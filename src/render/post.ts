// HDR post-processing: the scene is rendered into a half-float target, then eye adaptation,
// bloom, the tone curve and colour grading of the current imagespace turn it into the
// displayed image (shaders/post.wgsl, shaders/luminance.wgsl).

import luminanceShader from './shaders/luminance.wgsl?raw';
import postShader from './shaders/post.wgsl?raw';
import { blurWeights } from './post-data.ts';
import { NEUTRAL_IMAGE_SPACE, type ImageSpace } from '../world/image-space.ts';

/** Format of the scene before post-processing. */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** Bloom is computed at a quarter of the resolution. */
const BLOOM_DIVISOR = 4;
const POST_FLOATS = 32;

/**
 * Rates of the two luminance averages per second. TODO(M13): the engine's exact mapping of
 * Eye Adapt Speed / Strength to the shader's rates is not documented; these follow the
 * values' ranges (speed 35–45, strength 5–8) with a time scale that adapts within seconds.
 */
const ADAPT_RATE_PER_UNIT = 0.1;

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
}

export class PostProcessor {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #luminanceLayout: GPUBindGroupLayout;
  readonly #bright: GPURenderPipeline;
  readonly #blur: GPURenderPipeline;
  readonly #composite: GPURenderPipeline;
  readonly #luminance: GPUComputePipeline;
  readonly #sampler: GPUSampler;
  /** Uniforms of the bright/composite pass and the two blur passes. */
  readonly #uniforms: GPUBuffer[];
  readonly #adaptation: GPUBuffer;
  readonly #adaptParams: GPUBuffer;
  readonly #data = new Float32Array(POST_FLOATS);
  #targets: Targets | undefined;
  #reset = true;

  constructor(device: GPUDevice, outputFormat: GPUTextureFormat) {
    this.#device = device;
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
    this.#uniforms = [0, 1, 2].map((i) =>
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

  /** Bloom, adaptation, tone curve and grading from the HDR target into `output`. */
  run(
    encoder: GPUCommandEncoder,
    output: GPUTextureView,
    width: number,
    height: number,
    space: ImageSpace | undefined,
    deltaSeconds: number,
  ): void {
    const targets = this.#ensureTargets(width, height);
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

    const data = this.#data;
    data.fill(0);
    data.set(
      [bloom ? hdr.receiveBloomThreshold : 0, 1 / Math.max(hdr.white, 0.05) ** 2, adapt ? 1 : 0, 0],
      0,
    );
    data.set([image.saturation, 0, image.contrast, image.brightness], 4);
    data.set([...image.tintColor, image.tintAmount], 8);
    data.set(blurWeights(hdr.bloomBlurRadius), 16);
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
    pass('composite', output, this.#composite, targets.composite);
  }

  #ensureTargets(width: number, height: number): Targets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    this.#targets?.hdr.destroy();
    this.#targets?.bloomA.destroy();
    this.#targets?.bloomB.destroy();
    const device = this.#device;
    const texture = (label: string, w: number, h: number): GPUTexture =>
      device.createTexture({
        label,
        size: [Math.max(1, w), Math.max(1, h)],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
    const hdr = texture('hdr', width, height);
    const bloomA = texture(
      'bloom-a',
      Math.ceil(width / BLOOM_DIVISOR),
      Math.ceil(height / BLOOM_DIVISOR),
    );
    const bloomB = texture('bloom-b', bloomA.width, bloomA.height);
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
