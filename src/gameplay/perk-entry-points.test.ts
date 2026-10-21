import { describe, expect, it } from 'vitest';
import {
  applyEntryFunction,
  ENTRY_POINTS,
  EntryFunction,
  EntryPoint,
  entryPointName,
  isValueFunction,
  orderEntries,
  type EntryFunctionData,
} from './perk-entry-points.ts';

const sources = {
  actorValue: (index: number) => (index === 145 ? 30 : 0),
  random: () => 0.5,
};
const float = (value: number): EntryFunctionData => ({ type: 'float', value });

describe('perk entry points', () => {
  it('lists every entry point of the game with its condition tabs', () => {
    expect(ENTRY_POINTS).toHaveLength(92);
    expect(entryPointName(EntryPoint.modAttackDamage)).toBe('Mod Attack Damage');
    expect(ENTRY_POINTS[EntryPoint.modAttackDamage]?.tabs).toEqual(['owner', 'weapon', 'target']);
    expect(ENTRY_POINTS[EntryPoint.modEnchantmentPower]?.tabs).toEqual([
      'owner',
      'enchantment',
      'item',
    ]);
    expect(entryPointName(EntryPoint.allowMountActor)).toBe('Allow Mount Actor');
    for (const info of ENTRY_POINTS) expect(info.tabs[0]).toBe('owner');
  });

  it('applies each value function', () => {
    const at = (fn: number, data: EntryFunctionData, value = 10): number =>
      applyEntryFunction(value, fn, data, sources);
    expect(at(EntryFunction.setValue, float(3))).toBe(3);
    expect(at(EntryFunction.addValue, float(3))).toBe(13);
    expect(at(EntryFunction.multiplyValue, float(1.5))).toBe(15);
    expect(at(EntryFunction.addRangeToValue, { type: 'range', min: 2, max: 4 })).toBe(13);
    const av: EntryFunctionData = { type: 'actorValue', actorValue: 145, factor: 0.01 };
    expect(at(EntryFunction.addActorValueMult, av)).toBeCloseTo(10.3);
    expect(at(EntryFunction.setToActorValueMult, av)).toBeCloseTo(0.3);
    expect(at(EntryFunction.multiplyActorValueMult, av)).toBeCloseTo(3);
    // Fortify Alchemy 30 through AlchemySkillBoosts: × 1.3.
    expect(at(EntryFunction.multiplyOnePlusActorValueMult, av)).toBeCloseTo(13);
    expect(at(EntryFunction.absoluteValue, { type: 'none' }, -4)).toBe(4);
    expect(at(EntryFunction.negativeAbsoluteValue, { type: 'none' }, 4)).toBe(-4);
    // Functions that pick something leave the value.
    expect(at(EntryFunction.selectSpell, { type: 'spell', spell: 1 })).toBe(10);
    expect(isValueFunction(EntryFunction.selectSpell)).toBe(false);
    expect(isValueFunction(EntryFunction.multiplyOnePlusActorValueMult)).toBe(true);
  });

  it('runs entries by priority, the lowest first, equal ones in their order', () => {
    const entries = [
      { name: 'a', priority: 5 },
      { name: 'b', priority: 0 },
      { name: 'c', priority: 5 },
      { name: 'd', priority: 1 },
    ];
    expect(orderEntries(entries).map((e) => e.name)).toEqual(['b', 'd', 'a', 'c']);
    // Set then multiply differs from multiply then set: the order decides.
    const run = (list: { fn: number; value: number; priority: number }[]): number =>
      orderEntries(list).reduce(
        (value, entry) => applyEntryFunction(value, entry.fn, float(entry.value), sources),
        10,
      );
    expect(
      run([
        { fn: EntryFunction.multiplyValue, value: 2, priority: 1 },
        { fn: EntryFunction.setValue, value: 3, priority: 0 },
      ]),
    ).toBe(6);
  });
});
