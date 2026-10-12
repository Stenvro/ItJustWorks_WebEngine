import { GBUFFER_FORMAT, gbufferTarget } from './gbuffer.ts';
import { frustumPlanes, invert } from './frustum.ts';
import type { GpuContext } from './gpu.ts';
import { fitCascades, type Cascade } from './shadow-cascades.ts';

/**
 * Frames between updates of each shadow cascade: the near ones every frame, the far ones
 * (large texels, little visible change) every second and fourth frame.
 */
const CASCADE_PERIODS: readonly number[] = [1, 1, 2, 4];
/** Casters smaller than this many shadow-map texels are left out of a cascade. */
const MIN_CASTER_TEXELS = 3;
/** The precipitation occlusion map reaches this far above and below the camera. */
const OCCLUSION_DEPTH = 8192;
/** And is redrawn at least this often (frames), as cells stream in. */
const OCCLUSION_REFRESH_FRAMES = 120;
import type { Mat4, Vec3 } from './math.ts';
import {
  DEPTH_FORMAT,
  SAMPLE_COUNT,
  SceneRenderer,
  type GpuScene,
  SHADOW_MAP_LAYERS,
  PRECIPITATION_OCCLUSION_LAYER,
  SHADOW_MAP_SIZE,
  type FrameShadows,
  type LargeRefMask,
  type LodMask,
  type SceneLighting,
  type WaterFrame,
} from './scene-renderer.ts';
import backdropShader from './shaders/backdrop.wgsl?raw';
import depthResolveShader from './shaders/depth-resolve.wgsl?raw';
import { HDR_FORMAT, PostProcessor } from './post.ts';
import { SkyRenderer, type SkyFrame } from './sky.ts';
import type { ImageSpace } from '../world/image-space.ts';
import { TerrainRenderer, type GpuTerrainCell } from './terrain.ts';
import { TreeLodRenderer, type TreeLodFrame } from './tree-lod.ts';
import { SnowScattering } from './snow-sss.ts';
import { Sao } from './sao.ts';
import { GrassRenderer, type GpuGrassField } from './grass.ts';
import { DecalRenderer, type GpuDecals } from './decals.ts';
import { occlusionView, PrecipitationRenderer, type PrecipitationFrame } from './precipitation.ts';

/** Wind speed (world units per second) of a weather wind of 1 (WTHR wind speed 255). */
const MAX_WIND_SPEED = 500;

/** The weather's wind as a velocity (blowing towards its direction, clockwise from north). */
function windVelocity(lighting: SceneLighting): Vec3 {
  const speed = (lighting.wind ?? 0) * MAX_WIND_SPEED;
  const direction = lighting.windDirection ?? 0;
  return [Math.sin(direction) * speed, Math.cos(direction) * speed, 0];
}

/** Anything that can view a scene: the orbit camera, the free-flying camera, ... */
export type { Camera } from './view-camera.ts';
import type { Camera } from './view-camera.ts';

/** What the renderer draws: scenes and terrain, seen by a camera, lit by a lighting source. */
export interface SceneView {
  /** The scenes to draw this frame (several while cells stream in and out). */
  readonly scenes: () => Iterable<GpuScene>;
  /** Landscape cells to draw this frame. */
  readonly terrain?: () => Iterable<GpuTerrainCell>;
  /** Distant trees (tree LOD billboards). */
  readonly trees?: () => TreeLodFrame | undefined;
  /** Grass of the loaded cells. */
  readonly grass?: () => Iterable<GpuGrassField>;
  /** Placed decals (blood, scorch marks, puddles) of the loaded cells. */
  readonly decals?: () => Iterable<GpuDecals>;
  /** Rain and snow of the weather, with how much of each falls. */
  readonly precipitation?: () => readonly PrecipitationFrame[];
  /** The sky behind everything (exteriors). */
  readonly sky?: () => SkyFrame | undefined;
  /** Loaded cells, where distant LOD gives way. */
  readonly lodMask?: () => LodMask | undefined;
  /** Cells whose large references are loaded, where their object LOD gives way. */
  readonly largeRefMask?: () => LargeRefMask | undefined;
  /** Sky colours for water reflections and the weather's water tint. */
  readonly water?: () => WaterFrame | undefined;
  /** Imagespace of the frame (eye adaptation, bloom, grading); none: the image as rendered. */
  readonly imageSpace?: () => ImageSpace | undefined;
  readonly camera: Camera;
  /** Called every frame (lighting may depend on the camera, e.g. a studio light). */
  readonly lighting: (camera: Camera) => SceneLighting;
  /** Draw the shell backdrop behind the scene (model viewer) or not (cells). */
  readonly backdrop: boolean;
  /** The directional light casts cascaded shadows (exteriors). */
  readonly shadows?: boolean;
}

