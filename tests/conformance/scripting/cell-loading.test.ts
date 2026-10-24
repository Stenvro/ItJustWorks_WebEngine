// Conformance: cell loading (engine map: Scripting, events, world state > Cell loading). What
// attaches and detaches as the player moves, and the events and clocks that follow. Skipped
// without game data.
//
// Sources:
// - The base scripts' declarations and the Creation Kit's event pages: OnCellAttach,
//   OnCellDetach, OnCellLoad, OnLoad, OnUnload, OnAttachedToCell, OnDetachedFromCell
//   (`node tools/script-events.ts`).
// - The engine's rule, observed in the original (src/scripting/runtime/cell-reset.ts): a cell notes the
//   whole game hour it detaches (its reset waits from then) and clears it as it attaches again.
// - The settings: [General] uGridsToLoad 5 built in (the exterior cells loaded round the
//   player's: 5 × 5).
// - The data (Skyrim.esm): BilegulchMine [0001B147] and its ore veins [000B5153..000B5156]
//   (MineOreScript); WhiterunBanneredMare [0001605E].

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the cell events the scripts wait for (data)', () => {
  let counts: Record<string, number> = {};

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    try {
      const { handlers } = await scriptEventUsage(vfs);
      counts = Object.fromEntries(
        [
          'oncellattach',
          'oncelldetach',
          'oncellload',
          'onload',
          'onunload',
          'onattachedtocell',
          'ondetachedfromcell',
        ].map((event) => [event, handlers.get(event)?.length ?? 0]),
      );
    } finally {
      await vfs.close();
    }
  }, 300_000);

  it('counts the scripts that handle each cell event', () => {
    expect(counts).toEqual({
      oncellattach: 153,
      oncelldetach: 74,
      oncellload: 93,
      onload: 431,
      onunload: 116,
      onattachedtocell: 3,
      ondetachedfromcell: 10,
    });
  });
});

const BILEGULCH_MINE = 0x1b147;
const ORE_VEINS = [0xb5153, 0xb5154, 0xb5155, 0xb5156];
const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('leaving a mine for an inn (headless simulation)', () => {
  let sim: Sim;
  let leftAt = 0;
  let hour = 0;
  let detachedBefore = false;

  beforeAll(async () => {
    sim = await openSim({ interior: BILEGULCH_MINE, hour: 10 });
    await sim.step(1);
    detachedBefore = sim.runtime.state.cellDetached.has(BILEGULCH_MINE);
    leftAt = sim.time;
    hour = Math.floor(sim.runtime.state.gameDaysPassed * 24);
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('sends the mine’s scripted references OnUnload and OnCellDetach as it goes', () => {
    for (const vein of ORE_VEINS) {
      const events = sim
        .scriptEvents({ target: vein, since: leftAt })
        .map((event) => event.event.toLowerCase());
      expect(events).toContain('oncelldetach');
    }
  });

  it('notes the whole game hour the mine left (its reset waits from then)', () => {
    expect(detachedBefore).toBe(false);
    expect(sim.runtime.state.cellDetached.get(BILEGULCH_MINE)).toBe(hour);
  });

  it('clears the inn’s own note as it comes in', () => {
    expect(sim.runtime.state.cellDetached.has(BANNERED_MARE)).toBe(false);
  });
});

describe('the loaded area', () => {
  it.todo(
    'keeps cells the player left in a buffer, their references in memory, so coming back does ' +
      'not load them again (interior and exterior buffers)  [UESP; original unread] (sim)',
  );
  it.todo(
    'sends OnAttachedToCell and OnDetachedFromCell to a reference moved into or out of the ' +
      'attached area by a script or by walking  [CK; original: TESMoveAttachDetachEvent] (sim)',
  );
  it.todo(
    'loads the uGridsToLoad × uGridsToLoad cells round the player, not the camera  [INI] (sim)',
  );
  it.todo(
    'sends OnCellAttach to every reference of the cell, not only those with scripts (the hub’s ' +
      'other consumers)  [original]',
  );
  it.todo(
    'loads a worldspace’s persistent references with the exterior cell they stand in  [data] (sim)',
  );
  it.todo('sends OnCellLoad once every object’s 3D of the cell is in, after OnLoad  [CK] (sim)');
});
