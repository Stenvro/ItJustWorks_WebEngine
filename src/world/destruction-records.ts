// Destructible objects: the destruction data a base object carries (DEST and its stages:
// activators, containers, doors, furniture, lights, statics, trees, moveable statics, weapons,
// armor, actors, ...) and the debris (DEBR) its stages throw. Layout after xEdit's
// wbDefinitionsTES5 (wbDEST, DEBR). Platform-independent. Notes: docs/formats/esm.md
// ("Destructible objects"), the running game: docs/gameplay.md ("Destruction").

import { view, zstring } from '../formats/esm/fields.ts';
import { alternateTextures, type AlternateTexture } from './actor-records.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'>;

/** The record types whose definition carries DEST (xEdit wbDEST). */
export const DESTRUCTIBLE_TYPES = [
  'ACTI',
  'ALCH',
  'AMMO',
  'ARMO',
  'BOOK',
  'CONT',
  'DOOR',
  'FLOR',
  'FURN',
  'INGR',
  'KEYM',
  'LIGH',
  'MISC',
  'MSTT',
  'NPC_',
  'PROJ',
  'SCRL',
  'SLGM',
  'STAT',
  'TACT',
  'TREE',
  'WEAP',
] as const;

/** DEST header flags (byte 5: xEdit "VATS Targetable", and the large actors' flag). */
export const DestructibleFlag = {
  vatsTargetable: 0x01,
  largeActorDestroys: 0x02,
} as const;

/** DSTD flags (xEdit). */
export const DestructionStageFlag = {
  /** One blow cannot take it past this stage (its health stops at the next stage's). */
  capDamage: 0x01,
  /** The reference is disabled as it reaches the stage. */
  disable: 0x02,
  /** The reference is destroyed (IsDestroyed) as it reaches the stage. */
  destroy: 0x04,
  /** Only its own damage (self damage per second, scripts) takes it further. */
  ignoreExternalDamage: 0x08,
} as const;

export interface DestructionStage {
  /** Its health (percent of the object's) at or below which the stage is reached. */
  readonly healthPercent: number;
  /** Its index (the stage number scripts read: GetCurrentDestructionStage). */
  readonly index: number;
  /** The model's damage stage (the NIF's BSDamageStage switch), when it has no own model. */
  readonly modelDamageStage: number;
  readonly flags: number;
  /** Health it loses per second while in the stage. */
  readonly selfDamagePerSecond: number;
  /** EXPL going off as the stage is reached. */
  readonly explosion: number | undefined;
  /** DEBR thrown as the stage is reached, `debrisCount` times. */
  readonly debris: number | undefined;
  readonly debrisCount: number;
  /** DMDL: the model replacing the object's from this stage on. */
  readonly model: string | undefined;
  /** DMDS: texture sets swapped onto the stage model's shapes. */
  readonly alternateTextures: readonly AlternateTexture[];
}

export interface DestructionData {
  /** Its health (DEST): what damage takes from (0: only scripts and self damage move it). */
  readonly health: number;
  readonly flags: number;
  /** In the record's order (their health percents fall). */
  readonly stages: readonly DestructionStage[];
}

/**
 * The DEST block of a record: DEST (i32 health, u8 stage count, u8 flags, 2 unknown), then
 * per stage DSTD (u8 health %, u8 index, u8 model damage stage, u8 flags, i32 self damage per
 * second, EXPL, DEBR, i32 debris count), an optional model (DMDL, DMDT, DMDS) and DSTF.
 */
export function parseDestruction(record: RecordSource): DestructionData | undefined {
  const list = record.fields.list;
  const start = list.findIndex((field) => field.type === 'DEST');
  const dest = start < 0 ? undefined : list[start]?.data;
  if (!dest || dest.length < 4) return undefined;
  const header = view(dest);
  const stages: DestructionStage[] = [];
  let stage: MutableStage | undefined;
  const finish = (): void => {
    if (stage) stages.push(stage);
    stage = undefined;
  };
  for (let i = start + 1; i < list.length; i++) {
    const field = list[i];
    if (!field) break;
    const { type, data } = field;
    if (type === 'DSTD') {
      finish();
      if (data.length < 20) continue;
      const d = view(data);
      stage = {
        healthPercent: data[0] ?? 0,
        index: data[1] ?? 0,
        modelDamageStage: data[2] ?? 0,
        flags: data[3] ?? 0,
        selfDamagePerSecond: d.getInt32(4, true),
        explosion: formOf(record, data, 8),
        debris: formOf(record, data, 12),
        debrisCount: d.getInt32(16, true),
        model: undefined,
        alternateTextures: [],
      };
    } else if (type === 'DMDL') {
      if (stage) {
        const path = zstring(data);
        stage.model = path === '' ? undefined : path;
      }
    } else if (type === 'DMDS') {
      if (stage) stage.alternateTextures = alternateTextures(record, data);
    } else if (type === 'DMDT') {
      // The model's texture hashes (unused by the engine's loading).
    } else if (type === 'DSTF') {
      finish();
    } else {
      break;
    }
  }
  finish();
  return {
    health: header.getInt32(0, true),
    flags: dest.length > 5 ? (dest[5] ?? 0) : 0,
    stages,
  };
}

interface MutableStage {
  healthPercent: number;
  index: number;
  modelDamageStage: number;
  flags: number;
  selfDamagePerSecond: number;
  explosion: number | undefined;
  debris: number | undefined;
  debrisCount: number;
  model: string | undefined;
  alternateTextures: readonly AlternateTexture[];
}

/** One of a debris' models (DATA: u8 percentage, the model's path, u8 flags). */
export interface DebrisModel {
  /** Percent of the debris count thrown as this model. */
  readonly percentage: number;
  readonly model: string;
  /** Its NIF carries collision (a bhk body): it falls and bounces as a physics body. */
  readonly hasCollision: boolean;
}

export interface DebrisRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly models: readonly DebrisModel[];
}

export function parseDebris(record: RecordSource): DebrisRecord {
  const models: DebrisModel[] = [];
  for (const data of record.fields.all('DATA')) {
    if (data.length < 2) continue;
    const end = data.indexOf(0, 1);
    const stop = end < 0 ? data.length : end;
    const model = zstring(data.subarray(1, stop));
    if (model === '') continue;
    models.push({
      percentage: data[0] ?? 0,
      model,
      hasCollision: ((data[stop + 1] ?? 0) & 0x01) !== 0,
    });
  }
  return { formId: record.formId, editorId: record.editorId ?? '', models };
}

function formOf(record: RecordSource, data: Uint8Array, offset: number): number | undefined {
  if (data.length < offset + 4) return undefined;
  const formId = record.formIdAt(data, offset);
  return formId === 0 ? undefined : formId;
}
