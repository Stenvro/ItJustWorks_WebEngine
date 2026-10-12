// Screen-space ambient occlusion (shaders/sao.wgsl): camera-space Z and its mips from the
// resolved depth, the raw AO, a bilateral blur per axis, and a composite that darkens the
// opaque scene (the multisampled colour target, before the blended pass draws over it).

import frameShader from './shaders/frame.wgsl?raw';
import saoShader from './shaders/sao.wgsl?raw';

/** Mips of camera-space Z (the reference code's MAX_MIP_LEVEL 5). */
const MIP_LEVELS = 6;
const Z_FORMAT: GPUTextureFormat = 'r32float';
const AO_FORMAT: GPUTextureFormat = 'rgba16float';

interface SaoTargets {
  readonly width: number;
  readonly height: number;
  readonly cameraZ: GPUTexture;
  /** Mip levels that exist (fewer than MIP_LEVELS for tiny targets). */
  readonly levels: number;
  readonly mips: readonly GPUTextureView[];
  readonly cameraZChain: GPUTextureView;
  readonly ao: GPUTexture;
  readonly blurred: GPUTexture;
}

export class Sao {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #pipelines: {
    readonly cameraZ: GPURenderPipeline;
    readonly minify: GPURenderPipeline;
    readonly ao: GPURenderPipeline;
    readonly blurH: GPURenderPipeline;
    readonly blurV: GPURenderPipeline;
    readonly composite: GPURenderPipeline;
  };
  #targets: SaoTargets | undefined;

  constructor(
    device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
  ) {
    this.#device = device;
    const texture = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'unfilterable-float' },
    });
    this.#layout = device.createBindGroupLayout({
      label: 'sao',
      entries: [texture(0), texture(1), texture(2)],
    });
    const layout = device.createPipelineLayout({
      label: 'sao',
      bindGroupLayouts: [frameLayout, this.#layout],
    });
    const module = device.createShaderModule({ label: 'sao', code: frameShader + saoShader });
    const pipeline = (
      entryPoint: string,
      format: GPUTextureFormat,
      extra: Partial<GPUColorTargetState> = {},
      samples = 1,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `sao-${entryPoint}`,
        layout,
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint, targets: [{ format, ...extra }] },
        primitive: { topology: 'triangle-list' },
        multisample: { count: samples },
      });
    this.#pipelines = {
      cameraZ: pipeline('fs_camera_z', Z_FORMAT),
      minify: pipeline('fs_minify', Z_FORMAT),
      ao: pipeline('fs_ao', AO_FORMAT),
      blurH: pipeline('fs_blur_h', AO_FORMAT),
      blurV: pipeline('fs_blur_v', AO_FORMAT),
      // dst * AO + fog colour * fog * (1 - AO): the AO under the fog.
      composite: pipeline(
        'fs_composite',
        colorFormat,
        {
          blend: {
            color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        },
        sampleCount,
      ),
    };
  }

  /**
   * Darkens the opaque scene in `color` (multisampled, resolved into `resolve`) by its
   * ambient occlusion. Needs the frame bind group's scene depth resolved this frame.
   */
  run(
    encoder: GPUCommandEncoder,
    frameBindGroup: GPUBindGroup,
    frame: {
      readonly width: number;
      readonly height: number;
      readonly gbuffer: GPUTexture;
      readonly color: GPUTextureView;
      readonly resolve: GPUTextureView;
    },
  ): void {
    const targets = this.#ensureTargets(frame.width, frame.height);
    const gbuffer = frame.gbuffer.createView();
    const group = (
      source: GPUTextureView,
      cameraZ: GPUTextureView,
      gbufferView: GPUTextureView = gbuffer,
    ): GPUBindGroup =>
      this.#device.createBindGroup({
        layout: this.#layout,
        entries: [
          { binding: 0, resource: source },
          { binding: 1, resource: gbufferView },
          { binding: 2, resource: cameraZ },
        ],
      });
    const aoView = targets.ao.createView();
    const blurredView = targets.blurred.createView();
    const pass = (
      label: string,
      view: GPUTextureView,
      pipeline: GPURenderPipeline,
      bindGroup: GPUBindGroup,
    ): void => {
      const p = encoder.beginRenderPass({
        label,
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      });
      p.setPipeline(pipeline);
      p.setBindGroup(0, frameBindGroup);
      p.setBindGroup(1, bindGroup);
      p.draw(3);
      p.end();
    };
    const mip = (level: number): GPUTextureView => {
      const view = targets.mips[level];
      if (!view) throw new Error(`SAO mip ${String(level)} missing`);
      return view;
    };
    // Bindings never include the texture (mip) being drawn into.
    pass('sao-camera-z', mip(0), this.#pipelines.cameraZ, group(aoView, blurredView));
    for (let level = 1; level < targets.levels; level++) {
      pass(
        `sao-minify-${String(level)}`,
        mip(level),
        this.#pipelines.minify,
        group(mip(level - 1), blurredView),
      );
    }
    pass('sao-ao', aoView, this.#pipelines.ao, group(blurredView, targets.cameraZChain));
    pass('sao-blur-h', blurredView, this.#pipelines.blurH, group(aoView, targets.cameraZChain));
    pass('sao-blur-v', aoView, this.#pipelines.blurV, group(blurredView, targets.cameraZChain));
    const composite = encoder.beginRenderPass({
      label: 'sao-composite',
      colorAttachments: [
        { view: frame.color, resolveTarget: frame.resolve, loadOp: 'load', storeOp: 'store' },
      ],
    });
    composite.setPipeline(this.#pipelines.composite);
    composite.setBindGroup(0, frameBindGroup);
    composite.setBindGroup(1, group(aoView, targets.cameraZChain));
    composite.draw(3);
    composite.end();
  }

  #ensureTargets(width: number, height: number): SaoTargets {
    const current = this.#targets;
    if (current?.width === width && current.height === height) return current;
    current?.cameraZ.destroy();
    current?.ao.destroy();
    current?.blurred.destroy();
    const device = this.#device;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const levels = Math.min(MIP_LEVELS, Math.floor(Math.log2(Math.max(width, height))) + 1);
    const cameraZ = device.createTexture({
      label: 'sao-camera-z',
      size: [width, height],
      format: Z_FORMAT,
      mipLevelCount: levels,
      usage,
    });
    const mips = Array.from({ length: levels }, (_, level) =>
      cameraZ.createView({ baseMipLevel: level, mipLevelCount: 1 }),
    );
    const make = (label: string): GPUTexture =>
      device.createTexture({ label, size: [width, height], format: AO_FORMAT, usage });
    this.#targets = {
      width,
      height,
      cameraZ,
      levels,
      mips,
      cameraZChain: cameraZ.createView(),
      ao: make('sao-ao'),
      blurred: make('sao-blurred'),
    };
    return this.#targets;
  }
}
