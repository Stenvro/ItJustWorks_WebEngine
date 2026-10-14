// Quests (QUST): flags and priority, the story manager event that starts them, their stages
// (with log entries that complete or fail the quest), objectives and aliases with the ways
// they are filled (a forced reference, a unique actor, a created object, a matching reference,
// an alias of another quest, a location's reference of a type, an event's data).
// Platform-independent. Layout: docs/formats/esm.md ("Quests"), after UESP's QUST page.

import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt' | 'textAt'>;

/** QUST DNAM flags (the first two bytes, as a u16). */
export const QuestFlag = {
  startGameEnabled: 0x0001,
  wildernessEncounter: 0x0004,
  allowRepeatedStages: 0x0008,
  runOnce: 0x0100,
  excludeFromDialogueExport: 0x0200,
  warnOnAliasFillFailure: 0x0400,
} as const;

/** QUST INDX flags. */
export const StageFlag = {
  startUp: 0x02,
  shutDown: 0x04,
  keepInstanceData: 0x08,
} as const;

/** QSDT flags of a log entry. */
export const LogEntryFlag = {
  completeQuest: 0x01,
  failQuest: 0x02,
} as const;

/** Alias FNAM flags. */
export const AliasFlag = {
  reserves: 0x1,
  optional: 0x2,
  questObject: 0x4,
  allowReuse: 0x8,
  allowDead: 0x10,
  inLoadedArea: 0x20,
  essential: 0x40,
  allowDisabled: 0x80,
  storesText: 0x100,
  allowReserved: 0x200,
  protected: 0x400,
  noFillType: 0x800,
  allowDestroyed: 0x1000,
  closest: 0x2000,
  usesStoredText: 0x4000,
  initiallyDisabled: 0x8000,
  allowCleared: 0x10000,
  clearsNameWhenRemoved: 0x20000,
} as const;

export interface QuestLogEntry {
  /** QSDT (LogEntryFlag). */
  readonly flags: number;
  readonly conditions: readonly Condition[];
  /** CNAM: the journal text (localized). */
  readonly text: string | undefined;
  /** NAM0: the quest that follows. */
  readonly nextQuest: number | undefined;
}

export interface QuestStage {
  readonly index: number;
  /** INDX flags (StageFlag). */
  readonly flags: number;
  readonly logEntries: readonly QuestLogEntry[];
}

export interface QuestTarget {
  readonly alias: number;
  /** 1: the compass marker ignores locks. */
  readonly flags: number;
  readonly conditions: readonly Condition[];
}

export interface QuestObjective {
  readonly index: number;
  /** FNAM: 0x1 ORed with the previous one. */
  readonly flags: number;
  readonly text: string | undefined;
  readonly targets: readonly QuestTarget[];
}

/** How an alias is filled (its fill type), from its fields. */
export type AliasFill =
  | { readonly kind: 'forced'; readonly form: number }
  | { readonly kind: 'uniqueActor'; readonly npc: number }
  | {
      readonly kind: 'created';
      readonly base: number;
      /** The alias it is created at or in. */
      readonly alias: number;
      readonly inside: boolean;
      /** 0 easy .. 3 very hard, 4 none. */
      readonly level: number;
    }
  | { readonly kind: 'external'; readonly quest: number; readonly alias: number }
  | {
      readonly kind: 'locationReference';
      /** The location alias, the location reference type (LCRT). */
      readonly location: number;
      readonly referenceType: number;
    }
  | { readonly kind: 'referenceLocation'; readonly alias: number; readonly keyword: number }
  | { readonly kind: 'fromEvent'; readonly event: string; readonly data: string }
  | { readonly kind: 'matching'; readonly nearAlias: number | undefined }
  | { readonly kind: 'none' };

