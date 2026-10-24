// Conformance: potions and restoring in combat (engine map: Combat > Potions).
//
// Sources: observed in the original (docs/ai.md, Style values): health is restored below the
// defensive mult on fCombatRestoreHealthPercentMin (0) .. Max (0.5) of it, not within
// fCombatRestoreHealthRestrictTime (15 s) of the last; magicka below fCombatRestoreMagicka
// PercentMin (0.25) .. Max (0.4), not within …RestrictTime (10 s); no other value; the tree waits
// fCombatMagicDrinkPotionWaitTime (3 s) after a potion (CombatBehaviorDrinkPotion,
// CombatBehaviorTreeUsePotion; RTTI). the engine's defaults.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import { chooseSupport, restoreShare } from '../../../src/ai/combat-tactics.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;
const state = {
  health: 1,
  magicka: 1,
  sinceHealthRestore: 100,
  sinceMagickaRestore: 100,
  canHeal: false,
  potions: { health: true, magicka: true },
  canSummon: false,
  canBuff: false,
  canWard: false,
};

describe('restoring (formula)', () => {
  it('health below the defensive mult on 0 .. 0.5; magicka on 0.25 .. 0.4', () => {
    const style = styleWith({ defensiveMult: 1 });
    expect(restoreShare(style, 'health', settings)).toBe(ENGINE.fCombatRestoreHealthPercentMax);
    expect(restoreShare(style, 'magicka', settings)).toBeCloseTo(
      ENGINE.fCombatRestoreMagickaPercentMax,
    );
  });

  it('drinks a Health potion below the share', () => {
    const style = styleWith({ defensiveMult: 1 });
    expect(chooseSupport({ ...state, health: 0.4 }, style, settings)).toEqual({
      kind: 'potion',
      value: 'health',
    });
  });

  it('not within fCombatRestoreHealthRestrictTime (15 s) of the last', () => {
    const style = styleWith({ defensiveMult: 1 });
    expect(
      chooseSupport({ ...state, health: 0.4, sinceHealthRestore: 10 }, style, settings),
    ).not.toEqual({ kind: 'potion', value: 'health' });
  });

  it('waits fCombatMagicDrinkPotionWaitTime (3 s) after a potion', () => {
    expect(settings.drinkPotionWaitTime).toBe(ENGINE.fCombatMagicDrinkPotionWaitTime);
  });

  it.todo('the casters’ order in the tree (ward, heal, potion, summon, buff)  [RTTI]');
  it.todo('the stop-cast threshold of a held healing spell  [original]');
  it.todo('the potion chosen: the strongest of its kind  [original]');
});
