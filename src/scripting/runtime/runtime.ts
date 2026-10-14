// The running game's scripts: the Papyrus VM on the game data, the game state its natives
// change, the quests, and what the engine is told (WorldBridge). Events reach a reference's
// scripts and those of the aliases that hold it. A new game initializes every quest's scripts
// and the persistent references' (their OnInit), then starts the quests that start with the
// game. Platform-independent: Node tools run it without a world.
// Notes: docs/scripting.md.

import { RecordFlag } from '../../formats/esm/record.ts';
import { view } from '../../formats/esm/fields.ts';
import { LeveledFlag, parseLeveledList, type LeveledList } from '../../world/actor-records.ts';
import { pickLeveled, seededRandom } from '../../world/actors.ts';
import {
  dateAfter,
  daysBetween,
  DEFAULT_START_DATE,
  DEFAULT_TIME_SCALE,
  START_DAY_OF_WEEK,
  type GameDate,
} from '../../world/game-time.ts';
import { parseLocation, type LocationRecord } from '../../world/actor-stats-records.ts';
import { GameSettings } from '../../world/game-settings.ts';
import { linkedReferences } from '../../world/cell-records.ts';
import { QuestFlag } from '../../world/quest-records.ts';
import type { GameRecord, RecordDatabase } from '../../world/record-db.ts';
import { ConditionRunOn, type Condition } from '../conditions.ts';
import {
  PapyrusVm,
  type AttachedScriptInfo,
  type NativeFunction,
  type VmHost,
} from '../papyrus-vm.ts';
import { PapyrusScheduler } from '../scheduler.ts';
import type { ScriptLibrary } from '../script-library.ts';
import { ObjectHandle, type Value } from '../values.ts';
import { evaluateCondition, globalValue } from './condition-values.ts';
import { FormIndex, PLAYER_BASE, PLAYER_REF } from './forms.ts';
import { GameState, type Vec3 } from './game-state.ts';
import { registerNatives } from './natives/index.ts';
import { ActorEngine } from './actor-engine.ts';
import { QuestEngine } from './quests.ts';
import { questText } from './quest-text.ts';
import { scriptEvent, StoryManager, type StoryEventData } from './story-manager.ts';

/** What scripts do to the world the engine shows, and what they read of it (nothing in Node). */
export interface WorldBridge {
  /** A reference was enabled or disabled (shown or hidden). */
  enableChanged?(reference: number, enabled: boolean): void;
  /** A reference was moved or scaled (MoveTo, SetPosition, SetScale, ...). */
  moved?(reference: number): void;
  /** A reference was created (PlaceAtMe, an alias's Create Reference). */
  created?(reference: number): void;
  /** Where a loaded reference is now (actors and simulated objects move; the player). */
  livePlacement?(reference: number): LivePlacement | undefined;
  /** Whether a reference's 3D is loaded (Is3DLoaded). */
  loaded?(reference: number): boolean;
  /** References whose 3D is loaded (finding references near a point). */
  loadedReferences?(): Iterable<number>;
  /** Debug.Notification (TODO(M9): the game's HUD). */
  notification?(text: string): void;
  /** A message box; resolves to the button chosen (TODO(M9): the game's menu). */
  messageBox?(text: string, buttons?: readonly string[]): Promise<number> | undefined;
  /**
   * A help message (Message.ShowAsHelpMessage): shown for `seconds` every `interval`, at most
   * `times` times, until the player does the input event (TODO(M9): the HUD).
   */
  helpMessage?(text: string, event: string, seconds: number, interval: number, times: number): void;
  /** Message.ResetHelpMessage: the help for an input event may show again. */
  resetHelpMessage?(event: string): void;
  /** The HUD's "X added" / "X removed" for the player's items (TODO(M9)). */
  itemMessage?(item: number, count: number, added: boolean): void;
  /** Havok mass of a loaded reference's bodies. */
  mass?(reference: number): number;
  /** A quest's update: the HUD announces it (TODO(M9): the journal keeps it). */
  questUpdate?(update: QuestUpdate): void;
  /** A behavior graph event sent to a reference (PlayAnimation): false if it has none. */
  animationEvent?(reference: number, event: string): boolean;
  /** A NIF sequence played (PlayGamebryoAnimation). */
  sequence?(reference: number, name: string, startOver: boolean): boolean;
  animationVariable?(reference: number, name: string): number | undefined;
  setAnimationVariable?(reference: number, name: string, value: number): void;
  /** SetMotionType: the body becomes dynamic, keyframed, ... (and stops waiting for a touch). */
  motionTypeChanged?(reference: number, motionType: number): void;
  impulse?(reference: number, direction: Vec3, magnitude: number): void;
  pushAway?(pushed: number, from: number, force: number): void;
  hasNode?(reference: number, node: string): boolean;
  /** Where a named node of a loaded reference's model is (MoveToNode). */
  nodePlacement?(reference: number, node: string): { position: Vec3; rotation: Vec3 } | undefined;
  triggerCount?(reference: number): number;
  openChanged?(reference: number, open: boolean): void;
  lockChanged?(reference: number): void;
  destructionChanged?(reference: number): void;
  /** Default activation (doors, containers, items) after the scripts' OnActivate. */
  activate?(reference: number, activator: number | undefined): void;
  controlsChanged?(): void;
  fastTravel?(destination: number): void;
  fade?(out: boolean, black: boolean, delay: number, duration: number): void;
  pointOfView?(pov: 'first' | 'third'): void;
  shakeCamera?(strength: number, seconds: number): void;
  grabbed?(): number | undefined;
  /** A menu opened (TODO(M9): the game's menus), for an actor (inventory, barter, gift). */
  menu?(name: string, actor?: number): void;
  video?(file: string): void;
  sunPosition?(): Vec3;
  /** An actor died (its ragdoll; silent: no death cry or alarm). */
  killed?(actor: number, killer: number | undefined, silent: boolean): void;
  resurrected?(actor: number): void;
  raceChanged?(actor: number): void;
  equipmentChanged?(actor: number): void;
  /** A spell cast by a source at a target (TODO(M11): the magic system). */
  castSpell?(spell: number, source: number, target: number | undefined): void;
  criticalStage?(actor: number, stage: number): void;
  ashPile?(actor: number, pile: number | undefined): void;
  aiEnabled?(actor: number, enabled: boolean): void;
  /** EvaluatePackage: the actor picks its package again (TODO(M10)). */
  evaluatePackage?(actor: number): void;
  currentPackage?(actor: number): number | undefined;
  moveToPackageLocation?(actor: number): void;
  startCombat?(actor: number, target: number): void;
  stopCombat?(actor: number): void;
  lightLevel?(actor: number): number;
  /** An idle played (PlayIdle): false if it could not play. */
  playIdle?(actor: number, idle: number, target: number | undefined): boolean;
  setAlpha?(actor: number, alpha: number, fade: boolean): void;
  lookAt?(actor: number, target: number | undefined): void;
  expression?(actor: number, mood: number | undefined, strength: number): void;
  /** Jail (Faction.SendPlayerToJail, PlayerPayCrimeGold). TODO(M11): crime. */
  jail?(faction: number, removeInventory: boolean, realJail: boolean): void;
  cellAttached?(cell: number): boolean;
  resetCell?(cell: number): void;
  fog?(
    cell: number,
    fog: {
      near?: number;
      far?: number;
      power?: number;
      nearColor?: readonly [number, number, number];
      farColor?: readonly [number, number, number];
    },
  ): void;
  locationLoaded?(location: number): boolean;
  /** The sky (M4): a weather made active (forced: at once), released, read. */
  setWeather?(weather: number, force: boolean, override: boolean, accelerate: boolean): void;
  releaseWeatherOverride?(): void;
  currentWeather?(): number | undefined;
  outgoingWeather?(): number | undefined;
  weatherTransition?(): number;
  skyMode?(): number;
  /** A weather of a classification from the current region's list. */
  findWeather?(classification: number): number | undefined;
  /** Sounds (M6): an instance id (0: none). */
  playSound?(sound: number, source: number): number;
  playSoundAndWait?(sound: number, source: number): Promise<void>;
  stopSound?(instance: number): void;
  soundVolume?(instance: number, volume: number): void;
  soundCategory?(
    category: number,
    action: 'mute' | 'unmute' | 'pause' | 'unpause' | 'volume' | 'frequency',
    value: number,
  ): void;
  /** A music type added to or removed from the music stack (M6). */
  music?(type: number, add: boolean): void;
  imageSpace?(
    modifier: number,
    action: 'apply' | 'remove' | 'crossfade' | 'removeCrossfade' | 'popTo',
    value: number,
    other?: number,
  ): void;
  effectShader?(shader: number, target: number, play: boolean, duration: number): void;
  visualEffect?(
    effect: number,
    target: number,
    play: boolean,
    duration: number,
    facing: number | undefined,
  ): void;
  particleGeometry?(geometry: number, apply: boolean, fade: number): void;
  fireWeapon?(weapon: number, source: number, ammo: number | undefined): void;
  /** A line spoken (TODO(M9): dialogue). */
  say?(
    speaker: number,
    topic: number | undefined,
    speakAs: number | undefined,
    inHead: boolean,
  ): void;
}

/** A quest's update as the HUD announces it. */
export interface QuestUpdate {
  readonly quest: number;
  /** The quest's name, its tags filled in (quest-text.ts); empty if it has none. */
  readonly name: string;
  /** Its type (QuestRecord.type; 6: miscellaneous). */
  readonly type: number;
  /** The objective updated (its text, tags filled in); none: the quest itself. */
  readonly objective?: { readonly index: number; readonly text: string };
  readonly status: 'shown' | 'completed' | 'failed';
  /** The quest's first objective shown: the quest has started (for the player). */
  readonly first: boolean;
}

