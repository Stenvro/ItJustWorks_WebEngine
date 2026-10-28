// Conformance: AI package evaluation (engine map: AI > Package evaluation): which package an
// actor runs, when it is chosen again, and the package flags it runs with, as its procedures'
// flag overrides leave them.
//
// Unit cases run an actor's package runtime (src/ai/package-runtime.ts) on a mind of their own
// (tests/helpers/packages.ts). The data case counts every package of the load order
// (tools/package-census.ts) and checks that each flag the data uses is one we honour, or is
// listed as not yet. The interaction case below runs a town NPC's day in the headless simulation.
//
// Sources:
// - fEvaluatePackageTimer (15 s, the engine's built-in value: the engine's defaults; Skyrim.esm keeps
//   it) and the moments it is chosen again (as the hour changes, while it has none, when a script
//   asks): observed in the original (docs/ai.md, "Packages", When).
// - PKDT's flags and PFO2's fields: xEdit (wbDefinitionsTES5 / wbPackageFlags, "Set / Clear
//   General Flags", "Preferred Speed Override") and CommonLibSSE (PACKAGE_DATA::GeneralFlag).
// - The counts: `node tools/package-census.ts` over Skyrim.esm, the DLCs and the Creation Club
//   files of the maintainer's game folder (2026-10-24).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InterruptFlag, PackageFlag } from '../../../src/ai/package-records.ts';
import { packageFlags } from '../../../src/ai/package-runtime.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { packageCensus, type PackageCensus } from '../../../tools/package-census.ts';
import {
  branch,
  condition,
  lasting,
  pack,
  packageActor,
  procedure,
  tick,
  travelling,
} from '../../helpers/packages.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

/** The engine's fEvaluatePackageTimer (the engine's defaults). */
const EVALUATE_PACKAGE_TIMER = 15;

describe('package evaluation: when a package is chosen again', () => {
  it('chooses again every fEvaluatePackageTimer (15 s), not sooner', async () => {
    const { actor, truths } = packageActor(
      [pack(1, procedure('a'), { conditions: [condition(9)] }), pack(2, procedure('b'))],
      { a: lasting, b: lasting },
    );
    await tick(actor);
    expect(actor.current?.id).toBe(2);
    truths.add(9);
    await tick(actor, EVALUATE_PACKAGE_TIMER - 1);
    expect(actor.current?.id).toBe(2);
    await tick(actor, 1);
    expect(actor.current?.id).toBe(1);
  });

  it('chooses again as the game’s hour changes', async () => {
    const { actor, truths, time } = packageActor(
      [pack(1, procedure('a'), { conditions: [condition(9)] }), pack(2, procedure('b'))],
      { a: lasting, b: lasting },
    );
    await tick(actor);
    truths.add(9);
    time.hour = 11;
    await tick(actor, 0.1);
    expect(actor.current?.id).toBe(1);
  });

  it('chooses again at once when a script asks (EvaluatePackage)', async () => {
    const { actor, truths } = packageActor(
      [pack(1, procedure('a'), { conditions: [condition(9)] }), pack(2, procedure('b'))],
      { a: lasting, b: lasting },
    );
    await tick(actor);
    truths.add(9);
    actor.evaluate();
    await tick(actor, 0.1);
    expect(actor.current?.id).toBe(1);
  });

  it('keeps a package that must complete (PKDT 0x4) until it has', async () => {
    const { actor, truths } = packageActor(
      [
        pack(1, procedure('a'), { conditions: [condition(9)] }),
        pack(2, procedure('b'), { flags: PackageFlag.mustComplete }),
      ],
      { a: lasting, b: lasting },
    );
    await tick(actor);
    truths.add(9);
    await tick(actor, EVALUATE_PACKAGE_TIMER);
    expect(actor.current?.id).toBe(2);
  });

  it('runs a package that runs once a day (PKDT 0x400) once that day', async () => {
    const done: ReturnType<typeof procedure> = procedure('done');
    const { actor } = packageActor(
      [pack(1, done, { flags: PackageFlag.oncePerDay }), pack(2, procedure('b'))],
      { done: () => Promise.resolve('success'), b: lasting },
    );
    await tick(actor);
    await tick(actor);
    await tick(actor, EVALUATE_PACKAGE_TIMER);
    expect(actor.current?.id).toBe(2);
  });

  it.todo(
    'evaluates a running procedure again every fEvaluateProcedureTimer (3 s) (the engine’s defaults; ' +
      'what it re-checks is to be observed in the original)',
  );
  it.todo(
    'goes on with its package while the player is near (PKDT 0x200 Continue If PC Near: 4 ' +
      'packages) (xEdit; the engine’s rule to be observed in the original)',
  );
  it.todo(
    'plays its fallout behaviour as a package ends without Skip Fallout Behavior (PKDT 0x1000: ' +
      '189 packages set it) (xEdit; the behaviour to be observed in the original)',
  );
  it.todo(
    'offers its services only while a package with Offers Services runs (PKDT 0x1: 85 packages) ' +
      '(xEdit, UESP Faction VENV; the engine’s check to be observed in the original)',
  );
});

