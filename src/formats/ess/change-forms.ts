// The change forms of an .ess save (docs/formats/ess.md): what changed on each form, by its
// change flags (CommonLibSSE's ChangeFlags; the layouts and their order per xEdit's
// wbDefinitionsTES5Saves). Read until the first part whose layout is not known; what is left
// is counted (`undecoded`) and named (`stoppedAt`). Platform-independent.

import { FormatError } from '../binary-reader.ts';
import { changeFormData, changeFormTypeName, type ChangeFormEntry } from './ess.ts';
import { EssReader, RefIdKind } from './ess-reader.ts';
import type { RefIdResolver } from './global-data.ts';

const bit = (n: number): number => (1 << n) >>> 0;

/** The change flags every form has (TESForm). */
export const CHANGE_FORM_FLAGS = bit(0);

/** References (TESObjectREFR) and actors (Actor). */
export const ChangeRefr = {
  moved: bit(1),
  havokMoved: bit(2),
  cellChanged: bit(3),
  scale: bit(4),
  inventory: bit(5),
  ownershipExtra: bit(6),
  baseObject: bit(7),
  itemExtraData: bit(10),
  ammoExtra: bit(11),
  lockExtra: bit(12),
  empty: bit(21),
  openDefaultState: bit(22),
  openState: bit(23),
  promoted: bit(25),
  activatingChildren: bit(26),
  leveledInventory: bit(27),
  animation: bit(28),
  encounterZoneExtra: bit(29),
  createdOnlyExtra: bit(30),
  gameOnlyExtra: bit(31),
  // Actor
  lifeState: bit(10),
  packageExtraData: bit(11),
  merchantContainer: bit(12),
  dismemberedLimbs: bit(17),
  leveledActor: bit(18),
  dispositionModifiers: bit(19),
  tempModifiers: bit(20),
  damageModifiers: bit(21),
  overrideModifiers: bit(22),
  permanentModifiers: bit(23),
} as const;

export const ChangeNpc = {
  baseData: bit(1),
  attributes: bit(2),
  aiData: bit(3),
  spellList: bit(4),
  fullName: bit(5),
  factions: bit(6),
  skills: bit(9),
  class: bit(10),
  face: bit(11),
  defaultOutfit: bit(12),
  sleepOutfit: bit(13),
  gender: bit(24),
  race: bit(25),
} as const;

export const ChangeQuest = {
  flags: bit(1),
  scriptDelay: bit(2),
  alreadyRun: bit(26),
  instanceData: bit(27),
  runtimeData: bit(28),
  objectives: bit(29),
  script: bit(30),
  stages: bit(31),
} as const;

export const ChangeCell = {
  flags: bit(1),
  fullName: bit(2),
  ownership: bit(3),
  exteriorShort: bit(28),
  exteriorChar: bit(29),
  detachTime: bit(30),
  seenData: bit(31),
} as const;

/** The base objects' own flags. */
export const ChangeBase = {
  value: bit(1),
  fullName: bit(2),
  bookTeaches: bit(5),
  bookRead: bit(6),
  /** INFO said once, INGR use, NOTE read, LCTN cleared, FLST added form, ... */
  last: bit(31),
  locationKeywordData: bit(30),
  factionFlags: bit(1),
} as const;

/** The QUST runtime flags (CommonLibSSE QuestFlag). */
export const QuestFlag = {
  enabled: 0x1,
  completed: 0x2,
  displayedInHud: 0x20,
  failed: 0x40,
  active: 0x800,
} as const;

/** The form flags a reference keeps (TESForm record flags). */
export const FormFlag = { deleted: 0x20, disabled: 0x800 } as const;

const REFERENCE_TYPES = new Set([0, 1, 2, 3, 4, 5, 40, 41, 42]);
/** Change flags that put an extra data list in a reference's data (xEdit). */
const REFERENCE_EXTRAS = 0xa6021c40;
const ACTOR_EXTRAS = 0xa6061840;

type Vec3 = [number, number, number];

