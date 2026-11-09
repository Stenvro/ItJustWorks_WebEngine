import { GBUFFER_FORMAT, gbufferTarget } from './gbuffer.ts';
import { frustumPlanes, invert, type Plane } from './frustum.ts';
import type { GpuContext } from './gpu.ts';
import { ShadowKind } from './scene-lighting.ts';
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

/**
 * The water reflection's render targets (water-reflection.ts): the faces as layers, and the
 * multisampled colour, G-buffer and depth one face is drawn into (the opaque pass's formats, so
 * the sky, land, tree LOD and objects draw with their own pipelines).
 */
/** The water reflections' render targets: shared by every reflection's faces in turn. */
class ReflectionTargets {
  readonly color: GPUTextureView;
  readonly gbuffer: GPUTextureView;
  readonly depth: GPUTextureView;

  constructor(device: GPUDevice) {
    const size = [REFLECTION_SIZE, REFLECTION_SIZE];
    const multisampled = (label: string, format: GPUTextureFormat): GPUTextureView =>
      device
        .createTexture({
          label,
          format,
          size,
          sampleCount: SAMPLE_COUNT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        .createView();
    this.color = multisampled('water-reflection-color', HDR_FORMAT);
    this.gbuffer = multisampled('water-reflection-gbuffer', GBUFFER_FORMAT);
    this.depth = multisampled('water-reflection-depth', DEPTH_FORMAT);
  }
}

/**
 * One reflection's faces (water-reflection.ts): the texture the water samples, a frame state per
 * face, and the schedule its faces are redrawn by.
 */
class ReflectionCube {
  readonly faces: GPUTexture;
  readonly frames: SceneFrame[];
  readonly schedule = new ReflectionSchedule();
  /** What it reflects: a cube drawn for another kind is drawn again. */
  kind: ReflectionKind | undefined;

  constructor(device: GPUDevice, scene: SceneRenderer, index: number) {
    this.faces = device.createTexture({
      label: `water-reflection-${index}`,
      format: HDR_FORMAT,
      size: [REFLECTION_SIZE, REFLECTION_SIZE, REFLECTION_FACES],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.frames = Array.from({ length: REFLECTION_FACES }, (_, face) =>
      scene.createFrame(`water-reflection-${index}-${face}`),
    );
  }
}

/** A frame asked for (Renderer.captureFrame): its size, and who takes it. */
interface FrameCapture {
  readonly width: number;
  readonly height: number;
  readonly done: (frame: ImageBitmap | undefined) => void;
}

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
  chooseFocusLights,
  fitFocusShadow,
  FOCUS_DOUBLE_EVERY,
  FOCUS_FADE_START,
  FOCUS_SHADOW_COUNT,
  FOCUS_SHADOW_DISTANCE,
  focusFade,
  focusMapSize,
  selectFocusShadows,
  type FocusCandidate,
  type FocusChoice,
} from './focus-shadows.ts';

/** A body given a focus map this frame: its bound, its map's size in texels and its fade. */
interface FocusBodyChoice {
  readonly body: FocusChoice<GpuScene>;
  readonly size: number;
  readonly fade: number;
}

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
import type { ParticleBodies } from './particle-sim.ts';
import {
  mirroredCamera,
  REFLECTION_FACES,
  REFLECTION_NEAR,
  REFLECTION_SIZE,
  reflectionContent,
  reflectionFaceViewProjection,
  REFLECTION_FACES_PER_FRAME_MAX,
  ReflectionSchedule,
} from './water-reflection.ts';
import type { ReflectionKind } from './water-reflection.ts';
import {
  DEPTH_FORMAT,
  SAMPLE_COUNT,
  SceneRenderer,
  type GpuScene,
  type SceneFrame,
  SHADOW_MAP_LAYERS,
  PRECIPITATION_OCCLUSION_LAYER,
  SHADOW_MAP_SIZE,
  FOCUS_MAP_SIZE,
  focusCascadeSlot,
  focusLayer,
  type FocusSet,
  type FrameShadows,
  type InstanceVisibility,
  type LargeRefMask,
  type ShadowCasters,
  type LodMask,
  type PointLight,
  type SceneLighting,
  type WaterFrame,
  type WorldMapOverlay,
} from './scene-renderer.ts';
import backdropShader from './shaders/backdrop.wgsl?raw';
import depthResolveShader from './shaders/depth-resolve.wgsl?raw';
import { HDR_FORMAT, PostProcessor } from './post.ts';
import { SkyRenderer, type SkyFrame } from './sky.ts';
import type { ImageSpace } from '../world/image-space.ts';
import { nearPlaneWater, type NearPlaneWater, type UnderwaterFrame } from '../world/underwater.ts';
import { TerrainRenderer, type GpuTerrainCell } from './terrain.ts';
import { TreeLodRenderer, type TreeLodFrame } from './tree-lod.ts';
import { SnowScattering } from './snow-sss.ts';
import { Sao } from './sao.ts';
import { Composite } from './composite.ts';
import { ScreenBloodRenderer, type ScreenBloodFrame } from './screen-blood.ts';
import { SunEffects, type SunEffectsFrame } from './sun-effects.ts';
import { ImageLensFlare, type ImageLensFlareMotion } from './image-lens-flare.ts';
import { TemporalAA } from './taa.ts';
import { jitterPixels, jitterProjection, reprojection } from './taa-data.ts';
import { REFRACTION_FORMAT, RefractionComposite } from './refraction.ts';
import { GrassRenderer, type GpuGrassField } from './grass.ts';
import { DecalRenderer, type GpuDecals } from './decals.ts';
import { occlusionView, PrecipitationRenderer, type PrecipitationFrame } from './precipitation.ts';
import { recordFrame } from './frame-release.ts';
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
  /** The physics world mesh particles' rigid bodies live in (src/physics/particle-bodies.ts). */
  readonly particleBodies?: () => ParticleBodies | undefined;
  /** Sky colours for water reflections and the weather's water tint. */
  readonly water?: () => WaterFrame | undefined;
  /** Imagespace of the frame (eye adaptation, bloom, grading); none: the image as rendered. */
  readonly imageSpace?: () => ImageSpace | undefined;
  /**
   * The underwater view of the water at the camera (src/world/underwater.ts), called before
   * `lighting` each frame with what measures the camera's near plane against a water height;
   * undefined where the near plane is above the water.
   */
  readonly underwater?: (
    nearPlane: (waterHeight: number) => NearPlaneWater,
  ) => UnderwaterFrame | undefined;
  /** The world map's relief overlay on LOD land (the map menu's 3D only). */
  readonly worldMapOverlay?: () => WorldMapOverlay | undefined;
  /** The sun's volumetric lighting and lens flare this frame (exteriors). */
  readonly sunEffects?: () => SunEffectsFrame | undefined;
  /** Blood on the screen (the player hit: screen-blood-data.ts), over the finished image. */
  readonly screenBlood?: () => ScreenBloodFrame | undefined;
  readonly camera: Camera;
  /** Called every frame (lighting may depend on the camera, e.g. a studio light). */
  readonly lighting: (camera: Camera) => SceneLighting;
  /** Draw the shell backdrop behind the scene (model viewer) or not (cells). */
  readonly backdrop: boolean;
  /**
   * The directional light casts cascaded shadows (exteriors; a function: asked each frame, as
   * the world it shows may change).
   */
  readonly shadows?: boolean | (() => boolean);
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
  /**
   * The trees' switch (the console's tt): hidden, the near trees (TREE references, placed with it:
   * switched-visibility.ts) are not drawn, nor the distant tree LOD.
   */
  readonly treeVisibility: InstanceVisibility = { hidden: false };
  /** Trees are drawn, near and distant (the console's tt). */
  get showTrees(): boolean {
    return !this.treeVisibility.hidden;
  }
  set showTrees(on: boolean) {
    this.treeVisibility.hidden = !on;
  }
  /** Water is drawn (the console's tws). */
  showWater = true;
  /** The water reflects the sky, land, LOD and flagged references ([Water] bUseWaterReflections). */
  waterReflections = true;
  /** The water reflections' targets (made when first needed). */
  #reflectionTargets: ReflectionTargets | undefined;
  /** The reflections' cubes, by their index in the frame's plan (made when first needed). */
  readonly #reflectionCubes: ReflectionCube[] = [];
  /** Which reflection draws first this frame (they take turns at the frame's faces). */
  #reflectionTurn = 0;
  /**
   * The water reflection's work in the last frame (the terminal's stats): faces redrawn, and
   * of them the land quadrants, tree LOD blocks and reflected draws drawn, and the CPU time spent
   * recording them (ms).
   */
  reflectionStats = { faces: 0, land: 0, trees: 0, draws: 0, ms: 0 };
  readonly grass: GrassRenderer;
  readonly decals: DecalRenderer;
  readonly precipitation: PrecipitationRenderer;
  readonly post: PostProcessor;
  /** The weather's god rays and the sun's lens flare (sun-effects.ts). */
  readonly sunEffects: SunEffects;
  /** The image-based lens flare of bright lights (image-lens-flare.ts, bIBLFEnable). */
  readonly imageLensFlare: ImageLensFlare;
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
  /**
   * iNumFocusShadow, fMaxFocusShadowMapDistance, fFadingFracStart and
   * fFocusShadowMapDoubleEveryXUnit ([Display]; the shell sets them).
   */
  focusShadowCount = FOCUS_SHADOW_COUNT;
  focusShadowDistance = FOCUS_SHADOW_DISTANCE;
  focusShadowFadeStart = FOCUS_FADE_START;
  focusShadowDoubleEvery = FOCUS_DOUBLE_EVERY;
  /** Focus shadow maps rendered in the last frame (the terminal's stats). */
  focusShadowPasses = 0;
  /** The focus maps' casters of the frame (kept to spare arrays each frame). */
  readonly #focusCasters: ShadowCasters[] = [];
  /**
   * The shadow light (its shadow id) that held the focus maps last, where the sun casts none
   * (focus-shadows.ts chooseFocusLights).
   */
  #focusLight: number | undefined;
  readonly #lightShadowStates: (LightShadowState | undefined)[] = [];
  /** The precipitation occlusion map: its view, where it was centred and when. */
  #occlusion: { viewProj: Mat4; center: Vec3; frame: number } | undefined;
  #lastTime: number | undefined;
  /** Frames asked for (a save's screenshot), taken from the canvas as the next one is submitted. */
  #captures: FrameCapture[] = [];

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
    this.imageLensFlare = new ImageLensFlare(device);
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
  /**
   * The water's reflections (water-reflection.ts): which water takes which (planReflections, by
   * the frame's rules), then of the reflections water in view takes, the faces due this frame:
   * the probe from the player's eyes (the sky and the LOD), a plane's from the camera mirrored
   * under it while the camera is above it (what lies under the plane clipped). The frame's
   * faces are shared out among them in turn, at most two a frame. Each face has its own frame
   * state (the frame's uniforms are written once before the passes run); the draws keep the
   * lights they chose in the world's view.
   */
  #waterReflection(
    encoder: GPUCommandEncoder,
    view: SceneView,
    lighting: SceneLighting,
    scenes: readonly GpuScene[],
    sky: SkyFrame | undefined,
    water: WaterFrame | undefined,
    timeSeconds: number,
    shadows: FrameShadows | undefined,
  ): void {
    const stats = { faces: 0, land: 0, trees: 0, draws: 0, ms: 0 };
    this.reflectionStats = stats;
    // A cube map file in place of the rendered reflection (or none), see WaterFrame.environment.
    const rendered = this.waterReflections && this.showWater && water?.environment === undefined;
    const { plan, inView } = this.scene.waterReflectionPlan(
      scenes,
      rendered ? water?.reflections : undefined,
    );
    const camera = view.camera.position;
    const device = this.#gpu.device;
    const reflections: ({ faces: GPUTexture; active: boolean } | undefined)[] = [];
    const due: { cube: ReflectionCube; index: number; eye: Vec3; clip: number | undefined }[] = [];
    plan.reflections.forEach((reflection, index) => {
      const cube = (this.#reflectionCubes[index] ??= new ReflectionCube(device, this.scene, index));
      const { mirrored } = reflectionContent(reflection.kind);
      // A plane's reflection is of no use seen from below it.
      const drawn = inView[index] === true && (!mirrored || camera[2] > reflection.height);
      if (cube.kind !== reflection.kind) {
        cube.kind = reflection.kind;
        cube.schedule.facesFor(undefined);
      }
      if (drawn) {
        const eye = mirrored ? mirroredCamera(camera, reflection.height) : (water?.eye ?? camera);
        due.push({ cube, index, eye, clip: mirrored ? reflection.height : undefined });
      } else {
        // Its faces wait; a plane's are due again when it comes back in view.
        if (mirrored) cube.schedule.facesFor(undefined);
      }
      reflections[index] = { faces: cube.faces, active: drawn && cube.schedule.complete };
    });
    if (due.length > 0) {
      this.#reflectionTargets ??= new ReflectionTargets(device);
      const targets = this.#reflectionTargets;
      const terrain = this.showLod ? view.terrain?.() : undefined;
      const trees = this.showLod && this.showTrees ? view.trees?.() : undefined;
      const started = performance.now();
      // One face a frame in all, two while a reflection has faces due.
      let left = due.some((item) => item.cube.schedule.pending)
        ? REFLECTION_FACES_PER_FRAME_MAX
        : 1;
      this.#reflectionTurn = (this.#reflectionTurn + 1) % due.length;
      for (let n = 0; n < due.length && left > 0; n++) {
        const item = due[(this.#reflectionTurn + n) % due.length];
        if (!item) continue;
        const { cube, index, eye, clip } = item;
        const kind = cube.kind ?? 'probe';
        const content = reflectionContent(kind);
        // The probe moves with the eyes: its faces are redrawn in turn, never all due at once.
        const faces = cube.schedule.facesFor(content.mirrored ? (clip ?? 0) : 0, left);
        left -= faces.length;
        for (const face of faces) {
          const frame = cube.frames[face];
          if (!frame) continue;
          this.scene.useFrame(frame);
          this.scene.updateFrame(
            reflectionFaceViewProjection(face, eye),
            eye,
            lighting,
            timeSeconds,
            view.lodMask?.(),
            shadows,
            { width: REFLECTION_SIZE, height: REFLECTION_SIZE, near: REFLECTION_NEAR },
            view.largeRefMask?.(),
            undefined,
            undefined,
            { ...(clip !== undefined && { clipHeight: clip }), chooseLights: false },
          );
          const pass = encoder.beginRenderPass({
            label: `water-reflection-${index}-${face}`,
            colorAttachments: [
              {
                view: targets.color,
                resolveTarget: cube.faces.createView({
                  dimension: '2d',
                  baseArrayLayer: face,
                  arrayLayerCount: 1,
                }),
                clearValue:
                  sky && content.sky
                    ? SkyRenderer.clearColor(sky.state)
                    : { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'discard',
              },
              { view: targets.gbuffer, loadOp: 'clear', storeOp: 'discard' },
            ],
            depthStencilAttachment: {
              view: targets.depth,
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'discard',
            },
          });
          if (sky && content.sky) this.sky.draw(pass, this.scene.frameBindGroup, sky);
          const planes = this.scene.viewPlanes;
          if (content.lod && terrain) {
            stats.land += this.terrain.draw(pass, this.scene.frameBindGroup, terrain, planes);
          }
          if (content.lod && trees) {
            stats.trees += this.treeLod.draw(pass, this.scene.frameBindGroup, trees, planes);
          }
          stats.draws += this.scene.drawReflected(pass, scenes, content);
          stats.faces++;
          pass.end();
        }
        reflections[index] = { faces: cube.faces, active: cube.schedule.complete };
      }
      stats.ms = performance.now() - started;
      this.scene.useFrame(undefined);
    }
    this.scene.setWaterReflections(reflections);
  }

  render(timeSeconds: number, pixelScale: number): void {
    // What the frame's own updates let go of (a menu closing as its 3D animates) is destroyed
    // after the submit (frame-release.ts).
    recordFrame(() => {
      this.#record(timeSeconds, pixelScale);
    });
  }

  #record(timeSeconds: number, pixelScale: number): void {
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
    let focus: readonly FocusBodyChoice[] = [];
    let focusSets: FocusSet[] = [];
    let wind: Vec3 = [0, 0, 0];
    /** Cascades to render into the shadow map this frame. */
    const dueCascades: number[] = [];
    let frameLighting: SceneLighting | undefined;
    let underwater: UnderwaterFrame | undefined;
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
      // Where the near plane reaches below the water at the camera: the underwater view.
      if (view.underwater) {
        const inverseView = invert(this.#unjittered);
        const cameraZ = view.camera.position[2];
        underwater =
          inverseView && view.underwater((height) => nearPlaneWater(inverseView, height, cameraZ));
      }
      const lighting = view.lighting(view.camera);
      frameLighting = lighting;
      const sunShadows = typeof view.shadows === 'function' ? view.shadows() : view.shadows;
      const inverse = sunShadows === true ? invert(this.#viewProjection) : undefined;
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
      }
      this.scene.setWorldMapOverlay(view.worldMapOverlay?.());
      lightShadowSlots = this.#selectShadowLights(view, lighting.lights, delta);
      // The focus maps: the sun's where it casts shadows, else a shadow light's.
      focus = inverse || lightShadowSlots.length > 0 ? this.#focusBodies(view) : [];
      focusSets = inverse
        ? [this.#fitFocusSet(undefined, lighting.sunDirection, view, focus)]
        : this.#lightFocusSets(lighting.lights, lightShadowSlots, view, focus);
      if (inverse) this.#focusLight = undefined;
      this.scene.updateFocusShadows(focusSets);
      this.scene.updateFocusScenes(
        focusSets.length > 0 ? focus.map((entry) => entry.body.target) : [],
      );
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
      this.scene.particleBodies = view.particleBodies?.();
      this.scene.animate(scenes, view.clock?.() ?? timeSeconds, view.camera.position, wind);
    }
    const overlay = this.overlay;
    const overlayScenes = overlay ? this.#menu.prepare(overlay, targets) : [];
    const hdrView = this.post.hdrView(targets.width, targets.height);
    const colorView = targets.color.createView();
    const depthView = targets.depth.createView();
    const encoder = device.createCommandEncoder({ label: 'frame' });
    // The last frame's adapted luminance into the frames' uniforms (the character light's).
    this.post.copyAdaptedLuminance(encoder, this.scene.luminanceTargets);

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
    this.focusShadowPasses = 0;
    if (view && focus.length > 0) {
      focusSets.forEach((set, s) => {
        this.#focusShadowPass(encoder, set, s, focus);
        this.focusShadowPasses += set.maps.length;
      });
    }
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
        this.terrain.draw(
          opaque,
          this.scene.frameBindGroup,
          terrain,
          this.scene.viewPlanes,
          (center, radius, out, at) => {
            this.scene.chooseLandLights(center, radius, out, at);
          },
        );
      }
      const trees = this.showLod && this.showTrees ? view.trees?.() : undefined;
      if (trees) this.treeLod.draw(opaque, this.scene.frameBindGroup, trees, this.scene.viewPlanes);
      const grass = this.showGrass ? view.grass?.() : undefined;
      if (grass) this.grass.draw(opaque, grass, this.scene.viewPlanes, view.camera.position);
      this.scene.drawOpaque(opaque, scenes);
    }
    opaque.end();
    // The water's frame (the sky's colours, the displacement field's turn), once a frame.
    const water = view !== undefined && this.showWater && this.scene.hasWater(scenes);
    const waterFrame = water ? view.water?.() : undefined;
    if (view && frameLighting) {
      this.#waterReflection(
        encoder,
        view,
        frameLighting,
        scenes,
        sky,
        waterFrame,
        timeSeconds,
        shadows,
      );
    }

    const imageSpace = view?.imageSpace?.();
    // The imagespace's depth of field and the underwater view read the opaque scene's depth.
    const depthOfField =
      view !== undefined &&
      ((imageSpace?.depthOfField.strength ?? 0) > 0 || underwater !== undefined);
    if (view) {
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
        this.scene.updateWaterFrame(waterFrame, targets.width, targets.height);
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
      let flareMotion: ImageLensFlareMotion | undefined;
      if (this.antiAliasing && !view.backdrop) {
        const previous = this.#previousUnjittered;
        // Unjittered both ways: a pixel's history lies where its point was in the last frame's
        // steady image (the history holds no jitter). Through this frame's jittered matrix
        // every still pixel would fetch its history a jitter step away, a sub-pixel resample
        // each frame that blurred the image.
        const reproject = previous && reprojection(previous, this.#unjittered);
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
        flareMotion = { velocity, reproject };
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
      // The image-based lens flare reads the scene before the volumetric light is added.
      if (!view.backdrop) {
        this.imageLensFlare.run(encoder, hdrTexture, targets.sceneDepth, flareMotion);
      }
      const sun = view.sunEffects?.();
      if (sun) {
        this.sunEffects.run(
          encoder,
          hdrTexture,
          targets.sceneDepth,
          this.#unjittered,
          sun,
          shadows && { map: this.scene.shadowMap, cascades: shadows.cascades },
        );
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
      underwater,
    );
    const blood = view?.screenBlood?.();
    if (blood) this.#screenBlood.draw(encoder, canvasView, targets.width, targets.height, blood);
    if (overlay) {
      this.#menu.draw(encoder, overlay, overlayScenes, targets, canvasView, this.post.gamma);
    }
    device.queue.submit([encoder.finish()]);
    if (this.#captures.length > 0) {
      const captures = this.#captures;
      this.#captures = [];
      for (const capture of captures) this.#take(capture);
    }
  }

  /**
   * The next frame as drawn, scaled to `width` × `height` (a save's screenshot). The menus'
   * movies play over the canvas, not on it, so it holds the world alone. Without a frame within
   * `waitMs` (the page hidden, the loop paused) the canvas is taken as it was last shown.
   */
  captureFrame(width: number, height: number, waitMs = 500): Promise<ImageBitmap | undefined> {
    return new Promise((resolve) => {
      const capture: FrameCapture = { width, height, done: resolve };
      this.#captures.push(capture);
      setTimeout(() => {
        if (!this.#captures.includes(capture)) return;
        this.#captures = this.#captures.filter((other) => other !== capture);
        this.#take(capture);
      }, waitMs);
    });
  }

  /** The canvas's image now: read in the task that drew it, before the frame is shown. */
  #take(capture: FrameCapture): void {
    createImageBitmap(this.#gpu.context.canvas, {
      resizeWidth: Math.max(1, Math.round(capture.width)),
      resizeHeight: Math.max(1, Math.round(capture.height)),
      resizeQuality: 'high',
    }).then(capture.done, () => {
      capture.done(undefined);
    });
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
   * The bodies that take the focus maps this frame (focus-shadows.ts), each by the bound of its
   * scene's shadow casters, with its map's size and fade.
   */
  #focusBodies(view: SceneView): FocusBodyChoice[] {
    if (!view.focusShadows || this.focusShadowCount <= 0) return [];
    const candidates: FocusCandidate<GpuScene>[] = [];
    for (const body of view.focusShadows()) {
      const bound = boundingSphere(
        body.scene.draws.filter((draw) => draw.part.shadowPipeline && !draw.visibility?.hidden),
      );
      if (bound) candidates.push({ ...bound, player: body.player, target: body.scene });
    }
    const player = candidates.find((candidate) => candidate.player)?.center;
    const camera = view.camera.position;
    return selectFocusShadows(
      candidates,
      player ?? camera,
      this.focusShadowCount,
      this.focusShadowDistance,
    ).map((body) => {
      // The map's size by the body's distance to the camera (the original measures it from the
      // actor's root node; here from its bound's centre).
      const distance = Math.hypot(
        body.center[0] - camera[0],
        body.center[1] - camera[1],
        body.center[2] - camera[2],
      );
      const size = focusMapSize(
        distance,
        Math.min(FOCUS_MAP_SIZE, SHADOW_MAP_SIZE),
        this.focusShadowDoubleEvery,
      );
      const fade = focusFade(body.key, this.focusShadowDistance, this.focusShadowFadeStart);
      return { body, size, fade };
    });
  }

  /**
   * One light's focus maps (`slot`: the shadow light's; undefined: the sun's), fitted round the
   * bodies along the light's direction (`toLight`, from the scene towards it).
   */
  #fitFocusSet(
    slot: number | undefined,
    toLight: Vec3,
    view: SceneView,
    bodies: readonly FocusBodyChoice[],
    anchor: Vec3 = shadowAnchor(view.camera.position),
  ): FocusSet {
    return {
      slot,
      maps: bodies.map(({ body, size, fade }) =>
        fitFocusShadow(body.center, body.radius, toLight, size, anchor, fade),
      ),
    };
  }

  /**
   * Where the sun casts no shadows: the shadow lights that hold the focus maps (focus-shadows.ts
   * chooseFocusLights; the scene's shadow lights in the order they joined it, active while they
   * hold a slot), each set fitted along its spot light's axis.
   */
  #lightFocusSets(
    lights: readonly PointLight[],
    slots: readonly ShadowSlot[],
    view: SceneView,
    bodies: readonly FocusBodyChoice[],
  ): FocusSet[] {
    // The lights that render their shadows this frame: those holding a slot with its views.
    const slotOf = new Map<number, number>();
    for (const { light, slot } of slots) {
      const id = light.shadow?.id;
      if (id !== undefined && this.#lightShadowStates[slot]?.views) slotOf.set(id, slot);
    }
    const seen = new Set<number>();
    const ordered = lights
      .filter((light) => {
        const id = light.shadow?.id;
        if (id === undefined || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      // Lights without an order joined before every ordered one (scene-lighting.ts).
      .sort((a, b) => (a.order === b.order ? 0 : (a.order ?? -Infinity) - (b.order ?? -Infinity)));
    const choice = chooseFocusLights(
      ordered.map((light) => ({
        id: light.shadow?.id ?? 0,
        active: slotOf.has(light.shadow?.id ?? -1),
        frustum: light.shadow?.kind === ShadowKind.spot,
      })),
      this.#focusLight,
    );
    this.#focusLight = choice.kept;
    if (bodies.length === 0) return [];
    return choice.holders.flatMap((id) => {
      const light = ordered.find((entry) => entry.shadow?.id === id);
      const slot = slotOf.get(id);
      if (!light || slot === undefined) return [];
      // The light's view direction (a spot light's axis); the original fits the maps along it
      // wherever the light stands.
      const axis = light.shadow?.axis ?? light.spot?.direction ?? [0, 0, -1];
      const toLight: Vec3 = [-axis[0], -axis[1], -axis[2]];
      return [this.#fitFocusSet(slot, toLight, view, bodies, light.position)];
    });
  }

  /**
   * Renders a set of focus maps into the quarters of its layer of the sun's shadow map (the
   * focus layer; a second light's: the first cascade's, unused then), each from its body's own
   * casters alone (focus-shadows.ts), in a corner of its map's size.
   */
  #focusShadowPass(
    encoder: GPUCommandEncoder,
    set: FocusSet,
    index: number,
    bodies: readonly FocusBodyChoice[],
  ): void {
    const pass = encoder.beginRenderPass({
      label: `focus-shadows-${String(index)}`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.scene.shadowMap.createView({
          dimension: '2d',
          baseArrayLayer: focusLayer(index),
          arrayLayerCount: 1,
        }),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    set.maps.forEach((shadow, i) => {
      const scene = bodies[i]?.body.target;
      if (!scene) return;
      // The body's own casters, however small (the original's list holds its 3D alone).
      const views = [{ planes: frustumPlanes(shadow.viewProj), minRadius: 0 }];
      this.scene.collectShadowCasters([scene], views, this.#focusCasters);
      const casters = this.#focusCasters[0];
      if (!casters) return;
      const x = (i % 2) * FOCUS_MAP_SIZE;
      const y = Math.floor(i / 2) * FOCUS_MAP_SIZE;
      pass.setViewport(x, y, shadow.size, shadow.size, 0, 1);
      pass.setScissorRect(x, y, shadow.size, shadow.size);
      this.scene.drawShadowCasters(pass, casters, focusCascadeSlot(i, index));
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
