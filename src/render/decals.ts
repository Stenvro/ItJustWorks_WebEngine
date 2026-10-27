// Placed decals (TXST references with decal data) on the GPU: per texture set one bind group
// and the instances of its projection boxes; drawn at the start of the blended pass, where
// each box projects its texture onto the opaque surfaces it contains (shaders/decal.wgsl).
// Notes: docs/rendering.md ("Decals").

import { TextureSetFlag, type TextureSet } from '../world/decal.ts';
import { invert, sphereVisible, type Plane } from './frustum.ts';
import { maxScale, type Mat4 } from './math.ts';
import frameShader from './shaders/frame.wgsl?raw';
import decalShader from './shaders/decal.wgsl?raw';
import type { TextureCache } from './texture-cache.ts';
import { DEPTH_FORMAT, SAMPLE_COUNT } from './scene-renderer.ts';

/** A decal to place: its reference, texture set (shared by `base`), box and atlas variant. */
export interface DecalPlacement {
  readonly reference: number;
  readonly base: number;
  readonly textureSet: TextureSet;
  readonly box: Mat4;
  readonly rect: readonly [number, number, number, number];
}

/** Floats per decal instance: box (16), inverse rows (12), rect, colour, params. */
const INSTANCE_FLOATS = 40;

/** Unit cube corners and its 12 triangles (counter-clockwise from outside). */
const CUBE_CORNERS = Float32Array.from([
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5,
  0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
]);
const CUBE_INDICES = Uint16Array.from([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4,
  3, 4, 7,
]);

interface DecalInstance {
  readonly reference: number;
  readonly data: Float32Array;
  center: readonly [number, number, number];
  radius: number;
}

/** Writes a decal's box and the rows of its inverse (world → unit cube) into its data. */
function writeBox(data: Float32Array, box: Mat4): boolean {
  const inverse = invert(box);
  if (!inverse) return false;
  data.set(box, 0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) data[16 + row * 4 + col] = inverse[col * 4 + row] ?? 0;
  }
  return true;
}

interface DecalGroup {
  readonly bindGroup: GPUBindGroup;
  readonly instances: readonly DecalInstance[];
  /** The enabled instances: where they start in the buffer, and their bounds. */
  first: number;
  shown: DecalInstance[];
}

/** The decals of a cell on the GPU; `select` shows the enabled ones. */
export class GpuDecals {
  readonly groups: readonly DecalGroup[];
  readonly buffer: GPUBuffer;
  readonly #device: GPUDevice;

  constructor(device: GPUDevice, groups: readonly DecalGroup[], buffer: GPUBuffer) {
    this.#device = device;
    this.groups = groups;
    this.buffer = buffer;
    this.select(() => true);
  }

  /** Shows the decals whose reference is enabled. */
  select(isEnabled: (reference: number) => boolean): void {
    const total = this.groups.reduce((sum, group) => sum + group.instances.length, 0);
    const data = new Float32Array(Math.max(1, total) * INSTANCE_FLOATS);
    let at = 0;
    for (const group of this.groups) {
      group.first = at;
      group.shown = group.instances.filter((instance) => isEnabled(instance.reference));
      for (const instance of group.shown) data.set(instance.data, at++ * INSTANCE_FLOATS);
    }
    if (at > 0) this.#device.queue.writeBuffer(this.buffer, 0, data, 0, at * INSTANCE_FLOATS);
  }

