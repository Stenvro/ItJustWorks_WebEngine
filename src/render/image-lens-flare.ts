// The image-based lens flare of bright lights ([Display] bIBLFEnable), as the original draws it
// over the HDR scene: the passes, targets and settings are in image-lens-flare-data.ts, the
// shaders in shaders/image-lens-flare.wgsl. Runs in exteriors and interiors alike (the original
// has no list of lights for it: bright pixels feed it).

import shader from './shaders/image-lens-flare.wgsl?raw';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';
import {
  DOWNSAMPLE_TAPS,
  IMAGE_LENS_FLARE_DEFAULTS,
  STREAK_ITERATIONS,
  blurTaps,
  bloomTaps,
  imageLensFlareSizes,
  type BlurTap,
  type ImageLensFlareSettings,
} from './image-lens-flare-data.ts';

/** A pass's uniforms: params and 15 taps (vec4 each), one 256-byte slot. */
const SLOT_BYTES = 256;
const SLOT_FLOATS = SLOT_BYTES / 4;
/** The most passes a frame draws with their own uniforms. */
const MAX_SLOTS = 5 + 2 + 4 * STREAK_ITERATIONS;

type Size = readonly [number, number];

interface Targets {
  readonly width: number;
  readonly height: number;
  /** Quarter size: the first downsample (ping, pong), the lights filter, the bloom's swap, the sum. */
  readonly quarter: readonly [GPUTexture, GPUTexture];
  readonly filter: GPUTexture;
  readonly bloomSwap: GPUTexture;
  readonly sum: GPUTexture;
  /** 16 × 4: the second downsample (ping, pong), the near streaks and their swap. */
  readonly near: readonly [GPUTexture, GPUTexture];
  readonly nearBlur: GPUTexture;
  readonly nearSwap: GPUTexture;
  /** 32 × 4: the third downsample (ping, pong), the far streaks and their swap. */
  readonly far: readonly [GPUTexture, GPUTexture];
  readonly farBlur: GPUTexture;
  readonly farSwap: GPUTexture;
}

/** What the passes know of the frame's motion (the TAA's targets; none without TAA). */
export interface ImageLensFlareMotion {
  /** Moving draws' motion vectors (taa-data.ts VELOCITY_FORMAT). */
  readonly velocity: GPUTexture;
  /** This frame's clip space to the last frame's (none: no last frame). */
  readonly reproject: Mat4 | undefined;
}

