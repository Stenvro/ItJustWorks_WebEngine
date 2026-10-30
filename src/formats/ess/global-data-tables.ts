// The global data types of tables 2 and 3 that global-data.ts does not read: process lists
// (crimes) to the menu topic manager, temp effects and main (docs/formats/ess.md, "Global
// data"). Layouts after UESP's "Skyrim Mod:Save File Format" pages; their unnamed fields keep
// UESP's "unknown" as a name with a number. Built from the documented layout and tested by
// round trip; waiting on a real save to check against (TODO(M12)). Where the documentation
// stops (an undocumented temp effect type, the story event manager's entries, type 104), the
// rest is kept as bytes. Platform-independent.

import { EssReader, essReader, type EssSource } from './ess-reader.ts';
import {
  readAnimObjects,
  readAudio,
  readCreatedObjects,
  readEffects,
  readGlobalVariables,
  readMiscStats,
  readPlayerLocation,
  readSkyCells,
  readSynchronizedAnimations,
  readTes,
  readTimer,
  readWeather,
  type RefIdResolver,
} from './global-data.ts';
import { readCombatObject } from './combat.ts';
import { PathingStream } from './movement.ts';
import { readPapyrus } from './papyrus.ts';

type Vec3 = [number, number, number];

// --- 100 Process Lists ---------------------------------------------------------------------------

/** A crime the process lists keep (by type: theft, pickpocketing, trespassing, ...). */
export interface SavedCrime {
  readonly witnessNum: number;
  /** 0 theft, 1 pickpocketing, 2 trespassing, 3 assault, 4 murder, 5 (undocumented), 6 lycanthropy. */
  readonly crimeType: number;
  readonly unknown1: number;
  /** Stolen items (thefts). */
  readonly quantity: number;
  readonly serialNum: number;
  readonly unknown2: number;
  /** Possibly the crime's date (the low byte the day). */
  readonly unknown3: number;
  /** Negative: game time since the crime. */
  readonly elapsedTime: number;
  readonly victim: number;
  readonly criminal: number;
  readonly itemBase: number;
  readonly ownership: number;
  readonly witnesses: readonly number[];
  readonly bounty: number;
  readonly crimeFaction: number;
  /** 0 active, 1 atoned for. */
  readonly isCleared: number;
  readonly unknown4: number;
}

export interface ProcessLists {
  readonly unknown: Vec3;
  /** The serial number the next crime gets. */
  readonly nextNum: number;
  /** The crimes of each of the 7 types. */
  readonly crimes: readonly (readonly SavedCrime[])[];
}

export function readProcessLists(data: EssSource, resolve: RefIdResolver): ProcessLists {
  const reader = essReader(data);
  const unknown = reader.vec3();
  const nextNum = reader.u32();
  const crimes: SavedCrime[][] = [];
  for (let type = 0; type < 7; type++) {
    const count = reader.vsval();
    const list: SavedCrime[] = [];
    for (let i = 0; i < count; i++) {
      const witnessNum = reader.u32();
      const crimeType = reader.u32();
      const unknown1 = reader.u8();
      const quantity = reader.u32();
      const serialNum = reader.u32();
      const unknown2 = reader.u8();
      const unknown3 = reader.u32();
      const elapsedTime = reader.f32();
      const victim = resolve(reader.refId());
      const criminal = resolve(reader.refId());
      const itemBase = resolve(reader.refId());
      const ownership = resolve(reader.refId());
      const witnesses = refIds(reader, reader.vsval(), resolve);
      list.push({
        witnessNum,
        crimeType,
        unknown1,
        quantity,
        serialNum,
        unknown2,
        unknown3,
        elapsedTime,
        victim,
        criminal,
        itemBase,
        ownership,
        witnesses,
        bounty: reader.u32(),
        crimeFaction: resolve(reader.refId()),
        isCleared: reader.u8(),
        unknown4: reader.u16(),
      });
    }
    crimes.push(list);
  }
  return { unknown, nextNum, crimes };
}

function refIds(reader: EssReader, count: number, resolve: RefIdResolver): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(resolve(reader.refId()));
  return out;
}

function floats(reader: EssReader, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(reader.f32());
  return out;
}

