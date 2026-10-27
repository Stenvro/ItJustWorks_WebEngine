// Everything that belongs to one mounted game folder and is shared by the viewers: the
// VFS, the asset workers, texture and model caches, the record database and the Papyrus
// environment. Disposed when another folder is mounted.

import { loadGameScripts, type GameSave } from '../save/game-save.ts';
import type { SaveHeader } from '../save/save-codec.ts';
import { loadRouteMap } from '../ai/route-map.ts';
import type { Space } from '../ai/package-start.ts';
import type { RouteMap } from '../ai/routes.ts';
import { AudioLoader } from '../audio/audio-loader.ts';
import { SoundSystem, type VoiceLine } from '../audio/sound-system.ts';
import type { SoundInstance, SoundPlace } from '../audio/sound-instance.ts';
import { loadBehaviorGraph, type BehaviorGraph } from '../formats/hkx/behavior.ts';
import { parseNif, type NifFile } from '../formats/nif/nif.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import { IniSettings } from '../world/ini-settings.ts';
import { followWithHud, MenuStack } from '../ui/menu-stack.ts';
import { HudSignals } from './hud-signals.ts';
import { readPlayerData, type PlayerData } from './player.ts';
import { readCollisionMatrix, type CollisionMatrix } from '../physics/collision-layers.ts';
import type { ModelTextureSwaps } from '../render/actor-model.ts';
import type { Renderer } from '../render/renderer.ts';
import type { RenderPort } from '../render/render-port.ts';
import { Worldspace } from '../world/worldspace.ts';
import { markSeen } from '../world/seen-data.ts';
import { DefaultObjects } from '../world/default-objects.ts';
import { propertyMaterial, type AddonNode } from '../render/model-data.ts';
import type {
  EmittanceColor,
  GpuDirectionalMaterial,
  GpuModel,
  GpuMorphs,
  GpuWaterType,
  LodSnow,
  ModelAddon,
  PlacedDirectional,
  WaterFlow,
} from '../render/scene-renderer.ts';
import { TextureCache } from '../render/texture-cache.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { parseAddonNode, parseLight } from '../world/cell-records.ts';
import { emittanceColor, emittanceWeather, type EmittanceSource } from '../world/emittance.ts';
import {
  HD_LOD_SNOW_THRESHOLD_ANGLE,
  LOD_MATERIALS,
  LOD_SNOW_THRESHOLD_ANGLE,
  parseMaterialObject,
  type MaterialObject,
  type StaticDirectional,
} from '../world/material-object.ts';
import { GameSettings } from '../world/game-settings.ts';
import { WorldBorder } from '../world/border.ts';
import { parseWater, WaterFlag, type WaterType } from '../world/water.ts';
import {
  parseRegionWeather,
  parseWeather,
  type ClimateRecord,
  type WeatherChance,
  type WeatherRecord,
} from '../world/weather.ts';
import {
  parseWeatherRegionArea,
  SkyWeather,
  weatherSettings,
  type WeatherRegionArea,
} from '../world/sky-weather.ts';
import { ScriptEnvironment } from '../world/player-home.ts';
import { RecordDatabase } from '../world/record-db.ts';
import {
  dateAfter,
  dayOfWeekAfter,
  DEFAULT_START_DATE,
  DEFAULT_TIME_SCALE,
  readStartDate,
  readTimeScale,
  type GameDate,
} from '../world/game-time.ts';
import { PackageData } from '../ai/package-data.ts';
import { packageStart, type GameTime, type PackageStart } from '../ai/package-start.ts';
import type { ActorMind } from '../world/actors.ts';
import type { CellActor } from '../world/cell-loader.ts';
import { ScriptLibrary } from '../scripting/script-library.ts';
import { PapyrusScheduler } from '../scripting/scheduler.ts';
import { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ScriptWorld } from './script-world.ts';
import { TimeFlow } from './time-flow.ts';
import { ScreenModifiers } from './screen-modifiers.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
import { PluginIndexer } from '../workers/plugin-indexer.ts';
import { ActorPlacer } from './actors.ts';
import { AnimationAssets } from './animation-assets.ts';
import { audioSettingKey, Preferences } from './preferences.ts';
import { ControlSettings } from './control-settings.ts';
import { WorldLines } from './world-lines.ts';
import { SceneLines } from './scene-lines.ts';
import { PlayerLook } from './player-look.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { PlacedActor } from './actors.ts';
import type { Terminal } from './terminal.ts';

const numberFormat = new Intl.NumberFormat('en-US');

/**
 * How a session is presented: the page draws it with WebGPU and does the asset work in web
 * workers; the headless simulation (src/sim/) has no screen and works on its own thread.
 */
/** A sound the world asked for: its descriptor, where, and the reference sounding it. */
export interface SoundRequest {
  readonly descriptor: number;
  readonly place: SoundPlace;
  readonly source: number | undefined;
}

/** What says the actors' lines: the sound system in the page, the headless simulation's own. */
export interface VoicePort {
  /** Whether a file holds the sound (any of its names). */
  hasFile(path: string): boolean;
  /** A spoken line: its length, its lip data, and its playing at a place. */
  voiceLine(path: string, atListener?: boolean): Promise<VoiceLine | undefined>;
}

export interface SessionPresentation {
  /** What makes the session's models and scenes (src/render/render-port.ts). */
  readonly render: RenderPort;
  /** The page's renderer, for its viewers and menus (undefined headless). */
  readonly renderer?: Renderer;
  /** The GPU device textures are made on (undefined headless: none are made). */
  readonly device?: GPUDevice;
  /** The asset and plugin work runs in web workers (false: on this thread). */
  readonly workers: boolean;
  /**
   * The voices of a session without a sound system (headless: no audio device). Without it
   * the session makes its sound system on first use.
   */
  readonly voices?: VoicePort;
  /**
   * Where the player's settings and key bindings are kept: the page's localStorage by default,
   * null for none (the headless simulation plays with the defaults).
   */
  readonly storage?: Storage | null;
}

/** An emittance colour that the session moves with the hour. */
interface MutableEmittance {
  rgb: [number, number, number];
  version: number;
}

interface EmittanceEntry {
  readonly color: MutableEmittance;
  loaded: { source: EmittanceSource; weather?: WeatherRecord } | undefined;
}

/** Sets an emittance colour, bumping its version when it changes visibly. */
function setEmittance(color: MutableEmittance, rgb: readonly [number, number, number]): void {
  const changed = rgb.some((value, i) => Math.abs(value - (color.rgb[i] ?? 0)) > 1 / 1024);
  if (!changed) return;
  color.rgb = [rgb[0], rgb[1], rgb[2]];
  color.version++;
}

/**
 * GPU memory for models and textures loaded for the session: past it, the least recently
 * used ones that nothing draws are freed (and loaded again when needed).
 */
