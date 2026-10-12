// Draws models built by model-data.ts: one pipeline per vertex layout and material state,
// per-part uniforms in one buffer (dynamic offsets), opaque first, then blended parts
// sorted back to front.

import type { Mat4, Vec3 } from './math.ts';
import type { AlphaState, ModelData, ModelPart, VertexLayout } from './model-data.ts';
import commonShader from './shaders/common.wgsl?raw';
import effectShader from './shaders/effect.wgsl?raw';
import lightingShader from './shaders/lighting.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';

export const SAMPLE_COUNT = 4;
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** Size of the WGSL `Draw` struct and the stride between parts (uniform offset alignment). */
const DRAW_SIZE = 160;
const DRAW_STRIDE = 256;
const FRAME_SIZE = 128;

const SLSF1_ZBUFFER_TEST = 0x80000000;
const SLSF2_ZBUFFER_WRITE = 0x1;
const SLSF2_DOUBLE_SIDED = 0x10;
const SLSF1_ENVIRONMENT_MAPPING = 0x80;
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

export interface SceneLighting {
  /** Direction towards the sun. */
  readonly sunDirection: Vec3;
  readonly sunColor: Vec3;
  readonly ambient: Vec3;
}

interface GpuPart {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexCount: number;
  readonly pipeline: GPURenderPipeline;
  readonly bindGroup: GPUBindGroup;
  readonly uniformOffset: number;
  readonly transparent: boolean;
  readonly center: readonly [number, number, number];
}

export class GpuModel {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly parts: readonly GpuPart[];
  readonly drawBindGroup: GPUBindGroup;
  readonly #buffers: readonly GPUBuffer[];

  constructor(init: {
    center: readonly [number, number, number];
    radius: number;
    parts: readonly GpuPart[];
    drawBindGroup: GPUBindGroup;
    buffers: readonly GPUBuffer[];
  }) {
    this.center = init.center;
    this.radius = init.radius;
    this.parts = init.parts;
    this.drawBindGroup = init.drawBindGroup;
    this.#buffers = init.buffers;
  }

  destroy(): void {
    for (const buffer of this.#buffers) buffer.destroy();
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
    size: Math.ceil(data.byteLength / 4) * 4,
    usage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  buffer.unmap();
  return buffer;
}

export class SceneRenderer {
  readonly #device: GPUDevice;
  readonly #colorFormat: GPUTextureFormat;
  readonly #frameBuffer: GPUBuffer;
  readonly #frameData = new Float32Array(FRAME_SIZE / 4);
  readonly #frameBindGroup: GPUBindGroup;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #modules: { readonly lighting: GPUShaderModule; readonly effect: GPUShaderModule };
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #fallbackVertices: GPUBuffer;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat) {
    this.#device = device;
    this.#colorFormat = colorFormat;

    const frameLayout = device.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });
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

