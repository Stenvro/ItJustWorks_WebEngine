// Draws distant trees (tree LOD): billboards from a worldspace's tree atlas, one instance per
// tree of the loaded tree blocks.

import { sphereVisible } from './frustum.ts';
import type { Plane } from './frustum.ts';
import { gbufferTarget } from './gbuffer.ts';
import type { TreeLodInstance, TreeLodType } from '../formats/lod/lod.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT } from './scene-renderer.ts';
import frameShader from './shaders/frame.wgsl?raw';
import treeShader from './shaders/tree-lod.wgsl?raw';

/** Per instance: position + scale (f32x4), type (u32). */
const INSTANCE_STRIDE = 20;

/** A worldspace's tree types and atlas on the GPU. */
export class GpuTreeTypes {
  readonly bindGroup: GPUBindGroup;
  /** The largest billboard's width plus height (a block's bound grows by it times the scale). */
  readonly extent: number;
  readonly #buffer: GPUBuffer;

  constructor(bindGroup: GPUBindGroup, buffer: GPUBuffer, extent = 0) {
    this.bindGroup = bindGroup;
    this.extent = extent;
    this.#buffer = buffer;
  }

  destroy(): void {
    this.#buffer.destroy();
  }
}

/** The trees of one tree LOD block, with a sphere round their positions. */
export class GpuTreeBlock {
  readonly instances: GPUBuffer;
  readonly count: number;
  readonly center: readonly [number, number, number];
  readonly radius: number;
  /** The largest scale of its trees. */
  readonly maxScale: number;

  constructor(
    instances: GPUBuffer,
    count: number,
    center: readonly [number, number, number] = [0, 0, 0],
    radius = Infinity,
    maxScale = 1,
  ) {
    this.instances = instances;
    this.count = count;
    this.center = center;
    this.radius = radius;
    this.maxScale = maxScale;
  }

  destroy(): void {
    this.instances.destroy();
  }
}

export interface TreeLodFrame {
  readonly types: GpuTreeTypes;
  readonly blocks: Iterable<GpuTreeBlock>;
}

export class TreeLodRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, frameLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      label: 'tree-lod',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const module = device.createShaderModule({ label: 'tree-lod', code: frameShader + treeShader });
    this.#pipeline = device.createRenderPipeline({
      label: 'tree-lod',
      layout: device.createPipelineLayout({
        label: 'tree-lod',
        bindGroupLayouts: [frameLayout, this.#layout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_tree',
        buffers: [
          {
            arrayStride: INSTANCE_STRIDE,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, format: 'float32x4', offset: 0 },
              { shaderLocation: 1, format: 'uint32', offset: 16 },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_tree',
        targets: [{ format: colorFormat }, gbufferTarget(true)],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: SAMPLE_COUNT, alphaToCoverageEnabled: false },
    });
    this.#sampler = device.createSampler({
      label: 'tree-lod',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  createTypes(types: readonly TreeLodType[], atlas: GPUTexture): GpuTreeTypes {
    const count = Math.max(1, ...types.map((t) => t.index + 1));
    const data = new Float32Array(count * 8);
    for (const type of types) {
      data.set([type.width, type.height, 0, 0, ...type.uv], type.index * 8);
    }
    const buffer = this.#device.createBuffer({
      label: 'tree-types',
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    const bindGroup = this.#device.createBindGroup({
      label: 'tree-lod',
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: atlas.createView() },
      ],
    });
    const extent = Math.max(0, ...types.map((type) => type.width + type.height));
    return new GpuTreeTypes(bindGroup, buffer, extent);
  }

  createBlock(trees: readonly TreeLodInstance[]): GpuTreeBlock | undefined {
    if (trees.length === 0) return undefined;
    const data = new ArrayBuffer(trees.length * INSTANCE_STRIDE);
    const floats = new Float32Array(data);
    const uints = new Uint32Array(data);
    trees.forEach((tree, i) => {
      floats.set([...tree.position, tree.scale], (i * INSTANCE_STRIDE) / 4);
      uints[(i * INSTANCE_STRIDE) / 4 + 4] = tree.type;
    });
    const buffer = this.#device.createBuffer({
      label: 'tree-block',
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
    buffer.unmap();
    const bound = treeBound(trees);
    return new GpuTreeBlock(buffer, trees.length, bound.center, bound.radius, bound.maxScale);
  }

  /** Draws the blocks inside `planes` (all without planes); returns how many it drew. */
  draw(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    frame: TreeLodFrame,
    planes?: readonly Plane[],
  ): number {
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, frame.types.bindGroup);
    let drawn = 0;
    for (const block of frame.blocks) {
      const radius = block.radius + block.maxScale * frame.types.extent;
      if (planes && !sphereVisible(planes, block.center, radius)) continue;
      pass.setVertexBuffer(0, block.instances);
      pass.draw(6, block.count);
      drawn++;
    }
    return drawn;
  }
}

/** A sphere round the trees' positions (their billboards' size is added when drawn). */
export function treeBound(trees: readonly TreeLodInstance[]): {
  center: [number, number, number];
  radius: number;
  maxScale: number;
} {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let maxScale = 0;
  for (const tree of trees) {
    for (let i = 0; i < 3; i++) {
      const v = tree.position[i] ?? 0;
      min[i] = Math.min(min[i] ?? v, v);
      max[i] = Math.max(max[i] ?? v, v);
    }
    maxScale = Math.max(maxScale, tree.scale);
  }
  if (trees.length === 0) return { center: [0, 0, 0], radius: 0, maxScale: 0 };
  const mid = (i: number): number => ((min[i] ?? 0) + (max[i] ?? 0)) / 2;
  const center: [number, number, number] = [mid(0), mid(1), mid(2)];
  let radius = 0;
  for (const tree of trees) {
    const [x, y, z] = tree.position;
    radius = Math.max(radius, Math.hypot(x - center[0], y - center[1], z - center[2]));
  }
  return { center, radius, maxScale };
}
