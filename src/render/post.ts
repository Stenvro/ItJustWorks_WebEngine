// HDR post-processing: the scene is rendered into a half-float target, then eye adaptation,
// bloom, the tone curve and colour grading of the current imagespace turn it into the
// displayed image (shaders/post.wgsl, shaders/luminance.wgsl), and its depth of field blurs
// the distance (shaders/dof.wgsl).

import dofShader from './shaders/dof.wgsl?raw';
import luminanceShader from './shaders/luminance.wgsl?raw';
import postShader from './shaders/post.wgsl?raw';
import { blurWeights } from './post-data.ts';
import { NEUTRAL_IMAGE_SPACE, type ImageSpace } from '../world/image-space.ts';

/** Format of the scene before post-processing. */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
/** Bloom is computed at a quarter of the resolution. */
const BLOOM_DIVISOR = 4;
/** The depth of field's blurred copy is made at half the resolution. */
const DOF_DIVISOR = 2;
const POST_FLOATS = 32;
const DOF_FLOATS = 12;

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
  /** Depth of field: the graded image, its blurred copy (half size) and their bind groups. */
  readonly graded: GPUTexture;
  readonly dofA: GPUTexture;
  readonly dofB: GPUTexture;
  readonly dofDown: GPUBindGroup;
  readonly dofBlurH: GPUBindGroup;
  readonly dofBlurV: GPUBindGroup;
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
  readonly #layout: GPUBindGroupLayout;
  readonly #luminanceLayout: GPUBindGroupLayout;
  readonly #bright: GPURenderPipeline;
  readonly #blur: GPURenderPipeline;
  readonly #composite: GPURenderPipeline;
  /** The composite into the half-float image the depth of field reads. */
  readonly #compositeGraded: GPURenderPipeline;
  readonly #dof: GPURenderPipeline;
  readonly #dofLayout: GPUBindGroupLayout;
  readonly #dofUniforms: GPUBuffer;
  readonly #dofData = new Float32Array(DOF_FLOATS);
  /** The depth of field's last bind group and the depth view it was made for. */
  #dofGroup: { readonly depth: GPUTextureView; readonly group: GPUBindGroup } | undefined;
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
    this.#dof = device.createRenderPipeline({
      label: 'post-dof',
      layout: device.createPipelineLayout({ label: 'dof', bindGroupLayouts: [this.#dofLayout] }),
      vertex: { module: dofModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: dofModule, entryPoint: 'fs_dof', targets: [{ format: outputFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    this.#dofUniforms = device.createBuffer({
      label: 'dof-uniforms',
      size: DOF_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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
    // 0-2: bright pass and bloom blurs; 3-5: the depth of field's copy and blurs.
    this.#uniforms = [0, 1, 2, 3, 4, 5].map((i) =>
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
   * Bloom, adaptation, tone curve, grading and depth of field from the HDR target into
   * `output`. `depth`: the opaque scene's depth (r32float, reversed Z) with the camera's
   * near plane, for the depth of field.
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
    data.set(
      [image.saturation, 1 / Math.max(this.gamma, 0.05), image.contrast, image.brightness],
      4,
    );
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

    const field = image.depthOfField;
    const dof = space !== undefined && depth !== undefined && field.strength > 0;
    if (dof) {
      // The copy: threshold 0, scale 1; the blurs: the radius's taps at half size.
      data.set(blurWeights(dofBlurPixels(field.blurRadius)), 16);
      const dofWrite = (index: number, threshold: number, stepX: number, stepY: number): void => {
        data.set([threshold, 1, stepX, stepY], 12);
        const buffer = this.#uniforms[index];
        if (buffer) queue.writeBuffer(buffer, 0, data);
      };
      dofWrite(3, 0, 0, 0);
      dofWrite(4, 0, 1 / targets.dofA.width, 0);
      dofWrite(5, 0, 0, 1 / targets.dofA.height);
      this.#dofData.set([field.strength, field.distance, field.range, field.sky ? 1 : 0], 0);
      this.#dofData.set([1 / width, 1 / height, depth.near, 0], 4);
      const map = field.worldMap;
      this.#dofData.set(map ? [map.focal, map.maxBlur, map.scale, map.nearScale] : [0, 0, 0, 0], 8);
      queue.writeBuffer(this.#dofUniforms, 0, this.#dofData);
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
    if (!dof) {
      pass('composite', output, this.#composite, targets.composite);
      return;
    }
    pass('composite', targets.graded.createView(), this.#compositeGraded, targets.composite);
    // The world map's blur reads the graded image itself.
    if (!field.worldMap) {
      pass('dof-copy', targets.dofA.createView(), this.#bright, targets.dofDown);
      pass('dof-blur-h', targets.dofB.createView(), this.#blur, targets.dofBlurH);
      pass('dof-blur-v', targets.dofA.createView(), this.#blur, targets.dofBlurV);
    }
    pass('dof', output, this.#dof, this.#dofBindGroup(targets, depth.view));
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

  #ensureTargets(width: number, height: number): Targets {
    if (this.#targets?.width === width && this.#targets.height === height) return this.#targets;
    this.#targets?.hdr.destroy();
    this.#targets?.bloomA.destroy();
    this.#targets?.bloomB.destroy();
    this.#targets?.graded.destroy();
    this.#targets?.dofA.destroy();
    this.#targets?.dofB.destroy();
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
          GPUTextureUsage.COPY_SRC,
      });
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
