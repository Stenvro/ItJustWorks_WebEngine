// Conformance: the player's block by real input (engine map: Combat > Block, bash). With a
// one-handed weapon and nothing in the left hand, Left Attack/Block held raises the weapon's
// block (the action tree's BlockingStart: blockStart); held through a swing, the block goes up
// as the swing ends.
//
// Sources: the action tree (IDLE: ActionLeftAttack's BlockingStart under 0_master), the control
// map (Left Attack/Block, the right mouse button). Pressed in the middle of a swing the graph takes
// no block; the block held then rising at the swing's end is inferred (TODO(M13)): found
// 2026-11-09 in the browser in Helgen Keep, where a block pressed mid-swing was lost for good while
// the button stayed held.

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
});
