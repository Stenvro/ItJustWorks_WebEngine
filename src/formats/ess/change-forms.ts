// The change forms of an .ess save (docs/formats/ess.md): what changed on each form, by its
// change flags (CommonLibSSE's ChangeFlags; UESP's "Save File Format" pages, the rest as the
// original writes each flag's data, in its order). Read until the first part whose layout is
// not known; what is left is counted (`undecoded`) and named (`stoppedAt`).
// Platform-independent.

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

const REFERENCE_TYPES = new Set([0, 1, 2, 3, 4, 5, 40, 41, 42, 47]);
const PLAYER_REF = 0x14;
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

/** An extra data entry of a reference or an inventory item. */
export interface EssExtra {
  readonly type: number;
  readonly name: string;
  readonly value?: number | readonly number[];
  /** FactionChanges: the factions a script put the actor in (rank −1: taken out). */
  readonly factions?: readonly { readonly faction: number; readonly rank: number }[];
  /** LeveledCreature: the changes to the actor's generated base. */
  readonly npc?: EssNpcChanges;
  /** TextDisplayData: a name the player gave (enchanting). */
  readonly text?: string;
}

/** An actor's actor values as its change form keeps them. */
export interface EssActorValues {
  /** Health, magicka, stamina and voice points: permanent, temporary and damage modifiers. */
  readonly modifiers: readonly EssValueModifiers[];
  /** Base values that changed, by actor value index. */
  readonly base: readonly { readonly av: number; readonly value: number }[];
  /** The other actor values' modifiers. */
  readonly others: readonly EssValueModifiers[];
}

export interface EssValueModifiers {
  readonly av: number;
  readonly permanent: number;
  readonly temporary: number;
  /** The game keeps damage as a negative modifier. */
  readonly damage: number;
}

