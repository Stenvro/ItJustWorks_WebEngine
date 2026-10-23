// The composite after the opaque pass (shaders/composite.wgsl, the engine's ISSAOComposite):
// adds the snow's specular, applies the ambient occlusion and the fog, and adds the snow's
// sparkles, per sample of the multisampled colour target, after the snow's scattering and
// before anything reads the opaque scene (water, blended parts, soft effects).

import frameShader from './shaders/frame.wgsl?raw';
import snowShader from './shaders/snow.wgsl?raw';
import compositeShader from './shaders/composite.wgsl?raw';

export interface CompositeInputs {
  /** The ambient occlusion (r), or undefined without SAO. */
  readonly occlusion: GPUTexture | undefined;
  /** The multisampled G-buffer and depth of the opaque pass. */
  readonly gbuffer: GPUTexture;
  readonly depth: GPUTexture;
}

export class Composite {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #pipeline: GPURenderPipeline;
  /** A white texel: no occlusion. */
  readonly #open: GPUTexture;
  #group: { readonly inputs: CompositeInputs; readonly group: GPUBindGroup } | undefined;

  constructor(
    device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    colorFormat: GPUTextureFormat,
    sampleCount: number,
  ) {
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      label: 'composite',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', multisampled: true },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', multisampled: true },
        },
      ],
    });
    const module = device.createShaderModule({
      label: 'composite',
      code: frameShader + snowShader + compositeShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: 'composite',
      layout: device.createPipelineLayout({
        label: 'composite',
        bindGroupLayouts: [frameLayout, this.#layout],
      }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_composite',
        // src + dst * src.a: what the fog and the snow add, and what is left of the colour.
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: sampleCount },
    });
    this.#open = device.createTexture({
      label: 'composite-no-occlusion',
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // 1.0 as half floats.
    device.queue.writeTexture(
      { texture: this.#open },
      Uint16Array.of(0x3c00, 0x3c00, 0x3c00, 0x3c00),
      { bytesPerRow: 8 },
      [1, 1],
    );
  }

  /** Finishes the opaque scene in `color` (multisampled, resolved into `resolve`). */
  run(
    encoder: GPUCommandEncoder,
    frameBindGroup: GPUBindGroup,
    inputs: CompositeInputs,
    color: GPUTextureView,
    resolve: GPUTextureView,
  ): void {
    const pass = encoder.beginRenderPass({
      label: 'composite',
      colorAttachments: [{ view: color, resolveTarget: resolve, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, this.#bindGroup(inputs));
    pass.draw(3);
    pass.end();
  }

  #bindGroup(inputs: CompositeInputs): GPUBindGroup {
    const last = this.#group;
    if (
      last !== undefined &&
      last.inputs.occlusion === inputs.occlusion &&
      last.inputs.gbuffer === inputs.gbuffer &&
      last.inputs.depth === inputs.depth
    ) {
      return last.group;
    }
    const group = this.#device.createBindGroup({
      label: 'composite',
      layout: this.#layout,
      entries: [
        { binding: 0, resource: (inputs.occlusion ?? this.#open).createView() },
        { binding: 1, resource: inputs.gbuffer.createView() },
        { binding: 2, resource: inputs.depth.createView() },
      ],
    });
    this.#group = { inputs, group };
    return group;
  }
}