export interface QuestAlias {
  readonly id: number;
  readonly location: boolean;
  readonly name: string;
  /** FNAM (AliasFlag). */
  readonly flags: number;
  readonly fill: AliasFill;
  /** ALFI: the alias this one is forced into. */
  readonly forcedInto: number | undefined;
  /** Match conditions (Find Matching Reference / Location, and the event's). */
  readonly conditions: readonly Condition[];
  readonly keywords: readonly number[];
  readonly items: readonly { readonly item: number; readonly count: number }[];
  readonly spells: readonly number[];
  readonly factions: readonly number[];
  readonly packages: readonly number[];
  /** ALDN: the message whose text names the alias. */
  readonly displayName: number | undefined;
  readonly spectatorPackages: number | undefined;
  readonly combatPackages: number | undefined;
}

export interface QuestRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string | undefined;
  /** DNAM flags (QuestFlag). */
  readonly flags: number;
  readonly priority: number;
  /** 0 none, 1 main quest, 2 Mages' Guild, ... 9 Civil War, 10 Dawnguard, 11 Dragonborn. */
  readonly type: number;
  /** ENAM: the story manager event that starts it (e.g. "ADIA", "CLOC", "KILL"). */
  readonly event: string | undefined;
  /** CTDA before the stages: dialogue conditions, then (after NEXT) the event's. */
  readonly dialogueConditions: readonly Condition[];
  readonly eventConditions: readonly Condition[];
  readonly stages: readonly QuestStage[];
  readonly objectives: readonly QuestObjective[];
  readonly aliases: readonly QuestAlias[];
}

const fourCC = (data: Uint8Array): string =>
  String.fromCharCode(...data.subarray(0, 4)).replace(/\0+$/, '');
const zstring = (data: Uint8Array): string => {
  const end = data.indexOf(0);
  return String.fromCharCode(...data.subarray(0, end < 0 ? data.length : end));
};

/** An alias's fields while it is read. */
interface AliasDraft {
  id: number;
  location: boolean;
  name: string;
  flags: number;
  forcedInto: number | undefined;
  conditions: Condition[];
  keywords: number[];
  items: { item: number; count: number }[];
  spells: number[];
  factions: number[];
  packages: number[];
  displayName: number | undefined;
  spectatorPackages: number | undefined;
  combatPackages: number | undefined;
  forced?: number;
  uniqueActor?: number;
  created?: { base: number; alias: number; inside: boolean; level: number };
  externalQuest?: number;
  externalAlias?: number;
  /** ALFA before KNAM: a reference alias (location aliases); after: a location alias. */
  aliasField: number[];
  keyword?: number;
  referenceType?: number;
  event?: string;
  eventData?: string;
  nearAlias?: number;
}

