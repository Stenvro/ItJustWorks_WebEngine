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
// - The engine's event sources, observed in the original: a cell's attaching tells every one of
//   its references (TESCellAttachDetachEvent), with scripts or not; a reference whose parent cell
//   changes into or out of the attached area is told so (TESMoveAttachDetachEvent); a cell
//   whose references' 3D is all in tells it once (TESCellFullyLoadedEvent).
// - UESP ("Skyrim:INI Settings"): [General] uInterior Cell Buffer 3, uExterior Cell Buffer 36:
//   the cells the player left lately are kept, with their references, so coming back does not
//   read them again. The original's own handling of the buffers is not read (the least recently
//   left goes first is inferred).
// - The settings: [General] uGridsToLoad 5 built in (the exterior cells loaded round the
//   player's: 5 × 5); a player's INI may set another odd count.
// - The data (Skyrim.esm): BilegulchMine [0001B147] and its ore veins [000B5153..000B5156]
//   (MineOreScript); WhiterunBanneredMare [0001605E], its tankards (BasicTankard01, no scripts),
//   Hulda [0001A66E] (scripts on her base), the business ledger [0006DC94]
//   (TGRFOBusinessLedger, scripted) and the inn's door [00016072] to Whiterun; RiftenPawnedPrawn
//   [00016BD9] and its strongbox [000EA73D]; the small Whiterun houses (Amren's [000165AB],
//   Ysolda's [000165AC], Heimskr's [000165AD], Olava's [000165AE]); Tamriel [0000003C] round
//   Riverwood: its persistent cell holds a blacksmith's forge [000D6987], a sharpening wheel
//   [0001C785] and a wood pile [00079AB8] (scripted) standing in the exterior cells there.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { ObjectHandle, type Value } from '../../../src/scripting/values.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseTeleport } from '../../../src/world/cell-records.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

type Vec3 = [number, number, number];

/** Steps the world until engine work is done (at most 10 s); its result. */
async function drive<T>(sim: Sim, work: Promise<T>): Promise<T | undefined> {
  let result: T | undefined;
  let done = false;
  void work.then((value) => {
    result = value;
    done = true;
  });
  await sim.until(() => done, 10);
  return result;
}

/** A function called on an object as a script calls it. */
async function call(sim: Sim, target: Value, name: string, args: Value[] = []): Promise<Value> {
  if (!(target instanceof ObjectHandle)) throw new Error(`${name}: no object`);
  return (await drive(sim, sim.runtime.vm.call(target, name, args))) ?? null;
}

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
/** BasicTankard01 in the inn, a bucket in the mine: no scripts. */
const TANKARD = 0x58cce;
const BUCKET = 0xec8e3;

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

  it(
    'sends OnCellAttach to every reference of the cell, not only those with scripts (the hub’s ' +
      'other consumers)  [original]',
    () => {
      const told = (attached: boolean): Set<number> =>
        new Set(
          sim
            .records(leftAt)
            .flatMap((record) =>
              record.kind === 'game' &&
              record.type === 'cellAttachDetach' &&
              record.event.attached === attached
                ? [record.event.reference]
                : [],
            ),
        );
      const attached = told(true);
      const detached = told(false);
      // The inn's references, a tankard without scripts among them; the mine's as it went.
      const inn = sim.db.cellReferences(BANNERED_MARE);
      const shown = sim.world.cellData(BANNERED_MARE)?.objects.map((object) => object.reference);
      expect(attached).toContain(TANKARD);
      expect(detached).toContain(BUCKET);
      expect(shown?.every((reference) => attached.has(reference))).toBe(true);
      expect(inn.filter((reference) => attached.has(reference)).length).toBeGreaterThan(600);
      // The scripts hear it only where there are scripts to hear it.
      expect(sim.scriptEvents({ target: TANKARD, since: leftAt })).toEqual([]);
    },
  );

  it('sends OnCellLoad once every object’s 3D of the cell is in, after OnLoad  [CK] (sim)', () => {
    const inn = new Set(sim.db.cellReferences(BANNERED_MARE));
    const byReference = new Map<number, string[]>();
    for (const record of sim.scriptEvents({ since: leftAt })) {
      if (!inn.has(record.target) || record.alias !== undefined) continue;
      const list = byReference.get(record.target) ?? [];
      list.push(record.event.toLowerCase());
      byReference.set(record.target, list);
    }
    const loaded = [...byReference].filter(([, events]) => events.includes('onload'));
    expect(loaded.length).toBeGreaterThan(0);
    for (const [, events] of loaded) {
      const cellEvents = events.filter((event) =>
        ['oncellattach', 'onload', 'oncellload'].includes(event),
      );
      expect(cellEvents).toEqual(['oncellattach', 'onload', 'oncellload']);
    }
    // One fully loaded event for the inn, naming it and every reference whose 3D is in.
    const full = sim
      .records(leftAt)
      .flatMap((record) =>
        record.kind === 'game' && record.type === 'cellFullyLoaded' ? [record.event] : [],
      );
    expect(full.map((event) => event.cell)).toEqual([BANNERED_MARE]);
    for (const [reference] of loaded) expect(full[0]?.references).toContain(reference);
  });
});

