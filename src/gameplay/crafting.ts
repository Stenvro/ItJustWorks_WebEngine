// The crafting menu's model (interface\craftingmenu.swf) and the crafting math, without the UI:
// which menu a workbench opens, the constructible menu's material categories and entries, the
// items a smithing bench improves, the enchanting menu's filters and the alchemy menu's
// effect categories (partitioned filter flags), and the formulas of tempering, enchanting and
// alchemy and the skill uses they give.
// Sources: CommonLibSSE-NG (CraftingSubMenus: ConstructibleObjectMenu FilterFlags,
// EnchantConstructMenu FilterFlag / Category, AlchemyMenu), SkyUI 5 (its crafting defines keep
// the vanilla flags), the movie's ActionScript (ListFilterer), UESP (Skyrim:Smithing,
// Skyrim:Enchanting Effects, Skyrim:Alchemy, Skyrim:Alchemy Effects, Skyrim:Leveling).
// Notes: docs/formats/esm.md ("Crafting"), docs/gameplay.md ("Crafting"). Platform-independent.
// Perks and Fortify effects are inputs here: the running game reads them
// (src/scripting/runtime/crafting-engine.ts: actor values, the perk entry points' hooks).

import { WorkbenchType, type CraftedItemInfo, type Recipe } from '../world/crafting-records.ts';

// --- Which menu a workbench opens -----------------------------------------------------------

/** The frame labels of `_root.Menu` (one per subtype; nothing else differs between them). */
export type CraftingFrame =
  'ConstructibleObject' | 'Smithing' | 'EnchantConstruct' | 'EnchantDestruct' | 'Alchemy';

export type CraftingKind = 'constructible' | 'smithing' | 'enchanting' | 'alchemy';

export interface CraftingMenuType {
  readonly frame: CraftingFrame;
  readonly kind: CraftingKind;
  /** Smithing benches: the form type they improve (grindstone weapons, armor table armor). */
  readonly improves: 'WEAP' | 'ARMO' | undefined;
  /** GMST of the description at the top (`_root.Menu.MenuDescription`). */
  readonly description: string;
}

/**
 * The menu a workbench type (FURN WBDT byte 0) opens, or undefined for furniture that is no
 * workbench. The frames follow the bench types 1-5 in order; bench 4 (enchanting
 * experiment) and 6 (alchemy experiment) are unused in vanilla.
 */
export function craftingMenuOf(benchType: number): CraftingMenuType | undefined {
  switch (benchType) {
    case WorkbenchType.createObject:
      return menu(
        'ConstructibleObject',
        'constructible',
        undefined,
        'sConstructibleMenuDescription',
      );
    case WorkbenchType.smithingWeapon:
      return menu('Smithing', 'smithing', 'WEAP', 'sSmithingMenuDescription');
    case WorkbenchType.smithingArmor:
      return menu('Smithing', 'smithing', 'ARMO', 'sSmithingMenuDescription');
    case WorkbenchType.enchanting:
      return menu('EnchantConstruct', 'enchanting', undefined, 'sEnchantMenuDescription');
    case WorkbenchType.enchantingExperiment:
      return menu('EnchantDestruct', 'enchanting', undefined, 'sEnchantDeconstructMenuDescription');
    case WorkbenchType.alchemy:
    case WorkbenchType.alchemyExperiment:
      return menu('Alchemy', 'alchemy', undefined, 'sAlchemyMenuDescription');
    default:
      return undefined;
  }
}

function menu(
  frame: CraftingFrame,
  kind: CraftingKind,
  improves: 'WEAP' | 'ARMO' | undefined,
  description: string,
): CraftingMenuType {
  return { frame, kind, improves, description };
}

/** A category of the categories list, as SetCategoriesList takes it. */
export interface MenuCategory {
  readonly text: string;
  /** Entries show under it when `entry.filterFlag & flag` (partitioned: a byte equals it). */
  readonly flag: number;
  /** Shown even without entries. */
  readonly bDontHide: boolean;
}

/** SetCategoriesList's arguments: text, flag, bDontHide for each category in turn. */
export function categoriesListArgs(
  categories: readonly MenuCategory[],
): (string | number | boolean)[] {
  return categories.flatMap((c) => [c.text, c.flag, c.bDontHide]);
}

// --- Constructible objects ------------------------------------------------------------------

/**
 * The constructible menu's categories (CommonLib ConstructibleObjectMenu::FilterFlags): an
 * index; an entry's and its category's flag is `1 << index`. SkyUI's FILTERFLAG_CRAFT_JEWELRY
 * (1 << 16), FILTERFLAG_CRAFT_FOOD (1 << 17) and FILTERFLAG_CRAFT_MISC (1 << 30) confirm it.
 */
export const ConstructibleFilter = {
  wood: 0,
  hide: 1,
  draugr: 2,
  iron: 3,
  studded: 4,
  imperial: 5,
  steel: 6,
  leather: 7,
  dwarven: 8,
  elven: 9,
  falmer: 10,
  orcish: 11,
  ebony: 12,
  glass: 13,
  dragon: 14,
  daedric: 15,
  jewelry: 16,
  /** CommonLib's Unk11: created food. */
  food: 17,
  /** GenericCraftableKeyword01..08: 18..25 (HearthFire categories). */
  generic01: 18,
  bonemold: 26,
  chitin: 27,
  nordic: 28,
  stalhrim: 29,
  misc: 30,
  /**
   * DLC1LD_CraftingMaterialAetherium (default object GCKX, sGenericCraftKeywordName10) has no
   * slot in CommonLib's enum: the free bit 31. TODO(M13): check against the game.
   */
  aetherium: 31,
} as const;

export interface ConstructibleCategory {
  readonly index: number;
  /** A GMST editor id ("sWood") or a translation key ("$..."), as the shell resolves it. */
  readonly label: string;
  /** Default object uses (DOBJ) of the keywords that put a created object in it. */
  readonly uses: readonly string[];
}

