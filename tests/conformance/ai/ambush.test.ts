// Ambushes in the headless simulation (docs/ai.md, "Detection"): a draugr of Bleak Falls
// Barrow lies in its sarcophagus (ambushSleepPackage: Sleep in its linked furniture while its
// Variable01 is 0) and does not stir while the player stands off; once the player comes near
// it hears them, climbs out through its furniture's exit and fights them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** LvlDraugrAmbushMelee1HMale in BleakFallsBarrow01's hall of sarcophagi. */
const DRAUGR = 0x380b5;
/** ambushSleepPackage. */
const AMBUSH_SLEEP = 0x9448b;

interface Moment {
  readonly inFurniture: boolean;
  readonly fighting: boolean;
  readonly target: number | undefined;
  readonly package: number | undefined;
}

describe.skipIf(!hasGamedata())('a draugr in ambush (headless simulation)', () => {
  let sim: Sim;
  let away: Moment | undefined;
  let near: Moment | undefined;

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    await sim.openInterior(await sim.formId('CELL', 'BleakFallsBarrow01'));
    await sim.step(1);
    const stage = sim.world.stage;
    const draugr = sim.actor(DRAUGR);
    if (!draugr) throw new Error('the draugr is not on the stage');
    const moment = (): Moment => ({
      inFurniture: stage.furniture.interaction(DRAUGR)?.state === 3,
      fighting: stage.combat.engaged(DRAUGR),
      target: stage.combat.targetOf(DRAUGR),
      package: sim.package(DRAUGR)?.id,
    });
    const [x, y, z] = draugr.position;
    // The player stands off, out of its hearing.
    await sim.moveTo([x - 700, y, z]);
    await sim.step(6);
    away = moment();
    // ... then walks up to its sarcophagus.
    await sim.walkTo([x - 150, y, z], 6, 32);
    await sim.until(() => stage.combat.engaged(DRAUGR) && !moment().inFurniture, 15);
    near = moment();
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('lies still in its ambush while the player is away', () => {
    expect(away).toMatchObject({ inFurniture: true, fighting: false, package: AMBUSH_SLEEP });
  });

  it('bursts out and attacks the player once it notices them', () => {
    expect(near).toMatchObject({ inFurniture: false, fighting: true, target: PLAYER_REF });
  });
});
