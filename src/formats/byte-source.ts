/**
 * Willekeurig toegankelijke bytes (bestand, blob of geheugen). Parsers lezen grote
 * bestanden hiermee op offset, zodat een archief nooit in zijn geheel in geheugen staat.
 */
export interface ByteSource {
  readonly size: number;
  /** Leest precies `length` bytes vanaf `offset`; gooit als dat buiten het bestand valt. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Geeft onderliggende resources vrij (bestandshandles). */
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