describe('package evaluation: procedure flag overrides (PFO2)', () => {
  const override = (setFlags: number, clearFlags = 0, preferredSpeed?: number) => ({
    setFlags,
    clearFlags,
    setInterruptFlags: 0,
    clearInterruptFlags: 0,
    preferredSpeed,
  });

  it('sets a flag while its procedure runs, and only then (24 vanilla Travels set Ignore Combat)', async () => {
    let finish: (() => void) | undefined;
    const { actor } = packageActor(
      [
        pack(
          1,
          branch('Sequence', [
            procedure('travel', { override: override(PackageFlag.ignoreCombat) }),
            procedure('wait'),
          ]),
        ),
      ],
      {
        travel: () =>
          new Promise((resolve) => {
            finish = () => {
              resolve('success');
            };
          }),
        wait: lasting,
      },
    );
    await tick(actor);
    expect((actor.current?.flags ?? 0) & PackageFlag.ignoreCombat).not.toBe(0);
    finish?.();
    await tick(actor);
    expect(actor.current?.procedure).toBe('wait');
    expect((actor.current?.flags ?? 0) & PackageFlag.ignoreCombat).toBe(0);
  });

  it('clears a flag of the package while its procedure runs (an Activate clears Weapon Drawn)', async () => {
    const { actor } = packageActor(
      [
        pack(1, procedure('activate', { override: override(0, PackageFlag.weaponDrawn) }), {
          flags: PackageFlag.weaponDrawn,
        }),
      ],
      { activate: lasting },
    );
    await tick(actor);
    expect((actor.current?.flags ?? 0) & PackageFlag.weaponDrawn).toBe(0);
  });

  it('makes a procedure run when it sets Preferred Speed with Run (36 vanilla overrides)', async () => {
    const { actor, gaits } = packageActor(
      [
        pack(
          1,
          branch('Sequence', [
            procedure('first', { override: override(PackageFlag.preferredSpeed, 0, 2) }),
            procedure('second'),
          ]),
        ),
      ],
      {
        first: async (run) => {
          await run.body.travel([0, 0, 0], run.gait, 0);
          return 'success';
        },
        second: travelling,
      },
    );
    await tick(actor);
    await tick(actor);
    expect(gaits).toEqual(['run', 'walk']);
  });

  it('holds its package while its override sets Must Complete (15 vanilla Travels)', async () => {
    const { actor, truths } = packageActor(
      [
        pack(1, procedure('a'), { conditions: [condition(9)] }),
        pack(2, procedure('b', { override: override(PackageFlag.mustComplete) })),
      ],
      { a: lasting, b: lasting },
    );
    await tick(actor);
    truths.add(9);
    await tick(actor, EVALUATE_PACKAGE_TIMER);
    expect(actor.current?.id).toBe(2);
  });

  it('sets and clears interrupt flags (5 vanilla overrides clear the talk and reactions)', () => {
    const record = pack(1, procedure('x'), {
      interruptFlags: InterruptFlag.hellosToPlayer | InterruptFlag.randomConversations,
    });
    const flags = packageFlags(record, [
      {
        setFlags: 0,
        clearFlags: 0,
        setInterruptFlags: InterruptFlag.aggroRadiusBehavior,
        clearInterruptFlags: InterruptFlag.randomConversations,
        preferredSpeed: 0,
      },
    ]);
    expect(flags.interrupts).toBe(InterruptFlag.hellosToPlayer | InterruptFlag.aggroRadiusBehavior);
  });
});

/**
 * Every general flag (PKDT) the load order's packages set: whether we honour it, and where. The
 * ones not yet honoured have a todo above or in tests/conformance/ai/procedures.test.ts.
 */
