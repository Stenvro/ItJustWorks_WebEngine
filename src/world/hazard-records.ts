// Hazards (HAZD): what a spell, an explosion or an impact leaves burning, freezing or healing
// on the ground (Wall of Flames' fire, a Guardian Circle, Clairvoyance's trail, a trap's fire).
// Layout after xEdit's wbDefinitionsTES5 (HAZD: MODL its model, MNAM its image-space modifier,
// DATA 40 bytes: u32 limit, f32 radius, f32 lifetime, f32 image-space radius, f32 target
// interval, u32 flags, the spell it puts on those within its radius, its light, its impact data
// set, its sound). Platform-independent. Notes: docs/gameplay.md ("Magic effects").

import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt' | 'formIdField'>;

/** HAZD DATA flags (xEdit). */
export const HazardFlag = {
  affectsPlayerOnly: 0x01,
  inheritDurationFromSpawnSpell: 0x02,
  alignToImpactNormal: 0x04,
  inheritRadiusFromSpawnSpell: 0x08,
  dropToGround: 0x10,
} as const;

export interface HazardRecord {
  readonly formId: number;
  readonly editorId: string;
  /** How many of it one source may have placed at once (0: no limit). */
  readonly limit: number;
  /** Feet (as magic effects' areas: TODO(M13): the unit is not documented). */
  readonly radius: number;
  /** Seconds it lasts (0: as long as what placed it). */
  readonly lifetime: number;
  /** Feet from it within which its image-space modifier shows on the player. */
  readonly imageSpaceRadius: number;
  /** Seconds between its spell's hits on those within its radius. */
  readonly targetInterval: number;
  readonly flags: number;
  readonly spell: number | undefined;
  readonly light: number | undefined;
  readonly impactDataSet: number | undefined;
  readonly sound: number | undefined;
  readonly imageSpaceModifier: number | undefined;
  readonly model: string | undefined;
}

export function parseHazard(record: RecordSource): HazardRecord {
  const data = record.fields.first('DATA');
  const view = data ? new DataView(data.buffer, data.byteOffset, data.byteLength) : undefined;
  const f32 = (at: number): number =>
    view && data && data.length >= at + 4 ? view.getFloat32(at, true) : 0;
  const u32 = (at: number): number =>
    view && data && data.length >= at + 4 ? view.getUint32(at, true) : 0;
  const form = (at: number): number | undefined => {
    if (!data || data.length < at + 4) return undefined;
    const formId = record.formIdAt(data, at);
    return formId === 0 ? undefined : formId;
  };
  const imad = record.formIdField('MNAM');
  const model = record.fields.zstring('MODL');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    limit: u32(0),
    radius: f32(4),
    lifetime: f32(8),
    imageSpaceRadius: f32(12),
    targetInterval: f32(16),
    flags: u32(20),
    spell: form(24),
    light: form(28),
    impactDataSet: form(32),
    sound: form(36),
    imageSpaceModifier: imad === 0 ? undefined : imad,
    model: model === '' ? undefined : model,
  };
}
