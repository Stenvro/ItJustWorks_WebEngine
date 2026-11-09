// Conformance: respawn and cell reset (engine map: Scripting, events, world state > Respawn, cell
// reset). When a cell that left the loaded area resets as it comes back, what a reset restores,
// and the event it tells (OnReset: 73 vanilla scripts handle it). Skipped without game data.
//
// Sources:
// - The engine's rule, observed in the original (docs/scripting.md, "Cell reset and cleared locations";
//   src/scripting/runtime/cell-reset.ts): a cell notes the whole game hour it leaves; coming back
//   it resets once more than iHoursToRespawnCell hours have passed (iHoursToRespawnCellCleared
//   where its location is cleared); a cell with an encounter zone resets by the zone (Never
//   Resets keeps it; else the zone resets as it is met once its cells were away that long, and
//   its cells that left before the zone's reset reset); the reset is told to each reference
//   that may reset (TESResetEvent: OnReset); "No Respawn" references, containers whose base
//   does not Respawn and actors whose base does not Respawn keep their state.
// - The settings: iHoursToRespawnCell 72, iHoursToRespawnCellCleared 144, iHoursToClearCorpses
//   24 built in (scratchpad settings); Skyrim.esm sets the first two to 240 and 720.
// - The data (Skyrim.esm): BilegulchMine [0001B147] has BilegulchMineZone [000A3859] (flags 0)
//   and four ore veins [000B5153..000B5156] with MineOreScript, whose OnReset clears the
//   vein's depletion; BlindCliffCave01 [000152B7] has BlindCliffCaveZone [0003EBF1], flags 1
//   (Never Resets), and its lever [00077C50] carries NorLever01SCRIPT, which handles OnReset.
// - The base scripts' declarations: ObjectReference.OnReset() (`node tools/script-events.ts
//   OnReset`: 73 scripts).
// - What a reset restores (the engine's, observed in the original; docs/scripting.md): the cases
//   below play it out in Mara's Eye Den, Fort Greymoor, Bilegulch Mine, the Winking Skeever and
//   Whiterun's jail, each reference named where it is used. Inferred there (TODO(M13) in
//   src/scripting/runtime/cell-reset.ts): a dead persistent actor respawns at its editor place;
//   a jailing forces its cell's reset past a zone and for a cell met the first time; the reset
//   sets the enable state the plugins give, not one read from the engine.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cellReturn,
  RESET_DEFAULTS,
  respawnDue,
  type ResetWaits,
} from '../../../src/scripting/runtime/cell-reset.ts';
import { RecordFlag } from '../../../src/formats/esm/record.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseReference } from '../../../src/world/cell-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { worldRulesCensus, type WorldRulesCensus } from '../../../tools/world-rules-census.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** Skyrim.esm's waits (GMST iHoursToRespawnCell, iHoursToRespawnCellCleared). */
const SKYRIM: ResetWaits = { respawn: 240, cleared: 720 };

