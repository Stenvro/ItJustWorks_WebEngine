// Distant LOD of an exterior worldspace: terrain blocks (.btr, with their distant water),
// object blocks (.bto) and tree blocks (.btt) around the camera, chosen by distance and
// swapped without holes: a block stays until everything replacing it has loaded. LOD is
// hidden inside loaded cells by the shaders (frame.lodMask).

import {
  parseLodSettings,
  parseTreeBlock,
  parseTreeList,
  type LodSettings,
} from '../formats/lod/lod.ts';
import { identity } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type {
  GpuModel,
  GpuScene,
  GpuWaterType,
  LodSnow,
  ModelInstance,
} from '../render/scene-renderer.ts';
import type { GpuTreeBlock, GpuTreeTypes, TreeLodFrame } from '../render/tree-lod.ts';
import { CELL_SIZE } from '../world/land.ts';
import {
  allLodBlocks,
  blockDistance,
  blocksOfLevel,
  blocksOverlap,
  lodBlockKey,
  selectLodBlocks,
  TREE_LOD_DISTANCE,
  type LodBlock,
} from '../world/lod.ts';
import { DEFAULT_WATER } from '../world/water.ts';
import type { Worldspace } from '../world/worldspace.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Object LOD exists up to blocks of 16 cells. */
const OBJECT_LOD_LEVEL = 16;
/** Tree LOD exists for blocks of 4 cells. */
const TREE_LOD_LEVEL = 4;

interface Entry<T> {
  readonly block: LodBlock;
  /** Undefined while loading, or when the block has nothing to draw. */
  value: T | undefined;
  ready: boolean;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Blocks of one kind: loads them, decides which to show, frees the rest. */
class BlockSet<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #load: (block: LodBlock) => Promise<T | undefined>;
  readonly #free: (value: T) => void;
  #shown: Entry<T>[] = [];
  #shownKey = '';
  /** Bumped when a block finishes loading, so the shown set is recomputed. */
  changed = false;

  constructor(load: (block: LodBlock) => Promise<T | undefined>, free: (value: T) => void) {
    this.#load = load;
    this.#free = free;
  }

  get shown(): readonly Entry<T>[] {
    return this.#shown;
  }

