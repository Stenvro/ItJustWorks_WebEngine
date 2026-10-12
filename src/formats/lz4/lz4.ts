/* eslint-disable @typescript-eslint/no-non-null-assertion -- hot loop; bounds are checked explicitly */

// LZ4 decompression (block and frame format). Skyrim SE archives (BSA v105) store
// compressed files as a single LZ4 frame.
// Block:  https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
// Frame:  https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md

import { FormatError } from '../binary-reader.ts';
import { xxhash32 } from './xxhash32.ts';

const FRAME_MAGIC = 0x184d2204;
const SKIPPABLE_MAGIC = 0x184d2a50; // 0x184D2A50..0x184D2A5F
const MIN_MATCH = 4;
/** Below this length a byte loop is faster than `set`/`copyWithin`. */
const SHORT_COPY = 32;
const BLOCK_MAX_SIZES = [0, 0, 0, 0, 0x1_0000, 0x4_0000, 0x10_0000, 0x40_0000] as const;

function corrupt(message: string, offset: number): FormatError {
  return new FormatError(`LZ4: ${message}`, offset);
}

/**
 * Decodes one LZ4 block from `src[srcStart..srcEnd)` into `dst` starting at `dstStart`.
 * Matches may refer back as far as `windowStart` (start of the frame for linked blocks).
 * Returns the new write position in `dst`.
 */
export function decodeLz4Block(
  src: Uint8Array,
  srcStart: number,
  srcEnd: number,
  dst: Uint8Array,
  dstStart: number,
  windowStart = dstStart,
): number {
  if (srcStart < 0 || srcEnd > src.length || srcStart > srcEnd) {
    throw corrupt('invalid input range', srcStart);
  }
  const dstEnd = dst.length;
  let ip = srcStart;
  let op = dstStart;

  while (ip < srcEnd) {
    const token = src[ip++]!;

    // Literals
    let literalLength = token >>> 4;
    if (literalLength === 15) {
      let byte: number;
      do {
        if (ip >= srcEnd) throw corrupt('literal length runs past the block', ip);
        byte = src[ip++]!;
        literalLength += byte;
      } while (byte === 255);
    }
    if (literalLength > 0) {
      if (literalLength > srcEnd - ip) throw corrupt('literals run past the block', ip);
      if (literalLength > dstEnd - op) throw corrupt('output larger than expected', ip);
      if (literalLength < SHORT_COPY) {
        for (const end = ip + literalLength; ip < end;) dst[op++] = src[ip++]!;
      } else {
        dst.set(src.subarray(ip, ip + literalLength), op);
        ip += literalLength;
        op += literalLength;
      }
    }

    // The last sequence consists of literals only.
    if (ip >= srcEnd) break;

    // Match
    if (srcEnd - ip < 2) throw corrupt('truncated match offset', ip);
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > op - windowStart) {
      throw corrupt(`invalid match offset ${offset}`, ip - 2);
    }

    let matchLength = (token & 15) + MIN_MATCH;
    if ((token & 15) === 15) {
      let byte: number;
      do {
        if (ip >= srcEnd) throw corrupt('match length runs past the block', ip);
        byte = src[ip++]!;
        matchLength += byte;
      } while (byte === 255);
    }
    if (matchLength > dstEnd - op) throw corrupt('output larger than expected', ip);

    let mp = op - offset;
    if (matchLength < SHORT_COPY || offset < matchLength) {
      // Overlapping matches (offset < length) must also go byte by byte: they repeat a pattern.
      for (const end = op + matchLength; op < end;) dst[op++] = dst[mp++]!;
    } else {
      dst.copyWithin(op, mp, mp + matchLength);
      op += matchLength;
    }
  }
  return op;
}

function readU32(src: Uint8Array, p: number): number {
  if (p + 4 > src.length) throw corrupt('unexpected end of input', p);
  return (src[p]! | (src[p + 1]! << 8) | (src[p + 2]! << 16) | (src[p + 3]! << 24)) >>> 0;
}

export interface Lz4FrameOptions {
  /** Verify block and content checksums (if the frame has them). The header checksum is always verified. */
  readonly verifyChecksums?: boolean;
}