const GENERAL_FLAGS: ReadonlyMap<number, { readonly name: string; readonly honoured: boolean }> =
  new Map([
    [0x1, { name: 'Offers Services', honoured: false }],
    [PackageFlag.mustComplete, { name: 'Must Complete', honoured: true }],
    [PackageFlag.maintainSpeedAtGoal, { name: 'Maintain Speed At Goal', honoured: false }],
    // Bits 4, 5 and 8: unnamed for Skyrim by xEdit and CommonLibSSE (the Creation Kit shows no
    // box for them); set in 33, 2 and 5 packages, read by nothing we know of.
    [0x10, { name: '(unnamed bit 4)', honoured: true }],
    [0x20, { name: '(unnamed bit 5)', honoured: true }],
    [PackageFlag.unlockDoorsAtStart, { name: 'Unlock Doors At Package Start', honoured: true }],
    [PackageFlag.unlockDoorsOnChange, { name: 'Unlock Doors At Package End', honoured: true }],
    [0x100, { name: '(unnamed bit 8)', honoured: true }],
    [0x200, { name: 'Continue If PC Near', honoured: false }],
    [PackageFlag.oncePerDay, { name: 'Once Per Day', honoured: true }],
    [0x1000, { name: 'Skip Fallout Behavior', honoured: false }],
    [PackageFlag.preferredSpeed, { name: 'Preferred Speed', honoured: true }],
    [PackageFlag.alwaysSneak, { name: 'Always Sneak', honoured: true }],
    [PackageFlag.allowSwimming, { name: 'Allow Swimming', honoured: false }],
    [PackageFlag.ignoreCombat, { name: 'Ignore Combat', honoured: true }],
    [PackageFlag.weaponsUnequipped, { name: 'Weapons Unequipped', honoured: true }],
    [PackageFlag.weaponDrawn, { name: 'Weapon Drawn', honoured: true }],
    [PackageFlag.noCombatAlert, { name: 'No Combat Alert', honoured: true }],
    [PackageFlag.wearSleepOutfit, { name: 'Wear Sleep Outfit', honoured: true }],
  ]);

describe.skipIf(!hasGamedata())('package flags across the load order (data)', () => {
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

  it('counts the packages: 7,507 and 126 templates', () => {
    expect(census.packages).toBe(7507);
    expect(census.templates).toBe(126);
  });

  it('knows every general flag the packages set, with its count', () => {
    expect(Object.fromEntries(census.flags)).toEqual({
      [0x1]: 85,
      [0x4]: 148,
      [0x8]: 62,
      [0x10]: 33,
      [0x20]: 2,
      [0x40]: 38,
      [0x80]: 17,
      [0x100]: 5,
      [0x200]: 4,
      [0x400]: 124,
      [0x1000]: 189,
      [0x2000]: 1887,
      [0x20000]: 52,
      [0x40000]: 85,
      [0x100000]: 706,
      [0x200000]: 208,
      [0x800000]: 659,
      [0x8000000]: 603,
      [0x20000000]: 18,
    });
    for (const bit of census.flags.keys()) expect(GENERAL_FLAGS.has(bit)).toBe(true);
  });

  it('honours the general flags most packages set (the rest are todo cases)', () => {
    const notYet = [...census.flags]
      .filter(([bit]) => GENERAL_FLAGS.get(bit)?.honoured !== true)
      .sort((a, b) => a[0] - b[0])
      .map(
        ([bit, count]) => `${GENERAL_FLAGS.get(bit)?.name ?? bit.toString(16)} ${String(count)}`,
      );
    // Offers Services, Maintain Speed At Goal, Continue If PC Near, Skip Fallout Behavior and
    // Allow Swimming: 425 uses of 6,826 (the todo cases).
    expect(notYet).toEqual([
      'Offers Services 85',
      'Maintain Speed At Goal 62',
      'Continue If PC Near 4',
      'Skip Fallout Behavior 189',
      'Allow Swimming 85',
    ]);
  });

  it('counts the procedures’ flag overrides: 115 branches in 119 packages, all of procedures', () => {
    const branches = [...census.overrides.values()].reduce((sum, count) => sum + count, 0);
    expect(branches).toBe(115);
    expect(census.packagesWithOverrides).toBe(119);
    expect(Object.fromEntries(census.overrides)).toEqual({
      Travel: 68,
      Wait: 12,
      Sandbox: 11,
      Patrol: 6,
      Guard: 6,
      Follow: 4,
      UseWeapon: 3,
      Activate: 3,
      Find: 1,
      Flee: 1,
    });
  });

  it('honours every flag the overrides set or clear', () => {
    // Set: Must Complete 15, Preferred Speed 43, Always Sneak 7, Ignore Combat 24, Weapon Drawn
    // 17; cleared: Always Sneak 1, Weapon Drawn 1.
    for (const bit of [...census.overrideSets.keys(), ...census.overrideClears.keys()]) {
      expect(GENERAL_FLAGS.get(bit)?.honoured).toBe(true);
    }
    expect(Object.fromEntries(census.overrideSets)).toEqual({
      [0x4]: 15,
      [0x2000]: 43,
      [0x20000]: 7,
      [0x100000]: 24,
      [0x800000]: 17,
    });
  });

  it.todo(
    'keeps its speed as it reaches its goal (PKDT 0x8 Maintain Speed At Goal: 62 packages) ' +
      '(xEdit; the engine’s slowing at a goal to be observed in the original)',
  );
  it.todo(
    'swims only with Allow Swimming (PKDT 0x40000: 85 packages); without it its path keeps out ' +
      'of water (xEdit; the pathing’s rule to be observed in the original)',
  );
});