describe('the reset rule (the engine’s, observed in the original)', () => {
  it('has waited enough once more than the wait has passed since (not exactly the wait)', () => {
    expect(respawnDue(1000, 760, false, SKYRIM)).toBe(false);
    expect(respawnDue(1001, 760, false, SKYRIM)).toBe(true);
  });

  it('waits iHoursToRespawnCellCleared where the location is cleared', () => {
    expect(respawnDue(1100, 760, true, SKYRIM)).toBe(false);
    expect(respawnDue(1481, 760, true, SKYRIM)).toBe(true);
  });

  it('has always waited enough from never (0)', () => {
    expect(respawnDue(5, 0, false, SKYRIM)).toBe(true);
  });

  it('uses the engine’s built-in waits where no plugin sets them', () => {
    expect(RESET_DEFAULTS).toEqual({
      iHoursToRespawnCell: 72,
      iHoursToRespawnCellCleared: 144,
      iHoursToClearCorpses: 24,
    });
  });

  it('leaves a cell met for the first time as the plugins made it', () => {
    expect(cellReturn({ now: 9000, detached: 0, cleared: false, waits: SKYRIM })).toEqual({
      reset: false,
      returning: false,
    });
  });

  it('resets a cell without a zone by its own clock', () => {
    const back = (now: number) =>
      cellReturn({ now, detached: 100, cleared: false, waits: SKYRIM }).reset;
    expect(back(340)).toBe(false);
    expect(back(341)).toBe(true);
  });

  it('never resets a cell whose zone Never Resets', () => {
    const times = { detached: 1, attached: 9000, reset: 9000 };
    expect(
      cellReturn({
        now: 9000,
        detached: 100,
        cleared: false,
        zone: { neverResets: true, times },
        waits: SKYRIM,
      }).reset,
    ).toBe(false);
  });

  it('resets a zone’s cell that left before the zone last reset, and only such a one', () => {
    const zone = (reset: number) => ({
      neverResets: false,
      times: { detached: 0, attached: 0, reset },
    });
    const back = (reset: number) =>
      cellReturn({ now: 500, detached: 100, cleared: false, zone: zone(reset), waits: SKYRIM })
        .reset;
    expect(back(500)).toBe(true);
    expect(back(50)).toBe(false);
    expect(back(0)).toBe(false);
  });
});

describe.skipIf(!hasGamedata())('the reset’s data (load order)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: WorldRulesCensus;
  let onReset = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await worldRulesCensus(vfs, db);
    onReset = (await scriptEventUsage(vfs)).handlers.get('onreset')?.length ?? 0;
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 356 encounter zones and their flags (ECZN DATA)', () => {
    expect(census.zones).toBe(356);
    expect(census.zoneFlags).toEqual({
      neverResets: 91,
      matchPcBelowMinimum: 1,
      disableCombatBoundary: 1,
    });
    expect(census.zonesWithLocation).toBe(336);
  });

  it('counts the interiors that reset by a zone, and the 144 that never reset', () => {
    expect(census.interiorsWithZone).toBe(369);
    expect(census.interiorsNeverReset).toBe(144);
  });

  it('counts the references that never respawn and the bases that do', () => {
    expect(census.noRespawn).toBe(2766);
    expect([census.containersRespawning, census.containers]).toEqual([358, 616]);
    expect(census.npcsRespawning).toBe(3150);
  });

  it('counts the 73 scripts that handle OnReset', () => {
    expect(onReset).toBe(73);
  });
});

const BILEGULCH_MINE = 0x1b147;
const ORE_VEINS = [0xb5153, 0xb5154, 0xb5155, 0xb5156];
const BLIND_CLIFF_CAVE = 0x152b7;
const BLIND_CLIFF_LEVER = 0x77c50;
const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('a mine left and come back to (headless simulation)', () => {
  let sim: Sim;
  /** OnReset sent to the veins after 1 day away, and after 11. */
  let afterOneDay: number[] = [];
  let afterElevenDays: number[] = [];
  let settings: (number | string | undefined)[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    settings = await Promise.all(
      ['iHoursToRespawnCell', 'iHoursToRespawnCellCleared', 'iHoursToClearCorpses'].map((name) =>
        sim.runtime.gameSetting(name),
      ),
    );
    await sim.step(1);
    const veins = (since: number) =>
      sim
        .scriptEvents({ event: 'OnReset', since })
        .map((event) => event.target)
        .filter((target) => ORE_VEINS.includes(target))
        .sort();
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(sim.runtime.state.gameDaysPassed) + 1);
    let since = sim.time;
    await sim.openInterior(BILEGULCH_MINE);
    await sim.step(2);
    afterOneDay = veins(since);
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(sim.runtime.state.gameDaysPassed) + 11);
    since = sim.time;
    await sim.openInterior(BILEGULCH_MINE);
    await sim.step(2);
    afterElevenDays = veins(since);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('reads the waits from Skyrim.esm (240, 720) and the engine (24)', () => {
    expect(settings).toEqual([240, 720, undefined]);
  });

  it('does not reset the mine a day later', () => {
    expect(afterOneDay).toEqual([]);
  });

  it('resets the mine eleven days later: OnReset to each ore vein (MineOreScript)', () => {
    expect(afterElevenDays).toEqual(ORE_VEINS);
  });

  it('notes when the cell left and the zone’s clocks (whole game hours)', () => {
    const zone = sim.runtime.state.zoneTimes.get(0xa3859);
    expect(zone?.reset).toBe(Math.floor(sim.runtime.state.gameDaysPassed * 24));
  });
});

