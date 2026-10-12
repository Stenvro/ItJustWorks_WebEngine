// Everything that belongs to one mounted game folder and is shared by the viewers: the
// VFS, the asset workers, texture and model caches, the record database and the Papyrus
// environment. Disposed when another folder is mounted.

import { parseNif, type NifFile } from '../formats/nif/nif.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuModel, GpuWaterType, WaterFlow } from '../render/scene-renderer.ts';
import { TextureCache } from '../render/texture-cache.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { GameSettings } from '../world/game-settings.ts';
import { parseWater, WaterFlag, type WaterType } from '../world/water.ts';
import { ScriptEnvironment } from '../world/player-home.ts';
import { RecordDatabase } from '../world/record-db.ts';
import { AssetLoader } from '../workers/asset-loader.ts';
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

  constructor(device: GPUDevice, renderer: Renderer, vfs: Vfs, terminal: Terminal) {
    this.vfs = vfs;
    this.#renderer = renderer;
    this.#terminal = terminal;
    const loader = new AssetLoader(vfs);
    this.loader = loader;
    this.textures = new TextureCache(device, (path) => loader.loadTexture(path));
    // TODO(M4): index plugins in a worker; the main thread only does async I/O here, but
    // splitting ~1.2 million record headers still takes a moment.
    const start = performance.now();
    this.db = RecordDatabase.open(vfs).then((db) => {
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

  /** A model for placing in scenes; undefined for editor markers and broken files. */
  model(path: string): Promise<GpuModel | undefined> {
    let entry = this.#models.get(path);
    if (!entry) {
      entry = this.loader.loadModel(path).then(
        async (loaded) => {
          if (loaded.model.editorMarker || loaded.model.parts.length === 0) return undefined;
          return this.#renderer.scene.createModel(loaded.model, this.textures);
        },
        (error: unknown) => {
          this.#terminal.log('nif', describe(error), 'warn');
          return undefined;
        },
      );
      this.#models.set(path, entry);
    }
    return entry;
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
