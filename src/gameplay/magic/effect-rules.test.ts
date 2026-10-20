import { describe, expect, it } from 'vitest';
import { EffectArchetype, EffectFlag } from '../../world/magic-effects.ts';
import {
  castStrength,
  isValueEffect,
  magicResistanceApplies,
  resistanceMultiplier,
  soulGemFor,
  soulSize,
  valueAmount,
  valueMode,
  valueSign,
} from './effect-rules.ts';

const effect = (archetype: number, flags = 0) => ({ archetype, flags });

describe('value effects', () => {
  it('recover as temporary modifiers, act at once without a duration, else each second', () => {
    const fortify = effect(EffectArchetype.valueModifier, EffectFlag.recover);
    const damage = effect(EffectArchetype.valueModifier, EffectFlag.detrimental);
    expect(valueMode(fortify, 60, false)).toBe('temporary');
    expect(valueMode(damage, 0, false)).toBe('once');
    expect(valueMode(damage, 10, false)).toBe('perSecond');
    expect(valueMode(damage, 0, true)).toBe('once');
    expect(valueMode(effect(EffectArchetype.valueModifier, EffectFlag.noDuration), 10, false)).toBe(
      'once',
    );
    // Peak value modifiers and the AI's target values are always undone as they end.
    expect(valueMode(effect(EffectArchetype.peakValueModifier), 720, false)).toBe('temporary');
    expect(valueMode(effect(EffectArchetype.calm), 30, false)).toBe('temporary');
    expect(valueSign(damage)).toBe(-1);
    expect(valueSign(fortify)).toBe(1);
  });

  it('know which archetypes change values', () => {
    expect(isValueEffect(effect(EffectArchetype.paralysis))).toBe(true);
    expect(isValueEffect(effect(EffectArchetype.turnUndead))).toBe(true);
    expect(isValueEffect(effect(EffectArchetype.summonCreature))).toBe(false);
    expect(isValueEffect(effect(EffectArchetype.script))).toBe(false);
  });

  it('set a flag value to 1 when they have no magnitude', () => {
    expect(valueAmount({ flags: EffectFlag.noMagnitude }, 0)).toBe(1);
    expect(valueAmount({ flags: 0 }, 25)).toBe(25);
  });
});

describe('cast strength', () => {
  it("scales what the effect's flags say by the power", () => {
    const both = EffectFlag.powerAffectsMagnitude | EffectFlag.powerAffectsDuration;
    expect(castStrength({ magnitude: 10, duration: 30 }, { flags: both }, 2.2)).toEqual({
      magnitude: 22,
      duration: 66,
    });
    expect(
      castStrength({ magnitude: 10, duration: 30 }, { flags: EffectFlag.noDuration }, 2.2),
    ).toEqual({ magnitude: 10, duration: 0 });
  });
});

describe('resistances', () => {
  it("cap the player's and let weaknesses add", () => {
    expect(resistanceMultiplier(50, 85)).toBe(0.5);
    expect(resistanceMultiplier(100, 85)).toBeCloseTo(0.15);
    expect(resistanceMultiplier(100, undefined)).toBe(0);
    expect(resistanceMultiplier(-50, 85)).toBe(1.5);
  });

  it('take Magic Resistance on hostile spells, not potions or spells that ignore it', () => {
    const fire = { flags: EffectFlag.hostile | EffectFlag.detrimental, resistValue: 41 };
    expect(magicResistanceApplies('spell', fire, false)).toBe(true);
    expect(magicResistanceApplies('spell', fire, true)).toBe(false);
    expect(magicResistanceApplies('poison', fire, false)).toBe(false);
    expect(magicResistanceApplies('spell', { flags: 0, resistValue: -1 }, false)).toBe(false);
  });
});

describe('souls', () => {
  it('size by level, black for NPCs', () => {
    expect(soulSize(1, false)).toBe(1);
    expect(soulSize(4, false)).toBe(2);
    expect(soulSize(20, false)).toBe(3);
    expect(soulSize(30, false)).toBe(4);
    expect(soulSize(40, false)).toBe(5);
    expect(soulSize(1, true)).toBe(5);
  });

  it('go into the smallest empty gem that holds them', () => {
    const gems = [
      { id: 'grand', capacity: 5, soul: 0, holdsNpcSouls: false },
      { id: 'black', capacity: 5, soul: 0, holdsNpcSouls: true },
      { id: 'lesser', capacity: 2, soul: 0, holdsNpcSouls: false },
      { id: 'pettyFull', capacity: 1, soul: 1, holdsNpcSouls: false },
    ];
    expect(soulGemFor(gems, 1, false)?.id).toBe('lesser');
    expect(soulGemFor(gems, 5, false)?.id).toBe('grand');
    expect(soulGemFor(gems, 5, true)?.id).toBe('black');
    expect(soulGemFor(gems.slice(2), 3, false)).toBeUndefined();
  });
});