export type InitialData =
  | {
      readonly kind: 'detached cell';
      readonly worldspaceIndex?: number;
      readonly x?: number;
      readonly y?: number;
      readonly detachTime: number;
    }
  | {
      readonly kind: 'moved';
      readonly cell: number;
      readonly position: Vec3;
      readonly rotation: Vec3;
    }
  | {
      readonly kind: 'created';
      readonly cell: number;
      readonly position: Vec3;
      readonly rotation: Vec3;
      readonly flags: number;
      readonly base: number;
    }
  | {
      readonly kind: 'changed cell';
      readonly cell: number;
      readonly position: Vec3;
      readonly rotation: Vec3;
      readonly newCell: number;
      readonly x: number;
      readonly y: number;
    };

/** An extra data entry of a reference or an inventory item, as far as its layout is known. */
export interface EssExtra {
  readonly type: number;
  readonly name: string;
  readonly value?: number | readonly number[];
}

export interface EssInventoryEntry {
  readonly item: number;
  /** The change against the base container's count. */
  readonly delta: number;
  readonly extras: readonly (readonly EssExtra[])[];
}

export interface EssNpcChanges {
  /** ACBS (24 bytes): flags, magicka and stamina offsets, level, ... */
  readonly baseData?: Uint8Array;
  readonly factions?: readonly { readonly faction: number; readonly rank: number }[];
  readonly spells?: readonly number[];
  readonly leveledSpells?: readonly number[];
  readonly shouts?: readonly number[];
  readonly aiData?: Uint8Array;
  readonly fullName?: string;
  /** DNAM (52 bytes): 18 skill values, 18 offsets, health, magicka, stamina, ... */
  readonly skills?: Uint8Array;
  readonly class?: number;
  readonly race?: { readonly current: number; readonly original: number };
  readonly face?: {
    readonly hairColor?: number;
    readonly skinTone?: readonly [number, number, number, number];
    readonly textureSet?: number;
    readonly headParts: readonly number[];
    readonly morphs?: readonly number[];
    readonly presets?: readonly number[];
  };
  readonly female?: boolean;
  readonly defaultOutfit?: number;
  readonly sleepOutfit?: number;
}

export interface EssQuestChanges {
  readonly flags?: number;
  readonly scriptDelay?: number;
  /** The stages, and whether each is done. */
  readonly stages?: readonly { readonly stage: number; readonly done: boolean }[];
  readonly objectives?: readonly { readonly index: number; readonly status: number }[];
  /** The aliases' references (runtime data). */
  readonly aliases?: readonly { readonly id: number; readonly reference: number }[];
  readonly alreadyRun?: boolean;
}

export interface EssCellChanges {
  readonly flags?: number;
  readonly fullName?: string;
  readonly owner?: number;
}

export interface EssChangeForm {
  readonly formId: number;
  readonly type: number;
  readonly changeFlags: number;
  readonly initial?: InitialData;
  readonly formFlags?: number;
  readonly baseObject?: number;
  readonly scale?: number;
  readonly extras?: readonly EssExtra[];
  readonly inventory?: readonly EssInventoryEntry[];
  readonly npc?: EssNpcChanges;
  readonly quest?: EssQuestChanges;
  readonly cell?: EssCellChanges;
  readonly factionFlags?: number;
  /** Bytes after what was read. */
  readonly undecoded: number;
  /** Why reading stopped before the end (a part whose layout is not known). */
  readonly stoppedAt?: string;
}

/** The extra data types whose layouts are known (xEdit), and their names. */
const EXTRA_NAMES: Readonly<Record<number, string>> = {
  0x0c: 'Unknown12',
  0x16: 'Worn',
  0x17: 'WornLeft',
  0x18: 'PackageStartLocation',
  0x19: 'Package',
  0x1a: 'TresPassPackage',
  0x1b: 'RunOncePacks',
  0x1c: 'ReferenceHandle',
  0x1d: 'Follower',
  0x1e: 'LevCreaModifier',
  0x1f: 'Ghost',
  0x21: 'Ownership',
  0x22: 'Global',
  0x23: 'Rank',
  0x24: 'Count',
  0x25: 'Health',
  0x27: 'TimeLeft',
};

class Unknown extends Error {}

