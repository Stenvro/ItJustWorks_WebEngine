// AI packages (PACK): what an actor does when. A package has a schedule and conditions; most
// take their procedure tree (Sequence / Simultaneous / Random / Stacked branches over
// procedures: Travel, Sit, Sleep, Patrol, Sandbox, ...) from a template package (PKCU) and
// fill its public data inputs (a sit target, a patrol start, a sleep location). Packages
// without a template carry their own tree. Platform-independent.
// Layout: docs/formats/esm.md ("AI packages"), after UESP's PACK page.

import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from '../world/record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

/** PKDT misc flags. */
export const PackageFlag = {
  mustComplete: 0x4,
  maintainSpeedAtGoal: 0x8,
  unlockDoorsAtStart: 0x40,
  unlockDoorsOnChange: 0x80,
  oncePerDay: 0x400,
  preferredSpeed: 0x2000,
  alwaysSneak: 0x20000,
  allowSwimming: 0x40000,
  ignoreCombat: 0x100000,
  weaponsUnequipped: 0x200000,
  weaponDrawn: 0x800000,
  noCombatAlert: 0x8000000,
  wearSleepOutfit: 0x20000000,
} as const;

/** PLDT location types. */
export const LocationType = {
  nearReference: 0,
  inCell: 1,
  nearPackageStart: 2,
  nearEditorLocation: 3,
  objectId: 4,
  objectType: 5,
  nearLinkedReference: 6,
  atPackageLocation: 7,
  aliasReference: 8,
  aliasLocation: 9,
  nearSelf: 12,
} as const;

/** PTDA target types. */
export const TargetType = {
  specificReference: 0,
  objectId: 1,
  objectType: 2,
  linkedReference: 3,
  referenceAlias: 4,
  self: 6,
} as const;

/** PSDT: when a package runs (−1 / 0: any). */
export interface PackageSchedule {
  /** Month (0: Morning Star), −1 any. */
  readonly month: number;
  /** 0 Sundas .. 6 Loredas; 7 weekdays, 8 weekends, 9 Morndas/Middas/Fredas, 10 Tirdas/Turdas. */
  readonly dayOfWeek: number;
  /** Day of the month, 0 any. */
  readonly date: number;
  /** Start hour, −1 any time. */
  readonly hour: number;
  readonly minute: number;
  /** Minutes it lasts from its start. */
  readonly duration: number;
}

/** PLDT: a place. `form` is a global form id for the types that name a form, else raw. */
export interface PackageLocation {
  readonly type: number;
  readonly form: number;
  readonly radius: number;
}

/** PTDA: a target. `value` is a global form id for the types that name a form, else raw. */
export interface PackageTarget {
  readonly type: number;
  readonly value: number;
  readonly count: number;
}

/** A data input's value, by its type (ANAM). */
export type PackageValue =
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  /** ObjectList: a float whose meaning is not documented. */
  | { readonly kind: 'objectList'; readonly value: number }
  | { readonly kind: 'location'; readonly location: PackageLocation }
  | { readonly kind: 'singleRef'; readonly target: PackageTarget }
  | { readonly kind: 'targetSelector'; readonly target: PackageTarget }
  /** PDTO: a dialogue topic (DIAL) or a topic subtype (four characters); TPIC a topic. */
  | { readonly kind: 'topic'; readonly topic: number | string | undefined };

/** A public data input: its id (UNAM) and value. */
export interface PackageInput {
  readonly id: number;
  /** ANAM: Bool, Int, Float, ObjectList, Location, SingleRef, TargetSelector, Topic. */
  readonly type: string;
  readonly value: PackageValue | undefined;
}

/** A branch of the procedure tree. */
export interface ProcedureBranch {
  /** ANAM: Procedure, Sequence, Simultaneous, Random, Stacked. */
  readonly type: string;
  readonly conditions: readonly Condition[];
  /** PNAM: the procedure (Procedure branches): Travel, Sit, Sleep, Patrol, Sandbox, ... */
  readonly procedure: string | undefined;
  /** FNAM: 0x1 its success completes the package. */
  readonly flags: number;
  /** PKC2: the ids of the data inputs it uses, in order (255: none). */
  readonly inputs: readonly number[];
  readonly children: readonly ProcedureBranch[];
}

/** A template's name for one of its data inputs (procedure data). */
export interface PackageInputName {
  readonly id: number;
  /** BNAM: as the Creation Kit shows it ("Patrol Start", "Sleep Location", "Target"). */
  readonly name: string;
  /** PNAM: 1 when packages using the template fill it. */
  readonly public: boolean;
}

