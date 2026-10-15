import { describe, expect, it } from 'vitest';
import type { Recipe } from '../world/crafting-records.ts';
import {
  ALCHEMY_ALL_FLAG,
  alchemyCategories,
  alchemyCategoryList,
  alchemyEffectStrength,
  alchemyPower,
  alchemySkillUse,
  apparelEnchantmentMagnitude,
  canImprove,
  categoriesListArgs,
  constructibleCategories,
  constructibleCategory,
  constructibleEntry,
  constructibleFlag,
  ConstructibleFilter,
  constructibleSkillUse,
  craftingMenuOf,
  craftingSettings,
  disenchantSkillUse,
  effectGoldValue,
  enchantingCategories,
  enchantingFilterFlag,
  enchantingKindOfFlag,
  enchantingSkillMultiplier,
  enchantmentUses,
  hasComponents,
  ingredientFilterFlag,
  ingredientLines,
  MagicEffectFlag,
  materialFilterIndices,
  packEffectCategories,
  partitionMatches,
  purityKeeps,
  rechargeSkillUse,
  sharedEffects,
  SoulLevel,
  strongestEffect,
  temperedArmorRating,
  temperedWeaponDamage,
  temperHealth,
  temperingCandidates,
  temperingEffectiveSkill,
  temperingIncrease,
  temperingQualityLevel,
  temperingSkillUse,
  temperLevelOfHealth,
  temperQualityName,
  unpackEffectCategories,
  weaponChargePerUse,
  weaponEnchantmentMaxMagnitude,
} from './crafting.ts';

const recipe = (formId: number, created: number, components: [number, number][]): Recipe => ({
  formId,
  editorId: '',
  created,
  createdCount: 1,
  workbench: 0x88105,
  components: components.map(([item, count]) => ({ item, count })),
  conditions: [],
});

describe('crafting menu types', () => {
  it('open the frame of the workbench type', () => {
    expect(craftingMenuOf(1)).toMatchObject({
      frame: 'ConstructibleObject',
      kind: 'constructible',
    });
    expect(craftingMenuOf(2)).toMatchObject({ frame: 'Smithing', improves: 'WEAP' });
    expect(craftingMenuOf(7)).toMatchObject({ frame: 'Smithing', improves: 'ARMO' });
    expect(craftingMenuOf(3)).toMatchObject({
      frame: 'EnchantConstruct',
      description: 'sEnchantMenuDescription',
    });
    expect(craftingMenuOf(5)?.frame).toBe('Alchemy');
    expect(craftingMenuOf(0)).toBeUndefined();
  });
});

describe('constructible objects', () => {
  const defaults = new Map([
    ['WMIR', 0x1e718],
    ['AOFE', 0x6bbe3],
    ['JWLR', 0x6bbe9],
    ['GCKX', 0x200e299],
  ]);
  const materials = materialFilterIndices((use) => defaults.get(use));

  it('flag a category with its bit; bit 31 stays unsigned', () => {
    expect(constructibleFlag(ConstructibleFilter.jewelry)).toBe(0x10000);
    expect(constructibleFlag(ConstructibleFilter.food)).toBe(0x20000);
    expect(constructibleFlag(ConstructibleFilter.misc)).toBe(0x40000000);
    expect(constructibleFlag(ConstructibleFilter.aetherium)).toBe(0x80000000);
  });

  it('pick the first known keyword, else food, else misc', () => {
    expect(materials.get(0x1e718)).toBe(ConstructibleFilter.iron);
    expect(materials.get(0x200e299)).toBe(ConstructibleFilter.aetherium);
    expect(
      constructibleCategory({ keywords: [0x123, 0x6bbe9, 0x1e718], food: false }, materials),
    ).toBe(ConstructibleFilter.jewelry);
    expect(constructibleCategory({ keywords: [0x123], food: true }, materials)).toBe(
      ConstructibleFilter.food,
    );
    expect(constructibleCategory({ keywords: [], food: false }, materials)).toBe(
      ConstructibleFilter.misc,
    );
  });

  it('list every category in index order, hidden when empty', () => {
    const categories = constructibleCategories((label) => label.toUpperCase());
    expect(categories[0]).toEqual({ text: 'SWOOD', flag: 1, bDontHide: false });
    expect(categories.map((c) => c.flag)).toEqual(
      [...categories.map((c) => c.flag)].sort((a, b) => a - b),
    );
    expect(categoriesListArgs(categories.slice(0, 2))).toEqual([
      'SWOOD',
      1,
      false,
      'SHIDE',
      2,
      false,
    ]);
  });

  it('enable an entry when the player has every component (summed per item)', () => {
    const have = (item: number) => (item === 0x5ace5 ? 3 : item === 0x800e4 ? 1 : 0);
    const sword = recipe(0x1, 0x12eb7, [
      [0x5ace5, 1],
      [0x800e4, 1],
    ]);
    expect(hasComponents(sword, have)).toBe(true);
    const twice = recipe(0x2, 0x12eb7, [
      [0x5ace5, 2],
      [0x5ace5, 2],
    ]);
    expect(hasComponents(twice, have)).toBe(false);
    expect(constructibleEntry(sword, 'Iron Sword', ConstructibleFilter.iron, have)).toEqual({
      text: 'Iron Sword',
      count: 1,
      filterFlag: 1 << ConstructibleFilter.iron,
      enabled: true,
      formId: 0x12eb7,
      recipe: 0x1,
    });
    expect(ingredientLines(twice.components, () => 'Iron Ingot', have)).toEqual([
      { Name: 'Iron Ingot', RequiredCount: 4, PlayerCount: 3 },
    ]);
  });
});

