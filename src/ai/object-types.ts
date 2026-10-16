// The object types package targets and locations name (PTDA / PLDT type 2 and 5: "Food",
// "Furniture: Beds", "Weapons: Melee", ...; xEdit wbObjectTypeEnum, CommonLibSSE
// PACKAGE_OBJECT_TYPE): whether a base object is of one. Platform-independent.

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from '../world/record-db.ts';

/** The object types, as packages number them. */
export const ObjectType = {
  none: 0,
  activators: 1,
  armor: 2,
  books: 3,
  containers: 4,
  doors: 5,
  ingredients: 6,
  lights: 7,
  miscellaneous: 8,
  flora: 9,
  furniture: 10,
  weaponsAny: 11,
  ammo: 12,
  keys: 13,
  alchemy: 14,
  food: 15,
  combatWearable: 16,
  wearable: 17,
  weaponsNone: 18,
  weaponsMelee: 19,
  weaponsRanged: 20,
  spellsAny: 21,
  spellsTarget: 22,
  spellsTouch: 23,
  spellsSelf: 24,
  actorsAny: 25,
  beds: 26,
  chairs: 27,
  shouts: 28,
} as const;

/** The record types of the object types that are one record type each. */
const RECORD_TYPES: Readonly<Record<number, readonly string[]>> = {
  [ObjectType.activators]: ['ACTI', 'TACT'],
  [ObjectType.armor]: ['ARMO'],
  [ObjectType.books]: ['BOOK'],
  [ObjectType.containers]: ['CONT'],
  [ObjectType.doors]: ['DOOR'],
  [ObjectType.ingredients]: ['INGR'],
  [ObjectType.lights]: ['LIGH'],
  [ObjectType.miscellaneous]: ['MISC', 'SLGM'],
  [ObjectType.flora]: ['FLOR'],
  [ObjectType.furniture]: ['FURN'],
  [ObjectType.weaponsAny]: ['WEAP'],
  [ObjectType.ammo]: ['AMMO'],
  [ObjectType.keys]: ['KEYM'],
  [ObjectType.alchemy]: ['ALCH'],
  [ObjectType.wearable]: ['ARMO', 'WEAP'],
  [ObjectType.spellsAny]: ['SPEL'],
  [ObjectType.actorsAny]: ['NPC_', 'LVLN'],
  [ObjectType.shouts]: ['SHOU'],
};

/** ALCH ENIT flags: a food item. */
const FOOD_ITEM = 0x2;
/** ARMO BOD2 armor type: clothing (0 light, 1 heavy). */
const CLOTHING = 2;
/** WEAP DNAM animation types: bows and crossbows shoot. */
const BOW = 7;
const CROSSBOW = 9;
/** SPEL SPIT deliveries: self, touch (then aimed, target actor, target location). */
const SPELL_SELF = 0;
const SPELL_TOUCH = 1;
/** FNPR marker types: sit (and lean), sleep. */
const SIT = 0x1 | 0x4;
const SLEEP = 0x2;

type Source = Pick<GameRecord, 'type' | 'fields'>;

const u8At = (record: Source, field: string, at: number): number | undefined => {
  const data = record.fields.first(field);
  return data && data.length > at ? data[at] : undefined;
};

const u32At = (record: Source, field: string, at: number): number | undefined => {
  const data = record.fields.first(field);
  return data && data.length >= at + 4 ? view(data).getUint32(at, true) : undefined;
};

/** The furniture's marker types (FNPR: u16 type, u16 entry points). */
const markerTypes = (record: Source): number =>
  record.fields
    .all('FNPR')
    .reduce((types, data) => (data.length >= 2 ? types | view(data).getUint16(0, true) : types), 0);

/**
 * Whether a base object is of an object type. TODO(M13): which weapons "Weapons: None" names
 * (here: none), whether staves count as ranged (here: no); spells by their delivery (SPIT).
 */
export function isOfObjectType(type: number, record: Source): boolean {
  switch (type) {
    case ObjectType.food:
      return record.type === 'ALCH' && ((u32At(record, 'ENIT', 4) ?? 0) & FOOD_ITEM) !== 0;
    case ObjectType.combatWearable: {
      if (record.type === 'WEAP') return true;
      // BOD2: u32 slots, u32 armor type.
      return record.type === 'ARMO' && u32At(record, 'BOD2', 4) !== CLOTHING;
    }
    case ObjectType.weaponsMelee: {
      const anim = u8At(record, 'DNAM', 0);
      return record.type === 'WEAP' && anim !== undefined && anim <= 6;
    }
    case ObjectType.weaponsRanged: {
      const anim = u8At(record, 'DNAM', 0);
      return record.type === 'WEAP' && (anim === BOW || anim === CROSSBOW);
    }
    case ObjectType.weaponsNone:
      return false;
    case ObjectType.spellsTarget:
    case ObjectType.spellsTouch:
    case ObjectType.spellsSelf: {
      if (record.type !== 'SPEL') return false;
      // SPIT: cost, flags, type, charge time, cast type, delivery (0 self, 1 touch, 2 aimed,
      // 3 target actor, 4 target location), ...
      const delivery = u32At(record, 'SPIT', 20);
      if (type === ObjectType.spellsSelf) return delivery === SPELL_SELF;
      if (type === ObjectType.spellsTouch) return delivery === SPELL_TOUCH;
      return delivery !== undefined && delivery > SPELL_TOUCH;
    }
    case ObjectType.beds:
      return record.type === 'FURN' && (markerTypes(record) & SLEEP) !== 0;
    case ObjectType.chairs:
      return record.type === 'FURN' && (markerTypes(record) & SIT) !== 0;
    default:
      return RECORD_TYPES[type]?.includes(record.type) ?? false;
  }
}
