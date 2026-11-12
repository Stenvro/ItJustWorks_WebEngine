// Conformance: a search finds what a corpse holds where the body lies (engine map: AI >
// Procedures: Find, Acquire). A package's Find looks into the inventories within its place; a
// place given as a dead actor (an alias: its reference) is where its ragdoll carried it, and so
// is the body the search weighs. MQ101RalofGetDoorKey (the Acquire template) has Ralof find the
// keep's key within 101 units of BarracksRoomSoldier01, the officer, who carries it: his body.
//
// Sources: the package (`node tools/package-info.ts --package MQ101RalofGetDoorKey`: Search Loc
// "near the alias's reference, 101", Target Criteria the key's object), MQ101KeepIntroSceneB
// phase 30 (`node tools/scene-info.ts 0x4e1e2`). Found 2026-11-12 in the browser: after Helgen
// Keep's first fight Ralof wandered about the officer's body and MQ101 stood at 280 (the Find
// beside the template's Wander found nothing). The search weighed the corpse at the spot it
// died on while the place was the body's own, where its ragdoll lay: a body that fell farther
// from that spot than the place's radius was outside a search centred on itself. Here the
// radius is small, so the drop of a body that falls where it stood is enough to tell.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TargetType } from '../../../src/ai/package-records.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('a search of a place centred on a corpse (simulation)', () => {
  let sim: Sim;
  let bandit = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    bandit = await sim.place(await sim.formId('NPC_', 'EncBandit01Melee1HNordM'), PLAYER_REF);
    await sim.step(1);
    await sim.kill(bandit);
    // Its ragdoll falls and comes to rest.
    await sim.step(4);
  }, 600_000);

  afterAll(async () => {
    await sim.close();
  });

  it('finds what the corpse holds where its ragdoll lies', async () => {
    const stage = sim.world.stage;
    const died = sim.actor(bandit)?.position;
    const lies = stage.livePlacement(bandit)?.position;
    expect(died).toBeDefined();
    expect(lies).toBeDefined();
    if (!died || !lies) return;
    // The body lies off the spot it died on by more than the radius searched below.
    const RADIUS = 20;
    expect(Math.hypot(lies[0] - died[0], lies[1] - died[1], lies[2] - died[2])).toBeGreaterThan(
      RADIUS,
    );
    // Something it still holds (the weapon it dropped as it died is kept with a count of 0).
    const item = [...(await sim.runtime.inventory(bandit))].find(([, count]) => count > 0)?.[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    const held = await stage.search.findHeld(
      { type: TargetType.objectId, value: item, count: 0 },
      { actor: 0, from: lies, center: lies, radius: RADIUS, steal: true },
    );
    expect(held).toContainEqual({ holder: bandit, item });
  });
});
