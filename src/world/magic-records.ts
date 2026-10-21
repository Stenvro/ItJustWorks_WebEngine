// Magic items (CommonLibSSE MagicItem): spells, powers, abilities, diseases and shouts' spells
// (SPEL), scrolls (SCRL), enchantments (ENCH), potions, food and poisons (ALCH) and ingredients
// (INGR), read into one shape: what kind of magic it is, how it is cast (constant effect, fire
// and forget, concentration) and delivered (self, touch, aimed, target actor, target location),
// its flags and its effects (EFID, EFIT, CTDA each). Layouts after xEdit's wbDefinitionsTES5:
// SPEL / SCRL SPIT; ENCH ENIT (cost, flags, cast type, charge amount, delivery, enchant type,
// charge time, base enchantment, worn restrictions); ALCH ENIT (value, flags, addiction and its
// chance, the sound of using it); INGR ENIT (value, flags). Soul gems (SLGM) and art objects
// (ARTO) the effects use are read here too. Platform-independent.
// Notes: docs/formats/esm.md ("Spells and shouts"), docs/gameplay.md ("Magic effects").

import { view } from '../formats/esm/fields.ts';
import { parseEffects, PotionFlag, type ItemEffect } from './item-records.ts';
import type { GameRecord } from './record-db.ts';
import { CastType, SpellType } from './spell-records.ts';

type RecordSource = Pick<
  GameRecord,
  'formId' | 'type' | 'flags' | 'editorId' | 'fields' | 'formIdAt' | 'formIdField' | 'text'
>;

/** What a magic item is: its record and, for spells, its SPIT type; for potions, ENIT's flags. */
export type MagicItemKind =
  | 'spell'
  | 'disease'
  | 'power'
  | 'lesserPower'
  | 'ability'
  /** SPEL type 5 (a spell that is a poison). */
  | 'spellPoison'
  | 'addiction'
  | 'voice'
  | 'scroll'
  | 'enchantment'
  | 'staffEnchantment'
  | 'potion'
  | 'food'
  | 'poison'
  | 'ingredient';

export const MAGIC_ITEM_TYPES = ['SPEL', 'SCRL', 'ENCH', 'ALCH', 'INGR'] as const;
export type MagicItemType = (typeof MAGIC_ITEM_TYPES)[number];

/** SPIT flags of spells (xEdit; scrolls share 0x1 and 0x80000). */
export const MagicSpellFlag = {
  manualCost: 0x1,
  pcStartSpell: 0x20000,
  areaIgnoresLineOfSight: 0x80000,
  ignoreResistance: 0x100000,
  disallowAbsorbReflect: 0x200000,
  noDualCastModification: 0x800000,
} as const;

/** ENCH ENIT flags and enchant types. */
export const EnchantmentFlag = { noAutoCalc: 0x1, extendDurationOnRecast: 0x4 } as const;
export const EnchantType = { enchantment: 0x06, staffEnchantment: 0x0c } as const;

/** SPIT and ENIT deliveries. */
export const Delivery = {
  self: 0,
  touch: 1,
  aimed: 2,
  targetActor: 3,
  targetLocation: 4,
} as const;

export interface MagicItemRecord {
  readonly formId: number;
  readonly type: MagicItemType;
  readonly editorId: string;
  readonly name: string;
  readonly kind: MagicItemKind;
  /** CastType: constant effect, fire and forget, concentration, scroll. */
  readonly castType: number;
  readonly delivery: number;
  /** SPIT flags (spells, scrolls); ENIT's (enchantments, potions, ingredients). */
  readonly flags: number;
  readonly effects: readonly ItemEffect[];
  readonly keywords: readonly number[];
  /** SPIT's base cost (spells, scrolls) or ENIT's enchantment cost. */
  readonly cost: number;
  readonly chargeTime: number;
  /** SPEL / SCRL SPIT: the half-cost perk (a perk of its school and level), if any. */
  readonly castingPerk?: number;
  /** ENCH: the charge it holds, its base enchantment and the forms it may be on. */
  readonly enchantment?: {
    readonly amount: number;
    readonly baseEnchantment: number | undefined;
    readonly wornRestrictions: number | undefined;
  };
  /** ALCH: its value, the addiction it may give and its chance, the sound of using it. */
  readonly potion?: {
    readonly value: number;
    readonly addiction: number | undefined;
    readonly addictionChance: number;
    readonly useSound: number | undefined;
  };
}

const KINDS_BY_SPELL_TYPE: ReadonlyMap<number, MagicItemKind> = new Map([
  [SpellType.spell, 'spell'],
  [SpellType.disease, 'disease'],
  [SpellType.power, 'power'],
  [SpellType.lesserPower, 'lesserPower'],
  [SpellType.ability, 'ability'],
  [SpellType.poison, 'spellPoison'],
  [SpellType.addiction, 'addiction'],
  [SpellType.voice, 'voice'],
]);

const nonZero = (formId: number | undefined): number | undefined =>
  formId === 0 ? undefined : formId;

