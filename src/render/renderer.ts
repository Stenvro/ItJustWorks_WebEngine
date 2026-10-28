import { GBUFFER_FORMAT, gbufferTarget } from './gbuffer.ts';
import { frustumPlanes, invert, type Plane } from './frustum.ts';
import type { GpuContext } from './gpu.ts';
import {
  LIGHT_SHADOW_FACES,
  lightShadowKey,
  lightShadowViews,
  MAX_SHADOW_LIGHTS,
  shadowLightCandidates,
  ShadowLightSelector,
  type LightShadowViews,
  type ShadowSlot,
} from './light-shadows.ts';

/** What a slot of the light-shadow map holds: the light's views and each layer's casters. */
interface LightShadowState {
  readonly key: string;
  readonly views: LightShadowViews | undefined;
  readonly planes: readonly Plane[][];
  /** Each layer's caster signature when it was rendered (none: not yet). */
  readonly signatures: number[];
}
import { fitCascades, shadowAnchor, SHADOW_SPLITS, type Cascade } from './shadow-cascades.ts';
import {
  boundingSphere,
  fitFocusShadow,
  FOCUS_SHADOW_COUNT,
  FOCUS_SHADOW_DISTANCE,
  selectFocusShadows,
  type FocusCandidate,
  type FocusShadow,
} from './focus-shadows.ts';

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
  FOCUS_SHADOW_LAYER,
  FOCUS_MAP_SIZE,
  focusCascadeSlot,
  type FrameShadows,
  type LargeRefMask,
  type ShadowCasters,
  type LodMask,
  type PointLight,
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
import { Composite } from './composite.ts';
import { ScreenBloodRenderer, type ScreenBloodFrame } from './screen-blood.ts';
import { SunEffects, type SunEffectsFrame } from './sun-effects.ts';
import { TemporalAA } from './taa.ts';
import { jitterPixels, jitterProjection, reprojection } from './taa-data.ts';
import { REFRACTION_FORMAT, RefractionComposite } from './refraction.ts';
import { GrassRenderer, type GpuGrassField } from './grass.ts';
import { DecalRenderer, type GpuDecals } from './decals.ts';
import { occlusionView, PrecipitationRenderer, type PrecipitationFrame } from './precipitation.ts';
import { MenuOverlay, type OverlayView } from './menu-overlay.ts';

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
import type { RoomCuller } from './room-culler.ts';

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
  /** The rooms, portals and occluders that cull the view's objects (room-culler.ts). */
  readonly rooms?: () => RoomCuller | undefined;
  /**
   * The room (1-255; 0 none) holding a point, where the view has rooms: moving actors and
   * objects take theirs each frame (portal-strict lights: SceneRenderer.roomAt).
   */
  readonly roomAt?: (point: Vec3) => number;
  /** Sky colours for water reflections and the weather's water tint. */
  readonly water?: () => WaterFrame | undefined;
  /** Imagespace of the frame (eye adaptation, bloom, grading); none: the image as rendered. */
  readonly imageSpace?: () => ImageSpace | undefined;
  /** The sun's god rays and lens flare this frame (exteriors). */
  readonly sunEffects?: () => SunEffectsFrame | undefined;
  /** Blood on the screen (the player hit: screen-blood-data.ts), over the finished image. */
  readonly screenBlood?: () => ScreenBloodFrame | undefined;
  readonly camera: Camera;
  /** Called every frame (lighting may depend on the camera, e.g. a studio light). */
  readonly lighting: (camera: Camera) => SceneLighting;
  /** Draw the shell backdrop behind the scene (model viewer) or not (cells). */
  readonly backdrop: boolean;
  /** The directional light casts cascaded shadows (exteriors). */
  readonly shadows?: boolean;
  /** Lights with LIGH shadow flags cast shadows (light-shadows.ts). */
  readonly lightShadows?: boolean;
  /**
   * The bodies the sun's focus shadows may fit round (focus-shadows.ts): the player's (when
   * shown) and the actors'. Used with `shadows`.
   */
  readonly focusShadows?: () => Iterable<FocusBody>;
  /** Called once a frame before the scenes animate (actors take their poses). */
  readonly update?: (timeSeconds: number) => void;
  /**
   * The view's own clock (seconds) for its models' animations, where the game's stands still
   * (the map's clouds drift while the game is in its menu).
   */
  readonly clock?: () => number;
}

