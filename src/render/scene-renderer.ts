// Draws scenes of model instances built by model-data.ts. Models (geometry + materials) are
// uploaded once; a scene places them with per-instance world matrices. One pipeline per
// vertex layout and material state, per-draw uniforms in one buffer (dynamic offsets),
// opaque first, then blended parts sorted back to front.

import type { FaceWeights } from '../animation/face.ts';
import { sequenceWeight, type ObjectGraph } from '../animation/object-graph.ts';
import type { ActorPose } from '../animation/skeleton.ts';
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
  flatAmbient,
  type PointLight,
  type SceneFog,
  type SceneLighting,
} from './scene-lighting.ts';
import { GpuModel, type GpuParticleSystem, type GpuPart, type ModelAddon } from './gpu-model.ts';
import {
  faceMorphIndices,
  MORPH_REGION_BYTES,
  writeMorphSlots,
  type MorphData,
} from './face-morphs.ts';
import {
  MAX_PALETTE_BONES,
  PALETTE_BONE_FLOATS,
  writePaletteBone,
  writePosedPalette,
  writeRestPalette,
} from './bone-palette.ts';
import { frustumPlanes, invert, sphereVisible, type Plane } from './frustum.ts';
import type { RoomCuller } from './room-culler.ts';
import { identity, maxScale, multiply, transformPoint, type Mat4, type Vec3 } from './math.ts';
import { fadeOut, fadeRange, type FadeKind, type FadeSettings } from './object-fade.ts';
import { MAX_RIPPLES, type Ripple } from './water-ripples.ts';
import type {
  AlphaState,
  EffectMaterial,
  LightingMaterial,
  IndexRange,
  ModelData,
  ModelPart,
  PartMaterial,
  VertexLayout,
} from './model-data.ts';
import { LightningSimulation } from './lightning.ts';
import type { ParticleSystemData } from './particle-data.ts';
import type { PlacedPart } from './raycast.ts';
import { REFRACTION_FORMAT } from './refraction.ts';
import {
  PARTICLE_FLOATS,
  ParticleSimulation,
  type ParticleContext,
  type ParticleSource,
} from './particle-sim.ts';
import commonShader from './shaders/common.wgsl?raw';
import frameShader from './shaders/frame.wgsl?raw';
import effectShader from './shaders/effect.wgsl?raw';
import lightingShader from './shaders/lighting.wgsl?raw';
import snowShader from './shaders/snow.wgsl?raw';
import particleShader from './shaders/particle.wgsl?raw';
import skinningShader from './shaders/skinning.wgsl?raw';
import refractionShader from './shaders/refraction.wgsl?raw';
import shadowShader from './shaders/shadow.wgsl?raw';
import {
  LIGHT_SHADOW_FACES,
  LIGHT_SHADOW_MAP_SIZE,
  LIGHT_SHADOW_NEAR,
  MAX_SHADOW_LIGHTS,
  type LightShadowViews,
  type ShadowSlot,
} from './light-shadows.ts';
import waterShader from './shaders/water.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';
import { CELL_SIZE } from '../world/land.ts';

export { GpuModel, type ModelAddon };
export { flatAmbient, type PointLight, type SceneFog, type SceneLighting };
import { gbufferTarget } from './gbuffer.ts';
import { projectedUVParams, type MaterialObject } from '../world/material-object.ts';
import type { WaterType } from '../world/water.ts';

export const SAMPLE_COUNT = 4;
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
export const MAX_LIGHTS = 256;

/** Size of the WGSL `Draw` struct and the stride between draws (uniform offset alignment). */
const DRAW_SIZE = 256;
const DRAW_STRIDE = 256;
/** The identity transform (a part with no transform of its own). */
const IDENTITY = identity();
/** A draw's bone palette: as many bones as a vertex can name, three vec4 rows each. */
const PALETTE_BYTES = MAX_PALETTE_BONES * PALETTE_BONE_FLOATS * 4;
/** Palettes start at storage buffer offset alignment. */
const PALETTE_ALIGNMENT = 256;
/** WGSL `Frame` struct: 192 floats. */
const FRAME_FLOATS = 192;
/** Sun shadow map: one layer per cascade. */
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_MAP_LAYERS = 4;
/** An extra layer of the shadow map: the scene from straight above, for precipitation. */
export const PRECIPITATION_OCCLUSION_LAYER = 4;
const SHADOW_TEXTURE_LAYERS = SHADOW_MAP_LAYERS + 1;
/** Layers of the light-shadow map (light-shadows.ts): six per shadow light. */
const LIGHT_SHADOW_LAYERS = MAX_SHADOW_LIGHTS * LIGHT_SHADOW_FACES;
/** WGSL `LightShadows`: a matrix per layer, a vec4 per slot, the parameters. */
const LIGHT_SHADOW_FLOATS = LIGHT_SHADOW_LAYERS * 16 + MAX_SHADOW_LIGHTS * 4 + 4;
/**
 * Receiver offsets of the light shadows against acne: along the light (world units) and along
 * the normal (texels).
 */
const LIGHT_SHADOW_BIAS = 1;
const LIGHT_SHADOW_NORMAL_OFFSET = 1.5;
/** Shadow cascade uniforms: one view-projection per 256-byte slot. */
const CASCADE_STRIDE = 256;
/** Receiver offsets against shadow acne: depth (0..1 units) and along the normal (texels). */
const SHADOW_DEPTH_BIAS = 0.0004;
const SHADOW_NORMAL_OFFSET = 1.5;

/** The sun's shadow cascades of a frame. */
export interface FrameShadows {
  readonly cascades: readonly { readonly viewProj: Mat4; readonly far: number }[];
}

/** A shadow caster within a shadow light's reach (SceneRenderer.lightCasters). */
export interface LightCaster {
  readonly scene: GpuScene;
  readonly draw: Draw;
  /** Skinned or morphed: its shadow changes every frame. */
  readonly moves: boolean;
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
/**
 * Floats per point light: position, radius, colour, cone cosine (-2: none), cone axis, room,
 * shadow slot (-1: none), shadow fade, pad.
 */
const LIGHT_FLOATS = 16;
/** The cone cosine of a light without a cone. */
const NO_CONE = -2;

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
/** A skinned part: model-space normals turn with its bones (common.wgsl). */
const DRAW_SKINNED = 0x800000;
/**
 * Draw flag (common.wgsl): the player's first-person geometry, drawn through the first-person
 * view-projection in the depth band nearest the eye. A bit the NiAlphaProperty flags leave unused
 * (cleared from them first).
 */
const DRAW_FIRST_PERSON = 0x8000;

/** Sets (or clears) a draw's DRAW_FIRST_PERSON flag in its uniform's flags. */
function markFirstPerson(uints: Uint32Array, firstPerson: boolean): void {
  uints[38] = ((uints[38] ?? 0) & ~DRAW_FIRST_PERSON) | (firstPerson ? DRAW_FIRST_PERSON : 0);
}
/** Draw flag bits 24-31: the room its instance stands in (ModelInstance.room). */
const DRAW_ROOM_SHIFT = 24;
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
const SHADER_FACEGEN = 4;
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

/**
 * What a pass has bound, as a run of draws goes (drawOpaque, drawShadows): a draw sets only
 * what differs from the one before it. Consecutive draws are mostly parts of one model (its
 * pipeline, material and buffers), and each set is a call into the browser's WebGPU: Helgen's
 * shadow cascades and opaque pass made some 9,000 of them a frame.
 */
interface PassState {
  pipeline: GPURenderPipeline | undefined;
  material: GPUBindGroup | undefined;
  vertices: GPUBuffer | undefined;
  indices: GPUBuffer | undefined;
}

const passState = (): PassState => ({
  pipeline: undefined,
  material: undefined,
  vertices: undefined,
  indices: undefined,
});

/**
 * Uploads of a scene's draw uniforms gathered into runs: neighbouring draws (an actor's parts
 * lie side by side in its scene's buffer) go up in one writeBuffer, where each was its own call
 * (every animated draw every frame). A run is cut where a gap wider than RUN_GAP lies between.
 */
class UniformRuns {
  #start = -1;
  #end = -1;

  readonly #device: GPUDevice;
  readonly #buffer: GPUBuffer;
  readonly #data: ArrayBuffer;

  constructor(device: GPUDevice, buffer: GPUBuffer, data: ArrayBuffer) {
    this.#device = device;
    this.#buffer = buffer;
    this.#data = data;
  }