function u32s(reader: EssReader, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(reader.u32());
  return out;
}

// --- 101 Combat ----------------------------------------------------------------------------------

/** A position with its cell (UESP's Position). */
export interface SavedPosition {
  readonly position: Vec3;
  readonly cell: number;
}

/** UESP's UnkStruct: two floats. */
type FloatPair = [number, number];

export interface CombatMember {
  readonly unknown0: number;
  readonly unknown1: number;
  readonly unknown2: number;
  readonly unknown3: number;
  readonly unknown4: number;
  readonly target: number;
  readonly positions: readonly SavedPosition[];
  readonly unknown5: readonly number[];
}

export interface CombatSearch {
  readonly unknown0: number;
  readonly pairs: readonly FloatPair[];
  readonly unknown1: number;
  readonly position: SavedPosition;
  readonly unknown2: number;
  readonly searchPoints: readonly {
    readonly position: SavedPosition;
    readonly unknown0: number;
    readonly unknown1: number;
  }[];
  readonly searchers: readonly {
    readonly unknown0: number;
    readonly unknown1: number;
    readonly flags: readonly [number, number, number];
  }[];
  readonly detail?: {
    readonly unknown0: number;
    readonly unknown1: number;
    readonly entries: readonly {
      readonly unknown0: number;
      readonly bytes: Uint8Array;
      readonly reference: number;
      readonly unknown1: number;
    }[];
    readonly reference0: number;
    readonly floats0: readonly number[];
    readonly reference1: number;
    readonly float1: number;
    readonly reference2: number;
    readonly unknown2: number;
    readonly unknown3: number;
    readonly unknown4: number;
    readonly floats1: readonly number[];
  };
}

/** A combat group (UESP's Unknown0). */
export interface SavedCombat {
  readonly unknown0: number;
  readonly serialNum: number;
  readonly members: readonly CombatMember[];
  readonly targets: readonly {
    readonly reference: number;
    readonly unknown0: number;
    readonly unknown1: number;
  }[];
  /** The 4 pairs, then the 11. */
  readonly pairs: readonly FloatPair[];
  readonly search?: CombatSearch;
  readonly pair0: FloatPair;
  readonly floats: readonly number[];
  readonly pair1: FloatPair;
  readonly unknown1: number;
}

export interface CombatData {
  readonly nextNum: number;
  readonly combats: readonly SavedCombat[];
  /**
   * The threats the combat AI keeps (UESP's Unknown1), as observed in the original: by form,
   * each a combat object (combat.ts's CombatThreat).
   */
  readonly threats: readonly number[];
  /** The threats' time stamp. */
  readonly unknown0: number;
  /** A count the original always writes as 0. */
  readonly unknown1: number;
  readonly references: readonly number[];
  readonly unknown2: number;
  readonly pair0: FloatPair;
  readonly pair1: FloatPair;
}

function position(reader: EssReader, resolve: RefIdResolver): SavedPosition {
  return { position: reader.vec3(), cell: resolve(reader.refId()) };
}

function pair(reader: EssReader): FloatPair {
  return [reader.f32(), reader.f32()];
}