export const MEMORY_BUDGET = 4096 * 1024 * 1024;
/** Freed down to this share of the budget, so trimming does not run every frame. */
const TRIM_TARGET = 0.85;
/** Models and textures used in the last 10 seconds stay (cells may be about to place them). */
const EVICTION_GRACE_MS = 10_000;
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The browser's next task (a message to ourselves: no timer clamping): a frame that is due is
 * drawn before it. Long engine work gives way with it (PapyrusScheduler.yieldTask).
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

export class GameSession {
  readonly vfs: Vfs;
  /** The player's own key bindings (the journal's Controls page), kept in the browser. */
  readonly controlSettings: ControlSettings;
  /** The player's settings (the game's SkyrimPrefs.ini), kept in the browser. */
  readonly preferences: Preferences;

  /** The INI settings: the player's over the installation's over the engine's defaults. */
  get ini(): IniSettings {
    this.#ini ??= new IniSettings(this.vfs.defaultIni, this.preferences);
    return this.#ini;
  }

  #ini: IniSettings | undefined;
  readonly loader: AssetLoader;
  readonly textures: TextureCache;
  /** Behavior projects, Havok skeletons and clips (actors and animated objects). */
  readonly animation: AnimationAssets;
  /** Indexed once per session (all plugins of the load order). */
  readonly db: Promise<RecordDatabase>;
  /**
   * What the session's models and scenes are made by: the page's renderer, or the headless
   * simulation's (src/sim/headless-render.ts), which draws nothing.
   */
  readonly render: RenderPort;
  readonly #renderer: Renderer | undefined;
  /** The voices without a sound system (headless), if so. */
  readonly #voices: VoicePort | undefined;

  /** What says the actors' lines: the sound system, or the headless voices. */
  voices(): Promise<VoicePort> {
    return this.#voices ? Promise.resolve(this.#voices) : this.sounds();
  }

