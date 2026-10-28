// Nobody in Whiterun dies without a cause (src/shell/actor-movers.ts #giveUp, actor-furniture.ts
// use): a gate guard whose Sit sent it to a chair across the city was warped to that chair's
// approach at its own height, in the air over the Plains District, and died of the fall. It was
// sent there after its way stopped at the seam of two cells' navmeshes (#walkerGround).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, openSim, type Sim } from './helpers/sim.ts';

const WHITERUN = 0x1a26f;
/** A Whiterun guard (WhiterunGateGuardTravel, then a Sit at a chair in the Plains District). */
const GATE_GUARD = 0xdc9e4;
/** A Whiterun guard on patrol (package 0x108297) through the Wind District. */
const PATROL_GUARD = 0x78783;
/** C00GiantREF: the giant at Pelagia Farm, killed as the player enters Whiterun (stage 200). */
const GIANT = 0xc97d2;
/** C00GiantAttack, its stage 200 (C00GiantAttackCancelTriggerScript): Kill on the giant. */
const GIANT_ATTACK = 0xc97d9;

describe.skipIf(!hasGamedata())('deaths in Whiterun', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ exterior: { world: WHITERUN, cell: [4, -2] }, hour: 9 });
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  it('keeps its guards alive for a minute; the giant dies only by its quest', async () => {
    // Its patrol crosses the seam between cells 6,0 and 6,-1 (y 0) as a walker, far from the
    // player: it stood at y 4 for good, its navmeshes 5 units apart there.
    let south = Infinity;
    for (let t = 0; t < 60; t += 0.5) {
      await sim.step(0.5);
      south = Math.min(south, (await sim.position(PATROL_GUARD))?.[1] ?? Infinity);
    }
    expect(south).toBeLessThan(-50);
    expect(await sim.runtime.actors.isDead(GATE_GUARD)).toBe(false);
    // The original's own: the cancel trigger by the gate sets stage 200, whose fragment kills
    // the giant the Companions were to fight.
    expect(sim.stageDone(GIANT_ATTACK, 200)).toBe(true);
    const dead = sim.deaths().map((death) => death.actor);
    expect(dead.filter((actor) => actor !== GIANT)).toEqual([]);
  }, 120_000);

  it('still kills an actor dropped from a deadly height', async () => {
    const actors = sim.runtime.actors;
    let victim: number | undefined;
    // One its controller moves (it lands, and its fall is told).
    for (const staged of sim.actors()) {
      const reference = staged.reference;
      if (staged.dead || !sim.world.stage.movers.moves(reference)) continue;
      if (await actors.isEssential(reference)) continue;
      if (await actors.isProtected(reference)) continue;
      victim = reference;
      break;
    }
    if (victim === undefined) throw new Error('no mortal actor in Whiterun');
    const staged = sim.actor(victim);
    if (!staged) throw new Error('not staged');
    // Set 2,000 units over where it stands, as the warp did (its controller, not a script's
    // MoveTo, which puts it on the ground).
    const [x, y, z] = staged.position;
    staged.position = [x, y, z + 2000];
    sim.world.stage.movers.teleport(staged);
    const died = await sim.until(() => sim.deaths().some((death) => death.actor === victim), 8);
    expect(died).toBe(true);
    expect((await actors.value(victim, ActorValue.health)).current).toBeLessThanOrEqual(0);
  }, 60_000);
});
