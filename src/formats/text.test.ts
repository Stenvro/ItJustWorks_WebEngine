import { describe, expect, it } from 'vitest';
import { asciiLowerCase, decodeWindows1252, encodeWindows1252 } from './text.ts';

const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);

describe('Windows-1252', () => {
  it('decodeert alle 256 bytes gelijk aan TextDecoder', () => {
    expect(decodeWindows1252(allBytes)).toBe(new TextDecoder('windows-1252').decode(allBytes));
  });

  it('encode is de inverse van decode', () => {
    expect([...encodeWindows1252(decodeWindows1252(allBytes))]).toEqual([...allBytes]);
  });

  it('maakt onbekende tekens een vraagteken', () => {
    expect([...encodeWindows1252('a一')]).toEqual([0x61, 0x3f]);
  });

  it('decodeert een deelbereik', () => {
    expect(decodeWindows1252(Uint8Array.of(0x41, 0x80, 0x42), 1, 2)).toBe('€');
  });
});

describe('asciiLowerCase', () => {
  it('verandert alleen A-Z', () => {
    expect(asciiLowerCase('Meshes\\ÄBC.NIF')).toBe('meshes\\Äbc.nif');
  });
});