export function readCombat(data: EssSource, resolve: RefIdResolver): CombatData {
  const reader = essReader(data);
  const nextNum = reader.u32();
  const combats: SavedCombat[] = [];
  for (let count = reader.vsval(), i = 0; i < count; i++) {
    const unknown0 = reader.u32();
    const serialNum = reader.u32();
    const members: CombatMember[] = [];
    for (let n = reader.vsval(), j = 0; j < n; j++) {
      const member = {
        unknown0: resolve(reader.refId()),
        unknown1: reader.u32(),
        unknown2: reader.f32(),
        unknown3: reader.u16(),
        unknown4: reader.u16(),
        target: resolve(reader.refId()),
        positions: [0, 1, 2, 3, 4].map(() => position(reader, resolve)),
        unknown5: floats(reader, 6),
      };
      members.push(member);
    }
    const targets: SavedCombat['targets'][number][] = [];
    for (let n = reader.vsval(), j = 0; j < n; j++) {
      targets.push({
        reference: resolve(reader.refId()),
        unknown0: reader.f32(),
        unknown1: reader.f32(),
      });
    }
    const pairs: FloatPair[] = [];
    for (let j = 0; j < 4 + 11; j++) pairs.push(pair(reader));
    const flag = reader.u32();
    const search = flag !== 0 ? readCombatSearch(reader, resolve) : undefined;
    combats.push({
      unknown0,
      serialNum,
      members,
      targets,
      pairs,
      ...(search && { search }),
      pair0: pair(reader),
      floats: floats(reader, 4),
      pair1: pair(reader),
      unknown1: reader.u8(),
    });
  }
  // The threats: a form and its combat object each (written through the combat AI's stream,
  // which writes each object once).
  const stream = new PathingStream(reader, resolve);
  const threats: number[] = [];
  for (let count = reader.vsval(), i = 0; i < count; i++) {
    threats.push(resolve(reader.refId()));
    readCombatObject(stream);
  }
  const unknown0 = reader.f32();
  const unknown1 = reader.vsval();
  const references = refIds(reader, reader.vsval(), resolve);
  return {
    nextNum,
    combats,
    threats,
    unknown0,
    unknown1,
    references,
    unknown2: reader.f32(),
    pair0: pair(reader),
    pair1: pair(reader),
  };
}

function readCombatSearch(reader: EssReader, resolve: RefIdResolver): CombatSearch {
  const unknown0 = resolve(reader.refId());
  const pairs = [pair(reader), pair(reader)];
  const unknown1 = reader.f32();
  const at = position(reader, resolve);
  const unknown2 = reader.f32();
  const searchPoints: CombatSearch['searchPoints'][number][] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    searchPoints.push({
      position: position(reader, resolve),
      unknown0: reader.u32(),
      unknown1: reader.f32(),
    });
  }
  const searchers: CombatSearch['searchers'][number][] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    searchers.push({
      unknown0: resolve(reader.refId()),
      unknown1: resolve(reader.refId()),
      flags: [reader.u8(), reader.u8(), reader.u8()],
    });
  }
  const search = { unknown0, pairs, unknown1, position: at, unknown2, searchPoints, searchers };
  if (reader.u8() === 0) return search;
  const detail0 = reader.u32();
  const detail1 = reader.u32();
  const entries: NonNullable<CombatSearch['detail']>['entries'][number][] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    const unknown = reader.u8();
    const bytes = reader.bytes(reader.u32()).slice();
    entries.push({
      unknown0: unknown,
      bytes,
      reference: resolve(reader.refId()),
      unknown1: reader.u32(),
    });
  }
  return {
    ...search,
    detail: {
      unknown0: detail0,
      unknown1: detail1,
      entries,
      reference0: resolve(reader.refId()),
      floats0: floats(reader, 5),
      reference1: resolve(reader.refId()),
      float1: reader.f32(),
      reference2: resolve(reader.refId()),
      unknown2: reader.u16(),
      unknown3: reader.u8(),
      unknown4: reader.u8(),
      floats1: floats(reader, 2),
    },
  };
}

// --- 102 Interface -------------------------------------------------------------------------------

export interface InterfaceData {
  /** Help messages already shown (ids of the tutorial messages). */
  readonly shownHelpMessages: readonly number[];
  readonly unknown0: number;
  readonly lastUsedWeapons: readonly number[];
  readonly lastUsedSpells: readonly number[];
  readonly lastUsedShouts: readonly number[];
  readonly unknown1: number;
  /** Present "in certain situations" (UESP): read when bytes are left. */
  readonly extra?: {
    readonly entries: readonly {
      readonly name0: string;
      readonly name1: string;
      readonly values: readonly number[];
    }[];
    readonly names: readonly string[];
    readonly unknown: number;
  };
}

