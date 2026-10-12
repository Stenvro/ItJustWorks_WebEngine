import { describe, expect, it } from 'vitest';
import { detectGameFile, MAX_FILE_BYTES } from './gamefile-detect.ts';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('detectGameFile', () => {
  it('laat gewone bronbestanden door', () => {
    expect(detectGameFile('src/main.ts', 100, text('import x'))).toBeUndefined();
    expect(detectGameFile('README.md', 10, text('# Skyrim'))).toBeUndefined();
    expect(detectGameFile('.gitignore', 10, text('*.bsa'))).toBeUndefined();
  });

  it('blokkeert op extensie, hoofdletterongevoelig', () => {
    expect(detectGameFile('Data/Skyrim.ESM', 1, new Uint8Array())).toMatch(/\.esm/);
    expect(detectGameFile('a/b/foo.dds', 1, new Uint8Array())).toMatch(/\.dds/);
  });

  it('blokkeert hernoemde gamebestanden op inhoud', () => {
    expect(detectGameFile('fixture.bin', 64, text('BSA\0\x69\0\0\0'))).toMatch(/BSA/);
    expect(detectGameFile('model.bin', 64, text('Gamebryo File Format, Version 20'))).toMatch(
      /NIF/,
    );
    expect(detectGameFile('x', 4, Uint8Array.of(0xfa, 0x57, 0xc0, 0xde))).toMatch(/PEX/);
    expect(detectGameFile('voice.bin', 16, text('RIFF\0\0\0\0XWMAfmt '))).toMatch(/xWMA/);
  });

  it('blokkeert grote bestanden', () => {
    expect(detectGameFile('blob.bin', MAX_FILE_BYTES + 1, new Uint8Array())).toMatch(/groter/);
  });

  it('ziet een punt in een mapnaam niet als extensie', () => {
    expect(detectGameFile('foo.esm/readme', 1, text('hi'))).toBeUndefined();
  });
});
