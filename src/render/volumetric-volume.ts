// The weather's volumetric lighting as the original scatters it: a froxel volume over the view
// (shaders/volumetric.wgsl), generated each frame from the sun's shadow cascades and a drifting
// density noise, blended with the last frame, gathered slice by slice from the camera, blurred
// within each slice and added to the HDR scene by each pixel's depth (docs/rendering.md,
// "Volumetric lighting").

import volumetricShader from './shaders/volumetric.wgsl?raw';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';
import { invert } from './frustum.ts';
import {
  densityNoise,
  noiseDrift,
  sliceJitter,
  volumeSize,
  NOISE_SIZE,
  TEMPORAL_FACTOR,
} from './volumetric-data.ts';
import type { Rgb } from '../world/weather.ts';

type Vec3 = readonly [number, number, number];

/** The uniforms: four matrices (64 floats) and eight vectors. */
const UNIFORM_FLOATS = 96;
/** The cascades' depth bias in the volume (as the scene's, frame.wgsl shadowParams.z). */
const SHADOW_BIAS = 0.0004;

/** What the volume needs of a frame. */
export interface VolumeFrame {
  /** Towards the directional light. */
  readonly lightDirection: Vec3;
  /** The light's colour and strength (the weather's intensity × fVolumetricLightingIntensity). */
  readonly color: Rgb;
  readonly strength: number;
  /** The phase function's asymmetry g and its share against even scattering. */
  readonly scattering: number;
  readonly phaseContribution: number;
  /** VOLI's density contribution, density size, wind and falling speed, range factor. */
  readonly densityContribution: number;
  readonly densitySize: number;
  readonly windSpeed: number;
  readonly fallingSpeed: number;
  readonly rangeFactor: number;
  /** The weather's wind on the ground: its direction (unit) times its speed (0..1). */
  readonly wind: readonly [number, number];
}

/** The sun's shadow map and the cascades it holds (scene-renderer.ts). */
export interface VolumeShadows {
  readonly map: GPUTexture;
  readonly cascades: readonly { readonly viewProj: Mat4; readonly far: number }[];
}

interface VolumeTextures {
  readonly size: readonly [number, number, number];
  /** The generated froxels, this frame's and the last (they swap). */
  readonly froxels: [GPUTexture, GPUTexture];
  readonly gathered: GPUTexture;
  readonly blur: GPUTexture;
}