/** What an actor (ACHR) keeps beside its reference data. */
export interface EssActorData {
  /** The AI process level (0 high to 3 low), or −1: none. */
  readonly processLevel: number;
  readonly values?: EssActorValues;
  /** Spells added to the actor (AddSpell). */
  readonly addedSpells?: readonly number[];
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

export interface EssFactionChanges {
  readonly flags?: number;
  /** Reactions to other factions: modifier and group combat reaction. */
  readonly reactions?: readonly {
    readonly faction: number;
    readonly modifier: number;
    readonly reaction: number;
  }[];
  /** The crime counts and the time of the last arrest resisted (game days, relative). */
  readonly crime?: readonly [number, number, number, number];
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
  readonly actor?: EssActorData;
  readonly faction?: EssFactionChanges;
  /** LVLN, LVLI, LVSP: the entries a script added (AddForm). */
  readonly leveledAdded?: readonly {
    readonly form: number;
    readonly level: number;
    readonly count: number;
  }[];
  /** Bytes after what was read. */
  readonly undecoded: number;
  /** Why reading stopped before the end (a part whose layout is not known). */
  readonly stoppedAt?: string;
}

/**
 * The names of the extra data types a save writes (CommonLibSSE's ExtraDataType). The layout of
 * each is the original's (docs/formats/ess.md "Extra data"); a type the original has no layout
 * for is written as its type byte alone.
 */
const EXTRA_NAMES: Readonly<Record<number, string>> = {
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
  0x28: 'Charge',
  0x2a: 'Lock',
  0x2b: 'Teleport',
  0x2c: 'MapMarker',
  0x2d: 'LeveledCreature',
  0x2e: 'LeveledItem',
  0x2f: 'Scale',
  0x31: 'MagicCaster',
  0x32: 'NonActorMagicTarget',
  0x34: 'PlayerCrimeList',
  0x38: 'ItemDropper',
  0x3d: 'CannotWear',
  0x3e: 'Poison',
  0x44: 'FriendHits',
  0x45: 'HeadingTarget',
  0x48: 'StartingWorldOrCell',
  0x49: 'Hotkey',
  0x4c: 'InfoGeneralTopic',
  0x4d: 'HasNoRumors',
  0x4f: 'TerminalState',
  0x53: 'ActivateRefChildren',
  0x54: 'CanTalkToPlayer',
  0x55: 'ObjectHealth',
  0x58: 'ModelSwap',
  0x59: 'Radius',
  0x5b: 'FactionChanges',
  0x5c: 'DismemberedLimbs',
  0x5d: 'ActorCause',
  0x65: 'CombatStyle',
  0x68: 'OpenCloseActivateRef',
  0x6a: 'Ammo',
  0x6c: 'PackageData',
  0x6f: 'SayTopicInfoOnceADay',
  0x70: 'EncounterZone',
  0x71: 'SayTopicInfo',
  0x78: 'GuardedRefData',
  0x85: 'AshPileRef',
  0x87: 'FollowerSwimBreadcrumbs',
  0x88: 'AliasInstanceArray',
  0x8c: 'PromotedRef',
  0x8e: 'OutfitItem',
  0x92: 'SceneData',
  0x95: 'FromAlias',
  0x96: 'ShouldWear',
  0x98: 'AttachedArrows3D',
  0x99: 'TextDisplayData',
  0x9b: 'Enchantment',
  0x9c: 'Soul',
  0x9d: 'ForcedTarget',
  0x9f: 'UniqueID',
  0xa0: 'Flags',
  0xa1: 'RefrPath',
  0xa4: 'ForcedLandingMarker',
  0xa9: 'Interaction',
  0xae: 'GroupConstraint',
  0xaf: 'ScriptedAnimDependence',
  0xb0: 'CachedScale',
};

class Unknown extends Error {}

/** One extra data entry's data, by its type (the original's layouts). */
function readExtra(
  reader: EssReader,
  type: number,
  resolve: RefIdResolver,
): Omit<EssExtra, 'type' | 'name'> {
  const ref = (): number => resolve(reader.refId());
  const list = <T>(item: () => T): T[] => {
    const n = reader.vsval();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item());
    return out;
  };
  switch (type) {
    case 0x18: {
      const value = [ref(), ...reader.vec3()];
      reader.u32();
      return { value };
    }
    case 0x19: {
      const value = [ref(), ref()];
      reader.u32(); // the package's current procedure index
      reader.skip(3); // three flags
      return { value };
    }
    case 0x1a: {
      const value = ref();
      // A package the game made has its own data after the id.
      if (value >>> 24 === 0xff) throw new Unknown('a trespass package the game made');
      return { value };
    }
    case 0x1b:
      return {
        value: list(() => {
          const pack = ref();
          reader.u8();
          return pack;
        }),
      };
    case 0x1c:
    case 0x21:
    case 0x22:
    case 0x38:
    case 0x45:
    case 0x48:
    case 0x65:
    case 0x68:
    case 0x70:
    case 0x85:
    case 0x8e:
    case 0x92:
    case 0x9d:
    case 0xa4:
      return { value: ref() };
    case 0x1f:
    case 0x2c:
    case 0x49:
    case 0x4d:
    case 0x54:
    case 0x96:
    case 0x9c:
      return { value: reader.u8() };
    case 0x1e:
    case 0x53:
    case 0xa0:
      return { value: reader.u32() };
    case 0x23:
    case 0x5d:
      return { value: reader.i32() };
    case 0x25:
    case 0x27:
    case 0x28:
    case 0x2f:
    case 0x55:
    case 0x59:
      return { value: reader.f32() };
    case 0x24:
      return { value: reader.i16() };
    case 0x9f: {
      const owner = reader.u16();
      return { value: [owner, reader.u32()] };
    }
    case 0x2a: {
      // Lock: level, flags, key, then two more words.
      const level = reader.u8();
      const flags = reader.u8();
      const key = ref();
      reader.skip(8);
      return { value: [level, flags, key] };
    }
    case 0x2b: {
      // Teleport: the destination's position and rotation, a flag, the door.
      const position = reader.vec3();
      const rotation = reader.vec3();
      reader.u8();
      return { value: [ref(), ...position, ...rotation] };
    }
    case 0x2d: {
      // A leveled creature: its base and template, then the base's changes by their flags.
      const value = [ref(), ref()];
      const flags = reader.u32();
      if (flags & CHANGE_FORM_FLAGS) reader.skip(6);
      return { value, npc: readNpc(reader, flags, resolve) };
    }
    case 0x2e: {
      const value = reader.i32();
      reader.u8();
      return { value };
    }
    case 0x31:
      readCaster(reader, resolve);
      ref();
      ref();
      return {};
    case 0x32: {
      const value = ref();
      list(() => {
        ref();
        reader.u8();
        reader.vsval();
        reader.skip(reader.vsval());
      });
      return { value };
    }
    case 0x34:
      list(() => {
        reader.skip(8);
      });
      return {};
    case 0x3e:
    case 0x58:
    case 0x6a:
    case 0x95: {
      const value = ref();
      reader.u32();
      return { value };
    }
    case 0x44:
      return { value: list(() => reader.f32()) };
    case 0x4c:
      reader.wstring();
      reader.skip(5);
      return { value: [ref(), ref(), ref(), ref()] };
    case 0x4f:
      return { value: [reader.u8(), reader.u8()] };
    case 0x5b: {
      const factions = list(() => ({ faction: ref(), rank: reader.i8() }));
      const crimeFaction = ref();
      reader.u8();
      return { factions, value: crimeFaction };
    }
    case 0x5c:
      reader.skip(2 + 4 + 4 + 1);
      ref();
      list(() => {
        reader.skip(4);
        list(ref);
      });
      return {};
    case 0x6c:
      if (reader.u8() !== 0xff) throw new Unknown("a package's running data");
      return {};
    case 0x6f:
      return {
        value: list(() => {
          const info = ref();
          reader.skip(8);
          return info;
        }),
      };
    case 0x71: {
      const value = ref();
      reader.skip(5);
      ref();
      list(() => {
        reader.wstring();
        reader.wstring();
        reader.skip(9);
        ref();
        ref();
        ref();
        reader.u8();
      });
      reader.u16();
      for (let i = 0; i < 4; i++) ref();
      return { value };
    }
    case 0x78:
      list(() => {
        ref();
        reader.skip(5);
      });
      return {};
    case 0x87:
      reader.skip(12);
      ref();
      reader.u32();
      list(() => {
        reader.skip(12);
        ref();
        reader.skip(12);
        ref();
        reader.u8();
      });
      return {};
    case 0x88:
      // The aliases the reference fills: quest and alias id.
      return { value: list(() => [ref(), reader.u32()]).flat() };
    case 0x8c:
      return { value: list(ref) };
    case 0x98:
      list(() => {
        if (reader.refId() === 0) return;
        // TODO(M13): the arrow's transform is taken as 36 bytes (a 3x3 matrix).
        if (reader.u16() !== 0xffff) reader.skip(4 + 12 + 36 + 4);
      });
      reader.skip(4);
      return {};
    case 0x99: {
      const a = reader.refId();
      const b = reader.refId();
      const kind = reader.i32();
      if (a === 0 && b === 0 && kind === -2) return { value: kind, text: reader.wstring() };
      return { value: kind };
    }
    case 0x9b: {
      const value = ref();
      reader.u16();
      return { value };
    }
    case 0xa1:
      reader.skip(88);
      return {};
    case 0xa9:
      throw new Unknown('extra data type 0xa9 (interaction)');
    case 0xae:
      reader.u32();
      ref();
      reader.wstring();
      reader.wstring();
      reader.skip(32);
      return {};
    case 0xaf: {
      const n = reader.u32();
      for (let i = 0; i < n; i++) {
        ref();
        reader.u32();
      }
      return {};
    }
    case 0xb0:
      reader.skip(8);
      return {};
    default:
      return {}; // no data
  }
}

