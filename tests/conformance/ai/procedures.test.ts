// Conformance: AI procedures (engine map: AI > Procedures): every procedure the packages run has
// a runner, every branch type runs, and what a package's flags make an actor do with its gear.
//
// Sources:
// - The procedures and branch types the trees use: `node tools/package-census.ts` (Skyrim.esm,
//   the DLCs and the Creation Club files of the maintainer's game folder, 2026-10-24).
// - The engine's own packages (those no record holds): CommonLibSSE PACKAGE_TYPE (Alarm,
//   Trespass, Spectator, ReactToDead, GetUpFromChairBed, DoNothing, InGameDialogue, Surface,
//   SearchForAttacker, AvoidPlayer, ReactToDestroyedObject, ReactToGrenadeOrMine, StealWarning,
//   PickPocketWarning, MovementBlocked, VampireFeed, Cannibal, Landing, MountActor,
//   DismountActor, ClearMountPosition). bUseMovementBlockedPackage:General is 0 by default
//   (the engine's defaults): the movement blocked package is off.
// - Weapon Drawn, Weapons Unequipped, Wear Sleep Outfit: the flags' names (xEdit, CommonLibSSE
//   PACKAGE_DATA::GeneralFlag; the Creation Kit's package dialog). The actors, from the data:
//   `node tools/package-info.ts --audit interiors --list --flag 800000` (LvlVampireThrallMissileHold
//   [0005186D] runs DefaultHoldPositionEditorLoc256 [00073FDA], Weapon Drawn, at any hour) and
//   `--flag 200000 --hour 2` (AeriREF [0001A6D2] runs DefaultSleepEditorLoc24x8 [0001B210],
//   Weapons Unequipped, 24:00 for 8 h).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCEDURES } from '../../../src/ai/procedure-runs.ts';
import { PROCEDURE_PARAMETERS } from '../../../src/ai/procedures.ts';
import { WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { packageCensus, type PackageCensus } from '../../../tools/package-census.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the procedures across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: PackageCensus;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await packageCensus(db);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 30 procedures the packages run, by package', () => {
    expect(Object.fromEntries(census.procedures)).toEqual({
      Travel: 5895,
      Sandbox: 2874,
      UnlockDoors: 1974,
      Find: 1157,
      Sit: 1030,
      Wait: 723,
      Acquire: 568,
      Patrol: 525,
      Eat: 497,
      ForceGreet: 454,
      Sleep: 444,
      LockDoors: 439,
      Follow: 234,
      HoldPosition: 226,
      Wander: 213,
      Activate: 129,
      Guard: 125,
      UseWeapon: 117,
      UseMagic: 75,
      UseIdleMarker: 74,
      Escort: 72,
      Orbit: 66,
      Shout: 45,
      KeepAnEyeOn: 37,
      Flee: 29,
      Say: 15,
      Hover: 13,
      FlightGrab: 8,
      FollowTo: 6,
      DialogueActivate: 1,
    });
  });

  it('runs every one of them, with its parameters by slot', () => {
    for (const name of census.procedures.keys()) {
      expect(PROCEDURES[name.toLowerCase()], name).toBeTypeOf('function');
      expect(PROCEDURE_PARAMETERS[name.toLowerCase()], name).toBeDefined();
    }
  });

  it('runs every branch type the trees use', () => {
    // The package runtime's branch kinds (src/ai/package-runtime.ts #branchOnce).
    const runs = new Set(['procedure', 'sequence', 'stacked', 'simultaneous', 'random']);
    expect(Object.fromEntries(census.branchTypes)).toEqual({
      Procedure: 1051,
      Sequence: 204,
      Stacked: 196,
      Simultaneous: 151,
      Random: 9,
    });
    for (const type of census.branchTypes.keys()) expect(runs.has(type.toLowerCase())).toBe(true);
  });
});

