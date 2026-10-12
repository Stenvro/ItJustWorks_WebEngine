// Integration test against the local game data. Skipped if it is not present.

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkDataFolder } from '../src/vfs/data-folder-check.ts';
import { GAMEDATA_DIR, hasGamedata } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())(`local game data (${GAMEDATA_DIR})`, () => {
  it('is a complete Skyrim Special Edition Data folder', () => {
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
