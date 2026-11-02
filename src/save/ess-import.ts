// Import of the original's saves (.ess, docs/formats/ess.md "Import"): what the parser reads
// (src/formats/ess) put into our own save (game-save.ts), so it loads through the same path:
// the plugins read as for a new game, then this state applied. Form ids are moved from the
// save's load order to ours by plugin name. What has no place yet is listed, by change form
// type and flag, for the log. Platform-independent.

import {
  CHANGE_FORM_FLAGS,
  ChangeBase,
  ChangeCell,
  ChangeFaction,
  ChangeNpc,
  ChangeQuest,
  ChangeRefr,
  FormFlag,
  QuestFlag,
  readChangeForm,
  type EssActorValues,
  type EssChangeForm,
  type EssExtra,
  type EssInventoryEntry,
  type EssNpcChanges,
  type EssSceneChanges,
} from '../formats/ess/change-forms.ts';
import { changeFormTypeName, globalData, type EssFile } from '../formats/ess/ess.ts';
import {
  readAnimObjects,
  readAudio,
  readGlobalVariables,
  readMiscStats,
  readPlayerLocation,
  readWeather,
  refIdResolver,
  type RefIdResolver,
} from '../formats/ess/global-data.ts';
import {
  PapyrusType,
  readPapyrus,
  type EssGameHandle,
  type EssObject,
  type EssPapyrus,
  type EssVariable,
} from '../formats/ess/papyrus.ts';
import {
  readActorCauses,
  readCombat,
  readGlobalData,
  readInterface,
  readMagicFavorites,
  readQuestStaticData,
  readStoryEventManager,
  readTempEffects,
  StoryParameterKind,
  type SavedCombat,
  type SavedStoryEvent,
  type TempEffectEntry,
} from '../formats/ess/global-data-tables.ts';
import type { EssPlayerData, EssTintMask } from '../formats/ess/player.ts';
import type { EssProcedureState } from '../formats/ess/process.ts';
import type {
  SavedFrame,
  SavedInstance,
  SavedThread,
  ThreadWait,
} from '../scripting/papyrus-vm.ts';
import type { Hand } from '../gameplay/equipment.ts';
import {
  GameState,
  type ActorValueState,
  type ItemStack,
  type ReferenceState,
} from '../scripting/runtime/game-state.ts';
import {
  gameStateData,
  type RuntimeSave,
  type SavedUpdate,
} from '../scripting/runtime/runtime-save.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import type { StoryEventData } from '../scripting/runtime/story-manager.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../scripting/values.ts';
import { CELL_SIZE } from '../world/land.ts';
import { parseScene } from '../ai/scene-records.ts';
import type { SavedScene } from '../ai/scene-runtime.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { FACE_MORPH_COUNT } from '../world/chargen-records.ts';
import { savedDecalBox, subtextureRect } from '../world/decal.ts';
import { seenFromSave } from '../world/seen-data.ts';
import type { SkySave } from '../world/sky-weather.ts';
import { cellKey } from '../world/worldspace.ts';
import type { GameSave } from './game-save.ts';
import { SAVE_VERSION, type SaveHeader } from './save-codec.ts';
import type {
  SavedActor,
  SavedAnimObject,
  SavedAttachedArrow,
  SavedDecal,
  SavedGraphs,
  SavedFight,
  SavedPlayer,
} from './world-save.ts';
import {
  readAnimationGraphs,
  type EssAnimationGraph,
  type EssAnimationGraphs,
} from '../formats/ess/animation-graphs.ts';
import type { ActorGraphState } from '../animation/behavior-runtime.ts';

/** GameState's open states (ReferenceState.openState): open, closed. */
const OPEN_STATE_OPEN = 1;
const OPEN_STATE_CLOSED = 3;

/**
 * A place as a 4x4 matrix (column-major): a translation, a rotation (a unit quaternion x, y,
 * z, w) and a uniform scale.
 */
export function placeMatrix(
  [x, y, z]: readonly [number, number, number],
  [qx, qy, qz, qw]: readonly [number, number, number, number],
  scale: number,
): number[] {
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;
  const s = scale;
  return [
    (1 - 2 * (yy + zz)) * s,
    2 * (xy + wz) * s,
    2 * (xz - wy) * s,
    0,
    2 * (xy - wz) * s,
    (1 - 2 * (xx + zz)) * s,
    2 * (yz + wx) * s,
    0,
    2 * (xz + wy) * s,
    2 * (yz - wx) * s,
    (1 - 2 * (xx + yy)) * s,
    0,
    x,
    y,
    z,
    1,
  ];
}

/**
 * An original save's graph as ours keeps an actor's: its nodes and words by names (found as
 * the graph's files are reached), its quad variables as vectors.
 */
export function actorGraphState(graph: EssAnimationGraph): ActorGraphState {
  return {
    files: [],
    variables: [],
    ...(graph.quads.length > 0 && { vectors: graph.quads }),
    named: {
      machines: graph.machines.map((machine) => [machine.graph, machine.node, machine.stateId]),
      clips: graph.clips.map((clip) => [clip.graph, clip.node, clip.time]),
      sequences: graph.generators.map((clip) => [clip.graph, clip.node, clip.time]),
      words: graph.words,
    },
  };
}

const PLAYER_REF = 0x14;
const PLAYER_BASE = 0x7;
const GAME_DAYS_PASSED = 0x39;
/** The first skill's actor value (OneHanded); DNAM's 18 skills follow in actor value order. */
const FIRST_SKILL_AV = 6;
const HEALTH_AV = 24;
/**
 * An actor's life state (CommonLibSSE ACTOR_LIFE_STATE), the fifth of its saved state bytes:
 * the executed prisoners and the opening's dead read 2, the living 0. TODO(M13): the other
 * values seen on a save (6 on actors a script restrains; 3 not seen yet).
 */
/** A scene's phase word when none runs yet. */
const NO_PHASE = 0xffffffff;
const LifeState = { alive: 0, dying: 1, dead: 2, unconscious: 3, restrained: 6 } as const;
/** ACBS's flags (UESP NPC_): those scripts set on a base. */
const ActorBaseFlag = { essential: 0x2, protected: 0x800, invulnerable: 0x80000000 } as const;
/** A cell's flags as its change form keeps them (its record's DATA has the same 0x20). */
const CellFlag = { publicArea: 0x20 } as const;

/** A loaded plugin's place in our load order (RecordDatabase plugins' entries). */
export interface PluginSlot {
  readonly name: string;
  readonly modIndex: number;
  readonly lightIndex?: number | undefined;
}

/** Where a placed reference's record puts it: its cell (an interior) or worldspace. */
export interface RecordPlace {
  readonly cell?: number | undefined;
  readonly world?: number | undefined;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
}

/** What the importer needs of our world: the load order and records' types. */
export interface EssWorld {
  readonly plugins: readonly PluginSlot[];
  /** A record's type ("CELL", "WRLD", "FACT", ...) by our form id. */
  recordType(formId: number): string | undefined;
  /**
   * An actor's place as its record has it, by our form id (the actors the save keeps where
   * their records stand: it writes no place for them).
   */
  recordPlace?(formId: number): RecordPlace | undefined;
  /** A scene's quest and the aliases of its actors, by our form id (the scenes the save plays). */
  sceneCast?(formId: number): SceneCast | undefined;
}

/** A scene's quest, the aliases of its actors and its actions' indices, in its record's order. */
export interface SceneCast {
  readonly quest: number;
  readonly aliases: readonly number[];
  readonly actions: readonly number[];
}

/**
 * A scene action's state as the save keeps it (its record's order): a u32 (a dialogue's or a
 * timer's seconds as a float), a timer's two bytes, then two flags: running, and done. As read
 * on the saves: package actions that run on done (1, 1), lines said (0, 1), packages running
 * (1, 0), actions not begun (0, 0). TODO(M13): the u32 as a looping line's wait and a timer's
 * seconds left is inferred from one save's value (1.75).
 */
function sceneAction(
  index: number,
  action: EssSceneChanges['actions'][number],
): SavedScene['actions'][number] {
  const { values } = action;
  const running = (values.at(-2) ?? 0) !== 0;
  const done = (values.at(-1) ?? 0) !== 0;
  const bits = new DataView(new ArrayBuffer(4));
  bits.setUint32(0, values[0] ?? 0, true);
  const seconds = bits.getFloat32(0, true);
  return {
    index,
    status: running ? 'running' : done ? 'ended' : 'waiting',
    complete: done,
    left: Number.isFinite(seconds) && seconds > 0 && seconds < 3600 ? seconds : 0,
  };
}

/**
 * The branch a running package's tree had reached, as our saved packages keep it (SavedPackage
 * path: each branch's index among its parent's children, from the root down), from its procedure
 * states: a Sequence's, Stacked's and Random's u32 is the index of the child it runs (in the
 * saves read, every one of some 3,300 names a child, whose procedure the child's state names:
 * SitSleep for Sit and Sleep, DialogueActivate for ForceGreet); of a Simultaneous branch's
 * children, the first that runs (ours goes down one).
 */
export function procedurePath(state: EssProcedureState | undefined): number[] {
  const path: number[] = [];
  for (let at = state; at && path.length < 32;) {
    if (at.index !== undefined) {
      path.push(at.index);
      at = at.child;
      continue;
    }
    const first = at.children?.find((child) => child.state);
    if (!first) break;
    path.push(first.index);
    at = first.state;
  }
  return path;
}

/**
 * The procedures (not the branches) a running package's tree runs, from the root down, with
 * those each runs inside it (a Sandbox's activity, SitSleep's Activate, a Patrol's furniture).
 */
export function procedureStates(state: EssProcedureState | undefined): EssProcedureState[] {
  if (!state) return [];
  if (state.index !== undefined || state.children) {
    return [
      ...procedureStates(state.child),
      ...(state.children ?? []).flatMap((child) => procedureStates(child.state)),
    ];
  }
  return [state, ...(state.nested ?? []).flatMap((inner) => procedureStates(inner))];
}

/**
 * The furniture a SitSleep goes to and enters (its Activate's reference, in the save's load
 * order). Seated, the SitSleep keeps no Activate (in the saves read, every actor sitting sits on
 * a vehicle or a horse, which ours keeps apart). TODO(M13): where the original keeps the
 * furniture an actor sits in once its Activate is done.
 */
function furnitureOf(procedures: readonly EssProcedureState[]): number | undefined {
  const at = procedures.findIndex((state) => state.name === 'SitSleep');
  const activate = at < 0 ? undefined : procedures.slice(at + 1).find((s) => s.name === 'Activate');
  const furniture = activate?.refs?.[0];
  return furniture === 0 ? undefined : furniture;
}

/**
 * An actor's state bits as its change form writes them (18 bytes; ActorState's fields one a
 * byte, as observed in the original): the third is its sit and sleep state (CommonLibSSE's
 * SIT_SLEEP_STATE), the fifth its life state, the thirteenth its weapon's (WEAPON_STATE).
 * TODO(M13): the other bytes (the first's movement bits: 0x41 walking, 0x81 running, as read).
 */