export function parseQuest(record: RecordSource): QuestRecord {
  const fields = record.fields.list;
  const u32 = (data: Uint8Array, at = 0): number =>
    data.length >= at + 4 ? view(data).getUint32(at, true) : 0;
  const text = (data: Uint8Array): string => record.textAt(data);
  const dnam = record.fields.first('DNAM');
  const dialogueConditions: Condition[] = [];
  const eventConditions: Condition[] = [];
  let afterNext = false;
  let event: string | undefined;
  const stages: { index: number; flags: number; logEntries: QuestLogEntry[] }[] = [];
  let entry:
    | { flags: number; conditions: Condition[]; text: string | undefined; nextQuest?: number }
    | undefined;
  const objectives: {
    index: number;
    flags: number;
    text: string | undefined;
    targets: { alias: number; flags: number; conditions: Condition[] }[];
  }[] = [];
  const aliases: QuestAlias[] = [];
  let alias: AliasDraft | undefined;
  let section: 'header' | 'stages' | 'objectives' | 'aliases' = 'header';
  const closeEntry = (): void => {
    const stage = stages[stages.length - 1];
    if (entry && stage) {
      stage.logEntries.push({
        flags: entry.flags,
        conditions: entry.conditions,
        text: entry.text,
        nextQuest: entry.nextQuest,
      });
    }
    entry = undefined;
  };
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const { type, data } = field;
    if (type === 'INDX') {
      closeEntry();
      section = 'stages';
      stages.push({
        index: data.length >= 2 ? view(data).getInt16(0, true) : 0,
        flags: data[2] ?? 0,
        logEntries: [],
      });
      continue;
    }
    if (type === 'QOBJ') {
      closeEntry();
      section = 'objectives';
      objectives.push({
        index: data.length >= 2 ? view(data).getInt16(0, true) : 0,
        flags: 0,
        text: undefined,
        targets: [],
      });
      continue;
    }
    if (type === 'ALST' || type === 'ALLS') {
      closeEntry();
      section = 'aliases';
      alias = {
        id: u32(data),
        location: type === 'ALLS',
        name: '',
        flags: 0,
        forcedInto: undefined,
        conditions: [],
        keywords: [],
        items: [],
        spells: [],
        factions: [],
        packages: [],
        displayName: undefined,
        spectatorPackages: undefined,
        combatPackages: undefined,
        aliasField: [],
      };
      continue;
    }
    switch (section) {
      case 'header':
        if (type === 'ENAM' && data.length >= 4) event = fourCC(data);
        else if (type === 'NEXT') afterNext = true;
        else if (type === 'CTDA') {
          const condition = conditionAt(fields, i, record);
          if (condition) (afterNext ? eventConditions : dialogueConditions).push(condition);
        }
        break;
      case 'stages':
        if (type === 'QSDT') {
          closeEntry();
          entry = { flags: data[0] ?? 0, conditions: [], text: undefined };
        } else if (entry && type === 'CTDA') {
          const condition = conditionAt(fields, i, record);
          if (condition) entry.conditions.push(condition);
        } else if (entry && type === 'CNAM') {
          entry.text = text(data);
        } else if (entry && type === 'NAM0' && data.length >= 4) {
          entry.nextQuest = record.formIdAt(data, 0);
        }
        break;
      case 'objectives': {
        const objective = objectives[objectives.length - 1];
        if (!objective) break;
        if (type === 'FNAM') objective.flags = u32(data);
        else if (type === 'NNAM') objective.text = text(data);
        else if (type === 'QSTA' && data.length >= 8) {
          objective.targets.push({
            alias: view(data).getInt32(0, true),
            flags: u32(data, 4),
            conditions: [],
          });
        } else if (type === 'CTDA') {
          const condition = conditionAt(fields, i, record);
          const target = objective.targets[objective.targets.length - 1];
          if (condition && target) target.conditions.push(condition);
        }
        break;
      }
      case 'aliases':
        if (!alias) break;
        readAliasField(alias, type, data, fields, i, record);
        if (type === 'ALED') {
          aliases.push(finishAlias(alias));
          alias = undefined;
        }
        break;
    }
  }
  closeEntry();
  const flags = dnam && dnam.length >= 2 ? view(dnam).getUint16(0, true) : 0;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: ((full) => full && record.textAt(full))(record.fields.first('FULL')),
    flags,
    priority: dnam?.[2] ?? 0,
    type: dnam && dnam.length >= 12 ? view(dnam).getUint32(8, true) : 0,
    event,
    dialogueConditions,
    eventConditions,
    stages,
    objectives,
    aliases,
  };
}

