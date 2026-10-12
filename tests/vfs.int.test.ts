// Integratietest: de VFS op de lokale gamedata. Overgeslagen zonder gamedata.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPLICIT_MASTERS } from '../src/vfs/load-order.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { GAME_ROOT_DIR, hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('VFS op de lokale gamedata', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('mount zonder meldingen', () => {
    expect(vfs.problems).toEqual([]);
    expect(vfs.hasCreationClubList).toBe(true);
  });

  it('laadt eerst de vaste masters en daarna Creation Club in Skyrim.ccc-volgorde', () => {
    const names = vfs.loadOrder.map((e) => e.name);
    expect(names.slice(0, IMPLICIT_MASTERS.length)).toEqual([...IMPLICIT_MASTERS]);

    const ccc = readFileSync(path.join(GAME_ROOT_DIR, 'Skyrim.ccc'), 'latin1')
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase());
    const cc = names.slice(IMPLICIT_MASTERS.length);
    const positions = cc.map((name) => ccc.indexOf(name.toLowerCase()));
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Alle Creation Club-plugins zijn masters (.esm/.esl), dus de volgorde is precies die van Skyrim.ccc.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('geeft .esl-plugins een FE-index', () => {
    for (const entry of vfs.loadOrder) {
      expect(entry.lightIndex !== undefined).toBe(entry.name.toLowerCase().endsWith('.esl'));
    }
  });

  it('laadt eerst de INI-archieven en daarna de archieven van plugins', () => {
    const names = vfs.archives.map((a) => a.name);
    expect(names[0]).toBe('Skyrim - Misc.bsa');
    expect(names).toContain('Skyrim - Textures8.bsa');
    expect(names.indexOf('Skyrim - Textures8.bsa')).toBeLessThan(
      names.indexOf('ccBGSSSE001-Fish.bsa'),
    );
    expect(names).not.toContain('MarketplaceTextures.bsa');
  });

  it('leest bestanden uit verschillende archieven', async () => {
    for (const folder of ['meshes', 'textures', 'interface', 'sound', 'scripts']) {
      const first = vfs.list(folder)[0];
      expect(first, `geen bestanden onder ${folder}`).toBeDefined();
      if (first !== undefined) expect((await vfs.read(first)).length).toBeGreaterThan(0);
    }
  });
});
