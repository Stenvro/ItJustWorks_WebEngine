// Integration test: every BSA archive in the local game data. Skipped without game data.

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BsaArchive, type BsaEntry } from '../src/formats/bsa/bsa.ts';
import { GAMEDATA_DIR, hasGamedata, resolveDataFile } from '../tools/gamedata-path.ts';
import { NodeFileSource } from '../tools/node-game-folder.ts';

const archives = hasGamedata()
  ? readdirSync(GAMEDATA_DIR).filter((name) => name.toLowerCase().endsWith('.bsa'))
  : [];

const startsWith = (data: Uint8Array, offset: number, magic: readonly number[] | string): boolean =>
  (typeof magic === 'string'
    ? Array.from({ length: magic.length }, (_, i) => magic.charCodeAt(i))
    : magic
  ).every((byte, i) => data[offset + i] === byte);

/** Checks the content based on the extension (known magic bytes). */
function checkContent(path: string, data: Uint8Array): void {
  const extension = path.slice(path.lastIndexOf('.'));
  const ok = ((): boolean => {
    switch (extension) {
      case '.dds':
        return startsWith(data, 0, 'DDS ');
      case '.nif':
        return startsWith(data, 0, 'Gamebryo File Format');
      case '.hkx':
        return startsWith(data, 0, [0x57, 0xe0, 0xe0, 0x57, 0x10, 0xc0, 0xc0, 0x10]);
      case '.xwm':
        return startsWith(data, 0, 'RIFF') && startsWith(data, 8, 'XWMA');
      case '.wav':
        return startsWith(data, 0, 'RIFF') && startsWith(data, 8, 'WAVE');
      case '.fuz':
        return startsWith(data, 0, 'FUZE');
      case '.pex':
        return startsWith(data, 0, [0xfa, 0x57, 0xc0, 0xde]);
      case '.swf':
        return ['FWS', 'CWS', 'GFX', 'CFX'].some((magic) => startsWith(data, 0, magic));
      default:
        return true;
    }
  })();
  expect(ok, `content of ${path} does not match ${extension}`).toBe(true);
}

/** Start, end and an evenly spaced sample. */
function sample(entries: readonly BsaEntry[], count = 24): BsaEntry[] {
  const step = Math.max(1, Math.floor(entries.length / count));
  const picked = new Set<BsaEntry>(entries.slice(0, 3).concat(entries.slice(-3)));
  for (let i = 0; i < entries.length; i += step) {
    const entry = entries[i];
    if (entry) picked.add(entry);
  }
  return [...picked];
}

describe.skipIf(archives.length === 0)('BSA archives in the local game data', () => {
  it.each(archives)('%s: index, hashes and a sample of files', async (name) => {
    const archive = await BsaArchive.open(await NodeFileSource.open(resolveDataFile(name)), {
      verifyHashes: true,
    });
    try {
      expect(archive.header.version).toBe(105);
      expect(archive.hasNames).toBe(true);
      expect(archive.entries).toHaveLength(archive.header.fileCount);
      for (const entry of sample(archive.entries)) {
        const data = await archive.read(entry);
        expect(data.length).toBeGreaterThan(0);
        checkContent(entry.path ?? '', data);
      }
    } finally {
      await archive.close();
    }
  });
});
