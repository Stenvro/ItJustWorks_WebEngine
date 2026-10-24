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
import { bashChance, blockChance, offensiveBashChance } from '../../../src/ai/combat-tactics.ts';
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

  it.todo('a sustained block held for the block time (fCombatBlockTime* curve)  [original]');
  it.todo('fCombatBlockStartDistanceMin / Max (32, 192), StopDistance (128, 384)  [settings]');
  it.todo('fCombatBlockMaxTargetRetreatVelocity (128)  [settings]');
  it.todo('the block attack: a block timed to the target’s swing (fCombatBlockAttack*)  [original]');
  it.todo('the offensive bash run by the tree’s Bash behaviour  [RTTI]');
  it.todo('a blocked hit costs the blocker stamina (fBlockScoreNoShieldMult …)  [settings]');
});
