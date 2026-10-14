// Magic effects (MGEF): what the menus show of a potion's, a scroll's, a spell's or an
// enchantment's effects. An effect's description (DNAM) names its magnitude and duration with
// <mag> and <dur> (and its area with <area>), filled in with the item's values (Creation Kit:
// "Magic Effect"). DATA's flags hide an effect from the interface or say it has no magnitude,
// duration or area. Layout after UESP's MGEF page. Platform-independent.

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'text'>;

/** MGEF DATA flags. */
export const EffectFlag = {
  hostile: 0x1,
  recover: 0x2,
  detrimental: 0x4,
  noDuration: 0x200,
  noMagnitude: 0x400,
  noArea: 0x800,
  hideInUi: 0x8000,
  powerAffectsMagnitude: 0x200000,
  powerAffectsDuration: 0x400000,
} as const;

export interface MagicEffectRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  /** DNAM: the description, with <mag>, <dur>, <area> where the values go. */
  readonly description: string;
  readonly flags: number;
  readonly baseCost: number;
  /** The magic skill it belongs to (an actor value index; -1 none). */
  readonly skill: number;
  /** DATA: the skill level it needs (its spells' level: novice 0 .. master 100). */
  readonly minimumSkill: number;
  /** DATA: its archetype (value modifier, script, ...) and the actor value it changes. */
  readonly archetype: number;
  readonly actorValue: number;
}

export function parseMagicEffect(record: RecordSource): MagicEffectRecord {
  const data = record.fields.first('DATA');
  const d = data && data.length >= 72 ? view(data) : undefined;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    description: record.text('DNAM') ?? '',
    flags: d?.getUint32(0, true) ?? 0,
    baseCost: d?.getFloat32(4, true) ?? 0,
    skill: d?.getInt32(12, true) ?? -1,
    minimumSkill: d?.getUint32(40, true) ?? 0,
    archetype: d?.getUint32(64, true) ?? 0,
    actorValue: d?.getInt32(68, true) ?? -1,
  };
}

/**
 * An effect's description with its values filled in: <mag> the magnitude, <dur> the duration
 * (seconds), <area> the area (feet), each a whole number.
 */
export function effectText(
  effect: Pick<MagicEffectRecord, 'description'>,
  magnitude: number,
  duration: number,
  area: number,
): string {
  const whole = (value: number): string => String(Math.round(value));
  return effect.description
    .replace(/<mag>/gi, whole(magnitude))
    .replace(/<dur>/gi, whole(duration))
    .replace(/<area>/gi, whole(area));
}
