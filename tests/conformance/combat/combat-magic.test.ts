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
import {
  chooseCaster,
  COMBAT_SUBTREE_DEFAULTS,
  dualCastHold,
  type CasterState,
} from '../../../src/ai/combat-subtrees.ts';
import { NO_STYLE } from '../../../src/ai/combat-profile.ts';
import { castChance, equipmentMult, equipmentScore } from '../../../src/ai/combat-tactics.ts';
import { combatSpellScore, type ScoredEffect } from '../../../src/gameplay/combat/spell-score.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { EffectArchetype, EffectFlag } from '../../../src/world/magic-effects.ts';
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

  it('casters by purpose: offensive, defensive (wards), restore, summon, buff  [RTTI]', () => {
    expect(chooseCaster(idle)).toBeUndefined();
    expect(chooseCaster({ ...idle, wardThreat: true })).toBe('ward');
    expect(chooseCaster({ ...idle, health: 0.2 })).toBe('restore');
    expect(chooseCaster({ ...idle, canSummon: true })).toBe('summon');
    expect(chooseCaster({ ...idle, canBuff: true })).toBe('buff');
  });

  it('dual casting (Prepare Dual Cast): charged, then loosed from both hands  [RTTI]', () => {
    expect(JSON.stringify(COMBAT_TREES)).toContain('"action":"prepareDualCast"');
    expect(dualCastHold(0.5, 1)).toBe('charging');
    expect(dualCastHold(COMBAT_SUBTREE_DEFAULTS.dualCastInterruptTime, 1)).toBe('interrupt');
  });

  it('reanimating a corpse within range (the reanimate caster)  [original]', () => {
    const raising = { ...idle, canReanimate: true };
    expect(chooseCaster({ ...raising, corpseDistance: 500 })).toBe('reanimate');
    expect(chooseCaster({ ...raising, corpseDistance: undefined })).toBeUndefined();
  });

  const effect = (over: Partial<ScoredEffect>): ScoredEffect => ({
    archetype: EffectArchetype.valueModifier,
    actorValue: ActorValue.health,
    secondActorValue: -1,
    secondValueWeight: 0,
    flags: EffectFlag.hostile,
    taperDuration: 0,
    taperWeight: 0,
    magnitude: 10,
    duration: 0,
    cost: 50,
    kept: 1,
    ...over,
  });

  it('the spell’s score: what it does × its seconds × what is kept × its kind’s weight  [original]', () => {
    const aimed = (...effects: ScoredEffect[]) =>
      combatSpellScore({ self: false, concentration: false, effects });
    // Damage to health, one second at least; for 3 s three times that.
    expect(aimed(effect({}))).toEqual({ score: 10, caster: 'offensive' });
    expect(aimed(effect({ duration: 3 })).score).toBe(30);
    // A concentration spell counts fCombatMagicConcentrationScoreDuration (3).
    expect(
      combatSpellScore({ self: false, concentration: true, effects: [effect({})] }).score,
    ).toBe(30);
    // Half a target's resistance is half the score; a taper adds half its seconds × weight.
    expect(aimed(effect({ kept: 0.5 })).score).toBe(5);
    expect(aimed(effect({ taperDuration: 2, taperWeight: 1 })).score).toBe(20);
    // Stagger counts ten times; magicka half and no caster of its own.
    const stagger = effect({ archetype: EffectArchetype.stagger, actorValue: -1 });
    expect(aimed(stagger)).toEqual({ score: 100, caster: 'stagger' });
    expect(aimed(effect({ actorValue: ActorValue.magicka }))).toEqual({
      score: 5,
      caster: undefined,
    });
    // Both together: the sum, the caster the strongest's.
    expect(aimed(effect({}), stagger)).toEqual({ score: 110, caster: 'stagger' });
    // A summons by its cost; a heal on the caster itself.
    const summon = effect({
      archetype: EffectArchetype.summonCreature,
      actorValue: -1,
      flags: 0,
      duration: 60,
    });
    expect(combatSpellScore({ self: true, concentration: false, effects: [summon] })).toEqual({
      score: 3000,
      caster: 'summon',
    });
    expect(
      combatSpellScore({
        self: true,
        concentration: false,
        effects: [effect({ flags: 0 })],
      }).caster,
    ).toBe('restore');
  });

  it('its casters by their spells’ scores, no fixed order  [original]', () => {
    const both = { ...idle, canSummon: true, canBuff: true };
    // Without scores, the checks' order.
    expect(chooseCaster(both)).toBe('summon');
    expect(chooseCaster({ ...both, scores: { summon: 5, buff: 9 } })).toBe('buff');
    expect(chooseCaster({ ...both, scores: { summon: 9, buff: 5 } })).toBe('summon');
  });

  it('the magic score mult (CSGD) against melee and ranged, at the same score  [original]', () => {
    const score = { damage: 20, range: 2000, equipped: false } as const;
    const bow = { kind: 'ranged', id: 1, ...score } as const;
    const spell = { kind: 'magic', id: 2, ...score } as const;
    const style = styleWith({
      equipmentScoreMult: { ...NO_STYLE.general.equipmentScoreMult, magic: 3 },
    });
    expect(equipmentMult(style, 'magic')).toBe(3);
    // The same score at the same fit: only the style's mult between them.
    expect(equipmentScore(spell, 1500, style, COMBAT_AI_DEFAULTS)).toBeCloseTo(
      3 * equipmentScore(bow, 1500, style, COMBAT_AI_DEFAULTS),
    );
  });
});
