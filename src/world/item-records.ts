// The things a player can carry (the item menus' entries): weapons, armor, ammunition,
// potions and food, ingredients, books, scrolls, miscellaneous items, keys, soul gems and
// carryable lights, read into one shape: name, value, weight, keywords, models, and what each
// kind adds (a weapon's damage and skill, armor's rating and slots, a potion's or a scroll's
// effects, a book's teaching, a soul gem's soul). Layouts after UESP's "Skyrim Mod:Mod File
// Format" pages and xEdit's TES5 definitions; non-playable items (they never show in a menu)
// are flagged. Platform-independent. Notes: docs/formats/esm.md ("Items").

import { RecordFlag } from '../formats/esm/record.ts';
import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<
  GameRecord,
  'formId' | 'type' | 'flags' | 'editorId' | 'fields' | 'formIdAt' | 'formIdField' | 'text'
>;

/** The record types of carryable items. */
export const ITEM_TYPES = [
  'WEAP',
  'ARMO',
  'AMMO',
  'ALCH',
  'INGR',
  'BOOK',
  'SCRL',
  'MISC',
  'KEYM',
  'SLGM',
  'LIGH',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** A magic effect of a potion, ingredient, scroll or enchantment (EFID with its EFIT). */
export interface ItemEffect {
  readonly effect: number;
  readonly magnitude: number;
  readonly area: number;
  /** Seconds. */
  readonly duration: number;
  readonly conditions: readonly Condition[];
}

/** WEAP DNAM animation types. */
export const WeaponType = {
  handToHand: 0,
  oneHandSword: 1,
  oneHandDagger: 2,
  oneHandAxe: 3,
  oneHandMace: 4,
  twoHandSword: 5,
  twoHandAxe: 6,
  bow: 7,
  staff: 8,
  crossbow: 9,
} as const;

export interface WeaponData {
  readonly damage: number;
  /** DNAM: animation type (WeaponType). */
  readonly weaponType: number;
  readonly speed: number;
  readonly reach: number;
  /** The skill it uses (an actor value index; -1 none). */
  readonly skill: number;
  readonly critDamage: number;
  readonly stagger: number;
}

/** BOD2 armor types. */
export const ArmorType = { light: 0, heavy: 1, clothing: 2 } as const;

export interface ArmorData {
  /** DNAM / 100: the armor rating the menus show (before skill and perks). */
  readonly rating: number;
  /** BOD2: the biped slots it takes. */
  readonly slots: number;
  readonly armorType: number;
}

/** ALCH ENIT flags. */
export const PotionFlag = {
  noAutoCalc: 0x1,
  food: 0x2,
  medicine: 0x10000,
  poison: 0x20000,
} as const;

/** BOOK DATA flags. */
export const BookFlag = {
  teachesSkill: 0x01,
  cantBeTaken: 0x02,
  teachesSpell: 0x04,
} as const;

export interface BookData {
  readonly flags: number;
  /** 0 a book, 255 a note or scroll. */
  readonly bookType: number;
  /** The skill (actor value index) or spell (form id) it teaches. */
  readonly teaches: number;
  /** CNAM: the item card's description. */
  readonly description: string;
}

export interface ItemRecord {
  readonly formId: number;
  readonly type: ItemType;
  readonly editorId: string;
  readonly name: string;
  readonly value: number;
  readonly weight: number;
  readonly keywords: readonly number[];
  /** MODL: the world model (armor: the male world model, MOD2). */
  readonly model: string | undefined;
  /** MOD4: armor's female world model. */
  readonly femaleModel: string | undefined;
  /** Never shown in the menus (WEAP/AMMO flags; ARMO's record flag). */
  readonly nonPlayable: boolean;
  /** EITM: its enchantment, EAMT: its charge. */
  readonly enchantment: number | undefined;
  readonly charge: number;
  /** YNAM / ZNAM: the sounds of picking it up and putting it down (SNDR). */
  readonly pickUpSound: number | undefined;
  readonly putDownSound: number | undefined;
  readonly effects: readonly ItemEffect[];
  readonly weapon?: WeaponData;
  readonly armor?: ArmorData;
  /** ALCH ENIT flags (PotionFlag). */
  readonly potionFlags?: number;
  readonly book?: BookData;
  /** SLGM: the soul it holds and can hold (0 none .. 5 grand). */
  readonly soul?: { readonly current: number; readonly capacity: number };
  /** AMMO DATA: its damage. */
  readonly ammoDamage?: number;
}

const f32 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 4 ? view(data).getFloat32(at, true) : 0;
const u32 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 4 ? view(data).getUint32(at, true) : 0;
const i32 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 4 ? view(data).getInt32(at, true) : 0;
const u16 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 2 ? view(data).getUint16(at, true) : 0;

/** The record's effects: EFID (the magic effect) each followed by EFIT and its CTDA. */
export function parseEffects(record: Pick<GameRecord, 'fields' | 'formIdAt'>): ItemEffect[] {
  const effects: ItemEffect[] = [];
  let current: { effect: number; magnitude: number; area: number; duration: number } | undefined;
  let conditions: Condition[] = [];
  const close = (): void => {
    if (current) effects.push({ ...current, conditions });
    current = undefined;
    conditions = [];
  };
  const fields = record.fields.list;
  for (const [index, { type, data }] of fields.entries()) {
    if (type === 'EFID') {
      close();
      current = {
        effect: data.length >= 4 ? record.formIdAt(data) : 0,
        magnitude: 0,
        area: 0,
        duration: 0,
      };
    } else if (type === 'EFIT' && current) {
      current.magnitude = f32(data, 0);
      current.area = u32(data, 4);
      current.duration = u32(data, 8);
    } else if (type === 'CTDA' && current) {
      const condition = conditionAt(fields, index, record);
      if (condition) conditions.push(condition);
    }
  }
  close();
  return effects;
}

/** A carryable item's record read into one shape; undefined for other records. */
export function parseItem(record: RecordSource): ItemRecord | undefined {
  const type = record.type as ItemType;
  if (!(ITEM_TYPES as readonly string[]).includes(type)) return undefined;
  const data = record.fields.first('DATA');
  const keywords = record.fields
    .all('KWDA')
    .flatMap((kwda) =>
      Array.from({ length: Math.floor(kwda.length / 4) }, (_, i) => record.formIdAt(kwda, i * 4)),
    );
  const base = {
    formId: record.formId,
    type,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    keywords,
    model: record.fields.zstring(type === 'ARMO' ? 'MOD2' : 'MODL'),
    femaleModel: type === 'ARMO' ? record.fields.zstring('MOD4') : undefined,
    enchantment: record.formIdField('EITM'),
    charge: u16(record.fields.first('EAMT'), 0),
    pickUpSound: record.formIdField('YNAM'),
    putDownSound: record.formIdField('ZNAM'),
    effects: parseEffects(record),
  };
  switch (type) {
    case 'WEAP': {
      const dnam = record.fields.first('DNAM');
      const crdt = record.fields.first('CRDT');
      return {
        ...base,
        value: u32(data, 0),
        weight: f32(data, 4),
        nonPlayable: (u16(dnam, 12) & 0x80) !== 0,
        weapon: {
          damage: u16(data, 8),
          weaponType: dnam?.[0] ?? 0,
          speed: f32(dnam, 4),
          reach: f32(dnam, 8),
          skill: dnam && dnam.length >= 80 ? i32(dnam, 76) : -1,
          critDamage: u16(crdt, 0),
          stagger: f32(dnam, 96),
        },
      };
    }
    case 'ARMO': {
      const body = record.fields.first('BOD2') ?? record.fields.first('BODT');
      return {
        ...base,
        value: i32(data, 0),
        weight: f32(data, 4),
        nonPlayable: (record.flags & RecordFlag.nonPlayable) !== 0,
        armor: {
          rating: i32(record.fields.first('DNAM'), 0) / 100,
          slots: u32(body, 0),
          // BOD2: slots, armor type; BODT: slots, flags (u8 + 3 unused), armor type.
          armorType: record.fields.first('BOD2') ? u32(body, 4) : u32(body, 8),
        },
      };
    }
    case 'AMMO':
      return {
        ...base,
        value: u32(data, 12),
        weight: f32(data, 16),
        nonPlayable: (u32(data, 4) & 0x2) !== 0,
        ammoDamage: f32(data, 8),
      };
    case 'ALCH': {
      const enit = record.fields.first('ENIT');
      return {
        ...base,
        value: i32(enit, 0),
        weight: f32(data, 0),
        nonPlayable: false,
        potionFlags: u32(enit, 4),
      };
    }
    case 'INGR':
      return { ...base, value: i32(data, 0), weight: f32(data, 4), nonPlayable: false };
    case 'BOOK':
      return {
        ...base,
        value: u32(data, 8),
        weight: f32(data, 12),
        nonPlayable: false,
        book: {
          flags: data?.[0] ?? 0,
          bookType: data?.[1] ?? 0,
          teaches: i32(data, 4),
          description: record.text('CNAM') ?? '',
        },
      };
    case 'SCRL':
      return { ...base, value: u32(data, 0), weight: f32(data, 4), nonPlayable: false };
    case 'SLGM':
      return {
        ...base,
        value: i32(data, 0),
        weight: f32(data, 4),
        nonPlayable: false,
        soul: {
          current: record.fields.first('SOUL')?.[0] ?? 0,
          capacity: record.fields.first('SLCP')?.[0] ?? 0,
        },
      };
    case 'LIGH':
      // DATA: time, radius, color, flags, falloff, FOV, near clip, period, intensity and
      // movement amplitudes, value, weight. Only lights that can be carried are items.
      if ((u32(data, 12) & LIGHT_CARRIED) === 0) return undefined;
      return { ...base, value: u32(data, 40), weight: f32(data, 44), nonPlayable: false };
    default:
      // MISC, KEYM
      return { ...base, value: i32(data, 0), weight: f32(data, 4), nonPlayable: false };
  }
}

/** LIGH DATA flags: it can be carried (a torch). */
const LIGHT_CARRIED = 0x2;
