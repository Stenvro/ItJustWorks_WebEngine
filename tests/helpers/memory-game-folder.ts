import { MemoryByteSource, type ByteSource } from '../../src/formats/byte-source.ts';
import type { GameFolder } from '../../src/vfs/game-folder.ts';

const encode = (value: Uint8Array | string): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

/** In-memory installation folder for tests. */
export class MemoryGameFolder implements GameFolder {
  readonly #data: Map<string, Uint8Array>;
  readonly #root: Map<string, Uint8Array> | undefined;

  /** `root: null` simulates that only the Data folder was chosen. */
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
    if (!bytes) return Promise.reject(new Error(`${relativePath} does not exist`));
    return Promise.resolve(new MemoryByteSource(bytes));
  }

  readRootFile(name: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#root?.get(name.toLowerCase()));
  }
}

/** Minimal TES4 record with the given flags and masters (MAST + DATA fields, as plugins have). */
export function pluginBytes(flags = 0, masters: readonly string[] = []): Uint8Array {
  const encoder = new TextEncoder();
  const fields = masters.flatMap((master) => {
    const name = encoder.encode(`${master}\0`);
    const mast = new Uint8Array(6 + name.length);
    mast.set(encoder.encode('MAST'));
    new DataView(mast.buffer).setUint16(4, name.length, true);
    mast.set(name, 6);
    const data = new Uint8Array(6 + 8);
    data.set(encoder.encode('DATA'));
    new DataView(data.buffer).setUint16(4, 8, true);
    return [mast, data];
  });
  const dataSize = fields.reduce((sum, field) => sum + field.length, 0);
  const bytes = new Uint8Array(24 + dataSize);
  bytes.set(encoder.encode('TES4'));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, dataSize, true);
  view.setUint32(8, flags, true);
  let offset = 24;
  for (const field of fields) {
    bytes.set(field, offset);
    offset += field.length;
  }
  return bytes;
}