export class VolumetricVolume {
  /** [Display] iVolumetricLightingQuality (0 Low, 1 Medium, 2 High). */
  quality = 1;
  /** [Display] bVolumetricLightingEnableTemporalAccumulation. */
  temporal = true;
  readonly #device: GPUDevice;
  readonly #generate: GPUComputePipeline;
  readonly #raymarch: GPUComputePipeline;
  readonly #blurHorizontal: GPUComputePipeline;
  readonly #blurVertical: GPUComputePipeline;
  readonly #composite: GPURenderPipeline;
  readonly #uniforms: GPUBuffer;
  readonly #noise: GPUTexture;
  readonly #noiseSampler: GPUSampler;
  readonly #shadowSampler: GPUSampler;
  /** A 1×1 lit shadow map for frames without one. */
  readonly #noShadow: GPUTexture;
  #textures: VolumeTextures | undefined;
  #previousViewProj: Float32Array | undefined;
  readonly #noiseOffset: [number, number, number] = [0, 0, 0];
  #frame = 0;
  #lastTime: number | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: 'volumetric', code: volumetricShader });
    const compute = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `volumetric-${entryPoint}`,
        layout: 'auto',
        compute: { module, entryPoint },
      });
    this.#generate = compute('generate');
    this.#raymarch = compute('raymarch');
    this.#blurHorizontal = compute('blurHorizontal');
    this.#blurVertical = compute('blurVertical');
    this.#composite = device.createRenderPipeline({
      label: 'volumetric-composite',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_composite',
        targets: [
          {
            format: HDR_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.#uniforms = device.createBuffer({
      label: 'volumetric',
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#noise = device.createTexture({
      label: 'volumetric-noise',
      size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE],
      dimension: '3d',
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.#noise },
      densityNoise(),
      { bytesPerRow: NOISE_SIZE, rowsPerImage: NOISE_SIZE },
      [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE],
    );
    this.#noiseSampler = device.createSampler({
      label: 'volumetric-noise',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
    this.#shadowSampler = device.createSampler({
      label: 'volumetric-shadow',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.#noShadow = device.createTexture({
      label: 'volumetric-no-shadow',
      size: [1, 1, 2],
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** Forgets the last frame (a new place: nothing to blend with). */
  reset(): void {
    this.#previousViewProj = undefined;
  }

  /**
   * Generates the volume for this frame and adds it to `hdr`. `depth`: the opaque scene's
   * depth (r32float, reversed Z with an infinite far plane: near / distance); `viewProj`: the
   * camera's, without the TAA's jitter.
   */
  run(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    viewProj: Mat4,
    frame: VolumeFrame,
    shadows: VolumeShadows | undefined,
    now: number = performance.now(),
  ): void {
    const inverse = invert(viewProj);
    if (!inverse) return;
    const textures = this.#ensureTextures();
    const [width, height, slices] = textures.size;
    const dt = this.#lastTime === undefined ? 0 : Math.min(0.25, (now - this.#lastTime) / 1000);
    this.#lastTime = now;
    const drift = noiseDrift(
      dt,
      frame.densitySize,
      frame.windSpeed,
      frame.fallingSpeed,
      frame.wind,
      Math.random,
    );
    for (let i = 0; i < 3; i++) {
      // Kept within a span of noise tiles so the offset keeps its precision.
      const span = Math.max(1, frame.densitySize) * NOISE_SIZE;
      this.#noiseOffset[i] = ((this.#noiseOffset[i] ?? 0) + (drift[i] ?? 0)) % span;
    }
    const camera = column(inverse, [0, 0, viewProj[14] ?? 1, 0]);
    const cascades = shadows?.cascades.slice(0, 2) ?? [];
    const [lx, ly, lz] = frame.lightDirection;
    const length = Math.hypot(lx, ly, lz) || 1;
    const previous = this.temporal ? this.#previousViewProj : undefined;
    const data = new Float32Array(UNIFORM_FLOATS);
    data.set(inverse, 0);
    data.set(previous ?? viewProj, 16);
    data.set(cascades[0]?.viewProj ?? viewProj, 32);
    data.set(cascades[1]?.viewProj ?? viewProj, 48);
    data.set([camera[0], camera[1], camera[2], viewProj[14] ?? 1], 64);
    data.set([lx / length, ly / length, lz / length, frame.scattering], 68);
    data.set([width, height, slices, sliceJitter(this.#frame++)], 72);
    data.set(
      [
        this.#noiseOffset[0],
        this.#noiseOffset[1],
        this.#noiseOffset[2],
        1 / Math.max(1, frame.densitySize),
      ],
      76,
    );
    data.set(
      [
        Math.max(0, Math.min(1, frame.densityContribution)),
        Math.max(0, Math.min(1, frame.phaseContribution)),
        frame.rangeFactor > 0 ? frame.rangeFactor : 40,
        previous ? TEMPORAL_FACTOR : 0,
      ],
      80,
    );
    data.set(
      [cascades[0]?.far ?? 0, cascades[1]?.far ?? 0, shadows ? cascades.length : 0, SHADOW_BIAS],
      84,
    );
    data.set([...frame.color, frame.strength], 88);
    data.set([1 / depth.width, 1 / depth.height, 0, 0], 92);
    this.#device.queue.writeBuffer(this.#uniforms, 0, data);
    this.#previousViewProj ??= new Float32Array(16);
    this.#previousViewProj.set(viewProj);

    const [current, last] = textures.froxels;
    const uniforms: GPUBindGroupEntry = { binding: 0, resource: { buffer: this.#uniforms } };
    const group = (
      pipeline: GPUComputePipeline | GPURenderPipeline,
      entries: GPUBindGroupEntry[],
    ): GPUBindGroup =>
      this.#device.createBindGroup({
        label: 'volumetric',
        layout: pipeline.getBindGroupLayout(0),
        entries: [uniforms, ...entries],
      });
    const shadowMap = shadows && cascades.length > 0 ? shadows.map : this.#noShadow;
    const groupsX = Math.ceil(width / 8);
    const groupsY = Math.ceil(height / 8);
    const pass = encoder.beginComputePass({ label: 'volumetric' });
    pass.setPipeline(this.#generate);
    pass.setBindGroup(
      0,
      group(this.#generate, [
        { binding: 1, resource: this.#noise.createView() },
        { binding: 2, resource: this.#noiseSampler },
        { binding: 3, resource: shadowMap.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: this.#shadowSampler },
        { binding: 5, resource: last.createView() },
        { binding: 6, resource: current.createView() },
      ]),
    );
    pass.dispatchWorkgroups(groupsX, groupsY, slices);
    pass.setPipeline(this.#raymarch);
    pass.setBindGroup(
      0,
      group(this.#raymarch, [
        { binding: 7, resource: current.createView() },
        { binding: 8, resource: textures.gathered.createView() },
      ]),
    );
    pass.dispatchWorkgroups(groupsX, groupsY, 1);
    pass.setPipeline(this.#blurHorizontal);
    pass.setBindGroup(
      0,
      group(this.#blurHorizontal, [
        { binding: 9, resource: textures.gathered.createView() },
        { binding: 10, resource: textures.blur.createView() },
      ]),
    );
    pass.dispatchWorkgroups(groupsX, groupsY, slices);
    pass.setPipeline(this.#blurVertical);
    pass.setBindGroup(
      0,
      group(this.#blurVertical, [
        { binding: 9, resource: textures.blur.createView() },
        { binding: 10, resource: textures.gathered.createView() },
      ]),
    );
    pass.dispatchWorkgroups(groupsX, groupsY, slices);
    pass.end();
    textures.froxels.reverse();

    const add = encoder.beginRenderPass({
      label: 'volumetric-composite',
      colorAttachments: [{ view: hdr.createView(), loadOp: 'load', storeOp: 'store' }],
    });
    add.setPipeline(this.#composite);
    add.setBindGroup(
      0,
      group(this.#composite, [
        { binding: 11, resource: textures.gathered.createView() },
        { binding: 12, resource: depth.createView() },
      ]),
    );
    add.draw(3);
    add.end();
  }

  /** The volume's textures for the quality setting (made anew when it changes). */
  #ensureTextures(): VolumeTextures {
    const size = volumeSize(this.quality);
    const old = this.#textures;
    if (old?.size.every((v, i) => v === size[i])) return old;
    if (old) {
      for (const texture of [...old.froxels, old.gathered, old.blur]) texture.destroy();
    }
    this.#previousViewProj = undefined;
    const make = (label: string, format: GPUTextureFormat): GPUTexture =>
      this.#device.createTexture({
        label,
        size: [...size],
        dimension: '3d',
        format,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.#textures = {
      size,
      froxels: [make('volumetric-froxels-a', 'r32uint'), make('volumetric-froxels-b', 'r32uint')],
      gathered: make('volumetric-gathered', 'r32float'),
      blur: make('volumetric-blur', 'r32float'),
    };
    return this.#textures;
  }
}

/** A column-major matrix times a homogeneous vector, divided by its w. */
function column(m: Mat4, v: readonly [number, number, number, number]): Vec3 {
  const out = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    out[r] =
      (m[r] ?? 0) * v[0] +
      (m[4 + r] ?? 0) * v[1] +
      (m[8 + r] ?? 0) * v[2] +
      (m[12 + r] ?? 0) * v[3];
  }
  const w = out[3] ?? 1;
  return [(out[0] ?? 0) / w, (out[1] ?? 0) / w, (out[2] ?? 0) / w];
}
