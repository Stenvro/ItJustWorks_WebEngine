// Conformance: a real melee fight, by real input against the game data (engine map: Combat >
// Melee choice, Close movement): the player with an iron sword against a bandit in the Bannered
// Mare, button presses and turns only, until one of them is down.
//
// Sources: observed in the original (docs/ai.md, The attack decision, Which attack, Combat
// movement): the melee attack node's one list of attacks of the set the actor holds, each by its
// chance; a sword-and-shield bandit has neither a dual wielder's attacks nor fists, power attacks
// are the minority, and it keeps to its range (its reach and extents, its target's knockback or
// a fallback sending it off for a moment).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const STEP = 0.1;

interface Fight {
  readonly swings: number;
  readonly landed: number;
  readonly closeSwings: number;
  readonly closeLanded: number;
  /** The bandit's blows, and the distances between the two while it fought. */
  readonly banditHits: number;
  readonly banditPower: number;
  readonly distances: readonly number[];
  readonly banditHealth: number;
  readonly killer: number | undefined;
}

describe.skipIf(!hasGamedata)('a real melee fight, player against bandit', () => {
  let sim: Sim;
  let fight: Fight;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    for (const actor of sim.actors()) {
      if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
    }
    const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
    await sim.moveTo([feet[0] + 90, feet[1], feet[2]]);
    const bandit = await sim.place(
      await sim.formId('NPC_', 'EncBandit01Melee1HTankNordM'),
      PLAYER_REF,
    );
    await sim.moveTo(feet);
    const sword = await sim.formId('WEAP', 'IronSword');
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(sword), 1, true);
    await sim.equip(sword);
    await sim.attack(0.1);

    const distances: number[] = [];
    let swings = 0;
    let landed = 0;
    let closeSwings = 0;
    let closeLanded = 0;
    const apart = async (): Promise<number> => {
      const a = await sim.position(PLAYER_REF);
      const b = await sim.position(bandit);
      return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity;
    };
    const dead = (): boolean => sim.deaths().some((death) => death.actor === bandit);
    // The player closes to well inside its reach and swings, until the bandit is down.
    for (let round = 0; round < 120 && !dead(); round++) {
      const before = await apart();
      distances.push(before);
      const swing = await sim.swingAt(bandit, 110);
      if (!swing.began) {
        await sim.step(STEP);
        continue;
      }
      swings += 1;
      if (swing.landed) landed += 1;
      if (before <= 200) {
        closeSwings += 1;
        if (swing.landed) closeLanded += 1;
      }
    }
    const fromBandit = sim.events('hit').filter((hit) => hit.aggressor === bandit);
    const death = sim.deaths().find((one) => one.actor === bandit);
    fight = {
      swings,
      landed,
      closeSwings,
      closeLanded,
      banditHits: fromBandit.length,
      banditPower: fromBandit.filter((hit) => hit.powerAttack).length,
      distances,
      banditHealth: (await sim.runtime.actors.value(bandit, ActorValue.health)).current,
      killer: death?.killer,
    };
  }, 600_000);

  afterAll(async () => {
    await sim.close();
  });

  it('the player’s swings at close range land', () => {
    expect(fight.closeSwings).toBeGreaterThan(3);
    expect(fight.closeLanded / fight.closeSwings).toBeGreaterThan(0.5);
  });

  it('the bandit fights back, power attacks the minority of its blows', () => {
    expect(fight.banditHits).toBeGreaterThan(0);
    expect(fight.banditPower).toBeLessThan(Math.max(1, fight.banditHits));
  });

  it('the bandit keeps to its range: it does not stand off', () => {
    const sorted = [...fight.distances].sort((a, b) => a - b);
    // Its reach (141 × 1.03) and extents; the median near that, for all the pushes between them.
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(230);
    // At most a fifth of the fight past its range and its fallback's greatest distance.
    const far = sorted.filter((distance) => distance > 400).length;
    expect(far / sorted.length).toBeLessThan(0.2);
  });

  it('the bandit dies by blows, the player its killer', () => {
    expect(fight.banditHealth).toBeLessThanOrEqual(0);
    expect(fight.killer).toBe(PLAYER_REF);
  });
});
