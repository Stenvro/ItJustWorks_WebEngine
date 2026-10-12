/* eslint-disable @typescript-eslint/no-non-null-assertion -- hot loop; bounds are checked explicitly */

// zlib (RFC 1950) / DEFLATE (RFC 1951) decompression. Plugins store compressed records as
// a u32 decompressed size followed by a zlib stream.

import { FormatError } from '../binary-reader.ts';

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** Order in which code length code lengths are stored. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function corrupt(message: string, offset: number): FormatError {
  return new FormatError(`zlib: ${message}`, offset);
}

/**
 * Huffman decoding table indexed by the next `bits` input bits (LSB first).
 * Each entry is `symbol << 4 | codeLength`; 0 marks an invalid code.
 */
interface Huffman {
  readonly table: Uint32Array;
  readonly bits: number;
}

function buildHuffman(lengths: Uint8Array, count: number): Huffman {
  let maxBits = 0;
  const lengthCounts = new Uint16Array(16);
  for (let i = 0; i < count; i++) {
    const length = lengths[i]!;
    lengthCounts[length]!++;
    if (length > maxBits) maxBits = length;
  }
  lengthCounts[0] = 0;
  const bits = Math.max(1, maxBits);
  const table = new Uint32Array(1 << bits);

  // Canonical codes: first code per length.
  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + lengthCounts[length - 1]!) << 1;
    nextCode[length] = code;
  }
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    const symbolCode = nextCode[length]!++;
    if (symbolCode >= 1 << length) throw corrupt('over-subscribed Huffman code', 0);
    // Deflate packs codes MSB first into an LSB-first bit stream: index by reversed code.
    let reversed = 0;
    for (let i = 0; i < length; i++) reversed |= ((symbolCode >> i) & 1) << (length - 1 - i);
    const entry = (symbol << 4) | length;
    for (let index = reversed; index < table.length; index += 1 << length) table[index] = entry;
  }
  return { table, bits };
}

const FIXED_LITERALS = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return buildHuffman(lengths, 288);
})();
const FIXED_DISTANCES = buildHuffman(new Uint8Array(30).fill(5), 30);

class BitReader {
  readonly #src: Uint8Array;
  readonly #end: number;
  position: number;
  #buffer = 0;
  #count = 0;

  constructor(src: Uint8Array, start: number, end: number) {
    this.#src = src;
    this.position = start;
    this.#end = end;
  }

