// Temporal anti-aliasing ([Display] bUseTAA): the projection moves by a sub-pixel offset each
// frame (taa-data.ts) and the HDR scene is blended with its history before post-processing
// (shaders/taa.wgsl). The history follows the camera through the opaque scene's depth.

import taaShader from './shaders/taa.wgsl?raw';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';
import { VELOCITY_FORMAT } from './taa-data.ts';

/** The history's share of each frame (higher: smoother, slower to follow). */
const HISTORY_SHARE = 0.9;
const UNIFORM_FLOATS = 20;

interface Targets {
  readonly width: number;
  readonly height: number;
  history: [GPUTexture, GPUTexture];
  /** The two history textures in a fixed order (history swaps them each frame). */
  readonly pair: readonly [GPUTexture, GPUTexture];
  /** Motion vectors of moving draws (SceneRenderer.drawVelocity). */
  readonly velocity: GPUTexture;
  valid: boolean;
  /** Bind groups by history side, made for `hdr` and `depth` (made again when they change). */
  readonly groups: Map<number, GPUBindGroup>;
  hdr: GPUTexture | undefined;
  depth: GPUTexture | undefined;
}

export class TemporalAA {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #uniforms: GPUBuffer;
  readonly #data = new Float32Array(UNIFORM_FLOATS);
  #targets: Targets | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: 'taa', code: taaShader });
    this.#pipeline = device.createRenderPipeline({
      label: 'taa',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_resolve', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.#sampler = device.createSampler({
      label: 'taa',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.#uniforms = device.createBuffer({
      label: 'taa-uniforms',
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * The motion vectors' target of a frame of this size (cleared, then written by the moving
   * draws before resolve).
   */
  velocityTarget(width: number, height: number): GPUTexture {
    return this.#ensure(width, height).velocity;
  }

  /** Forgets the history (a new view, a cut). */
  reset(): void {
    if (this.#targets) this.#targets.valid = false;
  }

  /**
   * Blends `hdr` (this frame) with the history into the next history, then copies it back into
   * `hdr`. `reproject`: this frame's clip space to the last frame's (none: no history).
   */
  resolve(
    encoder: GPUCommandEncoder,
    hdr: GPUTexture,
    depth: GPUTexture,
    reproject: Mat4 | undefined,
  ): void {
    const targets = this.#ensure(hdr.width, hdr.height);
    const [previous, next] = targets.history;
    const valid = targets.valid && reproject !== undefined;
    if (reproject) this.#data.set(reproject, 0);
    this.#data.set([HISTORY_SHARE, valid ? 1 : 0, 1 / hdr.width, 1 / hdr.height], 16);
    this.#device.queue.writeBuffer(this.#uniforms, 0, this.#data);
    // The renderer's targets made anew (a resize, also one back to this size) are other
    // textures under the same labels: groups bound to the old ones would fail the submit.
    if (targets.hdr !== hdr || targets.depth !== depth) {
      targets.groups.clear();
      targets.hdr = hdr;
      targets.depth = depth;
    }
    const key = previous === targets.pair[0] ? 0 : 1;
    let group = targets.groups.get(key);
    if (!group) {
      group = this.#device.createBindGroup({
        label: 'taa',
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniforms } },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: hdr.createView() },
          { binding: 3, resource: previous.createView() },
          { binding: 4, resource: depth.createView() },
          { binding: 5, resource: targets.velocity.createView() },
        ],
      });
      targets.groups.set(key, group);
    }
    const pass = encoder.beginRenderPass({
      label: 'taa',
      colorAttachments: [{ view: next.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToTexture({ texture: next }, { texture: hdr }, [hdr.width, hdr.height]);
    targets.history = [next, previous];
    targets.valid = true;
  }

  #ensure(width: number, height: number): Targets {
    const old = this.#targets;
    if (old?.width === width && old.height === height) return old;
    for (const texture of old?.pair ?? []) texture.destroy();
    old?.velocity.destroy();
    const texture = (label: string): GPUTexture =>
      this.#device.createTexture({
        label,
        size: [width, height],
        format: HDR_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
    const pair: [GPUTexture, GPUTexture] = [texture('taa-history-a'), texture('taa-history-b')];
    this.#targets = {
      width,
      height,
      history: [pair[0], pair[1]],
      pair,
      velocity: this.#device.createTexture({
        label: 'taa-velocity',
        size: [width, height],
        format: VELOCITY_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }),
      valid: false,
      groups: new Map(),
      hdr: undefined,
      depth: undefined,
    };
    return this.#targets;
  }
}
