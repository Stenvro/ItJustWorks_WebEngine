// GPU textures from DDS files, cached per path. Missing or broken textures fall back to
// neutral defaults so a model still renders. Models hold the textures they use (retain /
// release); textures no model holds any more can be evicted under a memory budget.

import type { DdsTexture } from '../formats/dds/dds.ts';

export type TextureLoader = (path: string) => Promise<DdsTexture>;

export interface DefaultTextures {
  /** White: neutral diffuse, glow mask and environment mask. */
  readonly white: GPUTexture;
  /** Black: no glow. */
  readonly black: GPUTexture;
  /** Flat tangent-space normal (0.5, 0.5, 1) with no specular (alpha 0). */
  readonly flatNormal: GPUTexture;
  /** Black cubemap: no reflections. */
  readonly blackCube: GPUTexture;
}

const isCompressed = (format: string): boolean => format.startsWith('bc');
const roundUp4 = (value: number): number => Math.ceil(value / 4) * 4;

export function createGpuTexture(device: GPUDevice, dds: DdsTexture, label: string): GPUTexture {
  const compressed = isCompressed(dds.format);
  const texture = device.createTexture({
    label,
    format: dds.format,
    size: [dds.width, dds.height, dds.layerCount],
    mipLevelCount: dds.mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    ...(dds.cubemap && { textureBindingViewDimension: 'cube' as const }),
  });
  for (const level of dds.levels) {
    // Block-compressed copies cover whole 4x4 blocks, also for the 2x2 and 1x1 mips.
    const width = compressed ? roundUp4(level.width) : level.width;
    const height = compressed ? roundUp4(level.height) : level.height;
    device.queue.writeTexture(
      { texture, mipLevel: level.mip, origin: [0, 0, level.layer] },
      dds.data,
      { offset: level.offset, bytesPerRow: level.bytesPerRow, rowsPerImage: level.rows },
      [width, height, 1],
    );
  }
  return texture;
}

function solid(
  device: GPUDevice,
  label: string,
  rgba: readonly [number, number, number, number],
  layers = 1,
): GPUTexture {
  const texture = device.createTexture({
    label,
    format: 'rgba8unorm',
    size: [1, 1, layers],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    ...(layers === 6 && { textureBindingViewDimension: 'cube' as const }),
  });
  const pixel = Uint8Array.from(rgba);
  for (let layer = 0; layer < layers; layer++) {
    device.queue.writeTexture(
      { texture, origin: [0, 0, layer] },
      pixel,
      { bytesPerRow: 4 },
      [1, 1, 1],
    );
  }
  return texture;
}

/** GPU bytes of a DDS texture (all mips and layers as stored). */
export function textureBytes(dds: DdsTexture): number {
  return dds.levels.reduce((sum, level) => sum + level.size, 0);
}

interface TextureEntry {
  readonly texture: Promise<GPUTexture | undefined>;
  bytes: number;
  /** Models holding it; textures never held (terrain, sky, water) are never evicted. */
  refs: number;
  held: boolean;
  /** performance.now() of the last request or release. */
  lastUsed: number;
}

export class TextureCache {
  readonly defaults: DefaultTextures;
  readonly #device: GPUDevice;
  readonly #load: TextureLoader;
  readonly #cache = new Map<string, TextureEntry>();
  readonly #failures: string[] = [];
  #bytes = 0;

  constructor(device: GPUDevice, load: TextureLoader) {
    this.#device = device;
    this.#load = load;
    this.defaults = {
      white: solid(device, 'default-white', [255, 255, 255, 255]),
      black: solid(device, 'default-black', [0, 0, 0, 255]),
      flatNormal: solid(device, 'default-normal', [128, 128, 255, 0]),
      blackCube: solid(device, 'default-cube', [0, 0, 0, 255], 6),
    };
  }

  /** Paths that failed to load since the last call (for logging). */
  takeFailures(): string[] {
    return this.#failures.splice(0);
  }

  /** The texture at `path`, or `undefined` if it is missing or broken. */
  get(path: string): Promise<GPUTexture | undefined> {
    if (path === '') return Promise.resolve(undefined);
    let entry = this.#cache.get(path);
    if (!entry) {
      const created: TextureEntry = {
        texture: this.#load(path).then(
          (dds) => {
            created.bytes = textureBytes(dds);
            this.#bytes += created.bytes;
            return createGpuTexture(this.#device, dds, path);
          },
          (error: unknown) => {
            this.#failures.push(
              `${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
          },
        ),
        bytes: 0,
        refs: 0,
        held: false,
        lastUsed: performance.now(),
      };
      entry = created;
      this.#cache.set(path, entry);
    }
    entry.lastUsed = performance.now();
    return entry.texture;
  }

  /** A model holds the texture at `path` (see `release`). */
  retain(path: string): void {
    const entry = this.#cache.get(path);
    if (!entry) return;
    entry.refs++;
    entry.held = true;
    entry.lastUsed = performance.now();
  }

  /**
   * A model lets go of the texture at `path` (models are destroyed when idle, so this does not
   * count as a use).
   */
  release(path: string): void {
    const entry = this.#cache.get(path);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
  }

  /** GPU bytes of the loaded textures. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Frees textures that models held but none holds any more, least recently used first,
   * until the textures take at most `maxBytes`; skips those used in the last `graceMs`
   * (something may be about to hold them). Returns the bytes freed.
   */
  evict(maxBytes: number, graceMs: number): number {
    if (this.#bytes <= maxBytes) return 0;
    const now = performance.now();
    const idle = [...this.#cache.entries()]
      .filter(([, entry]) => entry.held && entry.refs === 0 && now - entry.lastUsed > graceMs)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let freed = 0;
    for (const [path, entry] of idle) {
      if (this.#bytes <= maxBytes) break;
      this.#cache.delete(path);
      this.#bytes -= entry.bytes;
      freed += entry.bytes;
      void entry.texture.then((texture) => {
        texture?.destroy();
      });
    }
    return freed;
  }
}