describe.skipIf(!hasGamedata())('a cave whose zone Never Resets (headless simulation)', () => {
  let sim: Sim;
  let resets: number[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BLIND_CLIFF_CAVE, hour: 10 });
    await sim.step(1);
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(sim.runtime.state.gameDaysPassed) + 40);
    const since = sim.time;
    await sim.openInterior(BLIND_CLIFF_CAVE);
    await sim.step(2);
    resets = sim.scriptEvents({ event: 'OnReset', since }).map((event) => event.target);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('tells no reset forty days later (BlindCliffCaveZone: Never Resets)', () => {
    expect(resets).not.toContain(BLIND_CLIFF_LEVER);
    expect(resets).toEqual([]);
  });
});

type Vec3 = readonly [number, number, number];
const apart = (a: Vec3 | undefined, b: Vec3 | undefined): number =>
  a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity;

/** A reference's place as its record has it (the editor's). */
async function editorPlace(sim: Sim, reference: number): Promise<Vec3> {
  const record = await sim.db.get(reference);
  if (!record) throw new Error(`No reference ${reference.toString(16)}`);
  return parseReference(record).position;
}

const locked = async (sim: Sim, reference: number): Promise<boolean> =>
  (await sim.native(sim.runtime.referenceHandle(reference), 'ObjectReference', 'IsLocked', [])) ===
  true;

/** What a container holds now: its items by base, those with a count. */
async function holds(sim: Sim, container: number): Promise<Map<number, number>> {
  const items = await sim.runtime.inventory(container);
  return new Map([...items].filter(([, count]) => count > 0));
}

// Mara's Eye Den (Skyrim.esm): MarasEyePond01 [000DBF12], its zone MarasEyePondZone [000ECF54]
// (min level 6, no max, flags 0).
const DEN = 0xdbf12;
const DEN_ZONE = 0xecf54;
/** Two LvlVampire [ACBS flags 0, TPLT LCharVampire: a leveled list]. */
const VAMPIRE = 0xdbf74;
const LATE_VAMPIRE = 0xdbfa9;
/** TreasBanditChest (CONT DATA 0x02: Respawns), locked (XLOC 25). */
const DEN_CHEST = 0xdc068;
/** EndTable01 (does not Respawn). */
const END_TABLE = 0xdc326;
/** MetalCageDoor01, locked (XLOC). */
const CAGE_DOOR = 0xdc01e;
/** CoinPurseMedium (FLOR). */
const COIN_PURSE = 0xdc3b5;
/** Quill01, not persistent. */
const QUILL = 0xdc3b1;
/** Gold001, enabled as placed. */
const DEN_GOLD = 0xdc3c7;
const GOLD = 0xf;