  /**
   * The page's renderer (a menu's 3D: Renderer.overlay); only the page's viewers and menus use
   * it, and a headless session has none.
   */
  get renderer(): Renderer {
    if (!this.#renderer) throw new Error('A headless session has no renderer');
    return this.#renderer;
  }

  readonly #terminal: Terminal;
  /** Models by path, shared by every cell and kept for the session. */
  readonly #models = new Map<string, Promise<GpuModel | undefined>>();
  /** The loaded ones by the same key (memory and eviction). */
  readonly #loadedModels = new Map<string, GpuModel>();
  readonly #borders = new Map<number, Promise<WorldBorder>>();
  readonly #worldspaces = new Map<number, Promise<Worldspace>>();
  #defaultObjects: Promise<DefaultObjects> | undefined;
  /** Behavior graphs by project path (shared by all the meshes that name them). */
  readonly #graphs = new Map<string, Promise<BehaviorGraph | undefined>>();
  #scripts: Promise<ScriptEnvironment> | undefined;
  #runtime: Promise<ScriptRuntime> | undefined;
  /** The running game's scripts once their new game has started. */
  scriptsReady: ScriptRuntime | undefined;
  /** The scripts while their new game starts, and what they are doing (dev checks). */
  scriptsStarting: ScriptRuntime | undefined;
  scriptsProgress = '';
  /** What the scripts do to the world on screen (the viewers attach to it). */
  readonly scriptWorld: ScriptWorld;
  /**
   * The sky's weather, one for the whole game as the engine's (src/world/sky-weather.ts): the
   * viewers draw it and run it each frame, scripts, the console and conditions drive and read it.
   */
  readonly sky: SkyWeather;
  /** Every weather of the load order, parsed (filled once the records are read). */
  readonly #weatherRecords = new Map<number, WeatherRecord>();
  /** The globals weather lists take chances from, as the plugins set them. */
  readonly #weatherGlobals = new Map<number, number>();
  /** Regions' areas and weather tabs, by form id. */
  readonly #weatherRegions = new Map<number, Promise<WeatherRegionArea | undefined>>();
  /**
   * Crime on the stage now (src/shell/actor-crime.ts): guards pursue the player, the player
   * trespasses. The menus that refuse then read it (waiting, fast travel, lockpicking).
   */
  crimeWatch: { readonly pursued: boolean; readonly trespassing: boolean } | undefined;
  /** Whether someone fights the player now (src/shell/actor-combat.ts). */
  combatWatch: { readonly fightingPlayer: boolean } | undefined;
  /**
   * Told when hours passed at once (waiting, sleeping): the actors of the stage are where their
   * packages had them by now (src/shell/actor-stage.ts).
   */
  readonly timeSkipped = new Set<() => void>();
  /** The actor a reference shows as on screen, if it does (the viewers answer: main.ts). */
  placedActor: ((reference: number) => PlacedActor | undefined) | undefined;
  /** An actor of the loaded area plays the idle an action gives it (ActionTalking as it talks). */
  actorAction: ((reference: number, action: string) => boolean) | undefined;
  /**
   * A dialogue idle for an actor of the loaded area (a line's speaker or listener idle,
   * ActionTalking's): held while its graph locks dialogue idles (IdleDialogueLock), played as
   * it unlocks them (src/shell/actor-graph-events.ts). Whether it was held.
   */
  holdDialogueIdle: ((reference: number, play: () => void) => boolean) | undefined;
  /** Lines actors say outside conversations (Say). */
  readonly lines: WorldLines;
  /** Lines actors say in scenes (src/shell/scene-lines.ts). */
  readonly sceneLines: SceneLines;
  /** What the game tells its HUD (Play's hudmenu.swf listens). */
  readonly hud = new HudSignals();
  /**
   * The menus open now, by name, with their flags (src/ui/menu-stack.ts): the HUD follows them
   * (its mode for each, hidden behind those that hide it), scripts ask them (UI.IsMenuOpen),
   * saving asks them.
   */
  readonly menuStack = new MenuStack();
  /**
   * The image-space modifiers on the screen (scripts', the menus', low health's), laid over
   * the viewers' imagespace each frame.
   */
  readonly imageSpaceModifiers: ScreenModifiers;
  #settings: Promise<GameSettings> | undefined;
  readonly #waterTypes = new Map<string, Promise<GpuWaterType | undefined>>();
  readonly #waterRecords = new Map<number, Promise<WaterType | undefined>>();
  /** Material objects (MATO) ready to draw, by form id. */
  readonly #directionalMaterials = new Map<number, Promise<GpuDirectionalMaterial | undefined>>();
  readonly #materialObjects = new Map<number, Promise<MaterialObject | undefined>>();
  /**
   * The game's time of day in hours, shared by the viewers: the world's sky advances it and
   * sets it from its time slider, interiors advance it at the timescale too.
   */
  gameHour = 10;
  /** Whole days passed since the game started (the clock's midnights). */
  gameDaysPassed = 0;
  /** The date a new game starts on (the GameYear, GameMonth and GameDay globals). */
  #startDate: GameDate = DEFAULT_START_DATE;
  #packages: Promise<PackageData> | undefined;
  #routes: Promise<RouteMap> | undefined;
  /** Game seconds per real second: the plugins' TimeScale global (Skyrim.esm: 20). */
  timeScale = DEFAULT_TIME_SCALE;
  /**
   * The dev panel's fast-forward: the clock runs this many times the TimeScale (1: as the
   * game), as the console's `set timescale` would.
   */
  timeSpeed = 1;

  /** Game seconds per real second now: the TimeScale times the panel's fast-forward. */
  get clockRate(): number {
    return this.timeScale * this.timeSpeed;
  }
  /**
   * Quest and scene states set by hand, by cell form id (enable-parent markers that are on);
   * cells without an entry show them as a new game has them.
   */
  readonly cellSelections = new Map<number, ReadonlySet<number>>();
  #weathersEntry: Promise<readonly { formId: number; editorId: string }[]> | undefined;
  /** The hour and climate the emittance colours were last moved to. */
  #emittanceAt: { hour: number; climate: ClimateRecord | undefined } | undefined;
  /** Emittance sources (XEMI) by form id, with their current colour. */
  readonly #emittance = new Map<number, EmittanceEntry>();
  #addonPathsEntry: Promise<Map<number, string>> | undefined;
  /** Models' collision by path, kept as long as the model (collision-only models stay). */
  readonly #collisions = new Map<string, CollisionData>();
  #collisionMatrix: Promise<CollisionMatrix> | undefined;
  #playerData: Promise<PlayerData> | undefined;
  #sounds: Promise<SoundSystem> | undefined;
  #audioLoader: AudioLoader | undefined;
  /** The sound system once it exists (the render loop updates it every frame). */
  soundSystem: SoundSystem | undefined;
  /** Told of every sound the world asks for (the headless simulation records them). */
  readonly soundRequests = new Set<(request: SoundRequest) => void>();

  /**
   * Plays a sound descriptor (SNDR) at a place for a reference (its conditions are that
   * reference's): through the sound system once there is one; the request is told either way.
   */
  playSound(
    descriptor: number,
    place?: SoundPlace,
    fadeIn = 0,
    source?: number,
  ): Promise<SoundInstance | undefined> | undefined {
    for (const listener of this.soundRequests) listener({ descriptor, place, source });
    return this.soundSystem?.play(descriptor, place, fadeIn, source);
  }
  #actors: Promise<ActorPlacer> | undefined;
  /** Head parts' expression morphs by TRI path (kept for the session: a few dozen files). */
  readonly #morphs = new Map<string, Promise<GpuMorphs | undefined>>();
  #morphBytes = 0;

  constructor(vfs: Vfs, terminal: Terminal, presentation: SessionPresentation) {
    followWithHud(this.menuStack, this.hud);
    this.vfs = vfs;
    const storage =
      presentation.storage === null
        ? undefined
        : (presentation.storage ??
          (typeof localStorage === 'undefined' ? undefined : localStorage));
    this.controlSettings = new ControlSettings(storage);
    this.preferences = new Preferences(storage);
    this.render = presentation.render;
    this.#renderer = presentation.renderer;
    this.#voices = presentation.voices;
    this.#terminal = terminal;
    this.scriptWorld = new ScriptWorld(terminal, this.hud);
    this.lines = new WorldLines(this, terminal);
    this.sceneLines = new SceneLines(this, terminal);
    this.scriptWorld.sceneLine = (speech) => this.sceneLines.speak(speech);
    this.scriptWorld.say = (speaker, topic, speakAs, inHead) => {
      if (topic === undefined) return;
      this.lines.say(speaker, topic, speakAs, inHead).catch((error: unknown) => {
        terminal.log('papyrus', `Say: ${describe(error)}`, 'warn');
      });
    };
    // Hours passing at once (jail): the clock, the scripts' clock, the actors' values over them.
    this.scriptWorld.passTime = async (hours) => {
      this.advanceClock(hours);
      const runtime = this.scriptsReady;
      if (!runtime) return;
      runtime.update(0, hours / 24);
      await runtime.progression.passTime(hours);
    };
    this.scriptWorld.sounds = () => this.soundSystem;
    this.scriptWorld.onSound = (descriptor, source) => {
      for (const listener of this.soundRequests) listener({ descriptor, place: undefined, source });
    };
    this.scriptWorld.talking = (actor) => this.lines.talking(actor);
    this.sky = new SkyWeather({
      hour: () => this.gameHour,
      weather: (formId) => this.#weatherRecords.get(formId),
      global: (formId) =>
        this.scriptsReady?.state.globals.get(formId) ?? this.#weatherGlobals.get(formId),
      random: Math.random,
    });
    this.scriptWorld.sky = this.sky;
    const workers = presentation.workers;
    const loader = workers ? new AssetLoader(vfs) : new AssetLoader(vfs, 0);
    this.loader = loader;
    this.textures = new TextureCache(presentation.device, (path) => loader.loadTexture(path));
    this.animation = new AnimationAssets(vfs, terminal);
    // The plugins' record headers (~1.2 million) are read in workers (on this thread without).
    const start = performance.now();
    const indexer = workers ? new PluginIndexer() : undefined;
    const indexed = (
      indexer
        ? RecordDatabase.open(vfs, 'english', (source, name) => indexer.index(name, source))
        : RecordDatabase.open(vfs, 'english')
    ).finally(() => {
      indexer?.dispose();
    });
    this.db = indexed.then((db) => {
      for (const problem of db.problems) terminal.log('esm', problem, 'warn');
      const records = db.plugins.reduce((sum, plugin) => sum + plugin.index.recordCount, 0);
      terminal.log(
        'esm',
        `${numberFormat.format(records)} records indexed in ${(performance.now() - start).toFixed(0)} ms`,
        'ok',
      );
      return db;
    });
    this.imageSpaceModifiers = new ScreenModifiers(this.db, terminal);
    // The sky knows every weather and its settings as soon as the records are read.
    void this.weathers();
    void this.settings().then((gmst) => {
      this.sky.settings = weatherSettings((id) => gmst.number(id));
    });
    this.scriptWorld.modifiers = this.imageSpaceModifiers;
    // Modifiers that aim at their target see it from the view's camera.
    this.imageSpaceModifiers.view = () => {
      const camera = this.render.view?.camera;
      if (!camera) return undefined;
      return {
        project: (point) => this.render.project(point),
        distance: (point) =>
          Math.hypot(
            point[0] - camera.position[0],
            point[1] - camera.position[1],
            point[2] - camera.position[2],
          ),
      };
    };
    void this.db.then(async (db) => {
      this.timeScale = await readTimeScale(db);
      this.#startDate = await readStartDate(db);
    });
  }

  /** The game's date and time now. */
  gameTime(): GameTime {
    const date = dateAfter(this.#startDate, this.gameDaysPassed);
    return {
      hour: this.gameHour,
      dayOfWeek: dayOfWeekAfter(this.gameDaysPassed),
      month: date.month,
      date: date.day,
    };
  }

  /** Advances the clock by game hours, counting the midnights it passes. */
  advanceClock(hours: number): void {
    const next = this.gameHour + hours;
    this.gameDaysPassed += Math.floor(next / 24);
    this.gameHour = ((next % 24) + 24) % 24;
  }

  /** The route map of the load order: navmeshes and load doors (src/ai/routes.ts), read once. */
  routeMap(): Promise<RouteMap> {
    this.#routes ??= this.db.then((db) => loadRouteMap(db));
    return this.#routes;
  }

  /** The AI packages and what they read (read once, shared by the actors' AI). */
  packageData(): Promise<PackageData> {
    this.#packages ??= this.db.then(async (db) => {
      const data = new PackageData(db, undefined, () => this.scriptsReady);
      await data.ready();
      return data;
    });
    return this.#packages;
  }

