// HDR post-processing: the scene is rendered into a half-float target, then eye adaptation,
// bloom, the tone curve and colour grading of the current imagespace turn it into the
// displayed image (shaders/post.wgsl, shaders/luminance.wgsl), and its depth of field blurs
// the distance (shaders/dof.wgsl). Image-space modifiers add a fade colour (in the grading)
// and screen effects after the depth of field: full-screen blur, double vision, radial blur
// and motion blur (shaders/screen-effects.wgsl).

import dofShader from './shaders/dof.wgsl?raw';
import luminanceShader from './shaders/luminance.wgsl?raw';
import postShader from './shaders/post.wgsl?raw';
import screenEffectsShader from './shaders/screen-effects.wgsl?raw';
import { blurWeights, doubleVisionOffset, motionBlurHistory, screenBlur } from './post-data.ts';
import {
  NEUTRAL_IMAGE_SPACE,
  type DepthOfFieldMode,
  type ImageSpace,
} from '../world/image-space.ts';

/** Format of the scene before post-processing. */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** Bloom is computed at a quarter of the resolution. */
const BLOOM_DIVISOR = 4;
/** The depth of field's blurred copy is made at half the resolution. */
const DOF_DIVISOR = 2;
const POST_FLOATS = 36;
const DOF_FLOATS = 16;
const EFFECT_FLOATS = 8;

/**
 * Rates of the two luminance averages per second. TODO(M13): the engine's exact mapping of
 * Eye Adapt Speed / Strength to the shader's rates is not documented; these follow the
 * values' ranges (speed 35–45, strength 5–8) with a time scale that adapts within seconds.
 */
const ADAPT_RATE_PER_UNIT = 0.1;

/** Uniform buffers of the post passes (see the constructor). */
const UNIFORM_BUFFERS = 9;
const SCREEN_BLUR_COPY = 6;
const SCREEN_BLUR_H = 7;
const SCREEN_BLUR_V = 8;

/** Which sides of the focus each depth of field mode blurs (front, back). */
const DOF_SIDES: Readonly<Record<DepthOfFieldMode, readonly [number, number]>> = {
  frontBack: [1, 1],
  front: [1, 0],
  back: [0, 1],
  none: [0, 0],
};

const SCREEN_ENTRIES = ['fs_copy', 'fs_mix', 'fs_double_vision', 'fs_radial_blur'] as const;
type ScreenEntry = (typeof SCREEN_ENTRIES)[number];

interface Targets {
  readonly width: number;
  readonly height: number;
  readonly hdr: GPUTexture;
  readonly bloomA: GPUTexture;
  readonly bloomB: GPUTexture;
  readonly bright: GPUBindGroup;
  readonly blurH: GPUBindGroup;
  readonly blurV: GPUBindGroup;
  readonly composite: GPUBindGroup;
  readonly luminance: GPUBindGroup;
  /** Depth of field: the graded image, its blurred copy (half size) and their bind groups. */
  readonly graded: GPUTexture;
  readonly dofA: GPUTexture;
  readonly dofB: GPUTexture;
  readonly dofDown: GPUBindGroup;
  readonly dofBlurH: GPUBindGroup;
  readonly dofBlurV: GPUBindGroup;
}

/** The screen effects' second full-size image and motion blur's two previous images. */
interface ScreenTargets {
  readonly effect: GPUTexture;
  /** Motion blur: last frame's image (read) and this frame's (written); swapped each frame. */
  history: [GPUTexture, GPUTexture];
  /** Whether history[0] holds last frame's image. */
  historyValid: boolean;
  /** Bind groups by uniform buffer and textures (they stay with the targets). */
  readonly groups: Map<string, GPUBindGroup>;
}

/**
 * Blur radius (pixels at half size) of an imagespace's depth of field blur radius 0..7 (the
 * engine picks blur shaders of 3 to 17 taps by it). TODO(M13): calibrate against the original.
 */
export function dofBlurPixels(radius: number): number {
  return 1 + Math.max(0, Math.min(7, Math.round(radius)));
}

