// A perk (PERK, UESP "Skyrim Mod:Mod File Format/PERK", xEdit wbDefinitionsTES5): its name,
// description, the conditions that make it available (the CTDA before its first entry, PRKE),
// DATA (u8 trait, u8 level, u8 rank count, u8 playable, u8 hidden), the next rank (NNAM: the
// perk a multi-rank perk such as Armsman goes on to), and its entries, each a group from PRKE
// (u8 type, u8 rank, u8 priority) to PRKF:
//   0 Quest + Stage: DATA quest (form id), stage (u16), 2 unused: the stage is set as the perk
//     is added;
//   1 Ability: DATA a spell, an ability the actor has while it holds the perk;
//   2 Entry Point: DATA u8 entry point, u8 function, u8 condition tab count; then per tab used
//     PRKC (s8 tab index) and its CTDA; EPFT (u8 data type), EPF2 (button label, lstring),
//     EPF3 (u16 script flags, u16 fragment index), EPFD (the data: float; two floats, or an
//     actor value stored as a float and a factor for the actor value functions; a leveled
//     list or spell form id; a string or lstring).
// Platform-independent. Notes: docs/formats/esm.md ("Perk trees"), docs/gameplay.md ("Perks").

import { view } from '../formats/esm/fields.ts';
import type { Field } from '../formats/esm/record.ts';
import { decodeGameText } from '../formats/text.ts';
import { EntryFunction, type EntryFunctionData } from '../gameplay/perk-entry-points.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

/** PRKE entry types. */
export const PerkEntryType = { quest: 0, ability: 1, entryPoint: 2 } as const;

interface PerkEntryBase {
  /** PRKE rank (0: the first): the rank of the perk it belongs to. */
  readonly rank: number;
  readonly priority: number;
}

export interface QuestStageEntry extends PerkEntryBase {
  readonly kind: 'quest';
  readonly quest: number;
  readonly stage: number;
}

export interface AbilityEntry extends PerkEntryBase {
  readonly kind: 'ability';
  readonly spell: number;
}

export interface EntryPointEntry extends PerkEntryBase {
  readonly kind: 'entryPoint';
  readonly entryPoint: number;
  /** EntryFunction. */
  readonly function: number;
  /** DATA byte 2: the tab count the editor stored. */
  readonly tabCount: number;
  /** The conditions by tab (PRKC); a tab without any holds. */
  readonly conditions: readonly (readonly Condition[])[];
  readonly data: EntryFunctionData;
}

export type PerkEntry = QuestStageEntry | AbilityEntry | EntryPointEntry;

export interface PerkRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly description: string;
  /** Requirements: the player must meet them to take it. */
  readonly conditions: readonly Condition[];
  /** DATA trait: a trait (Fallout's; no vanilla Skyrim perk is one). */
  readonly trait: boolean;
  readonly level: number;
  readonly ranks: number;
  readonly playable: boolean;
  readonly hidden: boolean;
  /** NNAM: the next rank, if it has one. */
  readonly next: number | undefined;
  /** Its entries, in the record's order. */
  readonly entries: readonly PerkEntry[];
}

type Source = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'text' | 'formIdAt' | 'textAt'>;

/** EPFT data types (xEdit). */
const DataType = {
  none: 0,
  float: 1,
  floatPair: 2,
  leveledList: 3,
  activateChoice: 4,
  spell: 5,
  string: 6,
  lstring: 7,
} as const;

/** The functions whose two floats are an actor value and a factor (xEdit wbEPFDDecider). */
const ACTOR_VALUE_FUNCTIONS: ReadonlySet<number> = new Set([
  EntryFunction.addActorValueMult,
  EntryFunction.setToActorValueMult,
  EntryFunction.multiplyActorValueMult,
  EntryFunction.multiplyOnePlusActorValueMult,
]);

interface PendingEntryPoint {
  rank: number;
  priority: number;
  entryPoint: number;
  fn: number;
  tabCount: number;
  /** By tab (a tab without conditions: a hole). */
  conditions: (Condition[] | undefined)[];
  tab: number;
  dataType: number;
  label: string;
  scriptFlags: number;
  fragment: number;
  epfd: Uint8Array | undefined;
}

