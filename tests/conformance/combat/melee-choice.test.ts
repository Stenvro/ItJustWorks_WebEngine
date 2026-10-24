// Conformance: the melee choice (engine map: Combat > Melee choice). When an actor attacks in
// melee, and with which attack.
//
// Sources: observed in the original (docs/ai.md, The attack decision): every 0.25 s the
// Attack Idle rolls the attack chance, the offensive mult on fCombatAttackChanceMin (0.05) ..
// Max (1), × the staggered mults against a staggered target, × the defensive mult on
// fCombatAttackChanceBlockingMultMax (0.67) .. Min (0.2) while it blocks, × 1 .. 1.5
// (fCombatAttackChanceLastAttackBonus) over fCombatAttackChanceLastAttackBonusTime (5 s).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import { ATTACK_DECISION_SECONDS, attackChance } from '../../../src/ai/combat-tactics.ts';
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
  blocking: false,
  canBash: false,
  powerChance: 0,
  sinceLastAttack: undefined,
};

describe('the attack decision (formula)', () => {
  it('is rolled every 0.25 s (the Attack Idle)', () => {
    expect(ATTACK_DECISION_SECONDS).toBe(0.25);
  });

  it('the offensive mult on fCombatAttackChanceMin .. Max', () => {
    expect(attackChance(styleWith({ offensiveMult: 0 }), input, settings)).toBeCloseTo(
      ENGINE.fCombatAttackChanceMin,
    );
    expect(attackChance(styleWith({ offensiveMult: 1 }), input, settings)).toBe(
      ENGINE.fCombatAttackChanceMax,
    );
  });

  it('while blocking × the defensive mult on BlockingMultMax .. Min', () => {
    const style = styleWith({ offensiveMult: 1, defensiveMult: 1 });
    expect(attackChance(style, { ...input, blocking: true }, settings)).toBeCloseTo(
      ENGINE.fCombatAttackChanceBlockingMultMin,
    );
  });

  it('rises to × 1.5 over 5 s since the last attack', () => {
    const style = styleWith({ offensiveMult: 0.5 });
    const base = attackChance(style, input, settings);
    expect(attackChance(style, { ...input, sinceLastAttack: 5 }, settings)).toBeCloseTo(
      base * ENGINE.fCombatAttackChanceLastAttackBonus,
    );
  });

  it.todo('the attack from the attack data while closing in (ATKD chance, recovery time)  [original]');
  it.todo('the strike angle × fCombatAttackStrikeAngleMult (0.67), per attack’s angle  [original]');
  it.todo('the special attack (CSME special attack mult, the tree’s Special Attack)  [original]');
  it.todo('power attacks by the attack data’s power chance and the staggered mults  [original]');
  it.todo('left-hand and dual attacks (Allow Dual Wielding)  [CommonLibSSE TESCombatStyle]');
  it.todo('NPC sneak attacks: an attacker unseen by its target  [UESP Sneak]');
});