const generic = (n: number, label: string, use: string): ConstructibleCategory => ({
  index: ConstructibleFilter.generic01 + n - 1,
  label,
  uses: [use],
});

/** Every category, in the order the menu lists them (index order). */
export const CONSTRUCTIBLE_CATEGORIES: readonly ConstructibleCategory[] = [
  { index: ConstructibleFilter.wood, label: 'sWood', uses: ['WMWO'] },
  { index: ConstructibleFilter.hide, label: 'sHide', uses: ['AOHI'] },
  { index: ConstructibleFilter.draugr, label: 'sDraugr', uses: ['WMDR', 'WMDH'] },
  { index: ConstructibleFilter.iron, label: 'sIron', uses: ['WMIR', 'AOFE', 'AOIB'] },
  { index: ConstructibleFilter.studded, label: 'sStudded', uses: ['AOSD'] },
  {
    index: ConstructibleFilter.imperial,
    label: 'sImperial',
    uses: ['WMIM', 'AOIM', 'AOIH', 'AOIR'],
  },
  // AOSC (ArmorMaterialScaled) has no category of its own: Steel (TODO(M13): check).
  { index: ConstructibleFilter.steel, label: 'sSteel', uses: ['WMST', 'AOST', 'AOSP', 'AOSC'] },
  { index: ConstructibleFilter.leather, label: 'sLeather', uses: ['AOFL'] },
  { index: ConstructibleFilter.dwarven, label: 'sDwarven', uses: ['WMDW', 'AODW'] },
  { index: ConstructibleFilter.elven, label: 'sElven', uses: ['WMEL', 'AOEL', 'AOES'] },
  { index: ConstructibleFilter.falmer, label: 'sFalmer', uses: ['WMFA', 'WMFH'] },
  { index: ConstructibleFilter.orcish, label: 'sOrcish', uses: ['WMOR', 'AOOR'] },
  { index: ConstructibleFilter.ebony, label: 'sEbony', uses: ['WMEB', 'AOEB'] },
  { index: ConstructibleFilter.glass, label: 'sGlass', uses: ['WMGL', 'AOGL'] },
  { index: ConstructibleFilter.dragon, label: 'sDragon', uses: ['AODP', 'AODS', 'AODB'] },
  { index: ConstructibleFilter.daedric, label: 'sDaedric', uses: ['WMDA', 'AODA'] },
  { index: ConstructibleFilter.jewelry, label: 'sJewelry', uses: ['JWLR'] },
  { index: ConstructibleFilter.food, label: 'sFood', uses: [] },
  generic(1, 'sGenericCraftKeywordName01', 'GCK1'),
  generic(2, 'sGenericCraftKeywordName02', 'GCK2'),
  generic(3, 'sGenericCraftKeywordName03', 'GCK3'),
  generic(4, 'sGenericCraftKeywordName04', 'GCK4'),
  generic(5, 'sGenericCraftKeywordName05', 'GCK5'),
  generic(6, 'sGenericCraftKeywordName06', 'GCK6'),
  generic(7, 'sGenericCraftKeywordName07', 'GCK7'),
  generic(8, 'sGenericCraftKeywordName08', 'GCK8'),
  {
    index: ConstructibleFilter.bonemold,
    label: '$Crafting_$DLC2ArmorBonemold',
    uses: ['ALBM', 'AHBM'],
  },
  {
    index: ConstructibleFilter.chitin,
    label: '$Crafting_$DLC2ArmorChitin',
    uses: ['ALCH', 'AHCH'],
  },
  {
    index: ConstructibleFilter.nordic,
    label: '$Crafting_$DLC2ArmorNordic',
    uses: ['ALNC', 'AHNC', 'WPNC'],
  },
  {
    index: ConstructibleFilter.stalhrim,
    label: '$Crafting_$DLC2ArmorStalhrim',
    uses: ['ALSM', 'AHSM', 'WPSM'],
  },
  { index: ConstructibleFilter.misc, label: 'sMisc', uses: [] },
  { index: ConstructibleFilter.aetherium, label: 'sGenericCraftKeywordName10', uses: ['GCKX'] },
];

/** An entry's or category's flag for a category index (bit 31 as an unsigned number). */
export function constructibleFlag(index: number): number {
  return (1 << index) >>> 0;
}

/**
 * The material keywords the menu knows (ConstructibleObjectMenu::materialFilterFlags): keyword
 * form id -> category index, from the default objects (`defaultObject(use)`).
 */
export function materialFilterIndices(
  defaultObject: (use: string) => number | undefined,
): Map<number, number> {
  const indices = new Map<number, number>();
  for (const category of CONSTRUCTIBLE_CATEGORIES) {
    for (const use of category.uses) {
      const keyword = defaultObject(use);
      if (keyword !== undefined && !indices.has(keyword)) indices.set(keyword, category.index);
    }
  }
  return indices;
}

/**
 * A created object's category: its first keyword the menu knows, else Food (food potions),
 * else Misc.
 */
export function constructibleCategory(
  item: Pick<CraftedItemInfo, 'keywords' | 'food'>,
  materials: ReadonlyMap<number, number>,
): number {
  for (const keyword of item.keywords) {
    const index = materials.get(keyword);
    if (index !== undefined) return index;
  }
  return item.food ? ConstructibleFilter.food : ConstructibleFilter.misc;
}

/**
 * The constructible menu's categories, every one (the movie hides those without entries:
 * bDontHide false), labelled by `text(label)`.
 */
export function constructibleCategories(text: (label: string) => string): MenuCategory[] {
  return CONSTRUCTIBLE_CATEGORIES.map((category) => ({
    text: text(category.label),
    flag: constructibleFlag(category.index),
    bDontHide: false,
  }));
}

