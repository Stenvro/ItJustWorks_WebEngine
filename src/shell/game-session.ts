// Everything that belongs to one mounted game folder and is shared by the viewers: the
// VFS, the asset workers, texture and model caches, the record database and the Papyrus
// environment. Disposed when another folder is mounted.

import { AudioLoader } from '../audio/audio-loader.ts';
import { SoundSystem } from '../audio/sound-system.ts';
import { loadBehaviorGraph, type BehaviorGraph } from '../formats/hkx/behavior.ts';
import { parseNif, type NifFile } from '../formats/nif/nif.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import { IniSettings } from '../world/ini-settings.ts';
import { readPlayerData, type PlayerData } from './player.ts';
import { readCollisionMatrix, type CollisionMatrix } from '../physics/collision-layers.ts';
import type { ModelTextureSwaps } from '../render/actor-model.ts';
import type { Renderer } from '../render/renderer.ts';
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
  type WeatherRecord,
} from '../world/weather.ts';
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
import type { ActorLook } from '../world/actors.ts';
import type { CellActor } from '../world/cell-loader.ts';
import { ScriptLibrary } from '../scripting/script-library.ts';
import { PapyrusScheduler } from '../scripting/scheduler.ts';
import { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ScriptWorld } from './script-world.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
import { PluginIndexer } from '../workers/plugin-indexer.ts';
import { ActorPlacer } from './actors.ts';
import { AnimationAssets } from './animation-assets.ts';
import type { Terminal } from './terminal.ts';

const numberFormat = new Intl.NumberFormat('en-US');

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