export class ImageLensFlare {
  /** The [Display] settings (main.ts sets them from the INI). */
  settings: ImageLensFlareSettings = IMAGE_LENS_FLARE_DEFAULTS;
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #downsample: GPURenderPipeline;
  readonly #filter: GPURenderPipeline;
  readonly #blur: GPURenderPipeline;
  readonly #add: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #passes: GPUBuffer;
  readonly #frame: GPUBuffer;
  readonly #data = new Float32Array(MAX_SLOTS * SLOT_FLOATS);
  readonly #frameData = new Float32Array(20);
  readonly #blank: GPUTexture;
  readonly #blankDepth: GPUTexture;
  #targets: Targets | undefined;
  #frameIndex = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    const fragment = GPUShaderStage.FRAGMENT;
    this.#layout = device.createBindGroupLayout({
      label: 'image-lens-flare',
      entries: [
        {
          binding: 0,
          visibility: fragment,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SLOT_BYTES },
        },
        { binding: 1, visibility: fragment, sampler: { type: 'filtering' } },
        { binding: 2, visibility: fragment, texture: { sampleType: 'float' } },
        { binding: 3, visibility: fragment, texture: { sampleType: 'float' } },
        { binding: 4, visibility: fragment, texture: { sampleType: 'float' } },
        { binding: 5, visibility: fragment, texture: { sampleType: 'unfilterable-float' } },
        { binding: 6, visibility: fragment, buffer: { type: 'uniform' } },
      ],
    });
    const module = device.createShaderModule({ label: 'image-lens-flare', code: shader });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
    const pipeline = (entryPoint: string, additive: boolean): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `image-lens-flare-${entryPoint}`,
        layout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: {
          module,
          entryPoint,
          targets: [
            additive
              ? {
                  format: HDR_FORMAT,
                  blend: {
                    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                  },
                }
              : { format: HDR_FORMAT },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });
    this.#downsample = pipeline('fs_downsample', false);
    this.#filter = pipeline('fs_filter', false);
    this.#blur = pipeline('fs_blur', false);
    this.#add = pipeline('fs_add', true);
    this.#sampler = device.createSampler({
      label: 'image-lens-flare',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.#passes = device.createBuffer({
      label: 'image-lens-flare-passes',
      size: this.#data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#frame = device.createBuffer({
      label: 'image-lens-flare-frame',
      size: this.#frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const blank = (format: GPUTextureFormat): GPUTexture =>
      device.createTexture({
        label: 'image-lens-flare-blank',
        size: [1, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
    this.#blank = blank(HDR_FORMAT);
    this.#blankDepth = blank('r32float');
  }

  /** Forgets the temporal history (a new view, a cut). */
  reset(): void {
    const t = this.#targets;
    if (!t) return;
    for (const texture of [...t.quarter, ...t.near, ...t.far]) texture.destroy();
    for (const texture of [t.filter, t.bloomSwap, t.sum, t.nearBlur, t.nearSwap]) texture.destroy();
    t.farBlur.destroy();
    t.farSwap.destroy();
    this.#targets = undefined;
  }

  /**
   * Draws the flare of `hdr`'s bright pixels and adds it to `hdr`. `depth`: the opaque scene's
   * depth (r32float); `motion`: the TAA's motion vectors and reprojection, if it ran.
   */
  run(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    motion: ImageLensFlareMotion | undefined,
  ): void {
    const s = this.settings;
    if (!s.enabled) return;
    const t = this.#ensure(hdr.width, hdr.height);
    // This frame's ping or pong target and the last frame's.
    const even = this.#frameIndex % 2 === 0;
    this.#frameIndex++;
    const swap = (pair: readonly [GPUTexture, GPUTexture]): readonly [GPUTexture, GPUTexture] =>
      even ? pair : [pair[1], pair[0]];
    const [quarter, quarterLast] = swap(t.quarter);
    const [nearDown, nearLast] = swap(t.near);
    const [farDown, farLast] = swap(t.far);

    const frame = this.#frameData;
    frame.fill(0);
    if (motion?.reproject) {
      frame.set(motion.reproject, 0);
      frame[16] = 1;
    }
    this.#device.queue.writeBuffer(this.#frame, 0, frame);

    const data = this.#data;
    data.fill(0);
    let slot = 0;
    const velocity = motion?.velocity ?? this.#blank;
    const draw = (
      pipeline: GPURenderPipeline,
      source: GPUTexture,
      target: GPUTexture,
      write: (at: number) => void,
      history: GPUTexture = this.#blank,
      load: GPULoadOp = 'clear',
    ): void => {
      const at = slot * SLOT_FLOATS;
      write(at);
      const group = this.#device.createBindGroup({
        label: 'image-lens-flare',
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer: this.#passes, size: SLOT_BYTES } },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: source.createView() },
          { binding: 3, resource: history.createView() },
          { binding: 4, resource: velocity.createView() },
          { binding: 5, resource: (motion ? depth : this.#blankDepth).createView() },
          { binding: 6, resource: { buffer: this.#frame } },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: 'image-lens-flare',
        colorAttachments: [
          {
            view: target.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: load,
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group, [pipeline === this.#add ? 0 : slot * SLOT_BYTES]);
      pass.draw(3);
      pass.end();
      if (pipeline !== this.#add) slot++;
    };
    const downsample =
      (sourceSize: Size, taps: readonly (readonly [number, number])[]) =>
      (at: number): void => {
        data.set([1 / sourceSize[0], 1 / sourceSize[1], taps.length, 1], at);
        taps.forEach(([x, y], i) => {
          data.set([x / sourceSize[0], y / sourceSize[1]], at + 4 + i * 4);
        });
      };
    const filter =
      (downshift: number, repeat: number, sourceWidth: number) =>
      (at: number): void => {
        data.set([downshift, repeat, 1 / sourceWidth, s.intensity], at);
      };
    // A blur's taps along x or y, each weight times the pass's strength.
    const blur =
      (taps: readonly BlurTap[], step: number, axis: 0 | 1, strength: number) =>
      (at: number): void => {
        data[at] = taps.length;
        taps.forEach((tap, i) => {
          const o = at + 4 + i * 4;
          data[o + axis] = tap.offset * step;
          data[o + 2] = tap.weight * strength;
        });
      };
    const sizes = imageLensFlareSizes(hdr.width, hdr.height);

    // The scene to a quarter, the lights filter, then across to 16 × 4 and 32 × 4.
    draw(
      this.#downsample,
      hdr,
      quarter,
      downsample([hdr.width, hdr.height], DOWNSAMPLE_TAPS.quarter),
      quarterLast,
    );
    draw(this.#filter, quarter, t.filter, filter(s.downshift, 0, sizes.quarter[0]));
    draw(
      this.#downsample,
      t.filter,
      nearDown,
      downsample(sizes.quarter, DOWNSAMPLE_TAPS.near),
      nearLast,
    );
    draw(this.#filter, nearDown, t.nearBlur, filter(0, s.lateralRepeat, sizes.near[0]));
    draw(
      this.#downsample,
      t.nearBlur,
      farDown,
      downsample(sizes.near, DOWNSAMPLE_TAPS.far),
      farLast,
    );

    // The bloom of the lights filter, across then down (the original steps the downward pass
    // by its source's width, not its height). TODO(M13): its targets' sizes are inferred (a
    // quarter); the original's second bloom, of the sum's 16 × 16 downsample, is black with
    // its compute downsample (the default), and is not drawn.
    const bloom = s.bloomIntensity > 0;
    if (bloom) {
      const taps = bloomTaps(s.bloomRadius);
      const strength = Math.sqrt(s.bloomIntensity);
      draw(this.#blur, t.filter, t.bloomSwap, blur(taps, 1 / sizes.quarter[0], 0, strength));
      draw(this.#blur, t.bloomSwap, t.sum, blur(taps, 1 / sizes.quarter[0], 1, strength));
    }

    // The streaks: three times across and down (near), down and across (far).
    const across = blurTaps(s.blurRadiusX);
    const down = blurTaps(s.blurRadiusY);
    const near = Math.sqrt(s.anamorphics);
    const far = Math.sqrt(s.anamorphicsFar);
    for (let i = 0; i < STREAK_ITERATIONS; i++) {
      if (across.length > 0) {
        draw(this.#blur, t.nearBlur, t.nearSwap, blur(across, 1 / sizes.near[0], 0, near));
      }
      if (down.length > 0) {
        draw(this.#blur, t.nearSwap, t.nearBlur, blur(down, 1 / sizes.near[1], 1, near));
      }
    }
    for (let i = 0; i < STREAK_ITERATIONS; i++) {
      if (down.length > 0) {
        const source = i === 0 ? farDown : t.farSwap;
        draw(this.#blur, source, t.farBlur, blur(down, 1 / sizes.far[1], 1, far));
      }
      if (across.length > 0) {
        draw(this.#blur, t.farBlur, t.farSwap, blur(across, 1 / sizes.far[0], 0, far));
      }
    }

    // The far streaks onto the near, those onto the bloom, the sum onto the scene.
    this.#device.queue.writeBuffer(this.#passes, 0, data, 0, slot * SLOT_FLOATS);
    const none = (): void => undefined;
    draw(this.#add, t.farSwap, t.nearBlur, none, this.#blank, 'load');
    draw(this.#add, t.nearBlur, t.sum, none, this.#blank, bloom ? 'load' : 'clear');
    draw(this.#add, t.sum, hdr, none, this.#blank, 'load');
  }

  #ensure(width: number, height: number): Targets {
    const t = this.#targets;
    if (t?.width === width && t.height === height) return t;
    this.reset();
    const sizes = imageLensFlareSizes(width, height);
    const target = (size: Size, label: string): GPUTexture =>
      this.#device.createTexture({
        label: `image-lens-flare-${label}`,
        size: [size[0], size[1]],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    const created: Targets = {
      width,
      height,
      quarter: [target(sizes.quarter, 'quarter-0'), target(sizes.quarter, 'quarter-1')],
      filter: target(sizes.quarter, 'filter'),
      bloomSwap: target(sizes.quarter, 'bloom-swap'),
      sum: target(sizes.quarter, 'sum'),
      near: [target(sizes.near, 'near-0'), target(sizes.near, 'near-1')],
      nearBlur: target(sizes.near, 'near-blur'),
      nearSwap: target(sizes.near, 'near-swap'),
      far: [target(sizes.far, 'far-0'), target(sizes.far, 'far-1')],
      farBlur: target(sizes.far, 'far-blur'),
      farSwap: target(sizes.far, 'far-swap'),
    };
    this.#targets = created;
    return created;
  }
}