/** Components summed per item (a recipe may name an item twice). */
export function requiredItems(components: Recipe['components']): Map<number, number> {
  const required = new Map<number, number>();
  for (const { item, count } of components) required.set(item, (required.get(item) ?? 0) + count);
  return required;
}

/** Whether `have(item)` (the player's count) covers every component. */
export function hasComponents(
  recipe: Pick<Recipe, 'components'>,
  have: (item: number) => number,
): boolean {
  for (const [item, count] of requiredItems(recipe.components)) {
    if (have(item) < count) return false;
  }
  return true;
}

/** An entry of the constructible menu's item list (ItemList.entryList). */
export interface ConstructibleEntry {
  /** The created object's name. */
  readonly text: string;
  /** How many the recipe makes (the list shows " (n)" when > 1). */
  readonly count: number;
  readonly filterFlag: number;
  /** False: greyed (a component is missing). */
  readonly enabled: boolean;
  /** The created object. */
  readonly formId: number;
  /** The recipe (COBJ). */
  readonly recipe: number;
}

export function constructibleEntry(
  recipe: Recipe,
  name: string,
  category: number,
  have: (item: number) => number,
): ConstructibleEntry {
  return {
    text: name,
    count: recipe.createdCount,
    filterFlag: constructibleFlag(category),
    enabled: hasComponents(recipe, have),
    formId: recipe.created ?? 0,
    recipe: recipe.formId,
  };
}

/** A line of `_root.Menu.UpdateIngredients` (the components under the item card). */
export interface IngredientLine {
  readonly Name: string;
  readonly RequiredCount: number;
  readonly PlayerCount: number;
}

export function ingredientLines(
  components: Recipe['components'],
  name: (item: number) => string,
  have: (item: number) => number,
): IngredientLine[] {
  return [...requiredItems(components)].map(([item, count]) => ({
    Name: name(item),
    RequiredCount: count,
    PlayerCount: have(item),
  }));
}

// --- Smithing (tempering) -------------------------------------------------------------------

export interface TemperCandidate<T> {
  readonly item: T;
  /** The tempering recipe: its created object is the item, its workbench keyword the bench's. */
  readonly recipe: Recipe;
}

/**
 * The player's items a smithing bench lists: those with a recipe at the bench (`recipes`, the
 * bench's own) whose created object is the item's base, else its template (WEAP CNAM, ARMO
 * TNAM: an enchanted variant is improved by its plain item's recipe). One entry per item
 * instance.
 */
export function temperingCandidates<
  T extends { readonly base: number; readonly template?: number | undefined },
>(items: readonly T[], recipes: readonly Recipe[]): TemperCandidate<T>[] {
  const byCreated = new Map<number, Recipe>();
  for (const recipe of recipes) {
    if (recipe.created !== undefined && !byCreated.has(recipe.created))
      byCreated.set(recipe.created, recipe);
  }
  const candidates: TemperCandidate<T>[] = [];
  for (const item of items) {
    const recipe =
      byCreated.get(item.base) ??
      (item.template === undefined ? undefined : byCreated.get(item.template));
    if (recipe) candidates.push({ item, recipe });
  }
  return candidates;
}

/** The skill offset in UESP's effective smithing skill. */
const TEMPER_SKILL_OFFSET = 13.29;

export interface TemperingInputs {
  /** The Smithing skill. */
  readonly skill: number;
  /**
   * The item's material perk (Steel Smithing, ...) is known (doubles), or the factor of the
   * perk entry point Mod Tempering Health (1: none).
   */
  readonly perk: boolean | number;
  /** Fortify Smithing of worn enchantments, as a fraction (two +29% items: 0.58). */
  readonly enchantments?: number;
  /** Fortify Smithing potion, as a fraction. */
  readonly potion?: number;
}

/**
 * UESP: effective skill = (skill - 13.29) x (1 + perk) x (1 + enchantments) x (1 + potion)
 * + 13.29.
 */
export function temperingEffectiveSkill(inputs: TemperingInputs): number {
  const perk = typeof inputs.perk === 'number' ? inputs.perk : inputs.perk ? 2 : 1;
  return (
    (inputs.skill - TEMPER_SKILL_OFFSET) *
      perk *
      (1 + (inputs.enchantments ?? 0)) *
      (1 + (inputs.potion ?? 0)) +
    TEMPER_SKILL_OFFSET
  );
}

/**
 * The quality an item is improved to (UESP): floor((effective skill + 38) x 3 / 103); 1 Fine,
 * 2 Superior, 3 Exquisite, 4 Flawless, 5 Epic, 6 and above Legendary.
 */
export function temperingQualityLevel(effectiveSkill: number): number {
  return Math.max(0, Math.floor(((effectiveSkill + 38) * 3) / 103 + 1e-9));
}

/** Improving gives something only when the quality rises (else sLackRequiredSkillToImprove). */
export function canImprove(currentLevel: number, newLevel: number): boolean {
  return newLevel > currentLevel;
}

/**
 * The armor rating or weapon damage an improvement adds (UESP): (3.6 x level - 1.6) x 1.0 for
 * chest (body) armor, x 0.5 for everything else (weapons too); nothing at level 0.
 */
export function temperingIncrease(level: number, chestArmor: boolean): number {
  if (level <= 0) return 0;
  return (3.6 * level - 1.6) * (chestArmor ? 1 : 0.5);
}

/** An improved armor rating: rounded up (UESP). */
export function temperedArmorRating(base: number, level: number, chestArmor: boolean): number {
  return Math.ceil(base + temperingIncrease(level, chestArmor) - 1e-9);
}

/** Improved weapon damage: rounded to the nearest integer (UESP). */
export function temperedWeaponDamage(base: number, level: number): number {
  return Math.round(base + temperingIncrease(level, false));
}

