// The weather's volumetric lighting as the original scatters it: a froxel volume over the view
// (shaders/volumetric.wgsl), generated each frame from the sun's shadow cascades and a drifting
// density noise, summed slice by slice from the camera, read by each pixel's depth and blended
// with the last frame's reading there, blurred across the screen and added to the HDR scene
// (docs/rendering.md, "Volumetric lighting").

import volumetricShader from './shaders/volumetric.wgsl?raw';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';
import { invert } from './frustum.ts';
import {
  compositeScale,
  densityNoise,
  ditherNoise,
  noiseDrift,
  volumeSize,
  DITHER_SIZE,
  JITTER_FRAMES,
  NOISE_SCALE,
  NOISE_SIZE,
  TEMPORAL_FACTOR,
} from './volumetric-data.ts';
import type { Rgb } from '../world/weather.ts';

type Vec3 = readonly [number, number, number];

/** The screen targets' format: the amount (r) and its depth (g). */
const SCREEN_FORMAT: GPUTextureFormat = 'rg16float';
/** The uniforms: four matrices (64 floats) and eight vectors. */
const UNIFORM_FLOATS = 96;
/**
 * The first cascade's depth bias in the volume (as the scene's, frame.wgsl shadowParams.z); the
 * second's lookup is not biased (observed in the original).
 */
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

/** The volume's passes, in the order they run (the GPU profile's entries). */
export const VOLUME_PASSES = ['generate', 'raymarch', 'composite', 'blur', 'apply'] as const;
export type VolumePass = (typeof VOLUME_PASSES)[number];

interface VolumeTextures {
  readonly size: readonly [number, number, number];
  readonly froxels: GPUTexture;
  readonly gathered: GPUTexture;
  /** The bind group that stays with these textures. */
  readonly raymarch: GPUBindGroup;
  /** That which also holds a texture of the frame: made again when it changes. */
  generate: CachedGroup | undefined;
}

/** The screen-sized targets (rg16float: the amount, its depth as VOLUME_NEAR / distance). */
interface ScreenTextures {
  readonly width: number;
  readonly height: number;
  /** The composite, this frame's and the last (they swap: the temporal blend's history). */
  readonly composite: [GPUTexture, GPUTexture];
  /** The horizontal blur's result. */
  readonly blurred: GPUTexture;
  readonly blur: [GPUBindGroup, GPUBindGroup];
  readonly apply: GPUBindGroup;
  /** The composite's groups by which texture is this frame's (they hold the scene's depth). */
  composite0: CachedGroup | undefined;
  composite1: CachedGroup | undefined;
}

interface CachedGroup {
  readonly source: GPUTexture;
  readonly group: GPUBindGroup;
}

/**
 * The volume's GPU time per pass (timestamp queries, where the device has them): the passes
 * write their begin and end, a resolved copy is read back a frame later, and each pass's time
 * is smoothed over frames (milliseconds).
 */
class VolumeProfiler {
  readonly timings: Record<VolumePass, number> = {
    generate: 0,
    raymarch: 0,
    composite: 0,
    blur: 0,
    apply: 0,
  };
  readonly #querySet: GPUQuerySet;
  readonly #resolve: GPUBuffer;
  readonly #free: GPUBuffer[];
  #written: GPUBuffer | undefined;