/** The persistent references of the load order (ScriptRuntime.persistentIndex). */
export interface PersistentIndex {
  readonly all: number[];
  readonly base: Map<number, number>;
  readonly byBase: Map<number, number[]>;
  /** Those with scripts of their own (VMAD). */
  readonly scripted: Set<number>;
  /** By reference: the references whose link without a keyword is it. */
  readonly linkedTo: Map<number, number[]>;
  /** Record flags (initially disabled, persistent, an ACHR's "starts dead", ...). */
  readonly flags: Map<number, number>;
  readonly enableParent: Map<number, { readonly reference: number; readonly opposite: boolean }>;
  /** Those that are ACHR (actors). */
  readonly actors: Set<number>;
  /** Where the plugin places each (DATA, XSCL). */
  readonly placement: Map<number, EditorPlacement>;
  /** Their persist locations (XLCN), where they have one. */
  readonly persistLocation: Map<number, number>;
}

/** Where the plugin places a reference: DATA position and rotation (radians), XSCL scale. */
export interface EditorPlacement {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: number;
}

function editorPlacementOf(record: GameRecord): EditorPlacement | undefined {
  const data = record.fields.first('DATA');
  if (!data || data.length < 24) return undefined;
  const d = view(data);
  return {
    position: [d.getFloat32(0, true), d.getFloat32(4, true), d.getFloat32(8, true)],
    rotation: [d.getFloat32(12, true), d.getFloat32(16, true), d.getFloat32(20, true)],
    scale: record.fields.f32('XSCL') ?? 1,
  };
}

/** Native implementations by lowercase "script.function". */
export type NativeRegistry = Map<string, NativeFunction>;

/** The player's controls (Game.EnablePlayerControls). */
export interface Controls {
  movement: boolean;
  fighting: boolean;
  camSwitch: boolean;
  looking: boolean;
  sneaking: boolean;
  menu: boolean;
  activate: boolean;
  journalTabs: boolean;
  disablePov: number;
  aiDriven: boolean;
}

/** Where the world shows a reference now; `cell` (and `world`) where it walked to. */
export interface LivePlacement {
  readonly position: Vec3;
  readonly rotation?: Vec3;
  readonly cell?: number;
  readonly world?: number;
}

export interface Placement {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly cell: number | undefined;
  readonly world: number | undefined;
  readonly scale: number;
}

const CELL_INTERIOR = 0x01;

/** The globals the engine keeps as its clock (UESP: GameHour, GameDaysPassed, ...). */
type ClockGlobal = 'hour' | 'days' | 'day' | 'month' | 'year' | 'timescale';
const CLOCK_GLOBALS: Readonly<Record<string, ClockGlobal>> = {
  gamehour: 'hour',
  gamedayspassed: 'days',
  gameday: 'day',
  gamemonth: 'month',
  gameyear: 'year',
  timescale: 'timescale',
};

/** Unbound (MQ101), Skyrim.esm: the opening a new game starts with. */
const OPENING_QUEST = 0x03372b;

/** Condition run-on names, for reports. */
const RUN_ON = [
  'subject',
  'target',
  'reference',
  'combat target',
  'linked reference',
  'quest alias',
  'package data',
  'event data',
];

export class ScriptRuntime implements VmHost {
  readonly forms: FormIndex;
  readonly state = new GameState();
  readonly vm: PapyrusVm;
  readonly quests: QuestEngine;
  readonly storyManager: StoryManager;
  readonly actors: ActorEngine;
  /** While a new game starts its quests (their aliases may take reserved references). */
  startingNewGame = false;
  /** Game seconds per real second (the TimeScale global; scripts may set it). */
  timeScale = DEFAULT_TIME_SCALE;
  /** A script moved the clock (set GameHour, ...): the engine takes the clock from here. */
  clockChanged = false;
  /** The world on screen (none once the game is retired). */
  world: WorldBridge;
  /** Thrown away for a new game: its scripts no longer reach the world. */
  retired = false;
  readonly controls: Controls = {
    movement: true,
    fighting: true,
    camSwitch: true,
    looking: true,
    sneaking: true,
    menu: true,
    activate: true,
    journalTabs: true,
    disablePov: 0,
    aiDriven: false,
  };
  chargen = { noSaving: false, noWaiting: false, controlsMessage: false };
  fastTravelEnabled = true;
  hudCartMode = false;
  perkPoints = 0;
  lastHorse: number | undefined;
  inMenuMode = false;
  frameRate = 60;
  readonly stats = new Map<string, number>();
  /** Words of power: learned (false) or unlocked (true). */
  readonly wordsLearned = new Map<number, boolean>();
  readonly iniOverrides = new Map<string, Value>();
  /** Debug.Trace lines (the Papyrus log). */
  log: (line: string) => void;
  readonly #natives: NativeRegistry = new Map();
  #warn: (message: string) => void;
  /** References → the aliases that hold them ("quest:alias"). */
  readonly #aliasesOf = new Map<number, Set<string>>();
  readonly #updates = new Map<string, number>();
  #updateToken = 1;
  /** Animation event registrations: sender → event → receivers (handle keys and handles). */
  readonly #animationEvents = new Map<number, Map<string, Map<string, ObjectHandle>>>();
  readonly #animationWaiters = new Map<string, (() => void)[]>();
  readonly #registrations = new Map<string, Map<string, ObjectHandle>>();
  readonly #formListAdded = new Map<number, number[]>();
  readonly #inventoryFilters = new Map<string, Set<number>>();
  readonly #scenes = new Set<number>();
  /** Actors in a playing scene (TODO(M10): scenes cast their actors). */
  readonly sceneActors = new Map<number, number>();
  readonly #lineOfSight = new Map<
    string,
    { target: ObjectHandle; viewer: number; seen: number; mode: 'both' | 'gain' | 'lost' }
  >();
  /** Skill uses (AdvanceSkill) and levels (IncrementSkill) scripts gave (TODO(M11): skills). */
  readonly skillUses = new Map<string, number>();
  readonly skillIncrements = new Map<string, number>();
  readonly #mapMarkers = new Map<number, { visible: boolean; travel: boolean }>();
  readonly #seeded = new Set<number>();
  readonly #locations = new Map<number, Promise<LocationRecord | undefined>>();
  #persistent: Promise<PersistentIndex> | undefined;
  /** References whose scripts have started (OnInit): persistent ones at the game's start. */
  readonly #initialized = new Set<number>();
  readonly #clockGlobals = new Map<number, ClockGlobal>();
  #globalsByName: Promise<Map<string, { formId: number; value: number | undefined }>> | undefined;
  #index: PersistentIndex | undefined;
  readonly #keywordCache = new Map<number, Promise<number[]>>();
  readonly #cellLocations = new Map<number, Promise<number | undefined>>();
  #settings: Promise<GameSettings> | undefined;
  #startDate: GameDate | undefined;
  #startDays = 0;

