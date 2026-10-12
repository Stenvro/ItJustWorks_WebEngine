// Integratietest tegen de lokale gamedata. Wordt overgeslagen als die er niet is.

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkDataFolder } from '../src/vfs/data-folder-check.ts';
import { GAMEDATA_DIR, hasGamedata } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())(`lokale gamedata (${GAMEDATA_DIR})`, () => {
  it('is een complete Skyrim Special Edition Data-map', () => {
    const entries = readdirSync(GAMEDATA_DIR, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
    }));
    const report = checkDataFolder(entries);

    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.plugins).toContain('Skyrim.esm');
  });
});