// The interaction case: a town NPC’s home by the hour.
//
// Expected output, from the data (Skyrim.esm; `node tools/package-info.ts 1a688 --hour 8`):
// Bergritte Battle-Born (BergritteBattleBornREF [0001A688], base [00013BB3], in
// WhiterunHouseBattleBorn) has, in her package list's order:
//   1. WhiterunBergritteHeimskrAudience [000847F7]  12:00 for 3 h, Travel
//   2. WhiterunBergritteMarket15x3 [000847F8]       15:00 for 3 h, Sandbox
//   3. WhiterunBergritteHomeSleepPackage [0002C39A] 20:00 for 10 h, Sleep: near her editor
//      location (radius 500), Find a bed (target selector: object type 26, beds), then Sleep
//   4. WhiterunBergritteHomeSitPackage [000914F7]  any time, Sandbox at reference [000914F8]
//      (a chair) with radius 0
// The first package whose schedule and conditions hold runs (Creation Kit, AI Packages: the
// package stack is evaluated top down). At 8:00 that is 4; at 22:00 it is 3. A furniture
// marker's animation type is 1 for sitting, 2 for sleeping (nif.xml FurniturePosition).

const BERGRITTE = 0x1a688;
const HOME_SIT_PACKAGE = 0x914f7;
const HOME_SIT_CHAIR = 0x914f8;
const HOME_SLEEP_PACKAGE = 0x2c39a;
/** The Sleep package's location: near the editor location, this far. */
const SLEEP_RADIUS = 500;
const SIT = 1;
const SLEEP = 2;
/** Sitting or sleeping in it (GetSitState / GetSleepState 3). */
const IN_FURNITURE = 3;

