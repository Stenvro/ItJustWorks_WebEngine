// Conformance: blocks and bashes (engine map: Combat > Block, bash). When an actor blocks, for how
// long, and when it bashes.
//
// Sources: observed in the original (docs/ai.md, Style values): the block chance is the
// defensive mult on fCombatBlockChanceMin .. Max (× fCombatBlockChanceWeaponMult with a weapon);
// a bash from a block the defensive mult on fCombatBashChanceMin (0.025) .. Max (0.2) × the bash
// mults (× bash recoil mult against a recoiling target, bash power attack mult against a power
// attack, bash attack mult against a swing, fCombatBashTargetBlockingMult 0 against a block); an
// offensive bash the offensive mult on fCombatOffensiveBashChanceMin (0) .. Max (0.05). The
// block damage: combat/damage-stagger.test.ts.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  bashChance,
  blockAttackOpening,
  blockChance,
  blockStartDistance,
  blockStopDistance,
  chooseAttack,
  holdsBlock,
  offensiveBashChance,
} from '../../../src/ai/combat-tactics.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;
const input = {
  targetIsPlayer: false,
  allies: 0,
  targetStaggered: false,
  targetBlocking: false,
  targetAttacking: false,
  targetPowerAttacking: false,
  targetRecoiling: false,
  blocking: true,
  canBash: true,
  powerChance: 0,
  sinceLastAttack: undefined,
};

describe('blocking and bashing (formula)', () => {
  it('a shield blocks by the defensive mult; a weapon × fCombatBlockChanceWeaponMult', () => {
    const style = styleWith({ defensiveMult: 1 });
    expect(blockChance(style, true, settings)).toBe(ENGINE.fCombatBlockChanceMax);
    expect(blockChance(style, false, settings)).toBeCloseTo(settings.blockChanceWeaponMult);
  });

  it('a bash from a block: the defensive mult on fCombatBashChanceMin .. Max', () => {
    expect(bashChance(styleWith({ defensiveMult: 1 }), input, settings)).toBeCloseTo(
      ENGINE.fCombatBashChanceMax,
    );
  });

  it('not against a block: × fCombatBashTargetBlockingMult (0)', () => {
    expect(
      bashChance(styleWith({ defensiveMult: 1 }), { ...input, targetBlocking: true }, settings),
    ).toBe(ENGINE.fCombatBashTargetBlockingMult);
  });

  it('an offensive bash: the offensive mult on fCombatOffensiveBashChanceMin .. Max', () => {
    expect(offensiveBashChance(styleWith({ offensiveMult: 1 }), input, settings)).toBeCloseTo(
      ENGINE.fCombatOffensiveBashChanceMax,
    );
  });

  it('fCombatBlockStartDistanceMin / Max (32, 192), StopDistance (128, 384)  [settings]', () => {
    expect(blockStartDistance(styleWith({ defensiveMult: 0 }), settings)).toBe(32);
    expect(blockStartDistance(styleWith({ defensiveMult: 1 }), settings)).toBe(192);
    expect(blockStopDistance(styleWith({ defensiveMult: 1 }), settings)).toBe(384);
  });

  it('a sustained block: held while the target stays near and does not back off  [settings]', () => {
    const style = styleWith({ defensiveMult: 0 });
    expect(holdsBlock({ distance: 100, targetRetreatSpeed: 0 }, style, settings)).toBe(true);
    // Beyond its stop distance (128), or backing off faster than 128 units a second.
    expect(holdsBlock({ distance: 200, targetRetreatSpeed: 0 }, style, settings)).toBe(false);
    expect(holdsBlock({ distance: 100, targetRetreatSpeed: 200 }, style, settings)).toBe(false);
  });

  it('the block attack’s opening: within the bash reach × 1.5, the strike angle × 1.25', () => {
    const angle = 0.5;
    expect(blockAttackOpening({ distance: 180, off: 0.6, strikeAngle: angle }, settings)).toBe(
      true,
    );
    expect(blockAttackOpening({ distance: 200, off: 0, strikeAngle: angle }, settings)).toBe(false);
    expect(blockAttackOpening({ distance: 100, off: 0.7, strikeAngle: angle }, settings)).toBe(
      false,
    );
  });

  it('the offensive bash: chosen out of no block by its chance  [RTTI]', () => {
    const rolls = [0, 0.99, 0];
    const random = (): number => rolls.shift() ?? 0.5;
    const style = styleWith({ offensiveMult: 1 });
    expect(chooseAttack(style, { ...input, blocking: false }, random, settings)).toBe(
      'offensiveBash',
    );
  });
  it.todo('a blocked hit costs the blocker stamina (fBlockScoreNoShieldMult …)  [settings]');
});