function readExtras(reader: EssReader, resolve: RefIdResolver): EssExtra[] {
  const count = reader.vsval();
  const extras: EssExtra[] = [];
  for (let i = 0; i < count; i++) {
    const type = reader.u8();
    const name = EXTRA_NAMES[type];
    if (name === undefined) {
      throw new Unknown(`extra data type 0x${type.toString(16)}`);
    }
    let value: number | number[] | undefined;
    switch (type) {
      case 0x0c: {
        resolve(reader.refId());
        const n = reader.vsval();
        for (let j = 0; j < n; j++) {
          reader.u32();
          reader.refId();
          reader.skip(8);
        }
        if (reader.u8() !== 0) reader.skip(8);
        reader.u8();
        break;
      }
      case 0x18:
        value = [resolve(reader.refId()), ...reader.vec3()];
        reader.u32();
        break;
      case 0x19:
        value = [resolve(reader.refId()), resolve(reader.refId())];
        reader.u32();
        reader.skip(3);
        break;
      case 0x1a:
      case 0x1c:
      case 0x21:
      case 0x22:
        value = resolve(reader.refId());
        break;
      case 0x1b: {
        const n = reader.vsval();
        value = [];
        for (let j = 0; j < n; j++) {
          value.push(resolve(reader.refId()));
          reader.u8();
        }
        break;
      }
      case 0x1e:
        value = reader.u32();
        break;
      case 0x1f:
        value = reader.u8();
        break;
      case 0x23:
        value = reader.i32();
        break;
      case 0x24:
        value = reader.i16();
        break;
      case 0x25:
        value = reader.f32();
        break;
      default:
        break; // no data
    }
    extras.push({ type, name, ...(value !== undefined && { value }) });
  }
  return extras;
}

function readInventory(reader: EssReader, resolve: RefIdResolver): EssInventoryEntry[] {
  const count = reader.vsval();
  const entries: EssInventoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const item = resolve(reader.refId());
    const delta = reader.i32();
    const lists = reader.vsval();
    const extras: EssExtra[][] = [];
    for (let j = 0; j < lists; j++) extras.push(readExtras(reader, resolve));
    entries.push({ item, delta, extras });
  }
  return entries;
}

function readInitial(
  reader: EssReader,
  entry: ChangeFormEntry,
  resolve: RefIdResolver,
): InitialData | undefined {
  const flags = entry.changeFlags;
  if (entry.type === 6) {
    if ((flags & ChangeCell.detachTime) === 0) return undefined;
    if (flags & ChangeCell.exteriorChar) {
      return {
        kind: 'detached cell',
        worldspaceIndex: reader.u16(),
        x: reader.i8(),
        y: reader.i8(),
        detachTime: reader.u32(),
      };
    }
    if (flags & ChangeCell.exteriorShort) {
      return {
        kind: 'detached cell',
        worldspaceIndex: reader.u16(),
        x: reader.i16(),
        y: reader.i16(),
        detachTime: reader.u32(),
      };
    }
    return { kind: 'detached cell', detachTime: reader.u32() };
  }
  if (!REFERENCE_TYPES.has(entry.type)) return undefined;
  let initial: InitialData | undefined;
  const place = (): { cell: number; position: Vec3; rotation: Vec3 } => ({
    cell: resolve(reader.refId()),
    position: reader.vec3(),
    rotation: reader.vec3(),
  });
  if (entry.refId >>> 22 === RefIdKind.Created) {
    initial = { kind: 'created', ...place(), flags: reader.u8(), base: resolve(reader.refId()) };
  } else if (flags & (ChangeRefr.cellChanged | ChangeRefr.promoted)) {
    initial = {
      kind: 'changed cell',
      ...place(),
      newCell: resolve(reader.refId()),
      x: reader.i16(),
      y: reader.i16(),
    };
  } else if (flags & (ChangeRefr.moved | ChangeRefr.havokMoved)) {
    initial = { kind: 'moved', ...place() };
  }
  if (initial && flags & ChangeRefr.havokMoved) reader.skip(reader.vsval());
  return initial;
}