describe.skipIf(!hasGamedata())('package evaluation by the hour (headless simulation)', () => {
  let sim: Sim;
  /** Where the package had her each hour: its id, and the furniture she went into. */
  let morning: { package?: number; furniture?: number; animationType?: number } = {};
  let night: {
    package?: number;
    furniture?: number;
    animationType?: number;
    state?: number;
    bedFromHome?: number;
  } = {};
  let switched = false;

  beforeAll(async () => {
    sim = await openSim({ hour: 8 });
    const cell = sim.db.cellOfReference(BERGRITTE);
    if (cell === undefined) throw new Error('Bergritte has no cell');
    await sim.openInterior(cell);
    const furniture = sim.world.stage.furniture;
    await sim.until(() => furniture.interaction(BERGRITTE)?.state === IN_FURNITURE, 20);
    const sitting = furniture.interaction(BERGRITTE);
    morning = {
      ...(sim.package(BERGRITTE) && { package: sim.package(BERGRITTE)?.id }),
      ...(sitting && { furniture: sitting.furniture, animationType: sitting.animationType }),
    };
    // The clock jumps to 22:00 (as a script's GameHour.SetValue): her packages are evaluated again.
    sim.setHour(22);
    switched = await sim.until(() => sim.package(BERGRITTE)?.id === HOME_SLEEP_PACKAGE, 20);
    await sim.until(
      () =>
        furniture.interaction(BERGRITTE)?.animationType === SLEEP &&
        furniture.interaction(BERGRITTE)?.state === IN_FURNITURE,
      90,
    );
    const bed = furniture.interaction(BERGRITTE);
    const home = (await sim.runtime.editorPlace(BERGRITTE)).position;
    const bedAt = bed && (await sim.position(bed.furniture));
    night = {
      ...(sim.package(BERGRITTE) && { package: sim.package(BERGRITTE)?.id }),
      ...(bed && { furniture: bed.furniture, animationType: bed.animationType, state: bed.state }),
      ...(home &&
        bedAt && {
          bedFromHome: Math.hypot(bedAt[0] - home[0], bedAt[1] - home[1], bedAt[2] - home[2]),
        }),
    };
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('runs the first package whose schedule holds at 8:00: the any-time home sit package', () => {
    expect(morning.package).toBe(HOME_SIT_PACKAGE);
  });

  it('goes to the sit package’s place at 8:00 and sits in it', () => {
    expect(morning.furniture).toBe(HOME_SIT_CHAIR);
    expect(morning.animationType).toBe(SIT);
  });

  it('runs the sleep package (20:00 for 10 h) once the clock is at 22:00', () => {
    expect(switched).toBe(true);
    expect(night.package).toBe(HOME_SLEEP_PACKAGE);
  });

  it('finds a bed near her editor location at night and sleeps in it', () => {
    expect(night.animationType).toBe(SLEEP);
    expect(night.state).toBe(IN_FURNITURE);
    expect(night.bedFromHome).toBeLessThanOrEqual(SLEEP_RADIUS);
  });

  it('tells each package as it starts (TESPackageEvent), the sit package before the sleep one', () => {
    const started = sim
      .packages(BERGRITTE)
      .filter((event) => event.type === 'start')
      .map((event) => event.package);
    expect(started.indexOf(HOME_SIT_PACKAGE)).toBeGreaterThanOrEqual(0);
    expect(started.lastIndexOf(HOME_SLEEP_PACKAGE)).toBeGreaterThan(
      started.indexOf(HOME_SIT_PACKAGE),
    );
  });
});

/** Her packages by hour, from their schedules (above): the first whose schedule holds. */
const AUDIENCE_PACKAGE = 0x847f7;
const MARKET_PACKAGE = 0x847f8;
const DAY: readonly (readonly [number, number])[] = [
  // The hours in the house first (sitting, then asleep), then those she goes out (she leaves the
  // loaded area through the door then).
  ...[6, 7, 8, 9, 10, 11, 18, 19].map((hour) => [hour, HOME_SIT_PACKAGE] as const),
  ...[20, 21, 22, 23, 0, 1, 2, 3, 4, 5].map((hour) => [hour, HOME_SLEEP_PACKAGE] as const),
  ...[12, 13, 14].map((hour) => [hour, AUDIENCE_PACKAGE] as const),
  ...[15, 16, 17].map((hour) => [hour, MARKET_PACKAGE] as const),
];

describe.skipIf(!hasGamedata())(
  'a town NPC’s whole day, hour by hour (headless simulation)',
  () => {
    let sim: Sim;
    const chosen = new Map<number, number | undefined>();

    beforeAll(async () => {
      sim = await openSim({ hour: 6 });
      const cell = sim.db.cellOfReference(BERGRITTE);
      if (cell === undefined) throw new Error('Bergritte has no cell');
      await sim.openInterior(cell);
      // The package she runs now, else (gone through the door) the last one she started.
      const running = (): number | undefined =>
        sim.package(BERGRITTE)?.id ??
        sim
          .packages(BERGRITTE)
          .filter((event) => event.type === 'start')
          .at(-1)?.package;
      for (const [hour, expected] of DAY) {
        // The clock set as a script's GameHour.SetValue: she chooses again as the hour changes.
        sim.setHour(hour + 0.5);
        await sim.until(() => running() === expected, 10);
        chosen.set(hour, running());
      }
    }, 900_000);
    afterAll(async () => {
      await sim.close();
    });

    it('runs at each of the 24 hours the package her schedules give it', () => {
      expect(Object.fromEntries(chosen)).toEqual(Object.fromEntries(new Map(DAY)));
    });
  },
);