interface RenderTargets {
  readonly width: number;
  readonly height: number;
  readonly color: GPUTexture;
  readonly depth: GPUTexture;
  /** Copies of the opaque scene for water, soft effects and particles (single sample). */
  readonly sceneColor: GPUTexture;
  readonly sceneDepth: GPUTexture;
  /** A view of sceneDepth (the depth of field's bind group is made for it once). */
  readonly sceneDepthView: GPUTextureView;
  /** The opaque pass's G-buffer (gbuffer.ts), multisampled and resolved. */
  readonly gbuffer: GPUTexture;
  readonly gbufferResolved: GPUTexture;
  readonly depthResolve: GPUBindGroup;
}

/**
 * Renders one frame per call, in HDR with 4× multisampling and reversed-Z depth:
 * 1. the shell backdrop or the sky, the terrain and the opaque parts of the scenes;
 * 2. (if there is water) copies of that image's colour and depth for the water shader;
 * 3. water surfaces, then the blended parts back to front;
 * 4. the imagespace's post-processing into the canvas (with its depth of field: from the copy of
 *    the opaque scene's depth).
 */
export class Renderer {
  readonly scene: SceneRenderer;
  readonly terrain: TerrainRenderer;
  readonly sky: SkyRenderer;
  readonly treeLod: TreeLodRenderer;
  /** The improved snow's subsurface scattering, on the opaque scene. */
  readonly snowScattering: SnowScattering;
  /** Ambient occlusion of the opaque scene (bSAOEnable). */
  readonly #sao: Sao;
  /** bSAOEnable (on in the launcher presets); off for comparisons. */
  ambientOcclusion = true;
  readonly grass: GrassRenderer;
  readonly decals: DecalRenderer;
  readonly precipitation: PrecipitationRenderer;
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
  /** The cascades as last rendered into the shadow map, and a frame counter for updates. */
  readonly #cascades: Cascade[] = [];
  #shadowFrame = 0;
  /** The precipitation occlusion map: its view, where it was centred and when. */
  #occlusion: { viewProj: Mat4; center: Vec3; frame: number } | undefined;
  #lastTime: number | undefined;

