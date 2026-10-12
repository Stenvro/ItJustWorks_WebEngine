import { constants, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FormatError } from '../binary-reader.ts';
import { inflateZlib } from './inflate.ts';

/** Deterministic pseudo-random bytes. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const text = new TextEncoder().encode(
  'Let me guess... someone stole your sweetroll. '.repeat(400) + 'Fus Ro Dah!',
);

const compress = (data: Uint8Array, options: Parameters<typeof deflateSync>[1] = {}): Uint8Array =>
  new Uint8Array(deflateSync(data, options));

describe('inflateZlib', () => {
  it.each([
    ['dynamic Huffman (text)', text, {}],
    ['best compression', text, { level: 9 }],
    ['stored blocks', noise(70_000), { level: 0 }],
    ['fixed Huffman', text, { strategy: constants.Z_FIXED }],
    ['incompressible data', noise(5000, 7), {}],
    ['empty input', new Uint8Array(0), {}],
  ] as const)('matches node:zlib for %s', (_, data, options) => {
    expect(inflateZlib(compress(data, options), data.length)).toEqual(data);
  });

  it('handles long matches and overlapping copies', () => {
    const data = new Uint8Array(100_000).fill(0x41);
    data.set(noise(300, 3), 50_000);
    expect(inflateZlib(compress(data), data.length)).toEqual(data);
  });

  it('rejects a wrong size, a bad checksum and truncated input', () => {
    const packed = compress(text);
    expect(() => inflateZlib(packed, text.length + 1)).toThrow(/expected/);

    const badChecksum = packed.slice();
    badChecksum[badChecksum.length - 1] = (badChecksum.at(-1) ?? 0) ^ 0xff;
    expect(() => inflateZlib(badChecksum, text.length)).toThrow(/Adler-32/);
    expect(inflateZlib(badChecksum, text.length, { verifyChecksum: false })).toEqual(text);

    expect(() => inflateZlib(packed.subarray(0, packed.length / 2), text.length)).toThrow(
      FormatError,
    );
  });

  it('rejects streams that are not zlib', () => {
    expect(() => inflateZlib(Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0), 1)).toThrow(
      /deflate|header/,
    );
  });
});
