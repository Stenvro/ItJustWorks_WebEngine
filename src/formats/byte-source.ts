/**
 * Random-access bytes (file, blob or memory). Parsers use this to read large
 * files at an offset, so an archive is never held in memory as a whole.
 */
export interface ByteSource {
  readonly size: number;
  /** Reads exactly `length` bytes from `offset`; throws if that falls outside the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Releases underlying resources (file handles). */
  close?(): Promise<void>;
}

export function checkReadRange(size: number, offset: number, length: number): void {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  ) {
    throw new RangeError(`Read range ${offset}+${length} is outside source of ${size} bytes`);
  }
}

export class MemoryByteSource implements ByteSource {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get size(): number {
    return this.#bytes.byteLength;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    checkReadRange(this.size, offset, length);
    return Promise.resolve(this.#bytes.slice(offset, offset + length));
  }
}
