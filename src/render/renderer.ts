import type { OrbitCamera } from './camera.ts';
import type { GpuContext } from './gpu.ts';
import {
  DEPTH_FORMAT,
  SAMPLE_COUNT,
  SceneRenderer,
  type GpuModel,
  type SceneLighting,
} from './scene-renderer.ts';
import backdropShader from './shaders/backdrop.wgsl?raw';

/**
 * Studio light for the model viewer: a warm key light from the camera's upper left plus
 * cool ambient, so a model is always lit from the side you look at.
 * TODO(M4): replace with cell/weather lighting once models sit in a world.
 */
function viewerLighting(camera: OrbitCamera): SceneLighting {
  const eye = camera.position;
  const toCamera = normalize([
    eye[0] - camera.target[0],
    eye[1] - camera.target[1],
    eye[2] - camera.target[2],
  ]);
  const up = camera.upVector;
  const right = normalize([
    up[1] * toCamera[2] - up[2] * toCamera[1],
    up[2] * toCamera[0] - up[0] * toCamera[2],
    up[0] * toCamera[1] - up[1] * toCamera[0],
  ]);
  const key = (k: 0 | 1 | 2): number => -0.5 * right[k] + 0.55 * up[k] + 0.65 * toCamera[k];
  return {
    sunDirection: normalize([key(0), key(1), key(2)]),
    sunColor: [1.05, 0.98, 0.88],
    ambient: [0.3, 0.33, 0.38],
  };
}

interface RenderTargets {
  readonly width: number;
  readonly height: number;
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
}

function normalize(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Renders one frame per call: the shell backdrop, then the scene, in one multisampled pass
 * with reversed-Z depth.
 */
export class Renderer {
  readonly scene: SceneRenderer;
  readonly #gpu: GpuContext;
  readonly #backdrop: GPURenderPipeline;
  readonly #backdropBuffer: GPUBuffer;
  /** time, scale, height in CSS pixels, padding */
  readonly #backdropData = new Float32Array(4);
  readonly #backdropBindGroup: GPUBindGroup;
  readonly #viewProjection = new Float32Array(16);
  #targets: RenderTargets | undefined;
  #models: GpuModel[] = [];
  #camera: OrbitCamera | undefined;
  #lastTime: number | undefined;

  constructor(gpu: GpuContext) {
    this.#gpu = gpu;
    const { device, format } = gpu;
    this.scene = new SceneRenderer(device, format);

    const module = device.createShaderModule({ label: 'backdrop', code: backdropShader });
    this.#backdrop = device.createRenderPipeline({
      label: 'backdrop',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: SAMPLE_COUNT },
    });
    this.#backdropBuffer = device.createBuffer({
      label: 'backdrop-uniforms',
      size: this.#backdropData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#backdropBindGroup = device.createBindGroup({
      label: 'backdrop',
      layout: this.#backdrop.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#backdropBuffer } }],
    });
  }

  /** Replaces the models in the scene; the previous ones are destroyed. */
  setScene(models: GpuModel[], camera: OrbitCamera | undefined): void {
    for (const model of this.#models) {
      if (!models.includes(model)) model.destroy();
    }
    this.#models = models;
    this.#camera = camera;
  }

  /** `timeSeconds` drives animation; `pixelScale` is the devicePixelRatio. */
  render(timeSeconds: number, pixelScale: number): void {
    const { device, context } = this.#gpu;
    const canvasTexture = context.getCurrentTexture();
    const targets = this.#ensureTargets(canvasTexture.width, canvasTexture.height);
    const delta = this.#lastTime === undefined ? 0 : Math.min(0.1, timeSeconds - this.#lastTime);
    this.#lastTime = timeSeconds;

    this.#backdropData[0] = timeSeconds;
    this.#backdropData[1] = pixelScale;
    this.#backdropData[2] = canvasTexture.height / pixelScale;
    device.queue.writeBuffer(this.#backdropBuffer, 0, this.#backdropData);

    const camera = this.#camera;
    if (camera) {
      camera.update(delta);
      camera.viewProjection(targets.width / targets.height, this.#viewProjection);
      this.scene.updateFrame(this.#viewProjection, camera.position, viewerLighting(camera));
    }

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      label: 'main',
      colorAttachments: [
        {
          view: targets.color.createView(),
          resolveTarget: canvasTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: {
        view: targets.depth.createView(),
        depthClearValue: 0, // reversed Z: far = 0
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.#backdrop);
    pass.setBindGroup(0, this.#backdropBindGroup);
    pass.draw(3);
    if (camera && this.#models.length > 0) this.scene.draw(pass, this.#models, camera.position);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  #ensureTargets(width: number, height: number): RenderTargets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    this.#targets?.color.destroy();
    this.#targets?.depth.destroy();
    const { device, format } = this.#gpu;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT;
    this.#targets = {
      width,
      height,
      color: device.createTexture({
        label: 'msaa-color',
        size: [width, height],
        format,
        sampleCount: SAMPLE_COUNT,
        usage,
      }),
      depth: device.createTexture({
        label: 'depth',
        size: [width, height],
        format: DEPTH_FORMAT,
        sampleCount: SAMPLE_COUNT,
        usage,
      }),
    };
    return this.#targets;
  }
}
