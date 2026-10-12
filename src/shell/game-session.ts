// Everything that belongs to one mounted game folder and is shared by the viewers: the
// VFS, the asset workers, texture and model caches, the record database and the Papyrus
// environment. Disposed when another folder is mounted.

import { parseNif, type NifFile } from '../formats/nif/nif.ts';
import type { Renderer } from '../render/renderer.ts';
import { propertyMaterial, type AddonNode } from '../render/model-data.ts';
import type {
  GpuDirectionalMaterial,
  GpuModel,
  GpuWaterType,
  LodSnow,
  ModelAddon,
  PlacedDirectional,
  WaterFlow,
} from '../render/scene-renderer.ts';
import { TextureCache } from '../render/texture-cache.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { parseAddonNode } from '../world/cell-records.ts';
import {
  HD_LOD_SNOW_THRESHOLD_ANGLE,
  LOD_MATERIALS,
  LOD_SNOW_THRESHOLD_ANGLE,
  parseMaterialObject,
  type MaterialObject,
  type StaticDirectional,
} from '../world/material-object.ts';
import { GameSettings } from '../world/game-settings.ts';
import { parseWater, WaterFlag, type WaterType } from '../world/water.ts';
import { ScriptEnvironment } from '../world/player-home.ts';
import { RecordDatabase } from '../world/record-db.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
import { PluginIndexer } from '../workers/plugin-indexer.ts';
import type { Terminal } from './terminal.ts';

const numberFormat = new Intl.NumberFormat('en-US');

/**
 * GPU memory for models and textures loaded for the session: past it, the least recently
 * used ones that nothing draws are freed (and loaded again when needed).
 */
export const MEMORY_BUDGET = 2048 * 1024 * 1024;
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
  /** Indexed once per session (all plugins of the load order). */
  readonly db: Promise<RecordDatabase>;
  readonly #renderer: Renderer;
  readonly #terminal: Terminal;
  /** Models by path, shared by every cell and kept for the session. */
  readonly #models = new Map<string, Promise<GpuModel | undefined>>();
  /** The loaded ones by the same key (memory and eviction). */
  readonly #loadedModels = new Map<string, GpuModel>();
  #scripts: Promise<ScriptEnvironment> | undefined;
  #settings: Promise<GameSettings> | undefined;
  readonly #waterTypes = new Map<string, Promise<GpuWaterType | undefined>>();
  readonly #waterRecords = new Map<number, Promise<WaterType | undefined>>();
  /** Material objects (MATO) ready to draw, by form id. */
  readonly #directionalMaterials = new Map<number, Promise<GpuDirectionalMaterial | undefined>>();
  readonly #materialObjects = new Map<number, Promise<MaterialObject | undefined>>();
  #addonPathsEntry: Promise<Map<number, string>> | undefined;

  constructor(device: GPUDevice, renderer: Renderer, vfs: Vfs, terminal: Terminal) {
    this.vfs = vfs;
    this.#renderer = renderer;
    this.#terminal = terminal;
    const loader = new AssetLoader(vfs);
    this.loader = loader;
    this.textures = new TextureCache(device, (path) => loader.loadTexture(path));
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
          const addons = withAddons ? await this.addons(data.addons) : [];
          const empty = data.parts.length === 0 && data.particles.length === 0;
          if (data.editorMarker || (empty && addons.length === 0)) return undefined;
          const model = await this.#renderer.scene.createModel(data, this.textures);
          model.addons = addons;
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

  /** The Papyrus environment, created on first use. */
  scripts(): Promise<ScriptEnvironment> {
    this.#scripts ??= this.db.then((db) => ScriptEnvironment.create(db, this.vfs));
    return this.#scripts;
  }

  /** GPU bytes of the session's models and textures. */
  get memory(): number {
    let models = 0;
    for (const model of this.#loadedModels.values()) models += model.bytes;
    return models + this.textures.bytes;
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

  dispose(): void {
    for (const entry of this.#models.values()) void entry.then((model) => model?.destroy());
    this.#models.clear();
    this.#loadedModels.clear();
    for (const entry of this.#waterTypes.values()) void entry.then((type) => type?.destroy());
    this.#waterTypes.clear();
    this.loader.dispose();
    void this.db.then((db) => db.close());
  }
}