/** Reads one change form's data (inflating it first). Never throws for unknown layouts. */
export function readChangeForm(entry: ChangeFormEntry, resolve: RefIdResolver): EssChangeForm {
  const reader = new EssReader(changeFormData(entry));
  const flags = entry.changeFlags;
  const has = (mask: number): boolean => (flags & mask) !== 0;
  const out: {
    -readonly [K in keyof EssChangeForm]: EssChangeForm[K];
  } = {
    formId: entry.formId ?? 0,
    type: entry.type,
    changeFlags: flags,
    undecoded: 0,
  };
  try {
    const initial = readInitial(reader, entry, resolve);
    if (initial) out.initial = initial;
    const formFlags = (): void => {
      if (!has(CHANGE_FORM_FLAGS)) return;
      out.formFlags = reader.u32();
      reader.u16();
    };
    const type = entry.type;
    if (REFERENCE_TYPES.has(type)) {
      if (type === 1) {
        reader.u32(); // has equipment data
        reader.u32();
      }
      formFlags();
      if (has(ChangeRefr.baseObject)) out.baseObject = resolve(reader.refId());
      if (has(ChangeRefr.scale)) out.scale = reader.f32();
      if (has(type === 1 ? ACTOR_EXTRAS : REFERENCE_EXTRAS))
        out.extras = readExtras(reader, resolve);
      if (has(ChangeRefr.inventory | ChangeRefr.leveledInventory)) {
        out.inventory = readInventory(reader, resolve);
      }
      if (has(ChangeRefr.animation)) reader.skip(reader.vsval());
      // TODO(M13): an actor's data after this (its equipment, actor values and modifiers,
      // life state, packages) has no known layout yet.
      if (type === 1 && reader.remaining > 0) throw new Unknown('actor data');
    } else if (type === 6) {
      formFlags();
      const cell: { -readonly [K in keyof EssCellChanges]: EssCellChanges[K] } = {};
      if (has(ChangeCell.flags)) cell.flags = reader.u16();
      if (has(ChangeCell.seenData)) {
        const exterior = initial?.kind === 'detached cell' && initial.x !== undefined;
        if (exterior) reader.skip(32);
        else {
          const n = reader.vsval();
          for (let i = 0; i < n; i++) reader.skip(2 + 32);
        }
      }
      if (has(ChangeCell.fullName)) cell.fullName = reader.wstring();
      if (has(ChangeCell.ownership)) cell.owner = resolve(reader.refId());
      out.cell = cell;
    } else if (type === 8) {
      formFlags();
      out.quest = readQuest(reader, flags, resolve);
    } else if (type === 9) {
      formFlags();
      out.npc = readNpc(reader, flags, resolve);
    } else {
      formFlags();
      if (type === 31 && has(ChangeBase.factionFlags)) out.factionFlags = reader.u32();
    }
  } catch (error) {
    if (error instanceof Unknown) out.stoppedAt = error.message;
    else if (error instanceof FormatError) out.stoppedAt = `corrupt: ${error.message}`;
    else throw error;
  }
  out.undecoded = reader.remaining;
  if (out.undecoded > 0 && out.stoppedAt === undefined) {
    out.stoppedAt = `${String(out.undecoded)} bytes of ${changeFormTypeName(entry.type)} data`;
  }
  return out;
}

