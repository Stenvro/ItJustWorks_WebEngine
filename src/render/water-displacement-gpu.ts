// The water's displacement field on the GPU (water-displacement.ts decides what it does each
// frame; shaders/water-displacement.wgsl runs it): two state textures it steps between and the
// slopes texture the water shader reads.

import displacementShader from './shaders/water-displacement.wgsl?raw';
import { MAX_RIPPLES, type DisplacementFrame, type RippleVars } from './water-displacement.ts';

/** WGSL `Displacement`: 3 vec4 + 2 per stamp. */
const PARAM_FLOATS = (3 + MAX_RIPPLES * 2) * 4;
const STATE_FORMAT: GPUTextureFormat = 'rgba16float';

export class DisplacementSimulation {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #prepare: GPUComputePipeline;
  readonly #advance: GPUComputePipeline;
  readonly #slopes: GPUComputePipeline;
  /** prepare's and the steps' parameters. */
  readonly #prepareBuffer: GPUBuffer;
  readonly #stepBuffer: GPUBuffer;
  readonly #data = new Float32Array(PARAM_FLOATS);
  #size = 0;
  #states: GPUTexture[] = [];
  #slopesTexture: GPUTexture;
  /** Bind groups by pass and the state they read: [prepare, advance, slopes][from 0, from 1]. */
  #groups: GPUBindGroup[][] = [];
  /** The state holding the field now. */
  #current = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      label: 'water-displacement',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: STATE_FORMAT },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      ],
    });
    const module = device.createShaderModule({
      label: 'water-displacement',
      code: displacementShader,
    });
    const layout = device.createPipelineLayout({
      label: 'water-displacement',
      bindGroupLayouts: [this.#layout],
    });
    const pipeline = (entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label: `water-displacement-${entryPoint}`,
        layout,
        compute: { module, entryPoint },
      });
    this.#prepare = pipeline('prepare');
    this.#advance = pipeline('advance');
    this.#slopes = pipeline('slopes');
    const buffer = (label: string): GPUBuffer =>
      device.createBuffer({
        label,
        size: PARAM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.#prepareBuffer = buffer('water-displacement-prepare');
    this.#stepBuffer = buffer('water-displacement-step');
    // A still surface until the first frame says how large the field is.
    this.#slopesTexture = this.#texture(1, 'water-displacement-slopes');
  }

  /** The surface's slopes (rg) and height (b) over the grid, for the water shader. */
  get slopes(): GPUTexture {
    return this.#slopesTexture;
  }

  /**
   * Runs the frame's passes (none without a frame). Returns true when the slopes texture was
   * made anew (the water's bind group must take the new one).
   */
  run(frame: DisplacementFrame | undefined): boolean {
    if (!frame) return false;
    const resized = this.#resize(frame.textureRes);
    const { stamps } = frame;
    const steps = frame.steps;
    const moved = frame.shift[0] !== 0 || frame.shift[1] !== 0 || frame.clear || resized;
    if (!moved && stamps.length === 0 && steps === 0) return resized;
    const device = this.#device;
    const data = this.#data;
    data.fill(0);
    data.set([frame.shift[0], frame.shift[1], frame.clear || resized ? 1 : 0, stamps.length], 0);
    data.set(vars(frame.wading), 4);
    data.set(vars(frame.rain), 8);
    stamps.forEach((stamp, i) => {
      data.set([stamp.x0, stamp.y0, stamp.x1, stamp.y1], 12 + i * 8);
      data.set([stamp.radius, stamp.force, stamp.layer, 0], 16 + i * 8);
    });
    device.queue.writeBuffer(this.#prepareBuffer, 0, data);
    device.queue.writeBuffer(this.#stepBuffer, 0, data.subarray(0, 12));
    const encoder = device.createCommandEncoder({ label: 'water-displacement' });
    const pass = encoder.beginComputePass({ label: 'water-displacement' });
    const groups = Math.ceil(this.#size / 8);
    const dispatch = (pipeline: GPUComputePipeline, kind: number): void => {
      pass.setPipeline(pipeline);
      const group = this.#groups[kind]?.[this.#current];
      if (!group) return;
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groups, groups);
    };
    if (moved || stamps.length > 0) {
      dispatch(this.#prepare, 0);
      this.#current = 1 - this.#current;
    }
    for (let i = 0; i < steps; i++) {
      dispatch(this.#advance, 1);
      this.#current = 1 - this.#current;
    }
    dispatch(this.#slopes, 2);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return resized;
  }

  destroy(): void {
    for (const texture of this.#states) texture.destroy();
    this.#slopesTexture.destroy();
    this.#prepareBuffer.destroy();
    this.#stepBuffer.destroy();
  }

  #texture(size: number, label: string): GPUTexture {
    return this.#device.createTexture({
      label,
      size: [size, size],
      format: STATE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
  }

  /** Makes the textures for a field of this many texels a side; true if they are new. */
  #resize(size: number): boolean {
    if (size === this.#size) return false;
    for (const texture of this.#states) texture.destroy();
    this.#slopesTexture.destroy();
    this.#size = size;
    this.#states = [0, 1].map((i) => this.#texture(size, `water-displacement-${String(i)}`));
    this.#slopesTexture = this.#texture(size, 'water-displacement-slopes');
    const group = (from: number, to: GPUTexture, buffer: GPUBuffer): GPUBindGroup =>
      this.#device.createBindGroup({
        label: 'water-displacement',
        layout: this.#layout,
        entries: [
          { binding: 0, resource: (this.#states[from] ?? to).createView() },
          { binding: 1, resource: to.createView() },
          { binding: 2, resource: { buffer } },
        ],
      });
    const other = (from: number): GPUTexture => this.#states[1 - from] ?? this.#slopesTexture;
    this.#groups = [
      [0, 1].map((from) => group(from, other(from), this.#prepareBuffer)),
      [0, 1].map((from) => group(from, other(from), this.#stepBuffer)),
      [0, 1].map((from) => group(from, this.#slopesTexture, this.#stepBuffer)),
    ];
    this.#current = 0;
    return true;
  }
}

const vars = (values: RippleVars): number[] => [
  values.force,
  values.velocity,
  values.falloff,
  values.size,
];
