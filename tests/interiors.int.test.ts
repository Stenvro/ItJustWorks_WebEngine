// Integration test: interiors as the game shows them, on the local game data. Skipped
// without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildModel } from '../src/render/model-data.ts';
import { loadCellData } from '../src/world/cell-loader.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../src/world/cell-upgrades.ts';
import {
  findHomeActions,
  fullyUpgraded,
  NEW_GAME,
  playHomeActions,
  ScriptEnvironment,
} from '../src/world/player-home.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('interiors on the local game data', () => {
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

  const cellId = async (editorId: string): Promise<number> => {
    const cell = (await db.interiorCells()).find((c) => c.editorId === editorId);
    if (!cell) throw new Error(`${editorId} missing`);
    return cell.formId;
  };

  it("places models without their root node's own transform", async () => {
    // The root of this Raven Rock hut piece is turned 90°; in game its opening faces −Y.
    const model = buildModel(
      parseNif(
        await vfs.read('meshes\\dlc02\\architecture\\ravenrock\\redoran\\redoranhutintcap01.nif'),
      ),
    );
    for (const part of model.parts) {
      expect(Array.from(part.world.subarray(0, 3)).map((v) => Math.round(v))).toEqual([1, 0, 0]);
    }
  });

  it('draws skinned objects (books) in their rest pose', async () => {
    const model = buildModel(parseNif(await vfs.read('meshes\\clutter\\books\\basicbook03.nif')));
    expect(model.parts.length).toBe(3);
    expect(model.skipped).toEqual([]);
    expect(model.radius).toBeGreaterThan(10);
    expect(model.radius).toBeLessThan(30);
  });

  it('loads every enable parent of large cells (Lakeview Manor has no doubled walls)', async () => {
    const data = await loadCellData(db, await cellId('BYOHHouse1Falkreath'));
    const env = await ScriptEnvironment.create(db, vfs);
    const actions = await findHomeActions(env, data);
    const result = await playHomeActions(env, actions, fullyUpgraded(actions, NEW_GAME));
    const toggles = findToggles(data, actions.controlled);
    const on = enabledReferences(data, toggles, gameStartSelection(toggles), result.enabled);
    // Every reference's enable parent is known.
    for (const state of data.references.values()) {
      if (state.parent) expect(data.references.has(state.parent.formId)).toBe(true);
    }
    // No two enabled objects with the same model at the same place.
    const seen = new Set<string>();
    let doubled = 0;
    for (const object of data.objects) {
      if (!on(object.reference)) continue;
      const key = `${object.model}|${Array.from(object.world, (v) => Math.round(v * 10)).join(',')}`;
      if (seen.has(key)) doubled++;
      seen.add(key);
    }
    expect(doubled).toBe(0);
  }, 300_000);

  it('builds the interiors without broken models or missing textures', async () => {
    for (const editorId of ['DLC2RRSeverinHouse', 'WhiterunBreezehome']) {
      const data = await loadCellData(db, await cellId(editorId));
      expect(data.skipped.filter((s) => /missing|unreadable|does not exist/.test(s))).toEqual([]);
      for (const path of new Set(data.objects.map((o) => o.model))) {
        const model = buildModel(parseNif(await vfs.read(path)));
        for (const part of model.parts) {
          const material = part.material;
          if (material?.kind !== 'lighting') continue;
          for (const texture of material.textures) {
            if (texture !== '') expect(vfs.has(texture), `${path}: ${texture}`).toBe(true);
          }
        }
      }
    }
  }, 120_000);
});
