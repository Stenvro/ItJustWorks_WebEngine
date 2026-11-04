// Conformance: combat magic, choosing the spells (engine map: Combat > Combat magic). When a
// caster casts in a fight and which spell (the casting itself, costs and projectiles: the magic
// suites).
//
// Sources: observed in the original (docs/ai.md, Style values): the cast's chance is the
// offensive mult on fCombatCastImmediateOffensiveMagicChanceMin (0.05) .. Max (0.75), a
// concentration spell's on …ConcentrationOffensiveMagicChanceMin (0.25) .. Max (1), rolled every
// 0.25 s (the Cast Immediate / Concentration Spell Idles); the tree's Magic context
// (CombatBehaviorContextMagic: Cast Immediate Spell, Cast Concentration Spell, Prepare Dual Cast,
// Equip Spell; class names). the engine's defaults.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  chooseCaster,
  COMBAT_SUBTREE_DEFAULTS,
  dualCastHold,
  type CasterState,
} from '../../../src/ai/combat-subtrees.ts';
import { castChance } from '../../../src/ai/combat-tactics.ts';
import { COMBAT_TREES } from '../../../src/ai/combat-tree.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;
const opponent = { targetIsPlayer: false, allies: 0 };

describe('the cast decision (formula)', () => {
  it('fire-and-forget: the offensive mult on 0.05 .. 0.75', () => {
    expect(castChance(styleWith({ offensiveMult: 0 }), opponent, false, settings)).toBeCloseTo(
      ENGINE.fCombatCastImmediateOffensiveMagicChanceMin,
    );
    expect(castChance(styleWith({ offensiveMult: 1 }), opponent, false, settings)).toBeCloseTo(
      ENGINE.fCombatCastImmediateOffensiveMagicChanceMax,
    );
  });

  it('concentration: the offensive mult on 0.25 .. 1', () => {
    expect(castChance(styleWith({ offensiveMult: 0 }), opponent, true, settings)).toBeCloseTo(
      ENGINE.fCombatCastConcentrationOffensiveMagicChanceMin,
    );
    expect(castChance(styleWith({ offensiveMult: 1 }), opponent, true, settings)).toBe(
      ENGINE.fCombatCastConcentrationOffensiveMagicChanceMax,
    );
  });

  const idle: CasterState = {
    health: 1,
    magicka: 1,
    restoreHealthBelow: 0.5,
    wardThreat: false,
    sinceWard: Infinity,
    canHeal: true,
    sinceHealthRestore: Infinity,
    restoreHealthRestrictTime: 15,
    canSummon: false,
    sinceSummon: Infinity,
    corpseDistance: undefined,
    canReanimate: false,
    sinceReanimate: Infinity,
    canBuff: false,
  };

  it('casters by purpose: offensive, defensive (wards), restore, summon, buff  [original]', () => {
    expect(chooseCaster(idle)).toBeUndefined();
    expect(chooseCaster({ ...idle, wardThreat: true })).toBe('ward');
    expect(chooseCaster({ ...idle, health: 0.2 })).toBe('restore');
    expect(chooseCaster({ ...idle, canSummon: true })).toBe('summon');
    expect(chooseCaster({ ...idle, canBuff: true })).toBe('buff');
  });

  it('dual casting (Prepare Dual Cast): charged, then loosed from both hands  [original]', () => {
    expect(JSON.stringify(COMBAT_TREES)).toContain('"action":"prepareDualCast"');
    expect(dualCastHold(0.5, 1)).toBe('charging');
    expect(dualCastHold(COMBAT_SUBTREE_DEFAULTS.dualCastInterruptTime, 1)).toBe('interrupt');
  });

  it('reanimating a corpse within range (the reanimate caster)  [original]', () => {
    const raising = { ...idle, canReanimate: true };
    expect(chooseCaster({ ...raising, corpseDistance: 500 })).toBe('reanimate');
    expect(chooseCaster({ ...raising, corpseDistance: undefined })).toBeUndefined();
  });

  // Fifteen casters in the original, one per spell by its effect: no fixed order between them
  // exists; each decides for its own spell, and the combat inventory scores the spells. The
  // inventory's scoring of a magic item was not read, so these two stay.
  it.todo(
    'the spell chosen by its effect’s score (damage per magicka, range): the inventory’s score was not read  [original]',
  );
  it.todo('the magic score mult (CSGD) against melee and ranged: with the same score  [original]');
});