/**
 * The GMST of a quality's name ("Fine" .. "Legendary"), shown after the item's name, or
 * undefined at level 0. Levels above 6 keep the name "Legendary".
 */
export function temperQualityName(level: number, type: 'WEAP' | 'ARMO'): string | undefined {
  if (level <= 0) return undefined;
  return `sHealthDataPrefix${type === 'WEAP' ? 'Weap' : 'Armo'}${String(Math.min(6, level))}`;
}

/**
 * The item health (ExtraHealth) an improvement stores: 1 + level / 10 (fHealthDataValue1 is
 * 1.1: Fine). TODO(M13): check the higher levels against the game.
 */
export function temperHealth(level: number): number {
  return 1 + level / 10;
}

/** The quality level of a stored item health (inverse of temperHealth; 1 or none: 0). */
export function temperLevelOfHealth(health: number): number {
  return Math.max(0, Math.round((health - 1) * 10));
}

// --- Enchanting -----------------------------------------------------------------------------

/** EnchantConstructMenu::FilterFlag (CommonLib): an entry's filterFlag. */
export const EnchantingFilter = {
  enchantWeapon: 0x1,
  disenchantWeapon: 0x2,
  enchantArmor: 0x4,
  disenchantArmor: 0x8,
  effectWeapon: 0x10,
  effectArmor: 0x20,
  soulGem: 0x40,
} as const;

/** EnchantConstructMenu::Category (CommonLib): what the highlighted entry is. */
export const EnchantingCategory = {
  disenchant: 0,
  soulGem: 1,
  item: 2,
  enchantment: 3,
} as const;

export type EnchantingEntryKind = 'disenchant' | 'item' | 'enchantment' | 'soulGem';

export interface CategoryTemplate {
  /** A GMST editor id; "" for the divider. */
  readonly label: string;
  readonly flag: number;
  readonly bDontHide: boolean;
}

/**
 * The enchanting menu's categories, with SkyUI's flags (FILTERFLAG_ENCHANTING_DISENCHANT 0xA,
 * _ITEM 0x5, _ENCHANTMENT 0x30, _SOULGEM 0x40); a divider (flag 0) after Disenchant.
 * TODO(M13): whether the game upper-cases these texts.
 */
export const ENCHANTING_CATEGORIES: readonly CategoryTemplate[] = [
  { label: 'sDisenchant', flag: 0x0a, bDontHide: true },
  { label: '', flag: 0, bDontHide: true },
  { label: 'sItem', flag: 0x05, bDontHide: true },
  { label: 'sEnchantment', flag: 0x30, bDontHide: true },
  { label: 'sSoulGem', flag: 0x40, bDontHide: true },
];

export function enchantingCategories(text: (label: string) => string): MenuCategory[] {
  return ENCHANTING_CATEGORIES.map(({ label, flag, bDontHide }) => ({
    text: label === '' ? '' : text(label),
    flag,
    bDontHide,
  }));
}

/** An entry's filter flag: its kind, for weapons or for armor (soul gems: neither). */
export function enchantingFilterFlag(kind: EnchantingEntryKind, armor: boolean): number {
  switch (kind) {
    case 'disenchant':
      return armor ? EnchantingFilter.disenchantArmor : EnchantingFilter.disenchantWeapon;
    case 'item':
      return armor ? EnchantingFilter.enchantArmor : EnchantingFilter.enchantWeapon;
    case 'enchantment':
      return armor ? EnchantingFilter.effectArmor : EnchantingFilter.effectWeapon;
    case 'soulGem':
      return EnchantingFilter.soulGem;
  }
}

/** The kind of an entry from its filter flag. */
export function enchantingKindOfFlag(flag: number): EnchantingEntryKind | undefined {
  if (flag & (EnchantingFilter.disenchantWeapon | EnchantingFilter.disenchantArmor))
    return 'disenchant';
  if (flag & (EnchantingFilter.enchantWeapon | EnchantingFilter.enchantArmor)) return 'item';
  if (flag & (EnchantingFilter.effectWeapon | EnchantingFilter.effectArmor)) return 'enchantment';
  if (flag & EnchantingFilter.soulGem) return 'soulGem';
  return undefined;
}

/** Soul sizes (SLGM SOUL / SLCP): 0 empty, 1 Petty .. 5 Grand. */
export const SoulLevel = {
  empty: 0,
  petty: 1,
  lesser: 2,
  common: 3,
  greater: 4,
  grand: 5,
} as const;

/** A soul's charge (UESP): Petty 250, Lesser 500, Common 1000, Greater 2000, Grand 3000. */
export const SOUL_CAPACITY: readonly number[] = [0, 250, 500, 1000, 2000, 3000];

/** The share of an apparel enchantment's magnitude a soul gives (UESP). */
export const SOUL_MAGNITUDE_MULTIPLIER: readonly number[] = [0, 1 / 12, 1 / 6, 1 / 3, 2 / 3, 1];

/** GMST of a soul's name (an entry's `soulLVL`). */
export const SOUL_LEVEL_NAME: readonly string[] = [
  '',
  'sSoulLevelNamePetty',
  'sSoulLevelNameLesser',
  'sSoulLevelNameCommon',
  'sSoulLevelNameGreater',
  'sSoulLevelNameGrand',
];

/** UESP: 1 + (skill / 100) x (skill / 100 - 0.14) / 3.4 (1.25 at 100). */
export function enchantingSkillMultiplier(skill: number): number {
  const s = skill / 100;
  return 1 + (s * (s - 0.14)) / 3.4;
}

export interface EnchantingInputs {
  readonly skill: number;
  /** Fortify Enchanting potion, as a fraction. */
  readonly potion?: number;
  /** Enchanter perk: 0.2 per rank. */
  readonly enchanter?: number;
  /** Fire / Frost / Storm, Insightful or Corpus Enchanter (0.25), or Stalhrim, when it applies. */
  readonly specific?: number;
  /** Seeker of Sorcery (0.1). */
  readonly seeker?: number;
}

