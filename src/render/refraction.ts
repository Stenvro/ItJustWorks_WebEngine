// Refraction as the engine does it: shapes with SLSF1 Refraction (heat haze over fires and
// torches, magic barriers, Nocturnal's mist) draw only into a refraction buffer (normal map
// xy, refraction strength, mask; shaders/refraction.wgsl); after everything else is drawn the
// image-space pass shifts the whole scene by it (ISRefraction, shaders/refraction-composite.wgsl),
// so whatever was blended behind a barrier is bent along with the opaque scene.

import { HDR_FORMAT } from './post.ts';
import refractionCompositeShader from './shaders/refraction-composite.wgsl?raw';

/** The refraction buffer: strengths go above 1 when controllers animate them. */
export const REFRACTION_FORMAT: GPUTextureFormat = 'rgba16float';

export interface RefractionInputs {
  /** The scene so far, resolved (a copy: the pass writes the scene). */
  readonly scene: GPUTexture;
  /** The resolved refraction buffer. */
  readonly refraction: GPUTexture;
}

export class RefractionComposite {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  #group: { readonly inputs: RefractionInputs; readonly group: GPUBindGroup } | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({
      label: 'refraction-composite',
      code: refractionCompositeShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: 'refraction-composite',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_refraction_composite',
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.#sampler = device.createSampler({
      label: 'refraction-composite',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** Writes the refracted scene into `target` (the resolved HDR scene). */
  run(encoder: GPUCommandEncoder, target: GPUTextureView, inputs: RefractionInputs): void {
    const pass = encoder.beginRenderPass({
      label: 'refraction-composite',
      colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup(inputs));
    pass.draw(3);
    pass.end();
  }

  #bindGroup(inputs: RefractionInputs): GPUBindGroup {
    const last = this.#group;
    if (last?.inputs.scene === inputs.scene && last.inputs.refraction === inputs.refraction) {
      return last.group;
    }
    const group = this.#device.createBindGroup({
      label: 'refraction-composite',
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#sampler },
        { binding: 1, resource: inputs.scene.createView() },
        { binding: 2, resource: inputs.refraction.createView() },
      ],
    });
    this.#group = { inputs, group };
    return group;
  }
}
