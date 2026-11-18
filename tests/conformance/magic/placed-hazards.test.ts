// Conformance: the hazards the plugins place in cells (PHZD) stand while their cell is attached
// and burn whoever stands in them (engine map: Magic > Hazards). In the headless simulation.
// Skipped without game data.
//
// Sources, the data (Skyrim.esm):
// - FireLgPlacedHazard [00057A8C]: a campfire's flames; model Effects\FXFire01New.nif, radius
//   3 ft, lifetime 0, target interval 0.3 s, spell [000153BD] (fire damage);
// - its reference [001046BB] in RiftenRatway02 [000A1BFD], enabled (WolfskullCave01's waits
//   for its quest);
// - the Bannered Mare [0001605E] has none.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { loadCellData } from '../../../src/world/cell-loader.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const RATWAY = 0xa1bfd;
const CAMPFIRE = 0x1046bb;
const FIRE_HAZARD = 0x57a8c;
const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('hazards placed in a cell (headless simulation)', () => {
  let sim: Sim;
  let stands = false;
  let drawn = false;
  let before = 0;
  let after = 0;
  let afterLeaving = true;

  beforeAll(async () => {
    sim = await openSim({ interior: RATWAY, hour: 10 });
    await sim.step(1);
    const { runtime } = sim;
    stands = runtime.hazards.get(CAMPFIRE)?.hazard.formId === FIRE_HAZARD;
    // Its cell lists it with its model (no longer a reference without one).
    const data = await loadCellData(sim.db, RATWAY);
    drawn = data.objects.some(
      (object) => object.reference === CAMPFIRE && object.model.endsWith('fxfire01new.nif'),
    );
    const fire = await sim.position(CAMPFIRE);
    if (fire) {
      before = (await runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
      await sim.openInterior(RATWAY, { position: fire, heading: 0 });
      await sim.step(2);
      after = (await runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
    }
    await sim.openInterior(BANNERED_MARE);
    await sim.step(1);
    afterLeaving = runtime.hazards.get(CAMPFIRE) !== undefined;
  }, 600_000);

  afterAll(async () => {
    await sim.close();
  });

  it('has a campfire’s placed hazard stand, drawn, while its cell is attached', () => {
    expect(stands).toBe(true);
    expect(drawn).toBe(true);
  });

  it('burns the player standing in it', () => {
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  it('no longer stands once its cell detached', () => {
    expect(afterLeaving).toBe(false);
  });
});