const perkFactor = (inputs: EnchantingInputs): number =>
  enchantingSkillMultiplier(inputs.skill) *
  (1 + (inputs.potion ?? 0)) *
  (1 + (inputs.enchanter ?? 0)) *
  (1 + (inputs.specific ?? 0)) *
  (1 + (inputs.seeker ?? 0));

/** An apparel enchantment's magnitude (UESP): base x soul x skill x perks, rounded down. */
export function apparelEnchantmentMagnitude(
  base: number,
  soul: number,
  inputs: EnchantingInputs,
): number {
  return Math.floor(base * (SOUL_MAGNITUDE_MULTIPLIER[soul] ?? 0) * perkFactor(inputs) + 1e-9);
}

/**
 * A weapon enchantment's largest magnitude (the slider's maximum; UESP): floor(floor(base x
 * skill x perks) x (1 + elemental Destruction perk)).
 */
export function weaponEnchantmentMaxMagnitude(
  base: number,
  inputs: EnchantingInputs & { readonly destruction?: number },
): number {
  return Math.floor(
    Math.floor(base * perkFactor(inputs) + 1e-9) * (1 + (inputs.destruction ?? 0)) + 1e-9,
  );
}

/**
 * The engine's enchanting cost settings (not in the load order: the engine's defaults,
 * fEnchantingCostExponent, fEnchantingSkillCostBase, fEnchantingSkillCostMult,
 * fEnchantingSkillCostScale; they give UESP's formula below).
 */
export interface EnchantingCostSettings {
  readonly costExponent: number;
  readonly skillCostBase: number;
  readonly skillCostMult: number;
  readonly skillCostScale: number;
}

export const ENCHANTING_COST_SETTINGS: EnchantingCostSettings = {
  costExponent: 1.1,
  skillCostBase: 0.005,
  skillCostMult: 3,
  skillCostScale: 0.5,
};

export function enchantingCostSettings(
  number: (editorId: string) => number | undefined,
): EnchantingCostSettings {
  const d = ENCHANTING_COST_SETTINGS;
  return {
    costExponent: number('fEnchantingCostExponent') ?? d.costExponent,
    skillCostBase: number('fEnchantingSkillCostBase') ?? d.skillCostBase,
    skillCostMult: number('fEnchantingSkillCostMult') ?? d.skillCostMult,
    skillCostScale: number('fEnchantingSkillCostScale') ?? d.skillCostScale,
  };
}

/**
 * Charge a weapon enchantment uses per hit (UESP): 3 x (base cost x magnitude / max
 * magnitude)^1.1 x (1 - sqrt(skill / 200)), the base cost being the base enchantment's (ENIT)
 * and the skill the enchanter's when it is made.
 */
export function weaponChargePerUse(
  baseCost: number,
  magnitude: number,
  maxMagnitude: number,
  skill: number,
  settings = ENCHANTING_COST_SETTINGS,
): number {
  const share = maxMagnitude > 0 ? magnitude / maxMagnitude : 1;
  return (
    settings.skillCostMult *
    (baseCost * share) ** settings.costExponent *
    Math.max(0, 1 - (settings.skillCostBase * Math.max(0, skill)) ** settings.skillCostScale)
  );
}

/** How many hits a weapon's charge gives (rounded down; a cost of 0: unlimited). */
export function enchantmentUses(charge: number, chargePerUse: number): number {
  return chargePerUse > 0 ? Math.floor(charge / chargePerUse + 1e-9) : Infinity;
}

/**
 * How many enchantments an item may get: 1, 2 with the Extra Effect perk (the perk entry point
 * "# Of Applied Enchantments Allowed" sets it: `allowed`).
 */
export function enchantmentsAllowed(extraEffect: boolean | number): number {
  if (typeof extraEffect === 'number') return Math.max(1, Math.floor(extraEffect));
  return extraEffect ? 2 : 1;
}

/** A base enchantment's effect item, as enchanting scales it. */
export interface EnchantableEffect {
  readonly magnitude: number;
  readonly duration: number;
  /** MGEF DATA flags (MagicEffectFlag: what the power scales). */
  readonly flags: number;
}

/**
 * The value enchanting's power scales on an effect: its duration when the power affects its
 * duration only (Paralyze, Soul Trap), else its magnitude.
 */
export function scaledValueOf(effect: EnchantableEffect): 'magnitude' | 'duration' {
  const magnitude = (effect.flags & MagicEffectFlag.powerAffectsMagnitude) !== 0;
  const duration = (effect.flags & MagicEffectFlag.powerAffectsDuration) !== 0;
  return duration && !magnitude ? 'duration' : 'magnitude';
}

/**
 * An effect enchanted at a power (`strength(base)`: the scaled value from the base's, rounded
 * down by the caller's formula): the magnitude or the duration it scales; the other stays.
 * Effects of a magnitude of 1 or less (Waterbreathing, Muffle: on or off) are not scaled
 * (UESP: no soul or skill changes them; TODO(M13): the engine's own rule is inferred).
 */
export function enchantEffect(
  effect: EnchantableEffect,
  strength: (base: number) => number,
): { magnitude: number; duration: number } {
  if (scaledValueOf(effect) === 'duration') {
    return { magnitude: effect.magnitude, duration: Math.max(1, strength(effect.duration)) };
  }
  if (effect.magnitude <= 1) return { magnitude: effect.magnitude, duration: effect.duration };
  return { magnitude: Math.max(1, strength(effect.magnitude)), duration: effect.duration };
}

/**
 * A weapon enchantment's effect at the slider's value: each effect's largest value
 * (`max(base)`) times the share chosen (value / largest of the first effect), rounded; the
 * first effect gets the value itself.
 */
