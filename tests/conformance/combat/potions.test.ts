// Conformance: potions and restoring in combat (engine map: Combat > Potions).
//
// Sources: observed in the original (docs/ai.md, Style values): health is restored below the
// defensive mult on fCombatRestoreHealthPercentMin (0) .. Max (0.5) of it, not within
// fCombatRestoreHealthRestrictTime (15 s) of the last; magicka below fCombatRestoreMagicka
// PercentMin (0.25) .. Max (0.4), not within …RestrictTime (10 s); no other value; the tree waits
// fCombatMagicDrinkPotionWaitTime (3 s) after a potion (CombatBehaviorDrinkPotion,
// CombatBehaviorTreeUsePotion). the engine's defaults.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  chooseCombatSupport,
  holdsRestore,
  restoreWanted,
} from '../../../src/ai/combat-subtrees.ts';
import { chooseSupport, restoreShare } from '../../../src/ai/combat-tactics.ts';
import { strongestPotion } from '../../../src/scripting/runtime/casting-engine.ts';
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

  it('the casters’ order in the tree (ward, heal, potion, summon, buff)  [original]', () => {
    const style = styleWith({ defensiveMult: 1 });
    const all = { ...state, health: 0.1, magicka: 0.1 };
    const ready = { ...all, canWard: true, canHeal: true, canSummon: true, canBuff: true };
    expect(chooseSupport(ready, style, settings)).toEqual({ kind: 'ward' });
    const noWard = { ...ready, canWard: false };
    expect(chooseSupport(noWard, style, settings)).toEqual({ kind: 'heal' });
    const noHeal = { ...noWard, canHeal: false };
    expect(chooseSupport(noHeal, style, settings)).toEqual({ kind: 'potion', value: 'health' });
    const noPotion = { ...noHeal, potions: { health: false, magicka: false } };
    expect(chooseSupport(noPotion, style, settings)).toEqual({ kind: 'summon' });
    expect(chooseSupport({ ...noPotion, canSummon: false }, style, settings)).toEqual({
      kind: 'buff',
    });
  });
  it('the stop-cast threshold of a held healing spell (0.25)  [settings]', () => {
    expect(holdsRestore(0.5, 0.5)).toBe(true);
    expect(holdsRestore(0.74, 0.5)).toBe(true);
    expect(holdsRestore(0.75, 0.5)).toBe(false);
    // Observed in the original: the stop is the share plus the threshold alone, with no stop at
    // full health of its own (the engine's shares reach 0.5 at most, so it stops by 0.75); an
    // earlier expectation here stopped it at full whatever the share.
    expect(holdsRestore(1, 0.9)).toBe(true);
    expect(holdsRestore(1.2, 0.9)).toBe(false);
  });

  it('wanted below the share; on below share + threshold once restoring  [original]', () => {
    expect(restoreWanted(0.49, 0.5)).toBe(true);
    expect(restoreWanted(0.6, 0.5)).toBe(false);
    expect(restoreWanted(0.6, 0.5, { restoring: true })).toBe(true);
    expect(restoreWanted(0.76, 0.5, { restoring: true })).toBe(false);
  });

  it('bleeding out, health is wanted whatever its share, and a held heal goes on  [original]', () => {
    expect(restoreWanted(0.9, 0.5, { bleedingOut: true })).toBe(true);
    expect(holdsRestore(0.9, 0.5, undefined, true)).toBe(true);
    const hurt = {
      health: 0.9,
      magicka: 1,
      restoreHealthBelow: 0.5,
      bleedingOut: true,
      wardThreat: false,
      sinceWard: 100,
      canHeal: true,
      sinceHealthRestore: 100,
      restoreHealthRestrictTime: 15,
      canSummon: false,
      sinceSummon: 100,
      corpseDistance: undefined,
      canReanimate: false,
      sinceReanimate: 100,
      canBuff: false,
    };
    const potions = {
      restoreMagickaBelow: 0.4,
      sinceMagickaRestore: 100,
      restoreMagickaRestrictTime: 10,
      health: true,
      magicka: false,
    };
    expect(chooseCombatSupport(hurt, potions)).toEqual({ kind: 'potion', value: 'health' });
    expect(chooseCombatSupport(hurt, { ...potions, health: false })).toEqual({ kind: 'restore' });
    expect(chooseCombatSupport({ ...hurt, bleedingOut: false }, potions)).toBeUndefined();
  });
  it('the potion chosen: the one restoring the most  [original]', () => {
    const potions = [
      { formId: 1, amount: 25 },
      { formId: 2, amount: 100 },
      { formId: 3, amount: 50 },
      { formId: 4, amount: 0 },
    ];
    expect(strongestPotion(potions)).toBe(2);
    expect(strongestPotion([{ formId: 4, amount: 0 }])).toBeUndefined();
  });
});
