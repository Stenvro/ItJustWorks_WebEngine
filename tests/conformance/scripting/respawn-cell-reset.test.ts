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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cellReturn,
  RESET_DEFAULTS,
  respawnDue,
  type ResetWaits,
} from '../../../src/scripting/runtime/cell-reset.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { worldRulesCensus, type WorldRulesCensus } from '../../../tools/world-rules-census.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

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

describe('what a reset restores', () => {
  it.todo(
    'refills a container whose base Respawns with its records’ items, its leveled lists picked ' +
      'anew (CONT DATA 0x02; the reset’s inventory reset)  [original] (sim)',
  );
  it.todo(
    'keeps the items of a container whose base does not Respawn (a player’s chest)  [original] (sim)',
  );
  it.todo(
    'brings back a dead actor whose base Respawns, alive at its editor place, leveled anew ' +
      '(NPC_ ACBS 0x08; a leveled actor unless No Respawn)  [original] (sim)',
  );
  it.todo(
    'removes the corpse of an actor that does not respawn once dead longer than ' +
      'iHoursToClearCorpses (24), unless it started dead  [original] (sim)',
  );
  it.todo(
    'puts an object that is not persistent back at its editor place; a persistent one keeps ' +
      'its moved place  [original] (sim)',
  );
  it.todo(
    'closes and locks doors and containers again as the plugin placed them  [original] (sim)',
  );
  it.todo('lets harvested flora grow again with its cell (FLOR, TREE)  [original] (sim)');
  it.todo(
    'levels the encounter zone anew as it is next met after a reset (ECZN; Match PC Below ' +
      'Minimum)  [original: the zone level is not read yet]',
  );
  it.todo(
    'restores a reference’s initial enable state, if the engine’s reset does (an enable call ' +
      'with the reference’s state is read, not whether it is the initial state)  [original]',
  );
  it.todo(
    'resets an actor by its own clock (the engine keeps a time on each actor that its respawn ' +
      'waits from; what sets it is not read)  [original]',
  );
  it.todo(
    'removes what the player dropped in the cell as it resets, if the engine does  [UESP ' +
      '"Skyrim:Respawning"; original unread]',
  );
  it.todo('resets a cell the player is jailed in at once (its detach time forced)  [original]');
});
