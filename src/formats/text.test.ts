import { describe, expect, it } from 'vitest';
import { asciiLowerCase, decodeWindows1252, encodeWindows1252 } from './text.ts';

const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);

describe('Windows-1252', () => {
  it('decodes all 256 bytes the same as TextDecoder', () => {
    expect(decodeWindows1252(allBytes)).toBe(new TextDecoder('windows-1252').decode(allBytes));
  });

  it('encode is the inverse of decode', () => {
    expect([...encodeWindows1252(decodeWindows1252(allBytes))]).toEqual([...allBytes]);
  });

  it('turns unknown characters into a question mark', () => {
    expect([...encodeWindows1252('a一')]).toEqual([0x61, 0x3f]);
  });

  it('decodes a subrange', () => {
    expect(decodeWindows1252(Uint8Array.of(0x41, 0x80, 0x42), 1, 2)).toBe('€');
  });
});

describe('asciiLowerCase', () => {
  it('changes only A-Z', () => {
    expect(asciiLowerCase('Meshes\\ÄBC.NIF')).toBe('meshes\\Äbc.nif');
  });
});