const PRAWN_STRONGBOX = 0xea73d;
const HULDA = 0x1a66e;
const LEDGER = 0x6dc94;
const MARE_DOOR = 0x16072;
const HOUSES = [0x165ab, 0x165ac, 0x165ad, 0x165ae] as const;

describe.skipIf(!hasGamedata())('the cells the player left (headless simulation)', () => {
  let sim: Sim;
  /** The inn's data as read: first, after three other cells, after four. */
  const inn: unknown[] = [];
  /** Hulda's and the ledger's attach events, in order. */
  let hulda: string[] = [];
  let ledger: string[] = [];
  const huldaPlaces: (number | undefined)[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    const { runtime } = sim;
    inn.push(sim.world.cellData(BANNERED_MARE));
    const since = sim.time;
    // The ledger moved away by a script, and back to the player.
    const book = runtime.referenceHandle(LEDGER);
    await call(sim, book, 'MoveTo', [runtime.referenceHandle(PRAWN_STRONGBOX), 0, 0, 0, true]);
    await sim.step(0.5);
    await call(sim, book, 'MoveTo', [runtime.referenceHandle(PLAYER_REF), 0, 0, 0, true]);
    await sim.step(0.5);
    // Hulda goes out through the inn's door and comes back in by the door outside.
    const door = await sim.db.get(MARE_DOOR);
    const outside = door && parseTeleport(door)?.door;
    await call(sim, runtime.referenceHandle(MARE_DOOR), 'Activate', [runtime.actorHandle(HULDA)]);
    await sim.step(1);
    huldaPlaces.push((await runtime.placement(HULDA))?.cell);
    if (outside !== undefined)
      await call(sim, runtime.referenceHandle(outside), 'Activate', [runtime.actorHandle(HULDA)]);
    await sim.step(1);
    huldaPlaces.push((await runtime.placement(HULDA))?.cell);
    const attachEvents = (target: number): string[] =>
      sim
        .scriptEvents({ target, since })
        .map((event) => event.event.toLowerCase())
        .filter((event) => event === 'onattachedtocell' || event === 'ondetachedfromcell');
    hulda = attachEvents(HULDA);
    ledger = attachEvents(LEDGER);

    // Three other cells, and back: the inn was kept. Four, and back: it was let go.
    for (const house of HOUSES.slice(0, 3)) {
      await sim.openInterior(house);
      await sim.step(0.5);
    }
    await sim.openInterior(BANNERED_MARE);
    await sim.step(0.5);
    inn.push(sim.world.cellData(BANNERED_MARE));
    for (const house of HOUSES) {
      await sim.openInterior(house);
      await sim.step(0.5);
    }
    await sim.openInterior(BANNERED_MARE);
    await sim.step(0.5);
    inn.push(sim.world.cellData(BANNERED_MARE));
  }, 900_000);
  afterAll(async () => {
    await sim.close();
  });

  it(
    'keeps cells the player left in a buffer, their references in memory, so coming back does ' +
      'not load them again (interior and exterior buffers)  [UESP; original unread] (sim)',
    () => {
      expect(inn[0]).toBeDefined();
      // Three cells left since (uInterior Cell Buffer 3): the inn's references as they were.
      expect(inn[1]).toBe(inn[0]);
      // Four: it was the least recently left, and is read again.
      expect(inn[2]).toBeDefined();
      expect(inn[2]).not.toBe(inn[1]);
    },
  );

  it(
    'sends OnAttachedToCell and OnDetachedFromCell to a reference moved into or out of the ' +
      'attached area by a script or by walking  [CK; original: TESMoveAttachDetachEvent] (sim)',
    () => {
      expect(ledger).toEqual(['ondetachedfromcell', 'onattachedtocell']);
      // Out through the door (her cell is Whiterun's outside), and back in.
      expect(huldaPlaces[0]).not.toBe(BANNERED_MARE);
      expect(huldaPlaces[1]).toBe(BANNERED_MARE);
      expect(hulda).toEqual(['ondetachedfromcell', 'onattachedtocell']);
    },
  );
});

