// Everything that belongs to one mounted game folder and is shared by the viewers: the
// VFS, the asset workers, texture and model caches, the record database and the Papyrus
// environment. Disposed when another folder is mounted.

import { parseNif, type NifFile } from '../formats/nif/nif.ts';
import type { Renderer } from '../render/renderer.ts';
import type { AddonNode } from '../render/model-data.ts';
import type { GpuModel, GpuWaterType, ModelAddon, WaterFlow } from '../render/scene-renderer.ts';
import { TextureCache } from '../render/texture-cache.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { parseAddonNode } from '../world/cell-records.ts';
import { GameSettings } from '../world/game-settings.ts';
import { parseWater, WaterFlag, type WaterType } from '../world/water.ts';
import { ScriptEnvironment } from '../world/player-home.ts';
import { RecordDatabase } from '../world/record-db.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
import { PluginIndexer } from '../workers/plugin-indexer.ts';
import type { Terminal } from './terminal.ts';

const numberFormat = new Intl.NumberFormat('en-US');
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
  #scripts: Promise<ScriptEnvironment> | undefined;
  #settings: Promise<GameSettings> | undefined;
  readonly #waterTypes = new Map<string, Promise<GpuWaterType | undefined>>();
  readonly #waterRecords = new Map<number, Promise<WaterType | undefined>>();
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
    if (!entry) {
      entry = this.loader.loadModel(path).then(
        async (loaded) => {
          const data = loaded.model;
          const addons = withAddons ? await this.addons(data.addons) : [];
          const empty = data.parts.length === 0 && data.particles.length === 0;
          if (data.editorMarker || (empty && addons.length === 0)) return undefined;
          const model = await this.#renderer.scene.createModel(data, this.textures);
          model.addons = addons;
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

  dispose(): void {
    for (const entry of this.#models.values()) void entry.then((model) => model?.destroy());
    this.#models.clear();
    for (const entry of this.#waterTypes.values()) void entry.then((type) => type?.destroy());
    this.#waterTypes.clear();
    this.loader.dispose();
    void this.db.then((db) => db.close());
  }
}