  constructor(device: GPUDevice) {
    const count = VOLUME_PASSES.length * 2;
    this.#querySet = device.createQuerySet({ label: 'volumetric', type: 'timestamp', count });
    this.#resolve = device.createBuffer({
      label: 'volumetric-timestamps',
      size: count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.#free = Array.from({ length: 3 }, () =>
      device.createBuffer({
        label: 'volumetric-timestamps-read',
        size: count * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
    );
  }

  /** Reads back the last frame's times (its commands have been submitted by now). */
  collect(): void {
    const buffer = this.#written;
    if (!buffer) return;
    this.#written = undefined;
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const stamps = new BigInt64Array(buffer.getMappedRange());
        VOLUME_PASSES.forEach((pass, i) => {
          const ns = Number((stamps[i * 2 + 1] ?? 0n) - (stamps[i * 2] ?? 0n));
          if (ns > 0 && ns < 1e9) this.timings[pass] = this.timings[pass] * 0.9 + (ns / 1e6) * 0.1;
        });
        buffer.unmap();
        this.#free.push(buffer);
      },
      () => {
        this.#free.push(buffer);
      },
    );
  }

  /** A pass's timestamp writes this frame (undefined: no read-back buffer free). */
  writes(pass: VolumePass): GPUComputePassTimestampWrites | undefined {
    if (this.#free.length === 0) return undefined;
    const index = VOLUME_PASSES.indexOf(pass);
    return {
      querySet: this.#querySet,
      beginningOfPassWriteIndex: index * 2,
      endOfPassWriteIndex: index * 2 + 1,
    };
  }

  /** Copies this frame's timestamps out for the read-back. */
  resolve(encoder: GPUCommandEncoder): void {
    const buffer = this.#free.pop();
    if (!buffer) return;
    encoder.resolveQuerySet(this.#querySet, 0, VOLUME_PASSES.length * 2, this.#resolve, 0);
    encoder.copyBufferToBuffer(this.#resolve, 0, buffer, 0, buffer.size);
    this.#written = buffer;
  }
}

export class VolumetricVolume {
  /** [Display] iVolumetricLightingQuality (0 Low, 1 Medium, 2 High). */
  quality = 1;
  /** [Display] bVolumetricLightingEnableTemporalAccumulation. */
  temporal = true;
  /**
   * Measures the passes' GPU time into `timings` (development: engineDev.renderer.sunEffects
   * .volume); only where the device has timestamp queries.
   */
  profile = false;
  readonly #device: GPUDevice;
  readonly #generate: GPUComputePipeline;
  readonly #raymarch: GPUComputePipeline;
  readonly #composite: GPURenderPipeline;
  readonly #blur: GPURenderPipeline;
  readonly #apply: GPURenderPipeline;
  /** The composite reads the volume with one filtered sample (float32-filterable). */
  readonly #filtered: boolean;
  readonly #uniforms: GPUBuffer;
  readonly #uniformData = new Float32Array(UNIFORM_FLOATS);
  readonly #noise: GPUTexture;
  readonly #noiseSampler: GPUSampler;
  readonly #dither: GPUTexture;
  readonly #historySampler: GPUSampler;
  readonly #shadowSampler: GPUSampler;
  readonly #volumeSampler: GPUSampler;
  /** A 1×1 lit shadow map for frames without one. */
  readonly #noShadow: GPUTexture;
  #textures: VolumeTextures | undefined;
  #screen: ScreenTextures | undefined;
  #profiler: VolumeProfiler | undefined;
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
    this.#filtered = device.features.has('float32-filterable');
    const screen = (entryPoint: string, target: GPUColorTargetState): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `volumetric-${entryPoint}`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint, targets: [target] },
        primitive: { topology: 'triangle-list' },
      });
    this.#composite = screen(this.#filtered ? 'fs_compositeFiltered' : 'fs_composite', {
      format: SCREEN_FORMAT,
    });
    this.#blur = screen('fs_blur', { format: SCREEN_FORMAT });
    this.#apply = screen('fs_apply', {
      format: HDR_FORMAT,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
      },
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
    this.#dither = device.createTexture({
      label: 'volumetric-dither',
      size: [DITHER_SIZE, DITHER_SIZE],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.#dither },
      ditherNoise(),
      { bytesPerRow: DITHER_SIZE },
      [DITHER_SIZE, DITHER_SIZE],
    );
    this.#historySampler = device.createSampler({
      label: 'volumetric-history',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.#shadowSampler = device.createSampler({
      label: 'volumetric-shadow',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.#volumeSampler = device.createSampler({
      label: 'volumetric-volume',
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

  /** The passes' GPU times in milliseconds (zeros until `profile` has run a few frames). */
  get timings(): Readonly<Record<VolumePass, number>> | undefined {
    return this.#profiler?.timings;
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
    const screen = this.#ensureScreen(hdr.width, hdr.height);
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
    const densitySize = Math.max(1, frame.densitySize);
    for (let i = 0; i < 3; i++) {
      // Kept within a span of noise tiles so the offset keeps its precision.
      const span = (densitySize / NOISE_SCALE) * NOISE_SIZE;
      this.#noiseOffset[i] = ((this.#noiseOffset[i] ?? 0) + (drift[i] ?? 0)) % span;
    }
    const camera = column(inverse, [0, 0, viewProj[14] ?? 1, 0]);
    const cascades = shadows?.cascades.slice(0, 2) ?? [];
    const [lx, ly, lz] = frame.lightDirection;
    const length = Math.hypot(lx, ly, lz) || 1;
    const previous = this.temporal ? this.#previousViewProj : undefined;
    const data = this.#uniformData;
    data.set(inverse, 0);
    data.set(previous ?? viewProj, 16);
    data.set(cascades[0]?.viewProj ?? viewProj, 32);
    data.set(cascades[1]?.viewProj ?? viewProj, 48);
    data.set([camera[0], camera[1], camera[2], viewProj[14] ?? 1], 64);
    data.set([lx / length, ly / length, lz / length, frame.scattering], 68);
    data.set([width, height, slices, this.#frame++ % JITTER_FRAMES], 72);
    data.set(
      [this.#noiseOffset[0], this.#noiseOffset[1], this.#noiseOffset[2], NOISE_SCALE / densitySize],
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
    data.set([...frame.color, compositeScale(frame.strength, slices)], 88);
    data.set([1 / depth.width, 1 / depth.height, 0, 0], 92);
    this.#device.queue.writeBuffer(this.#uniforms, 0, data);
    this.#previousViewProj ??= new Float32Array(16);
    this.#previousViewProj.set(viewProj);

    // The profile: last frame's times read back, this frame's passes stamped.
    if (this.profile && this.#device.features.has('timestamp-query')) {
      this.#profiler ??= new VolumeProfiler(this.#device);
    }
    const profiler = this.profile ? this.#profiler : undefined;
    profiler?.collect();
    const stamps = (pass: VolumePass): { timestampWrites?: GPUComputePassTimestampWrites } => {
      const writes = profiler?.writes(pass);
      return writes ? { timestampWrites: writes } : {};
    };

    const shadowMap = shadows && cascades.length > 0 ? shadows.map : this.#noShadow;
    const groupsX = Math.ceil(width / 8);
    const groupsY = Math.ceil(height / 8);
    const compute = (
      pass: VolumePass,
      pipeline: GPUComputePipeline,
      group: GPUBindGroup,
      z: number,
    ): void => {
      const computePass = encoder.beginComputePass({
        label: `volumetric-${pass}`,
        ...stamps(pass),
      });
      computePass.setPipeline(pipeline);
      computePass.setBindGroup(0, group);
      computePass.dispatchWorkgroups(groupsX, groupsY, z);
      computePass.end();
    };
    compute('generate', this.#generate, this.#generateGroup(textures, shadowMap), slices);
    compute('raymarch', this.#raymarch, textures.raymarch, 1);

    // The composite into this frame's screen target, the last frame's its history; then the
    // blur across, and the blur down added to the scene.
    const current = this.#frame % 2;
    const draw = (
      pass: VolumePass,
      pipeline: GPURenderPipeline,
      group: GPUBindGroup,
      target: GPUTexture,
      load: GPULoadOp,
    ): void => {
      const render = encoder.beginRenderPass({
        label: `volumetric-${pass}`,
        colorAttachments: [{ view: target.createView(), loadOp: load, storeOp: 'store' }],
        ...stamps(pass),
      });
      render.setPipeline(pipeline);
      render.setBindGroup(0, group);
      render.draw(3);
      render.end();
    };
    const target = screen.composite[current] ?? screen.composite[0];
    draw(
      'composite',
      this.#composite,
      this.#compositeGroup(screen, textures, depth, current),
      target,
      'clear',
    );
    draw('blur', this.#blur, screen.blur[current] ?? screen.blur[0], screen.blurred, 'clear');
    draw('apply', this.#apply, screen.apply, hdr, 'load');
    if (profiler) profiler.resolve(encoder);
  }

  #group(
    pipeline: GPUComputePipeline | GPURenderPipeline,
    entries: GPUBindGroupEntry[],
  ): GPUBindGroup {
    return this.#device.createBindGroup({
      label: 'volumetric',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#uniforms } }, ...entries],
    });
  }

  /** The generate pass's group: the froxels written, the noise and the shadows. */
  #generateGroup(textures: VolumeTextures, shadowMap: GPUTexture): GPUBindGroup {
    const cached = textures.generate;
    if (cached?.source === shadowMap) return cached.group;
    const group = this.#group(this.#generate, [
      { binding: 1, resource: this.#noise.createView() },
      { binding: 2, resource: this.#noiseSampler },
      { binding: 3, resource: shadowMap.createView({ dimension: '2d-array' }) },
      { binding: 4, resource: this.#shadowSampler },
      { binding: 6, resource: textures.froxels.createView() },
    ]);
    textures.generate = { source: shadowMap, group };
    return group;
  }

  /**
   * The composite's group: the summed volume, the scene's depth, the last frame's composite
   * (the other screen target) and the dither.
   */
  #compositeGroup(
    screen: ScreenTextures,
    textures: VolumeTextures,
    depth: GPUTexture,
    current: number,
  ): GPUBindGroup {
    const cached = current === 0 ? screen.composite0 : screen.composite1;
    if (cached?.source === depth) return cached.group;
    const history = screen.composite[1 - current] ?? screen.composite[1];
    const group = this.#group(this.#composite, [
      { binding: 11, resource: textures.gathered.createView() },
      { binding: 12, resource: depth.createView() },
      ...(this.#filtered ? [{ binding: 13, resource: this.#volumeSampler }] : []),
      { binding: 14, resource: history.createView() },
      { binding: 15, resource: this.#historySampler },
      { binding: 16, resource: this.#dither.createView() },
    ]);
    if (current === 0) screen.composite0 = { source: depth, group };
    else screen.composite1 = { source: depth, group };
    return group;
  }

  /** The screen targets at the scene's size (made anew when it changes). */
  #ensureScreen(width: number, height: number): ScreenTextures {
    const old = this.#screen;
    if (old?.width === width && old.height === height) return old;
    if (old) {
      for (const texture of [...old.composite, old.blurred]) texture.destroy();
    }
    // A new size has no history to blend with.
    this.#previousViewProj = undefined;
    const make = (label: string): GPUTexture =>
      this.#device.createTexture({
        label,
        size: [width, height],
        format: SCREEN_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    const composite: [GPUTexture, GPUTexture] = [
      make('volumetric-composite-a'),
      make('volumetric-composite-b'),
    ];
    const blurred = make('volumetric-blurred');
    // The blur across reads no uniforms (its group holds the source alone).
    const blur = (source: GPUTexture): GPUBindGroup =>
      this.#device.createBindGroup({
        label: 'volumetric-blur',
        layout: this.#blur.getBindGroupLayout(0),
        entries: [{ binding: 17, resource: source.createView() }],
      });
    this.#screen = {
      width,
      height,
      composite,
      blurred,
      blur: [blur(composite[0]), blur(composite[1])],
      apply: this.#group(this.#apply, [{ binding: 17, resource: blurred.createView() }]),
      composite0: undefined,
      composite1: undefined,
    };
    return this.#screen;
  }

  /** The volume's textures for the quality setting (made anew when it changes). */
  #ensureTextures(): VolumeTextures {
    const size = volumeSize(this.quality);
    const old = this.#textures;
    if (old?.size.every((v, i) => v === size[i])) return old;
    if (old) {
      for (const texture of [old.froxels, old.gathered]) texture.destroy();
    }
    this.#previousViewProj = undefined;
    const make = (label: string): GPUTexture =>
      this.#device.createTexture({
        label,
        size: [...size],
        dimension: '3d',
        format: 'r32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    const froxels = make('volumetric-froxels');
    const gathered = make('volumetric-gathered');
    this.#textures = {
      size,
      froxels,
      gathered,
      raymarch: this.#group(this.#raymarch, [
        { binding: 7, resource: froxels.createView() },
        { binding: 8, resource: gathered.createView() },
      ]),
      generate: undefined,
    };
    // The screen targets' composite groups hold the old volume.
    if (this.#screen) {
      this.#screen.composite0 = undefined;
      this.#screen.composite1 = undefined;
    }
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
