import type { GpuContext } from './gpu.ts';
import type { Mat4, Vec3 } from './math.ts';
import {
  DEPTH_FORMAT,
  SAMPLE_COUNT,
  SceneRenderer,
  type GpuScene,
  type SceneLighting,
} from './scene-renderer.ts';
import backdropShader from './shaders/backdrop.wgsl?raw';
import { TerrainRenderer, type GpuTerrainCell } from './terrain.ts';

/** Anything that can view a scene: the orbit camera, the free-flying camera, ... */
export interface Camera {
  readonly position: Vec3;
  update(deltaSeconds: number): void;
  viewProjection(aspect: number, out?: Mat4): Mat4;
}

/** What the renderer draws: scenes and terrain, seen by a camera, lit by a lighting source. */
export interface SceneView {
  /** The scenes to draw this frame (several while cells stream in and out). */
  readonly scenes: () => Iterable<GpuScene>;
  /** Landscape cells to draw this frame. */
  readonly terrain?: () => Iterable<GpuTerrainCell>;
  readonly camera: Camera;
  /** Called every frame (lighting may depend on the camera, e.g. a studio light). */
  readonly lighting: (camera: Camera) => SceneLighting;
  /** Draw the shell backdrop behind the scene (model viewer) or not (cells). */
  readonly backdrop: boolean;
}

interface RenderTargets {
  readonly width: number;
  readonly height: number;
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
}

/**
 * Renders one frame per call: the shell backdrop, then the scene, in one multisampled pass
 * with reversed-Z depth.
 */
export class Renderer {
  readonly scene: SceneRenderer;
  readonly terrain: TerrainRenderer;
  readonly #gpu: GpuContext;
  readonly #backdrop: GPURenderPipeline;
  readonly #backdropBuffer: GPUBuffer;
  /** time, scale, height in CSS pixels, padding */
  readonly #backdropData = new Float32Array(4);
  readonly #backdropBindGroup: GPUBindGroup;
  readonly #viewProjection = new Float32Array(16);
  #targets: RenderTargets | undefined;
  #view: SceneView | undefined;
  #lastTime: number | undefined;

  constructor(gpu: GpuContext) {
    this.#gpu = gpu;
    const { device, format } = gpu;
    this.scene = new SceneRenderer(device, format);
    this.terrain = new TerrainRenderer(device, format, this.scene.frameLayout);

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

  /** Shows a scene (or only the backdrop). The caller owns the scene and its models. */
  setView(view: SceneView | undefined): void {
    this.#view = view;
  }

  get view(): SceneView | undefined {
    return this.#view;
  }

  /** `timeSeconds` drives animation; `pixelScale` is the devicePixelRatio. */
  render(timeSeconds: number, pixelScale: number): void {
    const { device, context } = this.#gpu;
    const canvasTexture = context.getCurrentTexture();
    const targets = this.#ensureTargets(canvasTexture.width, canvasTexture.height);
    const delta = this.#lastTime === undefined ? 0 : Math.min(0.1, timeSeconds - this.#lastTime);
    this.#lastTime = timeSeconds;

    const view = this.#view;
    const showBackdrop = view?.backdrop ?? true;
    if (showBackdrop) {
      this.#backdropData[0] = timeSeconds;
      this.#backdropData[1] = pixelScale;
      this.#backdropData[2] = canvasTexture.height / pixelScale;
      device.queue.writeBuffer(this.#backdropBuffer, 0, this.#backdropData);
    }
    if (view) {
      view.camera.update(delta);
      view.camera.viewProjection(targets.width / targets.height, this.#viewProjection);
      this.scene.updateFrame(
        this.#viewProjection,
        view.camera.position,
        view.lighting(view.camera),
      );
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
    if (showBackdrop) {
      pass.setPipeline(this.#backdrop);
      pass.setBindGroup(0, this.#backdropBindGroup);
      pass.draw(3);
    }
    if (view) {
      const terrain = view.terrain?.();
      if (terrain) this.terrain.draw(pass, this.scene.frameBindGroup, terrain);
      this.scene.draw(pass, view.scenes(), view.camera.position);
    }
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
