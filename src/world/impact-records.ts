// Impacts: what happens where two materials meet. A material type (MATT HNAM) or a weapon names
// an impact data set (IPDS): for each material it can hit, an impact (IPCT) with its sounds
// (light and heavy), decal, effect model and hazard. Objects falling or knocked over play
// their material's impact on what they hit. Platform-independent. Notes: docs/formats/esm.md
// ("Impacts").

import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

/** IPDS: the impact for each material hit (MATT form id → IPCT form id). */
export interface ImpactDataSet {
  readonly formId: number;
  readonly editorId: string;
  readonly impacts: ReadonlyMap<number, number>;
}

/** IPCT DATA flags. */
export const ImpactFlag = {
  noDecalData: 0x1,
} as const;

/** IPCT: one kind of impact. */
export interface Impact {
  readonly formId: number;
  readonly editorId: string;
  /** DATA: how long its effect lasts, seconds. */
  readonly duration: number;
  /** 0 surface normal, 1 projectile vector, 2 projectile reflection. */
  readonly orientation: number;
  /** Degrees. */
  readonly angleThreshold: number;
  readonly placementRadius: number;
  /** How loud for detection: 0 loud, 1 normal, 2 silent, 3 very loud (a noise: actor-senses). */
  readonly soundLevel: number;
  readonly flags: number;
  /** SNAM: the sound of a light impact; NAM1: of a heavy one (SNDR). */
  readonly sound: number | undefined;
  readonly heavySound: number | undefined;
  /** NAM2: a hazard it leaves (HAZD). */
  readonly hazard: number | undefined;
  /** MODL: its effect model. */
  readonly model: string | undefined;
}

export function parseImpactDataSet(record: RecordSource): ImpactDataSet {
  const impacts = new Map<number, number>();
  for (const field of record.fields.list) {
    if (field.type !== 'PNAM' || field.data.byteLength < 8) continue;
    const material = record.formIdAt(field.data, 0);
    const impact = record.formIdAt(field.data, 4);
    if (material !== 0 && impact !== 0) impacts.set(material, impact);
  }
  return { formId: record.formId, editorId: record.editorId ?? '', impacts };
}

export function parseImpact(record: RecordSource): Impact {
  const data = record.fields.first('DATA');
  const view = data && new DataView(data.buffer, data.byteOffset, data.byteLength);
  const f32 = (offset: number): number =>
    view && data.byteLength >= offset + 4 ? view.getFloat32(offset, true) : 0;
  const u32 = (offset: number): number =>
    view && data.byteLength >= offset + 4 ? view.getUint32(offset, true) : 0;
  const form = (type: string): number | undefined => {
    const field = record.fields.first(type);
    const formId = field && field.byteLength >= 4 ? record.formIdAt(field, 0) : 0;
    return formId === 0 ? undefined : formId;
  };
  const modl = record.fields.first('MODL');
  let model: string | undefined;
  if (modl) {
    const end = modl.indexOf(0);
    model = String.fromCharCode(...modl.subarray(0, end < 0 ? modl.length : end)) || undefined;
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    duration: f32(0),
    orientation: u32(4),
    angleThreshold: f32(8),
    placementRadius: f32(12),
    soundLevel: u32(16),
    flags: u32(20),
    sound: form('SNAM'),
    heavySound: form('NAM1'),
    hazard: form('NAM2'),
    model,
  };
}
