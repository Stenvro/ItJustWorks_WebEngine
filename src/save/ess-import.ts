// Import of the original's saves (.ess, docs/formats/ess.md "Import"): what the parser reads
// (src/formats/ess) put into our own save (game-save.ts), so it loads through the same path:
// the plugins read as for a new game, then this state applied. Form ids are moved from the
// save's load order to ours by plugin name. What has no place yet is listed, by change form
// type and flag, for the log. Platform-independent.

import {
  CHANGE_FORM_FLAGS,
  ChangeBase,
  ChangeNpc,
  ChangeQuest,
  ChangeRefr,
  FormFlag,
  QuestFlag,
  readChangeForm,
  type EssActorValues,
  type EssChangeForm,
  type EssNpcChanges,
  type EssSceneChanges,
} from '../formats/ess/change-forms.ts';
import { changeFormTypeName, globalData, type EssFile } from '../formats/ess/ess.ts';
import {
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
  type EssPapyrus,
  type EssVariable,
} from '../formats/ess/papyrus.ts';
import {
  readMagicFavorites,
  readStoryEventManager,
  StoryParameterKind,
  type SavedStoryEvent,
} from '../formats/ess/global-data-tables.ts';
import type { EssPlayerData, EssTintMask } from '../formats/ess/player.ts';
import type { SavedInstance } from '../scripting/papyrus-vm.ts';
import { GameState, type ActorValueState } from '../scripting/runtime/game-state.ts';
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
import { cellKey } from '../world/worldspace.ts';
import type { GameSave } from './game-save.ts';
import { SAVE_VERSION, type SaveHeader } from './save-codec.ts';
import type { SavedActor, SavedPlayer } from './world-save.ts';

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
      if (q.alreadyRun !== undefined) applied |= ChangeQuest.alreadyRun;
      if (q.scriptDelay !== undefined) applied |= ChangeQuest.scriptDelay;
    } else if (entry.type === 9 && form.npc) {
      if (formId === PLAYER_BASE) applied |= applyPlayerBase(form);
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
    } else if (entry.type === 38 && flags & ChangeBase.last) {
      state.location(formId).cleared = true;
      state.location(formId).everCleared = true;
      applied |= ChangeBase.last;
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
    for (const extra of form.extras ?? []) {
      if (extra.name === 'Ownership' && typeof extra.value === 'number') {
        const owner = ours(extra.value);
        if (owner !== undefined) {
          if (world.recordType(owner) === 'FACT') reference.ownerFaction = owner;
          else reference.ownerActor = owner;
          applied |= ChangeRefr.ownershipExtra;
        }
      }
      // The factions a script put the actor in or took it out of (rank −1: out; ours: −2).
      if (extra.factions) {
        const factions = state.actor(formId).factions;
        for (const { faction, rank } of extra.factions) {
          const id = ours(faction);
          if (id !== undefined) factions.set(id, rank < 0 ? -2 : rank);
        }
      }
      // A lock (not an actor's: its bit is the merchant container there): its level and
      // whether it is locked (the lock's flags, bit 0).
      if (extra.name === 'Lock' && form.type !== 1 && typeof extra.value === 'object') {
        const [level = 0, lockFlags = 0] = extra.value;
        reference.lockLevel = level;
        reference.locked = (lockFlags & 1) !== 0;
        applied |= ChangeRefr.lockExtra;
      }
    }
    if (form.actor?.values) applyActorValues(formId, form.actor.values);
    // The life state (an actor's state bits, the fifth byte, as CommonLibSSE's
    // ACTOR_LIFE_STATE): dying or dead, unconscious, restrained; alive clears them.
    if (form.type === 1 && form.changeFlags & ChangeRefr.lifeState && form.actor?.stateBits) {
      const life = form.actor.stateBits[4] ?? 0;
      const actor = state.actor(formId);
      if (life === LifeState.dying || life === LifeState.dead) actor.dead = true;
      else if (life === LifeState.alive) actor.dead = false;
      actor.unconscious = life === LifeState.unconscious;
      actor.restrained = life === LifeState.restrained;
      applied |= ChangeRefr.lifeState;
    }
    if (form.actor && formId !== PLAYER_REF) {
      const saved = savedActor(form, formId);
      if (saved) savedActors.push(saved);
    }
    if (form.inventory) {
      const deltas = inventoryDeltas.get(formId) ?? new Map<number, number>();
      for (const item of form.inventory) {
        const id = ours(item.item);
        if (id !== undefined) deltas.set(id, (deltas.get(id) ?? 0) + item.delta);
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
   * An actor's running package (its AI process's current one) and whom it fought (its combat
   * controller's target), where the save has it stand: it goes on with them as it is placed
   * (src/save/world-save.ts). An actor the save keeps at its record's place (it writes no place
   * for it) stands there. The package starts again from its procedure tree's root.
   * TODO(M13): the procedures' running states (process.ts reads them) into ours.
   */
  function savedActor(form: EssChangeForm, formId: number): SavedActor | undefined {
    const actor = form.actor;
    if (actor?.process) skips.add('ACHR: the AI process beyond its package (TODO(M13))');
    const pkg = actor?.process?.package?.package;
    const id = pkg === undefined ? undefined : ours(pkg);
    const target = actor?.combat ? ours(actor.combat.target) : undefined;
    if (!id && !target) return undefined;
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
    return {
      reference: formId,
      cell,
      position: at.position,
      heading: at.rotation[2],
      ...(id && {
        package: { id, completed: false, ended: false, path: [], found: [], ranOn: [] },
      }),
      ...(target && { combatTarget: target }),
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

  // The weather.
  let weather: number | undefined;
  const weatherData = globalData(ess, 6);
  if (weatherData) {
    try {
      const id = ours(readWeather(weatherData, resolve).weather);
      weather = id === 0 ? undefined : id;
    } catch {
      skips.add('weather: unreadable');
    }
  }

  // Papyrus: the script instances' variables (TODO(M12): their stacks and registrations).
  let instances: SavedInstance[] = [];
  const papyrusData = globalData(ess, 1001);
  if (papyrusData) {
    try {
      const papyrus = readPapyrus(papyrusData, ess.header.version >= 12);
      instances = scriptInstances(papyrus, resolve, ours, skips);
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
      // TODO(M13): the running stacks (our resumable frames keep their own code positions,
      // not the compiled script's), the function messages and suspended stacks, the waits,
      // and the other registrations (animation, sleep, tracked stats, inventory filters).
      if (papyrus.stacks.length) {
        skips.add(`papyrus: ${String(papyrus.stacks.length)} running stacks (TODO(M13))`);
      }
      skips.add('papyrus: messages, waits and the registrations but updates (TODO(M13))');
    } catch (error) {
      skips.add(`papyrus: unreadable (${error instanceof Error ? error.message : String(error)})`);
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
  for (const table of [ess.globalData1, ess.globalData2, ess.globalData3]) {
    for (const entry of table) {
      if (![0, 1, 3, 6, 109, 111, 1001].includes(entry.type) && entry.data.length > 0) {
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
    animationEvents: undefined,
    registrations: undefined,
    lineOfSight: undefined,
    inventoryFilters: undefined,
    formListAdded,
    mapMarkers: undefined,
    initialized: [],
    seeded: [],
    dialogue:
      saidOnce.size > 0
        ? { saidOnce, saidAt: new Map(), chosen: new Set(), saidInTopic: new Map() }
        : undefined,
    storyManager: pending.length > 0 ? { pending } : undefined,
    instances,
    ...((scenesSaved.length > 0 || scenesWaiting.length > 0) && {
      scenes: { playing: scenesSaved, waiting: scenesWaiting },
    }),
  };
  const skipped = skips.lines();
  const save: GameSave = {
    runtime,
    player,
    weather,
    unsaved: [],
    world: { actors: savedActors, graphs: [], ...(savedPlayer && { player: savedPlayer }) },
    inventoryDeltas: [...inventoryDeltas].map(([container, items]) => [container, [...items]]),
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

/**
 * The script instances with their variables, by script level: a type's members follow its
 * parents' (TODO(M13): checked against a real save), else all go to the script itself.
 */
function scriptInstances(
  papyrus: EssPapyrus,
  resolve: RefIdResolver,
  ours: (formId: number) => number | undefined,
  skips: Skips,
): SavedInstance[] {
  const types = new Map(papyrus.types.map((type) => [type.name.toLowerCase(), type]));
  const objects = new Map(papyrus.objects.map((object) => [object.handle, object]));
  const handleOf = (object: (typeof papyrus.objects)[number]): ObjectHandle | undefined => {
    const formId = ours(resolve(object.refId));
    if (formId === undefined) return undefined;
    // TODO(M13): the game handle's high word names an alias for alias scripts.
    return new ObjectHandle(formId, object.script, object.flags !== 0 ? object.high : -1);
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
