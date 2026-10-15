// A perk (PERK, UESP "Skyrim Mod:Mod File Format/PERK") as the skills menu shows it: its name,
// description, the conditions that make it available (the CTDA before its first effect, PRKE),
// DATA (u8 trait, u8 level, u8 rank count, u8 playable, u8 hidden) and the next rank (NNAM: the
// perk a multi-rank perk such as Armsman goes on to). Platform-independent.
// Notes: docs/formats/esm.md ("Perk trees").

import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

export interface PerkRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly description: string;
  /** Requirements: the player must meet them to take it. */
  readonly conditions: readonly Condition[];
  readonly level: number;
  readonly ranks: number;
  readonly playable: boolean;
  readonly hidden: boolean;
  /** NNAM: the next rank, if it has one. */
  readonly next: number | undefined;
}

type Source = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'text' | 'formIdAt'>;

export function parsePerk(record: Source): PerkRecord {
  const fields = record.fields.list;
  const conditions: Condition[] = [];
  let data: Uint8Array | undefined;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Its effects (PRKE ...) bring conditions of their own.
    if (!field || field.type === 'PRKE') break;
    if (field.type === 'DATA') data ??= field.data;
    const condition = conditionAt(fields, i, record);
    if (condition) conditions.push(condition);
  }
  const nnam = record.fields.first('NNAM');
  const next = nnam && nnam.length >= 4 ? record.formIdAt(nnam) : 0;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    description: record.text('DESC') ?? '',
    conditions,
    level: data?.[1] ?? 0,
    ranks: Math.max(1, data?.[2] ?? 1),
    playable: (data?.[3] ?? 1) !== 0,
    hidden: (data?.[4] ?? 0) !== 0,
    next: next === 0 ? undefined : next,
  };
}
