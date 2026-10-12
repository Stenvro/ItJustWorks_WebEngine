// Draws scenes of model instances built by model-data.ts. Models (geometry + materials) are
// uploaded once; a scene places them with per-instance world matrices. One pipeline per
// vertex layout and material state, per-draw uniforms in one buffer (dynamic offsets),
// opaque first, then blended parts sorted back to front.

import { animate, type AnimationFrame, type ModelAnimation } from './animation.ts';
import { billboardWorld } from './billboard.ts';
import { frustumPlanes, invert, sphereVisible, type Plane } from './frustum.ts';
import { identity, maxScale, multiply, transformPoint, type Mat4, type Vec3 } from './math.ts';
import type { AlphaState, ModelData, ModelPart, PartMaterial, VertexLayout } from './model-data.ts';
import type { ParticleSystemData } from './particle-data.ts';
import type { PlacedPart } from './raycast.ts';
import { PARTICLE_FLOATS, ParticleSimulation, type ParticleContext } from './particle-sim.ts';
import commonShader from './shaders/common.wgsl?raw';
import frameShader from './shaders/frame.wgsl?raw';
import effectShader from './shaders/effect.wgsl?raw';
import lightingShader from './shaders/lighting.wgsl?raw';
import particleShader from './shaders/particle.wgsl?raw';
import refractionShader from './shaders/refraction.wgsl?raw';
import shadowShader from './shaders/shadow.wgsl?raw';
import waterShader from './shaders/water.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';
import type { WaterType } from '../world/water.ts';

export const SAMPLE_COUNT = 4;
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
export const MAX_LIGHTS = 256;

/** Size of the WGSL `Draw` struct and the stride between draws (uniform offset alignment). */
const DRAW_SIZE = 160;
const DRAW_STRIDE = 256;
/** WGSL `Frame` struct: 176 floats. */
const FRAME_FLOATS = 176;
/** Sun shadow map: one layer per cascade. */
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_MAP_LAYERS = 4;
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
type PartPass = 'opaque' | 'water' | 'transparent';

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
  readonly particles: readonly GpuParticleSystem[];
  /**
   * Models the engine attaches at AddOnNodes (ADDN: candle flames, torch fire, smoke),
   * resolved by the session; placed with every instance of this model.
   */
  addons: readonly ModelAddon[] = [];
  readonly #buffers: readonly GPUBuffer[];

  constructor(init: {
    center: readonly [number, number, number];
    radius: number;
    parts: readonly GpuPart[];
    buffers: readonly GPUBuffer[];
    animation: ModelAnimation | undefined;
    particles: readonly GpuParticleSystem[];
  }) {
    this.center = init.center;
    this.radius = init.radius;
    this.parts = init.parts;
    this.#buffers = init.buffers;
    this.animation = init.animation;
    this.particles = init.particles;
  }

  destroy(): void {
    for (const buffer of this.#buffers) buffer.destroy();
  }
}

export interface ModelInstance {
  readonly model: GpuModel;
  readonly world: Mat4;
  /** Water type of the model's water surfaces (the activator's WNAM); default otherwise. */
  readonly water?: GpuWaterType;
}

interface Draw {
  readonly part: GpuPart;
  readonly uniformOffset: number;
  readonly center: readonly [number, number, number];
  /** Bounding sphere radius in world units (culling). */
  readonly radius: number;
  readonly water: GpuWaterType | undefined;
}

/** A draw that changes every frame (animated, or turning to the camera). */
interface AnimatedDraw {
  readonly offset: number;
  readonly instanceWorld: Mat4;
  readonly part: ModelPart;
  readonly animation: ModelAnimation | undefined;
}

/** A placed particle system: its simulation and where its particles are this frame. */
interface ParticleDraw {
  readonly system: GpuParticleSystem;
  readonly simulation: ParticleSimulation;
  readonly instanceWorld: Mat4;
  readonly animation: ModelAnimation | undefined;
  readonly uniformOffset: number;
  /** Where the system sits in the world (update distance before it has particles). */
  readonly origin: readonly [number, number, number];
  /** Instances in the frame's particle buffer. */
  first: number;
  count: number;
  /** Seconds of the last update. */
  updated: number | undefined;
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

  constructor(
    draws: readonly Draw[],
    drawBindGroup: GPUBindGroup,
    uniforms: GPUBuffer,
    uniformData: ArrayBuffer,
    animated: readonly AnimatedDraw[],
    particles: readonly ParticleDraw[],
  ) {
    this.draws = draws;
    this.drawBindGroup = drawBindGroup;
    this.uniforms = uniforms;
    this.uniformData = uniformData;
    this.animated = animated;
    this.particles = particles;
  }