export interface PackageRecord {
  readonly formId: number;
  readonly editorId: string;
  /** PKDT misc flags (PackageFlag). */
  readonly flags: number;
  /** PKDT package type: 0x1 a template. */
  readonly type: number;
  readonly interruptOverride: number;
  /** 0 walk, 1 jog, 2 run, 3 fast walk (with PackageFlag.preferredSpeed). */
  readonly preferredSpeed: number;
  readonly interruptFlags: number;
  readonly schedule: PackageSchedule | undefined;
  /** CTDA before the data: when it may run. */
  readonly conditions: readonly Condition[];
  /** QNAM: the quest that owns it. */
  readonly ownerQuest: number | undefined;
  /** PKCU: the template package whose tree it runs. */
  readonly template: number | undefined;
  /** Public data inputs (ANAM and value, then UNAM ids in the same order). */
  readonly inputs: readonly PackageInput[];
  /** Its own procedure tree (templates, and packages without one). */
  readonly tree: ProcedureBranch | undefined;
  readonly inputNames: readonly PackageInputName[];
  /** POBA / POEA / POCA: the idle played on begin, end and change (INAM). */
  readonly onBegin: number | undefined;
  readonly onEnd: number | undefined;
  readonly onChange: number | undefined;
}

const decodeName = (data: Uint8Array): string => {
  const end = data.indexOf(0);
  return String.fromCharCode(...data.subarray(0, end < 0 ? data.length : end));
};

/** Types of PLDT whose value is a form id. */
const LOCATION_FORMS: ReadonlySet<number> = new Set([
  LocationType.nearReference,
  LocationType.inCell,
  LocationType.objectId,
  LocationType.nearLinkedReference,
  LocationType.aliasLocation,
]);
/** Types of PTDA whose value is a form id. */
const TARGET_FORMS: ReadonlySet<number> = new Set([
  TargetType.specificReference,
  TargetType.objectId,
  TargetType.linkedReference,
]);

function readLocation(record: RecordSource, data: Uint8Array): PackageLocation | undefined {
  if (data.length < 12) return undefined;
  const v = view(data);
  const type = v.getInt32(0, true);
  const raw = v.getUint32(4, true);
  return {
    type,
    form: LOCATION_FORMS.has(type) && raw !== 0 ? record.formIdAt(data, 4) : raw,
    radius: v.getInt32(8, true),
  };
}

function readTarget(record: RecordSource, data: Uint8Array): PackageTarget | undefined {
  if (data.length < 12) return undefined;
  const v = view(data);
  const type = v.getInt32(0, true);
  const raw = v.getUint32(4, true);
  return {
    type,
    value: TARGET_FORMS.has(type) && raw !== 0 ? record.formIdAt(data, 4) : raw,
    count: v.getInt32(8, true),
  };
}

/** The value of an input of type `type` from its field (CNAM, PLDT, PTDA, PDTO, TPIC). */
function readValue(
  record: RecordSource,
  type: string,
  field: { readonly type: string; readonly data: Uint8Array },
): PackageValue | undefined {
  const data = field.data;
  switch (field.type) {
    case 'CNAM': {
      const v = view(data);
      if (type === 'Bool' && data.length >= 1) return { kind: 'bool', value: data[0] !== 0 };
      if (data.length < 4) return undefined;
      if (type === 'Int') return { kind: 'int', value: v.getInt32(0, true) };
      if (type === 'Float') return { kind: 'float', value: v.getFloat32(0, true) };
      if (type === 'ObjectList') return { kind: 'objectList', value: v.getFloat32(0, true) };
      return undefined;
    }
    case 'PLDT': {
      const location = readLocation(record, data);
      return location && { kind: 'location', location };
    }
    case 'PTDA': {
      const target = readTarget(record, data);
      if (!target) return undefined;
      return type === 'TargetSelector'
        ? { kind: 'targetSelector', target }
        : { kind: 'singleRef', target };
    }
    case 'PDTO': {
      if (data.length < 8) return undefined;
      const kind = view(data).getUint32(0, true);
      const topic = kind === 0 ? record.formIdAt(data, 4) : decodeName(data.subarray(4, 8));
      return { kind: 'topic', topic };
    }
    case 'TPIC':
      return data.length >= 4 ? { kind: 'topic', topic: record.formIdAt(data, 0) } : undefined;
    default:
      return undefined;
  }
}

/** Where the record's sections begin: the public data, the tree, the procedure data. */
type Section = 'header' | 'data' | 'tree' | 'names' | 'events';