export function weaponEffectAt(
  effect: EnchantableEffect,
  max: (base: number) => number,
  share: number,
): { magnitude: number; duration: number } {
  return enchantEffect(effect, (base) => Math.max(1, Math.round(max(base) * share)));
}

/** The name an enchanted item gets unless the player names it: "<item> of <enchantment>". */
export function enchantedItemName(item: string, enchantment: string, of = ' of '): string {
  return enchantment === '' ? item : `${item}${of}${enchantment}`;
}

/** A charge as the item card's meter shows it (percent of the full charge). */
export function chargePercent(current: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
}

/** A weapon's charge after a soul is put into it (never above its full charge). */
export function rechargedCharge(current: number, soulCharge: number, max: number): number {
  return Math.min(max, Math.max(0, current) + Math.max(0, soulCharge));
}

// --- Alchemy --------------------------------------------------------------------------------

/** The alchemy menu's first category (sIngredients): its flag matches every entry. */
export const ALCHEMY_ALL_FLAG = 0xffffffff;

/** Up to four category indices (1..255; 0: none) packed one per byte, the first in the low byte. */
export function packEffectCategories(indices: readonly number[]): number {
  let flag = 0;
  for (let i = 0; i < 4; i++) flag |= ((indices[i] ?? 0) & 0xff) << (i * 8);
  return flag >>> 0;
}

export function unpackEffectCategories(flag: number): [number, number, number, number] {
  return [flag & 0xff, (flag >>> 8) & 0xff, (flag >>> 16) & 0xff, flag >>> 24];
}

/** The movie's partitioned filter (ListFilterer): a byte equals the filter, or the filter is all. */
export function partitionMatches(filterFlag: number, itemFilter: number): boolean {
  if (itemFilter >>> 0 === ALCHEMY_ALL_FLAG) return true;
  return unpackEffectCategories(filterFlag).includes(itemFilter);
}

export interface AlchemyEffectCategory {
  /** The magic effect (MGEF). */
  readonly effect: number;
  readonly name: string;
  /** 1-based: the byte entries carry. */
  readonly index: number;
}

/**
 * One category per known effect (deduplicated), sorted by name, numbered from 1; at most 255
 * (a byte). TODO(M13): the game's order is assumed alphabetical.
 */
export function alchemyCategories(
  known: readonly { readonly effect: number; readonly name: string }[],
): AlchemyEffectCategory[] {
  const byEffect = new Map<number, string>();
  for (const { effect, name } of known) if (!byEffect.has(effect)) byEffect.set(effect, name);
  return [...byEffect]
    .sort(([a, nameA], [b, nameB]) => {
      const x = nameA.toLowerCase();
      const y = nameB.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a - b;
    })
    .slice(0, 255)
    .map(([effect, name], i) => ({ effect, name, index: i + 1 }));
}

/** The alchemy menu's category list: "INGREDIENTS" (everything), then the effects. */
export function alchemyCategoryList(
  categories: readonly AlchemyEffectCategory[],
  ingredientsText: string,
): MenuCategory[] {
  return [
    { text: ingredientsText, flag: ALCHEMY_ALL_FLAG, bDontHide: true },
    ...categories.map((c) => ({ text: c.name, flag: c.index, bDontHide: true })),
  ];
}

/**
 * An ingredient entry's filter flag: for each of its (up to four) effects the category index
 * when the player knows that effect, else 0.
 */
export function ingredientFilterFlag(
  effects: readonly number[],
  known: (slot: number) => boolean,
  categories: readonly AlchemyEffectCategory[],
): number {
  const indexOf = new Map(categories.map((c) => [c.effect, c.index]));
  return packEffectCategories(
    effects.slice(0, 4).map((effect, slot) => (known(slot) ? (indexOf.get(effect) ?? 0) : 0)),
  );
}