export function readInterface(data: EssSource, resolve: RefIdResolver): InterfaceData {
  const reader = essReader(data);
  const shownHelpMessages = u32s(reader, reader.u32());
  const unknown0 = reader.u8();
  const lastUsedWeapons = refIds(reader, reader.vsval(), resolve);
  const lastUsedSpells = refIds(reader, reader.vsval(), resolve);
  const lastUsedShouts = refIds(reader, reader.vsval(), resolve);
  const unknown1 = reader.u8();
  const base = {
    shownHelpMessages,
    unknown0,
    lastUsedWeapons,
    lastUsedSpells,
    lastUsedShouts,
    unknown1,
  };
  if (reader.remaining === 0) return base;
  const entries: NonNullable<InterfaceData['extra']>['entries'][number][] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    entries.push({ name0: reader.wstring(), name1: reader.wstring(), values: u32s(reader, 4) });
  }
  const names: string[] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) names.push(reader.wstring());
  return { ...base, extra: { entries, names, unknown: reader.u32() } };
}

// --- 103 Actor Causes, 105 Detection Manager, 106 Location MetaData ---------------------------

export interface ActorCauses {
  readonly nextNum: number;
  readonly causes: readonly {
    readonly position: Vec3;
    readonly serialNum: number;
    readonly actor: number;
  }[];
}

export function readActorCauses(data: EssSource, resolve: RefIdResolver): ActorCauses {
  const reader = essReader(data);
  const nextNum = reader.u32();
  const causes: ActorCauses['causes'][number][] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    causes.push({
      position: reader.vec3(),
      serialNum: reader.u32(),
      actor: resolve(reader.refId()),
    });
  }
  return { nextNum, causes };
}

export function readDetectionManager(
  data: EssSource,
  resolve: RefIdResolver,
): { reference: number; unknown0: number; unknown1: number }[] {
  const reader = essReader(data);
  const out: { reference: number; unknown0: number; unknown1: number }[] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    out.push({
      reference: resolve(reader.refId()),
      unknown0: reader.u32(),
      unknown1: reader.u32(),
    });
  }
  return out;
}

export function readLocationMetaData(
  data: EssSource,
  resolve: RefIdResolver,
): { location: number; unknown: number }[] {
  const reader = essReader(data);
  const out: { location: number; unknown: number }[] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    out.push({ location: resolve(reader.refId()), unknown: reader.u32() });
  }
  return out;
}

// --- 107 Quest Static Data -----------------------------------------------------------------------

/** UESP's QuestRunDataItem3Data: type 1, 2, 4 a reference, 3 a number. */
export interface QuestRunDataValue {
  readonly type: number;
  readonly value: number;
}

/** UESP's QuestRunDataItem3: a quest's run data (story manager event data). */
export interface QuestRunData {
  readonly unknown1: number;
  readonly unknown2: number;
  readonly values: readonly QuestRunDataValue[];
}

export interface QuestStaticData {
  readonly runData0: readonly QuestRunData[];
  readonly runData1: readonly QuestRunData[];
  readonly references2: readonly number[];
  readonly references3: readonly number[];
  readonly references4: readonly number[];
  readonly quests: readonly {
    readonly quest: number;
    readonly values: readonly { readonly unknown0: number; readonly unknown1: number }[];
  }[];
  /** Always 1 in the saves UESP looked at. */
  readonly unknown6: number;
}

export function readQuestRunData(reader: EssReader, resolve: RefIdResolver): QuestRunData {
  const unknown1 = reader.u32();
  const unknown2 = reader.f32();
  const values: QuestRunDataValue[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    const type = reader.u32();
    values.push({ type, value: type === 3 ? reader.u32() : resolve(reader.refId()) });
  }
  return { unknown1, unknown2, values };
}

export function readQuestStaticData(data: EssSource, resolve: RefIdResolver): QuestStaticData {
  const reader = essReader(data);
  const runs = (): QuestRunData[] => {
    const out: QuestRunData[] = [];
    for (let n = reader.u32(), i = 0; i < n; i++) out.push(readQuestRunData(reader, resolve));
    return out;
  };
  const runData0 = runs();
  const runData1 = runs();
  const references2 = refIds(reader, reader.u32(), resolve);
  const references3 = refIds(reader, reader.u32(), resolve);
  const references4 = refIds(reader, reader.u32(), resolve);
  const quests: QuestStaticData['quests'][number][] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    const quest = resolve(reader.refId());
    const values: { unknown0: number; unknown1: number }[] = [];
    for (let k = reader.vsval(), j = 0; j < k; j++) {
      values.push({ unknown0: reader.u32(), unknown1: reader.u32() });
    }
    quests.push({ quest, values });
  }
  return {
    runData0,
    runData1,
    references2,
    references3,
    references4,
    quests,
    unknown6: reader.u8(),
  };
}

