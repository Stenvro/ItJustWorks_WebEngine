// Screen blood on the GPU: the splatters (screen-blood-data.ts) drawn over the finished image,
// before the menus (shaders/screen-blood.wgsl).

import shader from './shaders/screen-blood.wgsl?raw';
import type { SplatDraw } from './screen-blood-data.ts';

/** What the screen blood draws this frame. */
export interface ScreenBloodFrame {
  /** The splatters' shape (alpha), colour and flare textures. */
  readonly shape: GPUTexture;
  readonly color: GPUTexture;
  readonly flare: GPUTexture | undefined;
  readonly splats: readonly SplatDraw[];
}

/** Floats per quad: middle, half size, rotation and alpha. */
const QUAD_FLOATS = 6;
const MAX_QUADS = 128;

export class ScreenBloodRenderer {
  readonly #device: GPUDevice;
  readonly #splat: GPURenderPipeline;
  readonly #flare: GPURenderPipeline;
  readonly #sampler: GPUSampler;
  readonly #layout: GPUBindGroupLayout;
  readonly #quads: GPUBuffer;
  readonly #data = new Float32Array(MAX_QUADS * QUAD_FLOATS);
  readonly #groups = new WeakMap<GPUTexture, { key: string; group: GPUBindGroup }>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.#device = device;
    const module = device.createShaderModule({ label: 'screen-blood', code: shader });
    const layout = device.createBindGroupLayout({
      label: 'screen-blood',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.#layout = layout;
    const pipeline = (entry: string, blend: GPUBlendState): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `screen-blood ${entry}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: {
          module,
          entryPoint: 'vs_splat',
          buffers: [
            {
              arrayStride: QUAD_FLOATS * 4,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x2' },
                { shaderLocation: 2, offset: 16, format: 'float32x2' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: entry, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    this.#splat = pipeline('fs_splat', {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'zero', dstFactor: 'one' },
    });
    this.#flare = pipeline('fs_flare', {
      color: { srcFactor: 'one', dstFactor: 'one' },
      alpha: { srcFactor: 'zero', dstFactor: 'one' },
    });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.#quads = device.createBuffer({
      label: 'screen-blood quads',
      size: this.#data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  /** Draws the splatters, then their flares, over `target`. */
  draw(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    width: number,
    height: number,
    frame: ScreenBloodFrame,
  ): void {
    const splats = frame.splats.slice(0, MAX_QUADS / 2);
    if (splats.length === 0) return;
    const aspect = height / Math.max(1, width);
    const data = this.#data;
    let at = 0;
    const quad = (x: number, y: number, size: number, rotation: number, alpha: number): void => {
      data.set([x * 2 - 1, 1 - y * 2, size * aspect, size, rotation, alpha], at * QUAD_FLOATS);
      at++;
    };
    for (const s of splats) quad(s.x, s.y, s.size, s.rotation, s.alpha);
    const flares = frame.flare ? splats.filter((s) => s.flareAlpha > 0) : [];
    for (const s of flares) quad(s.flareX, s.flareY, s.flareSize, 0, s.flareAlpha);
    this.#device.queue.writeBuffer(this.#quads, 0, data, 0, at * QUAD_FLOATS);

    const pass = encoder.beginRenderPass({
      label: 'screen-blood',
      colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setBindGroup(0, this.#group(frame));
    pass.setVertexBuffer(0, this.#quads);
    pass.setPipeline(this.#splat);
    pass.draw(6, splats.length);
    if (flares.length > 0) {
      pass.setPipeline(this.#flare);
      pass.draw(6, flares.length, 0, splats.length);
    }
    pass.end();
  }

  #group(frame: ScreenBloodFrame): GPUBindGroup {
    const flare = frame.flare ?? frame.color;
    const key = `${frame.color.label}|${flare.label}`;
    const cached = this.#groups.get(frame.shape);
    if (cached?.key === key) return cached.group;
    const group = this.#device.createBindGroup({
      label: 'screen-blood',
      layout: this.#layout,
      entries: [
        { binding: 0, resource: this.#sampler },
        { binding: 1, resource: frame.shape.createView() },
        { binding: 2, resource: frame.color.createView() },
        { binding: 3, resource: flare.createView() },
      ],
    });
    this.#groups.set(frame.shape, { key, group });
    return group;
  }
}