/** A magic item's record read into one shape; undefined for other records. */
export function parseMagicItem(record: RecordSource): MagicItemRecord | undefined {
  const type = record.type as MagicItemType;
  if (!(MAGIC_ITEM_TYPES as readonly string[]).includes(type)) return undefined;
  const keywords: number[] = [];
  for (const kwda of record.fields.all('KWDA')) {
    for (let at = 0; at + 4 <= kwda.length; at += 4) keywords.push(record.formIdAt(kwda, at));
  }
  const base = {
    formId: record.formId,
    type,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    effects: parseEffects(record),
    keywords,
  };
  const u32 = (data: Uint8Array | undefined, at: number): number =>
    data && data.length >= at + 4 ? view(data).getUint32(at, true) : 0;
  const i32 = (data: Uint8Array | undefined, at: number): number =>
    data && data.length >= at + 4 ? view(data).getInt32(at, true) : 0;
  const f32 = (data: Uint8Array | undefined, at: number): number =>
    data && data.length >= at + 4 ? view(data).getFloat32(at, true) : 0;
  const form = (data: Uint8Array | undefined, at: number): number | undefined =>
    data && data.length >= at + 4 ? nonZero(record.formIdAt(data, at)) : undefined;
  switch (type) {
    case 'SPEL':
    case 'SCRL': {
      const spit = record.fields.first('SPIT');
      return {
        ...base,
        kind: type === 'SCRL' ? 'scroll' : (KINDS_BY_SPELL_TYPE.get(u32(spit, 8)) ?? 'spell'),
        cost: u32(spit, 0),
        flags: u32(spit, 4),
        chargeTime: f32(spit, 12),
        // A scroll's cast type is always Scroll (xEdit wbScrollCastAfterLoad): fire and forget.
        castType: type === 'SCRL' ? CastType.fireAndForget : u32(spit, 16),
        delivery: u32(spit, 20),
        // The half-cost perk (SpellHasCastingPerk; the school perks' Mod Spell Cost).
        ...(form(spit, 32) !== undefined && { castingPerk: form(spit, 32) }),
      };
    }
    case 'ENCH': {
      const enit = record.fields.first('ENIT');
      return {
        ...base,
        kind: u32(enit, 20) === EnchantType.staffEnchantment ? 'staffEnchantment' : 'enchantment',
        cost: i32(enit, 0),
        flags: u32(enit, 4),
        castType: u32(enit, 8),
        delivery: u32(enit, 16),
        chargeTime: f32(enit, 24),
        enchantment: {
          amount: i32(enit, 12),
          baseEnchantment: form(enit, 28),
          wornRestrictions: form(enit, 32),
        },
      };
    }
    case 'ALCH': {
      const enit = record.fields.first('ENIT');
      const flags = u32(enit, 4);
      return {
        ...base,
        kind:
          (flags & PotionFlag.poison) !== 0
            ? 'poison'
            : (flags & PotionFlag.food) !== 0
              ? 'food'
              : 'potion',
        cost: 0,
        flags,
        // Drunk or eaten: at once, on the one who uses it (a poison: on a weapon's target).
        castType: CastType.fireAndForget,
        delivery: (flags & PotionFlag.poison) !== 0 ? Delivery.touch : Delivery.self,
        chargeTime: 0,
        potion: {
          value: i32(enit, 0),
          addiction: form(enit, 8),
          addictionChance: f32(enit, 12),
          useSound: form(enit, 16),
        },
      };
    }
    case 'INGR': {
      const enit = record.fields.first('ENIT');
      return {
        ...base,
        kind: 'ingredient',
        cost: 0,
        flags: u32(enit, 4),
        castType: CastType.fireAndForget,
        delivery: Delivery.self,
        chargeTime: 0,
      };
    }
  }
}

/** Whether a magic item's effects last as long as one has it (abilities, diseases, worn enchantments). */
export function isConstantEffect(item: Pick<MagicItemRecord, 'castType'>): boolean {
  return item.castType === CastType.constantEffect;
}

/** SLGM: the soul it holds and can hold (0 none .. 5 grand), its filled version (NAM0). */
export interface SoulGemRecord {
  readonly formId: number;
  readonly soul: number;
  readonly capacity: number;
  /** Record flag 0x20000: it can hold an NPC's (black) soul. */
  readonly holdsNpcSouls: boolean;
  readonly filled: number | undefined;
}

/** SLGM record flag (xEdit): Can Hold NPC Soul. */
const CAN_HOLD_NPC_SOUL = 0x20000;

export function parseSoulGem(
  record: Pick<GameRecord, 'formId' | 'type' | 'flags' | 'fields' | 'formIdAt'>,
): SoulGemRecord | undefined {
  if (record.type !== 'SLGM') return undefined;
  const nam0 = record.fields.first('NAM0');
  return {
    formId: record.formId,
    soul: record.fields.first('SOUL')?.[0] ?? 0,
    capacity: record.fields.first('SLCP')?.[0] ?? 0,
    holdsNpcSouls: (record.flags & CAN_HOLD_NPC_SOUL) !== 0,
    filled: nam0 && nam0.length >= 4 ? nonZero(record.formIdAt(nam0)) : undefined,
  };
}

/** ARTO DNAM art types. */
export const ArtType = { magicCasting: 0, magicHitEffect: 1, enchantmentEffect: 2 } as const;

/** ARTO: an art object (a model shown on an actor: a spell's hit effect, an enchantment's glow). */
export interface ArtObjectRecord {
  readonly formId: number;
  readonly model: string | undefined;
  readonly artType: number;
}

export function parseArtObject(
  record: Pick<GameRecord, 'formId' | 'type' | 'fields'>,
): ArtObjectRecord | undefined {
  if (record.type !== 'ARTO') return undefined;
  return {
    formId: record.formId,
    model: record.fields.zstring('MODL'),
    artType: record.fields.u32('DNAM') ?? 0,
  };
}
