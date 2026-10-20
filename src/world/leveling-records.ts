// The records that level actors: a class's weights (CLAS DATA: how an auto-calculated NPC's
// skill and attribute points are shared out each level), an encounter zone (ECZN DATA: the
// level range of what lives in it) and a placed actor's level modifier (ACHR XLCM). Layouts:
// UESP "Skyrim Mod:Mod File Format/CLAS", "/ECZN", "/ACHR" and xEdit. Platform-independent.
// Notes: docs/gameplay.md ("Skills, levels and actor values").

import { view } from '../formats/esm/fields.ts';
import { SKILL_COUNT } from './actor-values.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'fields' | 'formIdAt'>;

/**
 * CLAS DATA (36 bytes): u32 unknown, u8 training skill (an actor value less 6), u8 the level its
 * trainers teach up to, u8 × 18 skill weights (One-handed .. Enchanting), f32 bleedout default,
 * u32 voice points, u8 health, magicka and stamina weights, u8 flags (0x1 guard).
 */
export interface ClassStats {
  readonly formId: number;
  /** The weight of each of the 18 skills (in actor value order). */
  readonly skillWeights: readonly number[];
  readonly healthWeight: number;
  readonly magickaWeight: number;
  readonly staminaWeight: number;
  /** The share of health below which its members bleed out. */
  readonly bleedout: number;
  readonly voicePoints: number;
}

export function parseClassStats(record: RecordSource): ClassStats {
  const data = record.fields.first('DATA');
  const d = data && data.length >= 35 ? view(data) : undefined;
  return {
    formId: record.formId,
    skillWeights: Array.from({ length: SKILL_COUNT }, (_, i) => d?.getUint8(6 + i) ?? 0),
    bleedout: d?.getFloat32(24, true) ?? 0,
    voicePoints: d?.getUint32(28, true) ?? 0,
    healthWeight: d?.getUint8(32) ?? 0,
    magickaWeight: d?.getUint8(33) ?? 0,
    staminaWeight: d?.getUint8(34) ?? 0,
  };
}

/** ECZN DATA flags (xEdit). */
export const EncounterZoneFlag = {
  neverResets: 0x1,
  matchPcBelowMinimum: 0x2,
  disableCombatBoundary: 0x4,
} as const;

/**
 * ECZN DATA (12 bytes; two vanilla zones keep an 8-byte one without levels): owner (NPC_ or
 * FACT), location (LCTN), i8 rank, u8 minimum level, u8 flags, u8 maximum level (0: none).
 */
export interface EncounterZone {
  readonly formId: number;
  readonly owner: number | undefined;
  readonly location: number | undefined;
  readonly rank: number;
  readonly minLevel: number;
  /** 0: no maximum. */
  readonly maxLevel: number;
  readonly flags: number;
}

export function parseEncounterZone(record: RecordSource): EncounterZone {
  const data = record.fields.first('DATA');
  const form = (offset: number): number | undefined => {
    if (!data || data.length < offset + 4) return undefined;
    const formId = record.formIdAt(data, offset);
    return formId === 0 ? undefined : formId;
  };
  const long = data && data.length >= 12 ? view(data) : undefined;
  return {
    formId: record.formId,
    owner: form(0),
    location: form(4),
    rank: long?.getInt8(8) ?? 0,
    minLevel: long?.getUint8(9) ?? 0,
    flags: long?.getUint8(10) ?? 0,
    maxLevel: long?.getUint8(11) ?? 0,
  };
}

/**
 * ACHR XLCM: a leveled actor's level modifier (the Creation Kit's Level Mod: 0 easy, 1 medium,
 * 2 hard, 3 very hard); undefined when the reference has none.
 */
export function levelModifier(record: Pick<GameRecord, 'fields'>): number | undefined {
  const xlcm = record.fields.first('XLCM');
  return xlcm && xlcm.length >= 4 ? view(xlcm).getInt32(0, true) : undefined;
}

/** The Creation Kit's level modifiers (XLCM). */
export const LevelModifier = { easy: 0, medium: 1, hard: 2, veryHard: 3 } as const;
