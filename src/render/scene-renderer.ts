// Draws scenes of model instances built by model-data.ts. Models (geometry + materials) are
// uploaded once; a scene places them with per-instance world matrices. One pipeline per
// vertex layout and material state, per-draw uniforms in one buffer (dynamic offsets),
// opaque first, then blended parts sorted back to front.

import type { ObjectGraph } from '../animation/object-graph.ts';
import type { BehaviorGraph } from '../formats/hkx/behavior.ts';
import {
  animate,
  animateLayers,
  type AnimationFrame,
  type AnimationLayer,
  type ModelAnimation,
  playSequence,
  type ModelSequences,
  type Playback,
} from './animation.ts';
import { billboardWorld } from './billboard.ts';
import {
  MAX_PALETTE_BONES,
  PALETTE_BONE_FLOATS,
  writePosedPalette,
  writeRestPalette,
} from './bone-palette.ts';
import { frustumPlanes, invert, sphereVisible, type Plane } from './frustum.ts';
import { identity, maxScale, multiply, transformPoint, type Mat4, type Vec3 } from './math.ts';
import type {
  AlphaState,
  EffectMaterial,
  LightingMaterial,
  ModelData,
  ModelPart,
  PartMaterial,
  VertexLayout,
} from './model-data.ts';
import type { ParticleSystemData } from './particle-data.ts';
import type { PlacedPart } from './raycast.ts';
import { REFRACTION_FORMAT } from './refraction.ts';
import { PARTICLE_FLOATS, ParticleSimulation, type ParticleContext } from './particle-sim.ts';
import commonShader from './shaders/common.wgsl?raw';
import frameShader from './shaders/frame.wgsl?raw';
import effectShader from './shaders/effect.wgsl?raw';
import lightingShader from './shaders/lighting.wgsl?raw';
import snowShader from './shaders/snow.wgsl?raw';
import particleShader from './shaders/particle.wgsl?raw';
import skinningShader from './shaders/skinning.wgsl?raw';
import refractionShader from './shaders/refraction.wgsl?raw';
import shadowShader from './shaders/shadow.wgsl?raw';
import waterShader from './shaders/water.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';
import { CELL_SIZE } from '../world/land.ts';
import { gbufferTarget } from './gbuffer.ts';
import { projectedUVParams, type MaterialObject } from '../world/material-object.ts';
import type { WaterType } from '../world/water.ts';

export const SAMPLE_COUNT = 4;
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
export const MAX_LIGHTS = 256;

/** Size of the WGSL `Draw` struct and the stride between draws (uniform offset alignment). */
const DRAW_SIZE = 256;
const DRAW_STRIDE = 256;
/** A draw's bone palette: as many bones as a vertex can name, three vec4 rows each. */
const PALETTE_BYTES = MAX_PALETTE_BONES * PALETTE_BONE_FLOATS * 4;
/** Palettes start at storage buffer offset alignment. */
const PALETTE_ALIGNMENT = 256;
/** WGSL `Frame` struct: 176 floats. */
const FRAME_FLOATS = 176;
/** Sun shadow map: one layer per cascade. */
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_MAP_LAYERS = 4;
/** An extra layer of the shadow map: the scene from straight above, for precipitation. */
export const PRECIPITATION_OCCLUSION_LAYER = 4;
const SHADOW_TEXTURE_LAYERS = SHADOW_MAP_LAYERS + 1;
/** Shadow cascade uniforms: one view-projection per 256-byte slot. */
const CASCADE_STRIDE = 256;
/** Receiver offsets against shadow acne: depth (0..1 units) and along the normal (texels). */
const SHADOW_DEPTH_BIAS = 0.0004;
const SHADOW_NORMAL_OFFSET = 1.5;

/** The sun's shadow cascades of a frame. */
export interface FrameShadows {
  readonly cascades: readonly { readonly viewProj: Mat4; readonly far: number }[];
}

/** Loaded cells, where distant LOD is not drawn: a 7×7 grid from its south-west cell. */
export interface LodMask {
  readonly originX: number;
  readonly originY: number;
  /** Bit (y * 7 + x) set for each loaded cell of the grid. */
  readonly low: number;
  readonly high: number;
}
/** WGSL `PointLight`: position + radius, colour + unused. */
const LIGHT_FLOATS = 8;

const SLSF1_ZBUFFER_TEST = 0x80000000;
const SLSF1_DECAL = 0x4000000;
const SLSF1_DYNAMIC_DECAL = 0x8000000;
/** Depth bias for decals: constant part (in depth units) and slope-scaled part. */
const DECAL_DEPTH_BIAS = 16;
const DECAL_SLOPE_BIAS = 1.5;
const SLSF2_ZBUFFER_WRITE = 0x1;
const SLSF2_DOUBLE_SIDED = 0x10;
const SLSF1_ENVIRONMENT_MAPPING = 0x80;
const SLSF1_CAST_SHADOWS = 0x200;
/** LOD landscape and LOD object shader types: distant LOD casts no shadows. */
const LOD_SHADER_TYPES = new Set([9, 13, 15, 18]);
/**
 * SLSF2 LOD_Landscape, LOD_Objects and HD_LOD_Objects: object LOD blocks (.bto) use shader
 * type 0 with these flags.
 */
const SLSF2_LOD = 0x2 | 0x4 | 0x80000000;

/** Distant LOD: terrain and object LOD blocks. */
function isLod(material: PartMaterial | undefined): boolean {
  return (
    material?.kind === 'lighting' &&
    (LOD_SHADER_TYPES.has(material.shaderType) || (material.flags2 & SLSF2_LOD) !== 0)
  );
}

/** Index ranges of an object LOD part by cell: hidden while that cell is loaded. */
interface LodSegment {
  readonly first: number;
  readonly count: number;
  readonly cellX: number;
  readonly cellY: number;
  /** Large references (shapes "obj-LargeRef"): also hidden where those are loaded. */
  readonly largeRef: boolean;
}

/**
 * Cells whose large references are loaded (uLargeRefLODGridSize 11): an 11×11 grid from its
 * south-west cell, bit (y * 11 + x) of four words.
 */
export interface LargeRefMask {
  readonly originX: number;
  readonly originY: number;
  readonly bits: Uint32Array;
}

/** Whether a cell's large references are loaded according to a large reference mask. */
function largeRefsLoaded(mask: LargeRefMask | undefined, x: number, y: number): boolean {
  if (!mask) return false;
  const gx = x - mask.originX;
  const gy = y - mask.originY;
  if (gx < 0 || gy < 0 || gx >= 11 || gy >= 11) return false;
  const bit = gy * 11 + gx;
  return (((mask.bits[bit >>> 5] ?? 0) >>> (bit & 31)) & 1) !== 0;
}

/**
 * The per-cell segments of an object LOD part placed with `world` (its block's origin):
 * blocks of 4 cells have one segment per cell, column by column from the south-west. Other
 * parts (larger blocks have a single segment) are drawn whole.
 */
function lodSegments(part: ModelPart, world: Mat4): LodSegment[] | undefined {
  const segments = part.segments;
  if (!isLod(part.material) || !segments || segments.length <= 1) return undefined;
  const originX = Math.round((world[12] ?? 0) / CELL_SIZE);
  const originY = Math.round((world[13] ?? 0) / CELL_SIZE);
  const largeRef = part.name.toLowerCase().includes('largeref');
  return segments
    .map((segment, i) => ({
      first: segment.first,
      count: segment.count,
      cellX: originX + Math.floor(i / 4),
      cellY: originY + (i % 4),
      largeRef,
    }))
    .filter((segment) => segment.count > 0);
}

/** Whether a cell is loaded according to the frame's LOD mask. */
function cellLoaded(mask: LodMask | undefined, x: number, y: number): boolean {
  if (!mask) return false;
  const gx = x - mask.originX;
  const gy = y - mask.originY;
  if (gx < 0 || gy < 0 || gx >= 7 || gy >= 7) return false;
  const bit = gy * 7 + gx;
  const word = bit < 32 ? mask.low : mask.high;
  return ((word >>> (bit % 32)) & 1) !== 0;
}
/** Draw flag (beside the NiAlphaProperty flags): a sky object, not fogged. */
const SKY_DRAW = 0x10000;
/** Draw flags of directional materials (lighting.wgsl): a single-pass material... */
const DRAW_PROJECTED = 0x20000;
/** ...with the engine's projected textures (bEnableProjecteUVDiffuseNormals, on)... */
const DRAW_PROJECTED_TEXTURED = 0x40000;
/** ...the second pass of a multi-pass material... */
const DRAW_MULTI_PASS = 0x80000;
/** ...an object that counts as snow... */
const DRAW_SNOW = 0x100000;
/** ...and HD object LOD (its vertex alpha shifts the snow line). */
const DRAW_LOD_HD = 0x200000;
/** SLSF1 External_Emittance: emit (or effect lighting) from the reference's XEMI. */
const SLSF1_EXTERNAL_EMITTANCE = 0x20000000;
const SLSF2_EFFECT_LIGHTING = 0x40000000;
/** Draw flag (common.wgsl): leaves flutter in the wind (SLSF2 Tree_Anim). */
const DRAW_TREE_ANIM = 0x400000;
const SLSF2_TREE_ANIM = 0x20000000;
/** The engine's directional material textures (BSGraphics default textures). */
const PROJECTED_TEXTURES = {
  diffuse: 'textures\\effects\\projecteddiffuse.dds',
  normal: 'textures\\effects\\projectednormal.dds',
  noise: 'textures\\effects\\projectednoise.dds',
} as const;
/** The LOD landscape noise texture (type 18, LOD landscape noise). */
const LOD_LANDSCAPE_NOISE = 'textures\\terrain\\noise.dds';
const SHADER_LOD_LANDSCAPE_NOISE = 18;
const SHADER_MULTI_LAYER_PARALLAX = 11;
const SHADER_PARALLAX = 3;
const SLSF1_MODEL_SPACE_NORMALS = 0x1000;
const SLSF1_SPECULAR = 0x1;
const SLSF2_GLOW_MAP = 0x40;
const SLSF2_SOFT_LIGHTING = 0x2000000;
const SLSF2_RIM_LIGHTING = 0x4000000;
const SLSF2_BACK_LIGHTING = 0x8000000;
/** Sort key offset that puts sky objects behind everything in the blended pass. */
const SKY_DISTANCE = 1e30;
/** NiAlphaProperty: alpha test on. */
const ALPHA_TEST = 0x200;
const SHADER_GLOW = 2;

/** NiAlphaProperty blend modes → WebGPU blend factors. */
const BLEND_FACTORS: readonly GPUBlendFactor[] = [
  'one',
  'zero',
  'src',
  'one-minus-src',
  'dst',
  'one-minus-dst',
  'src-alpha',
  'one-minus-src-alpha',
  'dst-alpha',
  'one-minus-dst-alpha',
  'src-alpha-saturated',
];

/**
 * Constant values for attributes a mesh lacks, read with array stride 0:
 * bitangent X, UV (f16x2), normal (+Z), tangent (+X), colour (white).
 */
const FALLBACK_VERTEX = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 255, 128, 255, 128, 128, 128, 255, 255, 255, 255,
]);
const FALLBACK_OFFSETS = { bitangentX: 0, uv: 4, normal: 8, tangent: 12, color: 16 } as const;

export interface PointLight {
  readonly position: Vec3;
  readonly radius: number;
  /** Already multiplied by the light's fade. */
  readonly color: Vec3;
}

export interface SceneFog {
  readonly nearColor: Vec3;
  readonly farColor: Vec3;
  readonly near: number;
  readonly far: number;
  readonly power: number;
  readonly max: number;
}

export interface SceneLighting {
  /** Direction towards the directional light. */
  readonly sunDirection: Vec3;
  readonly sunColor: Vec3;
  /** Ambient light from +X, −X, +Y, −Y, +Z, −Z (Skyrim's "directional ambient"). */
  readonly ambient: readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
  readonly fog: SceneFog | undefined;
  readonly lights: readonly PointLight[];
  /** Wind strength 0..1 (weather), for swaying grass. */
  readonly wind?: number;
  /** Where the wind blows towards: radians clockwise from north (+Y). */
  readonly windDirection?: number;
}

/** Uniform ambient from every direction. */
export function flatAmbient(color: Vec3): SceneLighting['ambient'] {
  return [color, color, color, color, color, color];
}

