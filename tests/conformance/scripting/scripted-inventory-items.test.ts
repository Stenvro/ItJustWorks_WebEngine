// Conformance: items with scripts of their own that a script gives to a container (AddItem), and
// the editor location of a unique actor (engine map: Scripting > Script events, Locations). In
// the headless simulation (the items) and on the runtime over the records (the locations).
// Skipped without game data.
//
// Sources, the data (Skyrim.esm, Dawnguard.esm):
// - dunTreasMapWhiterun [000F33D1]: a BOOK with dunTreasMapScript, whose OnContainerChanged
//   goes to state done (onEndState, then onBeginState);
// - LItemDawnguardWarAxe [0201421E]: a leveled list of one entry, chance none 0, that gives
//   DLC1DawnguardAxe [0200D098], a WEAP with scripts;
// - DA08's Whispering Door key: given by AddItem, it sets the quest's stage from its own
//   OnContainerChanged (tests/sim-the-whispering-door.int.test.ts);
// - TolfdirTheWhiteRef [0001C1A1]: persist location (XLCN) WinterholdCollegeLocation
//   [00076F3A]; the college's unique actor list (LCUN) gives him WinterholdCollegeDormitory2
//   Location [000D16E5], a location inside the college;
// - AeriREF [0001A6D2]: XLCN Anga's Mill [00018C8B], LCUN AngasMillAerisHouseLocation [0002004B];
// - DA09DragonPriestRef [00029D87]: XLCN KilkreathRuinsLocation [00019260], in no unique actor
//   list.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const TREASURE_MAP = 0xf33d1;
const DAWNGUARD_WAR_AXE_LIST = 0x0201421e;
const DAWNGUARD_AXE = 0x0200d098;
const TOLFDIR = 0x1c1a1;
const COLLEGE = 0x76f3a;
const DORMITORY_2 = 0xd16e5;
const AERI = 0x1a6d2;
const ANGAS_MILL = 0x18c8b;
const AERIS_HOUSE = 0x2004b;
const DRAGON_PRIEST = 0x29d87;
const KILKREATH = 0x19260;

describe.skipIf(!hasGamedata())('items with scripts given by AddItem (headless simulation)', () => {
  let sim: Sim;
  let mapAt = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    const { runtime } = sim;
    mapAt = sim.time;
    await runtime.addItem(PLAYER_REF, runtime.formHandle(TREASURE_MAP), 1, true);
    await sim.step(0.5);
    await runtime.addItem(PLAYER_REF, runtime.formHandle(DAWNGUARD_WAR_AXE_LIST), 1, true);
    await sim.step(0.5);
  }, 600_000);

  afterAll(async () => {
    await sim.close();
  });

  it('makes the given treasure map a reference in the player, whose script hears it arrive', () => {
    const moved = sim.itemsMoved().find((event) => event.item === TREASURE_MAP);
    expect(moved?.to).toBe(PLAYER_REF);
    const map = moved?.reference;
    expect(map).toBeDefined();
    const events = sim
      .scriptEvents({ target: map ?? 0, since: mapAt })
      .filter((event) => event.alias === undefined);
    expect(events.find((event) => event.event === 'OnContainerChanged')?.args).toEqual([
      { form: PLAYER_REF },
      null,
    ]);
    // Its script went from waiting to done.
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['onEndState', 'onBeginState']),
    );
  });

  it('gives what a leveled list resolves to, an item with scripts as a reference', async () => {
    const moved = sim.itemsMoved().filter((event) => event.to === PLAYER_REF);
    // The list itself is never held nor told; its axe is.
    expect(moved.some((event) => event.item === DAWNGUARD_WAR_AXE_LIST)).toBe(false);
    const axe = moved.find((event) => event.item === DAWNGUARD_AXE);
    expect(axe?.count).toBe(1);
    expect(axe?.reference).toBeDefined();
    expect(await sim.runtime.itemCount(PLAYER_REF, DAWNGUARD_AXE)).toBe(1);
    expect(await sim.runtime.itemCount(PLAYER_REF, DAWNGUARD_WAR_AXE_LIST)).toBe(0);
  });
});

describe.skipIf(!hasGamedata())('a unique actor’s editor location (the records)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    runtime = new ScriptRuntime(db, new ScriptLibrary((name) => db.script(name)));
  }, 120_000);

  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('is the one its location’s unique actor list gives, before its persist location', async () => {
    expect(await runtime.editorLocation(TOLFDIR)).toBe(DORMITORY_2);
    expect(await runtime.editorLocation(AERI)).toBe(AERIS_HOUSE);
  });

  it('lies within its persist location, so asking for that still finds the actor', async () => {
    expect(await runtime.locationWithin(DORMITORY_2, COLLEGE)).toBe(true);
    expect(await runtime.locationWithin(AERIS_HOUSE, ANGAS_MILL)).toBe(true);
  });

  it('is its persist location for an actor no unique actor list names', async () => {
    expect(await runtime.editorLocation(DRAGON_PRIEST)).toBe(KILKREATH);
  });
});