/** The effects at least two of the ingredients share, in first-seen order (the potion's). */
export function sharedEffects(ingredients: readonly (readonly number[])[]): number[] {
  const counts = new Map<number, number>();
  for (const effects of ingredients) {
    for (const effect of new Set(effects)) counts.set(effect, (counts.get(effect) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= 2).map(([effect]) => effect);
}

/** MGEF DATA flags that alchemy reads (xEdit; checked on the vanilla effects). */
export const MagicEffectFlag = {
  hostile: 0x1,
  detrimental: 0x4,
  noDuration: 0x200,
  noMagnitude: 0x400,
  powerAffectsMagnitude: 0x200000,
  powerAffectsDuration: 0x400000,
} as const;

export interface AlchemyInputs {
  readonly skill: number;
  /** Fortify Alchemy (enchantments and potions), as a fraction. */
  readonly fortify?: number;
  /** Alchemist perk: 0.2 per rank. */
  readonly alchemist?: number;
  /** Physician (0.25) when the effect restores Health, Magicka or Stamina. */
  readonly physician?: number;
  /** Benefactor (0.25) for potions, Poisoner (0.25) for poisons. */
  readonly benefactor?: number;
  readonly poisoner?: number;
  /** Seeker of Shadows (0.1). */
  readonly seeker?: number;
}

/** GMSTs of the alchemy power (engine defaults; the load order sets fAlchemySkillFactor). */
export interface AlchemySettings {
  readonly ingredientInitMult: number;
  readonly skillFactor: number;
}

export const ALCHEMY_SETTINGS: AlchemySettings = { ingredientInitMult: 4, skillFactor: 1.5 };

/**
 * The power of a made potion's effect (UESP): fAlchemyIngredientInitMult x (1 +
 * (fAlchemySkillFactor - 1) x skill / 100) x (1 + Fortify Alchemy) x (1 + Alchemist) x (1 +
 * Physician) x (1 + Benefactor) x (1 + Poisoner) x (1 + Seeker of Shadows).
 */
export function alchemyPower(inputs: AlchemyInputs, settings = ALCHEMY_SETTINGS): number {
  return (
    settings.ingredientInitMult *
    (1 + ((settings.skillFactor - 1) * inputs.skill) / 100) *
    (1 + (inputs.fortify ?? 0)) *
    (1 + (inputs.alchemist ?? 0)) *
    (1 + (inputs.physician ?? 0)) *
    (1 + (inputs.benefactor ?? 0)) *
    (1 + (inputs.poisoner ?? 0)) *
    (1 + (inputs.seeker ?? 0))
  );
}

/**
 * An ingredient effect's magnitude and duration in a potion: the power scales the magnitude
 * (PowerAffectsMagnitude) and / or the duration (PowerAffectsDuration), rounded; NoMagnitude /
 * NoDuration effects have none (UESP Alchemy Effects).
 */
export function alchemyEffectStrength(
  magnitude: number,
  duration: number,
  flags: number,
  power: number,
): { magnitude: number; duration: number } {
  const magnitudeFactor = flags & MagicEffectFlag.powerAffectsMagnitude ? power : 1;
  const durationFactor = flags & MagicEffectFlag.powerAffectsDuration ? power : 1;
  return {
    magnitude: flags & MagicEffectFlag.noMagnitude ? 0 : Math.round(magnitude * magnitudeFactor),
    duration: flags & MagicEffectFlag.noDuration ? 0 : Math.round(duration * durationFactor),
  };
}

/**
 * An effect's gold value (UESP): floor(base cost x (magnitude x duration / 10)^1.1), a zero
 * magnitude counting as 1 and a zero duration as 10 seconds.
 */
export function effectGoldValue(baseCost: number, magnitude: number, duration: number): number {
  const m = magnitude > 0 ? magnitude : 1;
  const d = duration > 0 ? duration / 10 : 1;
  return Math.floor(baseCost * (m * d) ** 1.1 + 1e-9);
}

/**
 * The index of the costliest effect (values before perks; the first of equals): it names the
 * potion ("Potion of " / "Poison of " + its name) and makes it a poison when it is hostile.
 */
export function strongestEffect(values: readonly number[]): number {
  let best = -1;
  values.forEach((value, i) => {
    if (best < 0 || value > (values[best] ?? 0)) best = i;
  });
  return best;
}

/** Purity: a potion keeps only beneficial effects, a poison only hostile ones. */
export function purityKeeps(hostile: boolean, poison: boolean): boolean {
  return hostile === poison;
}

/** An ingredient's effect item (INGR EFID / EFIT). */
export interface IngredientEffect {
  readonly effect: number;
  readonly magnitude: number;
  readonly duration: number;
  readonly area: number;
}

/** What alchemy reads of a magic effect (MGEF DATA). */
export interface AlchemyEffectInfo {
  readonly baseCost: number;
  readonly flags: number;
}

/** An effect of a potion made. */
export interface BrewedEffect {
  readonly effect: number;
  readonly magnitude: number;
  readonly duration: number;
  readonly area: number;
  /** Its gold value (effectGoldValue). */
  readonly value: number;
}

export interface BrewedPotion {
  /** Its effects, the strongest (costliest) first: it names the potion. */
  readonly effects: readonly BrewedEffect[];
  /** The strongest effect is hostile. */
  readonly poison: boolean;
  /** Its gold value: its effects' summed. */
  readonly value: number;
}

/**
 * The potion ingredients make (UESP "Skyrim:Alchemy"), or undefined when they share no effect:
 * each shared effect from the ingredient whose version of it is the strongest (the costliest
 * at the power), at the power (`power(effect)`: the skill's, Fortify Alchemy's and the perks'
 * that apply to it; `rank` the power before effect-specific perks, which orders them); a
 * poison when the strongest is hostile; Purity (`purify`) keeps only those of its kind.
 */
export function brewPotion(
  ingredients: readonly (readonly IngredientEffect[])[],
  info: (effect: number) => AlchemyEffectInfo | undefined,
  power: (effect: number) => number,
  rank: number,
  purify = false,
): BrewedPotion | undefined {
  const shared = sharedEffects(ingredients.map((effects) => effects.map((e) => e.effect)));
  if (shared.length === 0) return undefined;
  const ranked: { effect: BrewedEffect; rank: number; hostile: boolean }[] = [];
  for (const effect of shared) {
    const data = info(effect);
    if (!data) continue;
    const strengthAt = (entry: IngredientEffect, at: number) =>
      alchemyEffectStrength(entry.magnitude, entry.duration, data.flags, at);
    const valueAt = (entry: IngredientEffect, at: number) => {
      const strength = strengthAt(entry, at);
      return effectGoldValue(data.baseCost, strength.magnitude, strength.duration);
    };
    // The strongest version of it among the ingredients (UESP: ingredients of a stronger
    // effect lend it their magnitude and duration).
    let best: IngredientEffect | undefined;
    for (const effects of ingredients) {
      for (const entry of effects) {
        if (entry.effect !== effect) continue;
        if (!best || valueAt(entry, rank) > valueAt(best, rank)) best = entry;
      }
    }
    if (!best) continue;
    const strength = strengthAt(best, power(effect));
    ranked.push({
      effect: {
        effect,
        magnitude: strength.magnitude,
        duration: strength.duration,
        area: best.area,
        value: effectGoldValue(data.baseCost, strength.magnitude, strength.duration),
      },
      rank: valueAt(best, rank),
      hostile: (data.flags & MagicEffectFlag.hostile) !== 0,
    });
  }
  if (ranked.length === 0) return undefined;
  // The costliest first (the first of equals stays first).
  const sorted = ranked
    .map((entry, i) => ({ ...entry, i }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i);
  const poison = sorted[0]?.hostile ?? false;
  const kept = purify ? sorted.filter((entry) => purityKeeps(entry.hostile, poison)) : sorted;
  const effects = kept.map((entry) => entry.effect);
  return { effects, poison, value: effects.reduce((sum, e) => sum + e.value, 0) };
}

/** A made potion's name: "Potion of " / "Poison of " (sCreated*NamePrefix) + its strongest effect. */
export function potionName(prefix: string, effectName: string): string {
  return `${prefix}${effectName}`;
}

// --- Skill uses -----------------------------------------------------------------------------

/** Crafting GMSTs with their vanilla values (all set in the load order). */
export interface CraftingSettings {
  readonly constructibleSkillUseMult: number;
  readonly constructibleSkillUseExp: number;
  readonly constructibleSkillUseConst: number;
  readonly temperingSkillUseMult: number;
  readonly temperingSkillUseItemValMult: number;
  readonly temperingSkillUseItemValExp: number;
  readonly temperingSkillUseItemValConst: number;
  readonly disenchantSkillUse: number;
  readonly skillUsageRechargeMult: number;
  readonly wortFailSkillUseMagnitude: number;
}

export const CRAFTING_SETTINGS: CraftingSettings = {
  constructibleSkillUseMult: 3,
  constructibleSkillUseExp: 0.65,
  constructibleSkillUseConst: 25,
  temperingSkillUseMult: 1,
  temperingSkillUseItemValMult: 8,
  temperingSkillUseItemValExp: 0.6,
  temperingSkillUseItemValConst: 25,
  disenchantSkillUse: 0.0025,
  skillUsageRechargeMult: 0.0002,
  wortFailSkillUseMagnitude: 5,
};

/** The settings from GMSTs (`number(editorId)`), vanilla values for those not set. */
export function craftingSettings(
  number: (editorId: string) => number | undefined,
): CraftingSettings {
  const d = CRAFTING_SETTINGS;
  return {
    constructibleSkillUseMult: number('fConstructibleSkillUseMult') ?? d.constructibleSkillUseMult,
    constructibleSkillUseExp: number('fConstructibleSkilluseExp') ?? d.constructibleSkillUseExp,
    constructibleSkillUseConst:
      number('fConstructibleSkillUseConst') ?? d.constructibleSkillUseConst,
    temperingSkillUseMult: number('fTemperingSkillUseMult') ?? d.temperingSkillUseMult,
    temperingSkillUseItemValMult:
      number('fTemperingSkillUseItemValMult') ?? d.temperingSkillUseItemValMult,
    temperingSkillUseItemValExp:
      number('fTemperingSkillUseItemValExp') ?? d.temperingSkillUseItemValExp,
    temperingSkillUseItemValConst:
      number('fTemperingSkillUseItemValConst') ?? d.temperingSkillUseItemValConst,
    disenchantSkillUse: number('fDisenchantSkillUse') ?? d.disenchantSkillUse,
    skillUsageRechargeMult: number('fSkillUsageRechargeMult') ?? d.skillUsageRechargeMult,
    wortFailSkillUseMagnitude: number('fWortFailSkillUseMagnitude') ?? d.wortFailSkillUseMagnitude,
  };
}

/**
 * Skill use of making something at a workbench with a skill (UESP Smithing): 3 x value^0.65 +
 * 25, the value being that of everything the recipe makes.
 */
export function constructibleSkillUse(totalValue: number, settings = CRAFTING_SETTINGS): number {
  return (
    settings.constructibleSkillUseMult *
      Math.max(0, totalValue) ** settings.constructibleSkillUseExp +
    settings.constructibleSkillUseConst
  );
}

/**
 * Skill use of improving an item (Update.esm's settings, the constructible formula's kind):
 * fTemperingSkillUseMult x (fTemperingSkillUseItemValMult x value^fTemperingSkillUseItemValExp +
 * fTemperingSkillUseItemValConst), the value being the item's base value (UESP: the same
 * whatever quality it reaches). TODO(M13): whether the engine reads the value before or after
 * the improvement.
 */
export function temperingSkillUse(itemValue: number, settings = CRAFTING_SETTINGS): number {
  return (
    settings.temperingSkillUseMult *
    (settings.temperingSkillUseItemValMult *
      Math.max(0, itemValue) ** settings.temperingSkillUseItemValExp +
      settings.temperingSkillUseItemValConst)
  );
}

/** Skill use of enchanting an item: 1, whatever the item, enchantment or soul (UESP). */
export const ENCHANTING_SKILL_USE = 1;

/** Skill use of disenchanting (UESP: 1 per 400 gold of the enchantment). */
export function disenchantSkillUse(enchantmentValue: number, settings = CRAFTING_SETTINGS): number {
  return enchantmentValue * settings.disenchantSkillUse;
}

/** Skill use of recharging with a soul's charge (Petty 250: 0.05 .. Grand 3000: 0.6). */
export function rechargeSkillUse(soulCharge: number, settings = CRAFTING_SETTINGS): number {
  return Math.max(0, soulCharge) * settings.skillUsageRechargeMult;
}

/**
 * Skill use of making a potion (UESP Leveling): its gold value. TODO(M13): whether the
 * alchemy perks' share of the value counts.
 */
export function alchemySkillUse(potionValue: number): number {
  return Math.max(0, potionValue);
}

/**
 * Skill use of ingredients that make nothing (they are used up): fWortFailSkillUseMagnitude.
 * TODO(M13): the setting's use is inferred from its name.
 */
export function failedAlchemySkillUse(settings = CRAFTING_SETTINGS): number {
  return settings.wortFailSkillUseMagnitude;
}

/** Skill experience of a skill use (AVIF AVSK: use mult x use + offset; UESP Leveling). */
export function skillExperience(use: number, useMult: number, useOffset: number): number {
  return useMult * use + useOffset;
}
