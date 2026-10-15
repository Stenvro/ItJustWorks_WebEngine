// The menus' 3D: what the game draws over the world while a menu is open (the book of the book
// menu, the item turned in the inventory, the lock of the lockpicking menu, the stars of the
// skills menu). It has its own camera and light (its own frame state in the SceneRenderer),
// is drawn after the world's image is finished into the multisampled targets (cleared, so
// where nothing is drawn stays transparent) and laid over the image (shaders/menu-overlay.wgsl).

import type { Camera } from './view-camera.ts';
import { HDR_FORMAT } from './post.ts';
import type { GpuScene, SceneFrame, SceneLighting, SceneRenderer } from './scene-renderer.ts';
import overlayShader from './shaders/menu-overlay.wgsl?raw';

/** What a menu shows in 3D. */
export interface OverlayView {
  readonly scenes: () => Iterable<GpuScene>;
  readonly camera: Camera;
  readonly lighting: (camera: Camera) => SceneLighting;
  /** Called once a frame before the scenes animate. */
  readonly update?: (timeSeconds: number) => void;
  /** It hides the world (the skills menu's sky): what it does not draw is black. */
  readonly opaque?: boolean;
}

/** The renderer's multisampled targets, reused once the world is drawn. */
export interface OverlayTargets {
  readonly width: number;
  readonly height: number;
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
  readonly gbuffer: GPUTexture;
}

/** The overlay resolved, and the composite's bind group (for one set of targets). */
interface Resolved {
  readonly texture: GPUTexture;
  readonly group: GPUBindGroup;
  readonly depth: GPUTexture;
}

export class MenuOverlay {
  readonly #device: GPUDevice;
  readonly #scene: SceneRenderer;
  readonly #frame: SceneFrame;
  readonly #pipeline: GPURenderPipeline;
  readonly #uniforms: GPUBuffer;
  readonly #uniformData = new Float32Array(4);
  readonly #viewProjection = new Float32Array(16);
  /** The overlay's clock at its last frame. */
  #last: number | undefined;
  #resolved: Resolved | undefined;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, scene: SceneRenderer) {
    this.#device = device;
    this.#scene = scene;
    this.#frame = scene.createFrame('menu-frame');
    const module = device.createShaderModule({ label: 'menu-overlay', code: overlayShader });
    this.#pipeline = device.createRenderPipeline({
      label: 'menu-overlay',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_composite',
        targets: [
          {
            format: canvasFormat,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.#uniforms = device.createBuffer({
      label: 'menu-overlay',
      size: this.#uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Readies the overlay's frame (camera, light) and animates its scenes; call after the
   * world's scenes animated this frame (their particles come first). Returns the scenes. The
   * menus' 3D runs on a clock of its own: the world's stands still while a menu is open.
   */
  prepare(view: OverlayView, targets: Pick<OverlayTargets, 'width' | 'height'>): GpuScene[] {
    const scene = this.#scene;
    const timeSeconds = performance.now() / 1000;
    const delta = this.#last === undefined ? 0 : Math.min(0.1, timeSeconds - this.#last);
    this.#last = timeSeconds;
    view.camera.update(delta);
    view.camera.viewProjection(targets.width / targets.height, this.#viewProjection);
    scene.useFrame(this.#frame);
    scene.updateFrame(
      this.#viewProjection,
      view.camera.position,
      view.lighting(view.camera),
      timeSeconds,
      undefined,
      undefined,
      { width: targets.width, height: targets.height, near: view.camera.near },
    );
    view.update?.(timeSeconds);
    const scenes = [...view.scenes()];
    scene.animate(scenes, timeSeconds, view.camera.position, [0, 0, 0], true);
    scene.useFrame(undefined);
    return scenes;
  }

  /** Draws the scenes and lays them over the finished image (`output`, the canvas). */
  draw(
    encoder: GPUCommandEncoder,
    view: OverlayView,
    scenes: readonly GpuScene[],
    targets: OverlayTargets,
    output: GPUTextureView,
    gamma: number,
  ): void {
    const scene = this.#scene;
    const resolved = this.#ensureResolved(targets);
    scene.useFrame(this.#frame);
    const colorView = targets.color.createView();
    const depthView = targets.depth.createView();
    // The opaque parts write the G-buffer too (their pipelines have it), the blended do not.
    const opaque = encoder.beginRenderPass({
      label: 'menu-3d-opaque',
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: targets.gbuffer.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    scene.drawOpaque(opaque, scenes);
    opaque.end();
    const blended = encoder.beginRenderPass({
      label: 'menu-3d-blended',
      colorAttachments: [
        {
          view: colorView,
          resolveTarget: resolved.texture.createView(),
          loadOp: 'load',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    scene.drawTransparent(blended, scenes, view.camera.position);
    blended.end();
    scene.useFrame(undefined);

    this.#uniformData[0] = 1 / Math.max(gamma, 0.05);
    this.#uniformData[1] = view.opaque === true ? 1 : 0;
    this.#device.queue.writeBuffer(this.#uniforms, 0, this.#uniformData);
    const composite = encoder.beginRenderPass({
      label: 'menu-3d-composite',
      colorAttachments: [{ view: output, loadOp: 'load', storeOp: 'store' }],
    });
    composite.setPipeline(this.#pipeline);
    composite.setBindGroup(0, resolved.group);
    composite.draw(3);
    composite.end();
  }

  #ensureResolved(targets: OverlayTargets): Resolved {
    const current = this.#resolved;
    if (
      current?.depth === targets.depth &&
      current.texture.width === targets.width &&
      current.texture.height === targets.height
    ) {
      return current;
    }
    current?.texture.destroy();
    const texture = this.#device.createTexture({
      label: 'menu-3d',
      size: [targets.width, targets.height],
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const group = this.#device.createBindGroup({
      label: 'menu-overlay',
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#uniforms } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: targets.depth.createView() },
      ],
    });
    this.#resolved = { texture, group, depth: targets.depth };
    return this.#resolved;
  }
}
