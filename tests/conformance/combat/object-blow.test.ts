// Conformance: the player's melee blow on an object (engine map: Combat > Damage, stagger). A
// swing or a bash that meets no actor but an object in reach (clutter, a destructible, a
// container, a door) lands on it once: the object's OnHit is told once (the hit event,
// TESHitEvent) and a destructible takes the weapon's damage once (destruction-engine.ts: external
// damage), however often the attack's hit frame is raised; the same rule as a blow on an actor
// (each struck once an attack: tests/conformance/combat/player-block-hit.test.ts).
//
// Sources: the response files (HitFrame: HitFrameHandler), the destruction data (DEST: the
// stockade barricade's 125 health, no Ignore External Damage on its stages). Seen in the
// playtest and in the physics work: a player's one blow on an object landed twice (its impulse,
// its impact, its OnHit, its damage), as an attack's hit frame raised twice (two clips of a blend
// raise theirs within a frame or two) found the object each time. The last two cases fail without
// the strike marking what it met as struck (two hits for the swing, three for the bash).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphEvent } from '../../../src/animation/graph-events.ts';
import { AttackState, WeaponState } from '../../../src/gameplay/combat/combat-state.ts';
import { hasGamedata, openSim, PLAYER_REF, SIM_STEP, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const RIGHT = 'Right Attack/Block';
const LEFT = 'Left Attack/Block';

describe.skipIf(!hasGamedata())('the player’s blow on an object (headless simulation)', () => {
  let sim: Sim;
  let barricade = 0;
  let middle: [number, number, number] = [0, 0, 0];

  const hitsOnIt = () =>
    sim.events('hit').filter((hit) => hit.target === barricade && hit.aggressor === PLAYER_REF);
  const health = async (): Promise<number> =>
    (await sim.runtime.destruction.health(barricade)) ?? Number.NaN;

  /** One step with the player facing the barricade. */
  const tick = async (): Promise<void> => {
    sim.look(middle);
    await sim.step(SIM_STEP);
  };

  /** Steps until the attack and its recoil off the object are over (0.5 s at least, 5 at most). */
  const settled = async (): Promise<void> => {
    const combat = sim.world.stage.combat;
    for (let t = 0; t < 5; t += SIM_STEP) {
      await tick();
      const state = combat.combatState(PLAYER_REF);
      if (t >= 0.5 && state && state.current === undefined && !state.recoiling) return;
    }
  };

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    // No one but the player: a swing meets the object, not an actor in its cone.
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
    barricade = await sim.place(
      await sim.formId('ACTI', 'StockadeBarricade01Activator'),
      PLAYER_REF,
    );
    middle = [feet[0], feet[1], feet[2] + 80];
    await sim.moveTo([feet[0] - 90, feet[1], feet[2]]);
    for (let t = 0; t < 0.5; t += SIM_STEP) await tick();
  }, 600_000);

  afterAll(async () => {
    await sim.close();
  });

  /** The weapon's damage one blow took off the barricade (from the first case). */
  let blow = 0;

  it('lands once a swing: its OnHit told once, its damage taken once', async () => {
    const before = hitsOnIt().length;
    const full = await health();
    expect(full).toBe(125);
    sim.press(RIGHT, true);
    await tick();
    sim.press(RIGHT, false);
    await settled();
    expect(hitsOnIt().length - before).toBe(1);
    expect(hitsOnIt().at(-1)?.powerAttack).toBe(false);
    blow = full - (await health());
    expect(blow).toBeGreaterThan(0);
  }, 600_000);

  it('lands once a swing in third person too', async () => {
    sim.world.play?.player.setPov('third');
    for (let t = 0; t < 0.5; t += SIM_STEP) await tick();
    const before = hitsOnIt().length;
    const left = await health();
    sim.press(RIGHT, true);
    await tick();
    sim.press(RIGHT, false);
    await settled();
    expect(hitsOnIt().length - before).toBe(1);
    expect(left - (await health())).toBeCloseTo(blow, 3);
    sim.world.play?.player.setPov('first');
    for (let t = 0; t < 0.5; t += SIM_STEP) await tick();
  }, 600_000);

  it('lands once though its hit frame is raised twice within a frame', async () => {
    // The button tapped: held, it is a power attack.
    const { hits, taken } = await twiceAtItsHitFrame(false);
    expect(hits.map((hit) => [hit.powerAttack, hit.bashAttack])).toEqual([[false, false]]);
    expect(taken).toBeCloseTo(blow, 3);
  }, 600_000);

  it('a bash on it lands once though its hit frame is raised twice within a frame', async () => {
    const { hits, taken } = await twiceAtItsHitFrame(true);
    expect(hits.map((hit) => hit.bashAttack)).toEqual([true]);
    expect(taken).toBeGreaterThan(0);
  }, 600_000);

  /**
   * The player's next attack on the barricade (a bash: the attack key while the block is held),
   * its hit frame raised twice in one go before the clip's own (in its wind-up or its swing):
   * the hits on the barricade since and the health it lost.
   */
  async function twiceAtItsHitFrame(
    bash: boolean,
  ): Promise<{ hits: ReturnType<typeof hitsOnIt>; taken: number }> {
    const combat = sim.world.stage.combat;
    const avatar = sim.world.playerView?.avatar;
    expect(avatar).toBeDefined();
    if (!avatar) return { hits: [], taken: 0 };
    const firstPerson = sim.world.play?.player.pov === 'first';
    const before = hitsOnIt().length;
    if (bash) {
      sim.press(LEFT, true);
      for (let t = 0; t < 0.5; t += SIM_STEP) await tick();
    }
    sim.press(RIGHT, true);
    const states: number[] = [];
    let ready = false;
    for (let t = 0; t < 2 && !ready; t += SIM_STEP) {
      await tick();
      sim.press(RIGHT, false);
      const state = combat.combatState(PLAYER_REF);
      states.push(state?.attack ?? -1);
      ready =
        state?.current?.bash === bash &&
        (bash
          ? state.attack === AttackState.bash
          : state.attack === AttackState.draw || state.attack === AttackState.swing);
    }
    expect(ready, `attack states ${states.join(',')}`).toBe(true);
    expect(hitsOnIt().length).toBe(before);
    const left = await health();
    sim.world.stage.graphEvents.player(
      avatar,
      [graphEvent('HitFrame'), graphEvent('HitFrame')],
      firstPerson,
    );
    // The clip's own hit frame comes within this too: the attack has struck already.
    if (bash) {
      for (let t = 0; t < 0.5; t += SIM_STEP) await tick();
      sim.press(LEFT, false);
    }
    await settled();
    return { hits: hitsOnIt().slice(before), taken: left - (await health()) };
  }
});