  /** Where an actor's AI package has it now, as its cell loads (src/ai/package-start.ts). */
  async packageStart(actor: CellActor, look: ActorMind, space?: Space): Promise<PackageStart> {
    const data = await this.packageData();
    const placed = space ? { space } : await data.reference(actor.reference);
    if (!placed) return { kind: 'undecided', reason: 'its cell is not known' };
    return packageStart(
      {
        reference: actor.reference,
        base: look.base,
        npc: look.npc,
        race: look.race,
        female: look.female,
        factions: look.factions,
        packages: look.packages,
        space: placed.space,
        position: actor.position,
        linked: (keyword) => actor.links.get(keyword),
      },
      data,
      this.gameTime(),
    );
  }

  /**
   * A model for placing in scenes, with the models of its AddOnNodes attached; undefined
   * for editor markers, empty and broken files.
   */
  model(path: string): Promise<GpuModel | undefined> {
    return this.#model(path, true);
  }

  /**
   * A model with its NiSwitchNodes showing another child (flora harvested: 1); undefined where
   * it has no switch node (it looks the same).
   */
  async switchedModel(path: string, child: number): Promise<GpuModel | undefined> {
    return this.#model(path, true, child);
  }

  /**
   * A destructible object's model at a model damage stage (DSTD): its BSDamageStage nodes show
   * that stage's subtrees and collide as they do (GameSession.collision with the stage); `swaps`:
   * texture sets on its shapes (the stage's DMDS).
   */
  damagedModel(
    path: string,
    damageStage: number,
    swaps?: ModelTextureSwaps,
  ): Promise<GpuModel | undefined> {
    return this.#model(path, true, undefined, damageStage, swaps);
  }

