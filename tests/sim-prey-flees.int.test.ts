// Integration test: a prey animal that bolts from the player runs, and no one hunts it down for
// them. The elk north of the Western Watchtower road (LvlAnimalPlainsPrey: cowardly, in combat
// with whoever comes within its aggro radius of 1,500) sandbox there, wandering with no pause
// between their walks.
//
// Found 2026-11-12 in MQ104 (tests/sim-dragon-rising.int.test.ts, stages 50-60): one of them
// wandered within 1,500 units of the player waiting by the road, bolted, and "fought" them
// instead: its package's wander, stopped as its fight began, asked for its next walk at once
// and took the combat AI's run to cover from it; the run that ended where it stood counted as
// arrival, so it hid in the open; found there by the player looking its way, it turned to fight
// as one cornered; Irileth and the guards took up the player's defence, the scene they were
// cast in paused for the fight (MQ104FortIntroScene: its actors pause it in combat), and one
// guard chased the elk 5,000 units north. Stage 52 came 26 s late.
//
// Now a package moves no one who fights (src/shell/actor-ai.ts, #afterFight), a flee run that
// ends short of its place fails (src/ai/combat-subtrees.ts, fleeRunStatus) and a coward found in
// its hide flees on (hideEnd). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const TAMRIEL = 0x3c;
/** On the road east of the Western Watchtower (where MQ104's player waits for Irileth). */
const WATCHTOWER_ROAD = { position: [5600, -13500, -4990], heading: 0 } as const;
/** LvlAnimalPlainsPrey: the base of the elk placed north of the road (000dc552, 000dc553). */
const PLAINS_PREY = 0x422b1;
/** MQ104Soldier01: a Whiterun guard (it helps the player against one that attacks them). */
const GUARD = 0xa27cc;
/** How long the elk is watched after it bolts, and the sample (seconds). */
const WATCHED = 12;
const SAMPLE = 0.1;
/** Its first decision after its fight begins comes within this (seconds). */
const DECIDES_WITHIN = 1;

describe.skipIf(!hasGamedata())('a prey animal bolts from the player', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({
      exterior: { world: TAMRIEL, cell: [1, -4] },
      arrival: WATCHTOWER_ROAD,
      hour: 10,
    });
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  it('runs from them, fights no one and is hunted by no guard', async () => {
    const combat = sim.world.stage.combat;
    const movers = sim.world.stage.movers;
    const prey = (): number[] =>
      sim
        .actors()
        .filter((actor) => actor.placed.actor.base === PLAINS_PREY && !actor.dead)
        .map((actor) => actor.reference);
    expect(await sim.until(() => prey().length > 0, 20)).toBe(true);
    const place = (reference: number): Vec3 | undefined => {
      const at = sim.actor(reference)?.position;
      return at && [at[0], at[1], at[2]];
    };
    const bolted = (): number | undefined =>
      prey().find((reference) => combat.state(reference)?.inCombat === true);
    // The player walks up to the nearest of them over the navmeshes, half a second at a time
    // (it wanders meanwhile), until one has them within its aggro radius and its fight begins.
    for (let hop = 0; hop < 120 && bolted() === undefined; hop++) {
      const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
      const nearest = prey()
        .map((reference) => place(reference))
        .filter((at): at is Vec3 => at !== undefined)
        .sort(
          (a, b) =>
            Math.hypot(a[0] - feet[0], a[1] - feet[1]) - Math.hypot(b[0] - feet[0], b[1] - feet[1]),
        )[0];
      expect(nearest).toBeDefined();
      if (nearest) await sim.walkPath(nearest, 0.5, 600);
    }
    const elk = bolted();
    expect(elk).toBeDefined();
    if (elk === undefined) return;
    // A guard stands by the player from now on, as Irileth's did.
    const guard = await sim.place(GUARD, PLAYER_REF);
    // The player stands and watches it go.
    let fought = 0;
    let walked = 0;
    let fled = 0;
    let guardFought = 0;
    for (let passed = 0; passed < WATCHED; passed += SAMPLE) {
      const at = place(elk);
      if (at) sim.look(at);
      await sim.step(SAMPLE);
      if (combat.state(guard)?.inCombat === true) guardFought++;
      const state = combat.state(elk);
      if (state?.inCombat !== true || passed < DECIDES_WITHIN) continue;
      // In its fight it only flees: it does not turn on the player.
      if (state.fleeing) fled++;
      else fought++;
      // And it goes as its flight has it: at a run (its package's wander walks).
      const motion = movers.motion(elk);
      if (motion?.moving === true && !motion.running) walked++;
    }
    expect({ fought, walked, guardFought }).toEqual({ fought: 0, walked: 0, guardFought: 0 });
    expect(fled).toBeGreaterThan(0);
    // No one killed it.
    expect(sim.deaths().map((death) => death.actor)).not.toContain(elk);
  }, 600_000);
});