describe('smithing', () => {
  it('list the items a recipe at the bench improves, one entry per instance', () => {
    const recipes = [recipe(1, 0x12eb7, []), recipe(2, 0x13982, [])];
    const items = [
      { base: 0x12eb7, health: 1 },
      { base: 0x99999, health: 1 },
      { base: 0x12eb7, health: 1.2 },
    ];
    expect(
      temperingCandidates(items, recipes).map((c) => [c.item.health, c.recipe.formId]),
    ).toEqual([
      [1, 1],
      [1.2, 1],
    ]);
  });

  it("reach UESP's quality thresholds, with and without the material perk", () => {
    const level = (skill: number, perk: boolean) =>
      temperingQualityLevel(temperingEffectiveSkill({ skill, perk }));
    expect([14, 30, 31, 64, 65, 99, 100, 134, 168].map((s) => level(s, false))).toEqual([
      1, 1, 2, 2, 3, 3, 4, 5, 6,
    ]);
    expect([21, 22, 39, 40, 57, 74, 91].map((s) => level(s, true))).toEqual([1, 2, 2, 3, 4, 5, 6]);
    // A Fortify Smithing potion of 30% and an enchantment of 29%.
    expect(level(100, false)).toBeLessThan(
      temperingQualityLevel(
        temperingEffectiveSkill({ skill: 100, perk: false, potion: 0.3, enchantments: 0.29 }),
      ),
    );
    expect(canImprove(2, 2)).toBe(false);
    expect(canImprove(1, 2)).toBe(true);
  });

  it("add UESP's ratings: armor rounded up, weapon damage rounded", () => {
    // Other armor: +1 Fine, +3 Superior, +5 Exquisite, +7 Flawless, +9 Epic, +10 Legendary.
    expect([1, 2, 3, 4, 5, 6].map((l) => temperedArmorRating(0, l, false))).toEqual([
      1, 3, 5, 7, 9, 10,
    ]);
    expect(temperingIncrease(2, true)).toBeCloseTo(5.6);
    expect(temperedArmorRating(25, 2, true)).toBe(31);
    expect(temperedWeaponDamage(7, 2)).toBe(10);
    expect(temperedWeaponDamage(7, 0)).toBe(7);
  });

  it('name the quality and store it as item health', () => {
    expect(temperQualityName(0, 'WEAP')).toBeUndefined();
    expect(temperQualityName(1, 'WEAP')).toBe('sHealthDataPrefixWeap1');
    expect(temperQualityName(9, 'ARMO')).toBe('sHealthDataPrefixArmo6');
    expect(temperHealth(1)).toBeCloseTo(1.1);
    expect(temperLevelOfHealth(temperHealth(4))).toBe(4);
    expect(temperLevelOfHealth(1)).toBe(0);
  });
});

describe('enchanting', () => {
  it('flag entries by kind and slot, and read the kind back', () => {
    expect(enchantingFilterFlag('disenchant', true)).toBe(0x8);
    expect(enchantingFilterFlag('item', false)).toBe(0x1);
    expect(enchantingFilterFlag('enchantment', true)).toBe(0x20);
    expect(enchantingFilterFlag('soulGem', false)).toBe(0x40);
    for (const kind of ['disenchant', 'item', 'enchantment', 'soulGem'] as const) {
      expect(enchantingKindOfFlag(enchantingFilterFlag(kind, true))).toBe(kind);
    }
    const categories = enchantingCategories((label) => label.slice(1));
    expect(categories.map((c) => [c.text, c.flag])).toEqual([
      ['Disenchant', 0x0a],
      ['', 0],
      ['Item', 0x05],
      ['Enchantment', 0x30],
      ['SoulGem', 0x40],
    ]);
  });

  it("follow UESP's magnitudes and charges", () => {
    expect(enchantingSkillMultiplier(100)).toBeCloseTo(1.2529, 4);
    expect(enchantingSkillMultiplier(14)).toBeCloseTo(1, 6);
    // An apparel enchantment of base 50 at skill 100 with all five Enchanter ranks.
    expect(apparelEnchantmentMagnitude(50, SoulLevel.grand, { skill: 100, enchanter: 1 })).toBe(
      125,
    );
    expect(apparelEnchantmentMagnitude(50, SoulLevel.petty, { skill: 100, enchanter: 1 })).toBe(10);
    // Fire damage 10, Fire Enchanter, Augmented Flames 2 (+50% in the second floor).
    expect(
      weaponEnchantmentMaxMagnitude(10, {
        skill: 100,
        enchanter: 1,
        specific: 0.25,
        destruction: 0.5,
      }),
    ).toBe(Math.floor(Math.floor(10 * enchantingSkillMultiplier(100) * 2 * 1.25) * 1.5));
    const perUse = weaponChargePerUse(30, 10, 10, 0);
    expect(perUse).toBeCloseTo(3 * 30 ** 1.1);
    expect(weaponChargePerUse(30, 10, 10, 200)).toBe(0);
    expect(enchantmentUses(3000, perUse)).toBe(Math.floor(3000 / perUse));
    expect(enchantmentUses(3000, 0)).toBe(Infinity);
  });
});

