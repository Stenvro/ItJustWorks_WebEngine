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
import { blockedByActor } from '../../../src/ai/avoidance.ts';
import { movementBlocked } from '../../../src/ai/engine-packages.ts';
import { PROCEDURES } from '../../../src/ai/procedure-runs.ts';
import { PROCEDURE_PARAMETERS } from '../../../src/ai/procedures.ts';
import { WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseOutfit } from '../../../src/world/actor-records.ts';
import { INI_DEFAULTS } from '../../../src/world/ini-settings.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { packageCensus, type PackageCensus } from '../../../tools/package-census.ts';
import { lasting, pack, packageActor, procedure, tick } from '../../helpers/packages.ts';
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
  // Avoid Player (CommonLibSSE kAvoidPlayer): src/ai/engine-packages.test.ts.
  // React To Destroyed Object, Get Up From Chair Or Bed, Steal Warning, Surface: their procedures
  // and starts, src/ai/engine-packages.test.ts (who starts React To Destroyed Object and its length
  // are inferred). Pickpocket Warning is never made, as in the original (its comment there).
  // Vampire Feed and Cannibal: the natives StartVampireFeed and StartCannibal
  // (src/scripting/runtime/engine-events.test.ts, tests/magic-world.int.test.ts); whether the
  // original runs them as packages of its own was not read.

  // The movers' rule for one in the way (src/ai/avoidance.ts blockedByActor, which
  // src/shell/actor-movers.ts follows): after fMaxTimeBlockedByActors (observed in the original),
  // the standing player is asked first; the line and the one more wait are inferred.
  it('Avoid Player for an actor the standing player blocks: it asks them to move (inferred)', () => {
    const most = 2;
    const held = {
      blockedFor: 2.5,
      most,
      playerStanding: true,
      askedPlayer: false,
      otherTravels: false,
    };
    // Held up no longer than fMaxTimeBlockedByActors: it waits. (Stepping aside itself, its time
    // held up does not run: actor-movers.ts #blockedByActors.)
    expect(blockedByActor({ ...held, blockedFor: most })).toBe('wait');
    // Then it asks the standing player to move (its ActorCollidewithActor line), once a travel.
    expect(blockedByActor(held)).toBe('ask');
    expect(blockedByActor({ ...held, askedPlayer: true })).toBe('round');
    // A player on the move is gone round at once; an actor on its way, one of the two gives way.
    expect(blockedByActor({ ...held, playerStanding: false })).toBe('round');
    expect(blockedByActor({ ...held, playerStanding: false, otherTravels: true })).toBe('giveWay');
  });

  it('Movement Blocked is off (bUseMovementBlockedPackage 0); on, it stands for its time', async () => {
    expect(INI_DEFAULTS.General.bUseMovementBlockedPackage).toBe(0);
    let stops = 0;
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        body: {
          stop: () => {
            stops++;
          },
        },
      },
    );
    await tick(actor, 1);
    expect(actor.push('movementBlocked', movementBlocked(2))).toBe(true);
    await tick(actor, 0.1);
    expect(stops).toBeGreaterThan(0);
    expect(actor.engine()).toBeDefined();
    await tick(actor, 2);
    await tick(actor, 0.1);
    expect(actor.engine()).toBeUndefined();
  });
});

/** LvlVampireThrallMissileHold [0005186D]: DefaultHoldPositionEditorLoc256, Weapon Drawn. */
const THRALL = 0x5186d;
/** AeriREF [0001A6D2]: DefaultSleepEditorLoc24x8 at 2:00, Weapons Unequipped. */
const AERI = 0x1a6d2;
/** AsbjornRef [00019DF3]: RiftenAsbjornSleeps0x6 at 2:00, Wear Sleep Outfit; base Asbjorn. */
const ASBJORN = 0x19df3;
const ASBJORN_SLEEP = 0xded13;
/** His base's SOFT. */
const SLEEP_OUTFIT = 0x1697d;

describe.skipIf(!hasGamedata())('package flags on the gear (headless simulation)', () => {
  let sim: Sim;
  let thrall: { drawn: boolean; fighting: boolean } = { drawn: false, fighting: true };
  let aeri: {
    day: (number | undefined)[];
    asleep: (number | undefined)[];
    woken: (number | undefined)[];
    /** How many of each weapon of her day she carries after it (0 for an empty hand). */
    kept: number[];
    package?: number;
  } = { day: [], asleep: [], woken: [], kept: [] };
  let asbjorn: {
    pieces: number[];
    day: boolean;
    asleep: boolean;
    woken: boolean;
    package?: number;
  } = { pieces: [], day: true, asleep: false, woken: true };

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
    const kept = await Promise.all(
      day.map(async (weapon) => (weapon === undefined ? 0 : sim.runtime.itemCount(AERI, weapon))),
    );
    aeri = {
      day,
      asleep,
      woken: await hands(),
      kept,
      ...(pack !== undefined && { package: pack }),
    };
    // Wear Sleep Outfit: the outfit's pieces go on with his package and come off after it.
    const asbjornCell = sim.db.cellOfReference(ASBJORN);
    if (asbjornCell === undefined) throw new Error('Asbjorn has no cell');
    await sim.openInterior(asbjornCell);
    await sim.step(3);
    const outfit = await sim.db.require(SLEEP_OUTFIT);
    const pieces = parseOutfit(outfit);
    const wears = async (): Promise<boolean> => {
      for (const piece of pieces) {
        if (await equipment.isEquipped(ASBJORN, piece)) return true;
      }
      return false;
    };
    const asbjornDay = await wears();
    sim.setHour(2);
    await sim.until(() => sim.package(ASBJORN)?.id === ASBJORN_SLEEP, 20);
    await sim.step(3);
    const asbjornAsleep = await wears();
    const asbjornPack = sim.package(ASBJORN)?.id;
    sim.setHour(10);
    await sim.step(5);
    asbjorn = {
      pieces: [...pieces],
      day: asbjornDay,
      asleep: asbjornAsleep,
      woken: await wears(),
      ...(asbjornPack !== undefined && { package: asbjornPack }),
    };
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

  // The flag going gives nothing back: the weapons stay in the inventory until a fight takes
  // one up (observed in the original: Helgen's first prisoner keeps his battleaxe in his pack
  // from the cart, whose MQ101StayInCart has the flag, to the block; docs/ai.md, The gear).
  // The flag's sources above name it only, so this case once held our earlier rule, which gave
  // the weapons back as the package ended.
  it('keeps them off as that package ends, in its inventory, until a fight', () => {
    expect(aeri.woken).toEqual([undefined, undefined]);
    aeri.day.forEach((weapon, hand) => {
      if (weapon !== undefined) expect(aeri.kept[hand]).toBeGreaterThan(0);
    });
  });

  // The three vanilla actors with both (Asbjorn, Aduri Sarethi, Drifa) share SOFT [0001697D]; the
  // package's flag is what puts it on and its end what takes it off.
  it('wears its sleep outfit (NPC_ SOFT) while its package has Wear Sleep Outfit (18 packages)', () => {
    expect(asbjorn.package).toBe(ASBJORN_SLEEP);
    expect(asbjorn.pieces.length).toBeGreaterThan(0);
    expect(asbjorn.day).toBe(false);
    expect(asbjorn.asleep).toBe(true);
    expect(asbjorn.woken).toBe(false);
  });
});