function readQuest(reader: EssReader, flags: number, resolve: RefIdResolver): EssQuestChanges {
  const has = (mask: number): boolean => (flags & mask) !== 0;
  const quest: { -readonly [K in keyof EssQuestChanges]: EssQuestChanges[K] } = {};
  if (has(ChangeQuest.flags)) quest.flags = reader.u16();
  if (has(ChangeQuest.scriptDelay)) quest.scriptDelay = reader.u32();
  if (has(ChangeQuest.stages)) {
    const stages: { stage: number; done: boolean }[] = [];
    const n = reader.vsval();
    for (let i = 0; i < n; i++) stages.push({ stage: reader.u16(), done: (reader.u8() & 1) !== 0 });
    quest.stages = stages;
  }
  if (has(ChangeQuest.objectives)) {
    const objectives: { index: number; status: number }[] = [];
    const n = reader.vsval();
    for (let i = 0; i < n; i++) objectives.push({ index: reader.u32(), status: reader.u32() });
    quest.objectives = objectives;
  }
  if (has(ChangeQuest.runtimeData)) {
    reader.u8();
    const aliases: { id: number; reference: number }[] = [];
    const n = reader.u32();
    for (let i = 0; i < n; i++) {
      const id = reader.u32();
      const kind = reader.u8();
      if (kind === 0) aliases.push({ id, reference: resolve(reader.refId()) });
      else if (kind === 1) {
        aliases.push({ id, reference: resolve(reader.refId()) });
        reader.skip(4 * 3);
      } else throw new Unknown(`quest alias data of kind ${String(kind)}`);
    }
    quest.aliases = aliases;
    const locations = reader.u32();
    reader.skip(locations * 7);
    if (reader.u8() !== 0) {
      reader.u32();
      reader.skip(4);
      const params = reader.u32();
      for (let i = 0; i < params; i++) {
        const type = reader.u32();
        if (type === 3) reader.u32();
        else if (type <= 4) reader.refId();
      }
    }
  }
  if (has(ChangeQuest.instanceData)) {
    reader.u32();
    const n = reader.vsval();
    for (let i = 0; i < n; i++) {
      reader.u32();
      reader.skip(reader.vsval() * 7);
      reader.skip(reader.vsval() * 7);
      reader.skip(3);
    }
  }
  if (has(ChangeQuest.alreadyRun)) quest.alreadyRun = reader.u8() !== 0;
  return quest;
}

function readNpc(reader: EssReader, flags: number, resolve: RefIdResolver): EssNpcChanges {
  const has = (mask: number): boolean => (flags & mask) !== 0;
  const npc: { -readonly [K in keyof EssNpcChanges]: EssNpcChanges[K] } = {};
  const refIds = (): number[] => {
    const n = reader.vsval();
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(resolve(reader.refId()));
    return out;
  };
  if (has(ChangeNpc.attributes)) throw new Unknown('NPC attributes');
  if (has(ChangeNpc.baseData)) npc.baseData = reader.bytes(24);
  if (has(ChangeNpc.factions)) {
    const factions: { faction: number; rank: number }[] = [];
    const n = reader.vsval();
    for (let i = 0; i < n; i++)
      factions.push({ faction: resolve(reader.refId()), rank: reader.i8() });
    npc.factions = factions;
  }
  if (has(ChangeNpc.spellList)) {
    npc.spells = refIds();
    npc.leveledSpells = refIds();
    npc.shouts = refIds();
  }
  if (has(ChangeNpc.aiData)) npc.aiData = reader.bytes(20);
  if (has(ChangeNpc.fullName)) npc.fullName = reader.wstring();
  if (has(ChangeNpc.skills)) npc.skills = reader.bytes(52);
  if (has(ChangeNpc.class)) npc.class = resolve(reader.refId());
  if (has(ChangeNpc.race)) {
    npc.race = { current: resolve(reader.refId()), original: resolve(reader.refId()) };
  }
  if (has(ChangeNpc.face)) {
    const face: {
      hairColor?: number;
      skinTone?: [number, number, number, number];
      textureSet?: number;
      headParts: number[];
      morphs?: number[];
      presets?: number[];
    } = { headParts: [] };
    if (reader.u8() !== 0) {
      face.hairColor = resolve(reader.refId());
      face.skinTone = [reader.u8(), reader.u8(), reader.u8(), reader.u8()];
      face.textureSet = resolve(reader.refId());
    }
    face.headParts = refIds();
    if (reader.u8() !== 0) {
      const morphs: number[] = [];
      const m = reader.u32();
      for (let i = 0; i < m; i++) morphs.push(reader.f32());
      const presets: number[] = [];
      const p = reader.u32();
      for (let i = 0; i < p; i++) presets.push(reader.u32());
      face.morphs = morphs;
      face.presets = presets;
    }
    npc.face = face;
  }
  if (has(ChangeNpc.gender)) npc.female = reader.u8() === 1;
  if (has(ChangeNpc.defaultOutfit)) npc.defaultOutfit = resolve(reader.refId());
  if (has(ChangeNpc.sleepOutfit)) npc.sleepOutfit = resolve(reader.refId());
  return npc;
}