describe.skipIf(!hasGamedata())(
  'what a reset restores: a den left for a month (simulation)',
  () => {
    let sim: Sim;
    const before = {
      chestLocked: false,
      chestItems: 0,
      chestEmptied: -1,
      doorLocked: false,
      doorUnlocked: true,
      zoneLevel: 0,
      vampireLevel: 0,
      quillMoved: undefined as Vec3 | undefined,
      dropped: 0,
      goldEnabled: true,
    };
    const after = {
      chestLocked: false,
      chestItems: 0,
      table: new Map<number, number>(),
      doorLocked: false,
      doorOpen: -1,
      purseHarvested: true,
      quill: undefined as Vec3 | undefined,
      droppedDeleted: false,
      goldEnabled: false,
      zoneLevel: 0,
      vampireDead: true,
      vampireStaged: false,
      vampireResets: 0,
      vampireLevel: 0,
      lateVampireDead: false,
    };
    let quillEditor: Vec3 = [0, 0, 0];

    beforeAll(async () => {
      sim = await openSim({ interior: DEN, hour: 10 });
      const runtime = sim.runtime;
      runtime.godMode = true;
      await sim.step(1);
      // The vampire killed, its level and its zone's as met at the player's level 1.
      before.zoneLevel = await runtime.progression.zoneLevel(DEN_ZONE);
      before.vampireLevel = await runtime.progression.leveledLevel(VAMPIRE);
      await sim.kill(VAMPIRE);
      // The chest emptied and unlocked; the end table's items swapped for 7 gold.
      before.chestLocked = await locked(sim, DEN_CHEST);
      before.chestItems = (await holds(sim, DEN_CHEST)).size;
      await runtime.removeAllItems(DEN_CHEST, PLAYER_REF);
      before.chestEmptied = (await holds(sim, DEN_CHEST)).size;
      await sim.native(runtime.referenceHandle(DEN_CHEST), 'ObjectReference', 'Lock', [false]);
      await runtime.removeAllItems(END_TABLE, PLAYER_REF);
      await runtime.addItem(END_TABLE, runtime.formHandle(GOLD), 7, true);
      // The cage door unlocked and opened.
      before.doorLocked = await locked(sim, CAGE_DOOR);
      await sim.native(runtime.referenceHandle(CAGE_DOOR), 'ObjectReference', 'Lock', [false]);
      await sim.native(runtime.referenceHandle(CAGE_DOOR), 'ObjectReference', 'SetOpen', [true]);
      before.doorUnlocked = await locked(sim, CAGE_DOOR);
      // The coin purse harvested; the quill moved; a tankard dropped; a gold coin disabled.
      await runtime.harvest.harvest(PLAYER_REF, COIN_PURSE);
      quillEditor = await editorPlace(sim, QUILL);
      runtime.move(QUILL, [quillEditor[0] + 40, quillEditor[1], quillEditor[2] + 10]);
      const tankard = await sim.formId('MISC', 'BasicTankard01');
      await runtime.addItem(PLAYER_REF, runtime.formHandle(tankard), 1, true);
      const known = new Set(runtime.state.created.keys());
      await sim.drop(tankard);
      before.dropped = [...runtime.state.created.keys()].find((id) => !known.has(id)) ?? 0;
      await runtime.setEnabled(DEN_GOLD, false);
      before.goldEnabled = await sim.enabled(DEN_GOLD);
      await sim.step(3);
      before.quillMoved = await sim.position(QUILL);
      // Away for a month (past iHoursToRespawnCellCleared's 720 hours), the player at level 20;
      // the other vampire killed a day before the player comes back.
      await sim.openInterior(BANNERED_MARE);
      await sim.step(1);
      runtime.state.actor(PLAYER_REF).level = 20;
      const left = Math.floor(runtime.state.gameDaysPassed);
      sim.setDay(left + 30);
      await sim.kill(LATE_VAMPIRE);
      sim.setDay(left + 31);
      await sim.openInterior(DEN);
      await sim.step(2);
      after.chestLocked = await locked(sim, DEN_CHEST);
      after.chestItems = (await holds(sim, DEN_CHEST)).size;
      after.table = await holds(sim, END_TABLE);
      after.doorLocked = await locked(sim, CAGE_DOOR);
      after.doorOpen = sim.openState(CAGE_DOOR);
      after.purseHarvested = runtime.harvest.isHarvested(COIN_PURSE);
      after.quill = await sim.position(QUILL);
      after.droppedDeleted = runtime.state.references.get(before.dropped)?.deleted === true;
      after.goldEnabled = await sim.enabled(DEN_GOLD);
      after.zoneLevel = await runtime.progression.zoneLevel(DEN_ZONE);
      after.vampireDead = await runtime.actors.isDead(VAMPIRE);
      after.vampireStaged = sim.actor(VAMPIRE) !== undefined;
      after.vampireResets = runtime.state.resets.get(VAMPIRE) ?? 0;
      after.vampireLevel = await runtime.progression.leveledLevel(VAMPIRE);
      after.lateVampireDead = await runtime.actors.isDead(LATE_VAMPIRE);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('refills a container whose base Respawns with its records’ items, its leveled lists picked anew (CONT DATA 0x02; the reset’s inventory reset)  [original] (sim)', () => {
      expect(before.chestItems).toBeGreaterThan(0);
      expect(before.chestEmptied).toBe(0);
      expect(after.chestItems).toBeGreaterThan(0);
    });

    it('keeps the items of a container whose base does not Respawn (a player’s chest)  [original] (sim)', () => {
      expect([...after.table]).toEqual([[GOLD, 7]]);
    });

    it('brings back a dead actor whose base Respawns, alive at its editor place, leveled anew (NPC_ ACBS 0x08; a leveled actor unless No Respawn)  [original] (sim)', () => {
      // LvlVampire's ACBS has no Respawn flag: it respawns as a leveled actor.
      expect(after.vampireDead).toBe(false);
      expect(after.vampireStaged).toBe(true);
      expect(after.vampireResets).toBe(1);
      // Leveled anew: at its zone's level as met again (the player at 20), not the first one.
      expect(before.vampireLevel).toBeLessThan(after.vampireLevel);
    });

    it('puts the den’s quill, moved and not persistent, back at its editor place', () => {
      expect(apart(before.quillMoved, quillEditor)).toBeGreaterThan(20);
      expect(apart(after.quill, quillEditor)).toBeLessThan(16);
    });

    it('closes and locks doors and containers again as the plugin placed them  [original] (sim)', () => {
      expect([before.chestLocked, before.doorLocked, before.doorUnlocked]).toEqual([
        true,
        true,
        false,
      ]);
      expect(after.chestLocked).toBe(true);
      expect(after.doorLocked).toBe(true);
      expect(after.doorOpen === 0 || after.doorOpen === 3).toBe(true);
    });

    it('lets harvested flora grow again with its cell (FLOR, TREE)  [original] (sim)', () => {
      expect(after.purseHarvested).toBe(false);
    });

    it('levels the encounter zone anew as it is next met after a reset (ECZN; Match PC Below Minimum)  [original: the zone level is not read yet]', () => {
      // MarasEyePondZone: its minimum (6) for a player of level 1; the minimum plus
      // fLevelScalingMult (Skyrim.esm 1) of the levels past it for a player of 20.
      expect(before.zoneLevel).toBe(6);
      expect(after.zoneLevel).toBe(20);
    });

    it('restores a reference’s initial enable state, if the engine’s reset does (an enable call with the reference’s state is read, not whether it is the initial state)  [original]', () => {
      expect(before.goldEnabled).toBe(false);
      expect(after.goldEnabled).toBe(true);
    });

    it('resets an actor by its own clock (the engine keeps a time on each actor that its respawn waits from; what sets it is not read)  [original]', () => {
      // Killed a day before the cell came back: the cell reset, the vampire waits on.
      expect(after.lateVampireDead).toBe(true);
    });

    it('removes what the player dropped in the cell as it resets, if the engine does  [UESP "Skyrim:Respawning"; original unread]', () => {
      expect(before.dropped).not.toBe(0);
      expect(after.droppedDeleted).toBe(true);
    });
  },
);

// Fort Greymoor (Skyrim.esm): FortGreymoor01 [0001527C], FortGreymoorZone [0003EC1B] (flags 0).
const FORT = 0x1527c;
/** Agnis: unique, without Respawn, not persistent, not dead at the start. */
const AGNIS = 0x20045;
/** An IronSword placed persistent, and one that is not. */
const PERSISTENT_SWORD = 0x8c939;
const LOOSE_SWORD = 0x51736;

describe.skipIf(!hasGamedata())('what a reset restores: a fort left twice (simulation)', () => {
  let sim: Sim;
  let agnisEnabledAfterTwoDays = true;
  let agnisDeadAfterTwoDays = false;
  const editor = new Map<number, Vec3>();
  const moved = new Map<number, Vec3 | undefined>();
  const left = new Map<number, Vec3 | undefined>();
  const back = new Map<number, Vec3 | undefined>();

  beforeAll(async () => {
    sim = await openSim({ interior: FORT, hour: 10 });
    const runtime = sim.runtime;
    runtime.godMode = true;
    await sim.step(1);
    await sim.kill(AGNIS);
    for (const sword of [PERSISTENT_SWORD, LOOSE_SWORD]) {
      const at = await editorPlace(sim, sword);
      editor.set(sword, at);
      runtime.move(sword, [at[0] + 40, at[1], at[2] + 10]);
    }
    await sim.step(3);
    for (const sword of [PERSISTENT_SWORD, LOOSE_SWORD])
      moved.set(sword, await sim.position(sword));
    // Two days away: past iHoursToClearCorpses (24), not iHoursToRespawnCell (240).
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(runtime.state.gameDaysPassed) + 2);
    await sim.openInterior(FORT);
    await sim.step(1);
    agnisEnabledAfterTwoDays = await sim.enabled(AGNIS);
    agnisDeadAfterTwoDays = await runtime.actors.isDead(AGNIS);
    // Eleven days away: the fort resets. Where each sword was left, and where it loads (before
    // physics moves it on: the persistent one, left mid-air, falls as it loads).
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    for (const sword of [PERSISTENT_SWORD, LOOSE_SWORD]) left.set(sword, await sim.position(sword));
    sim.setDay(Math.floor(runtime.state.gameDaysPassed) + 11);
    await sim.openInterior(FORT);
    for (const sword of [PERSISTENT_SWORD, LOOSE_SWORD]) back.set(sword, await sim.position(sword));
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('removes the corpse of an actor that does not respawn once dead longer than iHoursToClearCorpses (24), unless it started dead  [original] (sim)', () => {
    expect(agnisDeadAfterTwoDays).toBe(true);
    expect(agnisEnabledAfterTwoDays).toBe(false);
  });

  it('puts an object that is not persistent back at its editor place; a persistent one keeps its moved place  [original] (sim)', () => {
    for (const sword of [PERSISTENT_SWORD, LOOSE_SWORD])
      expect(apart(moved.get(sword), editor.get(sword))).toBeGreaterThan(20);
    expect(apart(back.get(LOOSE_SWORD), editor.get(LOOSE_SWORD))).toBeLessThan(16);
    expect(apart(left.get(PERSISTENT_SWORD), editor.get(PERSISTENT_SWORD))).toBeGreaterThan(20);
    expect(apart(back.get(PERSISTENT_SWORD), left.get(PERSISTENT_SWORD))).toBeLessThan(1);
  });
});

// Bilegulch Mine's boss: LvlBanditBossOrcM [ACBS 0x08: Respawns], placed persistent.
const MINE_BOSS = 0xef02b;
const MINE_DOOR = 0x1b154;

describe.skipIf(!hasGamedata())('what a reset restores: a mine’s boss (simulation)', () => {
  let sim: Sim;
  let editor: Vec3 = [0, 0, 0];
  let door: Vec3 | undefined;
  let corpse: Vec3 | undefined;
  let back: Vec3 | undefined;
  let dead = true;
  let carries = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    const runtime = sim.runtime;
    runtime.godMode = true;
    await sim.step(1);
    editor = await editorPlace(sim, MINE_BOSS);
    door = await sim.position(MINE_DOOR);
    await sim.kill(MINE_BOSS);
    // Its corpse carried off to the door and stripped.
    if (door) runtime.move(MINE_BOSS, [door[0], door[1], door[2] + 20]);
    await runtime.removeAllItems(MINE_BOSS, PLAYER_REF);
    await sim.step(2);
    corpse = await sim.position(MINE_BOSS);
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(runtime.state.gameDaysPassed) + 31);
    await sim.openInterior(BILEGULCH_MINE);
    await sim.step(2);
    dead = await runtime.actors.isDead(MINE_BOSS);
    back = await sim.position(MINE_BOSS);
    carries = (await holds(sim, MINE_BOSS)).size;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('brings back a dead persistent actor whose base Respawns alive at its editor place, its inventory its records’ again  [original] (sim)', () => {
    expect(apart(corpse, door)).toBeLessThan(200);
    expect(dead).toBe(false);
    expect(apart(back, editor)).toBeLessThan(apart(back, corpse));
    expect(apart(back, corpse)).toBeGreaterThan(300);
    expect(carries).toBeGreaterThan(0);
  });
});

// The Winking Skeever (Skyrim.esm): SolitudeWinkingSkeever [00016A0E], no encounter zone, its
// flora (coin purses); ccBGSSSE001-Fish.esm places a coin purse there flagged No Respawn
// (ccBGSSSE001_MiscSolitude_CoinPurseLarge, object 000B95).
const WINKING_SKEEVER = 0x16a0e;
const FISH_PLUGIN = 'ccBGSSSE001-Fish.esm';
const FISH_PURSE = 0xb95;

describe.skipIf(!hasGamedata())('harvested flora in an inn left eleven days (simulation)', () => {
  let sim: Sim;
  let flora: number | undefined;
  let purse: number | undefined;
  let harvested: boolean[] = [];
  let regrown: boolean[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: WINKING_SKEEVER, hour: 10 });
    const runtime = sim.runtime;
    await sim.step(1);
    purse = sim.db.formIdOf(FISH_PLUGIN, FISH_PURSE);
    for (const reference of sim.db.cellReferences(WINKING_SKEEVER)) {
      const record = await sim.db.get(reference);
      if (!record || reference === purse || (record.flags & RecordFlag.noRespawn) !== 0) continue;
      if (await runtime.harvest.flora(reference)) {
        flora = reference;
        break;
      }
    }
    const floras = [flora, purse].filter((reference) => reference !== undefined);
    for (const reference of floras) await runtime.harvest.harvest(PLAYER_REF, reference);
    harvested = floras.map((reference) => runtime.harvest.isHarvested(reference));
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    sim.setDay(Math.floor(runtime.state.gameDaysPassed) + 11);
    // A while in the other inn eleven days on, then back.
    await sim.step(3);
    await sim.openInterior(WINKING_SKEEVER);
    await sim.step(3);
    regrown = floras.map((reference) => !runtime.harvest.isHarvested(reference));
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('lets harvested flora grow again with its cell, but not one flagged No Respawn  [original] (sim)', (context) => {
    if (purse === undefined) context.skip();
    expect(flora).toBeDefined();
    expect(harvested).toEqual([true, true]);
    expect(regrown).toEqual([true, false]);
  });
});

// The Whiterun jail (Skyrim.esm): CrimeFactionWhiterun [000267EA], its prison marker in
// WhiterunDragonsreachBasement [0004A376] (no encounter zone); a cell door there, WRJailDoor01
// [0009DC35], locked (XLOC 50).
const WHITERUN_JAIL = 0x4a376;
const JAIL_DOOR = 0x9dc35;

describe.skipIf(!hasGamedata())('the cell the player is jailed in (simulation)', () => {
  let sim: Sim;
  let unlocked = true;
  let lockedAgain = false;
  let open = -1;

  beforeAll(async () => {
    sim = await openSim({ interior: WHITERUN_JAIL, hour: 10 });
    const runtime = sim.runtime;
    await sim.step(1);
    await sim.native(runtime.referenceHandle(JAIL_DOOR), 'ObjectReference', 'Lock', [false]);
    await sim.native(runtime.referenceHandle(JAIL_DOOR), 'ObjectReference', 'SetOpen', [true]);
    unlocked = !(await locked(sim, JAIL_DOOR));
    await sim.step(2);
    // Left an hour, then taken back there by the guards.
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    await runtime.crime.jail(await sim.formId('FACT', 'CrimeFactionWhiterun'), false, true);
    await sim.openAtPlayer();
    await sim.step(1);
    lockedAgain = await locked(sim, JAIL_DOOR);
    open = sim.openState(JAIL_DOOR);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('resets a cell the player is jailed in at once (its detach time forced)  [original]', () => {
    expect(unlocked).toBe(true);
    expect(lockedAgain).toBe(true);
    expect(open === 0 || open === 3).toBe(true);
  });
});