  constructor(gpu: GpuContext) {
    this.#gpu = gpu;
    const { device, format } = gpu;
    this.scene = new SceneRenderer(device, HDR_FORMAT);
    this.terrain = new TerrainRenderer(device, HDR_FORMAT, this.scene.frameLayout, {
      layout: this.scene.cascadeLayout,
      module: this.scene.shadowModule,
    });
    this.sky = new SkyRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.treeLod = new TreeLodRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.snowScattering = new SnowScattering(device);
    this.#sao = new Sao(device, this.scene.frameLayout, HDR_FORMAT, SAMPLE_COUNT);
    this.grass = new GrassRenderer(device, HDR_FORMAT, this.scene);
    this.decals = new DecalRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.precipitation = new PrecipitationRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.post = new PostProcessor(device, format);

    const module = device.createShaderModule({ label: 'backdrop', code: backdropShader });
    this.#backdrop = device.createRenderPipeline({
      label: 'backdrop',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: HDR_FORMAT }, gbufferTarget(false)],
      },
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
    let shadows: FrameShadows | undefined;
    let wind: Vec3 = [0, 0, 0];
    /** Cascades to render into the shadow map this frame. */
    const dueCascades: number[] = [];
    if (view) {
      view.camera.update(delta);
      view.camera.viewProjection(targets.width / targets.height, this.#viewProjection);
      const lighting = view.lighting(view.camera);
      const inverse = view.shadows ? invert(this.#viewProjection) : undefined;
      if (inverse) {
        const fitted = fitCascades(
          inverse,
          view.camera.near,
          lighting.sunDirection,
          SHADOW_MAP_SIZE,
        );
        this.#shadowFrame++;
        fitted.forEach((cascade, i) => {
          const period = CASCADE_PERIODS[i] ?? 1;
          if (this.#cascades[i] !== undefined && this.#shadowFrame % period !== 0) return;
          this.#cascades[i] = cascade;
          dueCascades.push(i);
        });
        // The shader samples each cascade with the matrix it was rendered with.
        shadows = { cascades: this.#cascades };
      }
      this.scene.updateFrame(
        this.#viewProjection,
        view.camera.position,
        lighting,
        timeSeconds,
        view.lodMask?.(),
        shadows,
        { width: targets.width, height: targets.height, near: view.camera.near },
        view.largeRefMask?.(),
      );
      wind = windVelocity(lighting);
    }

    const sky = view?.sky?.();
    const scenes = view ? [...view.scenes()] : [];
    // Controllers of the placed models (UV scrolling, turning parts, idle sequences) and
    // their particle systems.
    if (view) this.scene.animate(scenes, timeSeconds, view.camera.position, wind);
    const hdrView = this.post.hdrView(targets.width, targets.height);
    const colorView = targets.color.createView();
    const depthView = targets.depth.createView();
    const encoder = device.createCommandEncoder({ label: 'frame' });

    // The sun's shadow map: casters of the loaded cells, one pass per cascade.
    const terrainCells = view?.terrain ? [...view.terrain()] : [];
    if (view && shadows) {
      for (const i of dueCascades) {
        const cascade = this.#cascades[i];
        if (!cascade || i >= SHADOW_MAP_LAYERS) continue;
        this.#shadowPass(encoder, i, cascade.viewProj, terrainCells, scenes, cascade.texelSize);
      }
    }
    // Precipitation: the casters seen from above (where it rains), redrawn as the camera moves.
    const precipitation = view?.precipitation?.().filter((entry) => entry.amount > 0) ?? [];
    if (view && precipitation.length > 0) {
      const box = Math.max(...precipitation.map((entry) => entry.system.precipitation.boxSize));
      const extent = box * 0.75 + 256;
      const camera = view.camera.position;
      const last = this.#occlusion;
      const moved =
        !last ||
        Math.hypot(camera[0] - last.center[0], camera[1] - last.center[1]) > extent / 4 ||
        Math.abs(camera[2] - last.center[2]) > OCCLUSION_DEPTH / 4 ||
        this.#shadowFrame - last.frame > OCCLUSION_REFRESH_FRAMES;
      if (moved) {
        const viewProj = occlusionView(camera, extent, OCCLUSION_DEPTH);
        this.#occlusion = { viewProj, center: [...camera], frame: this.#shadowFrame };
        this.scene.setOcclusionView(viewProj);
        this.#shadowPass(
          encoder,
          PRECIPITATION_OCCLUSION_LAYER,
          viewProj,
          terrainCells,
          scenes,
          (2 * extent) / SHADOW_MAP_SIZE,
        );
      }
    }

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
        {
          view: targets.gbuffer.createView(),
          resolveTarget: targets.gbufferResolved.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'discard',
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
      if (terrain) {
        this.terrain.draw(opaque, this.scene.frameBindGroup, terrain, this.scene.viewPlanes);
      }
      const trees = view.trees?.();
      if (trees) this.treeLod.draw(opaque, this.scene.frameBindGroup, trees);
      const grass = view.grass?.();
      if (grass) this.grass.draw(opaque, grass, this.scene.viewPlanes, view.camera.position);
      this.scene.drawOpaque(opaque, scenes);
    }
    opaque.end();

    const imageSpace = view?.imageSpace?.();
    // The imagespace's depth of field reads the opaque scene's depth.
    const depthOfField = view !== undefined && (imageSpace?.depthOfField.strength ?? 0) > 0;
    if (view) {
      const water = this.scene.hasWater(scenes);
      const decals = view.decals ? [...view.decals()] : [];
      const decalsInView = this.decals.visible(decals, this.scene.viewPlanes);
      // Copies of the opaque scene: for water, soft effects and particles, decals, the depth of
      // field and the snow's scattering (which reads them every frame).
      {
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
        // Ambient occlusion darkens the opaque scene before anything reads it (the engine's
        // SAO composite comes before the snow's scattering and the blended objects).
        if (this.ambientOcclusion && !view.backdrop) {
          this.#sao.run(encoder, this.scene.frameBindGroup, {
            width: targets.width,
            height: targets.height,
            gbuffer: targets.gbufferResolved,
            color: colorView,
            resolve: hdrView,
          });
        }
        encoder.copyTextureToTexture(
          { texture: this.post.hdrTexture(targets.width, targets.height) },
          { texture: targets.sceneColor },
          [targets.width, targets.height],
        );
        this.scene.updateWaterFrame(view.water?.(), targets.width, targets.height);
      }
      // Snow scattering into the multisampled colour, which the blended pass goes on with.
      this.snowScattering.run(
        encoder,
        colorView,
        { scene: targets.sceneColor, depth: targets.sceneDepth, gbuffer: targets.gbufferResolved },
        view.camera.near,
      );
      const blended = encoder.beginRenderPass({
        label: 'water-and-blended',
        colorAttachments: [
          { view: colorView, resolveTarget: hdrView, loadOp: 'load', storeOp: 'discard' },
        ],
        depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'discard' },
      });
      if (decalsInView) {
        this.decals.draw(blended, this.scene.frameBindGroup, decals, this.scene.viewPlanes);
      }
      if (water) this.scene.drawWater(blended, scenes);
      this.scene.drawTransparent(blended, scenes, view.camera.position);
      if (precipitation.length > 0 && this.#occlusion) {
        this.precipitation.draw(
          blended,
          this.scene.frameBindGroup,
          precipitation,
          timeSeconds,
          wind,
          this.#occlusion.viewProj,
        );
      }
      blended.end();
    }

    this.post.run(
      encoder,
      canvasTexture.createView(),
      targets.width,
      targets.height,
      imageSpace,
      delta,
      depthOfField ? { view: targets.sceneDepthView, near: view.camera.near } : undefined,
    );
    device.queue.submit([encoder.finish()]);
  }

  /** Renders shadow casters (terrain and scene parts) into a layer of the shadow map. */
  #shadowPass(
    encoder: GPUCommandEncoder,
    layer: number,
    viewProj: Mat4,
    terrain: readonly GpuTerrainCell[],
    scenes: readonly GpuScene[],
    texelSize: number,
  ): void {
    const planes = frustumPlanes(viewProj);
    const pass = encoder.beginRenderPass({
      label: `shadow-${String(layer)}`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.scene.shadowMap.createView({
          dimension: '2d',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        }),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    this.terrain.drawShadows(
      pass,
      this.scene.cascadeBindGroup,
      this.scene.cascadeOffset(layer),
      terrain,
      planes,
    );
    this.scene.drawShadows(pass, scenes, layer, planes, texelSize * MIN_CASTER_TEXELS);
    pass.end();
  }

  #ensureTargets(width: number, height: number): RenderTargets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    for (const texture of [
      this.#targets?.color,
      this.#targets?.depth,
      this.#targets?.sceneColor,
      this.#targets?.sceneDepth,
      this.#targets?.gbuffer,
      this.#targets?.gbufferResolved,
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
      sceneDepthView: sceneDepth.createView(),
      gbuffer: device.createTexture({
        label: 'msaa-gbuffer',
        size: [width, height],
        format: GBUFFER_FORMAT,
        sampleCount: SAMPLE_COUNT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      gbufferResolved: device.createTexture({
        label: 'gbuffer',
        size: [width, height],
        format: GBUFFER_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
      depthResolve: device.createBindGroup({
        label: 'depth-resolve',
        layout: this.#depthResolve.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: depth.createView() }],
      }),
    };
    this.scene.setSceneCopies(sceneColor.createView(), sceneDepth.createView());
    return this.#targets;
  }
}