// --- 108 to 114 ----------------------------------------------------------------------------------

/** 108 StoryTeller: a flag (0 or 1). */
export function readStoryTeller(data: EssSource): { flag: number } {
  return { flag: essReader(data).u8() };
}

/** 109 Magic Favorites: favourited spells, shouts and powers, and the hotkeyed ones by key. */
export function readMagicFavorites(
  data: EssSource,
  resolve: RefIdResolver,
): { favorites: number[]; hotkeys: number[] } {
  const reader = essReader(data);
  const favorites = refIds(reader, reader.vsval(), resolve);
  return { favorites, hotkeys: refIds(reader, reader.vsval(), resolve) };
}

/** 110 PlayerControls. */
export function readPlayerControls(data: EssSource): {
  unknown0: number;
  unknown1: number;
  unknown2: number;
  unknown3: number;
  unknown4: number;
} {
  const reader = essReader(data);
  return {
    unknown0: reader.u8(),
    unknown1: reader.u8(),
    unknown2: reader.u8(),
    unknown3: reader.u16(),
    unknown4: reader.u8(),
  };
}

/** 111 Story Event Manager: its entries' format is undocumented, kept as bytes. */
export function readStoryEventManager(data: EssSource): {
  unknown: number;
  count: number;
  entries: Uint8Array;
} {
  const reader = essReader(data);
  const unknown = reader.u32();
  const count = reader.vsval();
  // TODO(M12): the entries' layout (UESP: possibly the quest static data's run data).
  return { unknown, count, entries: reader.bytes(reader.remaining).slice() };
}

/** 112 Ingredient Shared: the ingredient pairs alchemy found to share no effect. */
export function readIngredientShared(data: EssSource, resolve: RefIdResolver): [number, number][] {
  const reader = essReader(data);
  const out: [number, number][] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    out.push([resolve(reader.refId()), resolve(reader.refId())]);
  }
  return out;
}

/** 113 MenuControls. */
export function readMenuControls(data: EssSource): { unknown0: number; unknown1: number } {
  const reader = essReader(data);
  return { unknown0: reader.u8(), unknown1: reader.u8() };
}

/** 114 MenuTopicManager: two references. */
export function readMenuTopicManager(
  data: EssSource,
  resolve: RefIdResolver,
): { unknown0: number; unknown1: number } {
  const reader = essReader(data);
  return { unknown0: resolve(reader.refId()), unknown1: resolve(reader.refId()) };
}

// --- 1000 Temp Effects ---------------------------------------------------------------------------

/** UESP's Unknown0 of the temp effects. */
export interface TempEffectEntry {
  readonly flag: number;
  readonly reference0: number;
  readonly unknown0?: number;
  readonly reference1: number;
  readonly reference2: number;
  readonly vector0: Vec3;
  readonly vector1: Vec3;
  readonly floats0: readonly number[];
  readonly quaternion: readonly number[];
  readonly bytes0: readonly number[];
  readonly float1: number;
  readonly byte1: number;
  readonly floats2: readonly number[];
  readonly bytes2: readonly number[];
  readonly unknown1: number;
}

/** UESP's Unknown1_Def: the base of every temp effect. */
export interface TempEffectBase {
  readonly unknown0: number;
  readonly unknown1: number;
  readonly unknown2: number;
  readonly unknown3: number;
}

/** A temp effect by type (UESP's Unknown1); an undocumented type ends the read. */
export type TempEffect =
  | { readonly type: 1 | 3 | 4 | 5 | 7; readonly base: TempEffectBase }
  | {
      readonly type: 0;
      readonly base: TempEffectBase;
      readonly values0: readonly number[];
      readonly values1: readonly number[];
      readonly bytes: Uint8Array;
      readonly name: string;
      readonly reference0: number;
      readonly reference1: number;
      readonly unknown: number;
    }
  | {
      readonly type: 6;
      readonly base: TempEffectBase;
      readonly reference: number;
      readonly unknown0: number;
      readonly unknown1: number;
      readonly unknown2: number;
    }
  | ({ readonly type: 8 } & TempEffect8)
  | {
      readonly type: 9;
      readonly effect: TempEffect8;
      readonly reference: number;
      /** UESP's Unknown1_9_0, sized by its own length. */
      readonly data: Uint8Array;
    }
  | {
      readonly type: 10;
      readonly effect: TempEffect8;
      readonly floats: readonly number[];
      readonly unknown0: number;
      readonly reference0: number;
      readonly reference1: number;
      readonly unknown1: number;
    }
  | {
      readonly type: 11;
      readonly effect: TempEffect8;
      readonly reference: number;
      readonly unknown0: number;
      readonly values: readonly number[];
      readonly data: Uint8Array;
    };