  /** Moves every decal of the set to a box (a decal following a body), as shown. */
  move(box: Mat4): void {
    let moved = false;
    for (const group of this.groups) {
      for (const instance of group.instances) {
        if (!writeBox(instance.data, box)) continue;
        instance.center = [box[12] ?? 0, box[13] ?? 0, box[14] ?? 0];
        instance.radius = maxScale(box) * Math.sqrt(3) * 0.5;
        moved = true;
      }
    }
    if (moved) this.select(() => true);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

const inView = (group: DecalGroup, planes: readonly Plane[]): boolean =>
  group.shown.some((instance) => sphereVisible(planes, instance.center, instance.radius));

export class DecalRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #layout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #cube: GPUBuffer;
  readonly #cubeIndices: GPUBuffer;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, frameLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      label: 'decal',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const module = device.createShaderModule({ label: 'decal', code: frameShader + decalShader });
    const attribute = (location: number, offset: number): GPUVertexAttribute => ({
      shaderLocation: location,
      format: 'float32x4',
      offset,
    });
    this.#pipeline = device.createRenderPipeline({
      label: 'decal',
      layout: device.createPipelineLayout({
        label: 'decal',
        bindGroupLayouts: [frameLayout, this.#layout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_decal',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, format: 'float32x3', offset: 0 }],
          },
          {
            arrayStride: INSTANCE_FLOATS * 4,
            stepMode: 'instance',
            attributes: Array.from({ length: 10 }, (_, i) => attribute(i + 1, i * 16)),
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_decal',
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      // The box's far faces: they cover its whole area even with the camera inside it.
      primitive: { topology: 'triangle-list', cullMode: 'front', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: SAMPLE_COUNT },
    });
    this.#sampler = device.createSampler({
      label: 'decal',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 8,
    });
    const buffer = (data: Float32Array | Uint16Array, usage: number, label: string): GPUBuffer => {
      const gpu = device.createBuffer({
        label,
        size: Math.ceil(data.byteLength / 4) * 4,
        usage,
        mappedAtCreation: true,
      });
      new Uint8Array(gpu.getMappedRange()).set(new Uint8Array(data.buffer));
      gpu.unmap();
      return gpu;
    };
    this.#cube = buffer(CUBE_CORNERS, GPUBufferUsage.VERTEX, 'decal-cube');
    this.#cubeIndices = buffer(CUBE_INDICES, GPUBufferUsage.INDEX, 'decal-cube-indices');
  }

  /** Uploads a cell's decals (their textures load first; sets without a texture are left out). */
  async createDecals(
    decals: readonly DecalPlacement[],
    textures: TextureCache,
  ): Promise<GpuDecals | undefined> {
    const bySet = new Map<number, DecalPlacement[]>();
    for (const decal of decals) {
      const list = bySet.get(decal.base) ?? [];
      list.push(decal);
      bySet.set(decal.base, list);
    }
    const groups: DecalGroup[] = [];
    let total = 0;
    for (const list of bySet.values()) {
      const set = list[0]?.textureSet;
      const decal = set?.decal;
      if (!set || !decal) continue;
      const [diffuse, normal] = await Promise.all([
        textures.get(set.textures[0] ?? ''),
        textures.get(set.textures[1] ?? ''),
      ]);
      if (!diffuse) continue;
      const specular =
        normal !== undefined && (set.flags & TextureSetFlag.noSpecularMap) === 0 ? 1 : 0;
      const instances: DecalInstance[] = [];
      for (const placement of list) {
        const data = new Float32Array(INSTANCE_FLOATS);
        if (!writeBox(data, placement.box)) continue;
        data.set(placement.rect, 28);
        data.set([...decal.color, decal.shininess], 32);
        data.set([decal.flags, specular, 0, 0], 36);
        instances.push({
          reference: placement.reference,
          data,
          center: [placement.box[12] ?? 0, placement.box[13] ?? 0, placement.box[14] ?? 0],
          // Half the box diagonal.
          radius: maxScale(placement.box) * Math.sqrt(3) * 0.5,
        });
      }
      if (instances.length === 0) continue;
      total += instances.length;
      groups.push({
        bindGroup: this.#device.createBindGroup({
          label: `decal ${set.editorId}`,
          layout: this.#layout,
          entries: [
            { binding: 0, resource: this.#sampler },
            { binding: 1, resource: diffuse.createView() },
            { binding: 2, resource: (normal ?? textures.defaults.flatNormal).createView() },
          ],
        }),
        instances,
        first: 0,
        shown: [],
      });
    }
    if (groups.length === 0) return undefined;
    const buffer = this.#device.createBuffer({
      label: 'decals',
      size: total * INSTANCE_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    return new GpuDecals(this.#device, groups, buffer);
  }

  /** Whether any decal is in view (they need the copies of the opaque scene). */
  visible(decals: Iterable<GpuDecals>, planes: readonly Plane[]): boolean {
    for (const set of decals) {
      if (set.groups.some((group) => inView(group, planes))) return true;
    }
    return false;
  }

  /** Draws decals over the opaque scene (first in the blended pass). */
  draw(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    decals: Iterable<GpuDecals>,
    planes: readonly Plane[],
  ): void {
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.setVertexBuffer(0, this.#cube);
    pass.setIndexBuffer(this.#cubeIndices, 'uint16');
    for (const set of decals) {
      for (const group of set.groups) {
        if (!inView(group, planes)) continue;
        pass.setBindGroup(1, group.bindGroup);
        pass.setVertexBuffer(1, set.buffer);
        pass.drawIndexed(CUBE_INDICES.length, group.shown.length, 0, 0, group.first);
      }
    }
  }
}
