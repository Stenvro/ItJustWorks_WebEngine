// The global data tables of an .ess save (docs/formats/ess.md): table 1 (misc stats, player
// location, TES, global variables, created objects, effects, weather, audio, sky cells), table
// 2 (process lists to the menu topic manager: kept as bytes), table 3 (temp effects, Papyrus:
// papyrus.ts, anim objects, timer, synchronised animations, main). Reference ids are resolved
// with the save's form id array. Platform-independent.

import { EssReader, resolveRefId, type RawRefId } from './ess-reader.ts';

/** The global data types by number (UESP). */
export const GLOBAL_DATA_TYPES: Readonly<Record<number, string>> = {
  0: 'Misc Stats',
  1: 'Player Location',
  2: 'TES',
  3: 'Global Variables',
  4: 'Created Objects',
  5: 'Effects',
  6: 'Weather',
  7: 'Audio',
  8: 'Sky Cells',
  100: 'Process Lists',
  101: 'Combat',
  102: 'Interface',
  103: 'Actor Causes',
  104: 'Unknown 104',
  105: 'Detection Manager',
  106: 'Location MetaData',
  107: 'Quest Static Data',
  108: 'StoryTeller',
  109: 'Magic Favorites',
  110: 'PlayerControls',
  111: 'Story Event Manager',
  112: 'Ingredient Shared',
  113: 'MenuControls',
  114: 'MenuTopicManager',
  1000: 'Temp Effects',
  1001: 'Papyrus',
  1002: 'Anim Objects',
  1003: 'Timer',
  1004: 'Synchronized Animations',
  1005: 'Main',
};

export function globalDataName(type: number): string {
  return GLOBAL_DATA_TYPES[type] ?? `type ${String(type)}`;
}

/** Resolves raw reference ids (0 when of unknown kind or out of the array). */
export type RefIdResolver = (raw: RawRefId) => number;

export function refIdResolver(formIds: ArrayLike<number>): RefIdResolver {
  return (raw) => resolveRefId(raw, formIds) ?? 0;
}

export interface MiscStat {
  readonly name: string;
  /** 0 general, 1 quest, 2 combat, 3 magic, 4 crafting, 5 crime, 6 DLC. */
  readonly category: number;
  readonly value: number;
}

export function readMiscStats(data: Uint8Array): MiscStat[] {
  const reader = new EssReader(data);
  const count = reader.u32();
  const stats: MiscStat[] = [];
  for (let i = 0; i < count; i++) {
    stats.push({ name: reader.wstring(), category: reader.u8(), value: reader.i32() });
  }
  return stats;
}

export interface PlayerLocation {
  readonly nextObjectId: number;
  readonly worldspace1: number;
  readonly coordX: number;
  readonly coordY: number;
  readonly worldspace2: number;
  readonly position: [number, number, number];
}

export function readPlayerLocation(data: Uint8Array, resolve: RefIdResolver): PlayerLocation {
  const reader = new EssReader(data);
  return {
    nextObjectId: reader.u32(),
    worldspace1: resolve(reader.refId()),
    coordX: reader.i32(),
    coordY: reader.i32(),
    worldspace2: resolve(reader.refId()),
    position: reader.vec3(),
  };
}

export interface TesData {
  readonly unknown0: readonly { readonly formId: number; readonly unknown: number }[];
  /** A square table of reference ids (count2 x count2). */
  readonly unknown1: readonly number[];
  readonly unknown2: readonly number[];
}

export function readTes(data: Uint8Array, resolve: RefIdResolver): TesData {
  const reader = new EssReader(data);
  const unknown0: { formId: number; unknown: number }[] = [];
  const count0 = reader.vsval();
  for (let i = 0; i < count0; i++) {
    unknown0.push({ formId: resolve(reader.refId()), unknown: reader.u16() });
  }
  const count1 = reader.u32();
  const unknown1: number[] = [];
  for (let i = 0; i < count1 * count1; i++) unknown1.push(resolve(reader.refId()));
  const count2 = reader.vsval();
  const unknown2: number[] = [];
  for (let i = 0; i < count2; i++) unknown2.push(resolve(reader.refId()));
  return { unknown0, unknown1, unknown2 };
}

export function readGlobalVariables(data: Uint8Array, resolve: RefIdResolver): Map<number, number> {
  const reader = new EssReader(data);
  const globals = new Map<number, number>();
  const count = reader.vsval();
  for (let i = 0; i < count; i++) globals.set(resolve(reader.refId()), reader.f32());
  return globals;
}

export interface CreatedEffect {
  readonly effect: number;
  readonly magnitude: number;
  readonly duration: number;
  readonly area: number;
  readonly price: number;
}

export interface CreatedEnchantment {
  readonly formId: number;
  readonly timesUsed: number;
  readonly effects: readonly CreatedEffect[];
}

export interface CreatedObjects {
  readonly weaponEnchantments: readonly CreatedEnchantment[];
  readonly armourEnchantments: readonly CreatedEnchantment[];
  readonly potions: readonly CreatedEnchantment[];
  readonly poisons: readonly CreatedEnchantment[];
}

