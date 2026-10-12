// Integration test: the record database and Breezehome on the local game data.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCellData } from '../src/world/cell-loader.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const BREEZEHOME = 0x000165a8;

describe.skipIf(!hasGamedata())('record database on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('opens every plugin without problems', () => {
    expect(db.problems).toEqual([]);
    expect(db.plugins.map((p) => p.info.masters.length)[0]).toBe(0);
  });

  it('maps form ids between plugins and the load order', () => {
    const update = db.plugins[1];
    if (!update) throw new Error('Update.esm missing');
    // Update.esm stores Skyrim.esm records with master index 0.
    expect(db.toGlobal(update, 0x000165a8)).toBe(0x000165a8);
    expect(db.toLocal(update, 0x000165a8)).toBe(0x000165a8);
    // Its own records have master index 1 locally and mod index 01 globally.
    expect(db.toGlobal(update, 0x01000800)).toBe(0x01000800);
    const light = db.plugins.find((p) => p.entry.lightIndex === 0);
    if (!light) throw new Error('no light plugin');
    const own = (light.info.masters.length << 24) | 0x801;
    expect(db.toGlobal(light, own)).toBe(0xfe000801);
    expect(db.toLocal(light, 0xfe000801)).toBe(own);
  });

  it('reads Breezehome with its localized name and lighting template', async () => {
    const cell = await db.require(BREEZEHOME);
    expect(cell.editorId).toBe('WhiterunBreezehome');
    expect(cell.text('FULL')).toBe('Breezehome');
    const data = await loadCellData(db, BREEZEHOME);
    expect(data.cell.interior).toBe(true);
    expect(data.lighting).toBeDefined();
    expect(data.objects.length).toBeGreaterThan(80);
    expect(data.lights.length).toBeGreaterThan(0);
    expect(data.objects.every((o) => o.model.startsWith('meshes\\'))).toBe(true);
  }, 30_000);
});
