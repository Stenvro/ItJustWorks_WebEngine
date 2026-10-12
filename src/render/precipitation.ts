// Rain and snow (SPGD) on the GPU: one instanced draw per active precipitation, in front of
// everything at the end of the blended pass (shaders/precipitation.wgsl). Which particles are
// under a roof comes from an occlusion map: the scene's shadow casters seen from straight
// above, in layer 4 of the shadow map.
// Notes: docs/rendering.md ("Precipitation").

import type { Precipitation } from '../world/precipitation.ts';
import type { Mat4, Vec3 } from './math.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT } from './scene-renderer.ts';
import frameShader from './shaders/frame.wgsl?raw';
import precipitationShader from './shaders/precipitation.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';

/**
 * SPGD particle sizes are small numbers (rain 0.35 × 2, snow about 1.5): world units are this
 * many times larger (the engine scales snow quads by a technique constant of their own). The
 * rain texture's drop is a line 1/8 of its frame wide, so drops are about 2 units thick and
 * 100 long; the snow atlas's flakes fill about half their frame, 10–13 units across.
 * TODO(M13): calibrate both against the original renderer.
 */
export const PRECIPITATION_SIZE_SCALE = { rain: 50, snow: 16 } as const;
/** Particles per unit of SPGD density. */
const PARTICLES_PER_DENSITY = 1024;
const MAX_PARTICLES = 65536;
/** How strongly the weather's wind drives the particles (share of the wind's velocity). */
const WIND_DRIFT = { rain: 0.15, snow: 0.5 } as const;
/** Uniform floats: 4 vec4 + the occlusion matrix. */
const UNIFORM_FLOATS = 32;

/** A precipitation type on the GPU. */
export class GpuPrecipitation {
  readonly precipitation: Precipitation;
  readonly bindGroup: GPUBindGroup;
  readonly uniforms: GPUBuffer;

  constructor(precipitation: Precipitation, bindGroup: GPUBindGroup, uniforms: GPUBuffer) {
    this.precipitation = precipitation;
    this.bindGroup = bindGroup;
    this.uniforms = uniforms;
  }

  destroy(): void {
    this.uniforms.destroy();
  }
}

/** What falls this frame and how much of it (weather transitions fade it). */
export interface PrecipitationFrame {
  readonly system: GpuPrecipitation;
  readonly amount: number;
}

/** The occlusion map's view: an orthographic view straight down around the camera. */
export function occlusionView(camera: Vec3, extent: number, depth: number): Mat4 {
  const m = new Float32Array(16);
  // x and y map the square around the camera to −1..1; z maps from `depth` above the camera
  // (0) to `depth` below it (1); looking down, north is up in the map.
  m[0] = 1 / extent;
  m[5] = 1 / extent;
  m[10] = -1 / (2 * depth);
  m[12] = -camera[0] / extent;
  m[13] = -camera[1] / extent;
  m[14] = 0.5 + camera[2] / (2 * depth);
  m[15] = 1;
  return m;
}

export class PrecipitationRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #data = new Float32Array(UNIFORM_FLOATS);

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, frameLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      label: 'precipitation',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const module = device.createShaderModule({
      label: 'precipitation',
      code: frameShader + precipitationShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: 'precipitation',
      layout: device.createPipelineLayout({
        label: 'precipitation',
        bindGroupLayouts: [frameLayout, this.#layout],
      }),
      vertex: { module, entryPoint: 'vs_precipitation' },
      fragment: {
        module,
        entryPoint: 'fs_precipitation',
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
      multisample: { count: SAMPLE_COUNT },
    });
    this.#sampler = device.createSampler({
      label: 'precipitation',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** Uploads a precipitation type (its texture loads first; none without it). */
  async create(
    precipitation: Precipitation,
    textures: TextureCache,
  ): Promise<GpuPrecipitation | undefined> {
    const texture = await textures.get(precipitation.texture);
    if (!texture) return undefined;
    const uniforms = this.#device.createBuffer({
      label: `precipitation-${precipitation.editorId}`,
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.#device.createBindGroup({
      label: `precipitation-${precipitation.editorId}`,
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: texture.createView() },
      ],
    });
    return new GpuPrecipitation(precipitation, bindGroup, uniforms);
  }

  /**
   * Draws the precipitation of a frame (last in the blended pass). `wind` is the weather's
   * wind velocity; `occlusion` the occlusion map's view of this frame.
   */
  draw(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    frames: readonly PrecipitationFrame[],
    seconds: number,
    wind: Vec3,
    occlusion: Mat4,
  ): void {
    for (const { system, amount } of frames) {
      if (amount <= 0) continue;
      const p = system.precipitation;
      const snow = p.type === 'snow';
      const drift = snow ? WIND_DRIFT.snow : WIND_DRIFT.rain;
      const scale = PRECIPITATION_SIZE_SCALE[p.type];
      const count = Math.min(MAX_PARTICLES, Math.round(p.density * PARTICLES_PER_DENSITY));
      if (count <= 0) continue;
      const data = this.#data;
      data.set([p.boxSize, count, p.sizeX * scale, p.sizeY * scale], 0);
      data.set(
        [
          wind[0] * drift,
          wind[1] * drift,
          -p.gravityVelocity + wind[2] * drift,
          (p.rotationVelocity * Math.PI) / 180,
        ],
        4,
      );
      data.set(
        [
          p.centerOffsetMin,
          p.centerOffsetMax,
          (p.initialRotationRange * Math.PI) / 180,
          snow ? 1 : 0,
        ],
        8,
      );
      // The time wraps (the particles' lattice is periodic anyway) to keep float precision.
      data.set([p.subtexturesX, p.subtexturesY, Math.min(1, amount), seconds % 3600], 12);
      data.set(occlusion, 16);
      this.#device.queue.writeBuffer(system.uniforms, 0, data);
      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, frameBindGroup);
      pass.setBindGroup(1, system.bindGroup);
      pass.draw(6, count);
    }
  }
}
