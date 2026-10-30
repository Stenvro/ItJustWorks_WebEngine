// The global data tables of an .ess save (docs/formats/ess.md): table 1 (misc stats, player
// location, TES, global variables, created objects, effects, weather, audio, sky cells), table
// 2 (process lists to the menu topic manager: kept as bytes), table 3 (temp effects, Papyrus:
// papyrus.ts, anim objects, timer, synchronised animations, main). Reference ids are resolved
// with the save's form id array. Platform-independent.

import { essReader, resolveRefId, type EssSource, type RawRefId } from './ess-reader.ts';

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

export function readMiscStats(data: EssSource): MiscStat[] {
  const reader = essReader(data);
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
  /** A byte saves from form version 73 add (UESP: unknown); undefined in older saves. */
  readonly unknown?: number;
}

export function readPlayerLocation(data: EssSource, resolve: RefIdResolver): PlayerLocation {
  const reader = essReader(data);
  return {
    nextObjectId: reader.u32(),
    worldspace1: resolve(reader.refId()),
    coordX: reader.i32(),
    coordY: reader.i32(),
    worldspace2: resolve(reader.refId()),
    position: reader.vec3(),
    ...(reader.remaining > 0 && { unknown: reader.u8() }),
  };
}

export interface TesData {
  readonly unknown0: readonly { readonly formId: number; readonly unknown: number }[];
  /** A square table of reference ids (count2 x count2). */
  readonly unknown1: readonly number[];
  readonly unknown2: readonly number[];
}

export function readTes(data: EssSource, resolve: RefIdResolver): TesData {
  const reader = essReader(data);
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

export function readGlobalVariables(data: EssSource, resolve: RefIdResolver): Map<number, number> {
  const reader = essReader(data);
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

export function readCreatedObjects(data: EssSource, resolve: RefIdResolver): CreatedObjects {
  const reader = essReader(data);
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
  data: EssSource,
  resolve: RefIdResolver,
): { effects: ImageSpaceEffect[]; unknown1: number; unknown2: number } {
  const reader = essReader(data);
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

/** The sky's state (CommonLibSSE's Sky members, in the order the original writes them). */
export interface WeatherData {
  readonly climate: number;
  readonly weather: number;
  readonly previousWeather: number;
  /** The climate's default weather and a weather a script forced (ForceActive). */
  readonly defaultWeather: number;
  readonly overrideWeather: number;
  /** The region whose weather list was used. */
  readonly regionWeather: number;
  /** The game hour now, and when the weather last changed. */
  readonly currentTime: number;
  readonly beginTime: number;
  /** How far the transition to `weather` is (0..1). */
  readonly weatherPercent: number;
  /** The sky's flags, the last moon phase update (a day), three values the sky keeps. */
  readonly flags: number;
  readonly moonPhaseUpdate: number;
  readonly values: readonly number[];
  /** A u32 and the fog power the sky keeps, then its mode (0 none, 1 interior, 2 sky dome, 3 full). */
  readonly fogValue: number;
  readonly fogPower: number;
  readonly mode: number;
  /** The weathers' sky effects (visual effects with a model): whether the current and last have one. */
  readonly referenceEffects: readonly [boolean, boolean];
}

export function readWeather(data: EssSource, resolve: RefIdResolver): WeatherData {
  const reader = essReader(data);
  const ref = (): number => resolve(reader.refId());
  const forms = [ref(), ref(), ref(), ref(), ref(), ref()] as const;
  const [currentTime, beginTime, weatherPercent] = reader.vec3();
  const flags = reader.u32();
  const moonPhaseUpdate = reader.u32();
  const values = [reader.u32(), reader.u32(), reader.u32()];
  const fogValue = reader.u32();
  const fogPower = reader.f32();
  const mode = reader.u32();
  // Which of the current and last weather's sky effect follow (bits 1 and 2): each a model
  // reference effect as the temp effects write their type 9 (global-data-tables.ts).
  const effects = reader.u8();
  for (const bit of [1, 2]) if (effects & bit) skipModelReferenceEffect(reader);
  return {
    climate: forms[0],
    weather: forms[1],
    previousWeather: forms[2],
    defaultWeather: forms[3],
    overrideWeather: forms[4],
    regionWeather: forms[5],
    currentTime,
    beginTime,
    weatherPercent,
    flags,
    moonPhaseUpdate,
    values,
    fogValue,
    fogPower,
    mode,
    referenceEffects: [(effects & 1) !== 0, (effects & 2) !== 0],
  };
}

/**
 * A model reference effect's data: the temp effect's base (two floats, a byte, a u32), a byte,
 * the target, a byte and when set four references, then the art object and a sized block.
 */
function skipModelReferenceEffect(reader: ReturnType<typeof essReader>): void {
  reader.skip(4 + 4 + 1 + 4 + 1);
  reader.refId();
  if (reader.u8() !== 0) reader.skip(4 * 3);
  reader.refId();
  reader.skip(reader.vsval());
}

export function readAudio(
  data: EssSource,
  resolve: RefIdResolver,
): { unknown: number; tracks: number[]; music: number } {
  const reader = essReader(data);
  const unknown = resolve(reader.refId());
  const count = reader.vsval();
  const tracks: number[] = [];
  for (let i = 0; i < count; i++) tracks.push(resolve(reader.refId()));
  return { unknown, tracks, music: resolve(reader.refId()) };
}

export function readSkyCells(
  data: EssSource,
  resolve: RefIdResolver,
): { first: number; second: number }[] {
  const reader = essReader(data);
  const count = reader.vsval();
  const cells: { first: number; second: number }[] = [];
  for (let i = 0; i < count; i++) {
    cells.push({ first: resolve(reader.refId()), second: resolve(reader.refId()) });
  }
  return cells;
}

export function readAnimObjects(
  data: EssSource,
  resolve: RefIdResolver,
): { reference: number; animObject: number; unknown: number }[] {
  const reader = essReader(data);
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

export function readTimer(data: EssSource): { unknown1: number; unknown2: number } {
  const reader = essReader(data);
  return { unknown1: reader.u32(), unknown2: reader.u32() };
}

export interface SynchronizedAnimation {
  readonly unknown1: number;
  readonly unknown2: number;
  readonly actors: readonly { readonly reference: number; readonly name: string }[];
}

export function readSynchronizedAnimations(
  data: EssSource,
  resolve: RefIdResolver,
): SynchronizedAnimation[] {
  const reader = essReader(data);
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
