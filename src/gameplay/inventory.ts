// What the item menus show of a container's items: the categories (their labels, the game
// settings sFavorites, sAllItems, sWeapons, ...; their bits, which the menus only test, as the
// documented vanilla values: Favorites 0x1, Weapons 0x2, Apparel 0x4, Potions 0x8, Scrolls 0x10,
// Food 0x20, Ingredients 0x40, Books 0x80, Keys 0x100, Misc 0x200, All of them), each item's
// category and card type (the menus' InventoryDefines: ICT_ARMOR 1, ICT_WEAPON 2, ...), and the
// card's data. Platform-independent. Notes: docs/ui.md ("The item menus").

import { ArmorType, BookFlag, PotionFlag, type ItemRecord } from '../world/item-records.ts';

/** The inventory's category bits. */
export const ItemCategory = {
  favorites: 0x1,
  weapons: 0x2,
  apparel: 0x4,
  potions: 0x8,
  scrolls: 0x10,
  food: 0x20,
  ingredients: 0x40,
  books: 0x80,
  keys: 0x100,
  misc: 0x200,
} as const;

/** Every item category (the All category). */
export const ALL_ITEMS = 0x3ff;

/** The inventory's categories in the menu's order: label setting, bits, listed when empty. */
export const INVENTORY_CATEGORIES: readonly {
  readonly setting: string;
  readonly flag: number;
  readonly alwaysShown: boolean;
}[] = [
  { setting: 'sFavorites', flag: ItemCategory.favorites, alwaysShown: true },
  { setting: 'sAllItems', flag: ALL_ITEMS, alwaysShown: true },
  { setting: 'sWeapons', flag: ItemCategory.weapons, alwaysShown: false },
  { setting: 'sApparel', flag: ItemCategory.apparel, alwaysShown: false },
  { setting: 'sPotions', flag: ItemCategory.potions, alwaysShown: false },
  { setting: 'sScrolls', flag: ItemCategory.scrolls, alwaysShown: false },
  { setting: 'sFood', flag: ItemCategory.food, alwaysShown: false },
  { setting: 'sIngredients', flag: ItemCategory.ingredients, alwaysShown: false },
  { setting: 'sBooks', flag: ItemCategory.books, alwaysShown: false },
  { setting: 'sKeys', flag: ItemCategory.keys, alwaysShown: false },
  { setting: 'sMisc', flag: ItemCategory.misc, alwaysShown: false },
];

/** The menus' card types (InventoryDefines). */
export const CardType = {
  none: 0,
  armor: 1,
  weapon: 2,
  misc: 3,
  book: 4,
  food: 5,
  potion: 6,
  spell: 7,
  ingredient: 8,
  key: 9,
  shout: 10,
  activeEffect: 11,
  soulGem: 12,
  spellDefault: 13,
  list: 14,
} as const;

/** The menus' equip states (the row's icon). */
export const EquipState = { none: 0, equipped: 1, left: 2, right: 3, both: 4 } as const;

/** An item's category bit. */
export function itemCategory(item: ItemRecord): number {
  switch (item.type) {
    case 'WEAP':
    case 'AMMO':
      return ItemCategory.weapons;
    case 'ARMO':
      return ItemCategory.apparel;
    case 'ALCH':
      return ((item.potionFlags ?? 0) & PotionFlag.food) !== 0
        ? ItemCategory.food
        : ItemCategory.potions;
    case 'SCRL':
      return ItemCategory.scrolls;
    case 'INGR':
      return ItemCategory.ingredients;
    case 'BOOK':
      return ItemCategory.books;
    case 'KEYM':
      return ItemCategory.keys;
    default:
      return ItemCategory.misc;
  }
}

/** An item's card type. */
export function itemCardType(item: ItemRecord): number {
  switch (item.type) {
    case 'WEAP':
    case 'AMMO':
      return CardType.weapon;
    case 'ARMO':
      return CardType.armor;
    case 'ALCH':
      return ((item.potionFlags ?? 0) & PotionFlag.food) !== 0 ? CardType.food : CardType.potion;
    case 'SCRL':
      return CardType.spell;
    case 'INGR':
      return CardType.ingredient;
    case 'BOOK':
      return CardType.book;
    case 'KEYM':
      return CardType.key;
    case 'SLGM':
      return CardType.soulGem;
    default:
      return CardType.misc;
  }
}

/** The armor's skill (an actor value index): heavy or light armor; clothing has none. */
export function armorSkill(item: ItemRecord): number | undefined {
  const type = item.armor?.armorType;
  if (type === ArmorType.heavy) return 11;
  if (type === ArmorType.light) return 12;
  return undefined;
}

/** The soul level names (sSoulLevelName...): 1 petty .. 5 grand. */
export const SOUL_LEVEL_SETTINGS = [
  '',
  'sSoulLevelNamePetty',
  'sSoulLevelNameLesser',
  'sSoulLevelNameCommon',
  'sSoulLevelNameGreater',
  'sSoulLevelNameGrand',
] as const;

/** A book that teaches a spell or a skill is read on use (the card's verb is the menu's). */
export function bookTeaches(item: ItemRecord): 'spell' | 'skill' | undefined {
  const flags = item.book?.flags ?? 0;
  if ((flags & BookFlag.teachesSpell) !== 0) return 'spell';
  if ((flags & BookFlag.teachesSkill) !== 0) return 'skill';
  return undefined;
}

/**
 * The sound of picking an item up or putting it down: its own (YNAM / ZNAM), else the default
 * object for its kind (weapons, armor, books, ingredients, the rest).
 */
export function itemSound(
  item: Pick<ItemRecord, 'type' | 'pickUpSound' | 'putDownSound'>,
  pickUp: boolean,
  defaults: { get(use: string): number | undefined },
): number | undefined {
  const own = pickUp ? item.pickUpSound : item.putDownSound;
  if (own !== undefined) return own;
  const kind =
    item.type === 'WEAP' || item.type === 'AMMO'
      ? 'W'
      : item.type === 'ARMO'
        ? 'A'
        : item.type === 'BOOK'
          ? 'B'
          : item.type === 'INGR'
            ? 'I'
            : 'G';
  return defaults.get(`${pickUp ? 'PUS' : 'PDS'}${kind}`);
}
