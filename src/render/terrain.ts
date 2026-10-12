// Draws landscape cells built by terrain-data.ts: one draw per quadrant with its 8 blended
// textures and normal maps.

import { DEPTH_FORMAT, SAMPLE_COUNT } from './scene-renderer.ts';
import frameShader from './shaders/frame.wgsl?raw';
import terrainShader from './shaders/terrain.wgsl?raw';
import {
  quadrantIndices,
  TERRAIN_STRIDE,
  TERRAIN_TEXTURES,
  type TerrainQuadrantData,
} from './terrain-data.ts';
import type { TextureCache } from './texture-cache.ts';

/** Diffuse and normal map of each texture slot of a quadrant. */
export interface TerrainTexturePaths {
  readonly diffuse: string;
  readonly normal: string;
}

interface GpuQuadrant {
  readonly vertices: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/** A cell's landscape on the GPU. Destroy it when the cell unloads. */
export class GpuTerrainCell {
  readonly quadrants: readonly GpuQuadrant[];

  constructor(quadrants: readonly GpuQuadrant[]) {
    this.quadrants = quadrants;
  }

  destroy(): void {
    for (const quadrant of this.quadrants) quadrant.vertices.destroy();
  }
}

export class TerrainRenderer {
  readonly #device: GPUDevice;
  readonly #pipeline: GPURenderPipeline;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #indices: GPUBuffer;
  readonly #indexCount: number;
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, frameLayout: GPUBindGroupLayout) {
    this.#device = device;
    this.#materialLayout = device.createBindGroupLayout({
      label: 'terrain-material',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ...Array.from({ length: TERRAIN_TEXTURES * 2 }, (_, i): GPUBindGroupLayoutEntry => ({
          binding: i + 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {},
        })),
      ],
    });
    const module = device.createShaderModule({
      label: 'terrain',
      code: frameShader + terrainShader,
    });
    this.#pipeline = device.createRenderPipeline({
      label: 'terrain',
      layout: device.createPipelineLayout({
        label: 'terrain',
        bindGroupLayouts: [frameLayout, this.#materialLayout],
      }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: TERRAIN_STRIDE,
            attributes: [
              { shaderLocation: 0, format: 'float32x3', offset: 0 },
              { shaderLocation: 1, format: 'snorm8x4', offset: 12 },
              { shaderLocation: 2, format: 'unorm8x4', offset: 16 },
              { shaderLocation: 3, format: 'unorm8x4', offset: 20 },
              { shaderLocation: 4, format: 'unorm8x4', offset: 24 },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: colorFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: SAMPLE_COUNT },
    });
    const indices = quadrantIndices();
    this.#indexCount = indices.length;
    this.#indices = device.createBuffer({
      label: 'terrain-indices',
      size: Math.ceil(indices.byteLength / 4) * 4,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint16Array(this.#indices.getMappedRange()).set(indices);
    this.#indices.unmap();
    this.#sampler = device.createSampler({
      label: 'terrain',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 16,
    });
  }

  /** Uploads a cell; resolves when its textures are loaded (missing ones use defaults). */
  async createCell(
    quadrants: readonly TerrainQuadrantData[],
    texturePaths: (slot: number | undefined) => Promise<TerrainTexturePaths>,
    textures: TextureCache,
  ): Promise<GpuTerrainCell> {
    const device = this.#device;
    const gpuQuadrants = await Promise.all(
      quadrants.map(async (quadrant, q): Promise<GpuQuadrant> => {
        const vertices = device.createBuffer({
          label: `terrain-q${String(q)}`,
          size: quadrant.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX,
          mappedAtCreation: true,
        });
        new Uint8Array(vertices.getMappedRange()).set(quadrant.vertices);
        vertices.unmap();
        const slots = await Promise.all(
          Array.from({ length: TERRAIN_TEXTURES }, async (_, i) => {
            if (i >= quadrant.textures.length) return undefined;
            const paths = await texturePaths(quadrant.textures[i]);
            const [diffuse, normal] = await Promise.all([
              textures.get(paths.diffuse),
              textures.get(paths.normal),
            ]);
            return { diffuse, normal };
          }),
        );
        const { defaults } = textures;
        const bindGroup = device.createBindGroup({
          label: `terrain-q${String(q)}`,
          layout: this.#materialLayout,
          entries: [
            { binding: 0, resource: this.#sampler },
            ...slots.map((slot, i) => ({
              binding: 1 + i,
              resource: (slot?.diffuse ?? defaults.white).createView(),
            })),
            ...slots.map((slot, i) => ({
              binding: 1 + TERRAIN_TEXTURES + i,
              resource: (slot?.normal ?? defaults.flatNormal).createView(),
            })),
          ],
        });
        return { vertices, bindGroup, center: quadrant.center, radius: quadrant.radius };
      }),
    );
    return new GpuTerrainCell(gpuQuadrants);
  }

  draw(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    cells: Iterable<GpuTerrainCell>,
  ): void {
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, frameBindGroup);
    pass.setIndexBuffer(this.#indices, 'uint16');
    for (const cell of cells) {
      for (const quadrant of cell.quadrants) {
        pass.setBindGroup(1, quadrant.bindGroup);
        pass.setVertexBuffer(0, quadrant.vertices);
        pass.drawIndexed(this.#indexCount);
      }
    }
  }
}
