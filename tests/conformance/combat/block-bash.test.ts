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
import { blockCost } from '../../../src/gameplay/vitals.ts';
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

  it('the block attack’s opening: its target drawing, reach × 1.5, strike angle × 1.25  [original]', () => {
    // A weapon's reach 100, a radius of 30: inside 180. The strike angle 0.5 × 1.25: 0.625.
    const opening = {
      drawing: true,
      distance: 170,
      distanceSoon: 170,
      off: 0.6,
      strikeAngle: 0.5,
      reach: 100,
      radius: 30,
    };
    expect(blockAttackOpening(opening, settings)).toBe(true);
    // Only as the swing is drawn back: not once it has been swung.
    expect(blockAttackOpening({ ...opening, drawing: false }, settings)).toBe(false);
    // Out of reach now and fCombatAnticipateTime ahead; inside only as it closes.
    const far = { ...opening, distance: 200, distanceSoon: 190 };
    expect(blockAttackOpening(far, settings)).toBe(false);
    expect(blockAttackOpening({ ...far, distanceSoon: 170 }, settings)).toBe(true);
    // Outside the swing's own strike angle.
    expect(blockAttackOpening({ ...opening, off: 0.7 }, settings)).toBe(false);
  });

  it('the offensive bash: chosen out of no block by its chance  [original]', () => {
    const rolls = [0, 0];
    const random = (): number => rolls.shift() ?? 0.5;
    const style = styleWith({ offensiveMult: 1 });
    expect(chooseAttack(style, { ...input, blocking: false }, random, settings)).toBe(
      'offensiveBash',
    );
  });
  it('a blocked hit costs the blocker stamina: share × damage, stagger, base  [original]', () => {
    // fStaminaBlockDmgMult 0.25 × (share × the damage before armour), fStaminaBlockStaggerMult 5
    // × its stagger, fStaminaBlockBase (Skyrim.esm 0). fBlockScoreNoShieldMult is the combat
    // inventory's and has no part in it.
    expect(blockCost(0.5 * 40)).toBe(5);
    expect(blockCost(0.5 * 40, 0.4)).toBe(7);
    expect(blockCost(0, 0)).toBe(0);
  });
});
