// Conformance: the player's block by real input (engine map: Combat > Block, bash). With a
// one-handed weapon and nothing in the left hand, Left Attack/Block held raises the weapon's
// block (the action tree's BlockingStart: blockStart); held through a swing, the block goes up
// as the attack's window opens (AttackWinStart), before the swing's end; held through a jump, it
// is up again after the landing.
//
// Sources: the action tree (IDLE: ActionLeftAttack's BlockingStart under 0_master), the control
// map (Left Attack/Block, the right mouse button), 0_master's attack states (tools/behavior-run.ts:
// an axe's AttackState takes no blockStart before AttackWinStart, and takes it after, then raises
// attackStop). Found 2026-11-09 in the browser in Helgen Keep, where a block pressed mid-swing was
// lost for good while the button stayed held; on 2026-11-10 four of five blocks pressed mid-swing
// and held 0.9 s were let go before the axe's swing ended (1.5 s), unraised.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const STEP = 0.1;

describe.skipIf(!hasGamedata())('the player’s block (headless simulation)', () => {
  let sim: Sim;
  const blocking = (): boolean => sim.world.stage.combat.combatState(PLAYER_REF)?.blocking === true;
  const inBlockState = (): boolean =>
    (sim.world.playerView?.avatar?.body.behavior?.states() ?? []).some(
      (state) => state.state === 'BlockState',
    );
  const tap = async (event: string): Promise<void> => {
    sim.press(event, true);
    await sim.step(STEP);
    sim.press(event, false);
  };

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    const axe = await sim.formId('WEAP', 'IronWarAxe');
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(axe), 1, true);
    await sim.equip(axe);
    // Drawn (Ready Weapon; a press as the game starts may come before its controls take it).
    for (
      let tries = 0;
      tries < 3 && sim.world.stage.combat.weaponState(PLAYER_REF) !== WeaponState.drawn;
      tries++
    ) {
      await tap('Ready Weapon');
      await sim.step(2);
    }
    expect(sim.world.stage.combat.weaponState(PLAYER_REF)).toBe(WeaponState.drawn);
  }, 300_000);

  afterAll(async () => {
    await sim.close();
  });

  it('raises the axe’s block while Left Attack/Block is held, and lowers it on release', async () => {
    sim.press('Left Attack/Block', true);
    await sim.step(0.6);
    expect(blocking()).toBe(true);
    expect(inBlockState()).toBe(true);
    sim.press('Left Attack/Block', false);
    await sim.step(0.6);
    expect(blocking()).toBe(false);
  });

  it('raises a block held through a swing as the swing ends', async () => {
    await tap('Right Attack/Block');
    await sim.step(0.4);
    expect(sim.world.stage.combat.combatState(PLAYER_REF)?.current).toBeDefined();
    sim.press('Left Attack/Block', true);
    let raised = false;
    for (let t = 0; t < 2.5 && !raised; t += STEP) {
      await sim.step(STEP);
      raised = blocking() && inBlockState();
    }
    sim.press('Left Attack/Block', false);
    await sim.step(0.6);
    expect(raised).toBe(true);
  });

  it('raises a block held through a swing as the attack’s window opens, before the swing ends', async () => {
    const combat = sim.world.stage.combat;
    // A swing on its own: how long until it ends (the attack state none again).
    await sim.step(1);
    await tap('Right Attack/Block');
    let swing = STEP;
    let begun = false;
    for (; swing < 4; swing += STEP) {
      await sim.step(STEP);
      const current = combat.combatState(PLAYER_REF)?.current;
      if (current !== undefined) begun = true;
      else if (begun) break;
    }
    expect(begun).toBe(true);
    await sim.step(1);
    // The same swing, the block held from 0.3 s in: up in the window (nextAttack), before then.
    await tap('Right Attack/Block');
    await sim.step(0.2);
    sim.press('Left Attack/Block', true);
    let raisedAt: number | undefined;
    let during: number | undefined;
    for (let t = 0.3; t < 3 && raisedAt === undefined; t += STEP) {
      await sim.step(STEP);
      if (blocking() && inBlockState()) {
        raisedAt = t + STEP;
        during = combat.combatState(PLAYER_REF)?.attack;
      }
    }
    sim.press('Left Attack/Block', false);
    await sim.step(0.6);
    console.log(
      `swing ${swing.toFixed(1)} s, block up at ${String(raisedAt)} s (attack ${String(during)})`,
    );
    expect(raisedAt).toBeDefined();
    expect(raisedAt ?? 99).toBeLessThan(swing - STEP);
  });

  it('raises a block held through a jump after the landing', async () => {
    await sim.step(1);
    sim.press('Left Attack/Block', true);
    await sim.step(0.6);
    expect(blocking()).toBe(true);
    await tap('Jump');
    const trace: string[] = [];
    let raisedAgain = false;
    let left = false;
    for (let t = 0; t < 3 && !raisedAgain; t += STEP) {
      await sim.step(STEP);
      const states = (sim.world.playerView?.avatar?.body.behavior?.states() ?? [])
        .map((state) => `${state.machine}=${state.state}`)
        .filter((text) => /jump|block|readied|default_behavior/i.test(text))
        .join(' ');
      trace.push(`${t.toFixed(1)} blocking=${String(blocking())} ${states}`);
      if (!blocking()) left = true;
      else if (left && inBlockState()) raisedAgain = true;
    }
    const upAtEnd = blocking() && inBlockState();
    sim.press('Left Attack/Block', false);
    await sim.step(0.6);
    console.log(`jump dropped the block: ${String(left)}\n${trace.join('\n')}`);
    expect(upAtEnd).toBe(true);
  });
});