export function readCreatedObjects(data: Uint8Array, resolve: RefIdResolver): CreatedObjects {
  const reader = new EssReader(data);
  const table = (): CreatedEnchantment[] => {
    const count = reader.vsval();
    const out: CreatedEnchantment[] = [];
    for (let i = 0; i < count; i++) {
      const formId = resolve(reader.refId());
      const timesUsed = reader.u32();
      const effectCount = reader.vsval();
      const effects: CreatedEffect[] = [];
      for (let j = 0; j < effectCount; j++) {
        effects.push({
          effect: resolve(reader.refId()),
          magnitude: reader.f32(),
          duration: reader.u32(),
          area: reader.u32(),
          price: reader.f32(),
        });
      }
      out.push({ formId, timesUsed, effects });
    }
    return out;
  };
  return {
    weaponEnchantments: table(),
    armourEnchantments: table(),
    potions: table(),
    poisons: table(),
  };
}

export interface ImageSpaceEffect {
  readonly strength: number;
  readonly timestamp: number;
  readonly unknown: number;
  readonly effect: number;
}

export function readEffects(
  data: Uint8Array,
  resolve: RefIdResolver,
): { effects: ImageSpaceEffect[]; unknown1: number; unknown2: number } {
  const reader = new EssReader(data);
  const count = reader.vsval();
  const effects: ImageSpaceEffect[] = [];
  for (let i = 0; i < count; i++) {
    effects.push({
      strength: reader.f32(),
      timestamp: reader.f32(),
      unknown: reader.u32(),
      effect: resolve(reader.refId()),
    });
  }
  return { effects, unknown1: reader.f32(), unknown2: reader.f32() };
}

export interface WeatherData {
  readonly climate: number;
  readonly weather: number;
  readonly previousWeather: number;
  readonly unknownWeather1: number;
  readonly unknownWeather2: number;
  readonly regionWeather: number;
  /** The game hour now, and when the transition began. */
  readonly currentTime: number;
  readonly beginTime: number;
  /** How far the transition to `weather` is (0..1). */
  readonly weatherPercent: number;
  /** The rest (UESP: partly unknown), kept as bytes. */
  readonly rest: Uint8Array;
}

export function readWeather(data: Uint8Array, resolve: RefIdResolver): WeatherData {
  const reader = new EssReader(data);
  return {
    climate: resolve(reader.refId()),
    weather: resolve(reader.refId()),
    previousWeather: resolve(reader.refId()),
    unknownWeather1: resolve(reader.refId()),
    unknownWeather2: resolve(reader.refId()),
    regionWeather: resolve(reader.refId()),
    currentTime: reader.f32(),
    beginTime: reader.f32(),
    weatherPercent: reader.f32(),
    rest: reader.bytes(reader.remaining),
  };
}

export function readAudio(
  data: Uint8Array,
  resolve: RefIdResolver,
): { unknown: number; tracks: number[]; music: number } {
  const reader = new EssReader(data);
  const unknown = resolve(reader.refId());
  const count = reader.vsval();
  const tracks: number[] = [];
  for (let i = 0; i < count; i++) tracks.push(resolve(reader.refId()));
  return { unknown, tracks, music: resolve(reader.refId()) };
}

export function readSkyCells(
  data: Uint8Array,
  resolve: RefIdResolver,
): { first: number; second: number }[] {
  const reader = new EssReader(data);
  const count = reader.vsval();
  const cells: { first: number; second: number }[] = [];
  for (let i = 0; i < count; i++) {
    cells.push({ first: resolve(reader.refId()), second: resolve(reader.refId()) });
  }
  return cells;
}

export function readAnimObjects(
  data: Uint8Array,
  resolve: RefIdResolver,
): { reference: number; animObject: number; unknown: number }[] {
  const reader = new EssReader(data);
  const count = reader.u32();
  const objects: { reference: number; animObject: number; unknown: number }[] = [];
  for (let i = 0; i < count; i++) {
    objects.push({
      reference: resolve(reader.refId()),
      animObject: resolve(reader.refId()),
      unknown: reader.u8(),
    });
  }
  return objects;
}

export function readTimer(data: Uint8Array): { unknown1: number; unknown2: number } {
  const reader = new EssReader(data);
  return { unknown1: reader.u32(), unknown2: reader.u32() };
}

export interface SynchronizedAnimation {
  readonly unknown1: number;
  readonly unknown2: number;
  readonly actors: readonly { readonly reference: number; readonly name: string }[];
}

export function readSynchronizedAnimations(
  data: Uint8Array,
  resolve: RefIdResolver,
): SynchronizedAnimation[] {
  const reader = new EssReader(data);
  const count = reader.u32();
  const out: SynchronizedAnimation[] = [];
  for (let i = 0; i < count; i++) {
    const unknown1 = reader.u32();
    const unknown2 = reader.u32();
    const actorCount = reader.u32();
    const actors: { reference: number; name: string }[] = [];
    for (let j = 0; j < actorCount; j++) {
      actors.push({ reference: resolve(reader.refId()), name: reader.wstring() });
    }
    out.push({ unknown1, unknown2, actors });
  }
  return out;
}
