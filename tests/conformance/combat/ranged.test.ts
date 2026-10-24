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
import { bowHoldTime, rangedAttackChance } from '../../../src/ai/combat-tactics.ts';
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

  it.todo('an archer in the sim looses only with its target inside the firing arc  [original]');
  it.todo('the line of fire: an ally in the way holds the shot (fAIAimBlocked*)  [settings]');
  it.todo('cover: Find Cover, Attack From Cover, Wait Behind Cover  [RTTI]');
  it.todo('fCombatAimProjectileBlockedTime (1.5 s): a blocked aim is given up  [settings]');
  it.todo('the aim leads a moving target (projectile speed, gravity)  [original]');
});