/** UESP's Unknown1_8, also the start of types 9 to 11. */
export interface TempEffect8 {
  readonly base: TempEffectBase;
  readonly unknown: number;
  readonly reference: number;
  readonly references?: readonly number[];
}

export interface TempEffects {
  readonly entries: readonly TempEffectEntry[];
  readonly unknown: number;
  readonly effects1: readonly TempEffect[];
  readonly effects2: readonly TempEffect[];
  readonly effects3: readonly TempEffect[];
  /** Set when an undocumented effect type stopped the read: the type and the bytes left. */
  readonly unread?: { readonly type: number; readonly bytes: Uint8Array };
}

export function readTempEffects(data: EssSource, resolve: RefIdResolver): TempEffects {
  const reader = essReader(data);
  const entries: TempEffectEntry[] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    const flag = reader.u8();
    const reference0 = resolve(reader.refId());
    const unknown0 = flag !== 0 ? reader.u32() : undefined;
    entries.push({
      flag,
      reference0,
      ...(unknown0 !== undefined && { unknown0 }),
      reference1: resolve(reader.refId()),
      reference2: resolve(reader.refId()),
      vector0: reader.vec3(),
      vector1: reader.vec3(),
      floats0: floats(reader, 3),
      quaternion: floats(reader, 4),
      bytes0: [reader.u8(), reader.u8(), reader.u8(), reader.u8()],
      float1: reader.f32(),
      byte1: reader.u8(),
      floats2: floats(reader, 5),
      bytes2: [reader.u8(), reader.u8()],
      unknown1: reader.u32(),
    });
  }
  const unknown = reader.u32();
  let unread: TempEffects['unread'];
  const list = (): TempEffect[] => {
    const out: TempEffect[] = [];
    if (unread) return out;
    for (let n = reader.vsval(), i = 0; i < n; i++) {
      const type = reader.u32();
      const effect = readTempEffect(reader, type, resolve);
      if (!effect) {
        // TODO(M12): temp effect types 2 and above 11 are undocumented.
        unread = { type, bytes: reader.bytes(reader.remaining).slice() };
        break;
      }
      out.push(effect);
    }
    return out;
  };
  // Observed in the original: three lists of the process lists' temp effects (UESP knows two),
  // each a vsval count of (type u32, the effect's data).
  const effects1 = list();
  const effects2 = list();
  const effects3 = list();
  return { entries, unknown, effects1, effects2, effects3, ...(unread && { unread }) };
}

function readTempEffectBase(reader: EssReader): TempEffectBase {
  return {
    unknown0: reader.f32(),
    unknown1: reader.f32(),
    unknown2: reader.u8(),
    unknown3: reader.u32(),
  };
}

function readTempEffect8(reader: EssReader, resolve: RefIdResolver): TempEffect8 {
  const base = readTempEffectBase(reader);
  const unknown = reader.u8();
  const reference = resolve(reader.refId());
  const flag = reader.u8();
  return {
    base,
    unknown,
    reference,
    ...(flag !== 0 && { references: refIds(reader, 4, resolve) }),
  };
}

/** UESP's Unknown1_9_0: a vsval length and that many bytes. */
function sizedBlock(reader: EssReader): Uint8Array {
  return reader.bytes(reader.vsval()).slice();
}