describe('alchemy', () => {
  it('pack up to four category indices into the bytes of a filter flag', () => {
    expect(packEffectCategories([1, 2, 3, 4])).toBe(0x04030201);
    expect(packEffectCategories([255, 0, 0, 200])).toBe(0xc80000ff);
    expect(unpackEffectCategories(0xc80000ff)).toEqual([255, 0, 0, 200]);
    expect(partitionMatches(0x04030201, 3)).toBe(true);
    expect(partitionMatches(0x04030201, 5)).toBe(false);
    expect(partitionMatches(0, ALCHEMY_ALL_FLAG)).toBe(true);
  });

  it('number the known effects alphabetically and flag ingredients with the known ones', () => {
    const categories = alchemyCategories([
      { effect: 0x3eb15, name: 'Restore Health' },
      { effect: 0x3eb01, name: 'Damage Magicka Regen' },
      { effect: 0x3eb15, name: 'Restore Health' },
      { effect: 0x3eaf3, name: 'Fortify Health' },
    ]);
    expect(categories.map((c) => [c.name, c.index])).toEqual([
      ['Damage Magicka Regen', 1],
      ['Fortify Health', 2],
      ['Restore Health', 3],
    ]);
    expect(alchemyCategoryList(categories, 'INGREDIENTS')[0]).toEqual({
      text: 'INGREDIENTS',
      flag: 0xffffffff,
      bDontHide: true,
    });
    // Effects 1 and 3 known, effect 2 known but not among the categories, effect 4 unknown.
    const flag = ingredientFilterFlag(
      [0x3eb15, 0x3eaf3, 0x99999, 0x3eb01],
      (slot) => slot !== 3,
      categories,
    );
    expect(unpackEffectCategories(flag)).toEqual([3, 2, 0, 0]);
  });

  it('find the shared effects, the strongest one and what Purity keeps', () => {
    expect(
      sharedEffects([
        [1, 2, 3, 4],
        [5, 2, 6, 7],
        [8, 9, 3, 2],
      ]),
    ).toEqual([2, 3]);
    expect(sharedEffects([[1, 1], [2]])).toEqual([]);
    expect(strongestEffect([3, 10, 10])).toBe(1);
    expect(strongestEffect([])).toBe(-1);
    expect(purityKeeps(true, true)).toBe(true);
    expect(purityKeeps(false, true)).toBe(false);
  });

  it("follow UESP's power, strengths and values", () => {
    expect(alchemyPower({ skill: 15 })).toBeCloseTo(4.3);
    expect(alchemyPower({ skill: 100, alchemist: 1 })).toBeCloseTo(12);
    // Restore Health (power affects magnitude, no duration), Paralysis (duration, no magnitude).
    const restore = MagicEffectFlag.powerAffectsMagnitude | MagicEffectFlag.noDuration;
    expect(alchemyEffectStrength(5, 0, restore, 4.3)).toEqual({ magnitude: 22, duration: 0 });
    const paralysis = MagicEffectFlag.powerAffectsDuration | MagicEffectFlag.noMagnitude;
    expect(alchemyEffectStrength(0, 1, paralysis, 4.3)).toEqual({ magnitude: 0, duration: 4 });
    expect(effectGoldValue(1, 10, 0)).toBe(12);
    expect(effectGoldValue(500, 0, 10)).toBe(500);
    expect(effectGoldValue(3, 2, 60)).toBe(Math.floor(3 * 12 ** 1.1));
  });
});

describe('skill uses', () => {
  it('give the GMST and UESP skill uses', () => {
    expect(constructibleSkillUse(0)).toBe(25);
    expect(constructibleSkillUse(100)).toBeCloseTo(3 * 100 ** 0.65 + 25);
    expect(temperingSkillUse(16, 1)).toBeCloseTo(15.2);
    expect(disenchantSkillUse(400)).toBeCloseTo(1);
    expect(rechargeSkillUse(SoulLevel.petty)).toBeCloseTo(0.05);
    expect(rechargeSkillUse(SoulLevel.grand)).toBeCloseTo(0.6);
    expect(alchemySkillUse(50)).toBe(51);
    const settings = craftingSettings((id) =>
      id === 'fConstructibleSkillUseConst' ? 10 : undefined,
    );
    expect(constructibleSkillUse(0, settings)).toBe(10);
  });
});
