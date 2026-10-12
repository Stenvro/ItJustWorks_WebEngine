/* eslint-disable @typescript-eslint/no-non-null-assertion -- hot loop; grenzen worden expliciet bewaakt */

// LZ4-decompressie (block- en frameformaat). Skyrim SE-archieven (BSA v105) slaan
// gecomprimeerde bestanden op als één LZ4-frame.
// Block:  https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
// Frame:  https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md

import { FormatError } from '../binary-reader.ts';
import { xxhash32 } from './xxhash32.ts';

const FRAME_MAGIC = 0x184d2204;
const SKIPPABLE_MAGIC = 0x184d2a50; // 0x184D2A50..0x184D2A5F
const MIN_MATCH = 4;
/** Onder deze lengte is een byte-lus sneller dan `set`/`copyWithin`. */
const SHORT_COPY = 32;
const BLOCK_MAX_SIZES = [0, 0, 0, 0, 0x1_0000, 0x4_0000, 0x10_0000, 0x40_0000] as const;

function corrupt(message: string, offset: number): FormatError {
  return new FormatError(`LZ4: ${message}`, offset);
}

/**
 * Decodeert één LZ4-block uit `src[srcStart..srcEnd)` naar `dst` vanaf `dstStart`.
 * Matches mogen terugverwijzen tot `windowStart` (begin van het frame bij gekoppelde blocks).
 * Geeft de nieuwe schrijfpositie in `dst` terug.
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
    throw corrupt('ongeldig invoerbereik', srcStart);
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
        if (ip >= srcEnd) throw corrupt('literal-lengte loopt voorbij het block', ip);
        byte = src[ip++]!;
        literalLength += byte;
      } while (byte === 255);
    }
    if (literalLength > 0) {
      if (literalLength > srcEnd - ip) throw corrupt('literals lopen voorbij het block', ip);
      if (literalLength > dstEnd - op) throw corrupt('uitvoer groter dan verwacht', ip);
      if (literalLength < SHORT_COPY) {
        for (const end = ip + literalLength; ip < end;) dst[op++] = src[ip++]!;
      } else {
        dst.set(src.subarray(ip, ip + literalLength), op);
        ip += literalLength;
        op += literalLength;
      }
    }

    // De laatste sequence bestaat alleen uit literals.
    if (ip >= srcEnd) break;

    // Match
    if (srcEnd - ip < 2) throw corrupt('afgebroken match-offset', ip);
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > op - windowStart) {
      throw corrupt(`ongeldige match-offset ${offset}`, ip - 2);
    }

    let matchLength = (token & 15) + MIN_MATCH;
    if ((token & 15) === 15) {
      let byte: number;
      do {
        if (ip >= srcEnd) throw corrupt('match-lengte loopt voorbij het block', ip);
        byte = src[ip++]!;
        matchLength += byte;
      } while (byte === 255);
    }
    if (matchLength > dstEnd - op) throw corrupt('uitvoer groter dan verwacht', ip);

    let mp = op - offset;
    if (matchLength < SHORT_COPY || offset < matchLength) {
      // Ook overlappende matches (offset < lengte) moeten byte voor byte: ze herhalen een patroon.
      for (const end = op + matchLength; op < end;) dst[op++] = dst[mp++]!;
    } else {
      dst.copyWithin(op, mp, mp + matchLength);
      op += matchLength;
    }
  }
  return op;
}

function readU32(src: Uint8Array, p: number): number {
  if (p + 4 > src.length) throw corrupt('onverwacht einde van de invoer', p);
  return (src[p]! | (src[p + 1]! << 8) | (src[p + 2]! << 16) | (src[p + 3]! << 24)) >>> 0;
}

export interface Lz4FrameOptions {
  /** Controleer block- en content-checksums (als het frame ze heeft). De header-checksum wordt altijd gecontroleerd. */
  readonly verifyChecksums?: boolean;
}

/**
 * Decomprimeert één of meer aaneengesloten LZ4-frames naar exact `outputSize` bytes.
 * Gooit FormatError bij corrupte invoer of een afwijkende uitvoergrootte.
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
      if (ip > src.length) throw corrupt('skippable frame loopt voorbij de invoer', ip);
      continue;
    }
    if (magic !== FRAME_MAGIC) throw corrupt(`onbekende frame-magic 0x${magic.toString(16)}`, ip);
    ip += 4;

    // Frame descriptor
    const descriptorStart = ip;
    if (ip + 3 > src.length) throw corrupt('afgebroken frame descriptor', ip);
    const flags = src[ip++]!;
    const blockDescriptor = src[ip++]!;
    if (flags >>> 6 !== 1) throw corrupt(`frameversie ${flags >>> 6} niet ondersteund`, ip - 2);
    if ((flags & 0x02) !== 0 || (blockDescriptor & 0x8f) !== 0) {
      throw corrupt('gereserveerde bits gezet', ip - 2);
    }
    const independentBlocks = (flags & 0x20) !== 0;
    const hasBlockChecksum = (flags & 0x10) !== 0;
    const hasContentSize = (flags & 0x08) !== 0;
    const hasContentChecksum = (flags & 0x04) !== 0;
    if ((flags & 0x01) !== 0)
      throw corrupt('LZ4-dictionaries worden niet gebruikt door Skyrim', ip);
    const maxBlockSize = BLOCK_MAX_SIZES[(blockDescriptor >>> 4) & 7] ?? 0;
    if (maxBlockSize === 0) throw corrupt('ongeldige maximale blockgrootte', ip - 1);

    let contentSize = -1;
    if (hasContentSize) {
      const low = readU32(src, ip);
      const high = readU32(src, ip + 4);
      contentSize = high * 0x1_0000_0000 + low;
      ip += 8;
    }
    if (ip >= src.length) throw corrupt('afgebroken frame descriptor', ip);
    const headerChecksum = src[ip]!;
    if (((xxhash32(src, descriptorStart, ip - descriptorStart) >>> 8) & 0xff) !== headerChecksum) {
      throw corrupt('header-checksum klopt niet', ip);
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
      if (blockSize > maxBlockSize) throw corrupt(`block van ${blockSize} bytes te groot`, ip - 4);
      if (blockSize > src.length - ip) throw corrupt('block loopt voorbij de invoer', ip);

      if (
        verify &&
        hasBlockChecksum &&
        xxhash32(src, ip, blockSize) !== readU32(src, ip + blockSize)
      ) {
        throw corrupt('block-checksum klopt niet', ip);
      }
      if (stored) {
        if (blockSize > dst.length - op) throw corrupt('uitvoer groter dan verwacht', ip);
        dst.set(src.subarray(ip, ip + blockSize), op);
        op += blockSize;
      } else {
        op = decodeLz4Block(src, ip, ip + blockSize, dst, op, independentBlocks ? op : frameStart);
      }
      ip += blockSize + (hasBlockChecksum ? 4 : 0);
    }

    if (hasContentSize && op - frameStart !== contentSize) {
      throw corrupt(`frame bevat ${op - frameStart} bytes, header zegt ${contentSize}`, ip);
    }
    if (hasContentChecksum) {
      if (verify && xxhash32(dst, frameStart, op - frameStart) !== readU32(src, ip)) {
        throw corrupt('content-checksum klopt niet', ip);
      }
      ip += 4;
    }
  }

  if (op !== outputSize) {
    throw corrupt(`${op} bytes gedecomprimeerd, ${outputSize} verwacht`, ip);
  }
  return dst;
}