  /** Makes at least `n` (≤ 24) bits available; past the end, zero bits are supplied. */
  #fill(n: number): void {
    while (this.#count < n) {
      const byte = this.position < this.#end ? this.#src[this.position]! : 0;
      this.position++;
      this.#buffer |= byte << this.#count;
      this.#count += 8;
    }
  }

  bits(n: number): number {
    if (n === 0) return 0;
    this.#fill(n);
    const value = this.#buffer & ((1 << n) - 1);
    this.#buffer >>>= n;
    this.#count -= n;
    this.#checkOverrun();
    return value;
  }

  decode(huffman: Huffman): number {
    this.#fill(huffman.bits);
    const entry = huffman.table[this.#buffer & ((1 << huffman.bits) - 1)]!;
    const length = entry & 15;
    if (length === 0) throw corrupt('invalid Huffman code', this.position);
    this.#buffer >>>= length;
    this.#count -= length;
    this.#checkOverrun();
    return entry >>> 4;
  }

  /** Drops the bits of the current byte (stored blocks start byte-aligned). */
  alignToByte(): void {
    const drop = this.#count & 7;
    this.#buffer >>>= drop;
    this.#count -= drop;
    // Give whole buffered bytes back to the byte stream.
    this.position -= this.#count >> 3;
    this.#buffer = 0;
    this.#count = 0;
  }

  #checkOverrun(): void {
    // Bits consumed beyond the end only ever supplied padding zeros.
    if (this.position * 8 - this.#count > this.#end * 8) {
      throw corrupt('unexpected end of input', this.#end);
    }
  }
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    // 5552 is the largest block size for which the sums cannot overflow before reduction.
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Decodes a raw DEFLATE stream into `dst`; returns the number of bytes written. */
function inflateRaw(reader: BitReader, dst: Uint8Array): number {
  let op = 0;
  const lengths = new Uint8Array(320);

  for (;;) {
    const final = reader.bits(1);
    const type = reader.bits(2);

    if (type === 0) {
      reader.alignToByte();
      const src = reader;
      const lo = src.bits(16);
      const nlo = src.bits(16);
      if ((lo ^ 0xffff) !== nlo) throw corrupt('stored block length check failed', src.position);
      reader.alignToByte();
      for (let i = 0; i < lo; i++) {
        if (op >= dst.length) throw corrupt('output larger than expected', reader.position);
        dst[op++] = reader.bits(8);
      }
    } else if (type === 1 || type === 2) {
      let literals = FIXED_LITERALS;
      let distances = FIXED_DISTANCES;
      if (type === 2) {
        const literalCount = reader.bits(5) + 257;
        const distanceCount = reader.bits(5) + 1;
        const codeLengthCount = reader.bits(4) + 4;
        const codeLengthLengths = new Uint8Array(19);
        for (let i = 0; i < codeLengthCount; i++) {
          codeLengthLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3);
        }
        const codeLengths = buildHuffman(codeLengthLengths, 19);
        const total = literalCount + distanceCount;
        lengths.fill(0);
        for (let i = 0; i < total;) {
          const symbol = reader.decode(codeLengths);
          if (symbol < 16) {
            lengths[i++] = symbol;
          } else {
            let repeat: number;
            let value = 0;
            if (symbol === 16) {
              if (i === 0) throw corrupt('repeat without a previous length', reader.position);
              value = lengths[i - 1]!;
              repeat = 3 + reader.bits(2);
            } else if (symbol === 17) {
              repeat = 3 + reader.bits(3);
            } else {
              repeat = 11 + reader.bits(7);
            }
            if (i + repeat > total) throw corrupt('code lengths overflow', reader.position);
            lengths.fill(value, i, i + repeat);
            i += repeat;
          }
        }
        if (lengths[256] === 0) throw corrupt('missing end-of-block code', reader.position);
        literals = buildHuffman(lengths.subarray(0, literalCount), literalCount);
        distances = buildHuffman(lengths.subarray(literalCount, total), distanceCount);
      }

      for (;;) {
        const symbol = reader.decode(literals);
        if (symbol < 256) {
          if (op >= dst.length) throw corrupt('output larger than expected', reader.position);
          dst[op++] = symbol;
          continue;
        }
        if (symbol === 256) break;
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) throw corrupt(`invalid length symbol ${symbol}`, reader.position);
        const length = LENGTH_BASE[lengthIndex]! + reader.bits(LENGTH_EXTRA[lengthIndex]!);
        const distanceSymbol = reader.decode(distances);
        if (distanceSymbol >= 30)
          throw corrupt(`invalid distance symbol ${distanceSymbol}`, reader.position);
        const distance = DIST_BASE[distanceSymbol]! + reader.bits(DIST_EXTRA[distanceSymbol]!);
        if (distance > op)
          throw corrupt(`distance ${distance} before start of output`, reader.position);
        if (op + length > dst.length) throw corrupt('output larger than expected', reader.position);
        let from = op - distance;
        for (const end = op + length; op < end;) dst[op++] = dst[from++]!;
      }
    } else {
      throw corrupt('invalid block type 3', reader.position);
    }

    if (final) return op;
  }
}

export interface InflateOptions {
  /** Verify the Adler-32 checksum (default true). */
  readonly verifyChecksum?: boolean;
}

/**
 * Decompresses a zlib stream to exactly `outputSize` bytes. Throws FormatError on corrupt
 * input, a size mismatch or a checksum mismatch.
 */
export function inflateZlib(
  src: Uint8Array,
  outputSize: number,
  options: InflateOptions = {},
): Uint8Array {
  if (src.length < 6) throw corrupt('stream too short', 0);
  const cmf = src[0]!;
  const flags = src[1]!;
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7) throw corrupt('not a deflate stream', 0);
  if (((cmf << 8) | flags) % 31 !== 0) throw corrupt('header check failed', 0);
  if (flags & 0x20) throw corrupt('preset dictionaries are not supported', 1);

  const dst = new Uint8Array(outputSize);
  const reader = new BitReader(src, 2, src.length);
  const written = inflateRaw(reader, dst);
  if (written !== outputSize) {
    throw corrupt(`decompressed ${written} bytes, expected ${outputSize}`, reader.position);
  }

  if (options.verifyChecksum ?? true) {
    reader.alignToByte();
    const p = reader.position;
    if (p + 4 > src.length) throw corrupt('missing Adler-32 checksum', p);
    const expected =
      ((src[p]! << 24) | (src[p + 1]! << 16) | (src[p + 2]! << 8) | src[p + 3]!) >>> 0;
    if (adler32(dst) !== expected) throw corrupt('Adler-32 checksum mismatch', p);
  }
  return dst;
}