/** When a part is drawn: with the opaque scene, as water after it, or blended last. */
/** Refraction shapes draw only into the refraction buffer (see refraction.ts). */
type PartPass = 'opaque' | 'water' | 'transparent' | 'refraction';

interface GpuPart {
  readonly part: ModelPart;
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  readonly pipeline: GPURenderPipeline;
  /** Material textures (unused by water, which takes its type's bind group). */
  readonly bindGroup: GPUBindGroup;
  readonly pass: PartPass;
  /** Depth-only pipeline for the sun's shadow map (Cast_Shadows parts). */
  readonly shadowPipeline: GPURenderPipeline | undefined;
}

/** WGSL `WaterParams`: 11 vec4. */
const WATER_PARAM_FLOATS = 44;

/** A river cell's flow map (textures\water\<plugin>\flow.x.y.dds) and where it lies. */
export interface WaterFlow {
  readonly texture: string;
  /** South-west corner of the cell the map covers. */
  readonly origin: readonly [number, number];
}
/** WGSL `WaterFrame`: 5 vec4 + 32 profile samples. */
const WATER_FRAME_FLOATS = 20 + 32 * 4;

/** A water type (WATR) on the GPU: its parameters and noise textures. */
export class GpuWaterType {
  readonly type: WaterType;
  readonly bindGroup: GPUBindGroup;
  readonly #buffer: GPUBuffer;

  constructor(type: WaterType, bindGroup: GPUBindGroup, buffer: GPUBuffer) {
    this.type = type;
    this.bindGroup = bindGroup;
    this.#buffer = buffer;
  }

  destroy(): void {
    this.#buffer.destroy();
  }
}

/** Per-frame inputs of the water shader besides the frame uniforms. */
export interface WaterFrame {
  readonly horizon: Vec3;
  readonly lower: Vec3;
  readonly upper: Vec3;
  readonly multiplier: Vec3;
  /** Sky dome weights by elevation (ATMOSPHERE_SAMPLES × 4), if there is a sky. */
  readonly profile: Float32Array | undefined;
}

/** A particle system of a model on the GPU: its data, pipeline and material. */
interface GpuParticleSystem {
  readonly data: ParticleSystemData;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
}

/** A model attached at one of another model's AddOnNodes (model space of that model). */
export interface ModelAddon {
  readonly model: GpuModel;
  readonly world: Mat4;
}

/** A model on the GPU: geometry, materials and pipelines, placed by scenes. */
export class GpuModel {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly parts: readonly GpuPart[];
  /** Controllers that play on their own (evaluated every frame). */
  readonly animation: ModelAnimation | undefined;
  /** Sequences the game plays on demand (doors) or the behavior graph plays. */
  readonly sequences: ModelSequences | undefined;
  /**
   * The behavior graph that decides which sequences play (ModelData.behaviorGraph), resolved
   * by the session; every placed instance runs its own (ModelInstance.graph).
   */
  graph: BehaviorGraph | undefined = undefined;
  readonly particles: readonly GpuParticleSystem[];
  /**
   * Models the engine attaches at AddOnNodes (ADDN: candle flames, torch fire, smoke),
   * resolved by the session; placed with every instance of this model.
   */
  addons: readonly ModelAddon[] = [];
  /** GPU bytes of its own buffers (textures are counted by the texture cache). */
  readonly bytes: number;
  /** The root is a leaf animation node: Tree_Anim parts flutter (ModelData.leafAnimation). */
  readonly leafAnimation: boolean;
  /** performance.now() when a scene last took or let go of it (eviction order). */
  lastUsed = performance.now();
  readonly #buffers: readonly GPUBuffer[];
  /** The textures it holds in the cache, let go when it is destroyed. */
  readonly #textures: { readonly cache: TextureCache; readonly paths: readonly string[] };
  #users = 0;

  constructor(init: {
    center: readonly [number, number, number];
    radius: number;
    parts: readonly GpuPart[];
    buffers: readonly GPUBuffer[];
    animation: ModelAnimation | undefined;
    sequences?: ModelSequences | undefined;
    particles: readonly GpuParticleSystem[];
    textures: { readonly cache: TextureCache; readonly paths: readonly string[] };
    leafAnimation: boolean;
  }) {
    this.leafAnimation = init.leafAnimation;
    this.center = init.center;
    this.radius = init.radius;
    this.parts = init.parts;
    this.#buffers = init.buffers;
    this.animation = init.animation;
    this.sequences = init.sequences;
    this.particles = init.particles;
    this.#textures = init.textures;
    this.bytes = init.buffers.reduce((sum, buffer) => sum + buffer.size, 0);
    for (const path of init.textures.paths) init.textures.cache.retain(path);
  }

  /** Scenes and grass fields that draw it. */
  get users(): number {
    return this.#users;
  }

  /** A scene or field starts drawing it (see `release`). */
  acquire(): void {
    this.#users++;
    this.lastUsed = performance.now();
  }

  release(): void {
    this.#users = Math.max(0, this.#users - 1);
    this.lastUsed = performance.now();
  }

