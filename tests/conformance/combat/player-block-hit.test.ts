// Conformance: an NPC's blow on the player's raised block (engine map: Combat > Block, bash). The
// player holds Left Attack/Block with a one-handed weapon out (the block of
// tests/conformance/combat/player-block.test.ts) while a bandit strikes: a blow from within
// fCombatHitConeAngle of the player's facing is told as blocked (the hit event's blocked flag,
// the BlockHit reaction) and takes less health than one that meets no block: the share a weapon
// block takes off (blockedShare: fBlockWeaponBase 0.3 and up, by the attacker's weapon and the
// blocker's Block). A blow from behind the block is not blocked. And one blow is one hit, however
// often its attack's hit frame is raised.
//
// Sources: UESP "Block" (the blocked share, the block's facing), the game settings
// (fCombatHitConeAngle, fBlockWeaponBase, fBlockWeaponScaling), the response files (HitFrame:
// HitFrameHandler). Found 2026-11-12 in the browser in Helgen Keep's first fight: of 26 blows on
// the player 6 were blocked while a block was up and in front, and several blows were told two or
// three times within a millisecond, each with its own damage: an attack's hit frame raised twice
// in a frame struck twice, as each strike passed the "struck already" check before the other had
// marked its target (the strike waits for the attacker's perks in between). That is the last
// case here: it fails without the strike marking its targets in one step.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphEvent } from '../../../src/animation/graph-events.ts';
import type { AnimatedSkeleton } from '../../../src/animation/animated-skeleton.ts';
import { AttackState, WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { hasGamedata, openSim, PLAYER_REF, SIM_STEP, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const LEFT = 'Left Attack/Block';

describe.skipIf(!hasGamedata())('a blow on the player’s raised block (headless simulation)', () => {
  let sim: Sim;
  let bandit = 0;
  /** The plain blows on the player since `from`: each one's health taken, blocked or not. */
  const blows: { blocked: boolean; power: boolean; taken: number }[] = [];
  let seen = 0;

  const health = async (): Promise<number> =>
    (await sim.runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
  const hitsOnPlayer = () =>
    sim.events('hit').filter((hit) => hit.target === PLAYER_REF && hit.aggressor === bandit);

  /** One step with the player facing the bandit (`away`: their back to it), the blows noted. */
  const tick = async (away = false): Promise<void> => {
    const at = await sim.position(bandit);
    const me = sim.world.player.feet;
    if (at) {
      const to: [number, number, number] = away
        ? [2 * me[0] - at[0], 2 * me[1] - at[1], at[2] + 100]
        : [at[0], at[1], at[2] + 100];
      sim.look(to);
    }
    const before = await health();
    await sim.step(SIM_STEP);
    const hits = hitsOnPlayer();
    const taken = before - (await health());
    for (const hit of hits.slice(seen)) {
      blows.push({ blocked: hit.blocked, power: hit.powerAttack, taken });
    }
    seen = hits.length;
    // Healed again, so each blow is measured from full health.
    sim.runtime.actors.restore(PLAYER_REF, ActorValue.health, 10_000);
  };

  /** Steps until `count` more plain blows fell (at most `seconds`); those blows. */
  const until = async (count: number, seconds: number, away = false): Promise<typeof blows> => {
    const from = blows.length;
    const plain = (): typeof blows => blows.slice(from).filter((blow) => !blow.power);
    for (let t = 0; t < seconds && plain().length < count; t += SIM_STEP) await tick(away);
    return plain();
  };

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    for (const actor of sim.actors()) {
      if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
    }
    const axe = await sim.formId('WEAP', 'IronWarAxe');
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(axe), 1, true);
    await sim.equip(axe);
    for (
      let tries = 0;
      tries < 3 && sim.world.stage.combat.weaponState(PLAYER_REF) !== WeaponState.drawn;
      tries++
    ) {
      sim.press('Ready Weapon', true);
      await sim.step(0.1);
      sim.press('Ready Weapon', false);
      await sim.step(2);
    }
    expect(sim.world.stage.combat.weaponState(PLAYER_REF)).toBe(WeaponState.drawn);
    const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
    await sim.moveTo([feet[0] + 100, feet[1], feet[2]]);
    bandit = await sim.place(await sim.formId('NPC_', 'EncBandit01Melee1HNordM'), PLAYER_REF);
    await sim.moveTo(feet);
    sim.world.stage.combat.startCombat(bandit, PLAYER_REF);
    // The fight is not the case: the player cannot die in it.
    sim.runtime.debug.immortal = true;
  }, 600_000);

  afterAll(async () => {
    await sim.close();
  });

  it('is blocked from the front and takes less than a blow that meets no block', async () => {
    sim.press(LEFT, true);
    const blocked = await until(3, 40);
    sim.press(LEFT, false);
    for (let t = 0; t < 1; t += SIM_STEP) await tick();
    const open = await until(3, 40);
    expect(blocked.length).toBe(3);
    expect(open.length).toBe(3);
    expect(blocked.map((blow) => blow.blocked)).toEqual([true, true, true]);
    expect(open.map((blow) => blow.blocked)).toEqual([false, false, false]);
    const most = Math.max(...blocked.map((blow) => blow.taken));
    const least = Math.min(...open.map((blow) => blow.taken));
    expect(least).toBeGreaterThan(0);
    // A weapon block takes fBlockWeaponBase (0.3) off at the least.
    expect(most).toBeLessThanOrEqual(least * 0.7 + 0.01);
  }, 600_000);

  it('is not blocked from behind the block', async () => {
    sim.press(LEFT, true);
    for (let t = 0; t < 0.5; t += SIM_STEP) await tick(true);
    const behind = await until(2, 40, true);
    sim.press(LEFT, false);
    expect(behind.length).toBe(2);
    expect(behind.map((blow) => blow.blocked)).toEqual([false, false]);
    for (let t = 0; t < 1; t += SIM_STEP) await tick();
  }, 600_000);

  it('lands once though its hit frame is raised twice within a frame', async () => {
    const combat = sim.world.stage.combat;
    const skeleton = sim.actor(bandit)?.placed as unknown as AnimatedSkeleton | undefined;
    expect(skeleton).toBeDefined();
    if (!skeleton) return;
    const source = { reference: bandit, player: false, firstPerson: false, skeleton };
    // The bandit's next swing, before its own hit frame; the player within its reach.
    let swinging = false;
    for (let t = 0; t < 40 && !swinging; t += SIM_STEP) {
      await tick();
      swinging =
        combat.combatState(bandit)?.attack === AttackState.swing &&
        ((await sim.distance(bandit, PLAYER_REF)) ?? Infinity) < 100;
    }
    expect(swinging).toBe(true);
    const before = hitsOnPlayer().length;
    sim.world.stage.graphEvents.dispatch.dispatch(source, [
      graphEvent('HitFrame'),
      graphEvent('HitFrame'),
    ]);
    // The clip's own hit frame comes within this too: the attack has struck already.
    for (let t = 0; t < 0.4; t += SIM_STEP) await tick();
    expect(hitsOnPlayer().length - before).toBe(1);
  }, 600_000);
});
