import { MemoryByteSource, type ByteSource } from '../../src/formats/byte-source.ts';
import type { GameFolder } from '../../src/vfs/game-folder.ts';

const encode = (value: Uint8Array | string): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

/** Installatiemap in geheugen voor tests. */
export class MemoryGameFolder implements GameFolder {
  readonly #data: Map<string, Uint8Array>;
  readonly #root: Map<string, Uint8Array> | undefined;

  /** `root: null` simuleert dat alleen de Data-map gekozen is. */
  constructor(
    data: Record<string, Uint8Array | string>,
    root: Record<string, Uint8Array | string> | null = {},
  ) {
    this.#data = new Map(Object.entries(data).map(([k, v]) => [k, encode(v)]));
    this.#root =
      root === null
        ? undefined
        : new Map(Object.entries(root).map(([k, v]) => [k.toLowerCase(), encode(v)]));
  }

  listDataFiles(): Promise<readonly string[]> {
    return Promise.resolve([...this.#data.keys()]);
  }

  openDataFile(relativePath: string): Promise<ByteSource> {
    const bytes = this.#data.get(relativePath);
    if (!bytes) return Promise.reject(new Error(`${relativePath} bestaat niet`));
    return Promise.resolve(new MemoryByteSource(bytes));
  }

  readRootFile(name: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#root?.get(name.toLowerCase()));
  }
}

/** Minimale TES4-header met de gegeven vlaggen. */
export function pluginBytes(flags = 0): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(new TextEncoder().encode('TES4'));
  new DataView(bytes.buffer).setUint32(8, flags, true);
  return bytes;
}
