// Conformance: ranged combat (engine map: Combat > Ranged). When an archer looses, how long it
// draws, and its line of fire.
//
// Sources: observed in the original (docs/ai.md, Style values): the shot's chance is the
// offensive mult on fCombatRangedAttackChanceMin (0.05) .. Max (1), gaining up to
// fCombatRangedAttackChanceLastAttackBonus (half of itself) over …BonusTime (10 s); the draw is
// held at random from fCombatRangedAttackHoldTimeAbsoluteMin (0.1 s) to the offensive mult on
// …HoldTimeMax (1.5) .. Min (0.25); it looses only within fCombatRangedProjectileFiringArc (30°)
// and holds at most fCombatRangedAttackMaximumHoldTime (10 s). the engine's defaults.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  aimGivenUp,
  bowHoldTime,
  lineOfFireBlocker,
  rangedAttackChance,
} from '../../../src/ai/combat-tactics.ts';
import { COMBAT_TREES } from '../../../src/ai/combat-tree.ts';
import { AIM_DEFAULTS, leadPoint } from '../../../src/gameplay/combat/aim.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;
const opponent = { targetIsPlayer: false, allies: 0 };

describe('the shot (formula)', () => {
  it('its chance: the offensive mult on fCombatRangedAttackChanceMin .. Max', () => {
    const shot = { ...opponent, sinceLastAttack: undefined };
    expect(rangedAttackChance(styleWith({ offensiveMult: 0 }), shot, settings)).toBeCloseTo(
      ENGINE.fCombatRangedAttackChanceMin,
    );
    expect(rangedAttackChance(styleWith({ offensiveMult: 1 }), shot, settings)).toBe(
      ENGINE.fCombatRangedAttackChanceMax,
    );
  });

  it('half again after 10 s since the last attack', () => {
    const style = styleWith({ offensiveMult: 0.5 });
    const base = rangedAttackChance(style, { ...opponent, sinceLastAttack: undefined }, settings);
    expect(rangedAttackChance(style, { ...opponent, sinceLastAttack: 10 }, settings)).toBeCloseTo(
      base * 1.5,
    );
  });

  it('the draw: from 0.1 s to the offensive mult on 1.5 .. 0.25 s', () => {
    const style = styleWith({ offensiveMult: 1 });
    const far = { ...opponent, distance: 2000, radii: 0 };
    expect(bowHoldTime(style, far, () => 0, settings)).toBeCloseTo(
      ENGINE.fCombatRangedAttackHoldTimeAbsoluteMin,
    );
    expect(bowHoldTime(style, far, () => 1, settings)).toBeCloseTo(
      ENGINE.fCombatRangedAttackHoldTimeMin,
    );
  });

  it('looses within the firing arc (30°), holds at most 10 s', () => {
    expect(settings.rangedProjectileFiringArc).toBe(ENGINE.fCombatRangedProjectileFiringArc);
    expect(settings.rangedAttackMaximumHoldTime).toBe(ENGINE.fCombatRangedAttackMaximumHoldTime);
  });

  const body = (reference: number, x: number) => ({
    reference,
    feet: [x, 0, 0] as [number, number, number],
    radius: 30,
    height: 120,
  });

  it('the line of fire: an actor in the way holds the shot  [original]', () => {
    const from: [number, number, number] = [0, 0, 90];
    const to: [number, number, number] = [1000, 0, 90];
    expect(lineOfFireBlocker(from, to, [body(1, 500)])).toBe(1);
    // The nearest of two; none beside the line, behind the target or behind the shooter.
    expect(lineOfFireBlocker(from, to, [body(1, 700), body(2, 300)])).toBe(2);
    const beside = { ...body(1, 500), feet: [500, 100, 0] as [number, number, number] };
    expect(lineOfFireBlocker(from, to, [beside])).toBeUndefined();
    expect(lineOfFireBlocker(from, to, [body(1, 1200), body(2, -100)])).toBeUndefined();
    // Over one's head.
    expect(lineOfFireBlocker([0, 0, 400], [1000, 0, 400], [body(1, 500)])).toBeUndefined();
  });

  it('fCombatAimProjectileBlockedTime (1.5 s): a blocked aim is given up', () => {
    expect(settings.aimProjectileBlockedTime).toBe(ENGINE.fCombatAimProjectileBlockedTime);
    expect(aimGivenUp(undefined, settings)).toBe(false);
    expect(aimGivenUp(1.5, settings)).toBe(false);
    expect(aimGivenUp(1.6, settings)).toBe(true);
  });

  it('cover: Find Cover, Attack From Cover, Wait Behind Cover  [original]', () => {
    const tree = JSON.stringify(COMBAT_TREES.UseCover);
    for (const action of ['findCover', 'waitBehindCover', 'attackFromCover']) {
      expect(tree).toContain(`"action":"${action}"`);
    }
  });

  it('the aim leads a moving target (projectile speed, gravity)  [original]', () => {
    // Crossing at 300 units a second, a shot of 1500 a second over 1500 units takes 1 s.
    const point = leadPoint([0, 0, 0], [0, 1500, 0], [300, 0, 0], 1500, 0, AIM_DEFAULTS);
    expect(point[0]).toBeGreaterThan(280);
    // Under gravity the aim rises above the point.
    const falling = leadPoint([0, 0, 0], [0, 1500, 0], [0, 0, 0], 1500, 500, AIM_DEFAULTS);
    expect(falling[2]).toBeGreaterThan(0);
  });

  it('an archer looses only with its target inside the firing arc  [original]', () => {
    // The tree's Release needs shotInArc while the bow is held; shotOverheld lets it down.
    const tree = JSON.stringify(COMBAT_TREES);
    expect(tree).toContain('"shotInArc"');
    expect(tree).toContain('"shotOverheld"');
  });
});