  constructor(
    db: RecordDatabase,
    library: ScriptLibrary,
    options: {
      readonly world?: WorldBridge;
      readonly scheduler?: PapyrusScheduler;
      readonly warn?: (message: string) => void;
      readonly log?: (line: string) => void;
    } = {},
  ) {
    this.forms = new FormIndex(db);
    this.world = options.world ?? {};
    this.#warn = options.warn ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
    this.vm = new PapyrusVm(library, this, options.scheduler ?? new PapyrusScheduler());
    this.quests = new QuestEngine(this);
    this.storyManager = new StoryManager(this);
    this.actors = new ActorEngine(this);
    registerNatives(this.#natives, this);
  }

  // --- VmHost --------------------------------------------------------------------------------

  async formType(target: ObjectHandle): Promise<string | undefined> {
    if (this.state.activeEffects.has(target.key)) return 'activemagiceffect';
    const created = target.alias < 0 ? this.state.created.get(target.formId) : undefined;
    if (created) {
      const base = await this.forms.record(created.base);
      return base?.type === 'NPC_' || base?.type === 'LVLN' ? 'actor' : 'objectreference';
    }
    // A persistent reference's type is in the index (no read).
    if (target.alias < 0 && this.#index?.flags.has(target.formId)) {
      return this.#index.actors.has(target.formId) ? 'actor' : 'objectreference';
    }
    return this.forms.scriptType(target);
  }

  async attachedScripts(target: ObjectHandle): Promise<readonly AttachedScriptInfo[]> {
    // An active magic effect runs its base effect's scripts.
    const effect = this.state.activeEffects.get(target.key);
    if (effect) return this.forms.attachedScripts(new ObjectHandle(effect.effect, 'form'));
    const created = target.alias < 0 ? this.state.created.get(target.formId) : undefined;
    // A created reference runs its base object's scripts.
    if (created) return this.forms.attachedScripts(new ObjectHandle(created.base, 'form'));
    // A persistent reference without scripts of its own runs its base's (no read of its own).
    const base = target.alias < 0 ? this.#index?.base.get(target.formId) : undefined;
    if (
      base !== undefined &&
      target.formId !== PLAYER_REF &&
      !this.#index?.scripted.has(target.formId)
    ) {
      return this.forms.attachedScripts(new ObjectHandle(base, 'form'));
    }
    return this.forms.attachedScripts(target);
  }

  native(script: string, fn: string): NativeFunction | undefined {
    return this.#natives.get(`${script}.${fn}`);
  }

  warn(message: string): void {
    this.#warn(message);
  }

  /**
   * Work that goes on by itself (events sent, waits, story events): a fault in it (a broken
   * record) is reported, never left to stop the app.
   */
  /**
   * Throws this game away (a new game replaces it): what its scripts still do reaches neither
   * the world nor the log. Its threads stop with the frames that no longer run them.
   */
  retire(): void {
    this.retired = true;
    this.world = {};
    this.#warn = () => undefined;
    this.log = () => undefined;
  }

  detach(work: Promise<unknown>): void {
    work.catch((error: unknown) => {
      this.warn(`background fault: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // --- Handles ---------------------------------------------------------------------------------

  /** A reference as a script object (its type is found when a script calls on it). */
  referenceHandle(reference: number): ObjectHandle {
    return new ObjectHandle(reference, 'objectreference');
  }

  referenceHandleOrNone(reference: number | undefined): Value {
    return reference === undefined ? null : this.referenceHandle(reference);
  }

  actorHandle(reference: number): ObjectHandle {
    return new ObjectHandle(reference, 'actor');
  }

  actorHandleOrNone(reference: number | undefined): Value {
    return reference === undefined ? null : this.actorHandle(reference);
  }

  formHandle(formId: number): ObjectHandle {
    return new ObjectHandle(formId, 'form');
  }

  /** The reference an object handle stands for: an alias's, or the form itself. */
  reference(target: Value): number | undefined {
    if (!(target instanceof ObjectHandle)) return undefined;
    if (target.alias < 0) return target.formId;
    return this.state.quests.get(target.formId)?.aliases.get(target.alias);
  }

  // --- Events -----------------------------------------------------------------------------------

  /** An event to a form's scripts, and for a reference to the aliases that hold it. */
  async sendEvent(target: number, event: string, args: readonly Value[] = []): Promise<void> {
    const sends = [this.vm.sendEvent(new ObjectHandle(target, 'form'), event, args)];
    for (const key of this.#aliasesOf.get(target) ?? []) {
      const [quest = 0, alias = 0] = key.split(':').map(Number);
      sends.push(this.vm.sendEvent(new ObjectHandle(quest, 'form', alias), event, args));
    }
    await Promise.all(sends);
  }

  // --- What the engine tells the scripts ---------------------------------------------------

  /**
   * A cell became part of the loaded area with these references (`loaded`: those whose 3D
   * is there, the enabled ones). A reference's scripts start (OnInit) the first time it comes
   * into existence (persistent ones did at the game's start); then, as the Creation Kit's
   * events describe: OnCellAttach for the cell's references, OnLoad for the loaded ones, and
   * OnCellLoad once every object's 3D in the cell is there. Returns those with scripts.
   */
  async cellAttached(
    references: readonly number[],
    loaded: (reference: number) => boolean,
  ): Promise<number[]> {
    const scripted: number[] = [];
    for (const reference of references) {
      if (await this.#hasScripts(reference)) scripted.push(reference);
    }
    for (const reference of scripted) {
      if (this.#initialized.has(reference)) continue;
      this.#initialized.add(reference);
      await this.vm.startInitialize(this.referenceHandle(reference));
    }
    const sends: Promise<void>[] = [];
    for (const reference of scripted) sends.push(this.sendEvent(reference, 'OnCellAttach'));
    for (const reference of scripted)
      if (loaded(reference)) sends.push(this.sendEvent(reference, 'OnLoad'));
    for (const reference of scripted)
      if (loaded(reference)) sends.push(this.sendEvent(reference, 'OnCellLoad'));
    this.detach(Promise.all(sends));
    return scripted;
  }

  /** A cell left the loaded area: OnCellDetach for its references, OnUnload for the loaded. */
  async cellDetached(
    references: readonly number[],
    loaded: (reference: number) => boolean,
  ): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const reference of references) {
      if (!(await this.#hasScripts(reference))) continue;
      if (loaded(reference)) sends.push(this.sendEvent(reference, 'OnUnload'));
      sends.push(this.sendEvent(reference, 'OnCellDetach'));
    }
    this.detach(Promise.all(sends));
  }

  /**
   * The player activated a reference: its scripts get OnActivate (on their own threads, as the
   * game sends it). Returns whether the engine does what activating it does by default (open a
   * door, take an item): not while a script blocks its activation.
   */
  playerActivated(reference: number): boolean {
    this.detach(this.sendEvent(reference, 'OnActivate', [this.actorHandle(PLAYER_REF)]));
    return this.state.references.get(reference)?.activationBlocked !== true;
  }

  /** Something entered or left a reference's trigger volume (OnTriggerEnter / OnTriggerLeave). */
  triggered(reference: number, actor: number, entered: boolean): void {
    this.detach(
      this.sendEvent(reference, entered ? 'OnTriggerEnter' : 'OnTriggerLeave', [
        this.referenceHandle(actor),
      ]),
    );
  }

  async #hasScripts(reference: number): Promise<boolean> {
    if (this.#index?.scripted.has(reference)) return true;
    const base = await this.baseOf(reference);
    if (base !== undefined && (await this.forms.attachments(base)) !== undefined) return true;
    return (await this.forms.record(reference))?.fields.has('VMAD') === true;
  }

  aliasFilled(quest: number, alias: number, reference: number): void {
    const set = this.#aliasesOf.get(reference) ?? new Set();
    set.add(`${String(quest)}:${String(alias)}`);
    this.#aliasesOf.set(reference, set);
  }

  aliasCleared(quest: number, alias: number, reference: number): void {
    this.#aliasesOf.get(reference)?.delete(`${String(quest)}:${String(alias)}`);
    this.quests.filler.released(quest, alias, reference);
  }

  /** The aliases that hold a reference. */
  aliasesHolding(reference: number): { quest: number; alias: number }[] {
    return [...(this.#aliasesOf.get(reference) ?? [])].map((key) => {
      const [quest = 0, alias = 0] = key.split(':').map(Number);
      return { quest, alias };
    });
  }

  forceAlias(quest: number, alias: number, filled: number): void {
    const aliases = this.state.quest(quest).aliases;
    const previous = aliases.get(alias);
    if (previous !== undefined) this.aliasCleared(quest, alias, previous);
    aliases.set(alias, filled);
    this.aliasFilled(quest, alias, filled);
  }

  clearAlias(quest: number, alias: number): void {
    const aliases = this.state.quests.get(quest)?.aliases;
    const previous = aliases?.get(alias);
    if (previous === undefined) return;
    this.aliasCleared(quest, alias, previous);
    aliases?.delete(alias);
  }

  // --- Registrations ----------------------------------------------------------------------

  /** RegisterForUpdate / SingleUpdate (real seconds) and their GameTime forms (game hours). */
  registerUpdate(
    target: ObjectHandle | null,
    interval: number,
    gameTime: boolean,
    repeat: boolean,
  ): null {
    if (!target) return null;
    const key = `${target.key}:${gameTime ? 'game' : 'real'}`;
    const token = this.#updateToken++;
    this.#updates.set(key, token);
    const event = gameTime ? 'OnUpdateGameTime' : 'OnUpdate';
    const scheduler = this.vm.scheduler;
    const fire = (): void => {
      const wait = gameTime ? scheduler.waitGame(interval) : scheduler.waitReal(interval);
      this.detach(
        wait.then(async () => {
          if (this.#updates.get(key) !== token) return;
          if (!repeat) this.#updates.delete(key);
          else fire();
          await this.#sendTo(target, event, []);
        }),
      );
    };
    fire();
    return null;
  }

  unregisterUpdate(target: ObjectHandle | null, gameTime: boolean): null {
    if (target) this.#updates.delete(`${target.key}:${gameTime ? 'game' : 'real'}`);
    return null;
  }

  /** An event to a form or an alias (registrations: the object that registered). */
  #sendTo(target: ObjectHandle, event: string, args: readonly Value[]): Promise<void> {
    return this.vm.sendEvent(new ObjectHandle(target.formId, 'form', target.alias), event, args);
  }

  registerAnimationEvent(
    target: ObjectHandle | null,
    sender: Value,
    event: string,
    on: boolean,
  ): boolean {
    const reference = this.reference(sender);
    if (!target || reference === undefined) return false;
    const events =
      this.#animationEvents.get(reference) ?? new Map<string, Map<string, ObjectHandle>>();
    this.#animationEvents.set(reference, events);
    const lower = event.toLowerCase();
    const receivers = events.get(lower) ?? new Map<string, ObjectHandle>();
    events.set(lower, receivers);
    if (on) receivers.set(target.key, target);
    else receivers.delete(target.key);
    return true;
  }

  /** The engine: a reference's behavior graph raised an event (OnAnimationEvent, waits). */
  animationEvent(reference: number, event: string): void {
    const lower = event.toLowerCase();
    for (const receiver of this.#animationEvents.get(reference)?.get(lower)?.values() ?? []) {
      this.detach(
        this.#sendTo(receiver, 'OnAnimationEvent', [this.referenceHandle(reference), event]),
      );
    }
    const key = `${String(reference)}:${lower}`;
    const waiters = this.#animationWaiters.get(key);
    this.#animationWaiters.delete(key);
    for (const resume of waiters ?? []) resume();
  }

  /** Resolves when a reference's graph raises an event (PlayAnimationAndWait). */
  animationEventRaised(reference: number, event: string): Promise<void> {
    if (!this.world.animationEvent) return Promise.resolve();
    const key = `${String(reference)}:${event.toLowerCase()}`;
    return new Promise((resume) => {
      const waiters = this.#animationWaiters.get(key) ?? [];
      waiters.push(resume);
      this.#animationWaiters.set(key, waiters);
    });
  }

  /** Sleep and tracked stats registrations (the engine sends their events). */
  registerFor(kind: 'sleep' | 'trackedstats', target: ObjectHandle | null, on: boolean): null {
    if (!target) return null;
    const receivers = this.#registrations.get(kind) ?? new Map<string, ObjectHandle>();
    this.#registrations.set(kind, receivers);
    if (on) receivers.set(target.key, target);
    else receivers.delete(target.key);
    return null;
  }

  /** The engine: an event to every object registered for a kind (OnSleepStart, ...). */
  async registeredEvent(
    kind: 'sleep' | 'trackedstats',
    event: string,
    args: readonly Value[],
  ): Promise<void> {
    await Promise.all(
      [...(this.#registrations.get(kind)?.values() ?? [])].map((target) =>
        this.#sendTo(target, event, args),
      ),
    );
  }

  /**
   * RegisterForLOS (OnGainLOS and OnLostLOS until unregistered) and its single forms (one
   * OnGainLOS or one OnLostLOS). Detection decides when sight changes (TODO(M10)).
   */
  registerLineOfSight(target: ObjectHandle | null, viewer: Value, seen: Value, kind: string): null {
    const from = this.reference(viewer);
    const to = this.reference(seen);
    if (!target) return null;
    if (kind === 'unregisterforlos') {
      for (const [key, registration] of this.#lineOfSight) {
        if (
          registration.target.sameObject(target) &&
          registration.viewer === from &&
          registration.seen === to
        ) {
          this.#lineOfSight.delete(key);
        }
      }
      return null;
    }
    if (from === undefined || to === undefined) return null;
    const mode =
      kind === 'registerforsinglelosgain'
        ? 'gain'
        : kind === 'registerforsingleloslost'
          ? 'lost'
          : 'both';
    this.#lineOfSight.set(`${target.key}:${String(from)}:${String(to)}:${mode}`, {
      target,
      viewer: from,
      seen: to,
      mode,
    });
    return null;
  }

  /** Viewer → seen pairs scripts watch (detection reports their changes). */
  get lineOfSightWatched(): { viewer: number; seen: number }[] {
    return [...this.#lineOfSight.values()].map(({ viewer, seen }) => ({ viewer, seen }));
  }

  /** The engine: a viewer gained or lost sight of a reference (OnGainLOS / OnLostLOS). */
  lineOfSightChanged(viewer: number, seen: number, gained: boolean): void {
    for (const [key, registration] of this.#lineOfSight) {
      if (registration.viewer !== viewer || registration.seen !== seen) continue;
      if (registration.mode === (gained ? 'lost' : 'gain')) continue;
      if (registration.mode !== 'both') this.#lineOfSight.delete(key);
      this.detach(
        this.#sendTo(registration.target, gained ? 'OnGainLOS' : 'OnLostLOS', [
          this.referenceHandle(viewer),
          this.referenceHandle(seen),
        ]),
      );
    }
  }

  inventoryFilter(
    target: ObjectHandle | null,
    form: number | undefined,
    action: 'add' | 'remove' | 'clear',
  ): null {
    if (!target) return null;
    const filters = this.#inventoryFilters.get(target.key) ?? new Set<number>();
    this.#inventoryFilters.set(target.key, filters);
    if (action === 'clear') filters.clear();
    else if (form !== undefined) {
      if (action === 'add') filters.add(form);
      else filters.delete(form);
    }
    return null;
  }

  // --- Forms ---------------------------------------------------------------------------------

  /** A form list's forms, with those scripts added (AddForm). */
  async formList(formId: number): Promise<number[]> {
    return [...(await this.forms.formList(formId)), ...(this.#formListAdded.get(formId) ?? [])];
  }

  formListAdd(list: number, form: number): void {
    const added = this.#formListAdded.get(list) ?? [];
    if (!added.includes(form)) added.push(form);
    this.#formListAdded.set(list, added);
  }

  formListRemove(list: number, form: number): void {
    const added = this.#formListAdded.get(list);
    if (added)
      this.#formListAdded.set(
        list,
        added.filter((entry) => entry !== form),
      );
  }

  formListRevert(list: number): void {
    this.#formListAdded.delete(list);
  }

  /**
   * A form's keywords (KWDA); a reference's are its base's, an actor's its keywords NPC_'s,
   * with those of the aliases that hold it (Creation Kit: an alias's keywords).
   */
  async keywords(formId: number): Promise<number[]> {
    let base = this.#index?.base.get(formId) ?? this.state.created.get(formId)?.base;
    let reference = base !== undefined;
    if (base === undefined) {
      const record = await this.forms.record(formId);
      reference = record?.type === 'REFR' || record?.type === 'ACHR' || record?.type === 'PGRE';
      base = reference ? record?.formIdField('NAME') : formId;
    }
    if (reference) {
      const info = await this.actors.info(formId);
      if (info) base = info.keywords.formId;
    }
    const own = base === undefined ? [] : await this.#formKeywords(base);
    const aliases = reference ? this.aliasesHolding(formId) : [];
    if (aliases.length === 0) return own;
    const all = [...own];
    for (const { quest, alias } of aliases) {
      all.push(...((await this.forms.alias(quest, alias))?.keywords ?? []));
    }
    return all;
  }

  /** A base form's own keywords (KWDA), read once. */
  #formKeywords(formId: number): Promise<number[]> {
    let pending = this.#keywordCache.get(formId);
    if (!pending) {
      pending = this.forms.record(formId).then((record) => {
        const data = record?.fields.first('KWDA');
        const keywords: number[] = [];
        for (let at = 0; data && record && at + 4 <= data.length; at += 4) {
          keywords.push(record.formIdAt(data, at));
        }
        return keywords;
      });
      this.#keywordCache.set(formId, pending);
    }
    return pending;
  }

  async hasKeyword(formId: number, keyword: number): Promise<boolean> {
    return (await this.keywords(formId)).includes(keyword);
  }

  /** A form's value in gold (DATA of items: its first u32). */
  async goldValue(formId: number): Promise<number> {
    const record = await this.forms.record(formId);
    const data = record?.fields.first('DATA');
    return data && data.length >= 4 ? view(data).getInt32(0, true) : 0;
  }

  /** Whether the player knows a form (spells, shouts, recipes; TODO(M11)). */
  playerKnows(formId: number): boolean {
    return this.wordsLearned.has(formId);
  }

  async gameSetting(name: string): Promise<number | string | undefined> {
    this.#settings ??= GameSettings.read(this.forms.db);
    const settings = await this.#settings;
    return name.toLowerCase().startsWith('s') ? settings.string(name) : settings.number(name);
  }

  // --- References ---------------------------------------------------------------------------

  async baseOf(reference: number): Promise<number | undefined> {
    if (reference === PLAYER_REF) return PLAYER_BASE;
    const created = this.state.created.get(reference);
    if (created) return created.base;
    const indexed = this.#index?.base.get(reference);
    if (indexed !== undefined) return indexed;
    return (await this.forms.record(reference))?.formIdField('NAME');
  }

  /** Whether a reference is enabled: its own state, or its enable parent's. */
  async isEnabled(reference: number, depth = 0): Promise<boolean> {
    const state = this.state.references.get(reference);
    if (state?.deleted) return false;
    // A persistent reference's enable parent and flags are in the index (no read).
    const indexed = this.#index?.flags.get(reference);
    let parent: { readonly reference: number; readonly opposite: boolean } | undefined;
    let initiallyDisabled: boolean;
    if (indexed !== undefined) {
      parent = this.#index?.enableParent.get(reference);
      initiallyDisabled = (indexed & RecordFlag.initiallyDisabled) !== 0;
    } else {
      const record = await this.forms.record(reference);
      const xesp = record?.fields.first('XESP');
      if (record && xesp && xesp.length >= 5) {
        parent = { reference: record.formIdAt(xesp), opposite: ((xesp[4] ?? 0) & 1) !== 0 };
      }
      initiallyDisabled =
        record !== undefined && (record.flags & RecordFlag.initiallyDisabled) !== 0;
    }
    if (parent && depth < 16) {
      const enabled = await this.isEnabled(parent.reference, depth + 1);
      return parent.opposite ? !enabled : enabled;
    }
    if (state?.enabled !== undefined) return state.enabled;
    return !initiallyDisabled;
  }

  /** Whether a persistent reference is an actor (ACHR), from the index. */
  isIndexedActor(reference: number): boolean {
    return this.#index?.actors.has(reference) ?? false;
  }

  /** A persistent reference's record flags, if it is one (from the index, no read). */
  indexedFlags(reference: number): number | undefined {
    return this.#index?.flags.get(reference);
  }

  async setEnabled(reference: number, enabled: boolean): Promise<void> {
    const record = await this.forms.record(reference);
    if (record?.fields.has('XESP')) {
      // The engine ignores Enable/Disable on references with an enable parent.
      this.vm.warn(
        `${record.editorId ?? reference.toString(16)}: has an enable parent, Enable/Disable ignored`,
      );
      return;
    }
    if ((await this.isEnabled(reference)) === enabled) return;
    this.state.reference(reference).enabled = enabled;
    this.world.enableChanged?.(reference, enabled);
  }

  async linkedReference(reference: number, keyword: number): Promise<number | undefined> {
    const own = this.state.references.get(reference)?.links?.get(keyword);
    if (own !== undefined) return own === 0 ? undefined : own;
    const record = await this.forms.record(reference);
    return record ? linkedReferences(record).get(keyword) : undefined;
  }

  /** XLRT: the location reference types a reference has. */
  async referenceTypes(reference: number): Promise<number[]> {
    const record = await this.forms.record(reference);
    return record?.fields.all('XLRT').map((data) => record.formIdAt(data)) ?? [];
  }

  /** XAPR: the references that activate this one. */
  async activateParents(reference: number): Promise<number[]> {
    const record = await this.forms.record(reference);
    return record?.fields.all('XAPR').map((data) => record.formIdAt(data)) ?? [];
  }

  async voiceType(reference: number): Promise<number | undefined> {
    const base = await this.baseOf(reference);
    const record = base === undefined ? undefined : await this.forms.record(base);
    return record?.formIdField(record.type === 'TACT' ? 'VNAM' : 'VTCK');
  }

  /** XLOC: whether it is locked, its level (1 novice .. 100 master, 255 a key), its key. */
  async lock(
    reference: number,
  ): Promise<{ locked: boolean; level: number; key: number | undefined }> {
    const record = await this.forms.record(reference);
    const xloc = record?.fields.first('XLOC');
    const state = this.state.references.get(reference);
    return {
      locked: state?.locked ?? xloc !== undefined,
      level: state?.lockLevel ?? xloc?.[0] ?? 0,
      key: xloc && record && xloc.length >= 8 ? record.formIdAt(xloc, 4) || undefined : undefined,
    };
  }

  /** XOWN: its owner (an actor base or a faction), as scripts left it. */
  async owner(
    reference: number,
  ): Promise<{ actor: number | undefined; faction: number | undefined }> {
    const state = this.state.references.get(reference);
    if (state?.ownerActor !== undefined || state?.ownerFaction !== undefined) {
      return { actor: nonZero(state.ownerActor), faction: nonZero(state.ownerFaction) };
    }
    const record = await this.forms.record(reference);
    const owner = record?.formIdField('XOWN');
    const type = owner === undefined ? undefined : (await this.forms.record(owner))?.type;
    return {
      actor: type === 'NPC_' ? owner : undefined,
      faction: type === 'FACT' ? owner : undefined,
    };
  }

  /**
   * Where a reference is: where the world shows it now (`live`), else where scripts put it,
   * else where the plugin placed it. Without `live`, where scripts last put it (a MoveTo on the
   * player, before the world has taken them there).
   */
  async placement(reference: number, live = true): Promise<Placement | undefined> {
    const state = this.state.references.get(reference);
    const shown = live ? this.world.livePlacement?.(reference) : undefined;
    const editor = await this.#editorPlacement(reference);
    const position = shown?.position ?? state?.position ?? editor?.position;
    if (!position) return undefined;
    const rotation = shown?.rotation ?? state?.rotation ?? editor?.rotation ?? [0, 0, 0];
    const scale = state?.scale ?? editor?.scale ?? 1;
    // The cell it walked into (the player through a door) over the one a script left it in.
    if (shown?.cell !== undefined) {
      return { position, rotation, cell: shown.cell, world: shown.world, scale };
    }
    const editorCell = this.forms.db.cellOfReference(reference);
    const cell = state?.cell ?? editorCell;
    return {
      position,
      rotation,
      cell,
      world: state?.world ?? (cell === undefined ? undefined : this.forms.db.worldOfCell(cell)),
      scale,
    };
  }

  /** Where the plugin places a reference (DATA, XSCL): a persistent one's from the index. */
  async #editorPlacement(reference: number): Promise<EditorPlacement | undefined> {
    const indexed = this.#index?.placement.get(reference);
    if (indexed) return indexed;
    if (this.#index?.flags.has(reference)) return undefined;
    const record = await this.forms.record(reference);
    return record ? editorPlacementOf(record) : undefined;
  }

  move(reference: number, position: Vec3, rotation?: Vec3, cell?: number, world?: number): void {
    const state = this.state.reference(reference);
    state.position = position;
    if (rotation) state.rotation = rotation;
    if (cell !== undefined) {
      state.cell = cell;
      state.world = world;
    }
    this.world.moved?.(reference);
  }

  moveToEditorLocation(reference: number): void {
    const state = this.state.reference(reference);
    delete state.position;
    delete state.rotation;
    delete state.cell;
    delete state.world;
    this.world.moved?.(reference);
  }

  /** TranslateTo: the engine moves it there; done after the distance at the speed. */
  async translate(reference: number, position: Vec3, rotation: Vec3, speed: number): Promise<void> {
    const from = await this.placement(reference);
    const distance = from
      ? Math.hypot(
          position[0] - from.position[0],
          position[1] - from.position[1],
          position[2] - from.position[2],
        )
      : 0;
    const token = this.#updateToken++;
    this.#updates.set(`${String(reference)}:translation`, token);
    this.detach(
      this.vm.scheduler.waitReal(speed > 0 ? distance / speed : 0).then(async () => {
        if (this.#updates.get(`${String(reference)}:translation`) !== token) return;
        this.#updates.delete(`${String(reference)}:translation`);
        this.move(reference, position, rotation);
        await this.sendEvent(reference, 'OnTranslationComplete');
      }),
    );
  }

  stopTranslation(reference: number): void {
    this.#updates.delete(`${String(reference)}:translation`);
  }

  /** The location (LCTN) of the cell a reference is in (CELL XLCN). */
  async locationOf(reference: number): Promise<number | undefined> {
    const at = await this.placement(reference);
    let cell = at?.cell;
    if (at?.world !== undefined) {
      // A persistent reference of a worldspace: the exterior cell it stands in.
      cell = await this.forms.db.exteriorCell(
        at.world,
        Math.floor(at.position[0] / 4096),
        Math.floor(at.position[1] / 4096),
      );
    }
    return cell === undefined ? undefined : (await this.forms.record(cell))?.formIdField('XLCN');
  }

  /**
   * Its editor location: its own persist location (XLCN), else that of the cell it was placed
   * in (for a worldspace's persistent references, the exterior cell at its place).
   */
  async editorLocation(reference: number): Promise<number | undefined> {
    const indexed = this.#index?.flags.has(reference) === true;
    const own = indexed
      ? this.#index?.persistLocation.get(reference)
      : (await this.forms.record(reference))?.formIdField('XLCN');
    if (own !== undefined) return own;
    let cell = this.forms.db.cellOfReference(reference);
    const world = cell === undefined ? undefined : this.forms.db.worldOfCell(cell);
    if (world !== undefined && cell === this.forms.db.persistentCell(world)) {
      const at = (await this.#editorPlacement(reference))?.position;
      if (at)
        cell = await this.forms.db.exteriorCell(
          world,
          Math.floor(at[0] / 4096),
          Math.floor(at[1] / 4096),
        );
    }
    return cell === undefined ? undefined : this.#cellLocation(cell);
  }

  /** A cell's location (XLCN), read once per cell. */
  #cellLocation(cell: number): Promise<number | undefined> {
    let pending = this.#cellLocations.get(cell);
    if (!pending) {
      pending = this.forms.record(cell).then((record) => record?.formIdField('XLCN'));
      this.#cellLocations.set(cell, pending);
    }
    return pending;
  }

  /** The size of its base object's bounds (OBND), at its scale. */
  async bounds(reference: number): Promise<Vec3> {
    const base = await this.baseOf(reference);
    const obnd =
      base === undefined ? undefined : (await this.forms.record(base))?.fields.first('OBND');
    const scale = (await this.placement(reference))?.scale ?? 1;
    if (!obnd || obnd.length < 12) return [0, 0, 0];
    const v = view(obnd);
    return [0, 1, 2].map(
      (i) => (v.getInt16(6 + i * 2, true) - v.getInt16(i * 2, true)) * scale,
    ) as Vec3;
  }

  /** Its Havok mass (its loaded bodies'; 0 while not loaded, as in the game). */
  mass(reference: number): number {
    return this.world.mass?.(reference) ?? 0;
  }

  async isInterior(reference: number): Promise<boolean> {
    const cell = (await this.placement(reference))?.cell;
    const data =
      cell === undefined ? undefined : (await this.forms.record(cell))?.fields.first('DATA');
    return data !== undefined && ((data[0] ?? 0) & CELL_INTERIOR) !== 0;
  }

  setOpen(reference: number, open: boolean): void {
    this.state.reference(reference).openState = open ? 1 : 3;
    this.world.openChanged?.(reference, open);
  }

  /** GetOpenState: 1 open, 3 closed (as scripts or the plugin left it: ONAM open by default). */
  async openState(reference: number): Promise<number> {
    const set = this.state.references.get(reference)?.openState;
    if (set !== undefined) return set;
    const record = await this.forms.record(reference);
    return record?.fields.has('ONAM') ? 1 : 3;
  }

  /** DamageObject: through its destruction stages (TODO(M11): its base's DSTD stages). */
  async damageObject(reference: number, damage: number): Promise<void> {
    if (damage <= 0) return;
    const state = this.state.reference(reference);
    state.destructionStage = (state.destructionStage ?? 0) + 1;
    this.world.destructionChanged?.(reference);
    await this.sendEvent(reference, 'OnDestructionStageChanged', [
      state.destructionStage - 1,
      state.destructionStage,
    ]);
  }

  /** A map marker shown and reachable (TODO(M9): the map); the plugin's XMRK FNAM at first. */
  mapMarker(reference: number, visible: boolean | undefined, travel: boolean): void {
    const marker = this.#mapMarkers.get(reference) ?? { visible: false, travel: false };
    if (visible !== undefined) marker.visible = visible;
    marker.travel = travel;
    this.#mapMarkers.set(reference, marker);
  }

  mapMarkerVisible(reference: number): boolean {
    return this.#mapMarkers.get(reference)?.visible ?? false;
  }

  mapMarkerFastTravel(reference: number): boolean {
    return this.#mapMarkers.get(reference)?.travel ?? false;
  }

  /** Activate: the scripts' OnActivate (unless default only), then the engine's activation. */
  async activate(
    reference: number,
    activator: number | undefined,
    defaultOnly: boolean,
  ): Promise<boolean> {
    if (!defaultOnly) {
      await this.sendEvent(reference, 'OnActivate', [this.referenceHandleOrNone(activator)]);
    }
    if (!this.state.references.get(reference)?.activationBlocked)
      this.world.activate?.(reference, activator);
    return true;
  }

  /** A new reference (PlaceAtMe, an alias's Create Reference), at or in another one. */
  async createReference(base: number, at: number | undefined, inside: boolean): Promise<number> {
    const formId = this.state.create(base);
    if (inside && at !== undefined) {
      const items = await this.inventory(at);
      items.set(base, (items.get(base) ?? 0) + 1);
      return formId;
    }
    const placement = at === undefined ? undefined : await this.placement(at);
    if (placement) {
      const reference = this.state.reference(formId);
      reference.position = [...placement.position];
      reference.rotation = [...placement.rotation];
      reference.cell = placement.cell;
      reference.world = placement.world;
    }
    this.#initialized.add(formId);
    await this.vm.startInitialize(this.referenceHandle(formId));
    this.world.created?.(formId);
    return formId;
  }

  /** PlaceAtMe: a new reference at another's place, its initialization run. */
  async placeAt(base: number, at: number, count: number): Promise<number> {
    const formId = this.state.create(base, count);
    const placement = await this.placement(at);
    const reference = this.state.reference(formId);
    if (placement) {
      reference.position = [...placement.position];
      reference.rotation = [...placement.rotation];
      reference.cell = placement.cell;
      reference.world = placement.world;
    }
    this.#initialized.add(formId);
    await this.vm.startInitialize(this.referenceHandle(formId));
    this.world.created?.(formId);
    return formId;
  }

  async resetReference(reference: number, target: number | undefined): Promise<void> {
    this.state.references.delete(reference);
    this.state.inventories.delete(reference);
    this.#seeded.delete(reference);
    this.vm.reset(this.referenceHandle(reference));
    if (target !== undefined) {
      const at = await this.placement(target);
      if (at) this.move(reference, [...at.position], [...at.rotation], at.cell, at.world);
    }
    this.world.moved?.(reference);
  }

  // --- Inventories ------------------------------------------------------------------------

  /** A container's items: its own and its base's (CNTO, leveled lists picked), then changes. */
  async inventory(container: number): Promise<Map<number, number>> {
    const items = this.state.inventories.get(container) ?? new Map<number, number>();
    this.state.inventories.set(container, items);
    if (this.#seeded.has(container)) return items;
    this.#seeded.add(container);
    const random = seededRandom(container ^ 0x5bd1e995);
    const base = await this.baseOf(container);
    for (const formId of [container, base]) {
      const record = formId === undefined ? undefined : await this.forms.record(formId);
      for (const cnto of record?.fields.all('CNTO') ?? []) {
        if (!record || cnto.length < 8) continue;
        await this.#addResolved(
          items,
          record.formIdAt(cnto, 0),
          view(cnto).getInt32(4, true),
          random,
        );
      }
    }
    return items;
  }

  /**
   * A leveled list as it stands: its record's entries and those scripts added (AddForm), its
   * chance of none from its global (LVLG) if it has one.
   */
  async leveledList(formId: number): Promise<LeveledList | undefined> {
    const record = await this.forms.record(formId);
    if (record?.type !== 'LVLI' && record?.type !== 'LVLN' && record?.type !== 'LVSP')
      return undefined;
    const list = parseLeveledList(record);
    const added = this.state.leveledAdditions.get(formId) ?? [];
    const chanceNone =
      list.chanceGlobal === undefined
        ? list.chanceNone
        : await globalValue(this, list.chanceGlobal);
    return { ...list, chanceNone, entries: [...list.entries, ...added] };
  }

  async #addResolved(
    items: Map<number, number>,
    form: number,
    count: number,
    random: () => number,
    depth = 0,
  ): Promise<void> {
    const record = await this.forms.record(form);
    if (record?.type === 'LVLI' && depth < 8) {
      const list = await this.leveledList(form);
      if (!list) return;
      // Containers' leveled items are at the player's level (TODO(M11): encounter zones).
      const level = await this.actors.playerLevel();
      if ((list.flags & LeveledFlag.useAll) !== 0) {
        for (const entry of list.entries) {
          if (entry.level <= level)
            await this.#addResolved(items, entry.formId, entry.count * count, random, depth + 1);
        }
      } else {
        const picked = pickLeveled(list, level, random);
        const entry = list.entries.find((e) => e.formId === picked);
        if (picked !== undefined)
          await this.#addResolved(items, picked, (entry?.count ?? 1) * count, random, depth + 1);
      }
      return;
    }
    items.set(form, (items.get(form) ?? 0) + count);
  }

  /** The forms a script names: a form list's, or the form. */
  async #expand(form: Value): Promise<number[]> {
    if (!(form instanceof ObjectHandle)) return [];
    const record = await this.forms.record(form.formId);
    if (record?.type === 'FLST') return this.formList(form.formId);
    const created = this.state.created.get(form.formId);
    return [created?.base ?? form.formId];
  }

  async itemCountOf(container: number, form: Value): Promise<number> {
    const items = await this.inventory(container);
    let count = 0;
    for (const item of await this.#expand(form)) count += items.get(item) ?? 0;
    return count;
  }

  async itemCount(container: number, form: number): Promise<number> {
    return (await this.inventory(container)).get(form) ?? 0;
  }

  async addItem(container: number, form: Value, count: number, silent: boolean): Promise<void> {
    const items = await this.inventory(container);
    for (const item of await this.#expand(form)) {
      const record = await this.forms.record(item);
      if (record?.type === 'LVLI') {
        await this.#addResolved(items, item, count, seededRandom(Date.now() & 0xffffffff));
      } else {
        items.set(item, (items.get(item) ?? 0) + count);
      }
      if (!silent && container === PLAYER_REF) this.world.itemMessage?.(item, count, true);
      this.detach(
        this.sendEvent(container, 'OnItemAdded', [this.formHandle(item), count, null, null]),
      );
    }
  }

  async removeItem(
    container: number,
    form: Value,
    count: number,
    silent: boolean,
    to: number | undefined,
  ): Promise<void> {
    const items = await this.inventory(container);
    for (const item of await this.#expand(form)) {
      const have = items.get(item) ?? 0;
      const moved = Math.min(have, count);
      if (moved <= 0) continue;
      items.set(item, have - moved);
      if (!silent && container === PLAYER_REF) this.world.itemMessage?.(item, moved, false);
      this.detach(
        this.sendEvent(container, 'OnItemRemoved', [
          this.formHandle(item),
          moved,
          null,
          this.referenceHandleOrNone(to),
        ]),
      );
      if (to !== undefined) {
        const other = await this.inventory(to);
        other.set(item, (other.get(item) ?? 0) + moved);
        this.detach(
          this.sendEvent(to, 'OnItemAdded', [
            this.formHandle(item),
            moved,
            null,
            this.referenceHandle(container),
          ]),
        );
      }
    }
  }

  async removeAllItems(container: number, to: number | undefined): Promise<void> {
    const items = await this.inventory(container);
    for (const [item, count] of [...items]) {
      if (count > 0) await this.removeItem(container, this.formHandle(item), count, true, to);
    }
  }

  // --- Actors (the state natives and conditions read; TODO(M11): stats from records) ------

  // --- Locations and cells ------------------------------------------------------------------

  /** A location (LCTN, all its versions merged). */
  location(formId: number): Promise<LocationRecord | undefined> {
    let pending = this.#locations.get(formId);
    if (!pending) {
      pending = this.forms
        .versions(formId)
        .then((versions) =>
          versions.at(-1)?.type === 'LCTN' ? parseLocation(versions) : undefined,
        );
      this.#locations.set(formId, pending);
    }
    return pending;
  }

  /** A location and its parents, nearest first. */
  async locationParents(location: number): Promise<number[]> {
    const chain: number[] = [];
    for (let at: number | undefined = location; at !== undefined && chain.length < 32;) {
      if (chain.includes(at)) break;
      chain.push(at);
      at = (await this.location(at))?.parent;
    }
    return chain;
  }

  /** Whether a location is another or inside it (a child, a grandchild, ...). */
  async locationWithin(location: number, ancestor: number): Promise<boolean> {
    return (await this.locationParents(location)).includes(ancestor);
  }

  /** A cell's owner: as scripts set it, else its XOWN. */
  async cellOwner(
    cell: number,
  ): Promise<{ actor: number | undefined; faction: number | undefined }> {
    const set = this.state.cells.get(cell);
    if (set?.ownerActor !== undefined || set?.ownerFaction !== undefined) {
      return { actor: nonZero(set.ownerActor), faction: nonZero(set.ownerFaction) };
    }
    const owner = (await this.forms.record(cell))?.formIdField('XOWN');
    const type = owner === undefined ? undefined : (await this.forms.record(owner))?.type;
    return {
      actor: type === 'NPC_' ? owner : undefined,
      faction: type === 'FACT' ? owner : undefined,
    };
  }

  // --- Active magic effects (TODO(M11): the magic system starts and ends them) --------------

  /** An effect begins on an actor: its scripts start (OnInit) and get OnEffectStart. */
  async startEffect(
    effect: number,
    target: number,
    caster: number | undefined,
    duration: number,
    magnitude: number,
  ): Promise<ObjectHandle> {
    const handle = new ObjectHandle(this.state.nextEffect++, 'activemagiceffect');
    this.state.activeEffects.set(handle.key, {
      effect,
      target,
      caster,
      elapsed: 0,
      duration,
      magnitude,
    });
    await this.vm.startInitialize(handle);
    this.detach(
      this.vm.sendEvent(handle, 'OnEffectStart', [
        this.actorHandle(target),
        this.actorHandleOrNone(caster),
      ]),
    );
    return handle;
  }

  /** An effect ends (dispelled or run out): OnEffectFinish, then it is gone. */
  async endEffect(key: string): Promise<void> {
    const effect = this.state.activeEffects.get(key);
    if (!effect) return;
    const [formId = '0'] = key.split(':');
    const handle = new ObjectHandle(Number.parseInt(formId, 16), 'activemagiceffect');
    await this.vm.sendEvent(handle, 'OnEffectFinish', [
      this.actorHandle(effect.target),
      this.actorHandleOrNone(effect.caster),
    ]);
    this.state.activeEffects.delete(key);
    this.vm.reset(handle);
  }

  /**
   * The persistent references (always in memory, so found by searches anywhere: Find Matching
   * Reference), read in one pass: their bases, those with scripts of their own, and the
   * references linked (without a keyword) to each.
   */
  persistentIndex(): Promise<PersistentIndex> {
    this.#persistent ??= (async () => {
      const index: PersistentIndex = {
        all: [PLAYER_REF],
        base: new Map([[PLAYER_REF, PLAYER_BASE]]),
        byBase: new Map([[PLAYER_BASE, [PLAYER_REF]]]),
        scripted: new Set(),
        linkedTo: new Map(),
        flags: new Map(),
        enableParent: new Map(),
        actors: new Set(),
        placement: new Map(),
        persistLocation: new Map(),
      };
      const wanted = RecordFlag.persistent | RecordFlag.deleted;
      await this.forms.db.scan(
        ['REFR', 'ACHR'],
        (flags) => (flags & wanted) === RecordFlag.persistent,
        (record) => {
          const reference = record.formId;
          if (reference === PLAYER_REF) return;
          index.all.push(reference);
          const base = record.formIdField('NAME');
          if (base !== undefined) {
            index.base.set(reference, base);
            const list = index.byBase.get(base) ?? [];
            list.push(reference);
            index.byBase.set(base, list);
          }
          if (record.fields.has('VMAD')) {
            index.scripted.add(reference);
            // Kept: a new game starts their scripts (one read each would be slow in the browser).
            this.forms.remember(record.detached());
          }
          index.flags.set(reference, record.flags);
          const placed = editorPlacementOf(record);
          if (placed) index.placement.set(reference, placed);
          const location = record.formIdField('XLCN');
          if (location !== undefined) index.persistLocation.set(reference, location);
          if (record.type === 'ACHR') index.actors.add(reference);
          const xesp = record.fields.first('XESP');
          if (xesp && xesp.length >= 5) {
            index.enableParent.set(reference, {
              reference: record.formIdAt(xesp),
              opposite: ((xesp[4] ?? 0) & 1) !== 0,
            });
          }
          const linked = linkedReferences(record).get(0);
          if (linked !== undefined && linked !== 0) {
            const list = index.linkedTo.get(linked) ?? [];
            list.push(reference);
            index.linkedTo.set(linked, list);
          }
        },
      );
      this.#index = index;
      return index;
    })();
    return this.#persistent;
  }

  /** Dead actors of a base (ActorBase.GetDeadCount). */
  async deadCount(base: number): Promise<number> {
    let count = 0;
    for (const [reference, actor] of this.state.actors) {
      if (!actor.dead) continue;
      const info = await this.actors.info(reference);
      if (info?.base === base || info?.leveled === base) count++;
    }
    return count;
  }

  // --- Time ----------------------------------------------------------------------------------

  /** The hour of the game's day (0..24). */
  get gameHour(): number {
    return (this.state.gameDaysPassed % 1) * 24;
  }

  /** The game's date today (the calendar from the start date on). */
  get date(): GameDate {
    const start = this.#startDate ?? DEFAULT_START_DATE;
    return dateAfter(start, Math.floor(this.state.gameDaysPassed) - Math.floor(this.#startDays));
  }

  /** 0 Sundas .. 6 Loredas. */
  get dayOfWeek(): number {
    return (
      (START_DAY_OF_WEEK +
        Math.floor(this.state.gameDaysPassed) -
        Math.floor(this.#startDays) +
        7 * 1000) %
      7
    );
  }

  /** Utility.GameTimeToString: "MM/DD/YYYY HH:MM" (the Creation Kit wiki's format). */
  gameTimeString(days: number): string {
    const start = this.#startDate ?? { year: 201, month: 7, day: 17 };
    const date = dateAfter(start, Math.floor(days) - Math.floor(this.#startDays));
    const minutes = Math.floor((days % 1) * 24 * 60);
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return `${pad(date.month + 1)}/${pad(date.day)}/${pad(date.year, 4)} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }

  /** Every frame: the clocks move on (real seconds outside menus, game days). */
  update(realSeconds: number, gameDays: number): void {
    this.state.realTime += realSeconds;
    this.state.gameDaysPassed += gameDays;
    this.vm.scheduler.advance(realSeconds, gameDays);
  }

  /** A frame in a menu (menu mode): only the wall clock moves on (WaitMenuMode). */
  updateInMenu(realSeconds: number): void {
    this.vm.scheduler.advance(0, 0, realSeconds);
  }

  sunPosition(): Vec3 {
    return this.world.sunPosition?.() ?? [0, 0, 0];
  }

  // --- Messages ---------------------------------------------------------------------------

  /** Message.Show: its text (numbers filled in) and buttons; the button chosen. */
  async showMessage(message: number, args: readonly number[]): Promise<number> {
    const record = await this.forms.record(message);
    if (!record) return 0;
    const text = fillNumbers(record.text('DESC') ?? '', args);
    const buttons = record.fields.all('ITXT').map((data) => record.textAt(data));
    this.state.messages.push(text);
    const chosen = await this.world.messageBox?.(text, buttons);
    return typeof chosen === 'number' ? chosen : 0;
  }

  async showHelpMessage(
    message: number,
    event: string,
    seconds: number,
    interval: number,
    times: number,
  ): Promise<void> {
    const record = await this.forms.record(message);
    if (record)
      this.world.helpMessage?.(record.text('DESC') ?? '', event, seconds, interval, times);
  }

  resetHelpMessage(event: string): void {
    this.world.resetHelpMessage?.(event);
  }

  /**
   * A quest's update for the HUD: an objective shown (the quest's first: `first`), completed
   * or failed, or (without an objective) the quest completed or failed. Its texts are filled
   * in as they read now.
   */
  questUpdated(
    quest: number,
    status: QuestUpdate['status'],
    objective?: number,
    first = false,
  ): void {
    this.detach(
      (async () => {
        const record = await this.forms.quest(quest);
        if (!record) return;
        const text =
          objective === undefined
            ? undefined
            : (record.objectives.find((entry) => entry.index === objective)?.text ?? '');
        this.world.questUpdate?.({
          quest,
          name: await questText(this, record, record.name ?? ''),
          type: record.type,
          ...(objective !== undefined && {
            objective: { index: objective, text: await questText(this, record, text ?? '') },
          }),
          status,
          first,
        });
      })(),
    );
  }

  say(
    speaker: number,
    topic: number | undefined,
    speakAs: number | undefined,
    inHead: boolean,
  ): void {
    this.world.say?.(speaker, topic, speakAs, inHead);
  }

  // --- Scenes (TODO(M10): scenes play their phases, packages and dialogue) -------------------

  sceneStart(scene: number): void {
    this.#scenes.add(scene);
  }

  sceneStop(scene: number): void {
    this.#scenes.delete(scene);
  }

  scenePlaying(scene: number): boolean {
    return this.#scenes.has(scene);
  }

  sceneOf(reference: number): number | undefined {
    return this.sceneActors.get(reference);
  }

  // --- Skills (their experience: TODO(M11)), story events, finding references --------------

  advanceSkill(skill: string, magnitude: number): void {
    const key = skill.toLowerCase();
    this.skillUses.set(key, (this.skillUses.get(key) ?? 0) + magnitude);
  }

  incrementSkill(skill: string, count: number): void {
    const key = skill.toLowerCase();
    this.skillIncrements.set(key, (this.skillIncrements.get(key) ?? 0) + count);
  }

  /** Keyword.SendStoryEvent(akLoc, akRef1, akRef2, aiValue1, aiValue2): the script event. */
  storyEvent(keyword: number, args: readonly Value[]): Promise<boolean> {
    const form = (value: Value | undefined): number | undefined => this.reference(value ?? null);
    const number = (value: Value | undefined): number => (typeof value === 'number' ? value : 0);
    return this.storyManager.event(
      scriptEvent(
        keyword,
        form(args[0]),
        form(args[1]),
        form(args[2]),
        number(args[3]),
        number(args[4]),
        {
          form: (id, type) => (id === undefined ? null : new ObjectHandle(id, type)),
        },
      ),
    );
  }

  /** The loaded reference of one of the forms near a point (closest, or one at random). */
  async findReference(
    forms: readonly (number | undefined)[],
    args: readonly Value[],
    closest: boolean,
  ): Promise<number | undefined> {
    const at: Vec3 = [Number(args[1] ?? 0), Number(args[2] ?? 0), Number(args[3] ?? 0)];
    const radius = Number(args[4] ?? 0);
    const wanted = new Set(forms.filter((form): form is number => form !== undefined));
    const found: { reference: number; distance: number }[] = [];
    for (const reference of this.world.loadedReferences?.() ?? []) {
      const base = await this.baseOf(reference);
      if (base === undefined || !wanted.has(base)) continue;
      const placement = await this.placement(reference);
      if (!placement) continue;
      const distance = Math.hypot(
        placement.position[0] - at[0],
        placement.position[1] - at[1],
        placement.position[2] - at[2],
      );
      if (distance <= radius) found.push({ reference, distance });
    }
    if (found.length === 0) return undefined;
    if (closest) return found.sort((a, b) => a.distance - b.distance)[0]?.reference;
    return found[Math.floor(Math.random() * found.length)]?.reference;
  }

  async findActor(at: Vec3, radius: number, closest: boolean): Promise<number | undefined> {
    const found: { reference: number; distance: number }[] = [];
    for (const reference of this.world.loadedReferences?.() ?? []) {
      if ((await this.formType(this.referenceHandle(reference))) !== 'actor') continue;
      const placement = await this.placement(reference);
      if (!placement) continue;
      const distance = Math.hypot(
        placement.position[0] - at[0],
        placement.position[1] - at[1],
        placement.position[2] - at[2],
      );
      if (distance <= radius) found.push({ reference, distance });
    }
    if (found.length === 0) return undefined;
    if (closest) return found.sort((a, b) => a.distance - b.distance)[0]?.reference;
    return found[Math.floor(Math.random() * found.length)]?.reference;
  }

  // --- Conditions -------------------------------------------------------------------------

  /** Whether conditions hold for a subject, grouped as the engine does (unknowns hold). */
  async conditionsHold(
    conditions: readonly Condition[],
    subject: ObjectHandle,
    event?: StoryEventData,
    context: { readonly target?: ObjectHandle; readonly quest?: number } = {},
  ): Promise<boolean> {
    let result = true;
    let group: boolean | undefined;
    for (const condition of conditions) {
      const on = await this.#runsOn(condition, subject, event, context);
      let holds: boolean;
      if (on === 'unknown') {
        this.vm.warn(
          `conditions run on ${RUN_ON[condition.runOn] ?? String(condition.runOn)} are not valued yet`,
        );
        holds = true;
      } else {
        const quest = context.quest ?? (subject.type === 'quest' ? subject.formId : undefined);
        holds = on !== 'none' && (await evaluateCondition(this, condition, on, { event, quest }));
      }
      if (condition.or) group = (group ?? false) || holds;
      else {
        result = result && (group === undefined ? holds : group || holds);
        group = undefined;
      }
    }
    return group === undefined ? result : result && group;
  }

  /** What a condition runs on: a handle, nothing (it fails), or what is not known yet. */
  async #runsOn(
    condition: Condition,
    subject: ObjectHandle,
    event: StoryEventData | undefined,
    context: { readonly target?: ObjectHandle; readonly quest?: number },
  ): Promise<ObjectHandle | 'none' | 'unknown'> {
    switch (condition.runOn) {
      case ConditionRunOn.subject:
        return subject;
      case ConditionRunOn.target:
        return context.target ?? 'unknown';
      case ConditionRunOn.reference:
        return condition.reference === 0 ? 'none' : this.referenceHandle(condition.reference);
      case ConditionRunOn.linkedReference: {
        const reference = this.reference(subject);
        const linked =
          reference === undefined ? undefined : await this.linkedReference(reference, 0);
        return linked === undefined ? 'none' : this.referenceHandle(linked);
      }
      case ConditionRunOn.questAlias: {
        const quest = context.quest ?? (subject.type === 'quest' ? subject.formId : undefined);
        if (quest === undefined) return 'unknown';
        const filled = this.state.quests.get(quest)?.aliases.get(condition.param3);
        return filled === undefined ? 'none' : this.referenceHandle(filled);
      }
      case ConditionRunOn.eventData: {
        const member = event?.forms.get(condition.eventMember);
        return member === undefined ? 'none' : this.referenceHandle(member);
      }
      default:
        // Combat targets (TODO(M10)), package data (TODO(M10)).
        return 'unknown';
    }
  }

  // --- A new game ---------------------------------------------------------------------------

  /**
   * Starts a new game's scripts: the clock at the plugins' date and hour, every quest's and
   * alias's scripts and every persistent reference's initialized (their OnInit), then the
   * quests that start with the game started (a start resets a quest that does not run once:
   * its OnInit runs again).
   */
  async newGame(progress?: (what: string) => void): Promise<void> {
    const db = this.forms.db;
    // The start date: the GameYear, GameMonth and GameDay globals (as readStartDate reads them).
    const whole = async (name: string, fallback: number): Promise<number> => {
      const value = await this.#globalByName(name);
      return value !== undefined && Number.isFinite(value) ? Math.round(value) : fallback;
    };
    this.#startDate = {
      year: await whole('GameYear', DEFAULT_START_DATE.year),
      month: await whole('GameMonth', DEFAULT_START_DATE.month),
      day: await whole('GameDay', DEFAULT_START_DATE.day),
    };
    await this.#findClockGlobals();
    this.timeScale = (await this.#globalByName('TimeScale')) ?? DEFAULT_TIME_SCALE;
    // GameDaysPassed (1 in Skyrim.esm) plus GameHour (8): TODO(M13) whether the engine counts so.
    const hour = await this.#globalByName('GameHour');
    const days = await this.#globalByName('GameDaysPassed');
    this.state.gameDaysPassed = (days ?? 1) + (hour ?? 8) / 24;
    this.#startDays = this.state.gameDaysPassed;
    this.vm.scheduler.gameTime = this.state.gameDaysPassed;
    const quests = db.formIdsOfType('QUST');
    progress?.(`initializing ${String(quests.length)} quests`);
    await db.scan(
      ['QUST'],
      () => true,
      (record) => {
        this.forms.remember(record.detached());
      },
    );
    for (const quest of quests) {
      const record = await this.forms.quest(quest);
      if (record) await this.quests.initialize(record);
    }
    // Persistent references with scripts (their own or their base's).
    const index = await this.persistentIndex();
    const persistent: number[] = [];
    for (const reference of index.all) {
      const base = index.base.get(reference);
      const scripted =
        index.scripted.has(reference) ||
        (base !== undefined && (await this.forms.attachments(base)) !== undefined);
      if (scripted) persistent.push(reference);
    }
    progress?.(`initializing ${String(persistent.length)} persistent references with scripts`);
    for (const formId of persistent) this.#initialized.add(formId);
    await Promise.all(
      persistent.map((formId) => this.vm.startInitialize(this.referenceHandle(formId))),
    );
    const starting: { formId: number; priority: number }[] = [];
    for (const quest of quests) {
      const record = await this.forms.quest(quest);
      if (record && (record.flags & QuestFlag.startGameEnabled) !== 0) {
        starting.push({ formId: quest, priority: record.priority });
      }
    }
    progress?.(`starting ${String(starting.length)} quests that start with the game`);
    // TODO(M13): the engine's order of starting them; here by priority, then form id.
    starting.sort((a, b) => b.priority - a.priority || a.formId - b.formId);
    this.startingNewGame = true;
    for (const { formId } of starting) await this.quests.start(formId);
    this.startingNewGame = false;
    // The opening: no record or script starts Unbound (MQ101); the game does as a new game
    // begins (UESP: "this quest starts automatically when you begin a new game").
    const opening = db.formIdOf('Skyrim.esm', OPENING_QUEST);
    if (opening !== undefined) await this.quests.start(opening);
    await this.vm.idle();
  }

  async #globalByName(name: string): Promise<number | undefined> {
    return (await this.#globals()).get(name.toLowerCase())?.value;
  }

  /** Every global by lower-case editor id, read in one pass. */
  #globals(): Promise<Map<string, { formId: number; value: number | undefined }>> {
    this.#globalsByName ??= (async () => {
      const globals = new Map<string, { formId: number; value: number | undefined }>();
      await this.forms.db.scan(
        ['GLOB'],
        (flags) => (flags & RecordFlag.deleted) === 0,
        (record) => {
          const name = record.editorId?.toLowerCase();
          if (name !== undefined)
            globals.set(name, { formId: record.formId, value: record.fields.f32('FLTV') });
        },
      );
      return globals;
    })();
    return this.#globalsByName;
  }