const StateByte = { sitSleep: 2, life: 4, weapon: 12 } as const;
/** SIT_SLEEP_STATE values of an actor in its furniture: entering it, sitting, sleeping. */
const IN_FURNITURE = new Set([2, 3, 7, 8]);
/** WEAPON_STATE values of a weapon out: drawing, drawn. */
const WEAPON_OUT = new Set([2, 3]);

const seated = (bits: Uint8Array | undefined): boolean =>
  IN_FURNITURE.has(bits?.[StateByte.sitSleep] ?? 0);
const weaponDrawn = (bits: Uint8Array | undefined): boolean =>
  WEAPON_OUT.has(bits?.[StateByte.weapon] ?? 0);

/**
 * The change flag each extra data type is written under, as the saves read have them (every
 * extra of a type comes with its flag); the rest are the game's own (gameOnlyExtra).
 */
const EXTRA_FLAG: Readonly<Record<string, number>> = {
  Ownership: ChangeRefr.ownershipExtra,
  Lock: ChangeRefr.lockExtra,
  ReferenceHandle: ChangeRefr.itemExtraData,
  EncounterZone: ChangeRefr.encounterZoneExtra,
  PromotedRef: ChangeRefr.promoted,
  LeveledCreature: ChangeRefr.leveledActor,
  PackageStartLocation: ChangeRefr.packageExtraData,
  Follower: ChangeRefr.packageExtraData,
  Package: ChangeRefr.packageExtraData,
  PackageData: ChangeRefr.packageExtraData,
  DismemberedLimbs: ChangeRefr.dismemberedLimbs,
};
const EXTRA_FLAGS = [...new Set(Object.values(EXTRA_FLAG))];

/** The change flag an extra comes with (an actor's merchant container bit is not the lock's). */
function extraFlag(name: string, actor: boolean): number {
  const flag = EXTRA_FLAG[name] ?? ChangeRefr.gameOnlyExtra;
  return actor && (flag === ChangeRefr.lockExtra || flag === ChangeRefr.itemExtraData)
    ? ChangeRefr.gameOnlyExtra
    : flag;
}

/**
 * An inventory entry's extra data ours keeps (applyItemExtras) or that follows from what is
 * kept: its count, the leveled list or outfit it came from, its unique id, the quest aliases
 * holding it (a quest item, its reference: QUST runtime data), an alias's name for it.
 */
const ITEM_EXTRAS_KEPT = new Set([
  'Count',
  'Worn',
  'WornLeft',
  'Health',
  'Charge',
  'Soul',
  'Poison',
  'OutfitItem',
  'LeveledItem',
  'UniqueID',
  'AliasInstanceArray',
  'FromAlias',
  'ReferenceHandle',
]);

/** The change flags that write a reference's place into its change form. */
const MOVED = ChangeRefr.moved | ChangeRefr.havokMoved | ChangeRefr.cellChanged;

/**
 * Our world as the importer needs it, from the record database. Given the save, the places of
 * its actors that stand where their records put them are read ahead (the import is not async).
 */
export async function essWorld(db: RecordDatabase, ess?: EssFile): Promise<EssWorld> {
  const plugins = db.plugins.map((plugin) => plugin.entry);
  const places = new Map<number, RecordPlace>();
  const casts = new Map<number, SceneCast>();
  if (ess) {
    const toOurs = formIdMapper(ess, plugins);
    const actors = ess.changeForms.flatMap((entry) => {
      if (entry.type !== 1 || entry.changeFlags & MOVED || entry.formId === undefined) return [];
      const id = toOurs(entry.formId);
      return id === undefined || id >>> 24 === 0xff ? [] : [id];
    });
    await Promise.all(
      actors.map(async (formId) => {
        const record = await db.get(formId);
        const data = record?.fields.first('DATA');
        const cell = db.cellOfReference(formId);
        if (!data || data.length < 24 || cell === undefined) return;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const f = (at: number): number => view.getFloat32(at, true);
        const world = db.worldOfCell(cell);
        places.set(formId, {
          ...(world === undefined ? { cell } : { world }),
          position: [f(0), f(4), f(8)],
          rotation: [f(12), f(16), f(20)],
        });
      }),
    );
    // The scenes it plays: their quests and actors.
    const scenes = ess.changeForms.flatMap((entry) => {
      const id = entry.type === 37 && entry.formId !== undefined ? toOurs(entry.formId) : undefined;
      return id === undefined ? [] : [id];
    });
    await Promise.all(
      scenes.map(async (formId) => {
        const record = await db.get(formId);
        if (!record) return;
        const scene = parseScene(record);
        if (scene.quest === undefined) return;
        casts.set(formId, {
          quest: scene.quest,
          aliases: scene.actors.map((actor) => actor.alias),
          actions: scene.actions.map((action) => action.index),
        });
      }),
    );
  }
  return {
    plugins,
    recordType: (formId) => {
      const at = db.locate(formId);
      return at ? db.typeAt(at) : undefined;
    },
    recordPlace: (formId) => places.get(formId),
    sceneCast: (formId) => casts.get(formId),
  };
}

export interface EssImportRequest {
  readonly name: string;
  readonly number: number;
  readonly now: number;
}

export interface EssImport {
  readonly header: SaveHeader;
  readonly save: GameSave;
  /** What was not imported, counted ("ACHR: actor data x 40"), for the log. */
  readonly skipped: readonly string[];
}

/**
 * The decals of the temp effects' entries (global data 1000; docs/formats/ess.md "Temp
 * effects") as the world's decal store keeps them: each on its reference (flag 0) or the land of
 * its cell (flag 1), its box from the point, the rotation and the width, height and depth in
 * that space, the subtexture its first byte names, the face limit its floats keep (the cosine
 * of the impact's angle threshold: cos 80° on every burn). An entry repeated for each shape it
 * was made on (the same decal: the u32 after it differs) is taken once. The save writes no age:
 * each lasts a whole lifetime from the load (TODO(M13)), and the second texture set (none in
 * the saves read) and the other values are not used (TODO(M13)).
 */
