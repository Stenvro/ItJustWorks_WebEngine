/**
 * Error in binary data: too short, invalid value or unknown version.
 * Parsers throw only this error, so the engine can catch corrupt files
 * without crashing.
 */
export class FormatError extends Error {
  override readonly name = 'FormatError';
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (offset ${offset})`);
    this.offset = offset;
  }
}

/**
 * Sequential reader over a Uint8Array, with bounds checking. Little-endian unless told
 * otherwise (Skyrim's compiled Papyrus scripts are big-endian).
 */
export class BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #littleEndian: boolean;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0, littleEndian = true) {
    this.#bytes = bytes;
    this.#littleEndian = littleEndian;
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
      throw new FormatError(`Invalid position ${offset} in buffer of ${this.length} bytes`, offset);
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
    return this.#view.getUint16(this.#take(2), this.#littleEndian);
  }

  i16(): number {
    return this.#view.getInt16(this.#take(2), this.#littleEndian);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), this.#littleEndian);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), this.#littleEndian);
  }

  u64(): bigint {
    return this.#view.getBigUint64(this.#take(8), this.#littleEndian);
  }

  /** u64 as number; throws if the value does not fit exactly (> 2^53 - 1). */
  u64Number(): number {
    const start = this.#offset;
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FormatError(`u64 ${value} does not fit in a number`, start);
    }
    return Number(value);
  }

  f32(): number {
    return this.#view.getFloat32(this.#take(4), this.#littleEndian);
  }

  /** Next `count` bytes as a view on the same buffer (no copy). */
  bytes(count: number): Uint8Array {
    const start = this.#take(count);
    return this.#bytes.subarray(start, start + count);
  }

  /** Four ASCII characters, e.g. a record type (`TES4`) or magic (`BSA\0`). */
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

  /** Reserves `count` bytes and returns the start position. */
  #take(count: number): number {
    const start = this.#offset;
    if (!Number.isInteger(count) || count < 0) {
      throw new FormatError(`Invalid byte count ${count}`, start);
    }
    if (count > this.#bytes.byteLength - start) {
      throw new FormatError(`Unexpected end: need ${count} bytes, ${this.remaining} left`, start);
    }
    this.#offset = start + count;
    return start;
  }
}
