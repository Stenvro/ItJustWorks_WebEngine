// Conformance: combat magic, choosing the spells (engine map: Combat > Combat magic). When a
// caster casts in a fight and which spell (the casting itself, costs and projectiles: the magic
// suites).
//
// Sources: observed in the original (docs/ai.md, Style values): the cast's chance is the
// offensive mult on fCombatCastImmediateOffensiveMagicChanceMin (0.05) .. Max (0.75), a
// concentration spell's on …ConcentrationOffensiveMagicChanceMin (0.25) .. Max (1), rolled every
// 0.25 s (the Cast Immediate / Concentration Spell Idles); the tree's Magic context
// (CombatBehaviorContextMagic: Cast Immediate Spell, Cast Concentration Spell, Prepare Dual Cast,
// Equip Spell; RTTI). the engine's defaults.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import { castChance } from '../../../src/ai/combat-tactics.ts';
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

  it.todo('casters by purpose: offensive, defensive (wards), restore, summon, buff  [RTTI]');
  it.todo('the spell chosen by its effect’s score (damage per magicka, range)  [original]');
  it.todo('dual casting (Prepare Dual Cast) by the caster’s perks  [RTTI]');
  it.todo('reanimating a corpse within range (the reanimate caster)  [original]');
  it.todo('the magic score mult (CSGD) against melee and ranged  [original]');
});
