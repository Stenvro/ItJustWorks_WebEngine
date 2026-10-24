// Conformance: AI package evaluation by the hour (engine map: AI > Package evaluation), with the
// procedures it hands the actor to (Procedures, Movement) in the headless simulation. A town NPC's
// home at 8:00 and at 22:00: the package the data's schedules pick, and the actor going to the
// package's place and using it. Skipped without game data.
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

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

  it.todo(
    'evaluates packages again every 15 s and on the hour, not every 2 s (engine map: Time and ' +
      'budget; the evaluation timer is a game setting to be observed in the original)',
  );
  it.todo(
    'honours the packages’ flags: Weapon Drawn, Weapons Unequipped, Sleep Outfit, Allow ' +
      'Swimming, Maintain Speed (engine map: Package evaluation)',
  );
  it.todo(
    'takes procedure overrides from a package’s branches (engine map: Package evaluation, 115 ' +
      'branches in vanilla)',
  );
  it.todo(
    'runs the sandbox on its daily plan in game time (sleep, meals) with weighted choices ' +
      '(engine map: Sandbox)',
  );
});