  add(offset: number, size: number): void {
    if (this.#start >= 0 && offset >= this.#start && offset <= this.#end + RUN_GAP) {
      this.#end = Math.max(this.#end, offset + size);
      return;
    }
    this.flush();
    this.#start = offset;
    this.#end = offset + size;
  }

  flush(): void {
    if (this.#start < 0) return;
    this.#device.queue.writeBuffer(
      this.#buffer,
      this.#start,
      this.#data,
      this.#start,
      this.#end - this.#start,
    );
    this.#start = -1;
    this.#end = -1;
  }
}

/** Draws apart by at most this (bytes) go up in one run (the bytes between go too). */
const RUN_GAP = 4 * DRAW_SIZE;

/** Binds a part's pipeline, material and buffers where they differ from what is bound. */
function bindPart(
  pass: GPURenderPassEncoder,
  state: PassState,
  pipeline: GPURenderPipeline,
  part: GpuPart,
): void {
  if (state.pipeline !== pipeline) {
    pass.setPipeline(pipeline);
    state.pipeline = pipeline;
  }
  if (state.material !== part.bindGroup) {
    pass.setBindGroup(2, part.bindGroup);
    state.material = part.bindGroup;
  }
  if (state.vertices !== part.vertexBuffer) {
    pass.setVertexBuffer(0, part.vertexBuffer);
    state.vertices = part.vertexBuffer;
  }
  if (state.indices !== part.indexBuffer) {
    pass.setIndexBuffer(part.indexBuffer, 'uint16');
    state.indices = part.indexBuffer;
  }
}

/** WGSL `WaterParams`: 11 vec4. */
const WATER_PARAM_FLOATS = 44;

/** A river cell's flow map (textures\water\<plugin>\flow.x.y.dds) and where it lies. */
export interface WaterFlow {
  readonly texture: string;
  /** South-west corner of the cell the map covers. */
  readonly origin: readonly [number, number];
}
/** WGSL `WaterFrame`: 5 vec4 + 32 profile samples + the ripples. */
const WATER_FRAME_FLOATS = 20 + 32 * 4 + MAX_RIPPLES * 4;

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
  /** Rings on the water from splashes and wakes (water-ripples.ts), newest first. */
  readonly ripples?: readonly Ripple[];
}

/**
 * An instance that moves (a simulated object): its owner rewrites the instance's world matrix
 * in place and bumps `version`; the scene then updates the instance's draws.
 */
export interface InstanceMotion {
  version: number;
}

/**
 * Whether an instance is drawn: a disabled reference keeps its draws, hidden (scripts enable
 * and disable references without the scene being built again).
 */
export interface InstanceVisibility {
  hidden: boolean;
}

/** A reference's distance fade: the setting it fades by (object-fade.ts). */
export interface InstanceFade {
  readonly kind: FadeKind;
  /** It fades with distance (false: the player, who never does). Default: true. */
  readonly byDistance?: boolean;
  /**
   * How much of it is veiled whatever the distance (0..1, dithered away as the fade is): an
   * invisible actor's (src/gameplay/magic/invisibility.ts).
   */
  veil?: number;
}

export interface ModelInstance {
  readonly model: GpuModel;
  readonly world: Mat4;
  /** The instance moves (its world matrix changes, see InstanceMotion). */
  readonly motion?: InstanceMotion;
  /** Shown or hidden (an enabled or disabled reference); always shown without. */
  readonly visibility?: InstanceVisibility;
  /**
   * A placed reference that fades out with distance by its kind's setting (object-fade.ts);
   * never fades without. Instances sharing one fade as one.
   */
  readonly fade?: InstanceFade;
  /**
   * The room the instance stands in (1-255; 0 or none: no room): portal-strict lights of
   * another room leave it unlit (PointLight.room).
   */
  readonly room?: number;
  /**
   * The player's first-person geometry (the arms, what they hold): drawn with first person's own
   * field of view and near plane, over the world (DRAW_FIRST_PERSON); never culled.
   */
  readonly firstPerson?: boolean;
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
  /**
   * A skeleton (an actor's, or an object's moved by its graph): the model's skinned parts
   * follow its nodes (by bone name).
   */
  readonly pose?: ActorPose;
  /** With a pose: the pose node of each of the model's nodes (rigid parts follow theirs). */
  readonly poseNodes?: Int16Array;
  /** An actor's colours: its skin tone on skin shapes, its hair colour on hair shapes. */
  readonly tints?: ActorTints;
  /**
   * An actor's equipment and dismemberment: whether a body part's partitions of one of the
   * model's parts are drawn.
   */
  readonly partitionVisible?: (bodyPart: number, part: ModelPart) => boolean;
  /**
   * The parts of the model this instance draws (all without): a weapon's blade in the hand
   * while its scabbard ("Scb") stays at the sheath (src/shell/actor-weapons.ts).
   */
  readonly partShown?: (part: ModelPart) => boolean;
  /**
   * A held weapon's blood: its blood shapes (ModelPart.weaponBlood) are drawn, following it;
   * without, they are not (a weapon on a rack or in the inventory shows none).
   */
  readonly weaponBlood?: WeaponBloodLevel;
  /**
   * An actor's face: its morph weights and the expression morphs of the model's skinned
   * shapes by lower-case name (FaceGen head parts).
   */
  readonly face?: InstanceFace;
  /**
   * Particles of the model's systems made elsewhere (an effect shader's particles: their
   * system is the model's only one); the systems' own simulation without.
   */
  readonly particleSource?: (system: ParticleSystemData) => ParticleSource | undefined;
}

/** A head part's expression morphs on the GPU (shared by every head that uses its TRI file). */
export interface GpuMorphs {
  readonly buffer: GPUBuffer;
  readonly vertexCount: number;
  /** Per face morph (FACE_MORPHS), its index in the TRI file (−1: the part lacks it). */
  readonly indices: Int16Array;
  readonly bytes: number;
}

/** What animates an instance's face (ModelInstance.face). */
export interface InstanceFace {
  readonly weights: FaceWeights;
  readonly morphs: ReadonlyMap<string, GpuMorphs>;
}

export interface ActorTints {
  readonly skin?: readonly [number, number, number];
  readonly hair?: readonly [number, number, number];
}

/** Lighting shader types that take an actor's colour: skin tint and hair tint. */
const SHADER_SKIN_TINT = 5;
const SHADER_HAIR_TINT = 6;

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

/**
 * How bloodied a weapon is (the engine's BSTempEffectWeaponBlood), which its blood shapes
 * (ModelPart.weaponBlood) show; `version` changes with it (docs/rendering.md, "Weapon blood").
 */
export interface WeaponBloodLevel {
  /**
   * The effect shader's blood cutoff (its AlphaTestRef.x): the blood mask (the texture's green)
   * shows where it is above this; 1 or more shows none.
   */
  readonly cutoff: number;
  /** The soft edge above the cutoff (AlphaTestRef.y: fWeaponBloodFalloffThreshold). */
  readonly falloff: number;
  /** The wet sheen's (the lighting blood shape's) alpha: 0 shows none. */
  readonly sheen: number;
  readonly version: number;
}

/** A draw of a weapon's blood shape: it follows its weapon's blood. */
interface WeaponBloodDraw {
  readonly offset: number;
  readonly source: WeaponBloodLevel;
  readonly effect: boolean;
  /** The material's own alpha (lighting). */
  readonly alpha: number;
  version: number;
}

/**
 * Writes a weapon's blood into a blood shape's draw: an effect's cutoff and soft edge (its
 * `layer` slot, which effects do not use otherwise) and whether it shows (material alpha); a
 * lighting shape's alpha times the sheen.
 */
function writeWeaponBlood(floats: Float32Array, entry: WeaponBloodDraw): void {
  const blood = entry.source;
  if (entry.effect) {
    floats.set([blood.cutoff, blood.falloff, 0, 0], 44);
    floats[29] = blood.cutoff < 1 ? 1 : 0;
  } else {
    floats[29] = entry.alpha * blood.sheen;
  }
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
  /** An actor's part with hidden partitions: the index ranges that are drawn. */
  readonly ranges?: readonly IndexRange[];
  /** A FaceGen head part: its morphs and the byte offset of its active morphs. */
  readonly face?: { readonly morphs: GpuMorphs; readonly offset: number };
  /** Its instance's visibility (hidden: not drawn, no shadow). */
  readonly visibility?: InstanceVisibility;
  /** The player's first-person geometry (ModelInstance.firstPerson): never culled. */
  readonly firstPerson?: boolean;
  /** Its instance's distance fade (ModelInstance.fade). */
  readonly fade?: FadeGroup;
}