export function parsePackage(record: RecordSource): PackageRecord {
  const fields = record.fields.list;
  const u32 = (data: Uint8Array | undefined, at = 0): number | undefined =>
    data && data.length >= at + 4 ? view(data).getUint32(at, true) : undefined;
  const pkdt = record.fields.first('PKDT');
  const psdt = record.fields.first('PSDT');
  const pkcu = record.fields.first('PKCU');
  const schedule: PackageSchedule | undefined =
    psdt && psdt.length >= 12
      ? {
          month: view(psdt).getInt8(0),
          dayOfWeek: view(psdt).getInt8(1),
          date: psdt[2] ?? 0,
          hour: view(psdt).getInt8(3),
          minute: view(psdt).getInt8(4),
          duration: view(psdt).getUint32(8, true),
        }
      : undefined;
  const conditions: Condition[] = [];
  let ownerQuest: number | undefined;
  const types: string[] = [];
  const values: (PackageValue | undefined)[] = [];
  const ids: number[] = [];
  const inputNames: PackageInputName[] = [];
  const events: Record<'POBA' | 'POEA' | 'POCA', number | undefined> = {
    POBA: undefined,
    POEA: undefined,
    POCA: undefined,
  };
  let event: 'POBA' | 'POEA' | 'POCA' | undefined;
  // The tree's branches in order, each with how many children it still takes.
  const roots: ProcedureBranch[] = [];
  const open: { branch: ProcedureBranch & { children: ProcedureBranch[] }; left: number }[] = [];
  let branch:
    | {
        type: string;
        conditions: Condition[];
        childCount: number;
        procedure: string | undefined;
        flags: number;
        inputs: number[];
      }
    | undefined;
  const closeBranch = (): void => {
    if (!branch) return;
    const done: ProcedureBranch & { children: ProcedureBranch[] } = {
      type: branch.type,
      conditions: branch.conditions,
      procedure: branch.procedure,
      flags: branch.flags,
      inputs: branch.inputs,
      children: [],
    };
    const parent = open[open.length - 1];
    if (parent) {
      parent.branch.children.push(done);
      parent.left--;
    } else {
      roots.push(done);
    }
    if (branch.type !== 'Procedure' && branch.childCount > 0) {
      open.push({ branch: done, left: branch.childCount });
    }
    while (open.length > 0 && (open[open.length - 1]?.left ?? 0) <= 0) open.pop();
    branch = undefined;
  };
  let section: Section = 'header';
  let name: { id: number; name: string } | undefined;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const { type, data } = field;
    if (type === 'POBA' || type === 'POEA' || type === 'POCA') {
      closeBranch();
      section = 'events';
      event = type;
      continue;
    }
    switch (section) {
      case 'header':
        if (type === 'CTDA') {
          const condition = conditionAt(fields, i, record);
          if (condition) conditions.push(condition);
        } else if (type === 'QNAM' && data.length >= 4) {
          ownerQuest = record.formIdAt(data, 0);
        } else if (type === 'ANAM') {
          section = 'data';
          types.push(decodeName(data));
          values.push(undefined);
        } else if (type === 'XNAM') {
          section = 'tree';
        }
        break;
      case 'data':
        if (type === 'ANAM') {
          types.push(decodeName(data));
          values.push(undefined);
        } else if (type === 'UNAM') {
          ids.push(data[0] ?? 0);
        } else if (type === 'XNAM') {
          section = 'tree';
        } else if (values.length > 0 && values[values.length - 1] === undefined) {
          values[values.length - 1] = readValue(record, types[types.length - 1] ?? '', field);
        }
        break;
      case 'tree':
        if (type === 'ANAM') {
          closeBranch();
          branch = {
            type: decodeName(data),
            conditions: [],
            childCount: 0,
            procedure: undefined,
            flags: 0,
            inputs: [],
          };
        } else if (branch && type === 'CTDA') {
          // CITC before them counts them.
          const condition = conditionAt(fields, i, record);
          if (condition) branch.conditions.push(condition);
        } else if (branch && type === 'PRCB') {
          // Two u32s, undocumented: the first is the branch's child count in every package.
          branch.childCount = u32(data) ?? 0;
        } else if (branch && type === 'PNAM') {
          branch.procedure = decodeName(data);
        } else if (branch && type === 'FNAM') {
          branch.flags = u32(data) ?? 0;
        } else if (branch && type === 'PKC2') {
          branch.inputs.push(data[0] ?? 0);
        } else if (type === 'UNAM') {
          closeBranch();
          section = 'names';
          name = { id: data[0] ?? 0, name: '' };
        }
        break;
      case 'names':
        if (type === 'UNAM') {
          name = { id: data[0] ?? 0, name: '' };
        } else if (type === 'BNAM' && name) {
          name.name = decodeName(data);
        } else if (type === 'PNAM' && name) {
          inputNames.push({ id: name.id, name: name.name, public: (u32(data) ?? 0) !== 0 });
          name = undefined;
        }
        break;
      case 'events':
        if (type === 'INAM' && event && data.length >= 4) {
          const idle = record.formIdAt(data, 0);
          events[event] = idle === 0 ? undefined : idle;
        }
        break;
    }
  }
  closeBranch();
  const inputs: PackageInput[] = types.map((type, index) => ({
    id: ids[index] ?? index,
    type,
    value: values[index],
  }));
  const v = pkdt && pkdt.length >= 12 ? view(pkdt) : undefined;
  const template = u32(pkcu, 4) !== undefined && pkcu ? record.formIdAt(pkcu, 4) : undefined;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: v?.getUint32(0, true) ?? 0,
    type: v?.getUint8(4) ?? 0,
    interruptOverride: v?.getUint8(5) ?? 0,
    preferredSpeed: v?.getUint8(6) ?? 0,
    interruptFlags: v?.getUint32(8, true) ?? 0,
    schedule,
    conditions,
    ownerQuest,
    template: template === 0 ? undefined : template,
    inputs,
    tree: roots[0],
    inputNames,
    onBegin: events.POBA,
    onEnd: events.POEA,
    onChange: events.POCA,
  };
}
