// Animation objects: ANIO (TESObjectANIO), the props an actor's behavior graph puts in its
// hands as an idle or a furniture animation plays (the smith's hammer, the woodcutter's axe,
// the drinker's tankard, the bard's lute). A record is an editor id, a model (MODL, with MODT
// and alternate textures, MODS) and the name of the graph event that takes it away again
// (BNAM, the unload event: "AnimObjectUnequip" on all but two vanilla records). The graphs
// name the records by editor id, in the payloads of their AnimObjLoad and AnimObjDraw events.
// Layouts: xEdit (wbDefinitionsTES5 ANIO), CommonLibSSE-NG (TESObjectANIO), UESP "Skyrim
// Mod:Mod File Format/ANIO". How the engine uses them: docs/animation.md ("Animation objects").

import { RecordFlag } from '../formats/esm/record.ts';
import { alternateTextures, type AlternateTexture } from './actor-records.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'>;

export interface AnimObjectRecord {
  readonly formId: number;
  /** EDID: the name the graphs' events give it. */
  readonly editorId: string;
  /** MODL: its model (a path under meshes\); undefined: none. */
  readonly model: string | undefined;
  /** MODS: texture sets on its model's shapes. */
  readonly alternateTextures: readonly AlternateTexture[];
  /**
   * BNAM: the graph event that unloads it (any event of that name its holder's graph raises);
   * undefined: none (AnimObjectLog), it stays until its holder's 3D goes.
   */
  readonly unloadEvent: string | undefined;
}

export function parseAnimObject(record: RecordSource): AnimObjectRecord {
  const text = (type: string): string | undefined => {
    const value = record.fields.zstring(type);
    return value === undefined || value === '' ? undefined : value;
  };
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    model: text('MODL'),
    alternateTextures: alternateTextures(record, record.fields.first('MODS')),
    unloadEvent: text('BNAM'),
  };
}

/**
 * The animation objects of a load order by lower-case editor id (the engine finds them by
 * editor id, as the graphs name them). Where two records share an editor id (Dawnguard's and
 * Hearthfire's AnimObjectWoodScrap and AnimObjectDrawBlade), the one later in the load order
 * is found. TODO(M13): which of the two the engine's editor id lookup keeps is unknown (the
 * vanilla pairs have the same models).
 */
export async function readAnimObjects(db: RecordDatabase): Promise<Map<string, AnimObjectRecord>> {
  const parsed = new Map<number, AnimObjectRecord>();
  await db.scan(
    ['ANIO'],
    (flags) => (flags & RecordFlag.deleted) === 0,
    (record) => {
      parsed.set(record.formId, parseAnimObject(record));
    },
  );
  const byEditorId = new Map<string, AnimObjectRecord>();
  for (const formId of db.formIdsOfType('ANIO')) {
    const record = parsed.get(formId);
    if (record && record.editorId !== '') byEditorId.set(record.editorId.toLowerCase(), record);
  }
  return byEditorId;
}
