// Bouwt LZ4-frames voor tests. Geen echte compressor: blocks worden aangeleverd
// (handgemaakt) of als literal-only block gecodeerd.

import { xxhash32 } from '../../src/formats/lz4/xxhash32.ts';

export interface FrameBlock {
  readonly data: Uint8Array;
  /** Ongecomprimeerd opgeslagen (hoogste bit van de blockgrootte). */
  readonly stored?: boolean;
}

export interface FrameOptions {
  readonly independentBlocks?: boolean;
  readonly blockChecksum?: boolean;
  readonly contentSize?: number;
  /** Ongecomprimeerde inhoud; zet de content-checksum. */
  readonly contentChecksumOf?: Uint8Array;
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function buildFrame(blocks: readonly FrameBlock[], options: FrameOptions = {}): Uint8Array {
  const flags =
    0x40 |
    ((options.independentBlocks ?? true) ? 0x20 : 0) |
    (options.blockChecksum ? 0x10 : 0) |
    (options.contentSize !== undefined ? 0x08 : 0) |
    (options.contentChecksumOf ? 0x04 : 0);
  const descriptor = [flags, 0x40];
  if (options.contentSize !== undefined) descriptor.push(...u32(options.contentSize), 0, 0, 0, 0);
  const headerChecksum = (xxhash32(Uint8Array.from(descriptor)) >>> 8) & 0xff;

  const out: number[] = [...u32(0x184d2204), ...descriptor, headerChecksum];
  for (const block of blocks) {
    out.push(...u32(block.data.length | (block.stored ? 0x80000000 : 0)), ...block.data);
    if (options.blockChecksum) out.push(...u32(xxhash32(block.data)));
  }
  out.push(...u32(0));
  if (options.contentChecksumOf) out.push(...u32(xxhash32(options.contentChecksumOf)));
  return Uint8Array.from(out);
}

/** Codeert data als één LZ4-block met alleen literals (geldig, maar zonder compressie). */
export function literalBlock(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  if (data.length < 15) {
    out.push(data.length << 4);
  } else {
    out.push(0xf0);
    let rest = data.length - 15;
    while (rest >= 255) {
      out.push(255);
      rest -= 255;
    }
    out.push(rest);
  }
  out.push(...data);
  return Uint8Array.from(out);
}

/**
 * Literal-only frame. Blocks van 60 KiB, zodat een gecodeerd block (data plus lengtebytes)
 * onder de maximale blockgrootte van 64 KiB blijft.
 */
export function literalFrame(data: Uint8Array): Uint8Array {
  const chunk = 0xf000;
  const blocks: FrameBlock[] = [];
  for (let i = 0; i < data.length; i += chunk) {
    blocks.push({ data: literalBlock(data.subarray(i, i + chunk)) });
  }
  return buildFrame(blocks, { contentChecksumOf: data });
}