function readTempEffect(
  reader: EssReader,
  type: number,
  resolve: RefIdResolver,
): TempEffect | undefined {
  switch (type) {
    case 1:
    case 3:
    case 4:
    case 5:
    case 7:
      return { type, base: readTempEffectBase(reader) };
    case 0:
      return {
        type,
        base: readTempEffectBase(reader),
        values0: u32s(reader, 4),
        values1: u32s(reader, 3),
        bytes: reader.bytes(12).slice(),
        name: reader.wstring(),
        reference0: resolve(reader.refId()),
        reference1: resolve(reader.refId()),
        unknown: reader.u32(),
      };
    case 6:
      return {
        type,
        base: readTempEffectBase(reader),
        reference: resolve(reader.refId()),
        unknown0: reader.u32(),
        unknown1: reader.u32(),
        unknown2: reader.u8(),
      };
    case 8:
      return { type, ...readTempEffect8(reader, resolve) };
    case 9:
      return {
        type,
        effect: readTempEffect8(reader, resolve),
        reference: resolve(reader.refId()),
        data: sizedBlock(reader),
      };
    case 10:
      return {
        type,
        effect: readTempEffect8(reader, resolve),
        floats: floats(reader, 4),
        unknown0: reader.u32(),
        reference0: resolve(reader.refId()),
        reference1: resolve(reader.refId()),
        unknown1: reader.u32(),
      };
    case 11:
      return {
        type,
        effect: readTempEffect8(reader, resolve),
        reference: resolve(reader.refId()),
        unknown0: reader.u8(),
        values: u32s(reader, 3),
        data: sizedBlock(reader),
      };
    default:
      return undefined;
  }
}

// --- 104 and 1005 Main ---------------------------------------------------------------------------

/** 104: undocumented; kept as bytes (TODO(M12): its layout, from a real save). */
export function readUnknown104(data: EssSource): Uint8Array {
  const reader = essReader(data);
  return reader.bytes(reader.remaining).slice();
}

/** 1005 Main: always empty (UESP); the table 3 count leaves it out, so the game never reads it. */
export function readMain(data: EssSource): { empty: boolean; bytes: Uint8Array } {
  const reader = essReader(data);
  const bytes = reader.bytes(reader.remaining).slice();
  return { empty: bytes.length === 0, bytes };
}

/** The reader of every global data type (the save's three tables), by type number. */
export const GLOBAL_DATA_READERS: Readonly<
  Record<number, (data: EssSource, resolve: RefIdResolver) => unknown>
> = {
  0: (data) => readMiscStats(data),
  1: readPlayerLocation,
  2: readTes,
  3: readGlobalVariables,
  4: readCreatedObjects,
  5: readEffects,
  6: readWeather,
  7: readAudio,
  8: readSkyCells,
  100: readProcessLists,
  101: readCombat,
  102: readInterface,
  103: readActorCauses,
  104: (data) => readUnknown104(data),
  105: readDetectionManager,
  106: readLocationMetaData,
  107: readQuestStaticData,
  108: (data) => readStoryTeller(data),
  109: readMagicFavorites,
  110: (data) => readPlayerControls(data),
  111: (data) => readStoryEventManager(data),
  112: readIngredientShared,
  113: (data) => readMenuControls(data),
  114: readMenuTopicManager,
  1000: readTempEffects,
  1001: (data) => {
    const reader = essReader(data);
    return readPapyrus(reader.bytes(reader.remaining));
  },
  1002: readAnimObjects,
  1003: (data) => readTimer(data),
  1004: readSynchronizedAnimations,
  1005: (data) => readMain(data),
};

/** A global data entry read by its type's reader: what it read, and the bytes it left. */
export interface GlobalDataRead {
  readonly value: unknown;
  /** Bytes after where the reader stopped (0: read to its end). */
  readonly unread: number;
}

/** Reads a global data entry with its type's reader (undefined: no reader for the type). */
export function readGlobalData(
  type: number,
  data: Uint8Array,
  resolve: RefIdResolver,
): GlobalDataRead | undefined {
  // Papyrus says itself what it left.
  if (type === 1001) {
    const papyrus = readPapyrus(data);
    return { value: papyrus, unread: papyrus.unread };
  }
  const read = GLOBAL_DATA_READERS[type];
  if (!read) return undefined;
  const reader = new EssReader(data);
  return { value: read(reader, resolve), unread: reader.remaining };
}