/**
 * An instance's distance fade: its draws, its bound's radius, and how far it has faded this
 * frame (0..255, in the top byte of the draws' flags.w: common.wgsl fadeDiscarded).
 */
interface FadeGroup {
  readonly kind: FadeKind;
  readonly draws: Draw[];
  radius: number;
  level: number;
  /** The instances' fade it stands for (its veil, whether distance counts). */
  readonly of?: InstanceFade;
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
  /** An actor's part: the pose its palette follows. */
  readonly posed?: PosedDraw;
  /** A rigid part on a skeleton: the pose node it hangs on. */
  readonly hung?: { readonly pose: ActorPose; readonly node: number };
  /** A FaceGen head part: the face's weights written to its active morphs. */
  readonly face?: FaceDraw;
  /**
   * A part its skeleton moves (skinned, or hung on a node): its draws' culling spheres follow
   * the pose, not the instance's root (a cart's riders sit 200 units behind their root).
   */
  readonly follows?: FollowedBound;
}

/**
 * Where a posed part's bounding sphere is: its centre in the frame of a bone of its skin (the one
 * nearest the centre at rest) or of the node it hangs on.
 */
interface FollowedBound {
  readonly draws: Draw[];
  /** The skin bone the centre moves with (skinned parts). */
  readonly bone: number;
  /** The centre in the bone's rest frame (skinned) or in the part's own frame (hung). */
  readonly local: readonly [number, number, number];
}