describe('the engine’s own packages (no record holds them)', () => {
  it.todo(
    'Avoid Player: an actor the player walks into steps out of the way (CommonLibSSE kAvoidPlayer)',
  );
  it.todo(
    'React To Destroyed Object: an actor near an object destroyed reacts (CommonLibSSE ' +
      'kReactToDestroyedObject; its rule to be observed in the original)',
  );
  it.todo(
    'Steal Warning and Pickpocket Warning: an owner warns the player before the crime ' +
      '(CommonLibSSE kStealWarning, kPickPocketWarning)',
  );
  it.todo(
    'Get Up From Chair or Bed: an actor in furniture whose package ends gets up through its own ' +
      'package (CommonLibSSE kGetUpFromChairBed)',
  );
  it.todo('Surface: an actor under water swims up for air (CommonLibSSE kSurface)');
  it.todo(
    'Vampire Feed and Cannibal: the player’s feeding packages (CommonLibSSE kVampireFeed, kCannibal)',
  );
  it.todo(
    'Movement Blocked: off while bUseMovementBlockedPackage:General is 0, its built-in value ' +
      '(the engine's defaults); what it does when on is to be observed in the original',
  );
});

/** LvlVampireThrallMissileHold [0005186D]: DefaultHoldPositionEditorLoc256, Weapon Drawn. */
const THRALL = 0x5186d;
/** AeriREF [0001A6D2]: DefaultSleepEditorLoc24x8 at 2:00, Weapons Unequipped. */
const AERI = 0x1a6d2;

describe.skipIf(!hasGamedata())('package flags on the gear (headless simulation)', () => {
  let sim: Sim;
  let thrall: { drawn: boolean; fighting: boolean } = { drawn: false, fighting: true };
  let aeri: {
    day: (number | undefined)[];
    asleep: (number | undefined)[];
    woken: (number | undefined)[];
    package?: number;
  } = { day: [], asleep: [], woken: [] };

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    const thrallCell = sim.db.cellOfReference(THRALL);
    if (thrallCell === undefined) throw new Error('the thrall has no cell');
    await sim.openInterior(thrallCell);
    const combat = sim.world.stage.combat;
    // Weapon Drawn: its weapon comes out before anything else makes it draw.
    await sim.until(() => combat.weaponState(THRALL) === WeaponState.drawn, 10);
    thrall = {
      drawn: combat.weaponState(THRALL) === WeaponState.drawn,
      fighting: combat.engaged(THRALL),
    };
    const aeriCell = sim.db.cellOfReference(AERI);
    if (aeriCell === undefined) throw new Error('Aeri has no cell');
    await sim.openInterior(aeriCell);
    await sim.step(3);
    const equipment = sim.runtime.equipment;
    const hands = async (): Promise<(number | undefined)[]> => [
      await equipment.weapon(AERI, 'right'),
      await equipment.weapon(AERI, 'left'),
    ];
    const day = await hands();
    // 2:00: her sleep package (Weapons Unequipped); 10:00 again: her day's package.
    sim.setHour(2);
    await sim.step(5);
    const asleep = await hands();
    const pack = sim.package(AERI)?.id;
    sim.setHour(10);
    await sim.step(5);
    aeri = { day, asleep, woken: await hands(), ...(pack !== undefined && { package: pack }) };
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('draws its weapon while its package has Weapon Drawn (659 packages, 17 overrides)', () => {
    expect(thrall.fighting).toBe(false);
    expect(thrall.drawn).toBe(true);
  });

  it('holds no weapon while its package has Weapons Unequipped (208 packages)', () => {
    expect(aeri.day.some((weapon) => weapon !== undefined)).toBe(true);
    expect(aeri.package).toBe(0x1b210);
    expect(aeri.asleep).toEqual([undefined, undefined]);
  });

  it('has its weapons back in its hands as that package ends', () => {
    expect(aeri.woken).toEqual(aeri.day);
  });

  it.todo(
    'wears its sleep outfit (NPC_ SOFT) while its package has Wear Sleep Outfit (18 packages) ' +
      '(a vanilla actor with both in a cell to be picked: C00VilkasWaitForPlayer)',
  );
});