  destroy(): void {
    this.uniforms.destroy();
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
const REFRACTION_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

function isRefraction(material: PartMaterial | undefined): boolean {
  return material?.kind === 'lighting' && (material.flags1 & SLSF1_REFRACTION) !== 0;
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
}

/** Debug views of the lighting shader (dev tools): what a pixel shows instead of its colour. */
export const DebugView = {
  lit: 0,
  albedo: 1,
  normals: 2,
  lightOnly: 3,
  vertexColors: 4,
  geometryNormals: 5,
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
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, SHADOW_MAP_LAYERS],
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
      size: CASCADE_STRIDE * SHADOW_MAP_LAYERS,
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
      ],
    });
    this.#pipelineLayout = device.createPipelineLayout({
      label: 'object',
      bindGroupLayouts: [frameLayout, this.#drawLayout, this.#materialLayout],
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
        code: frameShader + commonShader + lightingShader,
      }),
      effect: device.createShaderModule({
        label: 'effect',
        code: frameShader + commonShader + effectShader,
      }),
      water: device.createShaderModule({
        label: 'water',
        code: frameShader + commonShader + waterShader,
      }),
      refraction: device.createShaderModule({
        label: 'refraction',
        code: frameShader + commonShader + refractionShader,
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
        // Refraction shapes blend the shifted scene over it by their mask.
        const refraction = isRefraction(part.material);
        const blend = water ? undefined : refraction ? REFRACTION_BLEND : blendState(part.alpha);
        return {
          part,
          vertexBuffer,
          indexBuffer,
          indexCount: part.indices.length,
          pipeline: water ? this.#waterPipeline(part) : this.#pipeline(part, blend),
          bindGroup: await this.#materialBindGroup(part.material, part.name, textures),
          pass: water ? 'water' : blend !== undefined ? 'transparent' : 'opaque',
          shadowPipeline:
            !water &&
            !refraction &&
            blend === undefined &&
            part.material?.kind === 'lighting' &&
            (part.material.flags1 & SLSF1_CAST_SHADOWS) !== 0 &&
            !LOD_SHADER_TYPES.has(part.material.shaderType)
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
    return new GpuModel({
      center: data.center,
      radius: data.radius,
      parts,
      buffers,
      animation: data.animation,
      particles,
    });
  }

  /**
   * Places model instances (with the models attached at their AddOnNodes); writes one
   * uniform slot per (instance, part) and per (instance, particle system).
   */
  createScene(instances: readonly ModelInstance[]): GpuScene {
    const placed: ModelInstance[] = [];
    const place = (instance: ModelInstance, depth: number): void => {
      placed.push(instance);
      if (depth >= 2) return;
      for (const addon of instance.model.addons) {
        place({ model: addon.model, world: multiply(instance.world, addon.world) }, depth + 1);
      }
    };
    for (const instance of instances) place(instance, 0);

    const drawCount = placed.reduce(
      (sum, instance) => sum + instance.model.parts.length + instance.model.particles.length,
      0,
    );
    const uniforms = new ArrayBuffer(Math.max(1, drawCount) * DRAW_STRIDE);
    const draws: Draw[] = [];
    const animated: AnimatedDraw[] = [];
    const particles: ParticleDraw[] = [];
    const world = new Float32Array(16);
    let slot = 0;
    for (const instance of placed) {
      const animation = instance.model.animation;
      for (const part of instance.model.parts) {
        const offset = slot++ * DRAW_STRIDE;
        if (animation || part.part.billboard) {
          animated.push({ offset, instanceWorld: instance.world, part: part.part, animation });
        }
        const floats = new Float32Array(uniforms, offset, DRAW_SIZE / 4);
        const uints = new Uint32Array(uniforms, offset, DRAW_SIZE / 4);
        multiply(instance.world, part.part.world, world);
        floats.set(world, 0);
        writeMaterial(floats, uints, part.part);
        draws.push({
          part,
          uniformOffset: offset,
          center: transformPoint(instance.world, part.part.center),
          radius: part.part.radius * maxScale(instance.world),
          water: part.pass === 'water' ? instance.water : undefined,
        });
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
        particles.push({
          system,
          simulation: new ParticleSimulation(system.data, seed),
          instanceWorld: instance.world,
          animation,
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
    return new GpuScene(draws, bindGroup, buffer, uniforms, animated, particles);
  }

  updateFrame(
    viewProjection: Mat4,
    cameraPosition: Vec3,
    lighting: SceneLighting,
    timeSeconds = 0,
    lodMask?: LodMask,
    shadows?: FrameShadows,
    screen?: { readonly width: number; readonly height: number; readonly near: number },
  ): void {
    this.#planes = frustumPlanes(viewProjection);
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
    for (const scene of sceneList) {
      for (const draw of scene.animated) {
        const frame = frameOf(draw.animation);
        const floats = new Float32Array(scene.uniformData, draw.offset, DRAW_SIZE / 4);
        const billboard = draw.part.billboard;
        if (frame?.hidden.has(draw.part.block)) {
          floats.fill(0, 0, 16);
        } else if (billboard) {
          const node = multiply(draw.instanceWorld, billboard.node);
          multiply(billboardWorld(node, billboard.mode, camera), billboard.local, world);
          floats.set(world, 0);
        } else {
          multiply(
            draw.instanceWorld,
            frame?.worlds.get(draw.part.block) ?? draw.part.world,
            world,
          );
          floats.set(world, 0);
        }
        if (frame) writeAnimatedMaterial(floats, draw.part, frame);
        this.#device.queue.writeBuffer(
          scene.uniforms,
          draw.offset,
          scene.uniformData,
          draw.offset,
          DRAW_SIZE,
        );
      }
    }
    this.#runParticles(sceneList, seconds, camera, wind, frameOf);
  }

  /** Updates the particle systems and gathers their instances into this frame's buffer. */
  #runParticles(
    scenes: readonly GpuScene[],
    seconds: number,
    camera: Vec3,
    wind: Vec3,
    frameOf: (animation: ModelAnimation | undefined) => AnimationFrame | undefined,
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
        const frame = frameOf(draw.animation);
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
        transparent.push({ scene, draw, distance: distance(draw.center) });
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
        pass.setVertexBuffer(0, part.vertexBuffer);
        pass.setIndexBuffer(part.indexBuffer, 'uint16');
        pass.drawIndexed(part.indexCount);
      }
    }
  }

  #visible(draw: Draw): boolean {
    return sphereVisible(this.#planes, draw.center, draw.radius);
  }

  #drawPart(pass: GPURenderPassEncoder, scene: GpuScene, draw: Draw): void {
    const { part } = draw;
    pass.setPipeline(part.pipeline);
    pass.setBindGroup(1, scene.drawBindGroup, [draw.uniformOffset]);
    pass.setBindGroup(2, part.bindGroup);
    pass.setVertexBuffer(0, part.vertexBuffer);
    pass.setIndexBuffer(part.indexBuffer, 'uint16');
    pass.drawIndexed(part.indexCount);
  }

  async #materialBindGroup(
    material: PartMaterial | undefined,
    label: string,
    textures: TextureCache,
  ): Promise<GPUBindGroup> {
    const { defaults } = textures;
    const slot = (index: number): string =>
      material?.kind === 'lighting' ? (material.textures[index] ?? '') : '';

    let diffusePath = slot(0);
    let glowPath = '';
    let envPath = '';
    let envMaskPath = '';
    if (material?.kind === 'effect') {
      diffusePath = material.sourceTexture;
      glowPath = material.greyscaleTexture;
    } else if (material?.kind === 'lighting') {
      if (material.shaderType === SHADER_GLOW) glowPath = slot(2);
      if ((material.flags1 & SLSF1_ENVIRONMENT_MAPPING) !== 0) {
        envPath = slot(4);
        envMaskPath = slot(5);
      }
    }

    const [diffuse, normal, glow, env, envMask] = await Promise.all([
      textures.get(diffusePath),
      textures.get(slot(1)),
      textures.get(glowPath),
      textures.get(envPath),
      textures.get(envMaskPath),
    ]);
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
    const key = ['shadow', layout.stride, withUv ? layout.uv : -1, doubleSided].join('|');
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const attributes: GPUVertexAttribute[] = [
        { shaderLocation: 0, format: 'float32x3', offset: 0 },
      ];
      if (withUv) attributes.push({ shaderLocation: 2, format: 'float16x2', offset: layout.uv });
      pipeline = this.#device.createRenderPipeline({
        label: key,
        layout: this.#device.createPipelineLayout({
          label: 'shadow',
          bindGroupLayouts: [this.#cascadeLayout, this.#drawLayout, this.#materialLayout],
        }),
        vertex: {
          module: this.#shadowModule,
          entryPoint: withUv ? 'vs_object_uv' : 'vs_object',
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
    const key = [
      shader,
      layout.stride,
      layout.uv,
      layout.normal,
      layout.tangent,
      layout.color,
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
        layout: this.#pipelineLayout,
        vertex: {
          module: this.#modules[shader],
          entryPoint: 'vs_main',
          buffers: vertexBuffers(layout),
        },
        fragment: {
          module: this.#modules[shader],
          entryPoint: refraction ? 'fs_refraction' : 'fs_main',
          targets: [{ format: this.#colorFormat, ...(blend && { blend }) }],
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

/** Mesh attributes from buffer 0; missing ones from the constant fallback buffer 1. */
export function vertexBuffers(layout: VertexLayout): GPUVertexBufferLayout[] {
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
