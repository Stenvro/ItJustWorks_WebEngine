import { describe, expect, it } from 'vitest';
import { bsCrc32 } from './crc32.ts';

/** Bit-by-bit CRC-32 (reflected 0xEDB88320, start 0, no final inversion) as the reference. */
function reference(text: string): number {
  let crc = 0;
  for (const char of text) {
    crc ^= char.charCodeAt(0) & 0xff;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
}

describe('bsCrc32', () => {
  it('is 0 for the empty string (no initial or final inversion)', () => {
    expect(bsCrc32('')).toBe(0);
  });

  it('matches the bitwise definition', () => {
    for (const text of ['a', 'abc', '123456789', 'meshes\\actors\\test\\animations', 'walkloop']) {
      expect(bsCrc32(text)).toBe(reference(text));
    }
  });

  it('differs from the zlib CRC-32 by the inversions', () => {
    // zlib's CRC-32 of "123456789" is 0xCBF43926; without the start and end inversions the
    // same table gives another value.
    expect(bsCrc32('123456789')).not.toBe(0xcbf43926);
    expect(bsCrc32('123456789')).toBe(reference('123456789'));
  });
});
