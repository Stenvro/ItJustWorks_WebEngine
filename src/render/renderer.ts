import type { GpuContext } from './gpu.ts';
import type { Mat4, Vec3 } from './math.ts';
import {
  DEPTH_FORMAT,
  SAMPLE_COUNT,
  SceneRenderer,
  type GpuScene,
  type SceneLighting,
  type WaterFrame,
} from './scene-renderer.ts';
import backdropShader from './shaders/backdrop.wgsl?raw';
import depthResolveShader from './shaders/depth-resolve.wgsl?raw';
import { HDR_FORMAT, PostProcessor } from './post.ts';
import { SkyRenderer, type SkyFrame } from './sky.ts';
import type { ImageSpace } from '../world/image-space.ts';
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
  /** The sky behind everything (exteriors). */
  readonly sky?: () => SkyFrame | undefined;
  /** Sky colours for water reflections and the weather's water tint. */
  readonly water?: () => WaterFrame | undefined;
  /** Imagespace of the frame (eye adaptation, bloom, grading); none: the image as rendered. */
  readonly imageSpace?: () => ImageSpace | undefined;
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
  /** Copies of the opaque scene for water: colour and depth (single sample). */
  readonly sceneColor: GPUTexture;
  readonly sceneDepth: GPUTexture;
  readonly depthResolve: GPUBindGroup;
  readonly waterInputs: GPUBindGroup;
}

/**
 * Renders one frame per call, in HDR with 4× multisampling and reversed-Z depth:
 * 1. the shell backdrop or the sky, the terrain and the opaque parts of the scenes;
 * 2. (if there is water) copies of that image's colour and depth for the water shader;
 * 3. water surfaces, then the blended parts back to front;
 * 4. the imagespace's post-processing into the canvas.
 */
export class Renderer {
  readonly scene: SceneRenderer;
  readonly terrain: TerrainRenderer;
  readonly sky: SkyRenderer;
  readonly post: PostProcessor;
  readonly #gpu: GpuContext;
  readonly #backdrop: GPURenderPipeline;
  readonly #backdropBuffer: GPUBuffer;
  /** time, scale, height in CSS pixels, padding */
  readonly #backdropData = new Float32Array(4);
  readonly #backdropBindGroup: GPUBindGroup;
  readonly #depthResolve: GPURenderPipeline;
  readonly #viewProjection = new Float32Array(16);
  #targets: RenderTargets | undefined;
  #view: SceneView | undefined;
  #lastTime: number | undefined;

  constructor(gpu: GpuContext) {
    this.#gpu = gpu;
    const { device, format } = gpu;
    this.scene = new SceneRenderer(device, HDR_FORMAT);
    this.terrain = new TerrainRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.sky = new SkyRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.post = new PostProcessor(device, format);

    const module = device.createShaderModule({ label: 'backdrop', code: backdropShader });
    this.#backdrop = device.createRenderPipeline({
      label: 'backdrop',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: HDR_FORMAT }] },
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
    const resolveModule = device.createShaderModule({
      label: 'depth-resolve',
      code: depthResolveShader,
    });
    this.#depthResolve = device.createRenderPipeline({
      label: 'depth-resolve',
      layout: 'auto',
      vertex: { module: resolveModule, entryPoint: 'vs_fullscreen' },
      fragment: {
        module: resolveModule,
        entryPoint: 'fs_resolve',
        targets: [{ format: 'r32float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** Shows a scene (or only the backdrop). The caller owns the scene and its models. */
  setView(view: SceneView | undefined): void {
    // A new view starts adapted to itself (like after a loading screen).
    this.post.resetAdaptation();
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
        timeSeconds,
      );
    }

    const sky = view?.sky?.();
    const scenes = view ? [...view.scenes()] : [];
    const hdrView = this.post.hdrView(targets.width, targets.height);
    const colorView = targets.color.createView();
    const depthView = targets.depth.createView();
    const encoder = device.createCommandEncoder({ label: 'frame' });

    const opaque = encoder.beginRenderPass({
      label: 'opaque',
      colorAttachments: [
        {
          view: colorView,
          resolveTarget: hdrView,
          clearValue: sky ? SkyRenderer.clearColor(sky.state) : { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: view ? 'store' : 'discard',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0, // reversed Z: far = 0
        depthLoadOp: 'clear',
        depthStoreOp: view ? 'store' : 'discard',
      },
    });
    if (showBackdrop) {
      opaque.setPipeline(this.#backdrop);
      opaque.setBindGroup(0, this.#backdropBindGroup);
      opaque.draw(3);
    }
    if (view) {
      if (sky) this.sky.draw(opaque, this.scene.frameBindGroup, sky);
      const terrain = view.terrain?.();
      if (terrain) this.terrain.draw(opaque, this.scene.frameBindGroup, terrain);
      this.scene.drawOpaque(opaque, scenes);
    }
    opaque.end();

    if (view) {
      const water = this.scene.hasWater(scenes);
      if (water) {
        encoder.copyTextureToTexture(
          { texture: this.post.hdrTexture(targets.width, targets.height) },
          { texture: targets.sceneColor },
          [targets.width, targets.height],
        );
        const resolve = encoder.beginRenderPass({
          label: 'depth-resolve',
          colorAttachments: [
            { view: targets.sceneDepth.createView(), loadOp: 'clear', storeOp: 'store' },
          ],
        });
        resolve.setPipeline(this.#depthResolve);
        resolve.setBindGroup(0, targets.depthResolve);
        resolve.draw(3);
        resolve.end();
        this.scene.updateWaterFrame(view.water?.(), targets.width, targets.height);
      }
      const blended = encoder.beginRenderPass({
        label: 'water-and-blended',
        colorAttachments: [
          { view: colorView, resolveTarget: hdrView, loadOp: 'load', storeOp: 'discard' },
        ],
        depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'discard' },
      });
      if (water) this.scene.drawWater(blended, scenes, targets.waterInputs);
      this.scene.drawTransparent(blended, scenes, view.camera.position);
      blended.end();
    }

    this.post.run(
      encoder,
      canvasTexture.createView(),
      targets.width,
      targets.height,
      view?.imageSpace?.(),
      delta,
    );
    device.queue.submit([encoder.finish()]);
  }

  #ensureTargets(width: number, height: number): RenderTargets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    for (const texture of [
      this.#targets?.color,
      this.#targets?.depth,
      this.#targets?.sceneColor,
      this.#targets?.sceneDepth,
    ]) {
      texture?.destroy();
    }
    const { device } = this.#gpu;
    const depth = device.createTexture({
      label: 'depth',
      size: [width, height],
      format: DEPTH_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const sceneColor = device.createTexture({
      label: 'scene-color',
      size: [width, height],
      format: HDR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const sceneDepth = device.createTexture({
      label: 'scene-depth',
      size: [width, height],
      format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#targets = {
      width,
      height,
      color: device.createTexture({
        label: 'msaa-color',
        size: [width, height],
        format: HDR_FORMAT,
        sampleCount: SAMPLE_COUNT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      depth,
      sceneColor,
      sceneDepth,
      depthResolve: device.createBindGroup({
        label: 'depth-resolve',
        layout: this.#depthResolve.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: depth.createView() }],
      }),
      waterInputs: this.scene.waterInputs(sceneColor.createView(), sceneDepth.createView()),
    };
    return this.#targets;
  }
}
