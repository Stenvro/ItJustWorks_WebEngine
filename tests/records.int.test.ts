// Integration test: the record database and Breezehome on the local game data.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCellData } from '../src/world/cell-loader.ts';
import { parseAddonNode } from '../src/world/cell-records.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { propertyMaterial } from '../src/render/model-data.ts';
import {
  parseMaterialObject,
  parseStaticDirectional,
  LOD_MATERIALS,
} from '../src/world/material-object.ts';
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

  it('reads the add-on nodes (ADDN) with unique indices and existing models', async () => {
    const indices = new Set<number>();
    for (const formId of db.formIdsOfType('ADDN')) {
      const record = await db.get(formId);
      if (!record) continue;
      const addon = parseAddonNode(record);
      expect(indices.has(addon.index), record.editorId).toBe(false);
      indices.add(addon.index);
      expect(addon.model && vfs.has(addon.model), record.editorId).toBe(true);
    }
    // Candle flames (49), torch fire (46) and chimney smoke (56) among them.
    for (const index of [46, 49, 56]) expect(indices.has(index)).toBe(true);
  });

  it('reads the material objects: single pass with a colour, multi-pass with a shader', async () => {
    const singlePass: string[] = [];
    const multiPass: string[] = [];
    for (const formId of db.formIdsOfType('MATO')) {
      const record = await db.get(formId);
      if (!record) continue;
      const material = parseMaterialObject(record);
      expect(material.noiseUVScale, material.editorId).toBeGreaterThan(0);
      if (material.singlePass) {
        singlePass.push(material.editorId);
        expect(Math.max(...material.singlePassColor), material.editorId).toBeGreaterThan(0);
        continue;
      }
      // Multi-pass materials keep their shader in DNAM (embedded NIF files); a few test
      // materials have none and draw nothing.
      const pass = propertyMaterial(material.properties.map((data) => parseNif(data)));
      if (material.properties.length > 0) {
        expect(pass.material, material.editorId).toBeDefined();
        multiPass.push(material.editorId);
      }
    }
    expect(singlePass).toContain('SnowMaterialObject1P');
    expect(multiPass).toContain('IceShader01');
    // The engine's object LOD snow and ash.
    for (const { plugin, id } of Object.values(LOD_MATERIALS)) {
      const formId = db.formIdOf(plugin, id);
      expect(formId, plugin).toBeDefined();
      expect((await db.get(formId ?? 0))?.type, plugin).toBe('MATO');
    }
  });

  it('finds the directional materials of statics', async () => {
    let withMaterial = 0;
    let snow = 0;
    for (const formId of db.formIdsOfType('STAT')) {
      const record = await db.get(formId);
      const directional = record && parseStaticDirectional(record);
      if (!directional) continue;
      if (directional.consideredSnow) snow++;
      if (directional.material === 0) continue;
      withMaterial++;
      expect((await db.get(directional.material))?.type, record.editorId).toBe('MATO');
      expect(directional.maxAngle, record.editorId).toBeGreaterThanOrEqual(0);
      expect(directional.maxAngle, record.editorId).toBeLessThanOrEqual(180);
    }
    // Vanilla + DLC: about 2500 statics with a material, a few hundred counted as snow.
    expect(withMaterial).toBeGreaterThan(2000);
    expect(snow).toBeGreaterThan(100);
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
