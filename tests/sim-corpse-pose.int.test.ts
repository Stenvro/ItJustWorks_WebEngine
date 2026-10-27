// A corpse lies where its ragdoll laid it after a save is loaded (docs/formats/save.md; the
// corpse pose: src/animation/corpse-pose.ts): Hulda, killed at the Bannered Mare's counter and
// knocked over, lies in the loaded game where she lay, rather than falling anew from her rest
// pose where she stood.

import { afterAll, describe, expect, it } from 'vitest';
import { transformPoint, type Vec3 } from '../src/render/math.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;
const HEAD = 'NPC Head [Head]';

/** Where an actor's head is in the world (undefined: not on the stage). */
function head(sim: Sim, reference: number): Vec3 | undefined {
  const placed = sim.actor(reference)?.placed;
  const world = placed?.instances[0]?.world;
  const node = placed?.pose.world(HEAD);
  return world && node
    ? transformPoint(world, [node[12] ?? 0, node[13] ?? 0, node[14] ?? 0])
    : undefined;
}

describe.skipIf(!hasGamedata())('a corpse across a save (headless simulation)', () => {
  const sims: Sim[] = [];
  afterAll(async () => {
    for (const sim of sims) await sim.close();
  });

  it('lies again where its ragdoll laid it', async () => {
    const before = await openSim({ interior: BANNERED_MARE, hour: 10 });
    sims.push(before);
    await before.step(2);
    await before.kill(HULDA, PLAYER_REF);
    await before.step(1);
    // Knocked over, she comes to rest on the floor.
    expect(before.world.stage.bodies.kickRagdoll(HULDA, [1, 0, 0], 6)).toBe(true);
    await before.step(8);
    const lay = head(before, HULDA);
    expect(lay).toBeDefined();
    const bytes = await before.save();
    await before.close();
    sims.splice(0);

    const after = await loadSim(bytes);
    sims.push(after);
    await after.step(1);
    const lies = head(after, HULDA);
    expect(lies).toBeDefined();
    if (!lay || !lies) return;
    expect(Math.hypot(lies[0] - lay[0], lies[1] - lay[1], lies[2] - lay[2])).toBeLessThan(8);
  }, 600_000);
});