export class PostProcessor {
  /** The player's brightness setting (fGamma): the gamma the final image is shown with. */
  gamma = 1;
  readonly #device: GPUDevice;
  readonly #outputFormat: GPUTextureFormat;
  readonly #layout: GPUBindGroupLayout;
  readonly #luminanceLayout: GPUBindGroupLayout;
  readonly #bright: GPURenderPipeline;
  readonly #blur: GPURenderPipeline;
  readonly #composite: GPURenderPipeline;
  /** The composite into the half-float image the depth of field reads. */
  readonly #compositeGraded: GPURenderPipeline;
  readonly #dof: GPURenderPipeline;
  /** The depth of field into the half-float image the screen effects go on with. */
  readonly #dofGraded: GPURenderPipeline;
  readonly #dofLayout: GPUBindGroupLayout;
  readonly #dofUniforms: GPUBuffer;
  readonly #dofData = new Float32Array(DOF_FLOATS);
  /** The depth of field's last bind group and the depth view it was made for. */
  #dofGroup: { readonly depth: GPUTextureView; readonly group: GPUBindGroup } | undefined;
  readonly #luminance: GPUComputePipeline;
  readonly #sampler: GPUSampler;
  /** Uniforms of the bright/composite pass, the blur passes and the screen blur's passes. */
  readonly #uniforms: GPUBuffer[];
  readonly #adaptation: GPUBuffer;
  readonly #adaptParams: GPUBuffer;
  readonly #data = new Float32Array(POST_FLOATS);
  /** Screen effects: pipelines by entry point into the half-float image and the output. */
  readonly #screenLayout: GPUBindGroupLayout;
  readonly #screenPipelines = new Map<string, GPURenderPipeline>();
  /** Uniforms of the screen effects: full-screen blur, double vision, radial and motion blur. */
  readonly #screenUniforms: {
    readonly blur: GPUBuffer;
    readonly doubleVision: GPUBuffer;
    readonly radial: GPUBuffer;
    readonly motion: GPUBuffer;
  };
  readonly #screenData = new Float32Array(EFFECT_FLOATS);
  #screen: ScreenTargets | undefined;
  #targets: Targets | undefined;
  #reset = true;
  /** Seconds of post-processing run (double vision sways with it). */
  #seconds = 0;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
    this.#outputFormat = outputFormat;
    this.#layout = device.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const module = device.createShaderModule({ label: 'post', code: postShader });
    const layout = device.createPipelineLayout({ label: 'post', bindGroupLayouts: [this.#layout] });
    const pipeline = (entryPoint: string, format: GPUTextureFormat): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `post-${entryPoint}`,
        layout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint, targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    this.#bright = pipeline('fs_bright', HDR_FORMAT);
    this.#blur = pipeline('fs_blur', HDR_FORMAT);
    this.#composite = pipeline('fs_composite', outputFormat);
    this.#compositeGraded = pipeline('fs_composite', HDR_FORMAT);
    this.#dofLayout = device.createBindGroupLayout({
      label: 'dof',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });
    const dofModule = device.createShaderModule({ label: 'dof', code: dofShader });
    const dofLayout = device.createPipelineLayout({
      label: 'dof',
      bindGroupLayouts: [this.#dofLayout],
    });
    const dofPipeline = (format: GPUTextureFormat): GPURenderPipeline =>
      device.createRenderPipeline({
        label: 'post-dof',
        layout: dofLayout,
        vertex: { module: dofModule, entryPoint: 'vs_fullscreen' },
        fragment: { module: dofModule, entryPoint: 'fs_dof', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    this.#dof = dofPipeline(outputFormat);
    this.#dofGraded = dofPipeline(HDR_FORMAT);
    this.#dofUniforms = device.createBuffer({
      label: 'dof-uniforms',
      size: DOF_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#screenLayout = device.createBindGroupLayout({
      label: 'screen-effects',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const screenModule = device.createShaderModule({
      label: 'screen-effects',
      code: screenEffectsShader,
    });
    const screenLayout = device.createPipelineLayout({
      label: 'screen-effects',
      bindGroupLayouts: [this.#screenLayout],
    });
    for (const entryPoint of SCREEN_ENTRIES) {
      for (const format of [HDR_FORMAT, outputFormat]) {
        this.#screenPipelines.set(
          `${entryPoint}:${format}`,
          device.createRenderPipeline({
            label: `screen-${entryPoint}`,
            layout: screenLayout,
            vertex: { module: screenModule, entryPoint: 'vs_fullscreen' },
            fragment: { module: screenModule, entryPoint, targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
          }),
        );
      }
    }
    const effectBuffer = (label: string): GPUBuffer =>
      device.createBuffer({
        label: `screen-${label}`,
        size: EFFECT_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.#screenUniforms = {
      blur: effectBuffer('blur'),
      doubleVision: effectBuffer('double-vision'),
      radial: effectBuffer('radial-blur'),
      motion: effectBuffer('motion-blur'),
    };

    this.#luminanceLayout = device.createBindGroupLayout({
      label: 'luminance',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      ],
    });
    this.#luminance = device.createComputePipeline({
      label: 'luminance',
      layout: device.createPipelineLayout({
        label: 'luminance',
        bindGroupLayouts: [this.#luminanceLayout],
      }),
      compute: {
        module: device.createShaderModule({ label: 'luminance', code: luminanceShader }),
        entryPoint: 'main',
      },
    });
    this.#sampler = device.createSampler({
      label: 'post',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    // 0-2: bright pass and bloom blurs; 3-5: the depth of field's copy and blurs; 6-8: the
    // screen blur's copy and blurs.
    this.#uniforms = Array.from({ length: UNIFORM_BUFFERS }, (_, i) =>
      device.createBuffer({
        label: `post-uniforms-${String(i)}`,
        size: POST_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );
    this.#adaptation = device.createBuffer({
      label: 'adaptation',
      size: 16,
      usage: GPUBufferUsage.STORAGE,
    });
    this.#adaptParams = device.createBuffer({
      label: 'adaptation-params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** The resolved scene: render passes resolve their multisampled colour into it. */
  hdrView(width: number, height: number): GPUTextureView {
    return this.#ensureTargets(width, height).hdr.createView();
  }

  /** The resolved scene texture (copied for the water shader). */
  hdrTexture(width: number, height: number): GPUTexture {
    return this.#ensureTargets(width, height).hdr;
  }

  /** Starts eye adaptation over (a new scene). */
  resetAdaptation(): void {
    this.#reset = true;
  }

  /**
   * Bloom, adaptation, tone curve, grading, depth of field and the modifiers' screen effects
   * from the HDR target into `output`. `depth`: the opaque scene's depth (r32float, reversed
   * Z) with the camera's near plane, for the depth of field.
   */
  run(
    encoder: GPUCommandEncoder,
    output: GPUTextureView,
    width: number,
    height: number,
    space: ImageSpace | undefined,
    deltaSeconds: number,
    depth?: { readonly view: GPUTextureView; readonly near: number },
  ): void {
    const targets = this.#ensureTargets(width, height);
    this.#seconds += deltaSeconds;
    const image = space ?? NEUTRAL_IMAGE_SPACE;
    const { hdr } = image;
    const adapt = space !== undefined && (hdr.eyeAdaptSpeed > 0 || hdr.eyeAdaptStrength > 0);
    const bloom = space !== undefined && hdr.bloomScale > 0 && hdr.receiveBloomThreshold > 0;
    const queue = this.#device.queue;

    const rate = (perUnit: number): number =>
      1 - Math.exp(-deltaSeconds * perUnit * ADAPT_RATE_PER_UNIT);
    queue.writeBuffer(
      this.#adaptParams,
      0,
      new Float32Array([
        rate(hdr.eyeAdaptSpeed),
        rate(hdr.eyeAdaptStrength),
        this.#reset ? 1 : 0,
        0,
      ]),
    );
    this.#reset = false;

    const effects = image.effects;
    const data = this.#data;
    data.fill(0);
    data.set(
      [bloom ? hdr.receiveBloomThreshold : 0, 1 / Math.max(hdr.white, 0.05) ** 2, adapt ? 1 : 0, 0],
      0,
    );
    data.set(
      [image.saturation, 1 / Math.max(this.gamma, 0.05), image.contrast, image.brightness],
      4,
    );
    data.set([...image.tintColor, image.tintAmount], 8);
    data.set(blurWeights(hdr.bloomBlurRadius), 16);
    data.set(effects ? [...effects.fadeColor, effects.fadeAmount] : [0, 0, 0, 0], 32);
    const bloomWidth = targets.bloomA.width;
    const bloomHeight = targets.bloomA.height;
    const write = (index: number, stepX: number, stepY: number): void => {
      data.set([hdr.bloomThreshold, hdr.bloomScale, stepX, stepY], 12);
      const buffer = this.#uniforms[index];
      if (buffer) queue.writeBuffer(buffer, 0, data);
    };
    write(0, 0, 0);
    write(1, 1 / bloomWidth, 0);
    write(2, 0, 1 / bloomHeight);
    // The copies' and blurs' passes: threshold 0, scale 1, the radius's taps at half size.
    const writeBlur = (first: number, pixels: number): void => {
      data.set(blurWeights(pixels), 16);
      const blurWrite = (index: number, stepX: number, stepY: number): void => {
        data.set([0, 1, stepX, stepY], 12);
        const buffer = this.#uniforms[index];
        if (buffer) queue.writeBuffer(buffer, 0, data);
      };
      blurWrite(first, 0, 0);
      blurWrite(first + 1, 1 / targets.dofA.width, 0);
      blurWrite(first + 2, 0, 1 / targets.dofA.height);
    };

    const field = image.depthOfField;
    const sides = DOF_SIDES[field.mode ?? 'back'];
    const dof =
      space !== undefined && depth !== undefined && field.strength > 0 && sides.some(Boolean);
    if (dof) {
      writeBlur(3, dofBlurPixels(field.blurRadius));
      this.#dofData.set([field.strength, field.distance, field.range, field.sky ? 1 : 0], 0);
      this.#dofData.set([1 / width, 1 / height, depth.near, 0], 4);
      const map = field.worldMap;
      this.#dofData.set(map ? [map.focal, map.maxBlur, map.scale, map.nearScale] : [0, 0, 0, 0], 8);
      this.#dofData.set([sides[0], sides[1], 0, 0], 12);
      queue.writeBuffer(this.#dofUniforms, 0, this.#dofData);
    }

    // The screen effects that act this frame, each from the image so far into the next.
    const blur = screenBlur(effects?.blurRadius ?? 0);
    const doubleVision = effects?.doubleVision ?? 0;
    const radial = effects && effects.radialBlur.strength > 0 ? effects.radialBlur : undefined;
    const motion = motionBlurHistory(effects?.motionBlur ?? 0, deltaSeconds);
    const screen = blur.amount > 0 || doubleVision > 0 || radial !== undefined || motion > 0;
    if (!(motion > 0) && this.#screen) this.#screen.historyValid = false;
    const writeEffect = (buffer: GPUBuffer, a: readonly number[], b: readonly number[] = []) => {
      this.#screenData.fill(0);
      this.#screenData.set(a, 0);
      this.#screenData.set(b, 4);
      queue.writeBuffer(buffer, 0, this.#screenData);
    };
    if (blur.amount > 0) {
      writeBlur(SCREEN_BLUR_COPY, blur.pixels);
      writeEffect(this.#screenUniforms.blur, [blur.amount]);
    }
    if (doubleVision > 0) {
      writeEffect(this.#screenUniforms.doubleVision, [
        ...doubleVisionOffset(doubleVision, this.#seconds),
        blur.amount > 0 ? 1 : 0,
      ]);
    }
    if (radial) {
      writeEffect(
        this.#screenUniforms.radial,
        [radial.strength, radial.rampUp, radial.start, radial.rampDown],
        [...radial.center, radial.downStart],
      );
    }

    const compute = encoder.beginComputePass({ label: 'luminance' });
    compute.setPipeline(this.#luminance);
    compute.setBindGroup(0, targets.luminance);
    compute.dispatchWorkgroups(1);
    compute.end();

    const pass = (
      label: string,
      view: GPUTextureView,
      pipeline: GPURenderPipeline,
      group: GPUBindGroup,
    ): void => {
      const render = encoder.beginRenderPass({
        label,
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      render.setPipeline(pipeline);
      render.setBindGroup(0, group);
      render.draw(3);
      render.end();
    };
    if (bloom) {
      pass('bloom-bright', targets.bloomA.createView(), this.#bright, targets.bright);
      pass('bloom-blur-h', targets.bloomB.createView(), this.#blur, targets.blurH);
      pass('bloom-blur-v', targets.bloomA.createView(), this.#blur, targets.blurV);
    } else {
      pass('bloom-clear', targets.bloomA.createView(), this.#bright, targets.bright);
    }
    if (!dof && !screen) {
      pass('composite', output, this.#composite, targets.composite);
      return;
    }
    pass('composite', targets.graded.createView(), this.#compositeGraded, targets.composite);

    // Each step reads `source` and writes the other full-size image, the last the output.
    type Step = (source: GPUTexture, target: GPUTextureView | undefined) => void;
    const steps: Step[] = [];
    if (dof) {
      steps.push((_source, target) => {
        // The depth of field comes first: its copy reads the graded image (the world map's
        // blur reads the graded image itself).
        if (!field.worldMap) {
          pass('dof-copy', targets.dofA.createView(), this.#bright, targets.dofDown);
          pass('dof-blur-h', targets.dofB.createView(), this.#blur, targets.dofBlurH);
          pass('dof-blur-v', targets.dofA.createView(), this.#blur, targets.dofBlurV);
        }
        pass(
          'dof',
          target ?? output,
          target ? this.#dofGraded : this.#dof,
          this.#dofBindGroup(targets, depth.view),
        );
      });
    }
    const screenTargets = screen ? this.#ensureScreen(targets) : undefined;
    const effectPass = (
      label: string,
      entry: ScreenEntry,
      target: GPUTextureView | undefined,
      buffer: GPUBuffer,
      source: GPUTexture,
      second: GPUTexture,
    ): void => {
      if (!screenTargets) return;
      const format = target ? HDR_FORMAT : this.#outputFormat;
      const pipeline = this.#screenPipelines.get(`${entry}:${format}`);
      if (!pipeline) return;
      pass(
        label,
        target ?? output,
        pipeline,
        this.#screenGroup(screenTargets, buffer, source, second),
      );
    };
    let blurred = false;
    if (blur.amount > 0) {
      steps.push((source, target) => {
        if (!screenTargets) return;
        // A blurred copy at half size, then the image turning into it.
        pass(
          'screen-blur-copy',
          targets.dofA.createView(),
          this.#bright,
          this.#postGroup(screenTargets, SCREEN_BLUR_COPY, source, targets.hdr),
        );
        pass(
          'screen-blur-h',
          targets.dofB.createView(),
          this.#blur,
          this.#postGroup(screenTargets, SCREEN_BLUR_H, targets.dofA, targets.hdr),
        );
        pass(
          'screen-blur-v',
          targets.dofA.createView(),
          this.#blur,
          this.#postGroup(screenTargets, SCREEN_BLUR_V, targets.dofB, targets.hdr),
        );
        effectPass(
          'screen-blur',
          'fs_mix',
          target,
          this.#screenUniforms.blur,
          source,
          targets.dofA,
        );
        blurred = true;
      });
    }
    if (doubleVision > 0) {
      steps.push((source, target) => {
        // The edges turn into the full-screen blur's copy (none without a blur).
        effectPass(
          'double-vision',
          'fs_double_vision',
          target,
          this.#screenUniforms.doubleVision,
          source,
          blurred ? targets.dofA : source,
        );
      });
    }
    if (radial) {
      steps.push((source, target) => {
        effectPass(
          'radial-blur',
          'fs_radial_blur',
          target,
          this.#screenUniforms.radial,
          source,
          source,
        );
      });
    }
    if (motion > 0 && screenTargets) {
      steps.push((source, target) => {
        // This frame keeps a share of the last one (none on its first frame), into the
        // history the next frame reads, then on to the output.
        const [previous, next] = screenTargets.history;
        writeEffect(this.#screenUniforms.motion, [screenTargets.historyValid ? motion : 0]);
        effectPass(
          'motion-blur',
          'fs_mix',
          next.createView(),
          this.#screenUniforms.motion,
          source,
          previous,
        );
        effectPass('motion-blur-out', 'fs_copy', target, this.#screenUniforms.motion, next, next);
        screenTargets.history = [next, previous];
        screenTargets.historyValid = true;
      });
    }

    let source = targets.graded;
    steps.forEach((step, i) => {
      const last = i === steps.length - 1;
      const next = source === targets.graded ? screenTargets?.effect : targets.graded;
      step(source, last || !next ? undefined : next.createView());
      if (!last && next) source = next;
    });
  }

  #dofBindGroup(targets: Targets, depth: GPUTextureView): GPUBindGroup {
    if (this.#dofGroup?.depth !== depth) {
      this.#dofGroup = {
        depth,
        group: this.#device.createBindGroup({
          label: 'dof',
          layout: this.#dofLayout,
          entries: [
            { binding: 0, resource: { buffer: this.#dofUniforms } },
            { binding: 1, resource: this.#sampler },
            { binding: 2, resource: targets.graded.createView() },
            { binding: 3, resource: targets.dofA.createView() },
            { binding: 4, resource: depth },
          ],
        }),
      };
    }
    return this.#dofGroup.group;
  }

  /** The screen effects' targets: made the first time a modifier needs them. */
  #ensureScreen(targets: Targets): ScreenTargets {
    if (this.#screen) return this.#screen;
    const texture = (label: string): GPUTexture =>
      this.#device.createTexture({
        label,
        size: [targets.width, targets.height],
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.#screen = {
      effect: texture('screen-effect'),
      history: [texture('motion-history-a'), texture('motion-history-b')],
      historyValid: false,
      groups: new Map(),
    };
    return this.#screen;
  }

  /** A bind group of the post shader (bright pass, blur) over other textures, kept. */
  #postGroup(
    screen: ScreenTargets,
    uniform: number,
    source: GPUTexture,
    bloom: GPUTexture,
  ): GPUBindGroup {
    const key = `post:${String(uniform)}:${source.label}:${bloom.label}`;
    let group = screen.groups.get(key);
    const buffer = this.#uniforms[uniform];
    if (!group && buffer) {
      group = this.#device.createBindGroup({
        label: 'post',
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: source.createView() },
          { binding: 3, resource: bloom.createView() },
          { binding: 4, resource: { buffer: this.#adaptation } },
        ],
      });
      screen.groups.set(key, group);
    }
    if (!group) throw new Error('post uniforms missing');
    return group;
  }

  /** A bind group of the screen effects' shader, kept with the targets. */
  #screenGroup(
    screen: ScreenTargets,
    buffer: GPUBuffer,
    image: GPUTexture,
    second: GPUTexture,
  ): GPUBindGroup {
    const key = `screen:${buffer.label}:${image.label}:${second.label}`;
    let group = screen.groups.get(key);
    if (!group) {
      group = this.#device.createBindGroup({
        label: 'screen-effects',
        layout: this.#screenLayout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: image.createView() },
          { binding: 3, resource: second.createView() },
        ],
      });
      screen.groups.set(key, group);
    }
    return group;
  }

  #ensureTargets(width: number, height: number): Targets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    this.#targets?.hdr.destroy();
    this.#targets?.bloomA.destroy();
    this.#targets?.bloomB.destroy();
    this.#targets?.graded.destroy();
    this.#targets?.dofA.destroy();
    this.#targets?.dofB.destroy();
    this.#screen?.effect.destroy();
    for (const texture of this.#screen?.history ?? []) texture.destroy();
    this.#screen = undefined;
    this.#dofGroup = undefined;
    const device = this.#device;
    const texture = (label: string, w: number, h: number): GPUTexture =>
      device.createTexture({
        label,
        size: [Math.max(1, w), Math.max(1, h)],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
    // COPY_DST: the temporal anti-aliasing copies its result back into it (taa.ts).
    const hdr = texture('hdr', width, height);
    const bloomA = texture(
      'bloom-a',
      Math.ceil(width / BLOOM_DIVISOR),
      Math.ceil(height / BLOOM_DIVISOR),
    );
    const bloomB = texture('bloom-b', bloomA.width, bloomA.height);
    const graded = texture('graded', width, height);
    const dofA = texture('dof-a', Math.ceil(width / DOF_DIVISOR), Math.ceil(height / DOF_DIVISOR));
    const dofB = texture('dof-b', dofA.width, dofA.height);
    const group = (uniform: number, source: GPUTexture, bloom: GPUTexture): GPUBindGroup => {
      const buffer = this.#uniforms[uniform];
      if (!buffer) throw new Error('post uniforms missing');
      return device.createBindGroup({
        label: 'post',
        layout: this.#layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: source.createView() },
          { binding: 3, resource: bloom.createView() },
          { binding: 4, resource: { buffer: this.#adaptation } },
        ],
      });
    };
    this.#targets = {
      width,
      height,
      hdr,
      bloomA,
      bloomB,
      // A pass never samples the texture it renders into (the unused bloom slot gets hdr).
      bright: group(0, hdr, bloomB),
      blurH: group(1, bloomA, hdr),
      blurV: group(2, bloomB, hdr),
      composite: group(0, hdr, bloomA),
      graded,
      dofA,
      dofB,
      dofDown: group(3, graded, hdr),
      dofBlurH: group(4, dofA, hdr),
      dofBlurV: group(5, dofB, hdr),
      luminance: device.createBindGroup({
        label: 'luminance',
        layout: this.#luminanceLayout,
        entries: [
          { binding: 0, resource: hdr.createView() },
          { binding: 1, resource: { buffer: this.#adaptation } },
          { binding: 2, resource: { buffer: this.#adaptParams } },
        ],
      }),
    };
    return this.#targets;
  }
}