function readAliasField(
  alias: AliasDraft,
  type: string,
  data: Uint8Array,
  fields: GameRecord['fields']['list'],
  index: number,
  record: RecordSource,
): void {
  const u32 = (at = 0): number => (data.length >= at + 4 ? view(data).getUint32(at, true) : 0);
  const form = (): number => (data.length >= 4 ? record.formIdAt(data, 0) : 0);
  switch (type) {
    case 'ALID':
      alias.name = zstring(data);
      break;
    case 'FNAM':
      alias.flags = u32();
      break;
    case 'ALFI':
      alias.forcedInto = u32();
      break;
    case 'ALFR':
    case 'ALFL':
      alias.forced = form();
      break;
    case 'ALUA':
      alias.uniqueActor = form();
      break;
    case 'ALCO':
      alias.created = { base: form(), alias: 0, inside: false, level: 4 };
      break;
    case 'ALCA':
      if (alias.created) {
        const value = u32();
        alias.created.inside = (value & 0x80000000) !== 0;
        alias.created.alias = value & 0x7fffffff;
      }
      break;
    case 'ALCL':
      if (alias.created) alias.created.level = u32();
      break;
    case 'ALEQ':
      alias.externalQuest = form();
      break;
    case 'ALEA':
      alias.externalAlias = u32();
      break;
    case 'ALFA':
      alias.aliasField.push(u32());
      break;
    case 'KNAM':
      alias.keyword = form();
      break;
    case 'ALRT':
      alias.referenceType = form();
      break;
    case 'ALFE':
      alias.event = fourCC(data);
      break;
    case 'ALFD':
      alias.eventData = fourCC(data);
      break;
    case 'ALNA':
      alias.nearAlias = u32();
      break;
    case 'CTDA': {
      const condition = conditionAt(fields, index, record);
      if (condition) alias.conditions.push(condition);
      break;
    }
    case 'KWDA':
      for (let at = 0; at + 4 <= data.length; at += 4)
        alias.keywords.push(record.formIdAt(data, at));
      break;
    case 'CNTO':
      if (data.length >= 8) alias.items.push({ item: form(), count: view(data).getInt32(4, true) });
      break;
    case 'ALSP':
      alias.spells.push(form());
      break;
    case 'ALFC':
      alias.factions.push(form());
      break;
    case 'ALPC':
      alias.packages.push(form());
      break;
    case 'ALDN':
      alias.displayName = form();
      break;
    case 'SPOR':
      alias.spectatorPackages = form();
      break;
    case 'ECOR':
      alias.combatPackages = form();
      break;
  }
}

function finishAlias(alias: AliasDraft): QuestAlias {
  let fill: AliasFill;
  if (alias.forced !== undefined && alias.forced !== 0)
    fill = { kind: 'forced', form: alias.forced };
  else if (alias.uniqueActor !== undefined && alias.uniqueActor !== 0)
    fill = { kind: 'uniqueActor', npc: alias.uniqueActor };
  else if (alias.created) fill = { kind: 'created', ...alias.created };
  else if (alias.externalQuest !== undefined)
    fill = { kind: 'external', quest: alias.externalQuest, alias: alias.externalAlias ?? 0 };
  else if (alias.referenceType !== undefined)
    fill = {
      kind: 'locationReference',
      location: alias.aliasField[alias.aliasField.length - 1] ?? 0,
      referenceType: alias.referenceType,
    };
  else if (alias.location && alias.keyword !== undefined)
    fill = { kind: 'referenceLocation', alias: alias.aliasField[0] ?? 0, keyword: alias.keyword };
  else if (alias.event !== undefined)
    fill = { kind: 'fromEvent', event: alias.event, data: alias.eventData ?? '' };
  else if (
    (alias.flags & AliasFlag.noFillType) === 0 &&
    (alias.conditions.length > 0 ||
      (alias.flags & (AliasFlag.inLoadedArea | AliasFlag.closest)) !== 0 ||
      alias.nearAlias !== undefined)
  )
    // Find Matching Reference / Location: by its conditions (in the loaded area, closest,
    // near an alias).
    fill = { kind: 'matching', nearAlias: alias.nearAlias };
  // Forced: None (UESP: the No Fill Type flag, or no fill at all): scripts fill it.
  else fill = { kind: 'none' };
  return {
    id: alias.id,
    location: alias.location,
    name: alias.name,
    flags: alias.flags,
    fill,
    forcedInto: alias.forcedInto,
    conditions: alias.conditions,
    keywords: alias.keywords,
    items: alias.items,
    spells: alias.spells,
    factions: alias.factions,
    packages: alias.packages,
    displayName: alias.displayName,
    spectatorPackages: alias.spectatorPackages,
    combatPackages: alias.combatPackages,
  };
}