/** A magic caster's common part (22 bytes). */
function readCaster(reader: EssReader, resolve: RefIdResolver): void {
  reader.u32();
  resolve(reader.refId());
  reader.skip(8);
  resolve(reader.refId());
  reader.u32();
}

function readExtras(reader: EssReader, resolve: RefIdResolver): EssExtra[] {
  const count = reader.vsval();
  const extras: EssExtra[] = [];
  for (let i = 0; i < count; i++) {
    const type = reader.u8();
    const name = EXTRA_NAMES[type] ?? `0x${type.toString(16)}`;
    extras.push({ type, name, ...readExtra(reader, type, resolve) });
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
      let processLevel = -1;
      if (type === 1) {
        processLevel = reader.i32();
        reader.u32(); // the actor's state flags
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
      if (type === 1) {
        const actor: { -readonly [K in keyof EssActorData]: EssActorData[K] } = { processLevel };
        out.actor = actor;
        const stopped = readActor(reader, actor, out.formId === PLAYER_REF, resolve);
        if (stopped !== undefined) throw new Unknown(stopped);
      }
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
    } else if (type === 31) {
      formFlags();
      out.faction = readFaction(reader, flags, resolve);
    } else if (type >= 44 && type <= 46) {
      formFlags();
      if (has(ChangeBase.last)) {
        const added: { form: number; level: number; count: number }[] = [];
        const n = reader.u8();
        for (let i = 0; i < n; i++) {
          added.push({ form: resolve(reader.refId()), level: reader.u16(), count: reader.u16() });
        }
        out.leveledAdded = added;
      }
    } else {
      formFlags();
      // TODO(M13): the other base types' own flags (book teaches, ingredient use, form list
      // added forms, encounter zone and location data, ...): their layouts are not read yet;
      // what they hold is counted as undecoded.
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
  if (has(ChangeQuest.scriptDelay)) quest.scriptDelay = reader.f32();
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
  // The original writes nothing for the attributes flag.
  if (has(ChangeNpc.gender)) npc.female = reader.u8() === 1;
  if (has(ChangeNpc.defaultOutfit)) npc.defaultOutfit = resolve(reader.refId());
  if (has(ChangeNpc.sleepOutfit)) npc.sleepOutfit = resolve(reader.refId());
  return npc;
}

/** FACT's own change flags. */
export const ChangeFaction = {
  flags: bit(1),
  reactions: bit(2),
  crimeCounts: bit(31),
} as const;

function readFaction(reader: EssReader, flags: number, resolve: RefIdResolver): EssFactionChanges {
  const faction: { -readonly [K in keyof EssFactionChanges]: EssFactionChanges[K] } = {};
  if (flags & ChangeFaction.reactions) {
    const reactions: { faction: number; modifier: number; reaction: number }[] = [];
    const n = reader.vsval();
    for (let i = 0; i < n; i++) {
      const other = resolve(reader.refId());
      reactions.push({ faction: other, modifier: reader.i32(), reaction: reader.u32() });
    }
    faction.reactions = reactions;
  }
  if (flags & ChangeFaction.flags) faction.flags = reader.u32();
  if (flags & ChangeFaction.crimeCounts) {
    faction.crime = [reader.u32(), reader.u32(), reader.f32(), reader.u32()];
  }
  return faction;
}

/** The actor values an actor keeps its own modifier sets for: health, magicka, stamina, voice. */
const MODIFIED_VALUES = [24, 25, 26, 37] as const;
/** The number of actor values: an index past this is not one. */
const ACTOR_VALUE_COUNT = 164;

/**
 * An actor's own data after its reference data (docs/formats/ess.md "Actors"). Fills `actor` as
 * far as it reads and returns why it stopped, if it did.
 */
function readActor(
  reader: EssReader,
  actor: { -readonly [K in keyof EssActorData]: EssActorData[K] },
  player: boolean,
  resolve: RefIdResolver,
): string | undefined {
  const ref = (): number => resolve(reader.refId());
  if (actor.processLevel === -1) {
    reader.u8();
    reader.skip(13 * 4); // timers, counters and the time since its last update
    ref();
    reader.skip(18); // its state bits
    ref();
    const casters = reader.u8();
    for (let i = 0; i < 4; i++) {
      if ((casters & (1 << i)) === 0) continue;
      readCaster(reader, resolve);
      reader.u32();
      ref();
      reader.u32();
      reader.skip(reader.vsval()); // the caster's animation state
    }
    for (let i = 0; i < 5; i++) ref(); // the spells and the power in hand
  } else {
    // TODO(M13): the AI process's data has no decoded layout yet: the actor values that follow
    // it are found by their fixed shape (four modifier sets of three values) and taken where
    // the storage after them reads as actor values.
    const at = findActorValues(reader);
    if (at === undefined) return 'AI process data';
    reader.seek(at);
  }
  const values = readActorValues(reader);
  if (!values) return 'actor values';
  actor.values = values;
  const added: number[] = [];
  const n = reader.u32();
  for (let i = 0; i < n; i++) added.push(ref());
  actor.addedSpells = added;
  // TODO(M13): the movement controller's and the combat controller's data, when present.
  if (reader.u8() !== 0) return 'actor movement data';
  reader.u32();
  if (reader.u8() !== 0) return 'combat controller data';
  const entries = reader.u32();
  for (let i = 0; i < entries; i++) {
    ref();
    reader.u32();
  }
  reader.skip(8);
  ref();
  reader.u8();
  // TODO(M13): the player's own data follows the actor's.
  if (player && reader.remaining > 0) return 'player data';
  return undefined;
}

/** The four modifier sets and the actor value storage, or undefined where they do not fit. */
function readActorValues(reader: EssReader): EssActorValues | undefined {
  const modifiers: EssValueModifiers[] = [];
  for (const av of MODIFIED_VALUES) {
    if (reader.u32() !== 3) return undefined;
    const [permanent, temporary, damage] = reader.vec3();
    if (![permanent, temporary, damage].every(Number.isFinite)) return undefined;
    modifiers.push({ av, permanent, temporary, damage });
  }
  const valid = (av: number, ...numbers: number[]): boolean =>
    av >= 0 && av < ACTOR_VALUE_COUNT && numbers.every(Number.isFinite);
  const base: { av: number; value: number }[] = [];
  const n = reader.vsval();
  if (n > ACTOR_VALUE_COUNT) return undefined;
  for (let i = 0; i < n; i++) {
    const av = reader.i32();
    const value = reader.f32();
    if (!valid(av, value)) return undefined;
    base.push({ av, value });
  }
  const others: EssValueModifiers[] = [];
  const m = reader.vsval();
  if (m > ACTOR_VALUE_COUNT) return undefined;
  for (let i = 0; i < m; i++) {
    const av = reader.i32();
    const [permanent, temporary, damage] = reader.vec3();
    if (!valid(av, permanent, temporary, damage)) return undefined;
    others.push({ av, permanent, temporary, damage });
  }
  return { modifiers, base, others };
}

/** Where the actor values start after an AI process's data, found by their shape. */
function findActorValues(reader: EssReader): number | undefined {
  const start = reader.offset;
  const end = start + reader.remaining;
  const word = (at: number): number => {
    reader.seek(at);
    return reader.u32();
  };
  for (let at = start; at + 64 <= end; at++) {
    if (word(at) !== 3 || word(at + 16) !== 3 || word(at + 32) !== 3 || word(at + 48) !== 3) {
      continue;
    }
    reader.seek(at);
    try {
      if (readActorValues(reader)) return at;
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
    }
  }
  reader.seek(start);
  return undefined;
}