/** The skin bone whose rest place is nearest a skinned part's centre. */
function nearestBone(skin: NonNullable<ModelPart['skin']>, centre: readonly number[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < skin.bones.length; i++) {
    const at = i * 16;
    const distance = Math.hypot(
      (skin.rest[at + 12] ?? 0) - (centre[0] ?? 0),
      (skin.rest[at + 13] ?? 0) - (centre[1] ?? 0),
      (skin.rest[at + 14] ?? 0) - (centre[2] ?? 0),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * A posed part's culling spheres where its pose has it this frame: a skinned part's centre moved
 * by its bone (pose × bind), a hung part's by the world it is drawn with.
 */
function followBound(draw: AnimatedDraw, follows: FollowedBound, world: Mat4): void {
  let centre: [number, number, number];
  if (draw.hung) {
    centre = transformPoint(world, follows.local);
  } else if (draw.posed) {
    const node = draw.posed.nodes[follows.bone] ?? -1;
    if (node < 0) return;
    const inModel = transformPoint(
      draw.posed.pose.worlds.subarray(node * 16, node * 16 + 16),
      follows.local,
    );
    centre = transformPoint(draw.instanceWorld, inModel);
  } else {
    return;
  }
  for (const followed of follows.draws) followed.center = centre;
}

/**
 * The bound a posed part's culling follows: a skinned part's centre (the model's, at rest) in
 * the rest frame of its bone nearest it; a hung part's in its own frame.
 */
function followedBound(
  part: ModelPart,
  posed: PosedDraw | undefined,
  hung: AnimatedDraw['hung'],
): FollowedBound | undefined {
  const skin = part.skin;
  if (posed && skin) {
    const bone = nearestBone(skin, part.center);
    const rest = invert(skin.rest.subarray(bone * 16, bone * 16 + 16));
    return rest ? { draws: [], bone, local: transformPoint(rest, part.center) } : undefined;
  }
  const inverse = hung && invert(part.world);
  return inverse ? { draws: [], bone: -1, local: transformPoint(inverse, part.center) } : undefined;
}

/** A head part's active morphs, rewritten when its face changes. */
interface FaceDraw {
  readonly weights: FaceWeights;
  readonly morphs: GpuMorphs;
  /** Byte offset of its morph region in the scene's bone buffer. */
  readonly offset: number;
  /** The face version the region shows. */
  version: number;
}

/** A skinned part on an actor's skeleton: the pose node of each of its bones. */
interface PosedDraw {
  readonly pose: ActorPose;
  /** Pose node per skin bone (−1: the bone keeps its rest matrix). */
  readonly nodes: Int16Array;
  /** The pose version its palette shows. */
  version: number;
}

/** Writes a head part's active morphs from its face's weights. */
function writeFaceMorphs(face: FaceDraw, out: Float32Array): void {
  face.version = face.weights.version;
  writeMorphSlots(
    face.weights.weights,
    face.morphs.indices,
    face.morphs.vertexCount,
    out,
    face.offset / 4,
  );
}

/** Writes a skinned part's palette from an actor pose. */
function writePosePalette(
  skin: NonNullable<ModelPart['skin']>,
  posed: PosedDraw,
  out: Float32Array,
  at: number,
): void {
  const worlds = posed.pose.worlds;
  for (let i = 0; i < skin.bones.length; i++) {
    const node = posed.nodes[i] ?? -1;
    if (node >= 0) {
      writePaletteBone(out, at + i * PALETTE_BONE_FLOATS, worlds, node * 16, skin.bind, i * 16);
    } else {
      writePaletteBone(out, at + i * PALETTE_BONE_FLOATS, skin.rest, i * 16, skin.bind, i * 16);
    }
  }
}

/** The index ranges of a part's partitions that are drawn (adjacent ones merged). */
function visibleRanges(
  part: ModelPart,
  visible: ((bodyPart: number, part: ModelPart) => boolean) | undefined,
): IndexRange[] | undefined {
  const partitions = part.skin?.partitions;
  if (!visible || !partitions) return undefined;
  const ranges: IndexRange[] = [];
  let hidden = false;
  for (const partition of partitions) {
    if (!visible(partition.bodyPart, part)) {
      hidden = true;
      continue;
    }
    const last = ranges.at(-1);
    if (last && last.first + last.count === partition.first) {
      ranges[ranges.length - 1] = { first: last.first, count: last.count + partition.count };
    } else {
      ranges.push({ first: partition.first, count: partition.count });
    }
  }
  return hidden ? ranges : undefined;
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
  readonly simulation: ParticleSource;
  readonly instanceWorld: Mat4;
  readonly animation: ModelAnimation | undefined;
  /** The instance's behavior graph: its sequences drive the system's controllers. */
  readonly graph?: GraphDraw;
  /** Its instance's visibility (hidden: neither simulated nor drawn). */
  readonly visibility?: InstanceVisibility;
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
  /** Palettes without morphs (an empty morph region, no morph offsets). */
  readonly bindGroup: GPUBindGroup;
  /** Palettes of head parts, with the TRI file's offsets. */
  readonly faces: ReadonlyMap<GpuMorphs, GPUBindGroup>;
  /** Byte offset of the empty morph region. */
  readonly noMorphs: number;
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
  /** Draws of weapons' blood shapes (updated when their weapon's blood changes). */
  readonly weaponBlood: readonly WeaponBloodDraw[];
  /** Instances that fade out with distance (ModelInstance.fade). */
  fades: readonly FadeGroup[] = [];
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
    weaponBlood: readonly WeaponBloodDraw[] = [],
  ) {
    this.weaponBlood = weaponBlood;
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
): [string, string, string, string, string, string, string, string] {
  if (material?.kind === 'effect') {
    return [material.sourceTexture, '', material.greyscaleTexture, '', '', '', '', ''];
  }
  if (material?.kind !== 'lighting') return ['', '', '', '', '', '', '', ''];
  const slot = (index: number): string => material.textures[index] ?? '';
  const multiLayer = material.shaderType === SHADER_MULTI_LAYER_PARALLAX;
  const environment = (material.flags1 & SLSF1_ENVIRONMENT_MAPPING) !== 0 || multiLayer;
  const glow = material.shaderType === SHADER_GLOW && (material.flags2 & SLSF2_GLOW_MAP) !== 0;
  const rimSoft = (material.flags2 & (SLSF2_SOFT_LIGHTING | SLSF2_RIM_LIGHTING)) !== 0;
  const backLight = (material.flags2 & SLSF2_BACK_LIGHTING) !== 0;
  // FaceGen heads: the face tint (slot 6, in the layer's place) and the detail map (slot 3).
  const facegen = material.shaderType === SHADER_FACEGEN;
  const specularMap =
    (material.flags1 & SLSF1_MODEL_SPACE_NORMALS) !== 0 && (material.flags1 & SLSF1_SPECULAR) !== 0;
  return [
    slot(0),
    slot(1),
    glow || rimSoft ? slot(2) : '',
    environment ? slot(4) : '',
    environment ? slot(5) : '',
    backLight || specularMap ? slot(7) : '',
    multiLayer || facegen
      ? slot(6)
      : material.shaderType === SHADER_PARALLAX
        ? slot(3)
        : material.shaderType === SHADER_LOD_LANDSCAPE_NOISE
          ? LOD_LANDSCAPE_NOISE
          : '',
    facegen ? slot(3) : '',
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

/** A view's frame state: its uniforms, point lights, bind group and culling. */
export interface SceneFrame {
  readonly buffer: GPUBuffer;
  readonly lights: GPUBuffer;
  bindGroup: GPUBindGroup;
  /** Planes of the camera's frustum this frame (culling). */
  planes: readonly Plane[];
  /** Loaded cells this frame (object LOD leaves them out). */
  lodMask: LodMask | undefined;
  /** Cells whose large references are loaded this frame. */
  largeRefMask: LargeRefMask | undefined;
  /** Rooms, portals and occluders culling this frame (room-culler.ts). */
  rooms?: RoomCuller | undefined;
}

/** The fade multipliers before the settings are read (the executable's [LOD] defaults). */
const DEFAULT_FADE: FadeSettings = { actors: 6, items: 3, objects: 5 };

export class SceneRenderer {
  /** One of DebugView; 0 shows the normal image. */
  debugView = 0;
  /** The last frame's room and occlusion culling: draws in view tested, and how many it hid. */
  lastCulling: { readonly tested: number; readonly culled: number } = { tested: 0, culled: 0 };
  /** Water type for water surfaces whose placement names none (DefaultWater). */
  defaultWater: GpuWaterType | undefined;
  /** The settings Actor, Item and Object Fade (INI [LOD] fLODFadeOutMult*). */
  objectFade: FadeSettings = DEFAULT_FADE;
  /**
   * The room (1-255; 0: none) holding a point of the cell drawn, if it has rooms: the draws of
   * moving instances (actors walking from room to room) take the room they are in each frame,
   * so portal-strict lights of other rooms leave them unlit (ModelInstance.room).
   */
  roomAt: ((point: Vec3) => number) | undefined;
  readonly #device: GPUDevice;
  readonly #colorFormat: GPUTextureFormat;
  readonly #frameData = new Float32Array(FRAME_FLOATS);
  readonly #frameUints = new Uint32Array(this.#frameData.buffer);
  readonly #lightData = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS);
  /** The world's view, and the view being drawn now (a menu's 3D: SceneFrame). */
  readonly #main: SceneFrame;
  #frame: SceneFrame;
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
  /** Bound as the morph offsets of draws without morphs. */
  readonly #noMorphOffsets: GPUBuffer;
  /** Material samplers by texture clamp mode (bit 0 wraps U, bit 1 wraps V). */
  readonly #samplers: readonly GPUSampler[];
  /** This frame's particle instances (CPU staging and GPU buffer). */
  #particleData = new Float32Array(4096 * PARTICLE_FLOATS);
  /** Particle instances written this frame (a second view's go after them). */
  #particleCursor = 0;
  #particleBuffer: GPUBuffer;
  readonly #shadowMap: GPUTexture;
  readonly #cascadeLayout: GPUBindGroupLayout;
  readonly #cascadeBuffer: GPUBuffer;
  readonly #cascadeBindGroup: GPUBindGroup;
  readonly #shadowModule: GPUShaderModule;
  readonly #shadowSampler: GPUSampler;
  /** The shadow lights' maps (light-shadows.ts), their uniforms and this frame's slots. */
  readonly #lightShadowMap: GPUTexture;
  readonly #lightShadowBuffer: GPUBuffer;
  readonly #lightShadowData = new Float32Array(LIGHT_SHADOW_FLOATS);
  #lightShadowSlots = new Map<number, { slot: number; fade: number }>();

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
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        {
          binding: 8,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d-array' },
        },
      ],
    }));
    this.#lightShadowMap = device.createTexture({
      label: 'light-shadow-map',
      size: [LIGHT_SHADOW_MAP_SIZE, LIGHT_SHADOW_MAP_SIZE, LIGHT_SHADOW_LAYERS],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#lightShadowBuffer = device.createBuffer({
      label: 'light-shadows',
      size: LIGHT_SHADOW_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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
      size: CASCADE_STRIDE * (SHADOW_TEXTURE_LAYERS + LIGHT_SHADOW_LAYERS),
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
        texture2d(11),
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
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: {
            type: 'read-only-storage',
            hasDynamicOffset: true,
            minBindingSize: MORPH_REGION_BYTES,
          },
        },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
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

    this.#shadowSampler = device.createSampler({
      label: 'shadow',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.#main = this.createFrame('frame');
    this.#frame = this.#main;
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
    this.#noMorphOffsets = createBuffer(
      device,
      new Uint8Array(16),
      GPUBufferUsage.STORAGE,
      'no-morph-offsets',
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

  /**
   * Another view's frame state (its camera, lights, culling): a menu's 3D drawn after the world
   * (Renderer's overlay). Draw with it after useFrame(frame); useFrame(undefined) goes back.
   */
  createFrame(label: string): SceneFrame {
    const device = this.#device;
    const buffers = {
      buffer: device.createBuffer({
        label,
        size: this.#frameData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      lights: device.createBuffer({
        label: `${label}-point-lights`,
        size: this.#lightData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    };
    return {
      ...buffers,
      bindGroup: this.#createFrameBindGroup(
        buffers,
        this.#noSceneColor.createView(),
        this.#noSceneDepth.createView(),
      ),
      planes: [],
      lodMask: undefined,
      largeRefMask: undefined,
    };
  }

  /** A texture the engine fills from a canvas (copyCanvas): a book menu's page of text. */
  createCanvasTexture(width: number, height: number, label: string): GPUTexture {
    return this.#device.createTexture({
      label,
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /**
   * A texture whose pixels (RGBA8, `mipLevels` levels) the engine writes (writePixels): the
   * player's face tint.
   */
  createPixelTexture(width: number, height: number, mipLevels: number, label: string): GPUTexture {
    return this.#device.createTexture({
      label,
      size: [width, height],
      mipLevelCount: mipLevels,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  /** Writes one level of a pixel texture (RGBA8). */
  writePixels(
    texture: GPUTexture,
    mip: number,
    width: number,
    height: number,
    data: Uint8Array,
  ): void {
    this.#device.queue.writeTexture(
      { texture, mipLevel: mip },
      data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height, 1],
    );
  }

  /** Copies a canvas's image (its alpha not premultiplied) into a texture's top left. */
  copyCanvas(canvas: HTMLCanvasElement, texture: GPUTexture, width: number, height: number): void {
    this.#device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture, premultipliedAlpha: false },
      [width, height],
    );
  }

  /** Draws with a view's frame state from now on (undefined: the world's). */
  useFrame(frame: SceneFrame | undefined): void {
    this.#frame = frame ?? this.#main;
  }

  #createFrameBindGroup(
    frame: Pick<SceneFrame, 'buffer' | 'lights'>,
    sceneColor: GPUTextureView,
    sceneDepth: GPUTextureView,
  ): GPUBindGroup {
    return this.#device.createBindGroup({
      label: 'frame',
      layout: this.#frameLayout,
      entries: [
        { binding: 0, resource: { buffer: frame.buffer } },
        { binding: 1, resource: { buffer: frame.lights } },
        { binding: 2, resource: this.#shadowMap.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: this.#shadowSampler },
        { binding: 4, resource: sceneColor },
        { binding: 5, resource: sceneDepth },
        { binding: 6, resource: this.#screenSampler },
        { binding: 7, resource: { buffer: this.#lightShadowBuffer } },
        { binding: 8, resource: this.#lightShadowMap.createView({ dimension: '2d-array' }) },
      ],
    });
  }

  /**
   * The copies of the opaque scene (colour, and depth as r32float) that the blended pass
   * reads: water, soft effects and particles. Called when the render targets change.
   */
  setSceneCopies(sceneColor: GPUTextureView, sceneDepth: GPUTextureView): void {
    this.#main.bindGroup = this.#createFrameBindGroup(this.#main, sceneColor, sceneDepth);
  }

  /** Uploads a model; resolves once all its textures are loaded (missing ones use defaults). */
  /** A head part's expression morphs on the GPU (destroy the buffer when done). */
  createMorphs(data: MorphData): GpuMorphs {
    const bytes = new Uint8Array(
      data.deltas.buffer,
      data.deltas.byteOffset,
      data.deltas.byteLength,
    );
    const buffer = createBuffer(
      this.#device,
      bytes.byteLength > 0 ? bytes : new Uint8Array(16),
      GPUBufferUsage.STORAGE,
      'face-morphs',
    );
    return {
      buffer,
      vertexCount: data.vertexCount,
      indices: faceMorphIndices(data.names),
      bytes: buffer.size,
    };
  }

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
          bindGroup: await this.#materialBindGroup(
            part.material,
            part.name,
            textures,
            data.gameContent === true,
          ),
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
        bindGroup: await this.#materialBindGroup(
          system.material,
          system.name,
          textures,
          data.gameContent === true,
        ),
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
      nodes: data.nodes,
      nodeWorlds: data.nodeWorlds,
      attachTo: data.attachTo,
      treeBones: data.treeBones,
    });
  }

  /**
   * A model drawn over another's surfaces with an effect material (an effect shader's membrane
   * on an actor: src/shell/actor-effects.ts): the other's shapes (their buffers shared: the
   * caller keeps `source` acquired while this one lives) in the blended pass, its own animation
   * (the membrane's texture scrolling). Placed with the source instance's world, pose, pose
   * nodes and face, it covers it exactly.
   */
  async createOverlay(
    source: GpuModel,
    material: EffectMaterial,
    alpha: AlphaState,
    textures: TextureCache,
    animation?: ModelAnimation,
    /** Which of the source's shapes it covers (all without). */
    filter?: (part: ModelPart) => boolean,
  ): Promise<GpuModel> {
    const blend = blendState(alpha);
    const shown = source.parts.filter(
      (gpu) =>
        (gpu.pass === 'opaque' || gpu.pass === 'transparent') &&
        gpu.part.weaponBlood !== true &&
        (!filter || filter(gpu.part)),
    );
    const parts = await Promise.all(
      shown.map(async (gpu): Promise<GpuPart> => {
        const part: ModelPart = { ...gpu.part, material, alpha };
        return {
          part,
          vertexBuffer: gpu.vertexBuffer,
          indexBuffer: gpu.indexBuffer,
          indexCount: gpu.indexCount,
          pipeline: this.#pipeline(part, blend),
          bindGroup: await this.#materialBindGroup(material, part.name, textures),
          pass: 'transparent',
          shadowPipeline: undefined,
        };
      }),
    );
    return new GpuModel({
      center: source.center,
      radius: source.radius,
      parts,
      buffers: [],
      animation,
      particles: [],
      textures: { cache: textures, paths: materialTextures(material).filter((p) => p !== '') },
      leafAnimation: false,
      nodes: source.nodes,
      nodeWorlds: source.nodeWorlds,
      attachTo: source.attachTo,
    });
  }

  /**
   * Places model instances (with the models attached at their AddOnNodes); writes one
   * uniform slot per (instance, part) and per (instance, particle system).
   */
  createScene(
    instances: readonly ModelInstance[],
    options: {
      readonly sky?: boolean;
      readonly lodSnow?: LodSnow;
      /** The room an instance stands in (ModelInstance.room), where it has none of its own. */
      readonly roomOf?: (instance: ModelInstance) => number | undefined;
    } = {},
  ): GpuScene {
    const sky = options.sky === true;
    const lodSnow = options.lodSnow;
    const placed: ModelInstance[] = [];
    const movingAddons: MovingAddon[] = [];
    // Rooms by instance (an add-on stands in its parent's).
    const rooms = new Map<ModelInstance, number>();
    // Fades by instance (an add-on fades with its parent).
    const fades = new Map<ModelInstance, FadeGroup>();
    // Instances sharing a fade (an actor's body, head and what it wears) fade as one.
    const fadeGroups = new Map<InstanceFade, FadeGroup>();
    const place = (
      instance: ModelInstance,
      depth: number,
      parentRoom?: number,
      parentFade?: FadeGroup,
    ): void => {
      placed.push(instance);
      const room = instance.room ?? parentRoom ?? options.roomOf?.(instance);
      if (room) rooms.set(instance, room);
      let fade = parentFade;
      if (!fade && instance.fade && !instance.firstPerson) {
        fade = fadeGroups.get(instance.fade);
        if (!fade) {
          fade = { kind: instance.fade.kind, draws: [], radius: 0, level: 0, of: instance.fade };
          fadeGroups.set(instance.fade, fade);
        }
      }
      if (fade) fades.set(instance, fade);
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
        // It shows, hides and moves with the instance it hangs on (candle flames, embers).
        const visibility = instance.visibility;
        place(
          {
            model: addon.model,
            world,
            ...(motion && { motion }),
            ...(visibility && { visibility }),
          },
          depth + 1,
          room,
          fade,
        );
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
    // Head parts' active morphs after them: an empty region first (draws without morphs).
    const faceMorphs = (instance: ModelInstance, part: ModelPart): GpuMorphs | undefined => {
      if (!part.skin) return undefined;
      const morphs = instance.face?.morphs.get(part.name.toLowerCase());
      return morphs?.vertexCount === part.vertexCount ? morphs : undefined;
    };
    const faceParts = placed.reduce(
      (sum, instance) =>
        sum + instance.model.parts.filter(({ part }) => faceMorphs(instance, part)).length,
      0,
    );
    const morphBase = Math.ceil(paletteEnd / PALETTE_ALIGNMENT) * PALETTE_ALIGNMENT;
    const boneData =
      paletteEnd > 0
        ? new Float32Array(
            (morphBase + Math.max(PALETTE_BYTES, (1 + faceParts) * MORPH_REGION_BYTES)) / 4,
          )
        : undefined;
    let paletteCursor = 0;
    const sharedPalettes = new Map<
      ModelPart,
      Map<ActorPose, { bones: number; posed: PosedDraw }>
    >();
    let morphCursor = morphBase + MORPH_REGION_BYTES;
    const draws: Draw[] = [];
    const animated: AnimatedDraw[] = [];
    const particles: ParticleDraw[] = [];
    const emittance: EmittanceDraw[] = [];
    const weaponBlood: WeaponBloodDraw[] = [];
    const moving: MovingDraw[] = [];
    const world = new Float32Array(16);
    let slot = 0;
    for (const [instanceIndex, instance] of placed.entries()) {
      const animation = instance.model.animation;
      const directional = instance.directional;
      const material = directional?.material;
      const fadeGroup = fades.get(instance);
      for (const [partIndex, part] of instance.model.parts.entries()) {
        if (instance.partShown && !instance.partShown(part.part)) continue;
        // A weapon's blood shapes only on a held weapon that can bleed.
        if (part.part.weaponBlood === true && !instance.weaponBlood) continue;
        const offset = slot++ * DRAW_STRIDE;
        // Sky scenes follow the camera: their placement changes every frame.
        const sequences = instance.model.sequences;
        const playback =
          instance.playback && sequences ? { state: instance.playback, sequences } : undefined;
        const graph = graphDraw(instance);
        const skin = part.part.skin;
        let bones: number | undefined;
        let posed: PosedDraw | undefined;
        const pose = instance.pose;
        // Placements sharing a pose (a tree model's sway) share their palettes too.
        const shared = skin && pose ? sharedPalettes.get(part.part)?.get(pose) : undefined;
        if (shared) {
          bones = shared.bones;
          posed = shared.posed;
        } else if (skin && boneData) {
          bones = Math.ceil(paletteCursor / PALETTE_ALIGNMENT) * PALETTE_ALIGNMENT;
          paletteCursor = bones + skin.bones.length * PALETTE_BONE_FLOATS * 4;
          if (pose) {
            const nodes = Int16Array.from(
              skin.names,
              (name) => pose.skeleton.nodeByName.get(name.toLowerCase()) ?? -1,
            );
            posed = { pose, nodes, version: pose.version };
            writePosePalette(skin, posed, boneData, bones / 4);
            let byPose = sharedPalettes.get(part.part);
            if (!byPose) {
              byPose = new Map<ActorPose, { bones: number; posed: PosedDraw }>();
              sharedPalettes.set(part.part, byPose);
            }
            byPose.set(pose, { bones, posed });
          } else {
            writeRestPalette(skin, boneData, bones / 4);
          }
        }
        // A FaceGen head part: its active morphs follow the face.
        const morphs = boneData && faceMorphs(instance, part.part);
        let face: FaceDraw | undefined;
        if (morphs && instance.face) {
          face = { weights: instance.face.weights, morphs, offset: morphCursor, version: -1 };
          morphCursor += MORPH_REGION_BYTES;
          writeFaceMorphs(face, boneData);
        }
        // A rigid part on a skeleton hangs on its pose node (−1: placed as the model places it).
        const poseNode =
          !skin && instance.pose && part.part.node !== undefined
            ? (instance.poseNodes?.[part.part.node] ?? -1)
            : -1;
        const hung =
          instance.pose && poseNode >= 0 ? { pose: instance.pose, node: poseNode } : undefined;
        const follows = followedBound(part.part, posed, hung);
        if (animation || part.part.billboard || sky || playback || graph || posed || hung || face) {
          animated.push({
            ...(follows && { follows }),
            offset,
            instanceWorld: instance.world,
            part: part.part,
            animation,
            ...(playback && { playback }),
            ...(graph && { graph }),
            ...(bones !== undefined && { bones }),
            ...(posed && { posed }),
            ...(hung && { hung }),
            ...(face && { face }),
          });
        }
        const floats = new Float32Array(uniforms, offset, DRAW_SIZE / 4);
        const uints = new Uint32Array(uniforms, offset, DRAW_SIZE / 4);
        multiply(instance.world, part.part.world, world);
        floats.set(world, 0);
        writeMaterial(floats, uints, part.part);
        if (sky) uints[38] = (uints[38] ?? 0) | SKY_DRAW;
        if (part.part.skin) uints[38] = (uints[38] ?? 0) | DRAW_SKINNED;
        const firstPerson = instance.firstPerson === true;
        markFirstPerson(uints, firstPerson);
        const room = rooms.get(instance);
        if (room) uints[38] = (uints[38] ?? 0) | ((room & 0xff) << DRAW_ROOM_SHIFT);
        const tints = instance.tints;
        const tinted = part.part.material;
        if (tints && tinted?.kind === 'lighting') {
          const color =
            tinted.shaderType === SHADER_SKIN_TINT
              ? tints.skin
              : tinted.shaderType === SHADER_HAIR_TINT
                ? tints.hair
                : undefined;
          if (color) floats.set(color, 32);
        }
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
        const blood = instance.weaponBlood;
        if (
          blood &&
          part.part.weaponBlood === true &&
          partMaterial &&
          partMaterial.kind !== 'water'
        ) {
          const entry: WeaponBloodDraw = {
            offset,
            source: blood,
            effect: partMaterial.kind === 'effect',
            alpha: partMaterial.kind === 'lighting' ? partMaterial.alpha : 1,
            version: blood.version,
          };
          writeWeaponBlood(floats, entry);
          weaponBlood.push(entry);
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
        const ranges = visibleRanges(part.part, instance.partitionVisible);
        const draw: Draw = {
          part,
          uniformOffset: offset,
          center: transformPoint(instance.world, part.part.center),
          radius: part.part.radius * maxScale(instance.world),
          water: part.pass === 'water' ? instance.water : undefined,
          sky,
          lodSegments: lodSegments(part.part, world),
          bones,
          ...(ranges && { ranges }),
          ...(face && { face: { morphs: face.morphs, offset: face.offset } }),
          ...(instance.visibility && { visibility: instance.visibility }),
          ...(firstPerson && { firstPerson }),
          ...(fadeGroup && { fade: fadeGroup }),
        };
        draws.push(draw);
        if (fadeGroup) {
          fadeGroup.draws.push(draw);
          fadeGroup.radius = Math.max(fadeGroup.radius, draw.radius);
        }
        follows?.draws.push(draw);
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
          if (room) passUints[38] = (passUints[38] ?? 0) | ((room & 0xff) << DRAW_ROOM_SHIFT);
          markFirstPerson(passUints, firstPerson);
          const passDraw: Draw = {
            part: passPart,
            uniformOffset: passOffset,
            center: transformPoint(instance.world, part.part.center),
            radius: part.part.radius * maxScale(instance.world),
            water: undefined,
            sky,
            lodSegments: undefined,
            bones,
            ...(ranges && { ranges }),
            ...(instance.visibility && { visibility: instance.visibility }),
            ...(firstPerson && { firstPerson }),
            ...(fadeGroup && { fade: fadeGroup }),
          };
          draws.push(passDraw);
          fadeGroup?.draws.push(passDraw);
          follows?.draws.push(passDraw);
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
          simulation:
            instance.particleSource?.(system.data) ??
            (system.data.lightning
              ? new LightningSimulation(system.data, seed)
              : new ParticleSimulation(system.data, seed)),
          instanceWorld: instance.world,
          animation,
          ...(graph && { graph }),
          ...(instance.visibility && { visibility: instance.visibility }),
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
    const scene = new GpuScene(
      draws,
      bindGroup,
      buffer,
      uniforms,
      animated,
      particles,
      models,
      emittance,
      { draws: moving, addons: movingAddons },
      boneData &&
        this.#sceneBones(
          boneData,
          morphBase,
          draws.flatMap((draw) => (draw.face ? [draw.face.morphs] : [])),
        ),
      weaponBlood,
    );
    scene.fades = [...new Set(fades.values())].filter((group) => group.draws.length > 0);
    return scene;
  }

  /**
   * Uploads a scene's bone palettes and head parts' active morphs; every draw binds its own
   * at dynamic offsets (`noMorphs`: the empty morph region).
   */
  #sceneBones(data: Float32Array, noMorphs: number, morphs: readonly GpuMorphs[]): SceneBones {
    const buffer = createBuffer(
      this.#device,
      new Uint8Array(data.buffer),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'bone-palettes',
    );
    const group = (offsets: GPUBuffer): GPUBindGroup =>
      this.#device.createBindGroup({
        label: 'bones',
        layout: this.#boneLayout,
        entries: [
          { binding: 0, resource: { buffer, size: PALETTE_BYTES } },
          { binding: 1, resource: { buffer, size: MORPH_REGION_BYTES } },
          { binding: 2, resource: { buffer: offsets } },
        ],
      });
    const faces = new Map<GpuMorphs, GPUBindGroup>();
    for (const entry of morphs) if (!faces.has(entry)) faces.set(entry, group(entry.buffer));
    return { buffer, bindGroup: group(this.#noMorphOffsets), faces, noMorphs, data };
  }

  /** Binds a skinned draw's palette and morphs. */
  #bindBones(pass: GPURenderPassEncoder, scene: GpuScene, draw: Draw): void {
    const bones = scene.bones;
    if (draw.bones === undefined || !bones) return;
    const face = draw.face;
    const group = face ? bones.faces.get(face.morphs) : undefined;
    if (face && group) {
      pass.setBindGroup(3, group, [draw.bones, face.offset]);
    } else {
      pass.setBindGroup(3, bones.bindGroup, [draw.bones, bones.noMorphs]);
    }
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
    rooms?: RoomCuller,
    firstPersonViewProjection?: Mat4,
  ): void {
    this.#frame.planes = frustumPlanes(viewProjection);
    this.#frame.lodMask = lodMask;
    this.#frame.largeRefMask = largeRefMask;
    if (this.#frame.rooms) this.lastCulling = { ...this.#frame.rooms.counts };
    rooms?.update(viewProjection, cameraPosition);
    this.#frame.rooms = rooms;
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
    data.set(firstPersonViewProjection ?? viewProjection, 176);
    this.#device.queue.writeBuffer(this.#frame.buffer, 0, data);

    if (lightCount > 0) {
      for (let i = 0; i < lightCount; i++) {
        const light = lighting.lights[i];
        if (!light) continue;
        this.#lightData.set(
          [
            ...light.position,
            light.radius,
            ...light.color,
            light.spot?.cosHalfAngle ?? NO_CONE,
            ...(light.spot?.direction ?? [0, 0, 1]),
            // A portal-strict light's room (0: every room).
            light.room ?? 0,
            ...this.#lightShadowOf(light),
          ],
          i * LIGHT_FLOATS,
        );
      }
      this.#device.queue.writeBuffer(
        this.#frame.lights,
        0,
        this.#lightData,
        0,
        lightCount * LIGHT_FLOATS,
      );
    }
  }

  /** A light's shadow slot and fade for the shader (slot −1: it casts none this frame). */
  #lightShadowOf(light: PointLight): [number, number, number, number] {
    const held = light.shadow && this.#lightShadowSlots.get(light.shadow.id);
    return held ? [held.slot, held.fade, 0, 0] : [-1, 0, 0, 0];
  }

  /**
   * The shadow lights of the frame (before updateFrame): which light holds which slot, with its
   * fade, and the views each slot's map was last rendered with.
   */
  updateLightShadows(
    slots: readonly ShadowSlot[],
    views: readonly (LightShadowViews | undefined)[],
  ): void {
    this.#lightShadowSlots = new Map(
      slots.flatMap((entry) =>
        entry.light.shadow && views[entry.slot]
          ? [[entry.light.shadow.id, { slot: entry.slot, fade: entry.fade }] as const]
          : [],
      ),
    );
    if (this.#lightShadowSlots.size === 0) return;
    const data = this.#lightShadowData;
    const slotBase = LIGHT_SHADOW_LAYERS * 16;
    views.slice(0, MAX_SHADOW_LIGHTS).forEach((view, slot) => {
      if (!view) return;
      view.viewProj.forEach((matrix, face) => {
        data.set(matrix, (slot * LIGHT_SHADOW_FACES + face) * 16);
      });
      data.set(
        [
          LIGHT_SHADOW_NEAR,
          view.far,
          view.viewProj.length > 1 ? 1 : 0,
          view.spread / LIGHT_SHADOW_MAP_SIZE,
        ],
        slotBase + slot * 4,
      );
    });
    data.set(
      [LIGHT_SHADOW_MAP_SIZE, LIGHT_SHADOW_BIAS, LIGHT_SHADOW_NORMAL_OFFSET, 0],
      slotBase + MAX_SHADOW_LIGHTS * 4,
    );
    this.#device.queue.writeBuffer(this.#lightShadowBuffer, 0, data);
  }

  /**
   * The shadow casters a light reaches: draws that cast shadows within its radius, and (with
   * rooms) in a room seen this frame.
   */
  lightCasters(
    scenes: Iterable<GpuScene>,
    position: Vec3,
    radius: number,
    rooms?: RoomCuller,
  ): LightCaster[] {
    const casters: LightCaster[] = [];
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (!draw.part.shadowPipeline || draw.visibility?.hidden) continue;
        const dx = draw.center[0] - position[0];
        const dy = draw.center[1] - position[1];
        const dz = draw.center[2] - position[2];
        const reach = radius + draw.radius;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        if (rooms && !rooms.inVisibleRoom(draw.center)) continue;
        // A skinned or morphed part changes shape without its transform changing.
        const moves = draw.bones !== undefined || draw.face !== undefined;
        casters.push({ scene, draw, moves });
      }
    }
    return casters;
  }

  /**
   * What a light's view shows of its casters, as a number that changes when one of them moves,
   * appears or goes: their world transforms as the frame's animation left them (a part whose
   * controllers only scroll its UVs keeps its map). NaN: a skinned caster, which changes every
   * frame.
   */
  casterSignature(casters: readonly LightCaster[], planes: readonly Plane[]): number {
    let hash = 2166136261;
    for (const { scene, draw, moves } of casters) {
      if (!sphereVisible(planes, draw.center, draw.radius)) continue;
      if (moves) return NaN;
      hash = Math.imul(hash ^ draw.uniformOffset, 16777619);
      const world = new Float32Array(scene.uniformData, draw.uniformOffset, 16);
      for (let i = 0; i < 16; i++) {
        hash = Math.imul(hash ^ Math.round((world[i] ?? 0) * 64), 16777619);
      }
    }
    return hash >>> 0;
  }

  /** Renders a light's casters into a layer of the light-shadow map with its view. */
  drawLightShadows(
    encoder: GPUCommandEncoder,
    casters: readonly LightCaster[],
    layer: number,
    viewProj: Mat4,
  ): void {
    const slot = SHADOW_TEXTURE_LAYERS + layer;
    this.#device.queue.writeBuffer(this.#cascadeBuffer, slot * CASCADE_STRIDE, viewProj);
    const planes = frustumPlanes(viewProj);
    const pass = encoder.beginRenderPass({
      label: `light-shadow-${String(layer)}`,
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.#lightShadowMap.createView({
          dimension: '2d',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
        }),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setBindGroup(0, this.#cascadeBindGroup, [this.cascadeOffset(slot)]);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    const state = passState();
    for (const { scene, draw } of casters) {
      const pipeline = draw.part.shadowPipeline;
      if (!pipeline || !sphereVisible(planes, draw.center, draw.radius)) continue;
      bindPart(pass, state, pipeline, draw.part);
      pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
      this.#bindBones(pass, scene, draw);
      if (draw.ranges) {
        for (const range of draw.ranges) pass.drawIndexed(range.count, 1, range.first);
      } else {
        pass.drawIndexed(draw.part.indexCount);
      }
    }
    pass.end();
  }

  /** Frame bind group layout (group 0), shared with the terrain and other world shaders. */
  get frameLayout(): GPUBindGroupLayout {
    return this.#frameLayout;
  }

  get frameBindGroup(): GPUBindGroup {
    return this.#frame.bindGroup;
  }

  /**
   * Plays the models' controllers: rewrites the uniforms of animated draws for this moment
   * (each model's animation is evaluated once per call), and runs the particle systems near
   * the camera or in view (`wind`: the weather's wind in units per second). `appendParticles`:
   * a second view's scenes this frame (the menu overlay), whose particles go after the first's.
   */
  animate(
    scenes: Iterable<GpuScene>,
    seconds: number,
    camera: Vec3,
    wind: Vec3 = [0, 0, 0],
    appendParticles = false,
  ): void {
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
    for (const scene of sceneList) {
      this.#updateFades(scene, camera);
      this.#updateRooms(scene);
    }
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
          if (sequence) {
            layers.push({
              tracks: sequence.tracks,
              seconds: seconds - playing.start,
              weight: sequenceWeight(playing, seconds),
            });
          }
        }
        frame = animateLayers(graph.sequences, layers);
        graphFrames.set(graph.player, frame);
      }
      return frame;
    };
    for (const scene of sceneList) {
      const uniforms = new UniformRuns(this.#device, scene.uniforms, scene.uniformData);
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
        uniforms.add(entry.draw.uniformOffset, 64);
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
          // Animated under its billboard node (a perk star's size in its states): the animated
          // place relative to the node.
          const animated = frame?.worlds.get(draw.part.block);
          const inverse = animated && invert(billboard.node);
          const local = animated && inverse ? multiply(inverse, animated) : billboard.local;
          multiply(billboardWorld(node, billboard.mode, camera), local, world);
          floats.set(world, 0);
        } else if (draw.hung) {
          // On a skeleton: the node's pose, then the part under it.
          const { pose, node } = draw.hung;
          multiply(
            pose.worlds.subarray(node * 16, node * 16 + 16),
            draw.part.local ?? IDENTITY,
            world,
          );
          multiply(draw.instanceWorld, world, world);
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
        if (draw.follows) followBound(draw, draw.follows, world);
        const skin = draw.part.skin;
        const bones = scene.bones;
        const face = draw.face;
        if (face && bones && face.version !== face.weights.version) {
          writeFaceMorphs(face, bones.data);
          this.#device.queue.writeBuffer(
            bones.buffer,
            face.offset,
            bones.data,
            face.offset / 4,
            MORPH_REGION_BYTES / 4,
          );
        }
        const posed = draw.posed;
        if (posed && skin && bones && draw.bones !== undefined) {
          if (posed.version !== posed.pose.version) {
            posed.version = posed.pose.version;
            writePosePalette(skin, posed, bones.data, draw.bones / 4);
            this.#device.queue.writeBuffer(
              bones.buffer,
              draw.bones,
              bones.data,
              draw.bones / 4,
              skin.bones.length * PALETTE_BONE_FLOATS,
            );
          }
        } else if (frame && skin && bones && draw.bones !== undefined) {
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
        uniforms.add(draw.offset, DRAW_SIZE);
      }
      uniforms.flush();
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
      // Weapons' blood shows after a hit and dries away.
      for (const entry of scene.weaponBlood) {
        if (entry.version === entry.source.version) continue;
        entry.version = entry.source.version;
        writeWeaponBlood(new Float32Array(scene.uniformData, entry.offset, DRAW_SIZE / 4), entry);
        this.#device.queue.writeBuffer(
          scene.uniforms,
          entry.offset,
          scene.uniformData,
          entry.offset,
          DRAW_SIZE,
        );
      }
    }
    this.#runParticles(
      sceneList,
      seconds,
      camera,
      wind,
      (draw) => (draw.graph ? graphFrame(draw.graph) : frameOf(draw.animation)),
      appendParticles ? this.#particleCursor : 0,
    );
  }

  /** Updates the particle systems and gathers their instances into this frame's buffer. */
  #runParticles(
    scenes: readonly GpuScene[],
    seconds: number,
    camera: Vec3,
    wind: Vec3,
    frameOf: (draw: ParticleDraw) => AnimationFrame | undefined,
    start: number,
  ): void {
    this.#particleCursor = start;
    let needed = 0;
    for (const scene of scenes) {
      for (const draw of scene.particles) needed += draw.simulation.data.maxParticles;
    }
    if (needed === 0) return;
    let cursor = start;
    for (const scene of scenes) {
      for (const draw of scene.particles) {
        draw.count = 0;
        if (draw.visibility?.hidden) continue;
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
          sphereVisible(this.#frame.planes, draw.origin, 512) ||
          (simulation.count > 0 &&
            sphereVisible(this.#frame.planes, simulation.center, simulation.radius));
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
        this.#particleCursor = cursor;
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
    pass.setBindGroup(0, this.#frame.bindGroup);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    const state = passState();
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (draw.part.pass === 'opaque' && this.#visible(draw)) {
          this.#drawPart(pass, scene, draw, state);
        }
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
    pass.setBindGroup(0, this.#frame.bindGroup);
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
    pass.setBindGroup(0, this.#frame.bindGroup);
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
    pass.setBindGroup(0, this.#frame.bindGroup);
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
    (frame?.ripples ?? []).slice(0, MAX_RIPPLES).forEach((ring, i) => {
      data.set([ring.x, ring.y, ring.age, ring.strength], 148 + i * 4);
    });
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
    return this.#frame.planes;
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
    const state = passState();
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        const { part } = draw;
        if (!part.shadowPipeline || draw.radius < minRadius || draw.visibility?.hidden) continue;
        if (draw.fade && draw.fade.level >= 255) continue;
        if (!sphereVisible(planes, draw.center, draw.radius)) continue;
        bindPart(pass, state, part.shadowPipeline, part);
        pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
        this.#bindBones(pass, scene, draw);
        if (draw.ranges) {
          for (const range of draw.ranges) pass.drawIndexed(range.count, 1, range.first);
        } else {
          pass.drawIndexed(part.indexCount);
        }
      }
    }
  }

  /**
   * How far each fading instance of a scene has faded from the camera (object-fade.ts): the
   * level goes into its draws' flags.w top byte, uploaded only when it changes.
   */
  #updateFades(scene: GpuScene, camera: Vec3): void {
    if (scene.fades.length === 0) return;
    const uints = new Uint32Array(scene.uniformData);
    const runs = new UniformRuns(this.#device, scene.uniforms, scene.uniformData);
    for (const group of scene.fades) {
      const center = group.draws[0]?.center;
      if (!center) continue;
      const { start, end } = fadeRange(group.kind, group.radius, this.objectFade);
      const distance = Math.hypot(
        center[0] - camera[0],
        center[1] - camera[1],
        center[2] - camera[2],
      );
      const away = group.of?.byDistance === false ? 0 : fadeOut(distance, start, end);
      const level = Math.round(Math.max(away, Math.min(1, group.of?.veil ?? 0)) * 255);
      if (level === group.level) continue;
      group.level = level;
      for (const draw of group.draws) {
        const at = draw.uniformOffset / 4 + 39;
        uints[at] = ((uints[at] ?? 0) & 0xffffff) | (level << 24);
        runs.add(draw.uniformOffset + 39 * 4, 4);
      }
    }
    runs.flush();
  }

  /** Moving draws take the room their centre is in (roomAt), uploaded when it changes. */
  #updateRooms(scene: GpuScene): void {
    const roomAt = this.roomAt;
    if (!roomAt || scene.moving.length === 0) return;
    const uints = new Uint32Array(scene.uniformData);
    const runs = new UniformRuns(this.#device, scene.uniforms, scene.uniformData);
    for (const { draw } of scene.moving) {
      if (draw.firstPerson || draw.sky) continue;
      const at = draw.uniformOffset / 4 + 38;
      const before = uints[at] ?? 0;
      const room = roomAt(draw.center) & 0xff;
      const after = ((before & ~(0xff << DRAW_ROOM_SHIFT)) | (room << DRAW_ROOM_SHIFT)) >>> 0;
      if (after === before) continue;
      uints[at] = after;
      runs.add(draw.uniformOffset + 38 * 4, 4);
    }
    runs.flush();
  }

  #visible(draw: Draw): boolean {
    if (draw.visibility?.hidden) return false;
    // Faded out entirely with distance (object-fade.ts).
    if (draw.fade && draw.fade.level >= 255) return false;
    if (draw.sky || draw.firstPerson) return true;
    if (!sphereVisible(this.#frame.planes, draw.center, draw.radius)) return false;
    return this.#frame.rooms?.visible(draw.center, draw.radius) ?? true;
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

  #drawPart(
    pass: GPURenderPassEncoder,
    scene: GpuScene,
    draw: Draw,
    state: PassState = passState(),
  ): void {
    const { part } = draw;
    bindPart(pass, state, part.pipeline, part);
    pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
    this.#bindBones(pass, scene, draw);
    if (draw.ranges) {
      for (const range of draw.ranges) pass.drawIndexed(range.count, 1, range.first);
      return;
    }
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
        cellLoaded(this.#frame.lodMask, segment.cellX, segment.cellY) ||
        (segment.largeRef &&
          largeRefsLoaded(this.#frame.largeRefMask, segment.cellX, segment.cellY))
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
    /** The model is the game's own (a texture it names that is missing, the game lacks). */
    fromGameContent = false,
  ): Promise<GPUBindGroup> {
    const { defaults } = textures;
    const [diffuse, normal, glow, env, envMask, slot7, slot6, detail] = await Promise.all(
      materialTextures(material).map((path) => textures.get(path, fromGameContent)),
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
        // A missing detail map leaves the face as it is (the engine's blank detail map).
        { binding: 11, resource: (flat(detail) ?? defaults.blankDetail).createView() },
      ],
    });
  }

  /** The sampler that wraps both U and V (the default clamp mode). */
  get #repeatSampler(): GPUSampler {
    const sampler = this.#samplers[3];
    if (!sampler) throw new Error('Material samplers missing');
    return sampler;
  }

  /**
   * Instanced quads (or strip segments, or lightning's ribbons) with the effect shader and the
   * system's blending.
   */
  #particlePipeline(system: ParticleSystemData): GPURenderPipeline {
    const material = system.material;
    const flags1 = material?.flags1 ?? SLSF1_ZBUFFER_TEST;
    const flags2 = material?.flags2 ?? 0;
    const blend = blendState(system.alpha);
    // Blended particles never write depth: their quads overlap unsorted within the system.
    const depthWrite = blend === undefined && (flags2 & SLSF2_ZBUFFER_WRITE) !== 0;
    const depthTest = (flags1 & SLSF1_ZBUFFER_TEST) !== 0;
    const entryPoint = system.lightning ? 'vs_ribbon' : system.strip ? 'vs_strip' : 'vs_particle';
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
          // Opaque parts are drawn in the opaque pass, which also has the G-buffer; blended
          // ones in the blended pass, which has not; refraction shapes into the refraction
          // buffer. Opaque lit parts leave fog and snow highlights to the composite.
          targets: refraction
            ? [{ format: REFRACTION_FORMAT }]
            : [
                { format: this.#colorFormat, ...(blend && { blend }) },
                ...(blend === undefined ? [gbufferTarget(true)] : []),
              ],
          ...(shader === 'lighting' && blend === undefined && { constants: { DEFERRED: 1 } }),
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
    instance.model.parts.flatMap(({ part }) =>
      part.weaponBlood === true
        ? []
        : [
            {
              part,
              instanceWorld: instance.world,
              center: transformPoint(instance.world, part.center),
              radius: part.radius * maxScale(instance.world),
            },
          ],
    ),
  );
}