const TAMRIEL = 0x3c;
const FORGE = 0xd6987;
const WHEEL = 0x1c785;
const WOOD_PILE = 0x79ab8;
const CELL = 4096;

describe.skipIf(!hasGamedata())('Riverwood with uGridsToLoad 3 (headless simulation)', () => {
  let sim: Sim;
  /** The player's cell and the loaded cells' keys, first and after a cell's walk east. */
  let centre: [number, number] = [0, 0];
  let loaded: string[] = [];
  let movedCentre: [number, number] = [0, 0];
  let movedLoaded: string[] = [];
  let grids = 0;
  /** Persistent objects placed as their cells loaded (by the grid's cell they stand in). */
  const placedPersistent = new Map<number, boolean>();
  const persistentCell = new Map<number, [number, number]>();
  let woodPileAttached = false;
  /** A cell's data before and after a trip inside; the wood pile placed where it was moved. */
  const kept: [unknown, unknown] = [undefined, undefined];
  let woodPileBack: Vec3 | undefined;
  let woodPileTarget: Vec3 | undefined;

  const around = ([x, y]: [number, number], radius: number): string[] => {
    const keys: string[] = [];
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) keys.push(`${String(x + dx)},${String(y + dy)}`);
    return keys.sort();
  };

  const cellOf = (at: readonly number[]): [number, number] => [
    Math.floor((at[0] ?? 0) / CELL),
    Math.floor((at[1] ?? 0) / CELL),
  ];

  beforeAll(async () => {
    sim = await openSim({
      exterior: { world: TAMRIEL, cell: [4, -11] },
      hour: 10,
      ini: { 'General:uGridsToLoad': 3 },
    });
    await sim.step(2);
    const { runtime } = sim;
    grids = runtime.gridsToLoad;
    const feet = [...sim.world.player.feet] as Vec3;
    centre = cellOf(feet);
    loaded = sim.world.loadedCells;
    for (const reference of [FORGE, WHEEL, WOOD_PILE]) {
      placedPersistent.set(reference, sim.world.placed(reference) !== undefined);
      const at = (await runtime.editorPlacement(reference))?.position;
      if (at) persistentCell.set(reference, cellOf(at));
    }
    woodPileAttached = sim
      .scriptEvents({ target: WOOD_PILE })
      .some((event) => event.event.toLowerCase() === 'oncellattach');

    // Inside, and out again where the player stood: the cells were kept. The wood pile, moved
    // by a script meanwhile into the player's own cell, stands there.
    woodPileTarget = [feet[0] + 300, feet[1] + 300, feet[2]];
    const target = cellOf(woodPileTarget);
    const pileCell = persistentCell.get(WOOD_PILE);
    // A cell of the grid the wood pile neither leaves nor comes into (theirs are made again).
    const keptKey = around(centre, 1).find((key) => {
      const [x = 0, y = 0] = key.split(',').map(Number);
      const same = (at: [number, number] | undefined): boolean => at?.[0] === x && at[1] === y;
      return !same(target) && !same(pileCell);
    });
    const keptCell = keptKey === undefined ? undefined : sim.world.cellFormId(keptKey);
    kept[0] = keptCell === undefined ? undefined : sim.world.cellData(keptCell);
    await sim.openInterior(BANNERED_MARE);
    await sim.step(0.5);
    const here = await sim.db.exteriorCell(TAMRIEL, target[0], target[1]);
    runtime.move(WOOD_PILE, woodPileTarget, [0, 0, 0], here, TAMRIEL);
    await sim.world.openExterior(TAMRIEL, { arrival: { position: feet, heading: 0 } });
    await sim.step(2);
    kept[1] = keptCell === undefined ? undefined : sim.world.cellData(keptCell);
    const pile = sim.world.placed(WOOD_PILE)?.instance.world;
    woodPileBack = pile && [pile[12] ?? 0, pile[13] ?? 0, pile[14] ?? 0];

    // A cell east: the grid follows the player.
    sim.world.teleportPlayer([feet[0] + CELL, feet[1], feet[2] + 200]);
    await sim.step(3);
    movedCentre = cellOf(sim.world.player.feet);
    movedLoaded = sim.world.loadedCells;
  }, 900_000);
  afterAll(async () => {
    await sim.close();
  });

  it('loads the uGridsToLoad × uGridsToLoad cells round the player, not the camera  [INI] (sim)', () => {
    expect(grids).toBe(3);
    expect([...loaded].sort()).toEqual(around(centre, 1));
    // A cell on: the grid round the player's new cell is in; nothing further than one cell
    // past it stays.
    expect(movedCentre).not.toEqual(centre);
    for (const key of around(movedCentre, 1)) expect(movedLoaded).toContain(key);
    for (const key of movedLoaded) {
      const [x = 0, y = 0] = key.split(',').map(Number);
      expect(Math.max(Math.abs(x - movedCentre[0]), Math.abs(y - movedCentre[1]))).toBeLessThan(3);
    }
  });

  it('loads a worldspace’s persistent references with the exterior cell they stand in  [data] (sim)', () => {
    const inGrid = (reference: number): boolean => {
      const at = persistentCell.get(reference);
      return (
        at !== undefined && Math.abs(at[0] - centre[0]) <= 1 && Math.abs(at[1] - centre[1]) <= 1
      );
    };
    expect(persistentCell.size).toBe(3);
    for (const reference of [FORGE, WHEEL, WOOD_PILE])
      expect(placedPersistent.get(reference)).toBe(inGrid(reference));
    expect([FORGE, WHEEL, WOOD_PILE].some(inGrid)).toBe(true);
    expect(woodPileAttached).toBe(inGrid(WOOD_PILE));
  });

  it('keeps the exterior cells left in their buffer, with what moved into them meanwhile', () => {
    expect(kept[0]).toBeDefined();
    expect(kept[1]).toBe(kept[0]);
    expect(woodPileBack).toBeDefined();
    expect(
      Math.hypot(
        (woodPileBack?.[0] ?? 0) - (woodPileTarget?.[0] ?? 0),
        (woodPileBack?.[1] ?? 0) - (woodPileTarget?.[1] ?? 0),
      ),
    ).toBeLessThan(1);
  });
});