  /** The globals that are the game's clock, by form id (found once). */
  async #findClockGlobals(): Promise<void> {
    for (const [name, { formId }] of await this.#globals()) {
      const clock = CLOCK_GLOBALS[name];
      if (clock) this.#clockGlobals.set(formId, clock);
    }
  }

  /**
   * A global that is the game's clock (GameHour, GameDaysPassed, GameDay, GameMonth,
   * GameYear, TimeScale): its value now; undefined for any other global.
   */
  clockGlobal(formId: number): number | undefined {
    const clock = this.#clockGlobals.get(formId);
    if (!clock) return undefined;
    const days = this.state.gameDaysPassed;
    const date = dateAfter(
      this.#startDate ?? DEFAULT_START_DATE,
      Math.floor(days) - Math.floor(this.#startDays),
    );
    switch (clock) {
      case 'hour':
        return this.gameHour;
      case 'days':
        return days;
      case 'day':
        return date.day;
      case 'month':
        return date.month;
      case 'year':
        return date.year;
      case 'timescale':
        return this.timeScale;
    }
  }

  /**
   * A global's value now when the scripts know it without reading (the clock's, those scripts
   * set); undefined for one still at its plugin value.
   */
  globalNow(formId: number): number | undefined {
    return this.clockGlobal(formId) ?? this.state.globals.get(formId);
  }

  /** A script set a clock global: the clock jumps (SetValue on GameHour, ...). */
  setClockGlobal(formId: number, value: number): boolean {
    const clock = this.#clockGlobals.get(formId);
    if (!clock) return false;
    const days = this.state.gameDaysPassed;
    const start = this.#startDate ?? DEFAULT_START_DATE;
    const today = dateAfter(start, Math.floor(days) - Math.floor(this.#startDays));
    const onDate = (date: GameDate): number =>
      Math.floor(this.#startDays) + daysBetween(start, date) + (days % 1);
    let next = days;
    switch (clock) {
      case 'hour':
        next = Math.floor(days) + Math.max(0, Math.min(24, value)) / 24;
        break;
      case 'days':
        next = value;
        break;
      case 'day':
        next = onDate({ ...today, day: Math.round(value) });
        break;
      case 'month':
        next = onDate({ ...today, month: Math.round(value) });
        break;
      case 'year':
        next = onDate({ ...today, year: Math.round(value) });
        break;
      case 'timescale':
        this.timeScale = value;
        return true;
    }
    // Waits on game time count from the clock: a jump moves them on too.
    const passed = next - days;
    this.state.gameDaysPassed = next;
    if (passed > 0) this.vm.scheduler.advance(0, passed);
    this.clockChanged = true;
    return true;
  }
}

/** A message's text with its %f-style placeholders filled from Show's numbers. */
function fillNumbers(text: string, args: readonly number[]): string {
  let next = 0;
  return text.replace(
    /%(\.(\d+))?f/g,
    (_match, _precision: string | undefined, digits: string | undefined) => {
      const value = args[next++] ?? 0;
      return digits === undefined ? String(value) : value.toFixed(Number(digits));
    },
  );
}

/** A form id, or undefined for none (0). */
const nonZero = (formId: number | undefined): number | undefined =>
  formId === 0 ? undefined : formId;