  destroy(): void {
    for (const buffer of this.#buffers) buffer.destroy();
    for (const path of this.#textures.paths) this.#textures.cache.release(path);
  }
}

/**
 * An instance that moves (a simulated object): its owner rewrites the instance's world matrix
 * in place and bumps `version`; the scene then updates the instance's draws.
 */
export interface InstanceMotion {
  version: number;
}

export interface ModelInstance {
  readonly model: GpuModel;
  readonly world: Mat4;
  /** The instance moves (its world matrix changes, see InstanceMotion). */
  readonly motion?: InstanceMotion;
  /** The sequence the instance plays (a door opening); its model's sequences. */
  readonly playback?: Playback;
  /** The instance's running behavior graph (over its model's graph and sequences). */
  readonly graph?: ObjectGraph;
  /** Water type of the model's water surfaces (the activator's WNAM); default otherwise. */
  readonly water?: GpuWaterType;
  /** A static's directional material (STAT DNAM). */
  readonly directional?: PlacedDirectional;
  /** A tree's leaf amplitude and frequency (TREE CNAM). */
  readonly leafAnimation?: { readonly amplitude: number; readonly frequency: number };
  /** XEMI: the colour that drives the model's External_Emittance shapes. */
  readonly emittance?: EmittanceColor;
}

/**
 * The current colour of an emittance source (a light, or a region's weather by the hour),
 * shared by the references that name it; `version` changes with the colour.
 */
export interface EmittanceColor {
  readonly rgb: readonly [number, number, number];
  readonly version: number;
}

/** A draw whose emit (lighting) or effect lighting follows an emittance colour. */
interface EmittanceDraw {
  readonly offset: number;
  readonly source: EmittanceColor;
  /** Lighting: the emissive multiple. Effect: 0 (the colour lights the effect). */
  readonly multiple: number;
  readonly effect: boolean;
  version: number;
}

/** A material object (MATO) ready to draw: its data and, if multi-pass, its own shader. */
export interface GpuDirectionalMaterial {
  readonly object: MaterialObject;
  /** Multi-pass: the material's shader property, drawn over the static a second time. */
  readonly pass:
    | {
        readonly material: LightingMaterial | EffectMaterial;
        readonly alpha: AlphaState | undefined;
        readonly bindGroup: GPUBindGroup;
      }
    | undefined;
}

/** A static's directional material as placed: the material, its max angle, snow. */
export interface PlacedDirectional {
  readonly material: GpuDirectionalMaterial | undefined;
  /** Degrees from the material's direction a surface may face (STAT DNAM). */
  readonly maxAngle: number;
  /** The static counts as snow (STAT DNAM flag). */
  readonly snow: boolean;
}

/** A material laid on object LOD shapes, with its max angle. */
export interface LodMaterial {
  readonly material: MaterialObject;
  readonly maxAngle: number;
}

/**
 * Snow on object LOD shapes named "objsnow" (plain and HD) and ash on "objash", see
 * WorldLod.
 */
export interface LodSnow {
  readonly normal: LodMaterial | undefined;
  readonly hd: LodMaterial | undefined;
  readonly ash: LodMaterial | undefined;
  readonly ashHd: LodMaterial | undefined;
}

interface Draw {
  readonly part: GpuPart;
  readonly uniformOffset: number;
  /** World bounding sphere centre (follows a moving instance). */
  center: readonly [number, number, number];
  /** Bounding sphere radius in world units (culling). */
  readonly radius: number;
  readonly water: GpuWaterType | undefined;
  /** Part of a sky scene: never culled, drawn behind everything else. */
  readonly sky: boolean;
  /** Object LOD by cell: segments of loaded cells are left out (the cell draws itself). */
  readonly lodSegments: readonly LodSegment[] | undefined;
  /** Skinned: byte offset of its bone palette in the scene's bone buffer. */
  readonly bones: number | undefined;
}

/** A draw that changes every frame (animated, or turning to the camera). */
interface AnimatedDraw {
  readonly offset: number;
  readonly instanceWorld: Mat4;
  readonly part: ModelPart;
  readonly animation: ModelAnimation | undefined;
  /** The instance's own sequence playback (doors), over the model's sequences. */
  readonly playback?: { readonly state: Playback; readonly sequences: ModelSequences };
  /** The instance's behavior graph and the model's sequences it plays. */
  readonly graph?: GraphDraw;
  /** Skinned: byte offset of its bone palette (posed from the frame's bone matrices). */
  readonly bones?: number;
}

/** An instance's running behavior graph with what it plays from. */
interface GraphDraw {
  readonly player: ObjectGraph;
  readonly sequences: ModelSequences;
  readonly animation: ModelAnimation | undefined;
}

/** A draw of a moving instance: rewritten when the instance's motion version changes. */
interface MovingDraw {
  readonly draw: Draw;
  readonly instanceWorld: Mat4;
  readonly part: ModelPart;
  /** Animated parts are rewritten every frame anyway; only their culling centre follows. */
  readonly animated: boolean;
  readonly motion: InstanceMotion;
  version: number;
}

/** An add-on placed on a moving instance: its world follows the instance's. */
interface MovingAddon {
  readonly parent: Mat4;
  readonly local: Mat4;
  readonly world: Mat4;
  readonly motion: InstanceMotion;
  version: number;
}

/** A placed particle system: its simulation and where its particles are this frame. */
interface ParticleDraw {
  readonly system: GpuParticleSystem;
  readonly simulation: ParticleSimulation;
  readonly instanceWorld: Mat4;
  readonly animation: ModelAnimation | undefined;
  /** The instance's behavior graph: its sequences drive the system's controllers. */
  readonly graph?: GraphDraw;
  readonly uniformOffset: number;
  /** Where the system sits in the world (update distance before it has particles). */
  readonly origin: readonly [number, number, number];
  /** Instances in the frame's particle buffer. */
  first: number;
  count: number;
  /** Seconds of the last update. */
  updated: number | undefined;
}

/** The bone palettes of a scene's skinned draws. */
interface SceneBones {
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly data: Float32Array;
}

/** Placed model instances with their per-draw uniforms. Does not own the models. */
export class GpuScene {
  readonly draws: readonly Draw[];
  readonly drawBindGroup: GPUBindGroup;
  readonly uniforms: GPUBuffer;
  /** CPU copy of the uniforms (animated draws are updated in it, then uploaded). */
  readonly uniformData: ArrayBuffer;
  readonly animated: readonly AnimatedDraw[];
  readonly particles: readonly ParticleDraw[];
  /** Draws whose emit follows an emittance colour (updated when the colour changes). */
  readonly emittance: readonly EmittanceDraw[];
  /** Draws of moving instances, and add-ons placed on them. */
  readonly moving: readonly MovingDraw[];
  readonly movingAddons: readonly MovingAddon[];
  /** Bone palettes of skinned draws (GPU buffer, its bind group and CPU copy). */
  readonly bones: SceneBones | undefined;
  /** The models it draws (held while it exists). */
  readonly #models: readonly GpuModel[];

  constructor(
    draws: readonly Draw[],
    drawBindGroup: GPUBindGroup,
    uniforms: GPUBuffer,
    uniformData: ArrayBuffer,
    animated: readonly AnimatedDraw[],
    particles: readonly ParticleDraw[],
    models: readonly GpuModel[],
    emittance: readonly EmittanceDraw[] = [],
    moving: { draws: readonly MovingDraw[]; addons: readonly MovingAddon[] } = {
      draws: [],
      addons: [],
    },
    bones?: SceneBones,
  ) {
    this.draws = draws;
    this.drawBindGroup = drawBindGroup;
    this.uniforms = uniforms;
    this.uniformData = uniformData;
    this.animated = animated;
    this.particles = particles;
    this.emittance = emittance;
    this.moving = moving.draws;
    this.movingAddons = moving.addons;
    this.bones = bones;
    this.#models = models;
    for (const model of models) model.acquire();
  }

  destroy(): void {
    this.uniforms.destroy();
    this.bones?.buffer.destroy();
    for (const model of this.#models) model.release();
  }
}

/** Particle systems farther than this are not simulated unless they are in view. */
const PARTICLE_UPDATE_DISTANCE = 4096;
/** Nor farther than this at all (their LOD has faded them out long before). */
const PARTICLE_MAX_DISTANCE = 16384;
/** Longest step of a particle update (a long frame or a system that comes back into view). */
const PARTICLE_MAX_STEP = 0.1;

/** Effect shader controlled variables (EffectShaderControlledVariable). */
const EffectVariable = {
  emissiveMultiple: 0,
  falloffStartAngle: 1,
  alphaTransparency: 5,
  uOffset: 6,
  uScale: 7,
  vOffset: 8,
  vScale: 9,
} as const;
/** Lighting shader controlled floats (LightingShaderControlledFloat). */
const LightingVariable = {
  refractionStrength: 0,
  environmentMapScale: 8,
  glossiness: 9,
  specularStrength: 10,
  emissiveMultiple: 11,
  alpha: 12,
  uOffset: 20,
  uScale: 21,
  vOffset: 22,
  vScale: 23,
} as const;

/** What a part or particle system draws with: material, alpha and their animation targets. */
interface MaterialSource {
  readonly material: PartMaterial | undefined;
  readonly alpha: AlphaState | undefined;
  readonly shader: number;
  readonly alphaProperty: number;
}

/** Writes an animation frame's values over a part's material uniforms. */
function writeAnimatedMaterial(
  floats: Float32Array,
  part: MaterialSource,
  frame: AnimationFrame,
): void {
  const material = part.material;
  const values = frame.shaderFloats.get(part.shader);
  const colors = frame.shaderColors.get(part.shader);
  const alphaTest = frame.alphaTest.get(part.alphaProperty);
  if (alphaTest !== undefined) floats[30] = alphaTest / 255;
  if (!material || material.kind === 'water' || (!values && !colors)) return;
  const uv = (u: number, uScale: number, v: number, vScale: number): void => {
    const set = (variable: number, index: number): void => {
      const value = values?.get(variable);
      if (value !== undefined) floats[index] = value;
    };
    set(u, 16);
    set(v, 17);
    set(uScale, 18);
    set(vScale, 19);
  };
  if (material.kind === 'effect') {
    uv(
      EffectVariable.uOffset,
      EffectVariable.uScale,
      EffectVariable.vOffset,
      EffectVariable.vScale,
    );
    const color = colors?.get(0) ?? material.baseColor;
    const scale = values?.get(EffectVariable.emissiveMultiple) ?? material.baseColorScale;
    floats.set(color.slice(0, 3), 20);
    floats[31] = scale;
    const alpha = values?.get(EffectVariable.alphaTransparency);
    if (alpha !== undefined) floats[23] = alpha;
    for (let i = 0; i < 4; i++) {
      const value = values?.get(EffectVariable.falloffStartAngle + i);
      if (value !== undefined) floats[32 + i] = value;
    }
    return;
  }
  uv(
    LightingVariable.uOffset,
    LightingVariable.uScale,
    LightingVariable.vOffset,
    LightingVariable.vScale,
  );
  const emissive = colors?.get(1) ?? material.emissiveColor;
  const multiple = values?.get(LightingVariable.emissiveMultiple) ?? material.emissiveMultiple;
  floats.set([emissive[0] * multiple, emissive[1] * multiple, emissive[2] * multiple], 20);
  const specular = colors?.get(0);
  if (specular) floats.set(specular, 24);
  const set = (variable: number, index: number): void => {
    const value = values?.get(variable);
    if (value !== undefined) floats[index] = value;
  };
  set(LightingVariable.specularStrength, 27);
  set(LightingVariable.glossiness, 28);
  set(LightingVariable.alpha, 29);
  set(LightingVariable.environmentMapScale, 31);
  set(LightingVariable.refractionStrength, 23);
}

/** SLSF1 Refraction on the lighting shader (no vanilla effect shader uses it). */
const SLSF1_REFRACTION = 0x8000;

function isRefraction(material: PartMaterial | undefined): boolean {
  return material?.kind === 'lighting' && (material.flags1 & SLSF1_REFRACTION) !== 0;
}

/** An instance's running behavior graph, if its model has sequences for it to play. */
function graphDraw(instance: ModelInstance): GraphDraw | undefined {
  const sequences = instance.model.sequences;
  return instance.graph && sequences
    ? { player: instance.graph, sequences, animation: instance.model.animation }
    : undefined;
}

function blendState(alpha: AlphaState | undefined): GPUBlendState | undefined {
  if (!alpha || (alpha.flags & 1) === 0) return undefined;
  return {
    color: {
      srcFactor: BLEND_FACTORS[(alpha.flags >> 1) & 15] ?? 'src-alpha',
      dstFactor: BLEND_FACTORS[(alpha.flags >> 5) & 15] ?? 'one-minus-src-alpha',
      operation: 'add',
    },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
}

function createBuffer(
  device: GPUDevice,
  data: ArrayBufferView,
  usage: number,
  label: string,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
    usage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  buffer.unmap();
  return buffer;
}

/** Material parameters of a part (everything in `Draw` after the world matrix). */
function writeMaterial(floats: Float32Array, uints: Uint32Array, part: MaterialSource): void {
  const material = part.material;
  const alphaThreshold = (part.alpha?.threshold ?? 128) / 255;
  if (material?.kind === 'water') {
    floats.set([...material.uvOffset, ...material.uvScale], 16);
    uints.set([material.flags1, material.flags2, 0, material.waterFlags], 36);
    return;
  }
  if (material?.kind === 'effect') {
    floats.set([...material.uvOffset, ...material.uvScale], 16);
    // Base colour and its scale apart: the palette lookup uses the unscaled colour.
    floats.set(material.baseColor, 20);
    // Effects keep their lighting influence and soft depth in the specular slot.
    floats.set([material.lightingInfluence, material.softFalloffDepth, 0, 0], 24);
    floats.set([1, 1, alphaThreshold, material.baseColorScale], 28);
    floats.set(material.falloff, 32);
    uints.set([material.flags1, material.flags2, part.alpha?.flags ?? 0, 0], 36);
    return;
  }
  floats.set([...(material?.uvOffset ?? [0, 0]), ...(material?.uvScale ?? [1, 1])], 16);
  const emissive = material?.emissiveColor ?? [0, 0, 0];
  const multiple = material?.emissiveMultiple ?? 0;
  // The emissive slot's alpha holds the refraction strength (unused otherwise).
  floats.set(
    [
      emissive[0] * multiple,
      emissive[1] * multiple,
      emissive[2] * multiple,
      material?.refractionStrength ?? 0,
    ],
    20,
  );
  floats.set([...(material?.specularColor ?? [1, 1, 1]), material?.specularStrength ?? 0], 24);
  floats.set(
    [
      material?.glossiness ?? 30,
      material?.alpha ?? 1,
      alphaThreshold,
      material?.environmentMapScale ?? 0,
    ],
    28,
  );
  floats.set([...(material?.tintColor ?? [1, 1, 1]), 1], 32);
  uints.set(
    [
      material?.flags1 ?? 0,
      material?.flags2 ?? 0,
      part.alpha?.flags ?? 0,
      material?.shaderType ?? 0,
    ],
    36,
  );
  // Soft light rolloff, rim light power, whether the environment map has a mask.
  const envMask = material?.textures[5] ?? '';
  floats.set(
    [material?.softLightRolloff ?? 0, material?.rimLightPower ?? 0, envMask === '' ? 0 : 1, 0],
    40,
  );
  floats.set(material?.multiLayer ?? [0, 0, 1, 1], 44);
  // No directional material: nothing projected (direction up keeps the shader's maths finite).
  floats.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], 48);
  floats.set(material?.sparkle ?? [1, 1, 1, 1], 60);
}

/**
 * Writes an emittance colour into a draw: lighting parts emit it times their emissive
 * multiple; effects (Effect_Lighting) are lit by it instead of the scene (draw.effect).
 */
function writeEmittance(floats: Float32Array, entry: EmittanceDraw): void {
  const [r, g, b] = entry.source.rgb;
  if (entry.effect) {
    floats.set([r, g, b, 1], 40);
  } else {
    floats.set([r * entry.multiple, g * entry.multiple, b * entry.multiple], 20);
  }
}

/**
 * Writes a single-pass directional material (or LOD snow) over a lighting part's uniforms:
 * the projection parameters and colour, and the draw flags.
 */
function writeProjected(
  floats: Float32Array,
  uints: Uint32Array,
  material: MaterialObject,
  maxAngle: number,
  extraFlags: number,
): void {
  floats.set(projectedUVParams(material, maxAngle), 48);
  floats.set([...material.singlePassColor, 0], 52);
  floats.set([0, 0, 1, 0], 56);
  uints[38] = (uints[38] ?? 0) | DRAW_PROJECTED | DRAW_PROJECTED_TEXTURED | extraFlags;
}

/**
 * Writes the second pass of a multi-pass directional material: the material's own shader
 * (written first with writeMaterial), laid on along its projection over the surfaces that
 * face against it within the static's max angle.
 */
function writeMultiPass(
  floats: Float32Array,
  uints: Uint32Array,
  material: MaterialObject,
  maxAngle: number,
  snow: boolean,
): void {
  floats.set(projectedUVParams(material, maxAngle), 48);
  floats.set(
    [
      material.normalDampener,
      material.materialUVScale > 0 ? 1 / material.materialUVScale : 0,
      0,
      0,
    ],
    52,
  );
  const [x, y, z] = material.projectionVector;
  const length = Math.hypot(x, y, z) || 1;
  floats.set([-x / length, -y / length, -z / length, Math.cos((maxAngle * Math.PI) / 180)], 56);
  uints[38] = (uints[38] ?? 0) | DRAW_MULTI_PASS | (snow ? DRAW_SNOW : 0);
}

/**
 * The textures a material binds: diffuse (effect: source), normal map, slot 2 (glow map or
 * rim / soft light map; effect: greyscale palette), environment map and mask, slot 7 (back
 * light map, or the specular map of model-space normals) and slot 6 (the multi-layer
 * parallax inner layer; parallax: the height map, slot 3; LOD landscape noise: the terrain
 * noise); '' where none.
 */
function materialTextures(
  material: PartMaterial | undefined,
): [string, string, string, string, string, string, string] {
  if (material?.kind === 'effect') {
    return [material.sourceTexture, '', material.greyscaleTexture, '', '', '', ''];
  }
  if (material?.kind !== 'lighting') return ['', '', '', '', '', '', ''];
  const slot = (index: number): string => material.textures[index] ?? '';
  const multiLayer = material.shaderType === SHADER_MULTI_LAYER_PARALLAX;
  const environment = (material.flags1 & SLSF1_ENVIRONMENT_MAPPING) !== 0 || multiLayer;
  const glow = material.shaderType === SHADER_GLOW && (material.flags2 & SLSF2_GLOW_MAP) !== 0;
  const rimSoft = (material.flags2 & (SLSF2_SOFT_LIGHTING | SLSF2_RIM_LIGHTING)) !== 0;
  const backLight = (material.flags2 & SLSF2_BACK_LIGHTING) !== 0;
  const specularMap =
    (material.flags1 & SLSF1_MODEL_SPACE_NORMALS) !== 0 && (material.flags1 & SLSF1_SPECULAR) !== 0;
  return [
    slot(0),
    slot(1),
    glow || rimSoft ? slot(2) : '',
    environment ? slot(4) : '',
    environment ? slot(5) : '',
    backLight || specularMap ? slot(7) : '',
    multiLayer
      ? slot(6)
      : material.shaderType === SHADER_PARALLAX
        ? slot(3)
        : material.shaderType === SHADER_LOD_LANDSCAPE_NOISE
          ? LOD_LANDSCAPE_NOISE
          : '',
  ];
}

/** Debug views of the lighting shader (dev tools): what a pixel shows instead of its colour. */
export const DebugView = {
  lit: 0,
  albedo: 1,
  normals: 2,
  lightOnly: 3,
  vertexColors: 4,
  geometryNormals: 5,
  /** The ambient occlusion (sao.wgsl) alone. */
  ambientOcclusion: 6,
} as const;

export class SceneRenderer {
  /** One of DebugView; 0 shows the normal image. */
  debugView = 0;
  /** Water type for water surfaces whose placement names none (DefaultWater). */
  defaultWater: GpuWaterType | undefined;
  readonly #device: GPUDevice;
  readonly #colorFormat: GPUTextureFormat;
  readonly #frameBuffer: GPUBuffer;
  readonly #frameData = new Float32Array(FRAME_FLOATS);
  readonly #frameUints = new Uint32Array(this.#frameData.buffer);
  readonly #lightBuffer: GPUBuffer;
  readonly #lightData = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS);
  #frameBindGroup: GPUBindGroup;
  readonly #frameLayout: GPUBindGroupLayout;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  /** Skinned parts: a fourth group with the draw's bone palette. */
  readonly #boneLayout: GPUBindGroupLayout;
  readonly #skinnedPipelineLayout: GPUPipelineLayout;
  readonly #skinnedShadowLayout: GPUPipelineLayout;
  readonly #shadowLayout: GPUPipelineLayout;
  readonly #modules: {
    readonly lighting: GPUShaderModule;
    readonly effect: GPUShaderModule;
    readonly water: GPUShaderModule;
    readonly particle: GPUShaderModule;
    readonly refraction: GPUShaderModule;
  };
  readonly #waterTypeLayout: GPUBindGroupLayout;
  readonly #waterPipelineLayout: GPUPipelineLayout;
  readonly #waterFrameBuffer: GPUBuffer;
  readonly #waterFrameBindGroup: GPUBindGroup;
  readonly #waterFrameData = new Float32Array(WATER_FRAME_FLOATS);
  readonly #screenSampler: GPUSampler;
  /** Stand-ins for the opaque scene's copies until the renderer provides them. */
  readonly #noSceneColor: GPUTexture;
  readonly #noSceneDepth: GPUTexture;
  /** Flow map without flow (alpha 1: strength 0). */
  readonly #stillFlow: GPUTexture;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  /** Second passes of multi-pass directional materials, per part and material. */
  readonly #passParts = new WeakMap<GpuPart, Map<GpuDirectionalMaterial, GpuPart>>();
  readonly #fallbackVertices: GPUBuffer;
  /** Material samplers by texture clamp mode (bit 0 wraps U, bit 1 wraps V). */
  readonly #samplers: readonly GPUSampler[];
  /** This frame's particle instances (CPU staging and GPU buffer). */
  #particleData = new Float32Array(4096 * PARTICLE_FLOATS);
  #particleBuffer: GPUBuffer;
  readonly #shadowMap: GPUTexture;
  readonly #cascadeLayout: GPUBindGroupLayout;
  readonly #cascadeBuffer: GPUBuffer;
  readonly #cascadeBindGroup: GPUBindGroup;
  readonly #shadowModule: GPUShaderModule;
  readonly #shadowSampler: GPUSampler;
  /** Planes of the camera's frustum this frame (culling). */
  #planes: readonly Plane[] = [];
  /** Loaded cells this frame (object LOD leaves them out). */
  #lodMask: LodMask | undefined;
  /** Cells whose large references are loaded this frame. */
  #largeRefMask: LargeRefMask | undefined;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
    this.#device = device;
    this.#colorFormat = colorFormat;

    const frameLayout = (this.#frameLayout = device.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d-array' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    }));
    this.#shadowMap = device.createTexture({
      label: 'sun-shadow-map',
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, SHADOW_TEXTURE_LAYERS],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#cascadeLayout = device.createBindGroupLayout({
      label: 'shadow-cascade',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { hasDynamicOffset: true, minBindingSize: 64 },
        },
      ],
    });
    this.#cascadeBuffer = device.createBuffer({
      label: 'shadow-cascades',
      size: CASCADE_STRIDE * SHADOW_TEXTURE_LAYERS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#cascadeBindGroup = device.createBindGroup({
      label: 'shadow-cascade',
      layout: this.#cascadeLayout,
      entries: [{ binding: 0, resource: { buffer: this.#cascadeBuffer, size: 64 } }],
    });
    this.#shadowModule = device.createShaderModule({ label: 'shadow', code: shadowShader });
    this.#drawLayout = device.createBindGroupLayout({
      label: 'draw',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { hasDynamicOffset: true, minBindingSize: DRAW_SIZE },
        },
      ],
    });
    const texture2d = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {},
    });
    this.#materialLayout = device.createBindGroupLayout({
      label: 'material',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        texture2d(1),
        texture2d(2),
        texture2d(3),
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        texture2d(5),
        texture2d(6),
        texture2d(7),
        texture2d(8),
        texture2d(9),
        texture2d(10),
      ],
    });
    this.#pipelineLayout = device.createPipelineLayout({
      label: 'object',
      bindGroupLayouts: [frameLayout, this.#drawLayout, this.#materialLayout],
    });
    this.#boneLayout = device.createBindGroupLayout({
      label: 'bones',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage', hasDynamicOffset: true, minBindingSize: 48 },
        },
      ],
    });
    this.#skinnedPipelineLayout = device.createPipelineLayout({
      label: 'object-skinned',
      bindGroupLayouts: [frameLayout, this.#drawLayout, this.#materialLayout, this.#boneLayout],
    });
    this.#shadowLayout = device.createPipelineLayout({
      label: 'shadow',
      bindGroupLayouts: [this.#cascadeLayout, this.#drawLayout, this.#materialLayout],
    });
    this.#skinnedShadowLayout = device.createPipelineLayout({
      label: 'shadow-skinned',
      bindGroupLayouts: [
        this.#cascadeLayout,
        this.#drawLayout,
        this.#materialLayout,
        this.#boneLayout,
      ],
    });
    this.#waterTypeLayout = device.createBindGroupLayout({
      label: 'water-type',
      entries: [
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        texture2d(8),
        texture2d(9),
        texture2d(10),
        texture2d(11),
      ],
    });
    const waterFrameLayout = device.createBindGroupLayout({
      label: 'water-frame',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    this.#waterPipelineLayout = device.createPipelineLayout({
      label: 'water',
      bindGroupLayouts: [frameLayout, this.#drawLayout, this.#waterTypeLayout, waterFrameLayout],
    });
    this.#waterFrameBuffer = device.createBuffer({
      label: 'water-frame',
      size: WATER_FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#waterFrameBindGroup = device.createBindGroup({
      label: 'water-frame',
      layout: waterFrameLayout,
      entries: [{ binding: 0, resource: { buffer: this.#waterFrameBuffer } }],
    });
    this.#noSceneColor = device.createTexture({
      label: 'no-scene-color',
      format: 'rgba16float',
      size: [1, 1],
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#noSceneDepth = device.createTexture({
      label: 'no-scene-depth',
      format: 'r32float',
      size: [1, 1],
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#particleBuffer = device.createBuffer({
      label: 'particles',
      size: this.#particleData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.#stillFlow = device.createTexture({
      label: 'still-flow',
      format: 'rgba8unorm',
      size: [1, 1],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.#stillFlow },
      Uint8Array.from([128, 128, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.#screenSampler = device.createSampler({
      label: 'screen',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.#frameBuffer = device.createBuffer({
      label: 'frame',
      size: this.#frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#lightBuffer = device.createBuffer({
      label: 'point-lights',
      size: this.#lightData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#shadowSampler = device.createSampler({
      label: 'shadow',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.#frameBindGroup = this.#createFrameBindGroup(
      this.#noSceneColor.createView(),
      this.#noSceneDepth.createView(),
    );
    this.#modules = {
      lighting: device.createShaderModule({
        label: 'lighting',
        code: frameShader + snowShader + commonShader + skinningShader + lightingShader,
      }),
      effect: device.createShaderModule({
        label: 'effect',
        code: frameShader + commonShader + skinningShader + effectShader,
      }),
      water: device.createShaderModule({
        label: 'water',
        code: frameShader + commonShader + waterShader,
      }),
      refraction: device.createShaderModule({
        label: 'refraction',
        code: frameShader + commonShader + skinningShader + refractionShader,
      }),
      particle: device.createShaderModule({
        label: 'particle',
        code: frameShader + commonShader + effectShader + particleShader,
      }),
    };
    this.#fallbackVertices = createBuffer(
      device,
      FALLBACK_VERTEX,
      GPUBufferUsage.VERTEX,
      'fallback-vertex',
    );
    const address = (wrap: boolean): GPUAddressMode => (wrap ? 'repeat' : 'clamp-to-edge');
    this.#samplers = [0, 1, 2, 3].map((mode) =>
      device.createSampler({
        label: `material-${String(mode)}`,
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: address((mode & 1) !== 0),
        addressModeV: address((mode & 2) !== 0),
        maxAnisotropy: 8,
      }),
    );
  }

  #createFrameBindGroup(sceneColor: GPUTextureView, sceneDepth: GPUTextureView): GPUBindGroup {
    return this.#device.createBindGroup({
      label: 'frame',
      layout: this.#frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#frameBuffer } },
        { binding: 1, resource: { buffer: this.#lightBuffer } },
        { binding: 2, resource: this.#shadowMap.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: this.#shadowSampler },
        { binding: 4, resource: sceneColor },
        { binding: 5, resource: sceneDepth },
        { binding: 6, resource: this.#screenSampler },
      ],
    });
  }

  /**
   * The copies of the opaque scene (colour, and depth as r32float) that the blended pass
   * reads: water, soft effects and particles. Called when the render targets change.
   */
  setSceneCopies(sceneColor: GPUTextureView, sceneDepth: GPUTextureView): void {
    this.#frameBindGroup = this.#createFrameBindGroup(sceneColor, sceneDepth);
  }

  /** Uploads a model; resolves once all its textures are loaded (missing ones use defaults). */
  async createModel(data: ModelData, textures: TextureCache): Promise<GpuModel> {
    const device = this.#device;
    const buffers: GPUBuffer[] = [];
    const parts = await Promise.all(
      data.parts.map(async (part): Promise<GpuPart> => {
        const vertexBuffer = createBuffer(device, part.vertices, GPUBufferUsage.VERTEX, part.name);
        const indexBuffer = createBuffer(device, part.indices, GPUBufferUsage.INDEX, part.name);
        buffers.push(vertexBuffer, indexBuffer);
        const water = part.material?.kind === 'water';
        // Refraction shapes write the refraction buffer (each covers what is behind it).
        const refraction = isRefraction(part.material);
        const blend = water || refraction ? undefined : blendState(part.alpha);
        return {
          part,
          vertexBuffer,
          indexBuffer,
          indexCount: part.indices.length,
          pipeline: water ? this.#waterPipeline(part) : this.#pipeline(part, blend),
          bindGroup: await this.#materialBindGroup(part.material, part.name, textures),
          pass: water
            ? 'water'
            : refraction
              ? 'refraction'
              : blend !== undefined
                ? 'transparent'
                : 'opaque',
          shadowPipeline:
            !water &&
            !refraction &&
            blend === undefined &&
            part.material?.kind === 'lighting' &&
            (part.material.flags1 & SLSF1_CAST_SHADOWS) !== 0 &&
            !isLod(part.material)
              ? this.#shadowPipeline(part)
              : undefined,
        };
      }),
    );
    const particles = await Promise.all(
      data.particles.map(async (system): Promise<GpuParticleSystem> => ({
        data: system,
        pipeline: this.#particlePipeline(system),
        bindGroup: await this.#materialBindGroup(system.material, system.name, textures),
      })),
    );
    const texturePaths = new Set<string>();
    for (const material of [
      ...data.parts.map((part) => part.material),
      ...data.particles.map((system) => system.material),
    ]) {
      for (const path of materialTextures(material)) if (path !== '') texturePaths.add(path);
    }
    return new GpuModel({
      center: data.center,
      radius: data.radius,
      parts,
      buffers,
      animation: data.animation,
      sequences: data.sequences,
      particles,
      textures: { cache: textures, paths: [...texturePaths] },
      leafAnimation: data.leafAnimation === true,
    });
  }

  /**
   * Places model instances (with the models attached at their AddOnNodes); writes one
   * uniform slot per (instance, part) and per (instance, particle system).
   */
  createScene(
    instances: readonly ModelInstance[],
    options: { readonly sky?: boolean; readonly lodSnow?: LodSnow } = {},
  ): GpuScene {
    const sky = options.sky === true;
    const lodSnow = options.lodSnow;
    const placed: ModelInstance[] = [];
    const movingAddons: MovingAddon[] = [];
    const place = (instance: ModelInstance, depth: number): void => {
      placed.push(instance);
      if (depth >= 2) return;
      for (const addon of instance.model.addons) {
        const world = multiply(instance.world, addon.world);
        // On a moving instance the add-on moves along.
        const motion = instance.motion;
        if (motion) {
          movingAddons.push({
            parent: instance.world,
            local: addon.world,
            world,
            motion,
            version: -1,
          });
        }
        place({ model: addon.model, world, ...(motion && { motion }) }, depth + 1);
      }
    };
    for (const instance of instances) place(instance, 0);

    // Multi-pass directional materials draw the static's opaque lighting parts twice.
    const passParts = (instance: ModelInstance): readonly (GpuPart | undefined)[] => {
      const directional = instance.directional?.material;
      if (!directional?.pass || instance.model.animation) return [];
      return instance.model.parts.map((part) => this.#passPart(part, directional));
    };
    const passes = placed.map(passParts);
    const drawCount = placed.reduce(
      (sum, instance, i) =>
        sum +
        instance.model.parts.length +
        instance.model.particles.length +
        (passes[i]?.filter((part) => part !== undefined).length ?? 0),
      0,
    );
    const uniforms = new ArrayBuffer(Math.max(1, drawCount) * DRAW_STRIDE);
    // Bone palettes of skinned parts, each at an aligned offset, in their rest pose.
    let paletteEnd = 0;
    for (const instance of placed) {
      for (const { part } of instance.model.parts) {
        if (!part.skin) continue;
        paletteEnd =
          Math.ceil(paletteEnd / PALETTE_ALIGNMENT) * PALETTE_ALIGNMENT +
          part.skin.bones.length * PALETTE_BONE_FLOATS * 4;
      }
    }
    const boneData =
      paletteEnd > 0
        ? new Float32Array(
            (Math.ceil(paletteEnd / PALETTE_ALIGNMENT) * PALETTE_ALIGNMENT + PALETTE_BYTES) / 4,
          )
        : undefined;
    let paletteCursor = 0;
    const draws: Draw[] = [];
    const animated: AnimatedDraw[] = [];
    const particles: ParticleDraw[] = [];
    const emittance: EmittanceDraw[] = [];
    const moving: MovingDraw[] = [];
    const world = new Float32Array(16);
    let slot = 0;
    for (const [instanceIndex, instance] of placed.entries()) {
      const animation = instance.model.animation;
      const directional = instance.directional;
      const material = directional?.material;
      for (const [partIndex, part] of instance.model.parts.entries()) {
        const offset = slot++ * DRAW_STRIDE;
        // Sky scenes follow the camera: their placement changes every frame.
        const sequences = instance.model.sequences;
        const playback =
          instance.playback && sequences ? { state: instance.playback, sequences } : undefined;
        const graph = graphDraw(instance);
        const skin = part.part.skin;
        let bones: number | undefined;
        if (skin && boneData) {
          bones = Math.ceil(paletteCursor / PALETTE_ALIGNMENT) * PALETTE_ALIGNMENT;
          paletteCursor = bones + skin.bones.length * PALETTE_BONE_FLOATS * 4;
          writeRestPalette(skin, boneData, bones / 4);
        }
        if (animation || part.part.billboard || sky || playback || graph) {
          animated.push({
            offset,
            instanceWorld: instance.world,
            part: part.part,
            animation,
            ...(playback && { playback }),
            ...(graph && { graph }),
            ...(bones !== undefined && { bones }),
          });
        }
        const floats = new Float32Array(uniforms, offset, DRAW_SIZE / 4);
        const uints = new Uint32Array(uniforms, offset, DRAW_SIZE / 4);
        multiply(instance.world, part.part.world, world);
        floats.set(world, 0);
        writeMaterial(floats, uints, part.part);
        if (sky) uints[38] = (uints[38] ?? 0) | SKY_DRAW;
        const partMaterial = part.part.material;
        const source = instance.emittance;
        if (source && partMaterial && partMaterial.kind !== 'water') {
          // External_Emittance: the reference's XEMI colour replaces the emissive colour
          // (lighting, times the emissive multiple) or the effect's light (Effect_Lighting).
          if ((partMaterial.flags1 & SLSF1_EXTERNAL_EMITTANCE) !== 0) {
            const effect = partMaterial.kind === 'effect';
            if (!effect || (partMaterial.flags2 & SLSF2_EFFECT_LIGHTING) !== 0) {
              const entry: EmittanceDraw = {
                offset,
                source,
                multiple: effect ? 0 : partMaterial.emissiveMultiple,
                effect,
                version: source.version,
              };
              writeEmittance(floats, entry);
              emittance.push(entry);
            }
          }
        }
        if (partMaterial?.kind === 'lighting' && (partMaterial.flags2 & SLSF2_TREE_ANIM) !== 0) {
          // Trees have no directional material: the projection slot holds the leaf amplitude,
          // the leaf frequency and whether the leaf animation node runs its timer (without
          // one the engine uses amplitude and frequency 1 and a stopped timer).
          const leaves = instance.leafAnimation;
          floats.set(
            [
              leaves?.amplitude ?? 1,
              leaves?.frequency ?? 1,
              instance.model.leafAnimation ? 1 : 0,
              0,
            ],
            48,
          );
          uints[38] = (uints[38] ?? 0) | DRAW_TREE_ANIM;
        } else if (partMaterial?.kind === 'lighting') {
          const snow = directional?.snow === true ? DRAW_SNOW : 0;
          if (isLod(partMaterial)) {
            // Object LOD of snowy statics: shapes named "objsnow" (HD: "objsnowHD"); of
            // ashen ones (Solstheim) "objash".
            const name = part.part.name.toLowerCase();
            const hd = name.includes('hd');
            const snowLod = name.startsWith('objsnow')
              ? hd
                ? lodSnow?.hd
                : lodSnow?.normal
              : name.startsWith('objash')
                ? hd
                  ? lodSnow?.ashHd
                  : lodSnow?.ash
                : undefined;
            if (snowLod) {
              writeProjected(
                floats,
                uints,
                snowLod.material,
                snowLod.maxAngle,
                hd ? DRAW_LOD_HD : 0,
              );
            }
          } else if (material?.object.singlePass && directional) {
            writeProjected(floats, uints, material.object, directional.maxAngle, snow);
          } else {
            uints[38] = (uints[38] ?? 0) | snow;
          }
        }
        const draw: Draw = {
          part,
          uniformOffset: offset,
          center: transformPoint(instance.world, part.part.center),
          radius: part.part.radius * maxScale(instance.world),
          water: part.pass === 'water' ? instance.water : undefined,
          sky,
          lodSegments: lodSegments(part.part, world),
          bones,
        };
        draws.push(draw);
        if (instance.motion) {
          moving.push({
            draw,
            instanceWorld: instance.world,
            part: part.part,
            animated: animation !== undefined || part.part.billboard !== undefined,
            motion: instance.motion,
            version: instance.motion.version,
          });
        }
        const passPart = passes[instanceIndex]?.[partIndex];
        if (passPart && directional?.material) {
          // The material's own shader, drawn over the part along the material's projection.
          const passOffset = slot++ * DRAW_STRIDE;
          const passFloats = new Float32Array(uniforms, passOffset, DRAW_SIZE / 4);
          const passUints = new Uint32Array(uniforms, passOffset, DRAW_SIZE / 4);
          passFloats.set(world, 0);
          writeMaterial(passFloats, passUints, passPart.part);
          writeMultiPass(
            passFloats,
            passUints,
            directional.material.object,
            directional.maxAngle,
            directional.snow,
          );
          const passDraw: Draw = {
            part: passPart,
            uniformOffset: passOffset,
            center: transformPoint(instance.world, part.part.center),
            radius: part.part.radius * maxScale(instance.world),
            water: undefined,
            sky,
            lodSegments: undefined,
            bones,
          };
          draws.push(passDraw);
          if (instance.motion) {
            moving.push({
              draw: passDraw,
              instanceWorld: instance.world,
              part: part.part,
              animated: false,
              motion: instance.motion,
              version: instance.motion.version,
            });
          }
        }
      }
      instance.model.particles.forEach((system, index) => {
        const offset = slot++ * DRAW_STRIDE;
        const floats = new Float32Array(uniforms, offset, DRAW_SIZE / 4);
        const uints = new Uint32Array(uniforms, offset, DRAW_SIZE / 4);
        // Particles are written in world space.
        floats.set(identity(), 0);
        writeMaterial(floats, uints, system.data);
        floats[28] = system.data.aspectRatio;
        const rest = system.data.objects.get(system.data.block) ?? identity();
        const origin = transformPoint(multiply(instance.world, rest), [0, 0, 0]);
        // Each placement gets its own random sequence, the same every time it loads.
        const seed = Math.imul(
          (Math.round(origin[0]) * 73856093) ^ (Math.round(origin[1]) * 19349663),
          (Math.round(origin[2]) * 83492791) ^ (index + 1),
        );
        const graph = graphDraw(instance);
        particles.push({
          system,
          simulation: new ParticleSimulation(system.data, seed),
          instanceWorld: instance.world,
          animation,
          ...(graph && { graph }),
          uniformOffset: offset,
          origin,
          first: 0,
          count: 0,
          updated: undefined,
        });
      });
    }
    const buffer = createBuffer(
      this.#device,
      new Uint8Array(uniforms),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      'draw-uniforms',
    );
    const bindGroup = this.#device.createBindGroup({
      label: 'draw',
      layout: this.#drawLayout,
      entries: [{ binding: 0, resource: { buffer, size: DRAW_SIZE } }],
    });
    const models = [...new Set(placed.map((instance) => instance.model))];
    return new GpuScene(
      draws,
      bindGroup,
      buffer,
      uniforms,
      animated,
      particles,
      models,
      emittance,
      { draws: moving, addons: movingAddons },
      boneData && this.#sceneBones(boneData),
    );
  }

  /** Uploads a scene's bone palettes; every draw binds its own at a dynamic offset. */
  #sceneBones(data: Float32Array): SceneBones {
    const buffer = createBuffer(
      this.#device,
      new Uint8Array(data.buffer),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'bone-palettes',
    );
    const bindGroup = this.#device.createBindGroup({
      label: 'bones',
      layout: this.#boneLayout,
      entries: [{ binding: 0, resource: { buffer, size: PALETTE_BYTES } }],
    });
    return { buffer, bindGroup, data };
  }

  updateFrame(
    viewProjection: Mat4,
    cameraPosition: Vec3,
    lighting: SceneLighting,
    timeSeconds = 0,
    lodMask?: LodMask,
    shadows?: FrameShadows,
    screen?: { readonly width: number; readonly height: number; readonly near: number },
    largeRefMask?: LargeRefMask,
  ): void {
    this.#planes = frustumPlanes(viewProjection);
    this.#lodMask = lodMask;
    this.#largeRefMask = largeRefMask;
    const data = this.#frameData;
    data.set(viewProjection, 0);
    data.set([...cameraPosition, 1], 16);
    data.set([...lighting.sunDirection, 0], 20);
    data.set([...lighting.sunColor, 1], 24);
    lighting.ambient.forEach((color, i) => {
      data.set([...color, 1], 28 + i * 4);
    });
    const fog = lighting.fog;
    data.set([...(fog?.nearColor ?? [0, 0, 0]), 1], 52);
    data.set([...(fog?.farColor ?? [0, 0, 0]), 1], 56);
    data.set([fog?.near ?? 0, fog?.far ?? 1, fog?.power ?? 1, fog?.max ?? 0], 60);
    const lightCount = Math.min(MAX_LIGHTS, lighting.lights.length);
    this.#frameUints.set([lightCount, fog ? 1 : 0, this.debugView, 0], 64);
    data.set([timeSeconds, lighting.wind ?? 0, 0, 0], 68);
    new Int32Array(data.buffer, 72 * 4, 4).set([
      lodMask?.originX ?? 0,
      lodMask?.originY ?? 0,
      lodMask?.low ?? 0,
      lodMask?.high ?? 0,
    ]);
    const cascades = shadows?.cascades ?? [];
    cascades.slice(0, SHADOW_MAP_LAYERS).forEach((cascade, i) => {
      data.set(cascade.viewProj, 76 + i * 16);
      this.#device.queue.writeBuffer(this.#cascadeBuffer, i * CASCADE_STRIDE, cascade.viewProj);
    });
    data.set(
      Array.from({ length: SHADOW_MAP_LAYERS }, (_, i) => cascades[i]?.far ?? 0),
      140,
    );
    data.set(
      [cascades.length > 0 ? 1 : 0, SHADOW_MAP_SIZE, SHADOW_DEPTH_BIAS, SHADOW_NORMAL_OFFSET],
      144,
    );
    data.set(
      [
        1 / Math.max(1, screen?.width ?? 1),
        1 / Math.max(1, screen?.height ?? 1),
        screen?.near ?? 1,
        0,
      ],
      148,
    );
    // The camera's right and up axes: the first two rows of the view-projection (the
    // projection only scales them).
    const axis = (row: number): number[] => {
      const v = [
        viewProjection[row] ?? 0,
        viewProjection[4 + row] ?? 0,
        viewProjection[8 + row] ?? 0,
      ];
      const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
      return [(v[0] ?? 0) / length, (v[1] ?? 0) / length, (v[2] ?? 0) / length, 0];
    };
    data.set(axis(0), 152);
    data.set(axis(1), 156);
    data.set(invert(viewProjection) ?? viewProjection, 160);
    this.#device.queue.writeBuffer(this.#frameBuffer, 0, data);

    if (lightCount > 0) {
      for (let i = 0; i < lightCount; i++) {
        const light = lighting.lights[i];
        if (!light) continue;
        this.#lightData.set([...light.position, light.radius, ...light.color, 0], i * LIGHT_FLOATS);
      }
      this.#device.queue.writeBuffer(
        this.#lightBuffer,
        0,
        this.#lightData,
        0,
        lightCount * LIGHT_FLOATS,
      );
    }
  }

  /** Frame bind group layout (group 0), shared with the terrain and other world shaders. */
  get frameLayout(): GPUBindGroupLayout {
    return this.#frameLayout;
  }

  get frameBindGroup(): GPUBindGroup {
    return this.#frameBindGroup;
  }

  /**
   * Plays the models' controllers: rewrites the uniforms of animated draws for this moment
   * (each model's animation is evaluated once per call), and runs the particle systems near
   * the camera or in view (`wind`: the weather's wind in units per second).
   */
  animate(scenes: Iterable<GpuScene>, seconds: number, camera: Vec3, wind: Vec3 = [0, 0, 0]): void {
    const frames = new Map<ModelAnimation, AnimationFrame>();
    const frameOf = (animation: ModelAnimation | undefined): AnimationFrame | undefined => {
      if (!animation) return undefined;
      let frame = frames.get(animation);
      if (!frame) {
        frame = animate(animation, seconds);
        frames.set(animation, frame);
      }
      return frame;
    };
    const world = new Float32Array(16);
    const sceneList = [...scenes];
    // Each instance's sequence is evaluated once per frame.
    const played = new Map<Playback, AnimationFrame | undefined>();
    const playedFrame = (playback: AnimatedDraw['playback']): AnimationFrame | undefined => {
      if (!playback) return undefined;
      if (!played.has(playback.state)) {
        played.set(playback.state, playSequence(playback.sequences, playback.state, seconds));
      }
      return played.get(playback.state);
    };
    // Each instance's behavior graph advances, and is evaluated, once per frame.
    const graphFrames = new Map<ObjectGraph, AnimationFrame>();
    const graphFrame = (graph: GraphDraw | undefined): AnimationFrame | undefined => {
      if (!graph) return undefined;
      let frame = graphFrames.get(graph.player);
      if (!frame) {
        graph.player.update(seconds);
        const layers: AnimationLayer[] = [];
        if (graph.animation) layers.push({ tracks: graph.animation.tracks, seconds });
        for (const playing of graph.player.playing) {
          const sequence = graph.sequences.byName.get(playing.sequence);
          if (sequence) layers.push({ tracks: sequence.tracks, seconds: seconds - playing.start });
        }
        frame = animateLayers(graph.sequences, layers);
        graphFrames.set(graph.player, frame);
      }
      return frame;
    };
    for (const scene of sceneList) {
      // Moving instances: add-ons follow, then the draws that moved get their new place.
      for (const addon of scene.movingAddons) {
        if (addon.version === addon.motion.version) continue;
        addon.version = addon.motion.version;
        multiply(addon.parent, addon.local, addon.world);
      }
      for (const entry of scene.moving) {
        if (entry.version === entry.motion.version) continue;
        entry.version = entry.motion.version;
        entry.draw.center = transformPoint(entry.instanceWorld, entry.part.center);
        if (entry.animated) continue;
        const floats = new Float32Array(scene.uniformData, entry.draw.uniformOffset, 16);
        multiply(entry.instanceWorld, entry.part.world, world);
        floats.set(world, 0);
        this.#device.queue.writeBuffer(
          scene.uniforms,
          entry.draw.uniformOffset,
          scene.uniformData,
          entry.draw.uniformOffset,
          64,
        );
      }
      for (const draw of scene.animated) {
        const frame =
          playedFrame(draw.playback) ?? graphFrame(draw.graph) ?? frameOf(draw.animation);
        const floats = new Float32Array(scene.uniformData, draw.offset, DRAW_SIZE / 4);
        const billboard = draw.part.billboard;
        if (frame?.hidden.has(draw.part.block)) {
          floats.fill(0, 0, 16);
        } else if (billboard) {
          const node = multiply(draw.instanceWorld, billboard.node);
          multiply(billboardWorld(node, billboard.mode, camera), billboard.local, world);
          floats.set(world, 0);
        } else {
          // A skinned shape is placed by its bones, never by its own node.
          const local = draw.part.skin
            ? draw.part.world
            : (frame?.worlds.get(draw.part.block) ?? draw.part.world);
          multiply(draw.instanceWorld, local, world);
          floats.set(world, 0);
        }
        if (frame) writeAnimatedMaterial(floats, draw.part, frame);
        const skin = draw.part.skin;
        const bones = scene.bones;
        if (frame && skin && bones && draw.bones !== undefined) {
          writePosedPalette(
            skin,
            (i) => frame.worlds.get(skin.bones[i] ?? -1),
            bones.data,
            draw.bones / 4,
          );
          this.#device.queue.writeBuffer(
            bones.buffer,
            draw.bones,
            bones.data,
            draw.bones / 4,
            skin.bones.length * PALETTE_BONE_FLOATS,
          );
        }
        this.#device.queue.writeBuffer(
          scene.uniforms,
          draw.offset,
          scene.uniformData,
          draw.offset,
          DRAW_SIZE,
        );
      }
      // Emittance colours change with the hour (windows lit at night, sunbeams by day).
      for (const entry of scene.emittance) {
        if (entry.version === entry.source.version) continue;
        entry.version = entry.source.version;
        writeEmittance(new Float32Array(scene.uniformData, entry.offset, DRAW_SIZE / 4), entry);
        this.#device.queue.writeBuffer(
          scene.uniforms,
          entry.offset,
          scene.uniformData,
          entry.offset,
          DRAW_SIZE,
        );
      }
    }
    this.#runParticles(sceneList, seconds, camera, wind, (draw) =>
      draw.graph ? graphFrame(draw.graph) : frameOf(draw.animation),
    );
  }

  /** Updates the particle systems and gathers their instances into this frame's buffer. */
  #runParticles(
    scenes: readonly GpuScene[],
    seconds: number,
    camera: Vec3,
    wind: Vec3,
    frameOf: (draw: ParticleDraw) => AnimationFrame | undefined,
  ): void {
    let needed = 0;
    for (const scene of scenes) {
      for (const draw of scene.particles) needed += draw.simulation.data.maxParticles;
    }
    if (needed === 0) return;
    let cursor = 0;
    for (const scene of scenes) {
      for (const draw of scene.particles) {
        draw.count = 0;
        const simulation = draw.simulation;
        const frame = frameOf(draw);
        if (frame?.hidden.has(simulation.data.block)) continue;
        const distance = Math.hypot(
          draw.origin[0] - camera[0],
          draw.origin[1] - camera[1],
          draw.origin[2] - camera[2],
        );
        if (distance > PARTICLE_MAX_DISTANCE) continue;
        const inView =
          sphereVisible(this.#planes, draw.origin, 512) ||
          (simulation.count > 0 &&
            sphereVisible(this.#planes, simulation.center, simulation.radius));
        if (distance > PARTICLE_UPDATE_DISTANCE && !inView) continue;
        // Time since this system last ran (it may have been out of view for a while).
        const step =
          draw.updated === undefined
            ? 0
            : Math.max(0, Math.min(PARTICLE_MAX_STEP, seconds - draw.updated));
        const context: ParticleContext = {
          seconds,
          dt: step,
          instanceWorld: draw.instanceWorld,
          animated: frame?.worlds,
          camera,
          wind,
          ...(draw.graph && { sequences: draw.graph.player.playing }),
        };
        simulation.update(context);
        draw.updated = seconds;
        if (simulation.count === 0 || !inView) continue;
        const instances = simulation.instanceCount;
        this.#ensureParticleCapacity((cursor + instances) * PARTICLE_FLOATS);
        draw.first = cursor;
        draw.count = simulation.write(this.#particleData, cursor * PARTICLE_FLOATS, context);
        cursor += draw.count;
        if (frame) {
          const floats = new Float32Array(scene.uniformData, draw.uniformOffset, DRAW_SIZE / 4);
          writeAnimatedMaterial(floats, simulation.data, frame);
          this.#device.queue.writeBuffer(
            scene.uniforms,
            draw.uniformOffset,
            scene.uniformData,
            draw.uniformOffset,
            DRAW_SIZE,
          );
        }
      }
    }
    if (cursor === 0) return;
    if (this.#particleBuffer.size < this.#particleData.byteLength) {
      this.#particleBuffer.destroy();
      this.#particleBuffer = this.#device.createBuffer({
        label: 'particles',
        size: this.#particleData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.#device.queue.writeBuffer(
      this.#particleBuffer,
      0,
      this.#particleData,
      0,
      cursor * PARTICLE_FLOATS,
    );
  }

  #ensureParticleCapacity(floats: number): void {
    if (this.#particleData.length >= floats) return;
    let size = this.#particleData.length;
    while (size < floats) size *= 2;
    const grown = new Float32Array(size);
    grown.set(this.#particleData);
    this.#particleData = grown;
  }

  /** Whether the blended pass reads copies of the opaque scene (water, effects, particles). */
  needsSceneCopies(scenes: Iterable<GpuScene>): boolean {
    for (const scene of scenes) {
      if (scene.particles.some((draw) => draw.count > 0)) return true;
      if (scene.draws.some((draw) => draw.part.pass !== 'opaque')) return true;
    }
    return false;
  }

  /** Draws the opaque parts of scenes. */
  drawOpaque(pass: GPURenderPassEncoder, scenes: Iterable<GpuScene>): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (draw.part.pass === 'opaque' && this.#visible(draw)) this.#drawPart(pass, scene, draw);
      }
    }
  }

  /** Whether any scene has water surfaces (they need copies of the opaque scene). */
  hasWater(scenes: Iterable<GpuScene>): boolean {
    for (const scene of scenes) {
      if (scene.draws.some((draw) => draw.part.pass === 'water')) return true;
    }
    return false;
  }

  /** Draws water surfaces (they read the opaque scene's copies, see setSceneCopies). */
  drawWater(pass: GPURenderPassEncoder, scenes: Iterable<GpuScene>): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    pass.setBindGroup(3, this.#waterFrameBindGroup);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (draw.part.pass !== 'water' || !this.#visible(draw)) continue;
        const type = draw.water ?? this.defaultWater;
        if (!type) continue;
        const { part } = draw;
        pass.setPipeline(part.pipeline);
        pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
        pass.setBindGroup(2, type.bindGroup);
        pass.setVertexBuffer(0, part.vertexBuffer);
        pass.setIndexBuffer(part.indexBuffer, 'uint16');
        pass.drawIndexed(part.indexCount);
      }
    }
  }

  /** Whether any refraction shape is in view (the frame then runs the refraction passes). */
  hasRefraction(scenes: Iterable<GpuScene>): boolean {
    for (const scene of scenes) {
      if (scene.draws.some((draw) => draw.part.pass === 'refraction' && this.#visible(draw))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Draws the refraction shapes into the refraction buffer, back to front (depth-tested
   * against the scene, never writing depth).
   */
  drawRefraction(
    pass: GPURenderPassEncoder,
    scenes: Iterable<GpuScene>,
    cameraPosition: Vec3,
  ): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    const shapes: { scene: GpuScene; draw: Draw; distance: number }[] = [];
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (draw.part.pass !== 'refraction' || !this.#visible(draw)) continue;
        const dx = draw.center[0] - cameraPosition[0];
        const dy = draw.center[1] - cameraPosition[1];
        const dz = draw.center[2] - cameraPosition[2];
        shapes.push({ scene, draw, distance: dx * dx + dy * dy + dz * dz });
      }
    }
    shapes.sort((a, b) => b.distance - a.distance);
    for (const { scene, draw } of shapes) this.#drawPart(pass, scene, draw);
  }

  /** Draws the blended parts and particle systems of all scenes back to front. */
  drawTransparent(
    pass: GPURenderPassEncoder,
    scenes: Iterable<GpuScene>,
    cameraPosition: Vec3,
  ): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    type Blended =
      | { scene: GpuScene; draw: Draw; particles?: undefined; distance: number }
      | { scene: GpuScene; draw?: undefined; particles: ParticleDraw; distance: number };
    const transparent: Blended[] = [];
    const distance = (center: readonly number[]): number => {
      const dx = (center[0] ?? 0) - cameraPosition[0];
      const dy = (center[1] ?? 0) - cameraPosition[1];
      const dz = (center[2] ?? 0) - cameraPosition[2];
      return dx * dx + dy * dy + dz * dz;
    };
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (draw.part.pass !== 'transparent' || !this.#visible(draw)) continue;
        // Sky objects behind everything, the largest (farthest) first.
        const behind = draw.sky ? SKY_DISTANCE + draw.radius : distance(draw.center);
        transparent.push({ scene, draw, distance: behind });
      }
      for (const particles of scene.particles) {
        if (particles.count === 0) continue;
        transparent.push({ scene, particles, distance: distance(particles.simulation.center) });
      }
    }
    transparent.sort((a, b) => b.distance - a.distance);
    for (const item of transparent) {
      if (item.draw) {
        pass.setVertexBuffer(1, this.#fallbackVertices);
        this.#drawPart(pass, item.scene, item.draw);
        continue;
      }
      const { system, uniformOffset, first, count } = item.particles;
      pass.setPipeline(system.pipeline);
      pass.setBindGroup(1, item.scene.drawBindGroup, [uniformOffset]);
      pass.setBindGroup(2, system.bindGroup);
      pass.setVertexBuffer(0, this.#particleBuffer);
      pass.draw(6, count, 0, first);
    }
  }

  /**
   * Uploads a water type (its noise textures load first). Rivers (WaterFlag.flowmap) get the
   * flow map of the cell they are drawn in.
   */
  async createWaterType(
    type: WaterType,
    textures: TextureCache,
    flow?: WaterFlow,
  ): Promise<GpuWaterType> {
    const device = this.#device;
    const data = new Float32Array(WATER_PARAM_FLOATS);
    const radians = (degrees: number): number => (degrees * Math.PI) / 180;
    data.set([...type.shallowColor, type.opacity], 0);
    data.set([...type.deepColor, type.reflectivity], 4);
    data.set([...type.reflectionColor, type.fresnel], 8);
    data.set(
      [type.refractionMagnitude, type.reflectionMagnitude, type.noiseFalloff, type.flowmapScale],
      12,
    );
    data.set([type.fogNear, type.fogFar, type.fogAmount, 0], 16);
    data.set(
      [
        type.sunSpecularPower,
        type.sunSpecularMagnitude,
        type.sunSparklePower,
        type.sunSparkleMagnitude,
      ],
      20,
    );
    data.set([...type.windDirection.map(radians), 0], 24);
    data.set([...type.windSpeed, 0], 28);
    data.set([...type.uvScale, 0], 32);
    data.set([...type.amplitude, 0], 36);
    const flowTexture = flow ? await textures.get(flow.texture) : undefined;
    data.set([flow?.origin[0] ?? 0, flow?.origin[1] ?? 0, flowTexture ? 1 : 0, 0], 40);
    const buffer = createBuffer(device, data, GPUBufferUsage.UNIFORM, `water-${type.editorId}`);
    const noise = await Promise.all(type.noiseTextures.map((path) => textures.get(path)));
    const view = (index: number): GPUTextureView =>
      (noise[index] ?? noise[0] ?? textures.defaults.flatNormal).createView();
    const bindGroup = device.createBindGroup({
      label: `water-${type.editorId}`,
      layout: this.#waterTypeLayout,
      entries: [
        { binding: 6, resource: { buffer } },
        { binding: 7, resource: this.#repeatSampler },
        { binding: 8, resource: view(0) },
        { binding: 9, resource: view(1) },
        { binding: 10, resource: view(2) },
        { binding: 11, resource: (flowTexture ?? this.#stillFlow).createView() },
      ],
    });
    return new GpuWaterType(type, bindGroup, buffer);
  }

  /** Sky colours and the screen size for this frame's water. */
  updateWaterFrame(frame: WaterFrame | undefined, width: number, height: number): void {
    const data = this.#waterFrameData;
    data.fill(0);
    data.set([...(frame?.horizon ?? [0.5, 0.6, 0.7]), 1], 0);
    data.set([...(frame?.lower ?? [0.4, 0.5, 0.6]), 1], 4);
    data.set([...(frame?.upper ?? [0.3, 0.4, 0.5]), 1], 8);
    data.set([...(frame?.multiplier ?? [1, 1, 1]), 1], 12);
    data.set([1 / Math.max(width, 1), 1 / Math.max(height, 1), frame?.profile ? 1 : 0, 0], 16);
    if (frame?.profile) {
      data.set(frame.profile.subarray(0, 128), 20);
    } else {
      // No sky (interiors): a plain gradient.
      for (let i = 0; i < 32; i++) data.set([1 - i / 31, i / 31, 0, 1], 20 + i * 4);
    }
    this.#device.queue.writeBuffer(this.#waterFrameBuffer, 0, data);
  }

  /** Material bind group layout (group 2 of object shaders), shared with grass. */
  get materialLayout(): GPUBindGroupLayout {
    return this.#materialLayout;
  }

  /** Constant values for vertex attributes a mesh lacks (vertex buffer 1). */
  get fallbackVertices(): GPUBuffer {
    return this.#fallbackVertices;
  }

  /** Planes of the camera's frustum this frame (for culling elsewhere). */
  get viewPlanes(): readonly Plane[] {
    return this.#planes;
  }

  /** The sun's shadow map (its layers are rendered by the frame renderer). */
  get shadowMap(): GPUTexture {
    return this.#shadowMap;
  }

  /** Cascade uniforms (group 0 of shadow pipelines) and their layout, shared with terrain. */
  get cascadeLayout(): GPUBindGroupLayout {
    return this.#cascadeLayout;
  }

  get cascadeBindGroup(): GPUBindGroup {
    return this.#cascadeBindGroup;
  }

  /** Sets the view the precipitation occlusion layer is rendered with (see drawShadows). */
  setOcclusionView(viewProj: Mat4): void {
    this.#device.queue.writeBuffer(
      this.#cascadeBuffer,
      PRECIPITATION_OCCLUSION_LAYER * CASCADE_STRIDE,
      viewProj,
    );
  }

  /** Dynamic offset of a cascade's uniforms. */
  cascadeOffset(cascade: number): number {
    return cascade * CASCADE_STRIDE;
  }

  get shadowModule(): GPUShaderModule {
    return this.#shadowModule;
  }

  /**
   * Draws the shadow casters of scenes into one cascade: culled by its box, and without
   * objects too small to show at its resolution (`minRadius`).
   */
  drawShadows(
    pass: GPURenderPassEncoder,
    scenes: Iterable<GpuScene>,
    cascade: number,
    planes: readonly Plane[],
    minRadius: number,
  ): void {
    pass.setBindGroup(0, this.#cascadeBindGroup, [this.cascadeOffset(cascade)]);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        const { part } = draw;
        if (!part.shadowPipeline || draw.radius < minRadius) continue;
        if (!sphereVisible(planes, draw.center, draw.radius)) continue;
        pass.setPipeline(part.shadowPipeline);
        pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
        pass.setBindGroup(2, part.bindGroup);
        if (draw.bones !== undefined && scene.bones) {
          pass.setBindGroup(3, scene.bones.bindGroup, [draw.bones]);
        }
        pass.setVertexBuffer(0, part.vertexBuffer);
        pass.setIndexBuffer(part.indexBuffer, 'uint16');
        pass.drawIndexed(part.indexCount);
      }
    }
  }

  #visible(draw: Draw): boolean {
    return draw.sky || sphereVisible(this.#planes, draw.center, draw.radius);
  }

  /**
   * Fades a scene's parts (sky objects during weather changes): their material alpha times
   * `fade`.
   */
  fadeScene(scene: GpuScene, fade: number): void {
    for (const draw of scene.draws) {
      const material = draw.part.part.material;
      const base = material?.kind === 'lighting' ? material.alpha : 1;
      const floats = new Float32Array(scene.uniformData, draw.uniformOffset, DRAW_SIZE / 4);
      if (floats[29] === base * fade) continue;
      floats[29] = base * fade;
      this.#device.queue.writeBuffer(
        scene.uniforms,
        draw.uniformOffset,
        scene.uniformData,
        draw.uniformOffset,
        DRAW_SIZE,
      );
    }
  }

  /**
   * The second pass of a multi-pass directional material over a part: the part's geometry
   * with the material's shader (opaque lighting parts only, like the engine's
   * BSMultiIndexTriShape); cached per part and material.
   */
  #passPart(base: GpuPart, directional: GpuDirectionalMaterial): GpuPart | undefined {
    const pass = directional.pass;
    const baseMaterial = base.part.material;
    if (
      !pass ||
      base.pass !== 'opaque' ||
      baseMaterial?.kind !== 'lighting' ||
      isLod(baseMaterial)
    ) {
      return undefined;
    }
    let byMaterial = this.#passParts.get(base);
    if (!byMaterial) {
      byMaterial = new Map();
      this.#passParts.set(base, byMaterial);
    }
    let part = byMaterial.get(directional);
    if (!part) {
      const model: ModelPart = { ...base.part, material: pass.material, alpha: pass.alpha };
      const blend = blendState(pass.alpha);
      part = {
        part: model,
        vertexBuffer: base.vertexBuffer,
        indexBuffer: base.indexBuffer,
        indexCount: base.indexCount,
        pipeline: this.#pipeline(model, blend),
        bindGroup: pass.bindGroup,
        pass: blend === undefined ? 'opaque' : 'transparent',
        shadowPipeline: undefined,
      };
      byMaterial.set(directional, part);
    }
    return part;
  }

  /**
   * A material object ready to draw. `pass` is the shader of a multi-pass material (from
   * its DNAM properties, see propertyMaterial); its textures are loaded here.
   */
  async createDirectionalMaterial(
    object: MaterialObject,
    pass: {
      readonly material: LightingMaterial | EffectMaterial | undefined;
      readonly alpha: AlphaState | undefined;
    },
    textures: TextureCache,
  ): Promise<GpuDirectionalMaterial> {
    const material = pass.material;
    return {
      object,
      pass:
        object.singlePass || !material
          ? undefined
          : {
              material,
              alpha: pass.alpha,
              bindGroup: await this.#materialBindGroup(material, object.editorId, textures),
            },
    };
  }

  #drawPart(pass: GPURenderPassEncoder, scene: GpuScene, draw: Draw): void {
    const { part } = draw;
    pass.setPipeline(part.pipeline);
    pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
    pass.setBindGroup(2, part.bindGroup);
    if (draw.bones !== undefined && scene.bones) {
      pass.setBindGroup(3, scene.bones.bindGroup, [draw.bones]);
    }
    pass.setVertexBuffer(0, part.vertexBuffer);
    pass.setIndexBuffer(part.indexBuffer, 'uint16');
    const segments = draw.lodSegments;
    if (!segments) {
      pass.drawIndexed(part.indexCount);
      return;
    }
    // Object LOD: whole objects of loaded cells are left out, like the engine's per-cell
    // segments; neighbouring segments that stay are drawn in one call.
    let first = -1;
    let end = -1;
    for (const segment of segments) {
      if (
        cellLoaded(this.#lodMask, segment.cellX, segment.cellY) ||
        (segment.largeRef && largeRefsLoaded(this.#largeRefMask, segment.cellX, segment.cellY))
      ) {
        continue;
      }
      if (segment.first === end) {
        end += segment.count;
        continue;
      }
      if (first >= 0) pass.drawIndexed(end - first, 1, first);
      first = segment.first;
      end = segment.first + segment.count;
    }
    if (first >= 0) pass.drawIndexed(end - first, 1, first);
  }

  async #materialBindGroup(
    material: PartMaterial | undefined,
    label: string,
    textures: TextureCache,
  ): Promise<GPUBindGroup> {
    const { defaults } = textures;
    const [diffuse, normal, glow, env, envMask, slot7, slot6] = await Promise.all(
      materialTextures(material).map((path) => textures.get(path)),
    );
    // The engine's directional material textures (not held by models: never evicted).
    const [projectedDiffuse, projectedNormal, projectedNoise] =
      material?.kind === 'lighting' || material?.kind === 'effect'
        ? await Promise.all([
            textures.get(PROJECTED_TEXTURES.diffuse),
            textures.get(PROJECTED_TEXTURES.normal),
            textures.get(PROJECTED_TEXTURES.noise),
          ])
        : [undefined, undefined, undefined];
    const cube = env?.depthOrArrayLayers === 6 ? env : defaults.blackCube;

    const clampMode = material?.kind === 'effect' ? material.textureClampMode & 3 : 3;
    // A few meshes name a cube map in a 2D slot (e.g. an env mask): those slots get defaults.
    const flat = (texture: GPUTexture | undefined): GPUTexture | undefined =>
      texture?.depthOrArrayLayers === 1 ? texture : undefined;
    return this.#device.createBindGroup({
      label,
      layout: this.#materialLayout,
      entries: [
        { binding: 0, resource: this.#samplers[clampMode] ?? this.#repeatSampler },
        { binding: 1, resource: (flat(diffuse) ?? defaults.white).createView() },
        { binding: 2, resource: (flat(normal) ?? defaults.flatNormal).createView() },
        {
          binding: 3,
          resource: (
            flat(glow) ?? (material?.kind === 'effect' ? defaults.white : defaults.black)
          ).createView(),
        },
        { binding: 4, resource: cube.createView({ dimension: 'cube' }) },
        { binding: 5, resource: (flat(envMask) ?? defaults.white).createView() },
        // Missing back light, rim / soft light and layer maps are black (an empty slot).
        { binding: 6, resource: (flat(slot7) ?? defaults.black).createView() },
        { binding: 7, resource: (flat(slot6) ?? defaults.black).createView() },
        { binding: 8, resource: (flat(projectedDiffuse) ?? defaults.white).createView() },
        { binding: 9, resource: (flat(projectedNormal) ?? defaults.flatNormal).createView() },
        { binding: 10, resource: (flat(projectedNoise) ?? defaults.black).createView() },
      ],
    });
  }

  /** The sampler that wraps both U and V (the default clamp mode). */
  get #repeatSampler(): GPUSampler {
    const sampler = this.#samplers[3];
    if (!sampler) throw new Error('Material samplers missing');
    return sampler;
  }

  /** Instanced quads (or strip segments) with the effect shader and the system's blending. */
  #particlePipeline(system: ParticleSystemData): GPURenderPipeline {
    const material = system.material;
    const flags1 = material?.flags1 ?? SLSF1_ZBUFFER_TEST;
    const flags2 = material?.flags2 ?? 0;
    const blend = blendState(system.alpha);
    // Blended particles never write depth: their quads overlap unsorted within the system.
    const depthWrite = blend === undefined && (flags2 & SLSF2_ZBUFFER_WRITE) !== 0;
    const depthTest = (flags1 & SLSF1_ZBUFFER_TEST) !== 0;
    const entryPoint = system.strip ? 'vs_strip' : 'vs_particle';
    const key = ['particle', entryPoint, JSON.stringify(blend), depthWrite, depthTest].join('|');
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const attribute = (location: number): GPUVertexAttribute => ({
        shaderLocation: location,
        format: 'float32x4',
        offset: location * 16,
      });
      pipeline = this.#device.createRenderPipeline({
        label: key,
        layout: this.#pipelineLayout,
        vertex: {
          module: this.#modules.particle,
          entryPoint,
          buffers: [
            {
              arrayStride: PARTICLE_FLOATS * 4,
              stepMode: 'instance',
              attributes: [attribute(0), attribute(1), attribute(2), attribute(3)],
            },
          ],
        },
        fragment: {
          module: this.#modules.particle,
          entryPoint: 'fs_particle',
          targets: [{ format: this.#colorFormat, ...(blend && { blend }) }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: depthWrite,
          depthCompare: depthTest ? 'greater-equal' : 'always',
        },
        multisample: { count: SAMPLE_COUNT },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #shadowPipeline(part: ModelPart): GPURenderPipeline {
    const layout = part.layout;
    const alphaTest = (part.alpha?.flags ?? 0) & ALPHA_TEST;
    const doubleSided = ((part.material?.flags2 ?? 0) & SLSF2_DOUBLE_SIDED) !== 0;
    const withUv = alphaTest !== 0 && layout.uv >= 0;
    const skinning = part.skin ? (layout.skinning ?? -1) : -1;
    const key = ['shadow', layout.stride, withUv ? layout.uv : -1, doubleSided, skinning].join('|');
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, format: 'float32x3', offset: 0 },
      ];
      if (withUv) attributes.push({ shaderLocation: 2, format: 'float16x2', offset: layout.uv });
      if (skinning >= 0) attributes.push(...skinAttributes(skinning));
      const entry = skinning >= 0 ? 'vs_skinned' : 'vs_object';
      pipeline = this.#device.createRenderPipeline({
        label: key,
        layout: skinning >= 0 ? this.#skinnedShadowLayout : this.#shadowLayout,
        vertex: {
          module: this.#shadowModule,
          entryPoint: withUv ? `${entry}_uv` : entry,
          buffers: [{ arrayStride: layout.stride, attributes }],
        },
        ...(withUv && {
          fragment: { module: this.#shadowModule, entryPoint: 'fs_alpha_test', targets: [] },
        }),
        primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back' },
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'less',
          depthBiasSlopeScale: 1.5,
        },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #waterPipeline(part: ModelPart): GPURenderPipeline {
    const layout = part.layout;
    const key = [
      'water',
      layout.stride,
      layout.uv,
      layout.normal,
      layout.tangent,
      layout.color,
    ].join('|');
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: key,
        layout: this.#waterPipelineLayout,
        vertex: {
          module: this.#modules.water,
          entryPoint: 'vs_main',
          buffers: vertexBuffers(layout),
        },
        fragment: {
          module: this.#modules.water,
          entryPoint: 'fs_water',
          targets: [{ format: this.#colorFormat }],
        },
        // Water is seen from above and, under it, from below.
        primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
        multisample: { count: SAMPLE_COUNT },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #pipeline(part: ModelPart, blend: GPUBlendState | undefined): GPURenderPipeline {
    const material = part.material;
    const refraction = isRefraction(material);
    const shader = refraction ? 'refraction' : material?.kind === 'effect' ? 'effect' : 'lighting';
    const flags1 = material?.flags1 ?? SLSF1_ZBUFFER_TEST;
    const flags2 = material?.flags2 ?? SLSF2_ZBUFFER_WRITE;
    const cullMode: GPUCullMode = (flags2 & SLSF2_DOUBLE_SIDED) !== 0 ? 'none' : 'back';
    const depthWrite = !refraction && (blend === undefined || (flags2 & SLSF2_ZBUFFER_WRITE) !== 0);
    const depthTest = (flags1 & SLSF1_ZBUFFER_TEST) !== 0 || material === undefined;
    // Decals (dirt and trim layers lying on other surfaces) are pulled towards the camera so
    // they never fight with the surface below. Reversed Z: a positive bias means closer.
    const decal = (flags1 & (SLSF1_DECAL | SLSF1_DYNAMIC_DECAL)) !== 0;
    const layout = part.layout;
    const skinned = part.skin !== undefined && (layout.skinning ?? -1) >= 0;
    const key = [
      shader,
      layout.stride,
      layout.uv,
      layout.normal,
      layout.tangent,
      layout.color,
      skinned ? layout.skinning : -1,
      JSON.stringify(blend),
      cullMode,
      depthWrite,
      depthTest,
      decal,
    ].join('|');

    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `${shader} ${key}`,
        layout: skinned ? this.#skinnedPipelineLayout : this.#pipelineLayout,
        vertex: {
          module: this.#modules[shader],
          entryPoint: skinned ? 'vs_skinned' : 'vs_main',
          buffers: vertexBuffers(layout, skinned),
        },
        fragment: {
          module: this.#modules[shader],
          entryPoint: refraction ? 'fs_refraction' : 'fs_main',
          // Opaque parts are drawn in the opaque pass, which also has the G-buffer (written
          // by the lighting shader); blended ones in the blended pass, which has not;
          // refraction shapes into the refraction buffer.
          targets: refraction
            ? [{ format: REFRACTION_FORMAT }]
            : [
                { format: this.#colorFormat, ...(blend && { blend }) },
                ...(blend === undefined ? [gbufferTarget(shader === 'lighting')] : []),
              ],
        },
        primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
        depthStencil: {
          format: DEPTH_FORMAT,
          depthWriteEnabled: depthWrite,
          depthCompare: depthTest ? 'greater-equal' : 'always',
          ...(decal && { depthBias: DECAL_DEPTH_BIAS, depthBiasSlopeScale: DECAL_SLOPE_BIAS }),
        },
        multisample: { count: SAMPLE_COUNT },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}

/** Bone weights (4 half floats) and bone indices (4 bytes) of skinned vertices. */
function skinAttributes(offset: number): GPUVertexAttribute[] {
  return [
    { shaderLocation: 6, format: 'float16x4', offset },
    { shaderLocation: 7, format: 'uint8x4', offset: offset + 8 },
  ];
}

/**
 * Mesh attributes from buffer 0; missing ones from the constant fallback buffer 1. Skinned
 * pipelines also read the bone weights and indices.
 */
export function vertexBuffers(layout: VertexLayout, skinned = false): GPUVertexBufferLayout[] {
  const mesh: GPUVertexAttribute[] = [{ shaderLocation: 0, format: 'float32x3', offset: 0 }];
  const fallback: GPUVertexAttribute[] = [];
  const add = (
    present: boolean,
    location: number,
    format: GPUVertexFormat,
    offset: number,
    fallbackOffset: number,
  ): void => {
    (present ? mesh : fallback).push({
      shaderLocation: location,
      format,
      offset: present ? offset : fallbackOffset,
    });
  };
  add(layout.tangent >= 0, 1, 'float32', 12, FALLBACK_OFFSETS.bitangentX);
  add(layout.uv >= 0, 2, 'float16x2', layout.uv, FALLBACK_OFFSETS.uv);
  add(layout.normal >= 0, 3, 'unorm8x4', layout.normal, FALLBACK_OFFSETS.normal);
  add(layout.tangent >= 0, 4, 'unorm8x4', layout.tangent, FALLBACK_OFFSETS.tangent);
  add(layout.color >= 0, 5, 'unorm8x4', layout.color, FALLBACK_OFFSETS.color);
  if (skinned) mesh.push(...skinAttributes(layout.skinning ?? 0));
  return [
    { arrayStride: layout.stride, attributes: mesh },
    { arrayStride: 0, attributes: fallback },
  ];
}

/** The parts of placed models in the world (for rays: where decals land). */
export function placedParts(instances: readonly ModelInstance[]): PlacedPart[] {
  return instances.flatMap((instance) =>
    instance.model.parts.map(({ part }) => ({
      part,
      instanceWorld: instance.world,
      center: transformPoint(instance.world, part.center),
      radius: part.radius * maxScale(instance.world),
    })),
  );
}