    this.#frameBuffer = device.createBuffer({
      label: 'frame',
      size: FRAME_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#frameBindGroup = device.createBindGroup({
      label: 'frame',
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.#frameBuffer } }],
    });
    this.#modules = {
      lighting: device.createShaderModule({
        label: 'lighting',
        code: commonShader + lightingShader,
      }),
      effect: device.createShaderModule({ label: 'effect', code: commonShader + effectShader }),
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
    const uniforms = new ArrayBuffer(Math.max(1, data.parts.length) * DRAW_STRIDE);
    const buffers: GPUBuffer[] = [];

    const parts = await Promise.all(
      data.parts.map(async (part, index): Promise<GpuPart> => {
        this.#writeDrawUniforms(uniforms, index * DRAW_STRIDE, part);
        const vertexBuffer = createBuffer(device, part.vertices, GPUBufferUsage.VERTEX, part.name);
        const indexBuffer = createBuffer(device, part.indices, GPUBufferUsage.INDEX, part.name);
        buffers.push(vertexBuffer, indexBuffer);
        const blend = blendState(part.alpha);
        return {
          vertexBuffer,
          indexBuffer,
          indexCount: part.indices.length,
          pipeline: this.#pipeline(part, blend),
          bindGroup: await this.#materialBindGroup(part, textures),
          uniformOffset: index * DRAW_STRIDE,
          transparent: blend !== undefined,
          center: part.center,
        };
      }),
    );

    const uniformBuffer = createBuffer(
      device,
      new Uint8Array(uniforms),
      GPUBufferUsage.UNIFORM,
      'draw-uniforms',
    );
    buffers.push(uniformBuffer);
    const drawBindGroup = device.createBindGroup({
      label: 'draw',
      layout: this.#drawLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer, size: DRAW_SIZE } }],
    });
    return new GpuModel({
      center: data.center,
      radius: data.radius,
      parts,
      drawBindGroup,
      buffers,
    });
  }

  updateFrame(viewProjection: Mat4, cameraPosition: Vec3, lighting: SceneLighting): void {
    const data = this.#frameData;
    data.set(viewProjection, 0);
    data.set([...cameraPosition, 1], 16);
    data.set([...lighting.sunDirection, 0], 20);
    data.set([...lighting.sunColor, 1], 24);
    data.set([...lighting.ambient, 1], 28);
    this.#device.queue.writeBuffer(this.#frameBuffer, 0, data);
  }

  draw(pass: GPURenderPassEncoder, models: readonly GpuModel[], cameraPosition: Vec3): void {
    pass.setBindGroup(0, this.#frameBindGroup);
    pass.setVertexBuffer(1, this.#fallbackVertices);
    const transparent: { model: GpuModel; part: GpuPart; distance: number }[] = [];

    for (const model of models) {
      for (const part of model.parts) {
        if (part.transparent) {
          const dx = part.center[0] - cameraPosition[0];
          const dy = part.center[1] - cameraPosition[1];
          const dz = part.center[2] - cameraPosition[2];
          transparent.push({ model, part, distance: dx * dx + dy * dy + dz * dz });
        } else {
          this.#drawPart(pass, model, part);
        }
      }
    }
    transparent.sort((a, b) => b.distance - a.distance);
    for (const { model, part } of transparent) this.#drawPart(pass, model, part);
  }

  #drawPart(pass: GPURenderPassEncoder, model: GpuModel, part: GpuPart): void {
    pass.setPipeline(part.pipeline);
    pass.setBindGroup(1, model.drawBindGroup, [part.uniformOffset]);
    pass.setBindGroup(2, part.bindGroup);
    pass.setVertexBuffer(0, part.vertexBuffer);
    pass.setIndexBuffer(part.indexBuffer, 'uint16');
    pass.drawIndexed(part.indexCount);
  }

  #writeDrawUniforms(target: ArrayBuffer, offset: number, part: ModelPart): void {
    const floats = new Float32Array(target, offset, DRAW_SIZE / 4);
    const uints = new Uint32Array(target, offset, DRAW_SIZE / 4);
    floats.set(part.world, 0);
    const material = part.material;
    const alphaThreshold = (part.alpha?.threshold ?? 128) / 255;
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
    } else {
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

  #pipeline(part: ModelPart, blend: GPUBlendState | undefined): GPURenderPipeline {
    const material = part.material;
    const shader = material?.kind === 'effect' ? 'effect' : 'lighting';
    const flags1 = material?.flags1 ?? SLSF1_ZBUFFER_TEST;
    const flags2 = material?.flags2 ?? SLSF2_ZBUFFER_WRITE;
    const cullMode: GPUCullMode = (flags2 & SLSF2_DOUBLE_SIDED) !== 0 ? 'none' : 'back';
    const depthWrite = blend === undefined || (flags2 & SLSF2_ZBUFFER_WRITE) !== 0;
    const depthTest = (flags1 & SLSF1_ZBUFFER_TEST) !== 0 || material === undefined;
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
        },
        multisample: { count: SAMPLE_COUNT },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}

/** Mesh attributes from buffer 0; missing ones from the constant fallback buffer 1. */
function vertexBuffers(layout: VertexLayout): GPUVertexBufferLayout[] {
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
