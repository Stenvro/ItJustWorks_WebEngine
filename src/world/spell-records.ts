// Spells (SPEL: spells, powers, abilities, diseases), shouts (SHOU) and their words (WOOP), as
// the magic menu lists them. Layouts after UESP's SPEL, SHOU and WOOP pages: SPIT (base cost,
// flags, type, charge time, cast type, delivery, cast duration, range, half-cost perk), the
// effects as items have them (item-records.ts), a shout's three words with their spells and
// recovery times. Platform-independent. Notes: docs/formats/esm.md ("Spells and shouts").

import { view } from '../formats/esm/fields.ts';
import { parseEffects, type ItemEffect } from './item-records.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<
  GameRecord,
  'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt' | 'formIdField' | 'text'
>;

/** SPIT types. */
export const SpellType = {
  spell: 0,
  disease: 1,
  power: 2,
  lesserPower: 3,
  ability: 4,
  poison: 5,
  addiction: 10,
  voice: 11,
} as const;

/** SPIT cast types. */
export const CastType = {
  constantEffect: 0,
  fireAndForget: 1,
  concentration: 2,
  scroll: 3,
} as const;

/** SPIT flags (UESP): 0x1 the cost is not calculated (SPIT's own). */
export const SpellFlag = { manualCost: 0x1, pcStartSpell: 0x20000 } as const;

export interface SpellRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly baseCost: number;
  readonly flags: number;
  readonly spellType: number;
  readonly chargeTime: number;
  readonly castType: number;
  readonly delivery: number;
  readonly castDuration: number;
  readonly range: number;
  readonly effects: readonly ItemEffect[];
  /** ETYP: the hand or voice it is equipped to. */
  readonly equipType: number | undefined;
}

export function parseSpell(record: RecordSource): SpellRecord {
  const spit = record.fields.first('SPIT');
  const d = spit && spit.length >= 32 ? view(spit) : undefined;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    baseCost: d?.getUint32(0, true) ?? 0,
    flags: d?.getUint32(4, true) ?? 0,
    spellType: d?.getUint32(8, true) ?? 0,
    chargeTime: d?.getFloat32(12, true) ?? 0,
    castType: d?.getUint32(16, true) ?? 0,
    delivery: d?.getUint32(20, true) ?? 0,
    castDuration: d?.getFloat32(24, true) ?? 0,
    range: d?.getFloat32(28, true) ?? 0,
    effects: parseEffects(record),
    equipType: record.formIdField('ETYP'),
  };
}

export interface ShoutWord {
  /** WOOP: the word. */
  readonly word: number;
  /** The spell it casts at this level. */
  readonly spell: number;
  /** Seconds before the voice recovers. */
  readonly recovery: number;
}

export interface ShoutRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly description: string;
  readonly words: readonly ShoutWord[];
}

export function parseShout(record: RecordSource): ShoutRecord {
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    description: record.text('DESC') ?? '',
    words: record.fields
      .all('SNAM')
      .filter((data) => data.length >= 12)
      .map((data) => ({
        word: record.formIdAt(data, 0),
        spell: record.formIdAt(data, 4),
        recovery: view(data).getFloat32(8, true),
      })),
  };
}

export interface WordRecord {
  readonly formId: number;
  /** FULL: the word in the dragon tongue ("Fus"). */
  readonly word: string;
  /** TNAM: its translation ("Force"). */
  readonly translation: string;
}

export function parseWord(record: RecordSource): WordRecord {
  return {
    formId: record.formId,
    word: record.text('FULL') ?? '',
    translation: record.text('TNAM') ?? '',
  };
}

/**
 * A spell's base cost (before the caster's skill and perks): SPIT's own when it is not
 * calculated, else the sum of its effects' costs, each base cost × (magnitude × duration /
 * 10)^1.1, a magnitude under 1 counted as 1, a duration of 0 (and any, for concentration
 * spells) as 10 (UESP, "Mod File Format/SPEL").
 */
export function spellBaseCost(
  spell: Pick<SpellRecord, 'baseCost' | 'flags' | 'castType' | 'effects'>,
  effectBaseCost: (effect: number) => number,
): number {
  if ((spell.flags & SpellFlag.manualCost) !== 0) return spell.baseCost;
  let cost = 0;
  for (const effect of spell.effects) {
    const magnitude = Math.max(1, effect.magnitude);
    const duration =
      spell.castType === CastType.concentration || effect.duration === 0 ? 10 : effect.duration;
    cost += effectBaseCost(effect.effect) * ((magnitude * duration) / 10) ** 1.1;
  }
  return cost;
}