export class GameSession {
  readonly vfs: Vfs;
  readonly loader: AssetLoader;
  readonly textures: TextureCache;
  /** Behavior projects, Havok skeletons and clips (actors and animated objects). */
  readonly animation: AnimationAssets;
  /** Indexed once per session (all plugins of the load order). */
  readonly db: Promise<RecordDatabase>;
  readonly #renderer: Renderer;
  readonly #terminal: Terminal;
  /** Models by path, shared by every cell and kept for the session. */
  readonly #models = new Map<string, Promise<GpuModel | undefined>>();
  /** The loaded ones by the same key (memory and eviction). */
  readonly #loadedModels = new Map<string, GpuModel>();
  readonly #borders = new Map<number, Promise<WorldBorder>>();
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
   * The weather picked by hand (the dev panel, as the console's fw), kept going in and out of
   * doors as the game keeps its weather; undefined: the regions pick.
   */
  pinnedWeather: number | undefined;
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
  #actors: Promise<ActorPlacer> | undefined;
  /** Head parts' expression morphs by TRI path (kept for the session: a few dozen files). */
  readonly #morphs = new Map<string, Promise<GpuMorphs | undefined>>();
  #morphBytes = 0;

  constructor(device: GPUDevice, renderer: Renderer, vfs: Vfs, terminal: Terminal) {
    this.vfs = vfs;
    this.#renderer = renderer;
    this.#terminal = terminal;
    this.scriptWorld = new ScriptWorld(terminal);
    this.scriptWorld.sounds = () => this.soundSystem;
    const loader = new AssetLoader(vfs);
    this.loader = loader;
    this.textures = new TextureCache(device, (path) => loader.loadTexture(path));
    this.animation = new AnimationAssets(vfs, terminal);
    // The plugins' record headers (~1.2 million) are read in workers.
    const start = performance.now();
    const indexer = new PluginIndexer();
    const indexed = RecordDatabase.open(vfs, 'english', (source, name) =>
      indexer.index(name, source),
    ).finally(() => {
      indexer.dispose();
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

  /** Where an actor's AI package has it now, as its cell loads (src/ai/package-start.ts). */
  async packageStart(actor: CellActor, look: ActorLook): Promise<PackageStart> {
    this.#packages ??= this.db.then(async (db) => {
      const data = new PackageData(db, undefined, () => this.scriptsReady);
      await data.ready();
      return data;
    });
    const data = await this.#packages;
    const placed = await data.reference(actor.reference);
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

  /** Models attached at AddOnNodes get no add-ons of their own (no cycles). */
  #model(path: string, withAddons: boolean): Promise<GpuModel | undefined> {
    const key = withAddons ? path : `${path}|addon`;
    let entry = this.#models.get(key);
    const loaded = this.#loadedModels.get(key);
    if (loaded) loaded.lastUsed = performance.now();
    if (!entry) {
      entry = this.loader.loadModel(path).then(
        async (loaded) => {
          const data = loaded.model;
          // Editor markers have no collision in the game either.
          if (!data.editorMarker) this.#collisions.set(path, loaded.collision);
          const addons = withAddons ? await this.addons(data.addons) : [];
          const empty = data.parts.length === 0 && data.particles.length === 0;
          if (data.editorMarker || (empty && addons.length === 0)) return undefined;
          const model = await this.#renderer.scene.createModel(data, this.textures);
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
          const model = await this.#renderer.scene.createModel(data, this.textures);
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

  /** Every weather (WTHR) of the load order, by editor id. */
  weathers(): Promise<readonly { formId: number; editorId: string }[]> {
    this.#weathersEntry ??= this.db.then(async (db) => {
      const records = await Promise.all(db.formIdsOfType('WTHR').map((id) => db.get(id)));
      return records
        .flatMap((record) =>
          record ? [{ formId: record.formId, editorId: record.editorId ?? '' }] : [],
        )
        .sort((a, b) => a.editorId.localeCompare(b.editorId));
    });
    return this.#weathersEntry;
  }

  /** A head part's expression morphs (its TRI file) on the GPU, read once. */
  expressions(path: string): Promise<GpuMorphs | undefined> {
    let entry = this.#morphs.get(path);
    if (!entry) {
      entry = this.loader.loadExpressions(path).then(
        (data) => {
          const morphs = this.#renderer.scene.createMorphs(data);
          this.#morphBytes += morphs.bytes;
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

  /** A worldspace's border regions (where the player may go), read once per worldspace. */
  worldBorder(world: number): Promise<WorldBorder> {
    let entry = this.#borders.get(world);
    if (!entry) {
      entry = this.db.then((db) => WorldBorder.of(db, world));
      this.#borders.set(world, entry);
    }
    return entry;
  }

  /** A model's Havok collision (also for models with nothing to draw). */
  async collision(path: string): Promise<CollisionData | undefined> {
    const cached = this.#collisions.get(path);
    if (cached) return cached;
    await this.#model(path, true);
    return this.#collisions.get(path);
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
    this.#playerData ??= this.db.then(async (db) =>
      readPlayerData(db, this.vfs, await this.settings(), (path) => this.nif(path)),
    );
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
      entry = this.#renderer.scene
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
          return this.#renderer.scene.createDirectionalMaterial(object, pass, this.textures);
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

  /** What places actors in cells (their looks, skeletons and clips are shared). */
  actors(): Promise<ActorPlacer> {
    this.#actors ??= this.db.then((db) => new ActorPlacer(this, db, this.#terminal));
    return this.#actors;
  }

  /**
   * The running game's scripts: a new game started as the session opens (every quest's and
   * persistent reference's OnInit, the quests that start with the game, the opening). The
   * game's clock is the scripts' from then on.
   */
  runtime(): Promise<ScriptRuntime> {
    this.#runtime ??= this.db.then(async (db) => {
      const start = performance.now();
      const library = new ScriptLibrary((name) => db.script(name));
      const runtime = new ScriptRuntime(db, library, {
        world: this.scriptWorld,
        scheduler: new PapyrusScheduler(1.2, () => performance.now()),
        warn: (message) => {
          this.#terminal.log('papyrus', message, 'warn');
        },
        log: (line) => {
          this.#terminal.log('papyrus', line);
        },
      });
      this.scriptsStarting = runtime;
      await runtime.newGame((what) => {
        if (runtime.retired) return;
        this.scriptsProgress = what;
        this.#terminal.log('papyrus', what);
      });
      // A new game asked for meanwhile replaced this one.
      if (runtime.retired) return runtime;
      // From now on threads share each frame's budget ([Papyrus] fUpdateBudgetMS).
      runtime.vm.scheduler.framed = true;
      // A new game's clock: the plugins' day and hour.
      this.gameDaysPassed = Math.floor(runtime.state.gameDaysPassed);
      this.gameHour = (runtime.state.gameDaysPassed % 1) * 24;
      this.timeScale = runtime.timeScale;
      const running = [...runtime.state.quests.values()].filter((quest) => quest.running).length;
      this.#terminal.log(
        'papyrus',
        `new game: ${String(running)} quests running · ${(performance.now() - start).toFixed(0)} ms`,
        'ok',
      );
      this.scriptsReady = runtime;
      // Sounds and music read the running game's globals from now on.
      void this.sounds().then((sounds) => {
        sounds.globals = (formId) => runtime.globalNow(formId);
      });
      this.scriptWorld.enableChanged();
      return runtime;
    });
    return this.#runtime;
  }

  /**
   * Throws the running game away and starts a new one: quests, what scripts enabled, moved and
   * created, the quest and scene states chosen in the panel, the clock. The sandbox's clean
   * state; the viewers load their scene again to show it.
   */
  newGame(): Promise<ScriptRuntime> {
    this.scriptsReady?.retire();
    this.scriptsStarting?.retire();
    this.scriptsReady = undefined;
    this.scriptsStarting = undefined;
    this.scriptsProgress = '';
    this.#runtime = undefined;
    this.cellSelections.clear();
    void this.sounds().then((sounds) => {
      sounds.globals = undefined;
    });
    return this.runtime();
  }

  /**
   * Every frame: the scripts' clocks move with the game's (real seconds, and game days as the
   * sky moves the hour); a script that set the clock (GameHour) sets the game's.
   */
  tickScripts(realSeconds: number): void {
    const runtime = this.scriptsReady;
    if (!runtime) return;
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

  /**
   * The enable states the scripts gave references (Enable, Disable, Delete), for the viewers;
   * empty until the scripts run.
   */
  scriptedEnables(): Map<number, boolean> {
    const states = new Map<number, boolean>();
    for (const [reference, state] of this.scriptsReady?.state.references ?? []) {
      if (state.deleted) states.set(reference, false);
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
    this.#sounds ??= this.db.then(async (db) => {
      const loader = new AudioLoader(this.vfs);
      this.#audioLoader = loader;
      const sounds = await SoundSystem.create(db, loader, new IniSettings(this.vfs.defaultIni));
      sounds.onWarning = (message) => {
        this.#terminal.log('audio', message, 'warn');
      };
      this.soundSystem = sounds;
      return sounds;
    });
    return this.#sounds;
  }

  dispose(): void {
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
