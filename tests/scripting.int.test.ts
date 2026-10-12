// Integration test: compiled scripts and player homes played in the Papyrus VM, on the local
// game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePex } from '../src/formats/pex/pex.ts';
import { loadCellData, type CellData } from '../src/world/cell-loader.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../src/world/cell-upgrades.ts';
import {
  findHomeActions,
  fullyUpgraded,
  NEW_GAME,
  playHomeActions,
  ScriptEnvironment,
  type HomeActions,
  type HomeChoices,
} from '../src/world/player-home.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const BREEZEHOME = 0x000165a8;

describe.skipIf(!hasGamedata())('Papyrus scripts on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let env: ScriptEnvironment;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    env = await ScriptEnvironment.create(db, vfs);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const shown = async (
    data: CellData,
    actions: HomeActions,
    choices: HomeChoices,
  ): Promise<{ count: number; on: (id: number) => boolean }> => {
    const result = await playHomeActions(env, actions, choices);
    const toggles = findToggles(data, actions.controlled);
    const on = enabledReferences(data, toggles, gameStartSelection(toggles), result.enabled);
    return { count: data.objects.filter((o) => on(o.reference)).length, on };
  };

  it('parses every compiled script', async () => {
    const scripts = vfs.list('scripts').filter((path) => path.endsWith('.pex'));
    expect(scripts.length).toBeGreaterThan(10_000);
    for (const path of scripts) parsePex(await vfs.read(path));
  }, 120_000);

  it("plays Breezehome's steward purchases with the game's dialogue scripts", async () => {
    const data = await loadCellData(db, BREEZEHOME);
    const actions = await findHomeActions(env, data);
    const labels = actions.purchases.map((p) => p.label);
    expect(labels).toContain('Kitchen furnishings. (300 gold)');
    expect(labels).toContain('Alchemy laboratory. (500 gold)');
    expect(actions.house).toBeUndefined();

    const kitchen = actions.purchases.find((p) => p.label.startsWith('Kitchen'));
    if (!kitchen) throw new Error('no kitchen purchase');
    const marker = [...data.references].find(
      ([, s]) => s.editorId === 'WhiterunPlayerHouseDecorateKitchen',
    )?.[0];
    const start = [...data.references].find(
      ([, s]) => s.editorId === 'WhiterunPlayerHouseKitchenStart',
    )?.[0];
    if (marker === undefined || start === undefined) throw new Error('kitchen markers missing');
    const bought = await playHomeActions(env, actions, {
      ...NEW_GAME,
      purchases: new Set([kitchen.info]),
    });
    expect(bought.enabled.get(marker)).toBe(true);
    expect(bought.enabled.get(start)).toBe(false);

    expect((await shown(data, actions, NEW_GAME)).count).toBe(108);
    expect((await shown(data, actions, fullyUpgraded(actions, NEW_GAME))).count).toBeGreaterThan(
      300,
    );
  }, 120_000);

  it('builds Lakeview Manor at the drafting table and workbenches like a player', async () => {
    const cell = (await db.interiorCells()).find((c) => c.editorId === 'BYOHHouse1Falkreath');
    if (!cell) throw new Error('Lakeview Manor missing');
    const data = await loadCellData(db, cell.formId);
    const actions = await findHomeActions(env, data);
    const { house } = actions;
    if (!house) throw new Error('no HearthFire house');
    expect(house.wings.map((w) => w.name)).toEqual(['West Wing', 'North Wing', 'East Wing']);
    expect(house.wings[0]?.rooms).toEqual(['Bedrooms', 'Greenhouse', "Enchanter's Tower"]);

    const plot = await shown(data, actions, NEW_GAME);
    const small = await shown(data, actions, {
      ...fullyUpgraded(actions, NEW_GAME),
      stage: 'small house',
    });
    const full = await shown(data, actions, fullyUpgraded(actions, NEW_GAME));
    expect(plot.count).toBeLessThan(small.count);
    expect(small.count).toBeLessThan(full.count);

    const byName = (name: string): number => {
      const found = [...data.references].find(([, s]) => s.editorId === name)?.[0];
      if (found === undefined) throw new Error(`${name} missing`);
      return found;
    };
    // Only main hall style A can be built (iHouseStyles = 1); the wing doors replace the
    // walls without doors.
    expect(full.on(byName('BYOHHouse1Room02APart017Walls1LeftDOOR'))).toBe(true);
    expect(full.on(byName('BYOHHouse1Room02APart017Walls1LeftNoDoor'))).toBe(false);
    expect(full.on(byName('BYOHHouse1Room02CPart054Walls1LeftDOOR'))).toBe(false);
    // The small house's own furniture moved out when it became the entryway.
    expect(small.on(byName('BYOHHouse1InteriorRoom01Part045BedDouble01'))).toBe(true);
    expect(full.on(byName('BYOHHouse1InteriorRoom01Part045BedDouble01'))).toBe(false);
  }, 300_000);
});