  /** Models attached at AddOnNodes get no add-ons of their own (no cycles). */
  #model(
    path: string,
    withAddons: boolean,
    switchChild?: number,
    damageStage = 0,
    swaps?: ModelTextureSwaps,
  ): Promise<GpuModel | undefined> {
    const key =
      (withAddons ? path : `${path}|addon`) +
      (switchChild === undefined ? '' : `|switch${switchChild}`) +
      (damageStage === 0 ? '' : `|damage${damageStage}`) +
      (swaps ? `|swaps${JSON.stringify(swaps)}` : '');
    const collisionKey = damageStage === 0 ? path : `${path}|damage${damageStage}`;
    let entry = this.#models.get(key);
    const loaded = this.#loadedModels.get(key);
    if (loaded) loaded.lastUsed = performance.now();
    if (!entry) {
      entry = this.loader.loadModel(path, switchChild, damageStage, swaps).then(
        async (loaded) => {
          const data = loaded.model;
          if (switchChild !== undefined && data.switches === undefined) return undefined;
          // Editor markers have no collision in the game either.
          if (!data.editorMarker) this.#collisions.set(collisionKey, loaded.collision);
          const addons = withAddons ? await this.addons(data.addons) : [];
          const empty = data.parts.length === 0 && data.particles.length === 0;
          if (data.editorMarker || (empty && addons.length === 0)) return undefined;
          const model = await this.render.scene.createModel(data, this.textures);
          model.addons = addons;
          if (data.behaviorGraph !== undefined) {
            model.graph = await this.behaviorGraph(data.behaviorGraph);
            // Where it plays skeletal clips, its nodes move too (a missing graph moves nothing).
            if (model.graph)
              model.skeletal = await this.animation.skeletalGraph(data.behaviorGraph);
          }
          this.#loadedModels.set(key, model);
          return model;
        },
        (error: unknown) => {
          this.#terminal.log('nif', describe(error), 'warn');
          return undefined;
        },
      );
      this.#models.set(key, entry);
    }
    return entry;
  }

  /**
   * A model an actor wears: blended with its thin (_0) model by `weight` and with texture
   * sets swapped in; equal ones are shared (and evicted like other models).
   */
  actorModel(
    path: string,
    thin: string | undefined,
    weight: number,
    swaps: ModelTextureSwaps,
  ): Promise<GpuModel | undefined> {
    const key = `actor|${path}|${thin ?? ''}|${String(weight)}|${JSON.stringify(swaps)}`;
    let entry = this.#models.get(key);
    const loaded = this.#loadedModels.get(key);
    if (loaded) loaded.lastUsed = performance.now();
    if (!entry) {
      entry = this.loader.loadActorPart(path, thin, weight, swaps).then(
        async ({ model: data, problems }) => {
          for (const problem of problems) this.#terminal.log('nif', `${path}: ${problem}`, 'warn');
          if (data.parts.length === 0) return undefined;
          const model = await this.render.scene.createModel(data, this.textures);
          // Its sequences play by its own graph (an automaton's steam flowing on its skin).
          if (data.behaviorGraph !== undefined) {
            model.graph = await this.behaviorGraph(data.behaviorGraph);
          }
          this.#loadedModels.set(key, model);
          return model;
        },
        (error: unknown) => {
          this.#terminal.log('nif', describe(error), 'warn');
          return undefined;
        },
      );
      this.#models.set(key, entry);
    }
    return entry;
  }

  /** Every weather (WTHR) of the load order, by editor id (the sky reads them all once). */
  weathers(): Promise<readonly { formId: number; editorId: string }[]> {
    this.#weathersEntry ??= this.db.then(async (db) => {
      const records = await Promise.all(db.formIdsOfType('WTHR').map((id) => db.get(id)));
      const weathers: { formId: number; editorId: string }[] = [];
      for (const record of records) {
        if (!record) continue;
        try {
          this.#weatherRecords.set(record.formId, parseWeather(record));
        } catch (error) {
          this.#terminal.log('sky', `${record.editorId ?? ''}: ${describe(error)}`, 'warn');
        }
        weathers.push({ formId: record.formId, editorId: record.editorId ?? '' });
      }
      return weathers.sort((a, b) => a.editorId.localeCompare(b.editorId));
    });
    return this.#weathersEntry;
  }

  /** A weather of the load order, once the weathers are read. */
  weatherRecord(formId: number): WeatherRecord | undefined {
    return this.#weatherRecords.get(formId);
  }

  /** A region's areas and weather tab (REGN), read once (its chances' globals too). */
  weatherRegion(formId: number): Promise<WeatherRegionArea | undefined> {
    let entry = this.#weatherRegions.get(formId);
    if (!entry) {
      entry = this.db.then(async (db) => {
        const record = await db.get(formId);
        if (record?.type !== 'REGN') return undefined;
        const region = parseWeatherRegionArea(record);
        if (region.weather) await this.weatherGlobals(region.weather.weathers);
        return region;
      });
      this.#weatherRegions.set(formId, entry);
    }
    return entry;
  }

  /** Reads the globals a weather list takes chances from (GLOB FLTV), once each. */
  async weatherGlobals(list: readonly WeatherChance[]): Promise<void> {
    const db = await this.db;
    for (const { global } of list) {
      if (global === undefined || this.#weatherGlobals.has(global)) continue;
      const value = (await db.get(global))?.fields.f32('FLTV');
      if (value !== undefined) this.#weatherGlobals.set(global, value);
    }
  }

  /** A head part's expression morphs (its TRI file) on the GPU, read once. */
  expressions(path: string): Promise<GpuMorphs | undefined> {
    let entry = this.#morphs.get(path);
    if (!entry) {
      entry = this.loader.loadExpressions(path).then(
        (data) => {
          const morphs = this.render.scene.createMorphs(data);
          this.#morphBytes += morphs?.bytes ?? 0;
          return morphs;
        },
        (error: unknown) => {
          this.#terminal.log('tri', `${path}: ${describe(error)}`, 'warn');
          return undefined;
        },
      );
      this.#morphs.set(path, entry);
    }
    return entry;
  }

  /**
   * A Havok Behavior graph by its project path (a mesh's BSBehaviorGraphExtraData), read
   * once; undefined if it is missing or broken (the mesh then plays none of its sequences,
   * as when the game fails to load a graph).
   */
  behaviorGraph(project: string): Promise<BehaviorGraph | undefined> {
    let entry = this.#graphs.get(project);
    if (!entry) {
      entry = loadBehaviorGraph(project, (path) => this.vfs.read(path)).catch((error: unknown) => {
        this.#terminal.log('hkx', `${project}: ${describe(error)}`, 'warn');
        return undefined;
      });
      this.#graphs.set(project, entry);
    }
    return entry;
  }

  /**
   * A worldspace with its indexes (its persistent references by cell, its doors), read once:
   * the world on screen and the map share it.
   */
  worldspace(formId: number): Promise<Worldspace> {
    let entry = this.#worldspaces.get(formId);
    if (!entry) {
      entry = this.db.then((db) => Worldspace.open(db, formId));
      entry.catch(() => this.#worldspaces.delete(formId));
      this.#worldspaces.set(formId, entry);
    }
    return entry;
  }

  /** The load order's default objects (DOBJ), read once. */
  defaultObjects(): Promise<DefaultObjects> {
    this.#defaultObjects ??= this.db.then((db) => DefaultObjects.read(db));
    return this.#defaultObjects;
  }

  /** A worldspace's border regions (where the player may go), read once per worldspace. */
  worldBorder(world: number): Promise<WorldBorder> {
    let entry = this.#borders.get(world);
    if (!entry) {
      entry = this.db.then((db) => WorldBorder.of(db, world));
      this.#borders.set(world, entry);
    }
    return entry;
  }

  /**
   * A model's Havok collision (also for models with nothing to draw); at a destructible object's
   * model damage stage, its BSDamageStage nodes' collision for that stage.
   */
  async collision(path: string, damageStage = 0): Promise<CollisionData | undefined> {
    const key = damageStage === 0 ? path : `${path}|damage${damageStage}`;
    const cached = this.#collisions.get(key);
    if (cached) return cached;
    await this.#model(path, true, undefined, damageStage);
    return this.#collisions.get(key);
  }

  /** Which collision layers collide (COLL records), read once. */
  collisionMatrix(): Promise<CollisionMatrix> {
    this.#collisionMatrix ??= this.db.then((db) => readCollisionMatrix(db));
    return this.#collisionMatrix;
  }

  /**
   * The player's body (race, skeleton bound, camera nodes), the INI settings, the control map
   * and the movement types, read once.
   */
  playerData(): Promise<PlayerData> {
    this.#playerData ??= this.db.then(async (db) => {
      const data = await readPlayerData(
        db,
        this.vfs,
        await this.settings(),
        (path) => this.nif(path),
        this.preferences,
      );
      // The player's own bindings over the control map, and as they change.
      data.controls = this.controlSettings.apply(data.baseControls);
      this.controlSettings.onChange(() => {
        data.controls = this.controlSettings.apply(data.baseControls);
      });
      return data;
    });
    return this.#playerData;
  }

  /** The models of a model's AddOnNodes (ADDN records by index). */
  async addons(nodes: readonly AddonNode[]): Promise<ModelAddon[]> {
    if (nodes.length === 0) return [];
    const paths = await this.#addonPaths();
    const addons = await Promise.all(
      nodes.map(async (node): Promise<ModelAddon | undefined> => {
        const path = paths.get(node.index);
        const model = path === undefined ? undefined : await this.#model(path, false);
        return model && { model, world: node.world };
      }),
    );
    return addons.filter((addon): addon is ModelAddon => addon !== undefined);
  }

  /** ADDN model paths by node index, read once. */
  #addonPaths(): Promise<Map<number, string>> {
    this.#addonPathsEntry ??= this.db.then(async (db) => {
      const paths = new Map<number, string>();
      for (const formId of db.formIdsOfType('ADDN')) {
        const record = await db.get(formId);
        if (!record) continue;
        const addon = parseAddonNode(record);
        if (addon.model) paths.set(addon.index, addon.model);
      }
      return paths;
    });
    return this.#addonPathsEntry;
  }

  /**
   * A water type (WATR) on the GPU, kept for the session. Rivers (WaterFlag.flowmap) drawn in
   * a cell with a flow map get a version with that map; other water shares one.
   */
  async waterType(formId: number, flow?: WaterFlow): Promise<GpuWaterType | undefined> {
    const type = await this.#waterRecord(formId);
    if (!type) return undefined;
    const flowing =
      flow !== undefined && (type.flags & WaterFlag.flowmap) !== 0 && this.vfs.has(flow.texture);
    const key = flowing ? `${String(formId)}@${flow.texture}` : String(formId);
    let entry = this.#waterTypes.get(key);
    if (!entry) {
      entry = this.render.scene
        .createWaterType(type, this.textures, flowing ? flow : undefined)
        .catch((error: unknown) => {
          this.#terminal.log('water', describe(error), 'warn');
          return undefined;
        });
      this.#waterTypes.set(key, entry);
    }
    return entry;
  }

  /**
   * A static's directional material as placed (STAT DNAM): the material object ready to draw
   * (kept for the session), its max angle and whether the static counts as snow.
   */
  async directionalMaterial(
    directional: StaticDirectional | undefined,
  ): Promise<PlacedDirectional | undefined> {
    if (!directional) return undefined;
    const material =
      directional.material === 0
        ? undefined
        : await this.#directionalMaterial(directional.material);
    if (!material && !directional.consideredSnow) return undefined;
    return { material, maxAngle: directional.maxAngle, snow: directional.consideredSnow };
  }

  /** The snow and ash laid on object LOD shapes ("objsnow", "objash"; engine materials). */
  async lodSnow(): Promise<LodSnow> {
    const db = await this.db;
    const load = async (
      entry: { readonly plugin: string; readonly id: number },
      maxAngle: number,
    ): Promise<{ material: MaterialObject; maxAngle: number } | undefined> => {
      const formId = db.formIdOf(entry.plugin, entry.id);
      const material = formId === undefined ? undefined : await this.#materialObject(formId);
      return material && { material, maxAngle };
    };
    const [normal, hd, ash, ashHd] = await Promise.all([
      load(LOD_MATERIALS.snow, LOD_SNOW_THRESHOLD_ANGLE),
      load(LOD_MATERIALS.snowHd, HD_LOD_SNOW_THRESHOLD_ANGLE),
      load(LOD_MATERIALS.ash, LOD_SNOW_THRESHOLD_ANGLE),
      load(LOD_MATERIALS.ash, HD_LOD_SNOW_THRESHOLD_ANGLE),
    ]);
    return { normal, hd, ash, ashHd };
  }

  #directionalMaterial(formId: number): Promise<GpuDirectionalMaterial | undefined> {
    let entry = this.#directionalMaterials.get(formId);
    if (!entry) {
      entry = this.#materialObject(formId)
        .then(async (object) => {
          if (!object) return undefined;
          // Multi-pass materials keep their shader as embedded NIF files (DNAM).
          const pass = object.singlePass
            ? { material: undefined, alpha: undefined }
            : propertyMaterial(object.properties.map((data) => parseNif(data)));
          return this.render.scene.createDirectionalMaterial(object, pass, this.textures);
        })
        .catch((error: unknown) => {
          this.#terminal.log('material', `MATO ${formId.toString(16)}: ${describe(error)}`, 'warn');
          return undefined;
        });
      this.#directionalMaterials.set(formId, entry);
    }
    return entry;
  }

  #materialObject(formId: number): Promise<MaterialObject | undefined> {
    let entry = this.#materialObjects.get(formId);
    if (!entry) {
      entry = this.db
        .then((db) => db.get(formId))
        .then((record) => (record?.type === 'MATO' ? parseMaterialObject(record) : undefined));
      this.#materialObjects.set(formId, entry);
    }
    return entry;
  }

  /**
   * The colour of an emittance source (REFR XEMI: a light or a region), shared by every
   * reference naming it; black until the record has loaded. updateEmittance moves it with
   * the hour.
   */
  emittance(formId: number): EmittanceColor {
    let entry = this.#emittance.get(formId);
    if (!entry) {
      const created: EmittanceEntry = { color: { rgb: [0, 0, 0], version: 0 }, loaded: undefined };
      entry = created;
      this.#emittance.set(formId, created);
      void this.#emittanceSource(formId).then((loaded) => {
        created.loaded = loaded;
        // A light's colour does not change: set it at once.
        if (loaded?.source.kind === 'light') setEmittance(created.color, loaded.source.color);
        // A region's colour: at the clock's hour right away (later moves follow the clock).
        const at = this.#emittanceAt;
        if (loaded?.source.kind === 'region') {
          setEmittance(
            created.color,
            emittanceColor(loaded.source, loaded.weather, at?.climate, at?.hour ?? this.gameHour),
          );
        }
      });
    }
    return entry.color;
  }

  /**
   * Moves the emittance colours to a game hour (regions follow their weather's sunlight:
   * windows lit at night, sunbeams by day). `climate` gives the times of sunrise and sunset.
   */
  updateEmittance(hour: number, climate?: ClimateRecord): void {
    // Every game minute is enough (the colours move slowly).
    const last = this.#emittanceAt;
    if (last && last.climate === climate && Math.abs(last.hour - hour) < 1 / 60) return;
    this.#emittanceAt = { hour, climate };
    for (const entry of this.#emittance.values()) {
      const loaded = entry.loaded;
      if (loaded?.source.kind !== 'region') continue;
      setEmittance(entry.color, emittanceColor(loaded.source, loaded.weather, climate, hour));
    }
  }

  async #emittanceSource(
    formId: number,
  ): Promise<{ source: EmittanceSource; weather?: WeatherRecord } | undefined> {
    const db = await this.db;
    const record = await db.get(formId);
    if (record?.type === 'LIGH')
      return { source: { kind: 'light', color: parseLight(record).color } };
    if (record?.type !== 'REGN') return undefined;
    const source: EmittanceSource = {
      kind: 'region',
      weathers: parseRegionWeather(record)?.weathers ?? [],
    };
    const weatherId = emittanceWeather(source);
    const weatherRecord = weatherId === undefined ? undefined : await db.get(weatherId);
    return {
      source,
      ...(weatherRecord?.type === 'WTHR' && { weather: parseWeather(weatherRecord) }),
    };
  }

  #waterRecord(formId: number): Promise<WaterType | undefined> {
    let entry = this.#waterRecords.get(formId);
    if (!entry) {
      entry = this.db
        .then((db) => db.get(formId))
        .then((record) => (record?.type === 'WATR' ? parseWater(record) : undefined));
      this.#waterRecords.set(formId, entry);
    }
    return entry;
  }

  /** Game settings (GMST), read on first use. */
  settings(): Promise<GameSettings> {
    this.#settings ??= this.db.then((db) => GameSettings.read(db));
    return this.#settings;
  }

  /** A NIF parsed on the main thread (small files such as the sky meshes). */
  async nif(path: string): Promise<NifFile> {
    return parseNif(await this.vfs.read(path));
  }

  #playerLook: PlayerLook | undefined;

  /** The player's look as the engine makes it (the race menu's choices), made once. */
  get playerLook(): PlayerLook {
    this.#playerLook ??= new PlayerLook(this, this.#terminal);
    return this.#playerLook;
  }

  /** What places actors in cells (their looks, skeletons and clips are shared). */
  actors(): Promise<ActorPlacer> {
    this.#actors ??= this.db.then((db) => new ActorPlacer(this, db, this.#terminal));
    return this.#actors;
  }

  /**
   * The running game's scripts: a new game started as the session opens (every quest's and
   * persistent reference's OnInit, the quests that start with the game, the opening unless
   * `opening` is false). The game's clock is the scripts' from then on.
   */
  runtime(opening = true): Promise<ScriptRuntime> {
    this.#runtime ??= this.db.then(async (db) => {
      const start = performance.now();
      const library = new ScriptLibrary((name) => db.script(name));
      const runtime = new ScriptRuntime(db, library, {
        world: this.scriptWorld,
        scheduler: new PapyrusScheduler(1.2, () => performance.now()),
        warn: (message) => {
          this.#terminal.log('papyrus', message, 'warn');
        },
        // The game's own faults (its Papyrus log has them too): marked as the game's.
        gameLog: (message) => {
          this.#terminal.log('papyrus', `game data: ${message}`);
        },
        log: (line) => {
          this.#terminal.log('papyrus', line);
        },
      });
      this.scriptsStarting = runtime;
      // Skill increases and blinking meters go to the HUD.
      runtime.progression.listener = this.hud;
      // The INI's settings the events read: OnTrigger's repeat, the attached area.
      const triggerDelay = this.ini.lookup('HAVOK', 'fTriggerEventDelayMS');
      if (triggerDelay !== undefined) runtime.triggerVolumes.delayMs = triggerDelay;
      const trapDelay = this.ini.lookup('HAVOK', 'fTrapHitEventDelayMS');
      if (trapDelay !== undefined) runtime.trapHits.delayMs = trapDelay;
      const grids = this.ini.lookup('General', 'uGridsToLoad');
      if (grids !== undefined) runtime.gridsToLoad = grids;
      runtime.magic.cloakInterval = this.ini.number('General', 'fCloakEffectUpdateInterval');
      const progress = (what: string): void => {
        if (runtime.retired) return;
        this.scriptsProgress = what;
        this.#terminal.log('papyrus', what);
      };
      const load = this.#pendingLoad;
      this.#pendingLoad = undefined;
      if (load) {
        // A saved game: the plugins' records, then the save's state (docs/formats/save.md).
        for (const problem of await loadGameScripts(runtime, load.save, load.header, progress)) {
          this.#terminal.log('save', problem, 'warn');
        }
      } else await runtime.newGame(progress, opening);
      // A new game asked for meanwhile replaced this one.
      if (runtime.retired) return runtime;
      // From now on threads share each frame's budget ([Papyrus] fUpdateBudgetMS).
      runtime.vm.scheduler.framed = true;
      runtime.vm.scheduler.yieldTask = nextTask;
      // A new game's clock: the plugins' day and hour.
      this.gameDaysPassed = Math.floor(runtime.state.gameDaysPassed);
      this.gameHour = (runtime.state.gameDaysPassed % 1) * 24;
      this.timeScale = runtime.timeScale;
      const running = [...runtime.state.quests.values()].filter((quest) => quest.running).length;
      this.#terminal.log(
        'papyrus',
        `${load ? 'loaded' : 'new game'}: ${String(running)} quests running · ${(performance.now() - start).toFixed(0)} ms`,
        'ok',
      );
      this.scriptsReady = runtime;
      // Sounds and music read the running game's globals from now on.
      if (!this.#voices)
        void this.sounds().then((sounds) => {
          sounds.globals = (formId) => runtime.globalNow(formId);
          // Sounds' conditions (SNDR) on the reference that sounds them, else the player.
          sounds.conditionsHold = (conditions, source) =>
            runtime.conditionsHold(conditions, runtime.referenceHandle(source ?? PLAYER_REF));
        });
      this.scriptWorld.enableChanged();
      return runtime;
    });
    return this.#runtime;
  }

  /**
   * Throws the running game away and starts a new one: quests, what scripts enabled, moved and
   * created, the quest and scene states chosen in the panel, the clock. The sandbox's clean
   * state; the viewers load their scene again to show it. Without `opening` the new game starts
   * without Unbound (the main menu's coc).
   */
  /**
   * Throws the running game away and loads a saved one: its scripts from the save (instead of a
   * new game's start). The caller then loads the world where the save's player stands.
   */
  loadSaved(save: GameSave, header: SaveHeader): Promise<ScriptRuntime> {
    this.#pendingLoad = { save, header };
    return this.resetStates(false);
  }

  /** A saved game the next runtime loads instead of starting a new game. */
  #pendingLoad: { readonly save: GameSave; readonly header: SaveHeader } | undefined;

  resetStates(opening = true): Promise<ScriptRuntime> {
    this.scriptsReady?.retire();
    this.scriptsStarting?.retire();
    this.scriptsReady = undefined;
    this.scriptsStarting = undefined;
    this.scriptsProgress = '';
    this.#runtime = undefined;
    this.cellSelections.clear();
    if (!this.#voices)
      void this.sounds().then((sounds) => {
        sounds.globals = undefined;
        sounds.conditionsHold = undefined;
      });
    return this.runtime(opening);
  }

  /**
   * The game is in a menu that pauses it (a message box, the journal, the inventory, ...): the
   * world stands still (main.ts holds the frames' game clock) and so do the scripts' clocks,
   * but for WaitMenuMode's.
   */
  menuMode = false;

  /**
   * A loading screen is up: the scripts' clocks and the game's stand still (nothing runs while
   * the game loads), while the world loads and the player is put down in it.
   */
  loading = false;

  /**
   * Every frame: the scripts' clocks move with the game's (real seconds, and game days as the
   * sky moves the hour); a script that set the clock (GameHour) sets the game's.
   */
  tickScripts(realSeconds: number): void {
    const runtime = this.scriptsReady;
    if (!runtime) return;
    runtime.inMenuMode = this.menuMode;
    runtime.menuOpen ??= (name) => this.menuStack.isOpen(name);
    if (this.loading) return;
    if (this.menuMode) {
      runtime.updateInMenu(realSeconds);
      return;
    }
    this.#watchLocation(runtime);
    this.#watchSeen(runtime, realSeconds);
    this.#watchEncumbrance(runtime, realSeconds);
    // Slow Time and a bow's zoom set the world's clock and the player's pace.
    this.time.update(runtime, realSeconds);
    this.soundSystem?.setTimeMultiplier(this.time.multiplier);
    this.timeScale = runtime.timeScale;
    const days = this.gameDaysPassed + this.gameHour / 24;
    if (runtime.clockChanged) {
      runtime.clockChanged = false;
      this.gameDaysPassed = Math.floor(runtime.state.gameDaysPassed);
      this.gameHour = (runtime.state.gameDaysPassed % 1) * 24;
      runtime.update(realSeconds, 0);
      return;
    }
    const passed = days - runtime.state.gameDaysPassed;
    if (passed < 0) {
      // Set back by hand (the dev panel's clock): the scripts' clock follows, no waits end.
      runtime.state.gameDaysPassed = days;
      runtime.update(realSeconds, 0);
    } else {
      runtime.update(realSeconds, passed);
    }
  }

  /** How fast the world's clock runs and the player with it (Slow Time, a bow's zoom). */
  readonly time = new TimeFlow();

  /** The player carries more than they can (the equip system): no running (src/shell/player.ts). */
  overEncumbered = false;
  #encumbranceWait = 0;
  #encumbranceAsked = false;

  /**
   * What the player carries, looked at twice a second: once it is more than their carry weight
   * they walk, and the HUD says so (sOverEncumbered); fast travel asks for itself.
   */
  #watchEncumbrance(runtime: ScriptRuntime, realSeconds: number): void {
    this.#encumbranceWait -= realSeconds;
    if (this.#encumbranceWait > 0 || this.#encumbranceAsked) return;
    this.#encumbranceWait = 0.5;
    this.#encumbranceAsked = true;
    void runtime.equipment
      .overEncumbered(PLAYER_REF)
      .then(async (over) => {
        if (over && !this.overEncumbered) {
          const text = await runtime.gameSetting('sOverEncumbered');
          if (typeof text === 'string') runtime.world.notification?.(text);
        }
        this.overEncumbered = over;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#encumbranceAsked = false;
      });
  }

  #seenWait = 0;

  /** Inside, what the player comes near is seen (the local map's fog of war), four times a second. */
  #watchSeen(runtime: ScriptRuntime, realSeconds: number): void {
    this.#seenWait -= realSeconds;
    if (this.#seenWait > 0) return;
    this.#seenWait = 0.25;
    const at = this.scriptWorld.livePlacement(PLAYER_REF);
    if (!at || at.world !== undefined || at.cell === undefined) return;
    let blocks = runtime.state.seen.get(at.cell);
    if (!blocks) {
      blocks = new Map();
      runtime.state.seen.set(at.cell, blocks);
    }
    markSeen(blocks, at.position[0], at.position[1]);
  }

  /** The runtime whose location changes the HUD hears. */
  #locationsHeard: ScriptRuntime | undefined;

  /**
   * The cell the player is in, told to the runtime every frame (actor-locations.ts: as they
   * enter a cell of another location, the actor location change event goes out). The HUD
   * shows the new location's name (SetLocationName).
   */
  #watchLocation(runtime: ScriptRuntime): void {
    if (this.#locationsHeard !== runtime) {
      this.#locationsHeard = runtime;
      // The scripts hear it through the relay (script-events.ts: OnLocationChange); the HUD
      // shows the player's new location.
      runtime.events.on('actorLocationChange', async ({ actor, to }) => {
        if (actor !== PLAYER_REF || to === undefined) return;
        const name = (await runtime.forms.record(to))?.text('FULL');
        if (name) this.hud.location(name);
      });
    }
    // The cell the view has them in (an exterior's once the cell at their place has loaded).
    const cell = this.scriptWorld.livePlacement(PLAYER_REF)?.cell;
    if (cell !== undefined) runtime.actorLocations.inCell(PLAYER_REF, String(cell));
  }

  /**
   * The enable states the scripts gave references (Enable, Disable, Delete), for the viewers;
   * empty until the scripts run.
   */
  scriptedEnables(): Map<number, boolean> {
    const states = new Map<number, boolean>();
    for (const [reference, state] of this.scriptsReady?.state.references ?? []) {
      if (state.deleted || state.container !== undefined) states.set(reference, false);
      else if (state.enabled !== undefined) states.set(reference, state.enabled);
    }
    return states;
  }

  /** The Papyrus environment, created on first use. */
  scripts(): Promise<ScriptEnvironment> {
    this.#scripts ??= this.db.then((db) => ScriptEnvironment.create(db, this.vfs));
    return this.#scripts;
  }

  /** GPU bytes of the session's models and textures. */
  get memory(): number {
    let models = 0;
    for (const model of this.#loadedModels.values()) models += model.bytes;
    return models + this.#morphBytes + this.textures.bytes;
  }

  /**
   * Keeps the session under MEMORY_BUDGET: frees the least recently used models that no
   * scene draws (they let go of their textures), then textures no model holds. Returns the
   * bytes freed.
   */
  trim(budget = MEMORY_BUDGET): number {
    const before = this.memory;
    if (before <= budget) return 0;
    const target = budget * TRIM_TARGET;
    const now = performance.now();
    const idle = [...this.#loadedModels.entries()]
      .filter(([, model]) => model.users === 0 && now - model.lastUsed > EVICTION_GRACE_MS)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let memory = before;
    for (const [key, model] of idle) {
      if (memory <= target) break;
      // Models holding this one as an add-on keep it.
      if (
        [...this.#loadedModels.values()].some((other) =>
          other.addons.some((a) => a.model === model),
        )
      ) {
        continue;
      }
      this.#loadedModels.delete(key);
      this.#models.delete(key);
      this.#collisions.delete(key);
      model.destroy();
      memory -= model.bytes;
    }
    this.textures.evict(Math.max(0, target - (memory - this.textures.bytes)), EVICTION_GRACE_MS);
    const freed = before - this.memory;
    if (freed > 0) {
      this.#terminal.log(
        'memory',
        `freed ${(freed / 1048576).toFixed(0)} MB (${(this.memory / 1048576).toFixed(0)} MB in use)`,
      );
    }
    return freed;
  }

  /** The game's sounds, made once (silent until a user gesture resumes the audio). */
  sounds(): Promise<SoundSystem> {
    if (this.#voices) return Promise.reject(new Error('A headless session has no sound system'));
    this.#sounds ??= this.db.then(async (db) => {
      const loader = new AudioLoader(this.vfs);
      this.#audioLoader = loader;
      const sounds = await SoundSystem.create(db, loader, this.ini);
      // The player's volumes (the journal's audio settings).
      for (const category of sounds.engine.menuCategories) {
        const volume = this.preferences.number('Audio', audioSettingKey(category.formId));
        if (volume !== undefined) sounds.engine.setUserVolume(category.formId, volume);
      }
      sounds.onWarning = (message) => {
        this.#terminal.log('audio', message, 'warn');
      };
      this.soundSystem = sounds;
      return sounds;
    });
    return this.#sounds;
  }

  dispose(): void {
    this.#playerLook?.dispose();
    this.soundSystem?.dispose();
    void this.soundSystem?.engine.context.close();
    this.#audioLoader?.dispose();
    for (const entry of this.#models.values()) void entry.then((model) => model?.destroy());
    this.#models.clear();
    this.#loadedModels.clear();
    for (const entry of this.#waterTypes.values()) void entry.then((type) => type?.destroy());
    this.#waterTypes.clear();
    for (const entry of this.#morphs.values()) {
      void entry.then((morphs) => {
        morphs?.buffer.destroy();
      });
    }
    this.#morphs.clear();
    this.loader.dispose();
    void this.db.then((db) => db.close());
  }
}
