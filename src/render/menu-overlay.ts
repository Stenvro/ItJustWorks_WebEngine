// The menus' 3D: what the game draws over the world while a menu is open (the book of the book
// menu, the item turned in the inventory, the lock of the lockpicking menu, the stars of the
// skills menu). It has its own camera and light (its own frame state in the SceneRenderer),
// is drawn after the world's image is finished into the multisampled targets (cleared, so
// where nothing is drawn stays transparent) and laid over the image (shaders/menu-overlay.wgsl).
// The map's local map is drawn the same way (its landscape too), then laid over the image as the
// game's ISLocalMap makes its picture: in the local map's frame only (src/shell/local-map.ts).

import type { Camera } from './view-camera.ts';
import { HDR_FORMAT } from './post.ts';
import type { GpuScene, SceneFrame, SceneLighting, SceneRenderer } from './scene-renderer.ts';
import type { GpuTerrainCell, TerrainRenderer } from './terrain.ts';
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
  /** Landscape drawn with the scenes (the local map's). */
  readonly terrain?: () => Iterable<GpuTerrainCell>;
  /** Laid over the image as the map's local map (see LocalMapFrame), not as it is drawn. */
  readonly localMap?: () => LocalMapFrame | undefined;
}

/**
 * Where the local map is (canvas pixels: x0, y0, x1, y1). Its frame's black field (at 80%,
 * as the movie's frame has it) holds the picture; the picture is the drawn image as the game's
 * ISLocalMap makes it (Community Shaders' ISLocalMap.hlsl): grey by luminance, opaque by its
 * edges (a Sobel filter, channels weighted 0.5, 0.25, 1) and its brightness, fading out toward
 * its sides, and not where the player has not been (`fog`: a raster of what they have seen,
 * 255 seen, and the affine map from canvas pixels to its 0..1). `step`: the pixels between the
 * edge filter's samples (the game's picture is 800 wide); `alpha`: the frame's fade.
 */
export interface LocalMapFrame {
  readonly picture: readonly [number, number, number, number];
  readonly field: readonly [number, number, number, number];
  readonly step: number;
  readonly alpha: number;
  readonly fog?: LocalMapFog;
}

export interface LocalMapFog {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** u = a·x + b·y + c, v = d·x + e·y + f (canvas pixels to the raster's 0..1). */
  readonly transform: readonly [number, number, number, number, number, number];
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
  readonly fog: GPUTexture;
}

export class MenuOverlay {
  readonly #device: GPUDevice;
  readonly #scene: SceneRenderer;
  readonly #frame: SceneFrame;
  readonly #pipeline: GPURenderPipeline;
  readonly #localMap: GPURenderPipeline;
  readonly #terrain: TerrainRenderer;
  readonly #uniforms: GPUBuffer;
  readonly #uniformData = new Float32Array(20);
  readonly #fogSampler: GPUSampler;
  /** The fog raster on the GPU, for the data it was made from (none: all seen). */
  #fog: { readonly data: Uint8Array | undefined; readonly texture: GPUTexture } | undefined;
  readonly #viewProjection = new Float32Array(16);
  /** The overlay's clock at its last frame. */
  #last: number | undefined;
  #resolved: Resolved | undefined;

  constructor(
    device: GPUDevice,
    canvasFormat: GPUTextureFormat,
    scene: SceneRenderer,
    terrain: TerrainRenderer,
  ) {
    this.#device = device;
    this.#scene = scene;
    this.#terrain = terrain;
    this.#frame = scene.createFrame('menu-frame');
    const module = device.createShaderModule({ label: 'menu-overlay', code: overlayShader });
    const layout = device.createBindGroupLayout({
      label: 'menu-overlay',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', multisampled: true },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#fogSampler = device.createSampler({
      label: 'local-map-fog',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const composite = (label: string, entryPoint: string): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module,
          entryPoint,
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
    this.#pipeline = composite('menu-overlay', 'fs_composite');
    this.#localMap = composite('menu-overlay-local-map', 'fs_local_map');
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
    const localMap = view.localMap?.();
    const resolved = this.#ensureResolved(targets, this.#useFog(localMap?.fog));
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
    const terrain = view.terrain?.();
    if (terrain) this.#terrain.draw(opaque, scene.frameBindGroup, terrain, scene.viewPlanes);
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

    const data = this.#uniformData;
    data.fill(0);
    data[0] = 1 / Math.max(gamma, 0.05);
    data[1] = view.opaque === true ? 1 : 0;
    if (localMap) {
      data[2] = Math.min(1, Math.max(0, localMap.alpha));
      data[3] = Math.max(1, localMap.step);
      data.set(localMap.picture, 4);
      data.set(localMap.field, 8);
      const fog = localMap.fog;
      if (fog) {
        const [a, b, c, d, e, f] = fog.transform;
        data.set([a, b, c, 1, d, e, f, 0], 12);
      }
    }
    this.#device.queue.writeBuffer(this.#uniforms, 0, data);
    const composite = encoder.beginRenderPass({
      label: 'menu-3d-composite',
      colorAttachments: [{ view: output, loadOp: 'load', storeOp: 'store' }],
    });
    composite.setPipeline(localMap ? this.#localMap : this.#pipeline);
    composite.setBindGroup(0, resolved.group);
    composite.draw(3);
    composite.end();
  }

  /** The fog raster on the GPU (a white texel when there is none), made again as it changes. */
  #useFog(fog: LocalMapFog | undefined): GPUTexture {
    if (this.#fog && this.#fog.data === fog?.data) return this.#fog.texture;
    this.#fog?.texture.destroy();
    const width = fog?.width ?? 1;
    const height = fog?.height ?? 1;
    const texture = this.#device.createTexture({
      label: 'local-map-fog',
      size: [width, height],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Rows padded to 256 bytes for the copy.
    const row = Math.ceil(width / 256) * 256;
    const padded = new Uint8Array(row * height);
    for (let y = 0; y < height; y++) {
      padded.set(fog ? fog.data.subarray(y * width, (y + 1) * width) : [255], y * row);
    }
    this.#device.queue.writeTexture({ texture }, padded, { bytesPerRow: row }, [width, height]);
    this.#fog = { data: fog?.data, texture };
    return texture;
  }

  #ensureResolved(targets: OverlayTargets, fog: GPUTexture): Resolved {
    const current = this.#resolved;
    const sameSize =
      current?.depth === targets.depth &&
      current.texture.width === targets.width &&
      current.texture.height === targets.height;
    if (sameSize && current.fog === fog) return current;
    if (!sameSize) current?.texture.destroy();
    const texture = sameSize
      ? current.texture
      : this.#device.createTexture({
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
        { binding: 3, resource: fog.createView() },
        { binding: 4, resource: this.#fogSampler },
      ],
    });
    this.#resolved = { texture, group, depth: targets.depth, fog };
    return this.#resolved;
  }
}