function functionData(entry: PendingEntryPoint, record: Source): EntryFunctionData {
  const epfd = entry.epfd;
  const u32 = (): number => (epfd && epfd.length >= 4 ? record.formIdAt(epfd) : 0);
  const formOrNone = (): number | undefined => {
    const formId = u32();
    return formId === 0 ? undefined : formId;
  };
  switch (entry.dataType) {
    case DataType.float:
      return {
        type: 'float',
        value: epfd && epfd.length >= 4 ? view(epfd).getFloat32(0, true) : 0,
      };
    case DataType.floatPair: {
      const first = epfd && epfd.length >= 4 ? view(epfd).getFloat32(0, true) : 0;
      const second = epfd && epfd.length >= 8 ? view(epfd).getFloat32(4, true) : 0;
      return ACTOR_VALUE_FUNCTIONS.has(entry.fn)
        ? { type: 'actorValue', actorValue: Math.round(first), factor: second }
        : { type: 'range', min: first, max: second };
    }
    case DataType.leveledList:
      return { type: 'leveledList', list: u32() };
    case DataType.activateChoice:
      return {
        type: 'activateChoice',
        spell: formOrNone(),
        label: entry.label,
        runImmediately: (entry.scriptFlags & 0x1) !== 0,
        replaceDefault: (entry.scriptFlags & 0x2) !== 0,
        fragment: entry.fragment,
      };
    case DataType.spell:
      return { type: 'spell', spell: formOrNone() };
    case DataType.string: {
      if (!epfd) return { type: 'text', text: '' };
      const end = epfd.indexOf(0);
      return { type: 'text', text: decodeGameText(epfd, 0, end < 0 ? epfd.length : end) };
    }
    case DataType.lstring:
      return { type: 'text', text: epfd ? record.textAt(epfd) : '' };
    default:
      return { type: 'none' };
  }
}

/** The entries from the first PRKE on (each closed by PRKF). */
function parseEntries(fields: readonly Field[], start: number, record: Source): PerkEntry[] {
  const entries: PerkEntry[] = [];
  let type = -1;
  let rank = 0;
  let priority = 0;
  let pending: PendingEntryPoint | undefined;
  let plain: PerkEntry | undefined;
  for (let i = start; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const data = field.data;
    switch (field.type) {
      case 'PRKE':
        type = data[0] ?? -1;
        rank = data[1] ?? 0;
        priority = data[2] ?? 0;
        pending = undefined;
        plain = undefined;
        break;
      case 'DATA':
        if (type === PerkEntryType.quest && data.length >= 6) {
          plain = {
            kind: 'quest',
            rank,
            priority,
            quest: record.formIdAt(data),
            stage: view(data).getUint16(4, true),
          };
        } else if (type === PerkEntryType.ability && data.length >= 4) {
          plain = { kind: 'ability', rank, priority, spell: record.formIdAt(data) };
        } else if (type === PerkEntryType.entryPoint && data.length >= 2) {
          pending = {
            rank,
            priority,
            entryPoint: data[0] ?? 0,
            fn: data[1] ?? 0,
            tabCount: data[2] ?? 1,
            conditions: [],
            tab: -1,
            dataType: DataType.none,
            label: '',
            scriptFlags: 0,
            fragment: 0,
            epfd: undefined,
          };
        }
        break;
      case 'PRKC':
        if (pending) pending.tab = view(data).getInt8(0);
        break;
      case 'CTDA': {
        const condition = conditionAt(fields, i, record);
        if (pending && condition && pending.tab >= 0) {
          (pending.conditions[pending.tab] ??= []).push(condition);
        }
        break;
      }
      case 'EPFT':
        if (pending) pending.dataType = data[0] ?? DataType.none;
        break;
      case 'EPF2':
        if (pending) pending.label = record.textAt(data);
        break;
      case 'EPF3':
        if (pending && data.length >= 2) {
          pending.scriptFlags = view(data).getUint16(0, true);
          pending.fragment = data.length >= 4 ? view(data).getUint16(2, true) : 0;
        }
        break;
      case 'EPFD':
        if (pending) pending.epfd = data;
        break;
      case 'PRKF':
        if (pending) {
          const conditions = Array.from(pending.conditions, (tab) => tab ?? []);
          entries.push({
            kind: 'entryPoint',
            rank: pending.rank,
            priority: pending.priority,
            entryPoint: pending.entryPoint,
            function: pending.fn,
            tabCount: pending.tabCount,
            conditions,
            data: functionData(pending, record),
          });
        } else if (plain) {
          entries.push(plain);
        }
        pending = undefined;
        plain = undefined;
        type = -1;
        break;
      default:
        break;
    }
  }
  return entries;
}

export function parsePerk(record: Source): PerkRecord {
  const fields = record.fields.list;
  const conditions: Condition[] = [];
  let data: Uint8Array | undefined;
  let first = fields.length;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // Its entries (PRKE ...) bring conditions of their own.
    if (!field || field.type === 'PRKE') {
      first = i;
      break;
    }
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
    trait: (data?.[0] ?? 0) !== 0,
    level: data?.[1] ?? 0,
    ranks: Math.max(1, data?.[2] ?? 1),
    playable: (data?.[3] ?? 1) !== 0,
    hidden: (data?.[4] ?? 0) !== 0,
    next: next === 0 ? undefined : next,
    entries: parseEntries(fields, first, record),
  };
}
