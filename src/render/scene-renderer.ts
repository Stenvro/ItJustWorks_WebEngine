// Draws scenes of model instances built by model-data.ts. Models (geometry + materials) are
// uploaded once; a scene places them with per-instance world matrices. One pipeline per
// vertex layout and material state, per-draw uniforms in one buffer (dynamic offsets),
// opaque first, then blended parts sorted back to front.

import { frustumPlanes, sphereVisible, type Plane } from './frustum.ts';
import { maxScale, multiply, transformPoint, type Mat4, type Vec3 } from './math.ts';
import type { AlphaState, ModelData, ModelPart, VertexLayout } from './model-data.ts';
import commonShader from './shaders/common.wgsl?raw';
import frameShader from './shaders/frame.wgsl?raw';
import effectShader from './shaders/effect.wgsl?raw';
import lightingShader from './shaders/lighting.wgsl?raw';
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
/** WGSL `Frame` struct: 148 floats. */
const FRAME_FLOATS = 148;
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

/** A model on the GPU: geometry, materials and pipelines, placed by scenes. */
export class GpuModel {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly parts: readonly GpuPart[];
  readonly #buffers: readonly GPUBuffer[];

  constructor(init: {
    center: readonly [number, number, number];
    radius: number;
    parts: readonly GpuPart[];
    buffers: readonly GPUBuffer[];
  }) {
    this.center = init.center;
    this.radius = init.radius;
    this.parts = init.parts;
    this.#buffers = init.buffers;
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

/** Placed model instances with their per-draw uniforms. Does not own the models. */
export class GpuScene {
  readonly draws: readonly Draw[];
  readonly drawBindGroup: GPUBindGroup;
  readonly #uniforms: GPUBuffer;

  constructor(draws: readonly Draw[], drawBindGroup: GPUBindGroup, uniforms: GPUBuffer) {
    this.draws = draws;
    this.drawBindGroup = drawBindGroup;
    this.#uniforms = uniforms;
  }

  destroy(): void {
    this.#uniforms.destroy();
  }
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
function writeMaterial(floats: Float32Array, uints: Uint32Array, part: ModelPart): void {
  const material = part.material;
  const alphaThreshold = (part.alpha?.threshold ?? 128) / 255;
  if (material?.kind === 'water') {
    floats.set([...material.uvOffset, ...material.uvScale], 16);
    uints.set([material.flags1, material.flags2, 0, material.waterFlags], 36);
    return;
  }
  if (material?.kind === 'effect') {
    floats.set([...material.uvOffset, ...material.uvScale], 16);
    floats.set(
      material.baseColor.map((c, i) => (i < 3 ? c * material.baseColorScale : c)),
      20,
    );
    floats.set([0, 0, 0, 0], 24);
    floats.set([1, 1, alphaThreshold, 0], 28);
    floats.set(material.falloff, 32);
    uints.set([material.flags1, material.flags2, part.alpha?.flags ?? 0, 0], 36);
    return;
  }
  floats.set([...(material?.uvOffset ?? [0, 0]), ...(material?.uvScale ?? [1, 1])], 16);
  const emissive = material?.emissiveColor ?? [0, 0, 0];
  const multiple = material?.emissiveMultiple ?? 0;
  floats.set([emissive[0] * multiple, emissive[1] * multiple, emissive[2] * multiple, 1], 20);
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
  readonly #frameBindGroup: GPUBindGroup;
  readonly #frameLayout: GPUBindGroupLayout;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #modules: {
    readonly lighting: GPUShaderModule;
    readonly effect: GPUShaderModule;
    readonly water: GPUShaderModule;
  };
  readonly #waterTypeLayout: GPUBindGroupLayout;
  readonly #waterFrameLayout: GPUBindGroupLayout;
  readonly #waterPipelineLayout: GPUPipelineLayout;
  readonly #waterFrameBuffer: GPUBuffer;
  readonly #waterFrameData = new Float32Array(WATER_FRAME_FLOATS);
  readonly #screenSampler: GPUSampler;
  /** Flow map without flow (alpha 1: strength 0). */
  readonly #stillFlow: GPUTexture;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #fallbackVertices: GPUBuffer;
  readonly #sampler: GPUSampler;
  readonly #shadowMap: GPUTexture;
  readonly #cascadeLayout: GPUBindGroupLayout;
  readonly #cascadeBuffer: GPUBuffer;
  readonly #cascadeBindGroup: GPUBindGroup;
  readonly #shadowModule: GPUShaderModule;
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
    this.#waterFrameLayout = device.createBindGroupLayout({
      label: 'water-frame',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#waterPipelineLayout = device.createPipelineLayout({
      label: 'water',
      bindGroupLayouts: [
        frameLayout,
        this.#drawLayout,
        this.#waterTypeLayout,
        this.#waterFrameLayout,
      ],
    });
    this.#waterFrameBuffer = device.createBuffer({
      label: 'water-frame',
      size: WATER_FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
    this.#frameBindGroup = device.createBindGroup({
      label: 'frame',
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#frameBuffer } },
        { binding: 1, resource: { buffer: this.#lightBuffer } },
        { binding: 2, resource: this.#shadowMap.createView({ dimension: '2d-array' }) },
        {
          binding: 3,
          resource: device.createSampler({
            label: 'shadow',
            compare: 'less-equal',
            magFilter: 'linear',
            minFilter: 'linear',
          }),
        },
      ],
    });
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
    };
    this.#fallbackVertices = createBuffer(
      device,
      FALLBACK_VERTEX,
      GPUBufferUsage.VERTEX,
      'fallback-vertex',
    );
    this.#sampler = device.createSampler({
      label: 'linear-repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 8,
    });
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
        const blend = water ? undefined : blendState(part.alpha);
        return {
          part,
          vertexBuffer,
          indexBuffer,
          indexCount: part.indices.length,
          pipeline: water ? this.#waterPipeline(part) : this.#pipeline(part, blend),
          bindGroup: await this.#materialBindGroup(part, textures),
          pass: water ? 'water' : blend !== undefined ? 'transparent' : 'opaque',
          shadowPipeline:
            !water &&
            blend === undefined &&
            part.material?.kind === 'lighting' &&
            (part.material.flags1 & SLSF1_CAST_SHADOWS) !== 0 &&
            !LOD_SHADER_TYPES.has(part.material.shaderType)
              ? this.#shadowPipeline(part)
              : undefined,
        };
      }),
    );
    return new GpuModel({ center: data.center, radius: data.radius, parts, buffers });
  }

  /** Places model instances; writes one uniform slot per (instance, part). */
  createScene(instances: readonly ModelInstance[]): GpuScene {
    const drawCount = instances.reduce((sum, instance) => sum + instance.model.parts.length, 0);
    const uniforms = new ArrayBuffer(Math.max(1, drawCount) * DRAW_STRIDE);
    const draws: Draw[] = [];
    const world = new Float32Array(16);
    for (const instance of instances) {
      for (const part of instance.model.parts) {
        const offset = draws.length * DRAW_STRIDE;
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
    }
    const buffer = createBuffer(
      this.#device,
      new Uint8Array(uniforms),
      GPUBufferUsage.UNIFORM,
      'draw-uniforms',
    );
    const bindGroup = this.#device.createBindGroup({
      label: 'draw',
      layout: this.#drawLayout,
      entries: [{ binding: 0, resource: { buffer, size: DRAW_SIZE } }],
    });
    return new GpuScene(draws, bindGroup, buffer);
  }

  updateFrame(
    viewProjection: Mat4,
    cameraPosition: Vec3,
    lighting: SceneLighting,
    timeSeconds = 0,
    lodMask?: LodMask,
    shadows?: FrameShadows,
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

  /** Draws water surfaces; `inputs` holds the opaque scene's colour and depth. */
  drawWater(pass: GPURenderPassEncoder, scenes: Iterable<GpuScene>, inputs: GPUBindGroup): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    pass.setBindGroup(3, inputs);
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

  /** Draws the blended parts of all scenes back to front. */
  drawTransparent(
    pass: GPURenderPassEncoder,
    scenes: Iterable<GpuScene>,
    cameraPosition: Vec3,
  ): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    const transparent: { scene: GpuScene; draw: Draw; distance: number }[] = [];
    for (const scene of scenes) {
      for (const draw of scene.draws) {
        if (draw.part.pass !== 'transparent' || !this.#visible(draw)) continue;
        const dx = draw.center[0] - cameraPosition[0];
        const dy = draw.center[1] - cameraPosition[1];
        const dz = draw.center[2] - cameraPosition[2];
        transparent.push({ scene, draw, distance: dx * dx + dy * dy + dz * dz });
      }
    }
    transparent.sort((a, b) => b.distance - a.distance);
    for (const { scene, draw } of transparent) this.#drawPart(pass, scene, draw);
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
        { binding: 7, resource: this.#sampler },
        { binding: 8, resource: view(0) },
        { binding: 9, resource: view(1) },
        { binding: 10, resource: view(2) },
        { binding: 11, resource: (flowTexture ?? this.#stillFlow).createView() },
      ],
    });
    return new GpuWaterType(type, bindGroup, buffer);
  }

  /** Water inputs: the opaque scene's colour and depth (single-sample copies). */
  waterInputs(color: GPUTextureView, depth: GPUTextureView): GPUBindGroup {
    return this.#device.createBindGroup({
      label: 'water-frame',
      layout: this.#waterFrameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#waterFrameBuffer } },
        { binding: 1, resource: color },
        { binding: 2, resource: depth },
        { binding: 3, resource: this.#screenSampler },
      ],
    });
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

  async #materialBindGroup(part: ModelPart, textures: TextureCache): Promise<GPUBindGroup> {
    const { defaults } = textures;
    const material = part.material;
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

    return this.#device.createBindGroup({
      label: part.name,
      layout: this.#materialLayout,
      entries: [
        { binding: 0, resource: this.#sampler },
        { binding: 1, resource: (diffuse ?? defaults.white).createView() },
        { binding: 2, resource: (normal ?? defaults.flatNormal).createView() },
        {
          binding: 3,
          resource: (
            glow ?? (material?.kind === 'effect' ? defaults.white : defaults.black)
          ).createView(),
        },
        { binding: 4, resource: cube.createView({ dimension: 'cube' }) },
        { binding: 5, resource: (envMask ?? defaults.white).createView() },
      ],
    });
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
    const shader = material?.kind === 'effect' ? 'effect' : 'lighting';
    const flags1 = material?.flags1 ?? SLSF1_ZBUFFER_TEST;
    const flags2 = material?.flags2 ?? SLSF2_ZBUFFER_WRITE;
    const cullMode: GPUCullMode = (flags2 & SLSF2_DOUBLE_SIDED) !== 0 ? 'none' : 'back';
    const depthWrite = blend === undefined || (flags2 & SLSF2_ZBUFFER_WRITE) !== 0;
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
          entryPoint: 'fs_main',
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
