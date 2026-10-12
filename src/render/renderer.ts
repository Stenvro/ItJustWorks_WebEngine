import type { GpuContext } from './gpu.ts';
import pipelineCheckShader from './shaders/pipeline-check.wgsl?raw';

/** Rendert één frame per aanroep. Nu alleen de M0-pijplijncheck. */
export class Renderer {
  readonly #gpu: GpuContext;
  readonly #pipeline: GPURenderPipeline;
  readonly #frameBuffer: GPUBuffer;
  readonly #frameData = new Float32Array(4);
  readonly #bindGroup: GPUBindGroup;

  constructor(gpu: GpuContext) {
    this.#gpu = gpu;
    const { device, format } = gpu;

    const module = device.createShaderModule({
      label: 'pipeline-check',
      code: pipelineCheckShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: 'pipeline-check',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.#frameBuffer = device.createBuffer({
      label: 'frame-uniforms',
      size: this.#frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#bindGroup = device.createBindGroup({
      label: 'frame',
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#frameBuffer } }],
    });
  }

  render(timeSeconds: number): void {
    const { device, context } = this.#gpu;
    this.#frameData[0] = timeSeconds;
    device.queue.writeBuffer(this.#frameBuffer, 0, this.#frameData);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      label: 'main',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
