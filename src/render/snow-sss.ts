// The improved snow's subsurface scattering (ISSnowSSS, shaders/snow-sss.wgsl): reads the
// resolved opaque scene as lit (before the composite adds the snow highlights, AO and fog),
// its depth and the G-buffer's snow mask, and writes the scattered snow into the
// multisampled colour target, which the composite then finishes.

import { HDR_FORMAT } from './post.ts';
import { SAMPLE_COUNT } from './scene-renderer.ts';
import snowSssShader from './shaders/snow-sss.wgsl?raw';

/** fSnowSSSStrength and fSnowSSSDepthDiff (the game's defaults). */
const SSS_STRENGTH = 50;
const SSS_DEPTH_DIFF = 0.5;
/**
 * The dark colour: fSnowSSSColorR/G/B and fSnowSSSDarkColorIntensity (the game's defaults;
 * iSnowSSSCurrentColor 2 selects a colour preset the engine does not document, so the
 * configured colour is used).
 */
const SSS_DARK_COLOR = [0, 0, 0.08] as const;
const SSS_DARK_INTENSITY = 0.1;

export interface SnowScatteringInputs {
  /** The resolved opaque scene, unfogged. */
  readonly scene: GPUTexture;
  /** Its depth (r32float, reversed Z). */
  readonly depth: GPUTexture;
  /** The resolved G-buffer (b: snow mask, a: written). */
  readonly gbuffer: GPUTexture;
}

export class SnowScattering {
  /** Development switch: off leaves the scene as lit. */
  enabled = true;
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #uniforms: GPUBuffer;
  readonly #sampler: GPUSampler;
  readonly #data = new Float32Array(8);
  #group: { readonly inputs: SnowScatteringInputs; readonly group: GPUBindGroup } | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: 'snow-sss', code: snowSssShader });
    this.#pipeline = device.createRenderPipeline({
      label: 'snow-sss',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_snow_sss', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      multisample: { count: SAMPLE_COUNT },
    });
    this.#uniforms = device.createBuffer({
      label: 'snow-sss-uniforms',
      size: this.#data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({
      label: 'snow-sss',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** Scatters the snow of the opaque scene into `target` (the multisampled colour). */
  run(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    inputs: SnowScatteringInputs,
    near: number,
  ): void {
    if (!this.enabled) return;
    this.#data.set([SSS_STRENGTH, SSS_DEPTH_DIFF, near, 0], 0);
    this.#data.set([...SSS_DARK_COLOR, SSS_DARK_INTENSITY], 4);
    this.#device.queue.writeBuffer(this.#uniforms, 0, this.#data);
    const pass = encoder.beginRenderPass({
      label: 'snow-sss',
      colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup(inputs));
    pass.draw(3);
    pass.end();
  }

  #bindGroup(inputs: SnowScatteringInputs): GPUBindGroup {
    const last = this.#group;
    if (
      last?.inputs.scene === inputs.scene &&
      last.inputs.depth === inputs.depth &&
      last.inputs.gbuffer === inputs.gbuffer
    ) {
      return last.group;
    }
    const group = this.#device.createBindGroup({
      label: 'snow-sss',
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#uniforms } },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: inputs.scene.createView() },
        { binding: 3, resource: inputs.depth.createView() },
        { binding: 4, resource: inputs.gbuffer.createView() },
      ],
    });
    this.#group = { inputs, group };
    return group;
  }
}