/** A body that may take one of the sun's focus shadow maps. */
export interface FocusBody {
  readonly scene: GpuScene;
  readonly player: boolean;
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
  /** The refraction buffer (refraction.ts), multisampled and resolved. */
  readonly refraction: GPUTexture;
  readonly refractionResolved: GPUTexture;
  readonly depthResolve: GPUBindGroup;
}

/**
 * Renders one frame per call, in HDR with 4× multisampling and reversed-Z depth:
 * 1. the shell backdrop or the sky, the terrain and the opaque parts of the scenes (unfogged);
 * 2. the snow's subsurface scattering, the ambient occlusion and the composite (snow
 *    highlights, AO, fog), then copies of the image's colour and depth for the water shader;
 * 3. water surfaces, then the blended parts back to front;
 * 4. (if refraction shapes are in view) the refraction buffer, and the image-space refraction
 *    of everything drawn so far;
 * 5. the imagespace's post-processing into the canvas (with its depth of field: from the copy of
 *    the opaque scene's depth);
 * 6. (while a menu shows 3D) the menu's overlay over it (menu-overlay.ts).
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
  /** Snow highlights, AO and fog over the opaque scene (ISSAOComposite). */
  readonly #composite: Composite;
  /** The image-space refraction (ISRefraction). */
  readonly #refraction: RefractionComposite;
  /** bSAOEnable (on in the launcher presets); off for comparisons. */
  ambientOcclusion = true;
  /** Grass is drawn (the console's tg turns it off and on). */
  showGrass = true;
  /** Distant land and tree LOD are drawn (the console's tll). */
  showLod = true;
  /** Trees are drawn (the console's tt; TODO(M13): the near trees, TREE references, too). */
  showTrees = true;
  /** Water is drawn (the console's tws). */
  showWater = true;
  readonly grass: GrassRenderer;
  readonly decals: DecalRenderer;
  readonly precipitation: PrecipitationRenderer;
  readonly post: PostProcessor;
  /** The weather's god rays and the sun's lens flare (sun-effects.ts). */
  readonly sunEffects: SunEffects;
  /** Temporal anti-aliasing ([Display] bUseTAA; main.ts sets it). */
  antiAliasing = true;
  readonly #taa: TemporalAA;
  /** The camera's view-projection without the jitter, this frame's and the last TAA frame's. */
  readonly #unjittered = new Float32Array(16);
  #previousUnjittered: Float32Array | undefined;
  #taaFrame = 0;
  /** What an open menu shows in 3D over the world (none: nothing). */
  overlay: OverlayView | undefined;
  readonly #menu: MenuOverlay;
  readonly #screenBlood: ScreenBloodRenderer;
  readonly #gpu: GpuContext;
  readonly #backdrop: GPURenderPipeline;
  readonly #backdropBuffer: GPUBuffer;
  /** time, scale, height in CSS pixels, padding */
  readonly #backdropData = new Float32Array(4);
  readonly #backdropBindGroup: GPUBindGroup;
  readonly #depthResolve: GPURenderPipeline;
  readonly #viewProjection = new Float32Array(16);
  readonly #firstPersonViewProjection = new Float32Array(16);
  /** First person's view-projection without the jitter, this frame's (if any) and the last. */
  readonly #firstPersonUnjittered = new Float32Array(16);
  #hasFirstPerson = false;
  #previousFirstPerson: Float32Array | undefined;
  #targets: RenderTargets | undefined;
  #view: SceneView | undefined;
  /** The cascades as last rendered into the shadow map, and a frame counter for updates. */
  readonly #cascades: Cascade[] = [];
  #shadowFrame = 0;
  /** Shadow lights drawn at once (at most MAX_SHADOW_LIGHTS). */
  shadowLightLimit = MAX_SHADOW_LIGHTS;
  /** Light-shadow map layers rendered in the last frame (the terminal's stats). */
  lightShadowPasses = 0;
  readonly #shadowLights = new ShadowLightSelector();
  /** iNumFocusShadow and fMaxFocusShadowMapDistance ([Display]; the shell sets them). */
  focusShadowCount = FOCUS_SHADOW_COUNT;
  focusShadowDistance = FOCUS_SHADOW_DISTANCE;
  /** Focus shadow maps rendered in the last frame (the terminal's stats). */
  focusShadowPasses = 0;
  /** The focus maps' casters of the frame (kept to spare arrays each frame). */
  readonly #focusCasters: ShadowCasters[] = [];
  readonly #lightShadowStates: (LightShadowState | undefined)[] = [];
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
    this.#refraction = new RefractionComposite(device);
    this.#sao = new Sao(device, this.scene.frameLayout);
    this.#composite = new Composite(device, this.scene.frameLayout, HDR_FORMAT, SAMPLE_COUNT);
    this.grass = new GrassRenderer(device, HDR_FORMAT, this.scene);
    this.decals = new DecalRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.precipitation = new PrecipitationRenderer(device, HDR_FORMAT, this.scene.frameLayout);
    this.post = new PostProcessor(device, format);
    this.sunEffects = new SunEffects(device);
    this.#taa = new TemporalAA(device);
    this.#menu = new MenuOverlay(device, format, this.scene, this.terrain);
    this.#screenBlood = new ScreenBloodRenderer(device, format);

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
    this.#taa.reset();
    this.#previousUnjittered = undefined;
    this.#view = view;
  }

  /** The canvas's size in pixels at the last frame. */
  get size(): readonly [number, number] {
    const targets = this.#targets;
    return targets ? [targets.width, targets.height] : [1, 1];
  }

  get view(): SceneView | undefined {
    return this.#view;
  }

  /**
   * Where a world point is on the screen as the last frame saw it (0..1 from the top left), or
   * undefined behind the camera.
   */
  project(point: readonly [number, number, number]): readonly [number, number] | undefined {
    const m = this.#viewProjection;
    const [x, y, z] = point;
    const w = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0);
    if (!(w > 1e-6)) return undefined;
    const cx = ((m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0)) / w;
    const cy = ((m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0)) / w;
    return [(cx + 1) / 2, (1 - cy) / 2];
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
    let lightShadowSlots: readonly ShadowSlot[] = [];
    let focus: readonly FocusShadow[] = [];
    let wind: Vec3 = [0, 0, 0];
    /** Cascades to render into the shadow map this frame. */
    const dueCascades: number[] = [];
    if (view) {
      view.camera.update(delta);
      view.camera.viewProjection(targets.width / targets.height, this.#viewProjection);
      this.#unjittered.set(this.#viewProjection);
      // First person's own field of view and near plane (the player's arms: common.wgsl).
      const firstPerson = view.camera.firstPersonViewProjection?.(
        targets.width / targets.height,
        this.#firstPersonViewProjection,
      );
      // The TAA moves the image by a sub-pixel offset each frame.
      this.#hasFirstPerson = firstPerson !== undefined;
      if (firstPerson) this.#firstPersonUnjittered.set(firstPerson);
      if (this.antiAliasing && !view.backdrop) {
        const pixels = jitterPixels(this.#taaFrame++);
        jitterProjection(this.#viewProjection, pixels, targets.width, targets.height);
        if (firstPerson) jitterProjection(firstPerson, pixels, targets.width, targets.height);
      }
      const lighting = view.lighting(view.camera);
      const inverse = view.shadows ? invert(this.#viewProjection) : undefined;
      if (inverse) {
        const fitted = fitCascades(
          inverse,
          view.camera.near,
          lighting.sunDirection,
          SHADOW_MAP_SIZE,
          SHADOW_SPLITS,
          shadowAnchor(view.camera.position),
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
        focus = this.#fitFocusShadows(view, lighting.sunDirection);
      }
      this.scene.updateFocusShadows(focus);
      lightShadowSlots = this.#selectShadowLights(view, lighting.lights, delta);
      this.scene.updateFrame(
        this.#viewProjection,
        view.camera.position,
        lighting,
        timeSeconds,
        view.lodMask?.(),
        shadows,
        { width: targets.width, height: targets.height, near: view.camera.near },
        view.largeRefMask?.(),
        view.rooms?.(),
        firstPerson,
      );
      wind = windVelocity(lighting);
    }

    const sky = view?.sky?.();
    view?.update?.(timeSeconds);
    const scenes = view ? [...view.scenes()] : [];
    // Controllers of the placed models (UV scrolling, turning parts, idle sequences) and
    // their particle systems.
    if (view) {
      this.scene.roomAt = view.roomAt;
      this.scene.animate(scenes, view.clock?.() ?? timeSeconds, view.camera.position, wind);
    }
    const overlay = this.overlay;
    const overlayScenes = overlay ? this.#menu.prepare(overlay, targets) : [];
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
    // The focus maps round the bodies near the player, every frame (they move).
    this.focusShadowPasses = focus.length;
    if (view && focus.length > 0) this.#focusShadowPass(encoder, focus, terrainCells, scenes);
    // The shadow lights' maps: only the layers whose casters changed.
    this.lightShadowPasses = 0;
    if (view) this.#lightShadowPasses(encoder, view, lightShadowSlots, scenes);
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
          // The composite reads it per sample.
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
      const terrain = this.showLod ? view.terrain?.() : undefined;
      if (terrain) {
        this.terrain.draw(opaque, this.scene.frameBindGroup, terrain, this.scene.viewPlanes);
      }
      const trees = this.showLod && this.showTrees ? view.trees?.() : undefined;
      if (trees) this.treeLod.draw(opaque, this.scene.frameBindGroup, trees);
      const grass = this.showGrass ? view.grass?.() : undefined;
      if (grass) this.grass.draw(opaque, grass, this.scene.viewPlanes, view.camera.position);
      this.scene.drawOpaque(opaque, scenes);
    }
    opaque.end();

    const imageSpace = view?.imageSpace?.();
    // The imagespace's depth of field reads the opaque scene's depth.
    const depthOfField = view !== undefined && (imageSpace?.depthOfField.strength ?? 0) > 0;
    if (view) {
      const water = this.showWater && this.scene.hasWater(scenes);
      const decals = view.decals ? [...view.decals()] : [];
      const decalsInView = this.decals.visible(decals, this.scene.viewPlanes);
      // The opaque scene is finished as the engine does it: the snow's scattering on the lit,
      // unfogged image, then the composite (snow highlights, ambient occlusion, fog,
      // sparkles). Then copies of it for water, soft effects and particles, decals and the
      // depth of field.
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
        const hdrTexture = this.post.hdrTexture(targets.width, targets.height);
        const copyScene = (): void => {
          encoder.copyTextureToTexture({ texture: hdrTexture }, { texture: targets.sceneColor }, [
            targets.width,
            targets.height,
          ]);
        };
        // Snow scattering into the multisampled colour, from a copy of the resolved image.
        if (this.snowScattering.enabled) {
          copyScene();
          this.snowScattering.run(
            encoder,
            colorView,
            {
              scene: targets.sceneColor,
              depth: targets.sceneDepth,
              gbuffer: targets.gbufferResolved,
            },
            view.camera.near,
          );
        }
        const occlusion =
          this.ambientOcclusion && !view.backdrop
            ? this.#sao.run(encoder, this.scene.frameBindGroup, {
                width: targets.width,
                height: targets.height,
                gbuffer: targets.gbufferResolved,
              })
            : undefined;
        this.#composite.run(
          encoder,
          this.scene.frameBindGroup,
          { occlusion, gbuffer: targets.gbuffer, depth: targets.depth },
          colorView,
          hdrView,
        );
        copyScene();
        this.scene.updateWaterFrame(view.water?.(), targets.width, targets.height);
      }
      // Refraction shapes are depth-tested after the blended pass: it keeps the depth then.
      const refraction = this.scene.hasRefraction(scenes);
      const blended = encoder.beginRenderPass({
        label: 'water-and-blended',
        colorAttachments: [
          { view: colorView, resolveTarget: hdrView, loadOp: 'load', storeOp: 'discard' },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthLoadOp: 'load',
          depthStoreOp: refraction ? 'store' : 'discard',
        },
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
      if (refraction) this.#refract(encoder, targets, scenes, depthView, hdrView, view.camera);
      const hdrTexture = this.post.hdrTexture(targets.width, targets.height);
      // The history blended in (from the last frame's place of each pixel), then the sun's
      // rays and flare over the steady image.
      if (this.antiAliasing && !view.backdrop) {
        const previous = this.#previousUnjittered;
        const reproject = previous && reprojection(previous, this.#viewProjection);
        // Moving draws' motion vectors (the rest follows the depth and the camera).
        const velocity = this.#taa.velocityTarget(hdrTexture.width, hdrTexture.height);
        const motion = encoder.beginRenderPass({
          label: 'velocity',
          colorAttachments: [
            {
              view: velocity.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        if (previous) {
          const firstPerson = this.#hasFirstPerson ? this.#firstPersonUnjittered : undefined;
          this.scene.drawVelocity(
            motion,
            scenes,
            {
              viewProj: this.#viewProjection,
              current: this.#unjittered,
              previous,
              firstPersonViewProj: firstPerson && this.#firstPersonViewProjection,
              firstPersonCurrent: firstPerson,
              firstPersonPrevious: firstPerson && (this.#previousFirstPerson ?? firstPerson),
            },
            targets.sceneDepth,
          );
        }
        motion.end();
        this.#taa.resolve(encoder, hdrTexture, targets.sceneDepth, reproject);
        this.#previousUnjittered ??= new Float32Array(16);
        this.#previousUnjittered.set(this.#unjittered);
        if (this.#hasFirstPerson) {
          this.#previousFirstPerson ??= new Float32Array(16);
          this.#previousFirstPerson.set(this.#firstPersonUnjittered);
        } else {
          this.#previousFirstPerson = undefined;
        }
      } else {
        this.#previousFirstPerson = undefined;
        this.#previousUnjittered = undefined;
        this.#taa.reset();
      }
      const sun = view.sunEffects?.();
      if (sun) {
        this.sunEffects.run(encoder, hdrTexture, targets.sceneDepth, this.#unjittered, sun);
      }
    }

    const canvasView = canvasTexture.createView();
    this.post.run(
      encoder,
      canvasView,
      targets.width,
      targets.height,
      imageSpace,
      delta,
      depthOfField ? { view: targets.sceneDepthView, near: view.camera.near } : undefined,
    );
    const blood = view?.screenBlood?.();
    if (blood) this.#screenBlood.draw(encoder, canvasView, targets.width, targets.height, blood);
    if (overlay) {
      this.#menu.draw(encoder, overlay, overlayScenes, targets, canvasView, this.post.gamma);
    }
    device.queue.submit([encoder.finish()]);
  }

  /**
   * The engine's refraction: the shapes write the refraction buffer, then the image-space
   * pass shifts the finished scene (a copy of it) by it, into the scene.
   */
  #refract(
    encoder: GPUCommandEncoder,
    targets: RenderTargets,
    scenes: readonly GpuScene[],
    depthView: GPUTextureView,
    hdrView: GPUTextureView,
    camera: Camera,
  ): void {
    const pass = encoder.beginRenderPass({
      label: 'refraction-buffer',
      colorAttachments: [
        {
          view: targets.refraction.createView(),
          resolveTarget: targets.refractionResolved.createView(),
          clearValue: { r: 0.5, g: 0.5, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'discard' },
    });
    this.scene.drawRefraction(pass, scenes, camera.position);
    pass.end();
    encoder.copyTextureToTexture(
      { texture: this.post.hdrTexture(targets.width, targets.height) },
      { texture: targets.sceneColor },
      [targets.width, targets.height],
    );
    this.#refraction.run(encoder, hdrView, {
      scene: targets.sceneColor,
      refraction: targets.refractionResolved,
    });
  }

  /**
   * Picks this frame's shadow lights (the nearest of those in a room seen, light-shadows.ts),
   * keeps each slot's views while its light stays put, and hands the slots to the scene.
   */
  #selectShadowLights(
    view: SceneView,
    lights: readonly PointLight[],
    delta: number,
  ): readonly ShadowSlot[] {
    const rooms = view.rooms?.();
    const candidates = view.lightShadows
      ? shadowLightCandidates(
          lights,
          frustumPlanes(this.#viewProjection),
          rooms && ((point) => rooms.inVisibleRoom(point)),
        )
      : [];
    const slots = this.#shadowLights.update(
      candidates,
      view.camera.position,
      this.shadowLightLimit,
      delta,
    );
    const views: (LightShadowViews | undefined)[] = [];
    for (const { light, slot } of slots) {
      const key = lightShadowKey(light);
      let state = this.#lightShadowStates[slot];
      if (state?.key !== key) {
        const shadowViews = lightShadowViews(light);
        state = {
          key,
          views: shadowViews,
          planes: shadowViews?.viewProj.map((matrix) => frustumPlanes(matrix)) ?? [],
          signatures: [],
        };
        this.#lightShadowStates[slot] = state;
      }
      views[slot] = state.views;
    }
    this.scene.updateLightShadows(slots, views);
    return slots;
  }

  /**
   * Renders the layers of the shadow lights' maps whose casters moved, appeared or went (all of
   * a slot's layers when its light changed or moved): a still room keeps its maps.
   */
  #lightShadowPasses(
    encoder: GPUCommandEncoder,
    view: SceneView,
    slots: readonly ShadowSlot[],
    scenes: readonly GpuScene[],
  ): void {
    const rooms = view.rooms?.();
    for (const { light, slot } of slots) {
      const state = this.#lightShadowStates[slot];
      if (!state?.views) continue;
      const casters = this.scene.lightCasters(scenes, light.position, light.radius, rooms);
      state.views.viewProj.forEach((viewProj, face) => {
        const signature = this.scene.casterSignature(casters, state.planes[face] ?? []);
        if (signature === state.signatures[face]) return;
        state.signatures[face] = signature;
        this.scene.drawLightShadows(encoder, casters, slot * LIGHT_SHADOW_FACES + face, viewProj);
        this.lightShadowPasses++;
      });
    }
  }

  /**
   * The focus maps of the frame: the bodies near the player (focus-shadows.ts), each fitted by
   * the bound of its scene's shadow casters.
   */
  #fitFocusShadows(view: SceneView, toLight: Vec3): FocusShadow[] {
    if (!view.focusShadows || this.focusShadowCount <= 0) return [];
    const candidates: FocusCandidate[] = [];
    for (const body of view.focusShadows()) {
      const bound = boundingSphere(
        body.scene.draws.filter((draw) => draw.part.shadowPipeline && !draw.visibility?.hidden),
      );
      if (bound) candidates.push({ ...bound, player: body.player, target: body.scene });
    }
    const player = candidates.find((candidate) => candidate.player)?.center;
    const anchor = shadowAnchor(view.camera.position);
    return selectFocusShadows(
      candidates,
      player ?? view.camera.position,
      this.focusShadowCount,
      this.focusShadowDistance,
    ).map((body) => fitFocusShadow(body.center, body.radius, toLight, FOCUS_MAP_SIZE, anchor));
  }

  /** Renders the focus maps into their quarters of the focus layer of the sun's shadow map. */
  #focusShadowPass(
    encoder: GPUCommandEncoder,
    focus: readonly FocusShadow[],
    terrain: readonly GpuTerrainCell[],
    scenes: readonly GpuScene[],
  ): void {
    const pass = encoder.beginRenderPass({
      label: 'focus-shadows',
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.scene.shadowMap.createView({
          dimension: '2d',
          baseArrayLayer: FOCUS_SHADOW_LAYER,
          arrayLayerCount: 1,
        }),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    // One walk over the scenes' draws sorts the casters out for every focus map.
    const views = focus.map((shadow) => ({
      planes: frustumPlanes(shadow.viewProj),
      minRadius: shadow.texelSize * MIN_CASTER_TEXELS,
    }));
    this.scene.collectShadowCasters(scenes, views, this.#focusCasters);
    views.forEach(({ planes }, i) => {
      const casters = this.#focusCasters[i];
      if (!casters) return;
      const x = (i % 2) * FOCUS_MAP_SIZE;
      const y = Math.floor(i / 2) * FOCUS_MAP_SIZE;
      pass.setViewport(x, y, FOCUS_MAP_SIZE, FOCUS_MAP_SIZE, 0, 1);
      pass.setScissorRect(x, y, FOCUS_MAP_SIZE, FOCUS_MAP_SIZE);
      const slot = focusCascadeSlot(i);
      this.terrain.drawShadows(
        pass,
        this.scene.cascadeBindGroup,
        this.scene.cascadeOffset(slot),
        terrain,
        planes,
      );
      this.scene.drawShadowCasters(pass, casters, slot);
    });
    pass.end();
    // Let go of the frame's draws (scenes may be unloaded before the next).
    for (const casters of this.#focusCasters) {
      casters.scenes.length = 0;
      casters.draws.length = 0;
    }
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
      this.#targets?.refraction,
      this.#targets?.refractionResolved,
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
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
      gbufferResolved: device.createTexture({
        label: 'gbuffer',
        size: [width, height],
        format: GBUFFER_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
      refraction: device.createTexture({
        label: 'msaa-refraction',
        size: [width, height],
        format: REFRACTION_FORMAT,
        sampleCount: SAMPLE_COUNT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      refractionResolved: device.createTexture({
        label: 'refraction',
        size: [width, height],
        format: REFRACTION_FORMAT,
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