export function essTempDecals(
  entries: readonly TempEffectEntry[],
  ours: (formId: number) => number | undefined,
): SavedDecal[] {
  const decals: SavedDecal[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([
      entry.flag,
      entry.reference0,
      entry.reference1,
      entry.vector0,
      entry.quaternion,
      entry.floats0,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    const on = entry.reference0 === 0 ? undefined : ours(entry.reference0);
    const textureSet = entry.reference1 === 0 ? undefined : ours(entry.reference1);
    if (on === undefined || textureSet === undefined) continue;
    decals.push({
      textureSet,
      on: entry.flag !== 0 ? { cell: on } : { reference: on },
      box: Array.from(savedDecalBox(entry.vector0, entry.quaternion, entry.floats0)),
      rect: subtextureRect(entry.bytes0[0] ?? 255, 0),
      faceLimit: entry.floats2[1] ?? 0.01,
    });
  }
  return decals;
}

/** An AI time stamp the save never set (−FLT_MAX). */
const NEVER = -3e38;

/**
 * What a combat group of the save knew of each of its targets (global data 101; docs/formats/
 * ess.md "Combat groups"), as the fight its members take up again keeps it (SavedFight, by
 * our target): the stealth points, known (flag 1) or lost (flag 2), the last known place with
 * its time stamp (the first place and the third time) and the place it attacked from (the
 * fourth and the fifth), the times as seconds before the save; and the group's search for the
 * target it searches, from its place. TODO(M13): the detection's own place and time (taken as
 * the last known ones while it is known), the other places and times, the search's points,
 * doors and the time it has searched (none in the saves read: it searches from its start).
 */
export function essGroupFights(
  group: SavedCombat,
  ours: (formId: number) => number | undefined,
): Map<number, SavedFight> {
  const fights = new Map<number, SavedFight>();
  const search = group.search;
  const searched = search && search.unknown0 !== 0 ? ours(search.unknown0) : undefined;
  const at = search?.position.position;
  const searchAt: readonly [number, number, number] | undefined = at && [at[0], at[1], at[2]];
  for (const entry of group.targets) {
    const target = ours(entry.reference);
    if (!target) continue;
    const place = (
      index: number,
      time: number | undefined,
    ): readonly [number, number, number] | undefined => {
      const at = entry.positions[index];
      return at && at.cell !== 0 && time !== undefined && time > NEVER
        ? [at.position[0], at.position[1], at.position[2]]
        : undefined;
    };
    const ago = (time: number | undefined): number | undefined =>
      time !== undefined && time > NEVER ? Math.max(0, -time) : undefined;
    const known = (entry.flags & 1) !== 0;
    const lastKnown = place(0, entry.times[2]);
    const attackedAt = place(3, entry.times[4]);
    fights.set(target, {
      known: {
        stealthPoints: entry.stealthPoints,
        known,
        lost: (entry.flags & 2) !== 0,
        searching: search !== undefined,
        ...(lastKnown && { lastKnown, lastKnownAgo: ago(entry.times[2]) }),
        ...(known && lastKnown && { detectedAt: lastKnown, detectedAgo: ago(entry.times[2]) }),
        ...(attackedAt && { attackedAt, attackedAgo: ago(entry.times[4]) }),
      },
      ...(search &&
        searchAt &&
        searched === target && {
          search: {
            at: searchAt,
            phase: 'go',
            left: 0,
            looks: 0,
            elapsed: 0,
            first: true,
            atPlace: true,
            target: searchAt,
            ...(search.unknown2 > 0 && { radius: search.unknown2 }),
          },
        }),
    });
  }
  return fights;
}

/** Moves form ids from the save's load order into ours (undefined: its plugin is not loaded). */
export function formIdMapper(
  ess: Pick<EssFile, 'plugins' | 'lightPlugins'>,
  plugins: readonly PluginSlot[],
): (formId: number) => number | undefined {
  const byName = new Map(plugins.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  const regular = ess.plugins.map((name) => byName.get(name.toLowerCase()));
  const light = ess.lightPlugins.map((name) => byName.get(name.toLowerCase()));
  const place = (slot: PluginSlot | undefined, formId: number): number | undefined => {
    if (!slot) return undefined;
    return slot.lightIndex === undefined
      ? ((slot.modIndex << 24) | (formId & 0xffffff)) >>> 0
      : (0xfe000000 | (slot.lightIndex << 12) | (formId & 0xfff)) >>> 0;
  };
  return (formId) => {
    if (formId === 0) return 0;
    const top = formId >>> 24;
    if (top === 0xff) return formId;
    if (top === 0xfe) return place(light[(formId >>> 12) & 0xfff], formId);
    return place(regular[top], formId);
  };
}

/** Counts what was skipped by its reason. */
class Skips {
  readonly #counts = new Map<string, number>();

  add(what: string): void {
    this.#counts.set(what, (this.#counts.get(what) ?? 0) + 1);
  }

  lines(): string[] {
    return [...this.#counts].map(([what, count]) =>
      count > 1 ? `${what} x ${String(count)}` : what,
    );
  }
}

/** The change flags' names for the log, by change form type (others by bit number). */
const names = (flags: Readonly<Record<string, number>>): Record<number, string> =>
  Object.fromEntries(Object.entries(flags).map(([name, bit]) => [bit, name]));
/** The actor flags share bits with reference ones: ACHR names them its way. */
const ACTOR_FLAGS = new Set(['lifeState', 'packageExtraData', 'merchantContainer']);
const REFERENCE_NAMES = names(
  Object.fromEntries(Object.entries(ChangeRefr).filter(([name]) => !ACTOR_FLAGS.has(name))),
);
const FLAG_NAMES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  REFR: REFERENCE_NAMES,
  ACHR: names(ChangeRefr),
  NPC_: names(ChangeNpc),
  QUST: names(ChangeQuest),
  FACT: names(ChangeFaction),
};

/** A change flag's name as the import logs it (by change form type; else "flag 0x..."). */
export function flagName(type: string, bit: number): string {
  const table = FLAG_NAMES[type] ?? (/^P[A-Z]{3}$/.test(type) ? REFERENCE_NAMES : undefined);
  return table?.[bit] ?? `flag 0x${bit.toString(16)}`;
}

/** Imports a read .ess into our save. */
export function importEss(ess: EssFile, world: EssWorld, request: EssImportRequest): EssImport {
  const skips = new Skips();
  const toOurs = formIdMapper(ess, world.plugins);
  const missing = new Set<string>();
  const ours = (formId: number): number | undefined => {
    const id = toOurs(formId);
    if (id === undefined) {
      const top = formId >>> 24;
      missing.add(
        top === 0xfe
          ? (ess.lightPlugins[(formId >>> 12) & 0xfff] ?? '?')
          : (ess.plugins[top] ?? '?'),
      );
    }
    return id;
  };
  const resolve: RefIdResolver = refIdResolver(ess.formIds);
  const state = new GameState();
  const stats = new Map<string, number>();
  const inventoryDeltas = new Map<number, Map<number, number>>();
  const formListAdded = new Map<number, number[]>();
  const updates: SavedUpdate[] = [];
  const saidOnce = new Set<number>();
  const scenesPlaying: [number, EssSceneChanges][] = [];
  /** The player's face (their NPC_'s face and sex, their tint masks), put together at the end. */
  let face: EssNpcChanges['face'];
  let female: boolean | undefined;
  let tints: readonly EssTintMask[] = [];
  /** The actors with the package each ran (and whom it fought), where the save has them. */
  const savedActors: SavedActor[] = [];
  let savedPlayer: SavedPlayer | undefined;
  /** The actors' graphs (by actor) and the player's: they go on as they are placed. */
  const actorGraphs = new Map<number, ActorGraphState>();
  let playerGraphs: SavedGraphs | undefined;
  /** The arrows stuck in actors (their AttachedArrows3D extra data). */
  const attachedArrows: SavedAttachedArrow[] = [];
  /** The map markers whose flags the save keeps (shown, travel to). */
  const mapMarkers = new Map<number, { visible: boolean; travel: boolean }>();
  /** Where actors' packages started, and the packages they ran once, for their saved actors. */
  const packageStarts = new Map<number, readonly [number, number, number]>();
  const ranOnce = new Map<number, number[]>();
  /** What actors wear and hold beside their outfits (the Worn extra data), by actor. */
  const worn = new Map<number, [number, Hand | undefined][]>();
  /** The horse each rider rides (the rider's Interaction extra data). */
  const riding = new Map<number, number>();
  /** The actor causes (global data 103): the actor each serial number blames. */
  const causes = new Map<number, number>();
  const causeData = globalData(ess, 103);
  if (causeData) {
    try {
      for (const cause of readActorCauses(causeData, resolve).causes) {
        const actor = ours(cause.actor);
        if (actor) causes.set(cause.serialNum, actor);
      }
    } catch {
      skips.add('actor causes: unreadable');
    }
  }

  /**
   * A story event as ours (story-manager.ts): its members numbered by kind in their order (R1,
   * L1, K1, V1, ...), and the started quest's OnStory arguments in that order.
   * TODO(M13): the arguments' order checked on the events other than Script Event (SCPT).
   */
  const storyEvent = (saved: SavedStoryEvent): StoryEventData => {
    const forms = new Map<string, number>();
    const values = new Map<string, number>();
    const counts = new Map<number, number>();
    const args: Value[] = [];
    const letter = ['R', 'F', 'L', 'V', 'K'] as const;
    const handleType = ['objectreference', 'form', 'location', '', 'keyword'] as const;
    for (const { kind, value } of saved.parameters) {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      const key = `${letter[kind] ?? 'F'}${String(n)}`;
      if (kind === StoryParameterKind.value) {
        values.set(key, value);
        args.push(value);
        continue;
      }
      const id = value === 0 ? undefined : ours(value);
      if (id !== undefined && id !== 0) forms.set(key, id);
      args.push(id ? new ObjectHandle(id, handleType[kind] ?? 'form') : null);
    }
    return { type: saved.type, forms, values, args };
  };

  // The combat groups (global data 101): a target that attacked a member fights it, for one
  // whose own combat controller names no target (ours puts the groups together again as their
  // members fight); and each member's fight takes what its group knew of the target and the
  // search it made for it (SavedFight). TODO(M13): the groups' timers, the members' threats,
  // the search's points, doors and time searched.
  const groupTargets = new Map<number, number>();
  const groupKnowledge = new Map<number, Map<number, SavedFight>>();
  const combatData = globalData(ess, 101);
  if (combatData) {
    try {
      for (const group of readCombat(combatData, resolve).combats) {
        for (const entry of group.targets) {
          const actor = ours(entry.reference);
          const target = ours(entry.attackedMember);
          if (actor && target) groupTargets.set(actor, target);
        }
        for (const [target, fight] of essGroupFights(group, ours)) {
          for (const member of group.members) {
            const actor = ours(member.reference);
            if (!actor) continue;
            const known = groupKnowledge.get(actor) ?? new Map<number, SavedFight>();
            known.set(target, fight);
            groupKnowledge.set(actor, known);
          }
        }
      }
    } catch {
      skips.add('combat: unreadable');
    }
  }

  // Global variables, the clock.
  const globals = globalData(ess, 3);
  if (globals) {
    for (const [formId, value] of readGlobalVariables(globals, resolve)) {
      const id = ours(formId);
      if (id === undefined) continue;
      state.globals.set(id, value);
      if (id === GAME_DAYS_PASSED) state.gameDaysPassed = value;
    }
  }
  const misc = globalData(ess, 0);
  if (misc) for (const stat of readMiscStats(misc)) stats.set(stat.name, stat.value);

  // Where the player stands: the player's change form, else the player location table.
  let player: Placement | undefined;
  const location = globalData(ess, 1);
  if (location) {
    const at = readPlayerLocation(location, resolve);
    const worldspace = ours(at.worldspace1);
    if (worldspace) {
      player = {
        position: at.position,
        rotation: [0, 0, 0],
        cell: undefined,
        world: worldspace,
        scale: 1,
      };
    }
  }

  const placeOf = (cellOrWorld: number): { cell?: number; world?: number } => {
    const id = ours(cellOrWorld);
    if (id === undefined) return {};
    return world.recordType(id) === 'WRLD' ? { world: id } : { cell: id };
  };

  for (const entry of ess.changeForms) {
    const typeName = changeFormTypeName(entry.type);
    let form: EssChangeForm;
    try {
      form = readChangeForm(entry, resolve);
    } catch (error) {
      skips.add(
        `${typeName}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (form.stoppedAt !== undefined) skips.add(`${typeName}: ${form.stoppedAt}`);
    const formId = ours(form.formId);
    if (formId === undefined) continue;
    let applied = 0;
    const flags = form.changeFlags;

    if (entry.type <= 5 || (entry.type >= 40 && entry.type <= 42)) {
      applied |= applyReference(form, formId);
    } else if (typeName === 'PARW') {
      applied |= applyArrow(form, formId);
    } else if (entry.type === 8 && form.quest) {
      const quest = state.quest(formId);
      const q = form.quest;
      if (q.flags !== undefined) {
        quest.running = (q.flags & QuestFlag.enabled) !== 0;
        quest.completed = (q.flags & QuestFlag.completed) !== 0;
        quest.failed = (q.flags & QuestFlag.failed) !== 0;
        quest.active = (q.flags & QuestFlag.active) !== 0;
        if (quest.running || quest.completed) quest.starts = 1;
        applied |= ChangeQuest.flags;
      }
      if (q.stages) {
        for (const stage of q.stages) if (stage.done) quest.stagesDone.add(stage.stage);
        // TODO(M13): the current stage itself is not in the stages list; the highest done.
        quest.stage = Math.max(0, ...quest.stagesDone);
        applied |= ChangeQuest.stages;
      }
      if (q.objectives) {
        // The objective's state (CommonLibSSE QUEST_OBJECTIVE_STATE): 1 displayed, 2 completed,
        // 3 completed and displayed, 4 failed, 5 failed and displayed.
        for (const objective of q.objectives) {
          quest.objectives.set(objective.index, {
            displayed: (objective.status & 1) !== 0,
            completed: objective.status === 2 || objective.status === 3,
            failed: objective.status === 4 || objective.status === 5,
          });
        }
        applied |= ChangeQuest.objectives;
      }
      if (q.aliases) {
        for (const alias of q.aliases) {
          const reference = ours(alias.reference);
          if (reference) quest.aliases.set(alias.id, reference);
        }
        applied |= ChangeQuest.runtimeData;
      }
      // The story event that started it (its conditions and aliases read its data).
      if (q.event) quest.event = storyEvent(q.event);
      if (q.instances) {
        // Its run's data: the text display globals' values it holds (its texts show them);
        // its aliases' references are its runtime data's (applied above) while it runs.
        for (const run of q.instances.instances) {
          for (const { global, value } of run.globals) {
            const id = ours(global);
            if (id) (quest.instanceGlobals ??= new Map()).set(id, value);
          }
        }
        applied |= ChangeQuest.instanceData;
      }
      if (q.alreadyRun !== undefined) applied |= ChangeQuest.alreadyRun;
      if (q.scriptDelay !== undefined) applied |= ChangeQuest.scriptDelay;
    } else if (entry.type === 9 && form.npc) {
      // The player's factions and skills are their actor's (applyPlayerBase); their base's AI
      // data as any base's.
      if (formId === PLAYER_BASE) {
        applied |= applyPlayerBase(form);
        if (form.npc.aiData) applied |= applyBaseChanges(formId, { aiData: form.npc.aiData });
      } else applied |= applyBaseChanges(formId, form.npc);
      // ACBS's flags a script set (SetEssential, SetProtected, SetInvulnerable) and the
      // outfits (SetOutfit), on the base.
      const npc = form.npc;
      if (npc.baseData && npc.baseData.length >= 4) {
        const acbs = new DataView(npc.baseData.buffer, npc.baseData.byteOffset, 4).getUint32(
          0,
          true,
        );
        const base = state.actorBase(formId);
        base.essential = (acbs & ActorBaseFlag.essential) !== 0;
        base.protected = (acbs & ActorBaseFlag.protected) !== 0;
        base.invulnerable = (acbs & ActorBaseFlag.invulnerable) !== 0;
        applied |= ChangeNpc.baseData;
      }
      for (const [outfit, key] of [
        [npc.defaultOutfit, 'outfit'],
        [npc.sleepOutfit, 'sleepOutfit'],
      ] as const) {
        const id = outfit === undefined ? undefined : ours(outfit);
        if (id === undefined) continue;
        state.actorBase(formId)[key] = id;
        applied |= key === 'outfit' ? ChangeNpc.defaultOutfit : ChangeNpc.sleepOutfit;
      }
    } else if (entry.type >= 44 && entry.type <= 46 && form.leveledAdded) {
      // LVLN, LVLI, LVSP: the entries scripts added (AddForm).
      const added = form.leveledAdded.flatMap(({ form: item, level, count }) => {
        const id = ours(item);
        return id === undefined ? [] : [{ level, formId: id, count }];
      });
      state.leveledAdditions.set(formId, added);
      applied |= ChangeBase.last;
    } else if (entry.type === 31 && form.faction?.reactions) {
      // FACT: its reactions to other factions as they stand (the record's list with what
      // SetReaction, ModReaction, SetAlly and SetEnemy changed): the modifier and the group
      // combat reaction, as ours keeps scripts' (they win over the record's XNAM).
      // TODO(M13): its flags (bit 1) and crime counts (bit 31), whose meaning is not known.
      const faction = state.faction(formId);
      for (const { faction: other, modifier, reaction } of form.faction.reactions) {
        const id = ours(other);
        if (id === undefined || id === 0) continue;
        faction.reactionModifiers.set(id, modifier);
        faction.reactions.set(id, reaction);
      }
      applied |= ChangeFaction.reactions;
    } else if (entry.type === 6) {
      applied |= applyCell(form, formId);
    } else if (entry.type === 13 && flags & ChangeBase.bookRead) {
      state.booksRead.add(formId);
      applied |= ChangeBase.bookRead;
    } else if (entry.type === 37 && form.base?.scene) {
      // SCEN: a scene that plays, put together once the quests' aliases are read (below).
      if (form.base.scene.playing) scenesPlaying.push([formId, form.base.scene]);
      applied |= ChangeBase.last;
    } else if (entry.type === 7 && flags & ChangeBase.last) {
      // INFO: said (its Say Once mark; the mark matters to those infos alone).
      saidOnce.add(formId);
      applied |= ChangeBase.last;
    } else if (entry.type === 38 && flags & (ChangeBase.last | ChangeBase.locationKeywordData)) {
      // LCTN: cleared, and the values scripts set on its keywords (SetKeywordData).
      if (flags & ChangeBase.last) {
        state.location(formId).cleared = true;
        state.location(formId).everCleared = true;
        applied |= ChangeBase.last;
      }
      const keywordData = form.base?.location?.keywordData;
      if (keywordData) {
        const values = state.location(formId).keywordData;
        for (const { keyword, value } of keywordData) {
          const id = ours(keyword);
          if (id) values.set(id, value);
        }
        applied |= ChangeBase.locationKeywordData;
      }
    } else if (form.base?.formListAdded) {
      // FLST: the forms scripts added (AddForm), in the order they were added.
      const added: number[] = [];
      for (const item of form.base.formListAdded) {
        const id = ours(item);
        if (id !== undefined && id !== 0) added.push(id);
      }
      formListAdded.set(formId, added);
      applied |= ChangeBase.last;
    }
    if (form.formFlags !== undefined && entry.type > 5) applied |= CHANGE_FORM_FLAGS;
    // What changed and had no place: by type and flag.
    for (let bit = 0; bit < 32; bit++) {
      const mask = (1 << bit) >>> 0;
      if (flags & mask && !(applied & mask)) skips.add(`${typeName}: ${flagName(typeName, mask)}`);
    }
  }

  function applyReference(form: EssChangeForm, formId: number): number {
    let applied = 0;
    const reference = state.reference(formId);
    if (form.formFlags !== undefined) {
      reference.enabled = (form.formFlags & FormFlag.disabled) === 0;
      if (form.formFlags & FormFlag.deleted) reference.deleted = true;
      applied |= CHANGE_FORM_FLAGS;
    }
    const initial = form.initial;
    if (initial && initial.kind !== 'detached cell') {
      const cellOrWorld = initial.kind === 'changed cell' ? initial.newCell : initial.cell;
      const place = placeOf(cellOrWorld);
      reference.position = initial.position;
      reference.rotation = initial.rotation;
      if (place.cell !== undefined) reference.cell = place.cell;
      if (place.world !== undefined) reference.world = place.world;
      if (initial.kind === 'created') {
        const base = ours(initial.base);
        if (base !== undefined) state.created.set(formId, { base, count: 1 });
        state.nextCreated = Math.max(state.nextCreated, formId + 1);
      }
      if (formId === PLAYER_REF) {
        player = {
          position: initial.position,
          rotation: initial.rotation,
          cell: place.cell,
          world: place.world,
          scale: form.scale ?? 1,
        };
      }
      applied |= ChangeRefr.moved | ChangeRefr.havokMoved | ChangeRefr.cellChanged;
      applied |= ChangeRefr.promoted;
    }
    if (form.scale !== undefined) {
      reference.scale = form.scale;
      applied |= ChangeRefr.scale;
    }
    applied |= applyExtras(form, formId, reference);
    if (form.baseObject !== undefined && form.changeFlags & ChangeRefr.baseObject) {
      // A base a script swapped in.
      const base = ours(form.baseObject);
      if (base !== undefined && base !== 0) {
        reference.base = base;
        applied |= ChangeRefr.baseObject;
      }
    }
    if (form.actor?.values) applyActorValues(formId, form.actor.values);
    // The life state (an actor's state bits, the fifth byte, as CommonLibSSE's
    // ACTOR_LIFE_STATE): dying or dead, unconscious, restrained; alive clears them.
    if (form.type === 1 && form.changeFlags & ChangeRefr.lifeState && form.actor?.stateBits) {
      const life = form.actor.stateBits[StateByte.life] ?? 0;
      const actor = state.actor(formId);
      if (life === LifeState.dying || life === LifeState.dead) actor.dead = true;
      else if (life === LifeState.alive) actor.dead = false;
      actor.unconscious = life === LifeState.unconscious;
      actor.restrained = life === LifeState.restrained;
      applied |= ChangeRefr.lifeState;
    }
    applied |= applyAnimation(form, formId, reference);
    if (form.actor && formId !== PLAYER_REF) {
      const saved = savedActor(form, formId);
      if (saved) savedActors.push(saved);
    }
    if (form.inventory) {
      const deltas = inventoryDeltas.get(formId) ?? new Map<number, number>();
      for (const item of form.inventory) {
        const id = ours(item.item);
        if (id === undefined) continue;
        const outfit = applyItemExtras(form, formId, id, item);
        deltas.set(id, (deltas.get(id) ?? 0) + item.delta - outfit);
      }
      inventoryDeltas.set(formId, deltas);
      applied |= ChangeRefr.inventory | ChangeRefr.leveledInventory;
    }
    // TODO(M13): the open state's data is not known (xEdit has not seen it): flagged as open.
    if (form.changeFlags & ChangeRefr.openState) {
      reference.openState = 1;
      applied |= ChangeRefr.openState;
    }
    if (formId === PLAYER_REF) state.actor(PLAYER_REF).level = ess.header.playerLevel;
    if (formId === PLAYER_REF && form.actor?.player) applyPlayerData(form.actor.player);
    return applied;
  }

  /**
   * An arrow lying in the world (PARW: one that hit the world and stays, to be picked up): the
   * reference the original made for it, as ours keeps one (src/shell/combat-projectiles.ts): a
   * reference of its ammunition (the projectile's second form: bow, ammunition, shooter, ...)
   * where it lies, held where it stuck, falling if physics moved it (havokMoved).
   */
  function applyArrow(form: EssChangeForm, formId: number): number {
    const applied = applyReference(form, formId);
    const ammo = ours(form.projectile?.refs[1] ?? 0);
    const made = state.created.get(formId);
    if (!made || !ammo || world.recordType(ammo) !== 'AMMO') {
      skips.add('PARW: an arrow whose ammunition is not known');
      return applied & ~MOVED;
    }
    state.created.set(formId, { ...made, base: ammo });
    state.reference(formId).motionType = form.changeFlags & ChangeRefr.havokMoved ? 1 : 4;
    return applied;
  }

  /**
   * A cell's changes: when it last left the loaded area (its detach time, in whole game hours
   * as ours keeps it: the saves read have 7 an hour and more before their clock's 8.3), what
   * the player has seen of it (the local map's fog: seenFromSave), whether it is a public place
   * (its flags' 0x20, as the record's DATA has it), its name and owner.
   */
  function applyCell(form: EssChangeForm, formId: number): number {
    let applied = 0;
    if (form.initial?.kind === 'detached cell') {
      state.cellDetached.set(formId, form.initial.detachTime);
      applied |= ChangeCell.detachTime | ChangeCell.exteriorChar | ChangeCell.exteriorShort;
    }
    const cell = form.cell;
    if (cell?.seen) {
      // TODO(M13): an exterior's fog is kept, but ours draws none on the exterior local map.
      const blocks = state.seen.get(formId) ?? new Map<string, Uint8Array>();
      for (const { x, y, bits } of cell.seen)
        blocks.set(`${String(x)},${String(y)}`, seenFromSave(bits));
      state.seen.set(formId, blocks);
      applied |= ChangeCell.seenData;
    }
    if (cell?.flags !== undefined) {
      state.cell(formId).public = (cell.flags & CellFlag.publicArea) !== 0;
      if (cell.flags & ~CellFlag.publicArea) {
        skips.add('CELL: flags 0x40, 0x200 (their meaning is not known: TODO(M13))');
      }
      applied |= ChangeCell.flags;
    }
    if (cell?.owner !== undefined) {
      const owner = ours(cell.owner);
      if (owner) {
        if (world.recordType(owner) === 'FACT') state.cell(formId).ownerFaction = owner;
        else state.cell(formId).ownerActor = owner;
        applied |= ChangeCell.ownership;
      }
    }
    return applied;
  }

  /**
   * A reference's extra data (docs/formats/ess.md "Extra data"), each where ours keeps it.
   * Returns the change flags whose extra data was all applied (an extra comes with its flag:
   * EXTRA_FLAG); an extra with no place is logged by its name.
   */
  function applyExtras(form: EssChangeForm, formId: number, reference: ReferenceState): number {
    const actor = form.type === 1;
    const unapplied = new Set<number>();
    const present = new Set<number>();
    for (const extra of form.extras ?? []) {
      const flag = extraFlag(extra.name, actor);
      present.add(flag);
      if (applyExtra(extra, form, formId, reference)) continue;
      unapplied.add(flag);
      skips.add(`${changeFormTypeName(form.type)}: extra ${extra.name} not applied`);
    }
    let applied = 0;
    for (const flag of [...EXTRA_FLAGS, ChangeRefr.gameOnlyExtra]) {
      if (actor ? flag === ChangeRefr.itemExtraData || flag === ChangeRefr.lockExtra : false) {
        continue;
      }
      // A flag whose extra data was all applied, or that came with none (nothing to apply).
      if (!unapplied.has(flag) && (present.has(flag) || form.changeFlags & flag)) applied |= flag;
    }
    return applied;
  }

  /** One extra data entry of a reference applied; false when ours has no place for it. */
  function applyExtra(
    extra: EssExtra,
    form: EssChangeForm,
    formId: number,
    reference: ReferenceState,
  ): boolean {
    const { value } = extra;
    const one = typeof value === 'number' ? value : undefined;
    switch (extra.name) {
      case 'Ownership': {
        const owner = one === undefined ? undefined : ours(one);
        if (owner === undefined) return false;
        if (world.recordType(owner) === 'FACT') reference.ownerFaction = owner;
        else reference.ownerActor = owner;
        return true;
      }
      case 'FactionChanges': {
        // The factions a script put the actor in or took it out of (rank −1: out; ours: −2).
        const factions = state.actor(formId).factions;
        for (const { faction, rank } of extra.factions ?? []) {
          const id = ours(faction);
          if (id !== undefined) factions.set(id, rank < 0 ? -2 : rank);
        }
        return true;
      }
      case 'Lock': {
        // A lock (not an actor's: its bit is the merchant container there): its level and
        // whether it is locked (the lock's flags, bit 0).
        if (form.type === 1 || typeof value !== 'object') return false;
        const [level = 0, lockFlags = 0] = value;
        reference.lockLevel = level;
        reference.locked = (lockFlags & 1) !== 0;
        return true;
      }
      case 'ReferenceHandle': {
        // An item reference in a container (the itemExtraData change): its holder, whose
        // inventory counts it (the holder's own entry names it back).
        const holder = one === undefined ? undefined : ours(one);
        const base = reference.base ?? state.created.get(formId)?.base;
        if (!holder || base === undefined || form.type === 1) return false;
        reference.container = { holder, base, count: state.created.get(formId)?.count ?? 1 };
        return true;
      }
      case 'EncounterZone': {
        const zone = one === undefined ? undefined : ours(one);
        if (zone === undefined) return false;
        reference.encounterZone = zone;
        return true;
      }
      case 'LeveledCreature': {
        // The NPC_ its leveled lists came down to (the second form; the first is its base).
        // TODO(M13): the changes to the generated base it writes after them (none in the
        // saves read).
        const picked = typeof value === 'object' ? ours(value[1] ?? 0) : undefined;
        if (!picked || Object.keys(extra.npc ?? {}).length > 0) return false;
        state.actor(formId).leveledBase = picked;
        return true;
      }
      case 'PackageStartLocation': {
        // Where its package started (its "near the package's start" locations), for the
        // package it goes on with.
        if (typeof value !== 'object' || value.length < 4) return false;
        packageStarts.set(formId, [value[1] ?? 0, value[2] ?? 0, value[3] ?? 0]);
        return true;
      }
      case 'RunOncePacks': {
        // Packages that run once a day that ran (TODO(M13): the byte beside each is not
        // known; ours counts them run today).
        if (typeof value !== 'object') return false;
        ranOnce.set(
          formId,
          value.flatMap((pack) => ours(pack) ?? []),
        );
        return true;
      }
      case 'ActorCause': {
        // The actor its doings are blamed on: the actor causes table's (global data 103).
        const cause = one === undefined ? undefined : causes.get(one);
        if (cause === undefined) return false;
        reference.actorCause = cause;
        return true;
      }
      case 'Flags':
        // ExtraFlags: bit 0 blocks activation (BlockActivation). TODO(M13): its other bits
        // (none set in the saves read).
        if (one === undefined || (one & ~1) !== 0) return false;
        reference.activationBlocked = (one & 1) !== 0;
        return true;
      case 'Ghost':
        state.actor(formId).ghost = one !== 0;
        return true;
      case 'MapMarker':
        // The marker's flags: bit 0 shown on the map, bit 1 travelled to.
        mapMarkers.set(formId, {
          visible: ((one ?? 0) & 1) !== 0,
          travel: ((one ?? 0) & 2) !== 0,
        });
        return true;
      case 'TextDisplayData':
        // A name of its own (kind −2: named by the player); else the name an alias gives it,
        // which ours gives from the alias it fills.
        if (extra.text !== undefined) reference.displayName = extra.text;
        return true;
      case 'Interaction': {
        // A rider and its horse (kind 0, the only kind in the saves read: the rider first).
        // TODO(M13): the other kinds and the flag byte after the references.
        if (typeof value !== 'object' || value[0] !== 0) return false;
        const rider = ours(value[1] ?? 0);
        const horse = ours(value[2] ?? 0);
        if (!rider || !horse || rider !== formId) return false;
        riding.set(rider, horse);
        return true;
      }
      case 'DismemberedLimbs': {
        // The limbs cut off: each its body part type and what the actor wore as it came off
        // (ActorState.dismembered: the body is dressed again so, src/shell/actor-dismemberment.ts).
        // TODO(M13): the five values before the list (a u16, two u32, a byte, the actor).
        const limbs = (extra.items ?? []).map(([limb = 0, ...forms]) => ({
          limb,
          worn: forms.flatMap((item) => {
            const id = ours(item);
            return id ? [id] : [];
          }),
        }));
        if (limbs.length === 0) return false;
        state.actor(formId).dismembered = limbs;
        return true;
      }
      case 'AttachedArrows3D': {
        // The arrows stuck in the actor (WorldSave.attachedArrows), oldest first: each its PROJ,
        // its bone, how long it has been stuck and its place on the bone. TODO(M13): the bone
        // index is taken as ours (the skeleton's bone order), the quaternion as Gamebryo's
        // (w, x, y, z); the u32 after the list is not known.
        for (const [arrow = 0, bone = 0xffff, ms = 0, ...place] of extra.items ?? []) {
          const projectile = ours(arrow);
          if (!projectile || bone === 0xffff || place.length < 8) continue;
          const [x = 0, y = 0, z = 0, qw = 1, qx = 0, qy = 0, qz = 0, scale = 1] = place;
          attachedArrows.push({
            target: formId,
            projectile,
            node: bone,
            local: placeMatrix([x, y, z], [qx, qy, qz, qw], scale),
            age: ms / 1000,
          });
        }
        return true;
      }
      case 'NonActorMagicTarget':
        // The magic effects on an object: none in the saves read (an empty list, which leaves
        // nothing to apply). TODO(M13): the effects' data, once a save holds one.
        return (extra.items ?? []).length === 0;
      case 'AliasInstanceArray':
      case 'PromotedRef':
      case 'SceneData':
      case 'CachedScale':
      case 'Follower':
        // Kept from what holds it: the quests' aliases (QUST runtime data), the scenes
        // playing, its scale, the packages of those following it.
        return true;
      default:
        return false;
    }
  }

  /**
   * An inventory entry's extra data lists, each a stack of the item: what it wears or holds
   * (Worn, WornLeft), its health (tempered), charge and soul (itemStacks), a weapon's poison.
   * Returns how many of its items came with the actor's outfit, which ours puts on as its
   * inventory is first read (they are left out of the delta). TODO(M13): the outfit's leveled
   * pieces are ours, picked by the actor's seed, not the save's.
   */
  function applyItemExtras(
    form: EssChangeForm,
    holder: number,
    item: number,
    entry: EssInventoryEntry,
  ): number {
    const actor = form.type === 1;
    let outfit = 0;
    for (const list of entry.extras) {
      const of = (name: string): EssExtra | undefined => list.find((e) => e.name === name);
      const number = (name: string): number | undefined => {
        const value = of(name)?.value;
        return typeof value === 'number' ? value : undefined;
      };
      const count = number('Count') ?? 1;
      if (actor && of('OutfitItem')) {
        outfit += count;
        continue;
      }
      if (actor && (of('Worn') || of('WornLeft'))) {
        const items = worn.get(holder) ?? [];
        // Worn: on the body, or in the right hand (a weapon, a spell's, a torch); WornLeft: the
        // left hand.
        const held = ['WEAP', 'LIGH'].includes(world.recordType(item) ?? '');
        items.push([item, of('WornLeft') ? 'left' : held ? 'right' : undefined]);
        worn.set(holder, items);
      }
      const health = number('Health');
      const charge = number('Charge');
      const soul = number('Soul');
      if (health !== undefined || charge !== undefined || soul !== undefined) {
        const byBase = state.itemStacks.get(holder) ?? new Map<number, ItemStack[]>();
        const stacks = byBase.get(item) ?? [];
        stacks.push({
          count,
          // The save's float as ours keeps a tempered item's (1.1 Fine, 1.2 Superior, ...).
          health: health === undefined ? 1 : Math.round(health * 1000) / 1000,
          ...(charge !== undefined && { charge }),
          ...(soul !== undefined && soul > 0 && { soul }),
          ...((of('Worn') ?? of('WornLeft')) && { worn: true }),
        });
        byBase.set(item, stacks);
        state.itemStacks.set(holder, byBase);
      }
      const poison = of('Poison');
      if (actor && poison && typeof poison.value === 'object') {
        const id = ours(poison.value[0] ?? 0);
        if (id) {
          state.actorMagic.set(holder, {
            ...state.actorMagic.get(holder),
            poison: { weapon: item, poison: id, charges: poison.value[1] ?? 1 },
          });
        }
      }
      for (const extra of list) {
        // An item's name from the alias holding it (none of its own) is the alias's.
        if (extra.name === 'TextDisplayData' && extra.text === undefined) continue;
        // An item a cut limb took with it (the decapitated head a beheaded body wears): ours
        // dresses the body from its limbs (DismemberedLimbs above), not from its inventory.
        // TODO(M13): CannotWear on an item of no cut limb (none in the saves read).
        if (
          extra.name === 'CannotWear' &&
          actor &&
          state.actor(holder).dismembered?.some((limb) => limb.worn.includes(item))
        ) {
          continue;
        }
        if (!ITEM_EXTRAS_KEPT.has(extra.name)) {
          skips.add(`${changeFormTypeName(form.type)}: item extra ${extra.name} not applied`);
        }
      }
    }
    return outfit;
  }

  /**
   * An actor's running package (its AI process's current one) and whom it fought (its combat
   * controller's target), where the save has it stand: it goes on with them as it is placed
   * (src/save/world-save.ts). An actor the save keeps at its record's place (it writes no place
   * for it) stands there. The package goes on in the branch of its procedure tree it ran (its
   * procedure states' child indices, procedurePath). TODO(M13): the procedures' own states
   * (where a Travel goes, a Sandbox's activity, a Patrol's point) and the high process's timers.
   */
  /**
   * The graphs' state (CHANGE_REFR_ANIMATION, docs/formats/ess.md "Animation graphs"), found
   * again by names: an actor's goes on as it is placed (SavedActor.graph), the player's body
   * and first person's as they are made, an object's as its 3D loads (GameState.graphs, which
   * the placed objects take); a reference with no graph plays its door's Open or Close.
   * Projectiles' graphs (a spell's hand effects) have no place in ours: left logged.
   */
  function applyAnimation(form: EssChangeForm, formId: number, reference: ReferenceState): number {
    if (!form.animation || !(form.changeFlags & ChangeRefr.animation)) return 0;
    if (form.type !== 0 && form.type !== 1) return 0;
    let read: EssAnimationGraphs;
    try {
      read = readAnimationGraphs(form.animation);
    } catch {
      skips.add(`${changeFormTypeName(form.type)}: an animation block not read`);
      return 0;
    }
    if (read.sequence !== undefined) {
      const sequence = read.sequence.toLowerCase();
      if (sequence === 'open') reference.openState = OPEN_STATE_OPEN;
      else if (sequence === 'close') reference.openState = OPEN_STATE_CLOSED;
      return ChangeRefr.animation;
    }
    const [first, second] = read.graphs.map(actorGraphState);
    if (!first) return ChangeRefr.animation;
    if (formId === PLAYER_REF)
      playerGraphs = { body: first, ...(second && { firstPerson: second }) };
    else if (form.type === 1) actorGraphs.set(formId, first);
    else if (first.named) state.graphs.set(formId, { named: first.named });
    return ChangeRefr.animation;
  }

  function savedActor(form: EssChangeForm, formId: number): SavedActor | undefined {
    const actor = form.actor;
    if (actor?.process) {
      // TODO(M13): the high process's timers and the six objects it holds (their meaning).
      skips.add("ACHR: the high process's timers and held objects (TODO(M13))");
    }
    const running = actor?.process?.package;
    const pkg = running?.package;
    const id = pkg === undefined ? undefined : ours(pkg);
    const target =
      (actor?.combat ? ours(actor.combat.target) : undefined) ?? groupTargets.get(formId);
    const horse = riding.get(formId);
    const graph = actorGraphs.get(formId);
    if (!id && !target && horse === undefined && !graph) return undefined;
    const initial = form.initial;
    // An actor the save keeps where its record stands (no place written): there.
    const at =
      initial && initial.kind !== 'detached cell'
        ? {
            ...placeOf(initial.kind === 'changed cell' ? initial.newCell : initial.cell),
            position: initial.position,
            rotation: initial.rotation,
          }
        : world.recordPlace?.(formId);
    if (!at) {
      skips.add('ACHR: a running package of an actor whose place is not known');
      return undefined;
    }
    const place = at;
    // The stage's key for the loaded cell (actor-stage.ts): an exterior's grid, an interior.
    const [x, y] = at.position;
    const cell =
      place.world !== undefined
        ? cellKey(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE))
        : place.cell !== undefined
          ? String(place.cell)
          : undefined;
    if (cell === undefined) return undefined;
    const procedures = procedureStates(running?.procedureState);
    // The point a patrol goes to (among its points), the furniture it sits or sleeps in.
    const goal = procedures.find((state) => state.goal !== undefined)?.goal;
    const seat = seated(actor?.stateBits) ? furnitureOf(procedures) : undefined;
    const furniture = seat === undefined ? undefined : ours(seat);
    return {
      reference: formId,
      cell,
      position: at.position,
      heading: at.rotation[2],
      ...(furniture && { furniture }),
      ...(weaponDrawn(actor?.stateBits) && { weaponDrawn: true }),
      ...(horse !== undefined && { riding: horse }),
      ...(graph && { graph }),
      ...(id && {
        package: {
          id,
          completed: false,
          ended: false,
          path: procedurePath(running?.procedureState),
          found: [],
          ranOn: (ranOnce.get(formId) ?? []).map(
            (pack) => [pack, Math.floor(state.gameDaysPassed)] as const,
          ),
          ...(packageStarts.has(formId) && { start: packageStarts.get(formId) }),
          ...(goal !== undefined && ours(goal) && { goal: ours(goal) }),
        },
      }),
      ...(target && { combatTarget: target }),
      ...(target &&
        groupKnowledge.get(formId)?.has(target) && {
          fight: groupKnowledge.get(formId)?.get(target),
        }),
    };
  }

  /**
   * The player's own data: the experience towards the next character level and each skill's
   * towards its next level, the times each skill was made legendary, and the perks taken; the
   * quest log's entries; the camera.
   */
  function applyPlayerData(data: EssPlayerData): void {
    state.playerExperience = data.xp;
    data.skills.forEach((skill, i) => {
      const av = FIRST_SKILL_AV + i;
      state.skillExperience.set(av, skill.xp);
      if (skill.legendary > 0) state.legendary.set(av, skill.legendary);
    });
    const perks = state.actor(PLAYER_REF).perks;
    for (const { perk } of data.perks) {
      const id = ours(perk);
      if (id !== undefined && id !== 0) perks.set(id, true);
    }
    // The quest log: newest first, each the stage and its log entry (the entry's index in the
    // stage). Ours keeps each quest's entries oldest first, and the journal's order by when
    // each quest was last updated.
    const log = [...data.questLog].reverse();
    for (const { quest: questId, stage, flags: entry } of log) {
      const id = ours(questId);
      if (id === undefined || id === 0) continue;
      const quest = state.quest(id);
      quest.log.push({ stage, entry });
      quest.updated = ++state.questClock;
    }
    // The camera: first person (its state 0) or third (the third person, mount, bleedout and
    // dragon states, 9 to 12), and the fields of view. TODO(M13): the other states (vanity,
    // furniture, a menu's) go back to the one under them; that is not read yet.
    const { camera } = data;
    const pov = camera.state === 0 ? 'first' : camera.state >= 9 ? 'third' : undefined;
    savedPlayer = { ...(pov && { pov }), fov: [camera.worldFov, camera.firstPersonFov] };
    // The face's tint masks (the race menu's tints), for the player's appearance.
    tints = data.tintMasks;
    // TODO(M13): the player's other lists (docs/formats/ess.md "The player").
  }

  function valueOf(reference: number, av: number): ActorValueState {
    const values = state.actor(reference).values;
    let value = values.get(av);
    if (!value) {
      value = { modifier: 0, damage: 0 };
      values.set(av, value);
    }
    return value;
  }

  /**
   * An actor's actor values: base values that changed (they win over the base record's, as the
   * player's skills from its NPC_ change form), and the modifiers. The game keeps damage as a
   * negative modifier; ours is the amount taken (TODO(M13): checked against a real save).
   */
  function applyActorValues(reference: number, values: EssActorValues): void {
    for (const { av, value } of values.base) valueOf(reference, av).base = value;
    for (const modifiers of [...values.modifiers, ...values.others]) {
      const value = valueOf(reference, modifiers.av);
      value.modifier = modifiers.permanent;
      if (modifiers.temporary !== 0) value.temporary = modifiers.temporary;
      value.damage = -modifiers.damage;
    }
  }

  /**
   * What the game changed on an NPC_ base other than the player's, over its record: its
   * factions (the whole list as it stands, SNAM's layout), skills (DNAM's 18 values) and AI
   * data (AIDT's aggression, confidence, energy, morality, mood, assistance), for every actor
   * of the base (actor-engine.ts). TODO(M13): DNAM's skill offsets, health, magicka and stamina
   * (calculated from the level by ours) and AIDT's aggro radii.
   */
  function applyBaseChanges(formId: number, npc: EssNpcChanges): number {
    let applied = 0;
    if (npc.factions) {
      const factions = new Map<number, number>();
      for (const { faction, rank } of npc.factions) {
        const id = ours(faction);
        if (id) factions.set(id, rank);
      }
      state.actorBase(formId).factions = factions;
      applied |= ChangeNpc.factions;
    }
    if (npc.skills && npc.skills.length >= 18) {
      state.actorBase(formId).skills = new Map(
        Array.from({ length: 18 }, (_, i) => [FIRST_SKILL_AV + i, npc.skills?.[i] ?? 0] as const),
      );
      applied |= ChangeNpc.skills;
    }
    if (npc.aiData && npc.aiData.length >= 6) {
      const [aggression = 0, confidence = 0, energy = 0, morality = 0, mood = 0, assistance = 0] =
        npc.aiData;
      state.actorBase(formId).aiData = {
        aggression,
        confidence,
        energy,
        morality,
        mood,
        assistance,
      };
      applied |= ChangeNpc.aiData;
    }
    return applied;
  }

  function applyPlayerBase(form: EssChangeForm): number {
    const npc = form.npc;
    if (!npc) return 0;
    let applied = 0;
    const actor = state.actor(PLAYER_REF);
    if (npc.fullName !== undefined) {
      state.playerName = npc.fullName;
      applied |= ChangeNpc.fullName;
    }
    if (npc.race) {
      const race = ours(npc.race.current);
      if (race !== undefined) actor.race = race;
      state.raceChosen = true;
      applied |= ChangeNpc.race;
    }
    if (npc.skills) {
      const view = new DataView(npc.skills.buffer, npc.skills.byteOffset, npc.skills.byteLength);
      for (let i = 0; i < 18; i++) {
        valueOf(PLAYER_REF, FIRST_SKILL_AV + i).base ??= view.getUint8(i);
      }
      // TODO(M13): DNAM's health, magicka and stamina as the player's base values.
      for (let i = 0; i < 3; i++) {
        const value = view.getUint16(36 + i * 2, true);
        if (value > 0) valueOf(PLAYER_REF, HEALTH_AV + i).base ??= value;
      }
      applied |= ChangeNpc.skills;
    }
    if (npc.factions) {
      for (const { faction, rank } of npc.factions) {
        const id = ours(faction);
        if (id !== undefined) actor.factions.set(id, rank);
      }
      applied |= ChangeNpc.factions;
    }
    if (npc.spells) {
      for (const spell of [...npc.spells, ...(npc.shouts ?? [])]) {
        const id = ours(spell);
        if (id !== undefined) actor.spells.set(id, true);
      }
      applied |= ChangeNpc.spellList;
    }
    // The face and sex: the player's appearance (below, once the tints are read too).
    if (npc.face) {
      face = npc.face;
      applied |= ChangeNpc.face;
    }
    if (npc.female !== undefined) {
      female = npc.female;
      applied |= ChangeNpc.gender;
    }
    return applied;
  }

  // The player's appearance, as the race menu leaves it (GameState.playerAppearance): the race,
  // sex, head parts, hair colour, skin tone, complexion, face sliders and parts, tints.
  const race = state.actors.get(PLAYER_REF)?.race;
  if (face && race !== undefined) {
    const formOf = (id: number | undefined): number | undefined => {
      const ourId = id === undefined || id === 0 ? undefined : ours(id);
      return ourId === 0 ? undefined : ourId;
    };
    const morphs = face.morphs ?? [];
    const parts = face.presets ?? [];
    const tone = face.skinTone ?? [255, 255, 255, 255];
    state.playerAppearance = {
      race,
      sex: female === true ? 1 : 0,
      // TODO(M13): the body's weight (NAM7) is not found in the save yet: the record's default.
      weight: 50,
      headParts: face.headParts.flatMap((part) => formOf(part) ?? []),
      hairColor: formOf(face.hairColor),
      skinTone: [tone[0] / 255, tone[1] / 255, tone[2] / 255],
      faceMorphs: Array.from({ length: FACE_MORPH_COUNT }, (_, i) => morphs[i] ?? 0),
      faceParts: [parts[0] ?? 0, parts[1] ?? -1, parts[2] ?? 0, parts[3] ?? 0],
      tints: [...tints]
        .sort((a, b) => a.index - b.index)
        .map(({ index, color, alpha }) => ({ index, color, value: alpha, preset: -1 })),
      complexion: formOf(face.textureSet),
    };
  }

  // The scenes playing (SCEN's running state): each goes on in the phase it was in (the state's
  // first word; −1: not begun yet, a start waiting), cast from its quest's aliases as the save
  // fills them; its actions start again in that phase, as ours do after a load.
  // TODO(M13): the actions' own state (their bytes: running, done; a looping line's wait) and
  // the scene's clock, whose meaning is not known yet.
  const scenesSaved: SavedScene[] = [];
  const scenesWaiting: [number, boolean][] = [];
  for (const [scene, changes] of scenesPlaying) {
    const cast = world.sceneCast?.(scene);
    if (!cast) {
      skips.add('SCEN: a scene whose record is not read');
      continue;
    }
    const quest = state.quests.get(cast.quest);
    if (quest?.running !== true) continue;
    const phase = changes.state[0] ?? NO_PHASE;
    if (phase === NO_PHASE) {
      scenesWaiting.push([scene, false]);
      continue;
    }
    scenesSaved.push({
      scene,
      force: false,
      random: false,
      phase,
      clock: 0,
      cast: cast.aliases.flatMap((alias) => {
        const reference = quest.aliases.get(alias);
        return reference === undefined ? [] : [[alias, reference] as const];
      }),
      actions: changes.actions.flatMap((action, i) => {
        const index = cast.actions[i];
        return index === undefined ? [] : [sceneAction(index, action)];
      }),
    });
  }

  // The magic favorites (spells, powers and shouts) and their hotkeys (1-8 by index; the
  // items' favorites are their inventory entries' extra data: TODO(M13)).
  const favoritesData = globalData(ess, 109);
  if (favoritesData) {
    const { favorites, hotkeys } = readMagicFavorites(favoritesData, resolve);
    for (const favorite of favorites) {
      const id = favorite === 0 ? undefined : ours(favorite);
      if (id) state.favorites.add(id);
    }
    hotkeys.forEach((hotkey, key) => {
      const id = hotkey === 0 ? undefined : ours(hotkey);
      if (id) state.hotkeys.set(id, key);
    });
  }

  // The sky: the current weather, the one a change under way comes from and when the current
  // came (the time of day), the weather scripts hold over the regions (ForceActive and
  // SetActive with override) and the one that stands for the regions' choice. Its climate,
  // region and fog follow from where the player is. TODO(M13): the change's share is ours
  // from when it began (the original keeps its own, weatherPercent: 1 in the saves read).
  let weather: number | undefined;
  let sky: SkySave | undefined;
  const weatherData = globalData(ess, 6);
  if (weatherData) {
    try {
      const read = readWeather(weatherData, resolve);
      const form = (id: number): number | undefined => {
        const mapped = id === 0 ? undefined : ours(id);
        return mapped === 0 ? undefined : mapped;
      };
      weather = form(read.weather);
      if (weather !== undefined) {
        sky = {
          current: weather,
          outgoing: form(read.previousWeather),
          override: form(read.overrideWeather),
          default: form(read.defaultWeather),
          since: read.beginTime,
        };
      }
    } catch {
      skips.add('weather: unreadable');
    }
  }

  // The music (global data 7): the types in play beside the location's (whose type, the
  // table's last form, follows from where the player is), oldest first: MQ101's
  // MUSDungeonChargen on the cart, MUSCombatBossChargen as Alduin attacks. TODO(M13): the
  // table's first form (0 in the saves read); a type the fights added is put back as a
  // script's (none in the saves read: the fights add theirs again as they go on).
  const music: number[] = [];
  const audioData = globalData(ess, 7);
  if (audioData) {
    try {
      for (const type of readAudio(audioData, resolve).tracks) {
        const id = type === 0 ? undefined : ours(type);
        if (id) music.push(id);
      }
    } catch {
      skips.add('audio: unreadable');
    }
  }

  // The temp effects (global data 1000): the decals on the world (the burns Alduin left on
  // Helgen), into the world's decal store; the three lists of typed effects are logged when
  // they hold any (empty in the saves read).
  let decals: SavedDecal[] = [];
  const tempData = globalData(ess, 1000);
  if (tempData) {
    try {
      const effects = readTempEffects(tempData, resolve);
      decals = essTempDecals(effects.entries, ours);
      for (const effect of [...effects.effects1, ...effects.effects2, ...effects.effects3]) {
        skips.add(`temp effects: an effect of type ${String(effect.type)} (TODO(M13))`);
      }
      if (effects.unread) skips.add('temp effects: an undocumented effect type');
    } catch {
      skips.add('temp effects: unreadable');
    }
  }

  // The animation objects actors hold (global data 1002: the prisoners' cuffs on the cart,
  // Hadvar's ledger and quill, the headsman's axe), put on again as each actor is placed.
  // Observed in the saves: the byte beside each is 1 for every object, shown on its actor;
  // TODO(M13): what another value means (taken as loaded, not shown).
  const animObjects: SavedAnimObject[] = [];
  const animData = globalData(ess, 1002);
  if (animData) {
    try {
      for (const held of readAnimObjects(animData, resolve)) {
        const actor = held.reference === 0 ? undefined : ours(held.reference);
        const object = held.animObject === 0 ? undefined : ours(held.animObject);
        if (actor === undefined || object === undefined) continue;
        animObjects.push({ actor, animObject: object, shown: held.unknown === 1 });
      }
    } catch {
      skips.add('anim objects: unreadable');
    }
  }

  // The interface (global data 102): the input events whose help messages the player has done
  // (the opening's "Look" and "Forward"), not shown again; the weapons, spells and shouts used
  // last (the journal's favorites, each counted once). TODO(M13): the help messages shown (one
  // number, 252 in the saves read) and the two words beside them, whose meaning is not known.
  const interfaceData = globalData(ess, 102);
  if (interfaceData) {
    try {
      const read = readInterface(interfaceData, resolve);
      for (const name of read.extra?.names ?? []) state.helpDone.add(name.toLowerCase());
      for (const [list, usage] of [
        [read.lastUsedWeapons, state.usage.weapons],
        [read.lastUsedSpells, state.usage.spells],
        [read.lastUsedShouts, state.usage.shouts],
      ] as const) {
        for (const form of list) {
          const id = form === 0 ? undefined : ours(form);
          if (id) usage.set(id, (usage.get(id) ?? 0) + 1);
        }
      }
    } catch {
      skips.add('interface: unreadable');
    }
  }

  // Papyrus: the script instances' variables, the threads, the registrations.
  let instances: SavedInstance[] = [];
  let threads: SavedThread[] = [];
  const animationEvents = new Map<number, Map<string, Map<string, ObjectHandle>>>();
  const registered = new Map<string, Map<string, ObjectHandle>>();
  const inventoryFilters = new Map<string, Set<number>>();
  const papyrusData = globalData(ess, 1001);
  if (papyrusData) {
    try {
      const papyrus = readPapyrus(papyrusData, ess.header.version >= 12);
      const values = papyrusValues(papyrus, resolve, ours);
      instances = scriptInstances(papyrus, values, skips);
      // The update registrations, each with the time left until it fires. The original saves
      // the time to send relative to the VM's clock, which the saves read keep at 0 (the
      // timer table): so the time is what is left (TODO(M13): confirmed on a save whose
      // timer is not 0). Real time is in milliseconds, game time in thousandths of an hour.
      const { registrations } = papyrus;
      for (const [list, gameTime] of [
        [registrations.updates, false],
        [registrations.gameTimeUpdates, true],
      ] as const) {
        for (const update of list) {
          const formId = ours(resolve(update.handle.refId));
          if (formId === undefined || formId === 0) continue;
          updates.push({
            // The handle's high word: the alias the registration is on (−1: the form).
            target: new ObjectHandle(formId, 'form', update.handle.high),
            interval: update.interval / 1000,
            gameTime,
            repeat: !update.single,
            left: update.time / 1000,
          });
        }
      }
      // The running stacks, their function messages and waits, the suspended calls.
      threads = scriptThreads(papyrus, values, { real: 0, game: state.gameDaysPassed }, skips);
      // The other registrations, on the handle's form or alias, as ours keep them (runtime.ts):
      // animation events by sender and lowercase name, sleep and tracked stats events, the
      // inventory event filters (items and form lists alike).
      const handle = (at: EssGameHandle): ObjectHandle | undefined => {
        const formId = ours(resolve(at.refId));
        return formId ? new ObjectHandle(formId, 'form', at.high) : undefined;
      };
      for (const { refId, events: senderEvents } of registrations.animationEvents) {
        const sender = ours(resolve(refId));
        if (!sender) continue;
        const byName = new Map<string, Map<string, ObjectHandle>>();
        for (const { name, handles } of senderEvents) {
          const receivers = new Map<string, ObjectHandle>();
          for (const at of handles) {
            const target = handle(at);
            if (target) receivers.set(target.key, target);
          }
          byName.set(name.toLowerCase(), receivers);
        }
        animationEvents.set(sender, byName);
      }
      for (const [kind, list] of [
        ['sleep', registrations.sleepEvents],
        ['trackedstats', registrations.trackedStatsEvents],
      ] as const) {
        const receivers = new Map<string, ObjectHandle>();
        for (const at of list) {
          const target = handle(at);
          if (target) receivers.set(target.key, target);
        }
        if (receivers.size > 0) registered.set(kind, receivers);
      }
      for (const filter of registrations.inventoryFilters) {
        const target = handle(filter.handle);
        if (!target) continue;
        const forms = [...filter.items, ...filter.lists].flatMap((refId) => {
          const id = ours(resolve(refId));
          return id ? [id] : [];
        });
        inventoryFilters.set(target.key, new Set(forms));
      }
      // TODO(M13): RegisterForLOS's (the save names viewer and target, not the script's
      // object that registered: none in the saves read), the latent functions' queued work.
      if (registrations.losEvents.length > 0) skips.add('papyrus: line of sight registrations');
      if (registrations.functors.some((queue) => queue.length > 0)) {
        skips.add("papyrus: latent functions' queued work");
      }
    } catch (error) {
      skips.add(`papyrus: unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  // Quest static data (global data 107): its fourth list is the quests running (in both saves
  // read, the same 451 quests whose change forms say they run), whose state the QUST change
  // forms gave; a listed quest that does not run is logged. TODO(M13): the other three lists
  // (run data, references: empty in the saves read).
  const staticData = globalData(ess, 107);
  if (staticData) {
    try {
      const lists = readQuestStaticData(staticData, resolve);
      for (const quest of lists.references3) {
        const id = ours(quest);
        if (id && !state.quests.get(id)?.running) {
          skips.add('quest static data: a quest listed that does not run');
        }
      }
      if (lists.runData0.length + lists.runData1.length + lists.references2.length > 0) {
        skips.add('quest static data: its run data lists (TODO(M13))');
      }
    } catch {
      skips.add('quest static data: unreadable');
    }
  }
  // The story event manager: the events told and not yet processed, told again after the load.
  let pending: StoryEventData[] = [];
  const events = globalData(ess, 111);
  if (events) {
    try {
      pending = readStoryEventManager(events, resolve).events.map(storyEvent);
    } catch (error) {
      skips.add(
        `story events: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  // Tables that hold nothing to apply when their lists are empty (as in every save read): the
  // image space modifiers running (5), the ingredients' known effects (112), the paired
  // animations under way (1004). TODO(M13): applied once a save holds some.
  const empty = (type: number, data: Uint8Array): boolean => {
    if (type !== 5 && type !== 112 && type !== 1004) return false;
    try {
      const value = readGlobalData(type, data, resolve)?.value;
      if (Array.isArray(value)) return value.length === 0;
      const effects = (value as { effects?: unknown } | undefined)?.effects;
      return Array.isArray(effects) && effects.length === 0;
    } catch {
      return false;
    }
  };
  for (const table of [ess.globalData1, ess.globalData2, ess.globalData3]) {
    for (const entry of table) {
      if (
        ![0, 1, 3, 6, 7, 101, 103, 107, 109, 111, 1000, 1001, 1002].includes(entry.type) &&
        entry.data.length > 0 &&
        !empty(entry.type, entry.data)
      ) {
        skips.add(`global data ${String(entry.type)}`);
      }
    }
  }
  for (const plugin of missing) skips.add(`forms of ${plugin}: the plugin is not loaded`);
  if (!player) throw new Error('the save does not say where the player is');

  const runtime: RuntimeSave = {
    state: gameStateData(state),
    clocks: { realTime: 0, gameTime: state.gameDaysPassed, wallTime: 0 },
    startDate: undefined,
    startDays: 0,
    fields: {},
    stats,
    wordsLearned: new Map(),
    iniOverrides: new Map(),
    updates,
    animationEvents,
    registrations: registered,
    lineOfSight: undefined,
    inventoryFilters,
    formListAdded,
    mapMarkers: mapMarkers.size > 0 ? mapMarkers : undefined,
    initialized: [],
    seeded: [],
    dialogue:
      saidOnce.size > 0
        ? { saidOnce, saidAt: new Map(), chosen: new Set(), saidInTopic: new Map() }
        : undefined,
    storyManager: pending.length > 0 ? { pending } : undefined,
    instances,
    ...(threads.length > 0 && { threads }),
    ...((scenesSaved.length > 0 || scenesWaiting.length > 0) && {
      scenes: { playing: scenesSaved, waiting: scenesWaiting },
    }),
  };
  const skipped = skips.lines();
  const save: GameSave = {
    runtime,
    player,
    weather,
    ...(sky && { sky }),
    ...(music.length > 0 && { music }),
    unsaved: [],
    world: {
      actors: savedActors,
      graphs: [],
      ...(savedPlayer && { player: savedPlayer }),
      ...(playerGraphs && { playerGraphs }),
      ...(attachedArrows.length > 0 && { attachedArrows }),
      ...(decals.length > 0 && { decals }),
      ...(animObjects.length > 0 && { animObjects }),
    },
    inventoryDeltas: [...inventoryDeltas].map(([container, items]) => [container, [...items]]),
    ...(worn.size > 0 && { worn: [...worn] }),
  };
  const header: SaveHeader = {
    version: SAVE_VERSION,
    name: request.name,
    kind: 'save',
    number: request.number,
    playerName: state.playerName ?? ess.header.playerName,
    playerLevel: ess.header.playerLevel,
    location: ess.header.location,
    gameDays: state.gameDaysPassed,
    realTime: request.now,
    plugins: [...ess.plugins, ...ess.lightPlugins],
  };
  return { header, save, skipped };
}

/** The save's Papyrus values as ours: its objects as handles to their forms. */
interface PapyrusValues {
  readonly objects: ReadonlyMap<number, EssObject>;
  readonly handleOf: (object: EssObject) => ObjectHandle | undefined;
  readonly value: (variable: EssVariable) => Value;
}

function papyrusValues(
  papyrus: EssPapyrus,
  resolve: RefIdResolver,
  ours: (formId: number) => number | undefined,
): PapyrusValues {
  const objects = new Map(papyrus.objects.map((object) => [object.handle, object]));
  const handleOf = (object: EssObject): ObjectHandle | undefined => {
    const formId = ours(resolve(object.refId));
    if (formId === undefined) return undefined;
    // The game handle's high word: an alias script's alias id (−1 on every form's, as read).
    return new ObjectHandle(formId, object.script, object.high);
  };
  const value = (variable: EssVariable): Value => {
    switch (variable.type) {
      case PapyrusType.Null:
        return null;
      case PapyrusType.Object: {
        const object = objects.get(variable.handle);
        return object ? (handleOf(object)?.as(variable.script) ?? null) : null;
      }
      case PapyrusType.String:
      case PapyrusType.Int:
      case PapyrusType.Float:
      case PapyrusType.Bool:
        return variable.value;
      default: {
        const items = papyrus.arrayData.get(variable.array);
        return items ? new PapyrusArray(items.map(value)) : null;
      }
    }
  };
  return { objects, handleOf, value };
}

/** The clocks the three wait tables wait on: Utility.Wait, WaitMenuMode, WaitGameTime. */
const WAIT_CLOCKS = ['real', 'wall', 'game'] as const;

/**
 * The running stacks as our waiting threads (papyrus-vm.ts SavedThread). Our VM runs the
 * compiled code as the original does, so a frame goes on at the instruction the save has it
 * at: each frame of the saves read stands on its call (the callee's frame, or the native call
 * its function message queued), which our resumed thread runs again, as the queued message
 * would have run; a stack in a wait table waits for that clock. A suspended stack (a call
 * queued and not begun) starts. TODO(M13): the stacks' fragment callbacks (a quest stage's,
 * a scene's results) and a property accessor's function type (1 get, 2 set: none in the saves
 * read).
 */
function scriptThreads(
  papyrus: EssPapyrus,
  { objects, value }: PapyrusValues,
  clocks: { readonly real: number; readonly game: number },
  skips: Skips,
): SavedThread[] {
  const self = (variable: EssVariable): ObjectHandle | null => {
    const handle = value(variable);
    return handle instanceof ObjectHandle ? handle : null;
  };
  // When each waiting stack resumes, on its clock: real time in milliseconds left, game time
  // in thousandths of an hour (as the update registrations).
  const waits = new Map<number, ThreadWait>();
  papyrus.registrations.waits.forEach((list, i) => {
    const clock = WAIT_CLOCKS[i] ?? 'real';
    for (const { stack, time } of list) {
      const at = clock === 'game' ? clocks.game + time / 1000 / 24 : clocks.real + time / 1000;
      waits.set(stack, { kind: 'clock', clock, at });
    }
  });
  const threads: SavedThread[] = [];
  for (const stack of papyrus.stackData) {
    const frames: SavedFrame[] = [];
    for (const [depth, frame] of stack.frames.entries()) {
      const handle = self(frame.self);
      const object =
        frame.self.type === PapyrusType.Object ? objects.get(frame.self.handle) : undefined;
      const attached = object?.script.toLowerCase() === frame.script.toLowerCase();
      const names = [...frame.function.params, ...frame.function.locals];
      frames.push({
        script: frame.baseScript.toLowerCase(),
        state: (frame.state ?? '').toLowerCase(),
        function: frame.functionName.toLowerCase(),
        accessor: frame.functionType === 1 ? 'get' : frame.functionType === 2 ? 'set' : undefined,
        size: frame.function.code.length,
        name: frame.functionName,
        self: handle?.as(frame.script) ?? null,
        instance: handle && {
          target: handle.as(frame.script),
          script: (attached ? frame.script : frame.baseScript).toLowerCase(),
          native: !attached,
        },
        pc: frame.instruction,
        depth,
        locals: frame.variables.flatMap((variable, i) => {
          const local = names[i];
          return local ? [[local.name.toLowerCase(), value(variable)] as const] : [];
        }),
        casts: [],
        engineNones: [],
      });
    }
    const outer = frames[0];
    if (!outer?.self || stack.frames.length === 0) {
      skips.add('papyrus: a running stack on a form not loaded');
      continue;
    }
    const event = outer.instance?.native === false;
    threads.push({
      origin: {
        kind: event ? 'event' : 'call',
        target: event ? outer.self.as(outer.instance.script) : outer.self,
        name: outer.name,
        args: [],
      },
      initializing: outer.function === 'oninit',
      frames,
      wait: waits.get(stack.id) ?? { kind: 'restart' },
      where: `${outer.name} (stack ${String(stack.id)})`,
    });
    if (stack.callback) skips.add(`papyrus: a stack's ${stack.callback.type} callback (TODO(M13))`);
  }
  // The calls queued and not begun.
  for (const { call } of papyrus.suspendedStacks.flat()) {
    const target = call && self(call.self);
    if (!call || !target) {
      skips.add('papyrus: a suspended call on a form not loaded');
      continue;
    }
    threads.push({
      origin: { kind: 'call', target, name: call.functionName, args: call.args.map(value) },
      initializing: false,
      frames: [],
      wait: { kind: 'restart' },
      where: `${call.script}.${call.functionName} (suspended)`,
    });
  }
  return threads;
}

/**
 * The script instances with their variables, by script level: a type's members follow its
 * parents' (TODO(M13): checked against a real save), else all go to the script itself.
 */
function scriptInstances(
  papyrus: EssPapyrus,
  { handleOf, value }: PapyrusValues,
  skips: Skips,
): SavedInstance[] {
  const types = new Map(papyrus.types.map((type) => [type.name.toLowerCase(), type]));
  const data = new Map(papyrus.objectData.map((entry) => [entry.handle, entry]));
  const instances: SavedInstance[] = [];
  for (const object of papyrus.objects) {
    const handle = handleOf(object);
    const entry = data.get(object.handle);
    if (!handle || !entry) {
      skips.add('papyrus: an instance on a form not loaded');
      continue;
    }
    const chain: { name: string; members: { name: string }[] }[] = [];
    for (
      let type = types.get(object.script.toLowerCase());
      type;
      type = types.get(type.parent.toLowerCase())
    ) {
      chain.unshift({ name: type.name, members: [...type.members] });
      if (chain.length > 32) break;
    }
    const total = chain.reduce((sum, level) => sum + level.members.length, 0);
    const levels =
      total === entry.variables.length
        ? chain
        : [{ name: object.script, members: chain.at(-1)?.members ?? [] }];
    if (levels.reduce((sum, level) => sum + level.members.length, 0) !== entry.variables.length) {
      skips.add(`papyrus: ${object.script}'s variables do not match its type`);
      continue;
    }
    let at = 0;
    const vars: [string, [string, Value][]][] = levels.map((level) => [
      level.name,
      level.members.map((member) => {
        const variable = entry.variables[at++];
        return [member.name.toLowerCase(), variable ? value(variable) : null];
      }),
    ]);
    instances.push({
      formId: handle.formId,
      alias: handle.alias,
      script: object.script,
      state: entry.state,
      vars,
    });
  }
  return instances;
}
