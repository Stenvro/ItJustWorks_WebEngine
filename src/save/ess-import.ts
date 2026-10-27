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
  type EssChangeForm,
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
import type { SavedInstance } from '../scripting/papyrus-vm.ts';
import { GameState } from '../scripting/runtime/game-state.ts';
import { gameStateData, type RuntimeSave } from '../scripting/runtime/runtime-save.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../scripting/values.ts';
import type { GameSave } from './game-save.ts';
import { SAVE_VERSION, type SaveHeader } from './save-codec.ts';

const PLAYER_REF = 0x14;
const PLAYER_BASE = 0x7;
const GAME_DAYS_PASSED = 0x39;
/** The first skill's actor value (OneHanded); DNAM's 18 skills follow in actor value order. */
const FIRST_SKILL_AV = 6;
const HEALTH_AV = 24;

/** A loaded plugin's place in our load order (RecordDatabase plugins' entries). */
export interface PluginSlot {
  readonly name: string;
  readonly modIndex: number;
  readonly lightIndex?: number | undefined;
}

/** What the importer needs of our world: the load order and records' types. */
export interface EssWorld {
  readonly plugins: readonly PluginSlot[];
  /** A record's type ("CELL", "WRLD", "FACT", ...) by our form id. */
  recordType(formId: number): string | undefined;
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

function flagName(type: string, bit: number): string {
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
        for (const objective of q.objectives) {
          quest.objectives.set(objective.index, {
            displayed: (objective.status & 1) !== 0,
            completed: (objective.status & 2) !== 0,
            failed: false,
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
      if (q.alreadyRun !== undefined) applied |= ChangeQuest.alreadyRun;
      if (q.scriptDelay !== undefined) applied |= ChangeQuest.scriptDelay;
    } else if (entry.type === 9 && form.npc && formId === PLAYER_BASE) {
      applied |= applyPlayerBase(form);
    } else if (entry.type === 13 && flags & ChangeBase.bookRead) {
      state.booksRead.add(formId);
      applied |= ChangeBase.bookRead;
    } else if (entry.type === 38 && flags & ChangeBase.last) {
      state.location(formId).cleared = true;
      state.location(formId).everCleared = true;
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
        actor.values.set(FIRST_SKILL_AV + i, { base: view.getUint8(i), modifier: 0, damage: 0 });
      }
      // TODO(M13): DNAM's health, magicka and stamina as the player's base values.
      for (let i = 0; i < 3; i++) {
        const value = view.getUint16(36 + i * 2, true);
        if (value > 0) actor.values.set(HEALTH_AV + i, { base: value, modifier: 0, damage: 0 });
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
    // TODO(M13): the face (head parts, morphs, tint) and sex into the player's appearance.
    return applied;
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
      const papyrus = readPapyrus(papyrusData);
      instances = scriptInstances(papyrus, resolve, ours, skips);
      if (papyrus.stacks.length) {
        skips.add(`papyrus: ${String(papyrus.stacks.length)} running stacks (TODO(M12))`);
      }
      if (papyrus.unread > 0) {
        skips.add('papyrus: function messages, suspended stacks and registrations (TODO(M12))');
      }
    } catch (error) {
      skips.add(`papyrus: unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  for (const table of [ess.globalData1, ess.globalData2, ess.globalData3]) {
    for (const entry of table) {
      if (![0, 1, 3, 6, 1001].includes(entry.type)) skips.add(`global data ${String(entry.type)}`);
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
    updates: [],
    animationEvents: undefined,
    registrations: undefined,
    lineOfSight: undefined,
    inventoryFilters: undefined,
    formListAdded: undefined,
    mapMarkers: undefined,
    initialized: [],
    seeded: [],
    dialogue: undefined,
    storyManager: undefined,
    instances,
  };
  const skipped = skips.lines();
  const save: GameSave = {
    runtime,
    player,
    weather,
    unsaved: [],
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
    // TODO(M13): the script's state name (the save's object data does not show it plainly).
    instances.push({
      formId: handle.formId,
      alias: handle.alias,
      script: object.script,
      state: '',
      vars,
    });
  }
  return instances;
}
