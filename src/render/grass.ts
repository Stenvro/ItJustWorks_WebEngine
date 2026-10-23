// Draws grass: for each grass type of a cell, its mesh instanced at every placed plant.

import { gbufferTarget } from './gbuffer.ts';
import { sphereVisible, type Plane } from './frustum.ts';
import {
  DEPTH_FORMAT,
  SAMPLE_COUNT,
  vertexBuffers,
  type GpuModel,
  type SceneRenderer,
} from './scene-renderer.ts';
import frameShader from './shaders/frame.wgsl?raw';
import grassShader from './shaders/grass.wgsl?raw';
import type { VertexLayout } from './model-data.ts';
import type { GrassInstance, GrassType } from '../world/grass.ts';
import { GrassFlag } from '../world/grass.ts';

/** Per instance: position + rotation, scale across + up + shade + unused, ground normal. */
const INSTANCE_FLOATS = 12;
/** fGrassStartFadeDistance (High, Ultra) and the range over which plants shrink away. */
export const GRASS_FADE_START = 7000;
export const GRASS_FADE_RANGE = 1000;
/** Where the fade start sits in a field's uniforms (floats: wave period, 1, start, range, ...). */
const FADE_START_OFFSET = 8;

/** One grass type's plants in one cell. */
export class GpuGrassField {
  readonly model: GpuModel;
  readonly instances: GPUBuffer;
  readonly count: number;
  readonly bindGroups: readonly GPUBindGroup[];
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly #uniforms: readonly GPUBuffer[];
  /** The fade start its uniforms hold. */
  #fadeStart = GRASS_FADE_START;

  constructor(init: {
    model: GpuModel;
    instances: GPUBuffer;
    count: number;
    bindGroups: readonly GPUBindGroup[];
    uniforms: readonly GPUBuffer[];
    center: readonly [number, number, number];
    radius: number;
  }) {
    this.model = init.model;
    this.instances = init.instances;
    this.count = init.count;
    this.bindGroups = init.bindGroups;
    this.#uniforms = init.uniforms;
    this.center = init.center;
    this.radius = init.radius;
    // The field draws the model while it exists.
    this.model.acquire();
  }

  /** Gives the field another fade start (the setting Grass Fade changed). */
  fadeFrom(device: GPUDevice, start: number): void {
    if (start === this.#fadeStart) return;
    this.#fadeStart = start;
    for (const buffer of this.#uniforms) {
      device.queue.writeBuffer(buffer, FADE_START_OFFSET, Float32Array.of(start));
    }
  }

  destroy(): void {
    this.instances.destroy();
    for (const buffer of this.#uniforms) buffer.destroy();
    this.model.release();
  }
}

export class GrassRenderer {
  readonly #device: GPUDevice;
  readonly #scene: SceneRenderer;
  readonly #colorFormat: GPUTextureFormat;
  readonly #layout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #module: GPUShaderModule;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  /** fGrassStartFadeDistance: where plants begin to fade (the setting Grass Fade). */
  fadeStart = GRASS_FADE_START;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, scene: SceneRenderer) {
    this.#device = device;
    this.#scene = scene;
    this.#colorFormat = colorFormat;
    this.#layout = device.createBindGroupLayout({
      label: 'grass',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {},
        },
      ],
    });
    this.#pipelineLayout = device.createPipelineLayout({
      label: 'grass',
      bindGroupLayouts: [scene.frameLayout, this.#layout, scene.materialLayout],
    });
    this.#module = device.createShaderModule({ label: 'grass', code: frameShader + grassShader });
  }

  createField(
    model: GpuModel,
    type: GrassType,
    plants: readonly GrassInstance[],
  ): GpuGrassField | undefined {
    if (plants.length === 0 || model.parts.length === 0) return undefined;
    const device = this.#device;
    const data = new Float32Array(plants.length * INSTANCE_FLOATS);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    plants.forEach((plant, i) => {
      const [x, y, z] = plant.position;
      data.set(
        [x, y, z, plant.rotation, plant.scaleXY, plant.scaleZ, plant.shade, 0, ...plant.normal, 0],
        i * INSTANCE_FLOATS,
      );
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    });
    const instances = device.createBuffer({
      label: `grass-${type.editorId}`,
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(instances.getMappedRange()).set(data);
    instances.unmap();
    const uniforms: GPUBuffer[] = [];
    const bindGroups = model.parts.map((part) => {
      const alpha = part.part.alpha;
      const threshold = alpha && (alpha.flags & 0x200) !== 0 ? alpha.threshold / 255 : -1;
      const buffer = device.createBuffer({
        label: `grass-${type.editorId}`,
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(buffer.getMappedRange()).set([
        type.wavePeriod,
        1,
        GRASS_FADE_START,
        GRASS_FADE_RANGE,
        threshold,
        (type.flags & GrassFlag.vertexLighting) !== 0 ? 1 : 0,
        0,
        0,
      ]);
      buffer.unmap();
      uniforms.push(buffer);
      return device.createBindGroup({
        label: `grass-${type.editorId}`,
        layout: this.#layout,
        entries: [{ binding: 0, resource: { buffer } }],
      });
    });
    const modelRadius = model.radius * Math.max(1, 1 + type.heightRange);
    return new GpuGrassField({
      model,
      instances,
      count: plants.length,
      bindGroups,
      uniforms,
      center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + modelRadius,
    });
  }

  /** Draws the fields in view and within the grass distance of the camera. */
  draw(
    pass: GPURenderPassEncoder,
    fields: Iterable<GpuGrassField>,
    planes: readonly Plane[],
    camera: readonly [number, number, number],
  ): void {
    pass.setBindGroup(0, this.#scene.frameBindGroup);
    pass.setVertexBuffer(1, this.#scene.fallbackVertices);
    const reach = this.fadeStart + GRASS_FADE_RANGE;
    for (const field of fields) {
      field.fadeFrom(this.#device, this.fadeStart);
      const distance = Math.hypot(
        field.center[0] - camera[0],
        field.center[1] - camera[1],
        field.center[2] - camera[2],
      );
      if (distance - field.radius > reach) continue;
      if (!sphereVisible(planes, field.center, field.radius)) continue;
      pass.setVertexBuffer(2, field.instances);
      field.model.parts.forEach((part, i) => {
        const group = field.bindGroups[i];
        if (!group || part.pass === 'water') return;
        pass.setPipeline(this.#pipeline(part.part.layout));
        pass.setBindGroup(1, group);
        pass.setBindGroup(2, part.bindGroup);
        pass.setVertexBuffer(0, part.vertexBuffer);
        pass.setIndexBuffer(part.indexBuffer, 'uint16');
        pass.drawIndexed(part.indexCount, field.count);
      });
    }
  }

  #pipeline(layout: VertexLayout): GPURenderPipeline {
    const key = [layout.stride, layout.uv, layout.normal, layout.tangent, layout.color].join('|');
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `grass ${key}`,
        layout: this.#pipelineLayout,
        vertex: {
          module: this.#module,
          entryPoint: 'vs_grass',
          buffers: [
            ...vertexBuffers(layout),
            {
              arrayStride: INSTANCE_FLOATS * 4,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 6, format: 'float32x4', offset: 0 },
                { shaderLocation: 7, format: 'float32x4', offset: 16 },
                { shaderLocation: 8, format: 'float32x4', offset: 32 },
              ],
            },
          ],
        },
        fragment: {
          module: this.#module,
          entryPoint: 'fs_grass',
          targets: [{ format: this.#colorFormat }, gbufferTarget(true)],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: SAMPLE_COUNT },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
