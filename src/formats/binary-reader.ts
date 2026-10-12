/**
 * Fout in binaire data: te kort, ongeldige waarde of onbekende versie.
 * Parsers gooien alleen deze fout, zodat de engine corrupte bestanden kan
 * opvangen zonder te crashen.
 */
export class FormatError extends Error {
  override readonly name = 'FormatError';
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (offset ${offset})`);
    this.offset = offset;
  }
}

/** Sequentiële little-endian lezer over een Uint8Array, met grenscontrole. */
export class BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#offset = 0;
    this.seek(offset);
  }

  get offset(): number {
    return this.#offset;
  }

  get length(): number {
    return this.#bytes.byteLength;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  seek(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.#bytes.byteLength) {
      throw new FormatError(
        `Ongeldige positie ${offset} in buffer van ${this.length} bytes`,
        offset,
      );
    }
    this.#offset = offset;
  }

  skip(count: number): void {
    this.seek(this.#take(count) + count);
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  i8(): number {
    return this.#view.getInt8(this.#take(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2), true);
  }

  i16(): number {
    return this.#view.getInt16(this.#take(2), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), true);
  }

  u64(): bigint {
    return this.#view.getBigUint64(this.#take(8), true);
  }

  /** u64 als number; gooit als de waarde niet exact past (> 2^53 - 1). */
  u64Number(): number {
    const start = this.#offset;
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FormatError(`u64 ${value} past niet in een number`, start);
    }
    return Number(value);
  }

  f32(): number {
    return this.#view.getFloat32(this.#take(4), true);
  }

  /** Volgende `count` bytes als view op dezelfde buffer (geen kopie). */
  bytes(count: number): Uint8Array {
    const start = this.#take(count);
    return this.#bytes.subarray(start, start + count);
  }

  /** Vier ASCII-tekens, bijvoorbeeld een record-type (`TES4`) of magic (`BSA\0`). */
  fourCC(): string {
    const start = this.#take(4);
    const b = this.#bytes;
    return String.fromCharCode(
      b[start] ?? 0,
      b[start + 1] ?? 0,
      b[start + 2] ?? 0,
      b[start + 3] ?? 0,
    );
  }

  /** Reserveert `count` bytes en geeft de startpositie terug. */
  #take(count: number): number {
    const start = this.#offset;
    if (!Number.isInteger(count) || count < 0) {
      throw new FormatError(`Ongeldig aantal bytes ${count}`, start);
    }
    if (count > this.#bytes.byteLength - start) {
      throw new FormatError(
        `Onverwacht einde: ${count} bytes nodig, ${this.remaining} over`,
        start,
      );
    }
    this.#offset = start + count;
    return start;
  }
}
