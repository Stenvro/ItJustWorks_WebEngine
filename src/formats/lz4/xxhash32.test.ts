import { describe, expect, it } from 'vitest';
import { xxhash32 } from './xxhash32.ts';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('xxhash32', () => {
  // Reference values from the official implementation (seed 0).
  it.each([
    ['', 0x02cc5d05],
    ['a', 0x550d7456],
    ['abc', 0x32d153ff],
    ['Nobody inspects the spammish repetition', 0xe2293b2f],
  ])('xxh32(%j)', (input, expected) => {
    expect(xxhash32(ascii(input))).toBe(expected);
  });

  it('hashes a subrange the same as a separate copy', () => {
    const data = ascii('xxNobody inspects the spammish repetitionyy');
    expect(xxhash32(data, 2, data.length - 4)).toBe(0xe2293b2f);
  });

  it('throws on a range outside the buffer', () => {
    expect(() => xxhash32(ascii('abc'), 2, 5)).toThrow(RangeError);
  });
});
