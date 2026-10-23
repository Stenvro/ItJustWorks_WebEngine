// Integration test: the story manager's Change Location on the local game data. A new game's
// scripts run; the player walks into Riverwood, its inn and Whiterun (as the world view tells
// the runtime the cell they are in); the actor location change goes out and the story manager
// starts the quests its Change Location nodes choose. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime, type WorldBridge } from '../src/scripting/runtime/runtime.ts';
import type { GameEvents } from '../src/scripting/runtime/event-hub.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const PLAYER = 0x14;
const TAMRIEL = 0x3c;
const WHITERUN_WORLD = 0x1a26f;
const RIVERWOOD = 0x13163;
const WHITERUN = 0x18a56;
const SLEEPING_GIANT_INN = 0x133c6;
const SLEEPING_GIANT_INN_LOCATION = 0x1cb8c;
const MS13_LUCAN_CAMILLA_SCENE = 0x38386;
const BANNERED_MARE = 0x1605e;
const BANNERED_MARE_LOCATION = 0x1f86d;
/** The favors FavorChangeLocationWhiterun may start (up to five). */
const WHITERUN_FAVORS = [0xa2c9e, 0xca209, 0xca210, 0xca439, 0x7105b];
const CAMILLA = 0x13488;
const RIVERWOOD_TRADER = 0x1cb8d;

describe.skipIf(!hasGamedata())('the story events on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const world: WorldBridge = {};
  const changes: GameEvents['actorLocationChange'][] = [];
  let player: { position: [number, number, number]; cell: number; world?: number } | undefined;

  /** An exterior cell of a worldspace, by a test on its record: its form id and grid. */
  async function exteriorCell(
    worldspace: number,
    test: (xlcn: number | undefined) => boolean,
  ): Promise<{ cell: number; x: number; y: number }> {
    for (const cell of db.formIdsOfType('CELL')) {
      if (db.worldOfCell(cell) !== worldspace || db.persistentCell(worldspace) === cell) continue;
      const record = await db.get(cell);
      const xclc = record?.fields.first('XCLC');
      if (!record || !xclc || !test(record.formIdField('XLCN'))) continue;
      const view = new DataView(xclc.buffer, xclc.byteOffset, xclc.byteLength);
      return { cell, x: view.getInt32(0, true), y: view.getInt32(4, true) };
    }
    throw new Error('no such cell');
  }

  /** The player is put in a cell (the view tells it), and what that started is done. */
  async function enter(cell: number, at: { x: number; y: number } | undefined, location: number) {
    player = at
      ? {
          position: [at.x * 4096 + 2048, at.y * 4096 + 2048, 0],
          cell,
          world: db.worldOfCell(cell),
        }
      : { position: [0, 0, 0], cell };
    // Quests that start may stop at once (BardSongStarter, once the bard sings): counted by starts.
    const before = new Map([...runtime.state.quests].map(([id, state]) => [id, state.starts]));
    runtime.actorLocations.inCell(PLAYER, String(cell));
    for (let i = 0; i < 200 && runtime.state.playerLocation !== location; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Behind the Change Location in the story manager's queue: done once this is.
    await runtime.storyManager.event({
      type: 'NONE',
      forms: new Map(),
      values: new Map(),
      args: [],
    });
    await runtime.vm.idle();
    const started: string[] = [];
    for (const [id, state] of runtime.state.quests) {
      if (state.starts > (before.get(id) ?? 0))
        started.push((await runtime.forms.quest(id))?.editorId ?? id.toString(16));
    }
    return started;
  }

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    world.livePlacement = (reference) => (reference === PLAYER ? player : undefined);
    runtime = new ScriptRuntime(db, library, { world });
    runtime.events.on('actorLocationChange', (event) => {
      changes.push(event);
    });
    await runtime.newGame();
    // A morning (the intro scenes' hours) a few days in.
    runtime.state.gameDaysPassed = Math.floor(runtime.state.gameDaysPassed) + 3 + 10 / 24;
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('finds a cell’s location as the engine does: its zone’s, its own, its worldspace’s', async () => {
    // Whiterun's city cells without a location of their own are in Whiterun's.
    const city = await exteriorCell(WHITERUN_WORLD, (xlcn) => xlcn === undefined);
    expect(
      await runtime.locationAt({
        position: [city.x * 4096 + 1, city.y * 4096 + 1, 0],
        cell: undefined,
        world: WHITERUN_WORLD,
      }),
    ).toBe(WHITERUN);
  });

  it('starts Riverwood’s scenes as the player walks in', async () => {
    const riverwood = await exteriorCell(TAMRIEL, (xlcn) => xlcn === RIVERWOOD);
    const started = await enter(riverwood.cell, riverwood, RIVERWOOD);
    console.log(`Riverwood: ${started.join(', ')}`);
    expect(changes.at(-1)).toEqual({ actor: PLAYER, from: undefined, to: RIVERWOOD });
    expect(started).toContain('DialogueRiverwoodIntroScene');
    // Lucan and Camilla's scene (MS13IntroSceneNode) runs from the game's start already.
    expect(runtime.quests.isRunning(MS13_LUCAN_CAMILLA_SCENE)).toBe(true);
  }, 120_000);

  it('starts the tavern talk in an inn', async () => {
    const started = await enter(SLEEPING_GIANT_INN, undefined, SLEEPING_GIANT_INN_LOCATION);
    console.log(`The Sleeping Giant Inn: ${started.join(', ')}`);
    expect(changes.at(-1)).toEqual({
      actor: PLAYER,
      from: RIVERWOOD,
      to: SLEEPING_GIANT_INN_LOCATION,
    });
    expect(started).toContain('WIGreeting');
  }, 120_000);

  it('offers Whiterun’s favors as the player enters the city', async () => {
    // From Riverwood (FavorsNode: not out of a dwelling, as an inn is).
    const riverwood = await exteriorCell(TAMRIEL, (xlcn) => xlcn === RIVERWOOD);
    await enter(riverwood.cell, riverwood, RIVERWOOD);
    const city = await exteriorCell(WHITERUN_WORLD, (xlcn) => xlcn === undefined);
    const started = await enter(city.cell, city, WHITERUN);
    console.log(`Whiterun: ${started.join(', ')}`);
    expect(WHITERUN_FAVORS.some((quest) => runtime.quests.isRunning(quest))).toBe(true);
  }, 120_000);

  it('starts the bard’s songs in an inn with a bard', async () => {
    const started = await enter(BANNERED_MARE, undefined, BANNERED_MARE_LOCATION);
    console.log(`The Bannered Mare: ${started.join(', ')}`);
    // BardSongStarter starts the bard's song and stops (counted by its starts).
    expect(started).toContain('BardSongStarter');
  }, 120_000);

  it('tells an NPC’s location change as a script moves it, without a Change Location', async () => {
    const before = changes.length;
    const city = await exteriorCell(WHITERUN_WORLD, (xlcn) => xlcn === undefined);
    runtime.move(
      CAMILLA,
      [city.x * 4096 + 100, city.y * 4096 + 100, 0],
      undefined,
      city.cell,
      WHITERUN_WORLD,
    );
    for (let i = 0; i < 200 && changes.length === before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // From where the plugin placed her: the Riverwood Trader.
    const from = await runtime.locationAt(await runtime.editorPlace(CAMILLA));
    expect(from).toBe(RIVERWOOD_TRADER);
    expect(changes.slice(before)).toEqual([{ actor: CAMILLA, from, to: WHITERUN }]);
  }, 60_000);
});