/**
 * Decompresses one or more concatenated LZ4 frames into exactly `outputSize` bytes.
 * Throws FormatError on corrupt input or a mismatching output size.
 */
export function decompressLz4Frame(
  src: Uint8Array,
  outputSize: number,
  options: Lz4FrameOptions = {},
): Uint8Array {
  const dst = new Uint8Array(outputSize);
  const verify = options.verifyChecksums ?? false;
  let ip = 0;
  let op = 0;

  while (ip < src.length) {
    const magic = readU32(src, ip);
    if ((magic & 0xfffffff0) >>> 0 === SKIPPABLE_MAGIC) {
      ip += 8 + readU32(src, ip + 4);
      if (ip > src.length) throw corrupt('skippable frame runs past the input', ip);
      continue;
    }
    if (magic !== FRAME_MAGIC) throw corrupt(`unknown frame magic 0x${magic.toString(16)}`, ip);
    ip += 4;

    // Frame descriptor
    const descriptorStart = ip;
    if (ip + 3 > src.length) throw corrupt('truncated frame descriptor', ip);
    const flags = src[ip++]!;
    const blockDescriptor = src[ip++]!;
    if (flags >>> 6 !== 1) throw corrupt(`frame version ${flags >>> 6} not supported`, ip - 2);
    if ((flags & 0x02) !== 0 || (blockDescriptor & 0x8f) !== 0) {
      throw corrupt('reserved bits set', ip - 2);
    }
    const independentBlocks = (flags & 0x20) !== 0;
    const hasBlockChecksum = (flags & 0x10) !== 0;
    const hasContentSize = (flags & 0x08) !== 0;
    const hasContentChecksum = (flags & 0x04) !== 0;
    if ((flags & 0x01) !== 0) throw corrupt('LZ4 dictionaries are not used by Skyrim', ip);
    const maxBlockSize = BLOCK_MAX_SIZES[(blockDescriptor >>> 4) & 7] ?? 0;
    if (maxBlockSize === 0) throw corrupt('invalid block maximum size', ip - 1);

    let contentSize = -1;
    if (hasContentSize) {
      const low = readU32(src, ip);
      const high = readU32(src, ip + 4);
      contentSize = high * 0x1_0000_0000 + low;
      ip += 8;
    }
    if (ip >= src.length) throw corrupt('truncated frame descriptor', ip);
    const headerChecksum = src[ip]!;
    if (((xxhash32(src, descriptorStart, ip - descriptorStart) >>> 8) & 0xff) !== headerChecksum) {
      throw corrupt('header checksum mismatch', ip);
    }
    ip++;

    // Data blocks
    const frameStart = op;
    for (;;) {
      const blockHeader = readU32(src, ip);
      ip += 4;
      if (blockHeader === 0) break; // EndMark
      const stored = (blockHeader & 0x80000000) !== 0;
      const blockSize = blockHeader & 0x7fffffff;
      if (blockSize > maxBlockSize) throw corrupt(`block of ${blockSize} bytes too large`, ip - 4);
      if (blockSize > src.length - ip) throw corrupt('block runs past the input', ip);

      if (
        verify &&
        hasBlockChecksum &&
        xxhash32(src, ip, blockSize) !== readU32(src, ip + blockSize)
      ) {
        throw corrupt('block checksum mismatch', ip);
      }
      if (stored) {
        if (blockSize > dst.length - op) throw corrupt('output larger than expected', ip);
        dst.set(src.subarray(ip, ip + blockSize), op);
        op += blockSize;
      } else {
        op = decodeLz4Block(src, ip, ip + blockSize, dst, op, independentBlocks ? op : frameStart);
      }
      ip += blockSize + (hasBlockChecksum ? 4 : 0);
    }

    if (hasContentSize && op - frameStart !== contentSize) {
      throw corrupt(`frame holds ${op - frameStart} bytes, header says ${contentSize}`, ip);
    }
    if (hasContentChecksum) {
      if (verify && xxhash32(dst, frameStart, op - frameStart) !== readU32(src, ip)) {
        throw corrupt('content checksum mismatch', ip);
      }
      ip += 4;
    }
  }

  if (op !== outputSize) {
    throw corrupt(`decompressed ${op} bytes, expected ${outputSize}`, ip);
  }
  return dst;
}
