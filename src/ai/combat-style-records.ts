// Combat styles (CSTY): how an actor fights. General multipliers (offensive, defensive, how it
// scores its equipment, how often it dodges threats), melee (attacking staggered or blocking
// targets, bashing, special attacks), close range (circling, falling back, flanking), long
// range (strafing), flight (hover, dive bombs, perches) and the dueling / flanking flags.
// Layout: xEdit's wbDefinitionsTES5 (CSTY), CommonLibSSE TESCombatStyle.h; the defaults of
// omitted values are the Creation Kit's after UESP's CSTY page. Platform-independent.
// Notes: docs/formats/esm.md ("Combat styles").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from '../world/record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'flags' | 'fields'>;

/** CSTY DATA flags (CommonLibSSE TESCombatStyle::FLAG). */
export const CombatStyleFlag = {
  dueling: 0x1,
  flanking: 0x2,
  allowDualWielding: 0x4,
} as const;

/** CSTY record header flags. */
export const CombatStyleRecordFlag = {
  /** Bit 19 (xEdit, CommonLibSSE kAllowDualWielding). */
  allowDualWielding: 0x80000,
} as const;

/** CSGD: general. */
export interface CombatStyleGeneral {
  readonly offensiveMult: number;
  readonly defensiveMult: number;
  readonly groupOffensiveMult: number;
  /** How the actor scores its equipment of each kind when it picks what to fight with. */
  readonly equipmentScoreMult: {
    readonly melee: number;
    readonly magic: number;
    readonly ranged: number;
    readonly shout: number;
    readonly unarmed: number;
    readonly staff: number;
  };
  readonly avoidThreatChance: number;
}

/** CSME: melee. */
export interface CombatStyleMelee {
  readonly attackStaggeredMult: number;
  readonly powerAttackStaggeredMult: number;
  readonly powerAttackBlockingMult: number;
  readonly bashMult: number;
  readonly bashRecoilMult: number;
  readonly bashAttackMult: number;
  readonly bashPowerAttackMult: number;
  readonly specialAttackMult: number;
}

/** CSCR: close range (dueling: circle and fall back; flanking: flank and stalk). */
export interface CombatStyleCloseRange {
  readonly circleMult: number;
  readonly fallbackMult: number;
  readonly flankDistance: number;
  readonly stalkTime: number;
}

/** CSLR: long range. */
export interface CombatStyleLongRange {
  readonly strafeMult: number;
}

/** CSFL: flight. */
export interface CombatStyleFlight {
  readonly hoverChance: number;
  readonly diveBombChance: number;
  readonly groundAttackChance: number;
  readonly hoverTime: number;
  readonly groundAttackTime: number;
  readonly perchAttackChance: number;
  readonly perchAttackTime: number;
  readonly flyingAttackChance: number;
}

export interface CombatStyle {
  readonly formId: number;
  readonly editorId: string;
  readonly general: CombatStyleGeneral;
  readonly melee: CombatStyleMelee;
  readonly closeRange: CombatStyleCloseRange;
  readonly longRange: CombatStyleLongRange;
  readonly flight: CombatStyleFlight;
  /** DATA flags (CombatStyleFlag); 0 without DATA (TODO(M13): the engine's then). */
  readonly flags: number;
  /** The record header's flags (CombatStyleRecordFlag). */
  readonly recordFlags: number;
}

/**
 * The Creation Kit's values for what a field leaves out (UESP CSTY). The offensive and
 * defensive mults have none documented; every vanilla CSGD stores them.
 * TODO(M13): the engine's own defaults of those two.
 */
const GENERAL_DEFAULTS = [0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.2] as const;
const MELEE_DEFAULTS = [1, 1, 1, 1, 1, 1, 1, 0.1] as const;
const CLOSE_RANGE_DEFAULTS = [0.2, 0.2, 0.2, 0.2] as const;
const LONG_RANGE_DEFAULTS = [0.2] as const;
const FLIGHT_DEFAULTS = [0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.75] as const;

/**
 * A field of floats that may stop early (or be missing): the stored values, then the
 * defaults for the rest.
 */
function floats(record: RecordSource, type: string, defaults: readonly number[]): number[] {
  const data = record.fields.first(type);
  const stored = data ? Math.min(defaults.length, Math.floor(data.length / 4)) : 0;
  const v = data && view(data);
  return defaults.map((fallback, i) => (v && i < stored ? v.getFloat32(i * 4, true) : fallback));
}

/** How many floats a field stores of the ones it can hold (the CLI's check of short fields). */
export function storedFloats(record: Pick<GameRecord, 'fields'>, type: string): number {
  return Math.floor((record.fields.first(type)?.length ?? 0) / 4);
}

export function parseCombatStyle(record: RecordSource): CombatStyle {
  const g = floats(record, 'CSGD', GENERAL_DEFAULTS);
  const m = floats(record, 'CSME', MELEE_DEFAULTS);
  const c = floats(record, 'CSCR', CLOSE_RANGE_DEFAULTS);
  const l = floats(record, 'CSLR', LONG_RANGE_DEFAULTS);
  const f = floats(record, 'CSFL', FLIGHT_DEFAULTS);
  const at = (values: readonly number[], i: number): number => values[i] ?? 0;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    general: {
      offensiveMult: at(g, 0),
      defensiveMult: at(g, 1),
      groupOffensiveMult: at(g, 2),
      equipmentScoreMult: {
        melee: at(g, 3),
        magic: at(g, 4),
        ranged: at(g, 5),
        shout: at(g, 6),
        unarmed: at(g, 7),
        staff: at(g, 8),
      },
      avoidThreatChance: at(g, 9),
    },
    melee: {
      attackStaggeredMult: at(m, 0),
      powerAttackStaggeredMult: at(m, 1),
      powerAttackBlockingMult: at(m, 2),
      bashMult: at(m, 3),
      bashRecoilMult: at(m, 4),
      bashAttackMult: at(m, 5),
      bashPowerAttackMult: at(m, 6),
      specialAttackMult: at(m, 7),
    },
    closeRange: {
      circleMult: at(c, 0),
      fallbackMult: at(c, 1),
      flankDistance: at(c, 2),
      stalkTime: at(c, 3),
    },
    longRange: { strafeMult: at(l, 0) },
    flight: {
      hoverChance: at(f, 0),
      diveBombChance: at(f, 1),
      groundAttackChance: at(f, 2),
      hoverTime: at(f, 3),
      groundAttackTime: at(f, 4),
      perchAttackChance: at(f, 5),
      perchAttackTime: at(f, 6),
      flyingAttackChance: at(f, 7),
    },
    flags: record.fields.u32('DATA') ?? 0,
    recordFlags: record.flags,
  };
}