  /** Requests the desired blocks; returns whether the shown set changed. */
  update(desired: readonly LodBlock[]): boolean {
    const wanted = new Set(desired.map(lodBlockKey));
    for (const block of desired) {
      const key = lodBlockKey(block);
      if (this.#entries.has(key)) continue;
      const entry: Entry<T> = { block, value: undefined, ready: false };
      this.#entries.set(key, entry);
      this.#load(block)
        .then((value) => {
          if (this.#entries.get(key) !== entry) {
            if (value !== undefined) this.#free(value);
            return;
          }
          entry.value = value;
        })
        .catch(() => undefined)
        .finally(() => {
          entry.ready = true;
          this.changed = true;
        });
    }
    // Show the ready desired blocks, and old blocks until all that replace them are ready.
    const desiredEntries = desired.flatMap((block) => {
      const entry = this.#entries.get(lodBlockKey(block));
      return entry ? [entry] : [];
    });
    const pending = desiredEntries.filter((entry) => !entry.ready);
    const shown = desiredEntries.filter((entry) => entry.ready);
    for (const entry of this.#shown) {
      if (wanted.has(lodBlockKey(entry.block))) continue;
      if (pending.some((p) => blocksOverlap(p.block, entry.block))) shown.push(entry);
    }
    const shownKeys = new Set(shown.map((entry) => lodBlockKey(entry.block)));
    // Free what is neither wanted nor shown.
    for (const [key, entry] of this.#entries) {
      if (wanted.has(key) || shownKeys.has(key)) continue;
      this.#entries.delete(key);
      if (entry.value !== undefined) this.#free(entry.value);
    }
    const key = [...shownKeys].sort().join('|');
    const changed = key !== this.#shownKey || this.changed;
    this.changed = false;
    this.#shown = shown;
    this.#shownKey = key;
    return changed;
  }

  dispose(): void {
    for (const entry of this.#entries.values())
      if (entry.value !== undefined) this.#free(entry.value);
    this.#entries.clear();
    this.#shown = [];
  }
}

export class WorldLod {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #terminal: Terminal;
  readonly #name: string;
  readonly #settings: LodSettings;
  readonly #water: GpuWaterType | undefined;
  readonly #treeTypes: GpuTreeTypes | undefined;
  /** Snow on the object LOD of snowy statics (shapes named "objsnow"). */
  readonly #lodSnow: LodSnow;
  readonly #terrain: BlockSet<GpuModel>;
  readonly #objects: BlockSet<GpuModel>;
  readonly #trees: BlockSet<GpuTreeBlock>;
  #scene: GpuScene | undefined;
  #disposed = false;
  /** The world map's locked LOD: one size of terrain and of object blocks everywhere. */
  #locked: { readonly terrain: number; readonly objects: number } | undefined;

  private constructor(
    session: GameSession,
    renderer: Renderer,
    terminal: Terminal,
    name: string,
    settings: LodSettings,
    water: GpuWaterType | undefined,
    treeTypes: GpuTreeTypes | undefined,
    lodSnow: LodSnow,
  ) {
    this.#session = session;
    this.#lodSnow = lodSnow;
    this.#renderer = renderer;
    this.#terminal = terminal;
    this.#name = name;
    this.#settings = settings;
    this.#water = water;
    this.#treeTypes = treeTypes;
    const free = (model: GpuModel): void => {
      model.destroy();
    };
    this.#terrain = new BlockSet((block) => this.#model(block, 'btr'), free);
    this.#objects = new BlockSet((block) => this.#model(block, 'bto'), free);
    this.#trees = new BlockSet(
      (block) => this.#treeBlock(block),
      (trees) => {
        trees.destroy();
      },
    );
  }

  /** The LOD of a worldspace (its LOD world's), if it has LOD settings. */
  static async create(
    session: GameSession,
    renderer: Renderer,
    world: Worldspace,
    terminal: Terminal,
  ): Promise<WorldLod | undefined> {
    const name = world.lodWorld.editorId.toLowerCase();
    const settingsPath = `lodsettings\\${name}.lod`;
    if (!session.vfs.has(settingsPath)) return undefined;
    const settings = parseLodSettings(await session.vfs.read(settingsPath));
    const water = await session.waterType(
      world.lodWorld.lodWater ?? world.waterWorld.water ?? DEFAULT_WATER,
    );
    let treeTypes: GpuTreeTypes | undefined;
    const listPath = `meshes\\terrain\\${name}\\trees\\${name}.lst`;
    const atlas = await session.textures.get(
      `textures\\terrain\\${name}\\trees\\${name}treelod.dds`,
    );
    if (atlas && session.vfs.has(listPath)) {
      try {
        const types = parseTreeList(await session.vfs.read(listPath));
        treeTypes = renderer.treeLod.createTypes(types, atlas);
      } catch (error) {
        terminal.log('lod', `${listPath}: ${describe(error)}`, 'warn');
      }
    }
    const lodSnow = await session.lodSnow();
    return new WorldLod(session, renderer, terminal, name, settings, water, treeTypes, lodSnow);
  }

  /**
   * Locks the LOD to one size of blocks over the whole world, without trees (the world map:
   * [MapMenu] uLockedTerrainLOD and uLockedObjectMapLOD).
   */
  lock(terrain: number, objects: number): void {
    this.#locked = { terrain, objects };
  }

  /** Chooses and loads the blocks for a camera position. */
  update(x: number, y: number): void {
    if (this.#disposed) return;
    const exists = (block: LodBlock, kind: string): boolean =>
      this.#session.vfs.has(this.#path(block, kind));
    const locked = this.#locked;
    if (locked) {
      const levels = (level: number): number =>
        Math.min(Math.max(level, this.#settings.lowestLevel), this.#settings.highestLevel);
      const terrainChanged = this.#terrain.update(
        allLodBlocks(this.#settings, levels(locked.terrain)).filter((block) =>
          exists(block, 'btr'),
        ),
      );
      const objectsChanged = this.#objects.update(
        allLodBlocks(this.#settings, Math.min(levels(locked.objects), OBJECT_LOD_LEVEL)).filter(
          (block) => exists(block, 'bto'),
        ),
      );
      if (terrainChanged || objectsChanged) this.#rebuildScene();
      return;
    }
    const selected = selectLodBlocks(this.#settings, x, y);
    const terrain = selected.filter((block) => exists(block, 'btr'));
    const objects = selected
      .flatMap((block) => blocksOfLevel(block, OBJECT_LOD_LEVEL))
      .filter((block) => exists(block, 'bto'));
    const trees = this.#treeTypes
      ? selected
          .filter((block) => blockDistance(block, x, y) < TREE_LOD_DISTANCE)
          .flatMap((block) => blocksOfLevel(block, TREE_LOD_LEVEL))
          .filter((block) => blockDistance(block, x, y) < TREE_LOD_DISTANCE)
          .filter((block) => exists(block, 'btt'))
      : [];
    const terrainChanged = this.#terrain.update(terrain);
    const objectsChanged = this.#objects.update(objects);
    this.#trees.update(trees);
    if (terrainChanged || objectsChanged) this.#rebuildScene();
  }

  *scenes(): Iterable<GpuScene> {
    if (this.#scene) yield this.#scene;
  }

  trees(): TreeLodFrame | undefined {
    const types = this.#treeTypes;
    return types && { types, blocks: this.#treeBlocks() };
  }

  dispose(): void {
    this.#disposed = true;
    this.#scene?.destroy();
    this.#scene = undefined;
    this.#terrain.dispose();
    this.#objects.dispose();
    this.#trees.dispose();
    this.#treeTypes?.destroy();
  }

  *#treeBlocks(): Iterable<GpuTreeBlock> {
    for (const entry of this.#trees.shown) if (entry.value) yield entry.value;
  }

  #rebuildScene(): void {
    const instances: ModelInstance[] = [];
    const water = this.#water;
    for (const entry of this.#terrain.shown) {
      if (!entry.value) continue;
      // Terrain LOD meshes are block-local; objects are already in world space.
      const world = identity();
      world[12] = entry.block.x * CELL_SIZE;
      world[13] = entry.block.y * CELL_SIZE;
      instances.push({ model: entry.value, world, ...(water && { water }) });
    }
    for (const entry of this.#objects.shown) {
      if (entry.value) instances.push({ model: entry.value, world: identity() });
    }
    const previous = this.#scene;
    this.#scene = this.#renderer.scene.createScene(instances, { lodSnow: this.#lodSnow });
    previous?.destroy();
  }

  #path(block: LodBlock, kind: string): string {
    const name = this.#name;
    const file = `${name}.${String(block.level)}.${String(block.x)}.${String(block.y)}.${kind}`;
    const folder = kind === 'bto' ? 'objects\\' : kind === 'btt' ? 'trees\\' : '';
    return `meshes\\terrain\\${name}\\${folder}${file}`;
  }

  async #model(block: LodBlock, kind: 'btr' | 'bto'): Promise<GpuModel | undefined> {
    const path = this.#path(block, kind);
    try {
      const loaded = await this.#session.loader.loadModel(path);
      if (this.#disposed || loaded.model.parts.length === 0) return undefined;
      return await this.#renderer.scene.createModel(loaded.model, this.#session.textures);
    } catch (error) {
      this.#terminal.log('lod', `${path}: ${describe(error)}`, 'warn');
      return undefined;
    }
  }

  async #treeBlock(block: LodBlock): Promise<GpuTreeBlock | undefined> {
    const path = this.#path(block, 'btt');
    try {
      const trees = parseTreeBlock(await this.#session.vfs.read(path));
      return this.#disposed ? undefined : this.#renderer.treeLod.createBlock(trees);
    } catch (error) {
      this.#terminal.log('lod', `${path}: ${describe(error)}`, 'warn');
      return undefined;
    }
  }
}
