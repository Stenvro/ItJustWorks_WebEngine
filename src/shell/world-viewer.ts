// Exterior worldspaces: streams the cells around the camera (landscape, objects and lights)
// in and out, like the engine's loaded grid (uGridsToLoad 5), under the sky and weather of
// the worldspace's climate and regions.
// Beyond the loaded cells: the worldspace's distant LOD (terrain, water, objects, trees).

import { FlyCamera } from '../render/fly-camera.ts';
import { identity } from '../render/math.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import {
  placedParts,
  type GpuModel,
  type GpuScene,
  type ModelInstance,
  type LodMask,
  type PointLight,
  type SceneLighting,
  type WaterFlow,
  type WaterFrame,
} from '../render/scene-renderer.ts';
import { projectDecals } from '../render/decal-projection.ts';
import type { GpuDecals } from '../render/decals.ts';
import type { GpuGrassField } from '../render/grass.ts';
import { waterPlane } from '../render/water-data.ts';
import { parseGrass, placeGrass, type GrassType } from '../world/grass.ts';
import { cellWater, DEFAULT_WATER } from '../world/water.ts';
import type { GpuTerrainCell, TerrainTexturePaths } from '../render/terrain.ts';
import {
  buildTerrainCell,
  DEFAULT_LAND_NORMAL,
  DEFAULT_LAND_TEXTURE,
} from '../render/terrain-data.ts';
import { pointLights } from '../world/cell-lighting.ts';
import { loadCellData, type CellLight, type CellObject } from '../world/cell-loader.ts';
import { raycastParts } from '../render/raycast.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../world/cell-upgrades.ts';
import { CELL_SIZE, LAND_GRID, landHeightAt, landTexture, type LandData } from '../world/land.ts';
import type { RecordDatabase, WorldspaceInfo } from '../world/record-db.ts';
import { cellKey, Worldspace } from '../world/worldspace.ts';
import type { GameSession } from './game-session.ts';
import { WorldLod } from './world-lod.ts';
import { WorldSky, type SkyElements } from './world-sky.ts';
import type { Terminal } from './terminal.ts';

/** Cells loaded around the camera's cell in each direction (uGridsToLoad 5 → 2). */
const GRID_RADIUS = 2;
/** Cells further than this are unloaded (one cell of slack against thrashing). */
const KEEP_RADIUS = GRID_RADIUS + 1;
const MAX_PARALLEL_LOADS = 3;
const MAX_LIGHTS = 256;
const EYE_HEIGHT = 120;

export interface WorldElements extends SkyElements {
  readonly panel: HTMLElement;
  readonly search: HTMLInputElement;
  readonly results: HTMLOListElement;
  readonly count: HTMLElement;
  readonly status: HTMLElement;
}

interface LoadedCell {
  readonly x: number;
  readonly y: number;
  terrain: GpuTerrainCell | undefined;
  scene: GpuScene | undefined;
  /** Models made for this cell only (its water plane). */
  owned: GpuModel[];
  grass: GpuGrassField[];
  /** Placed decals (blood, scorch marks, puddles). */
  decals: GpuDecals | undefined;
  lights: readonly CellLight[];
  /** The placed objects with their instances (development: what the camera looks at). */
  placed: readonly { readonly object: CellObject; readonly instance: ModelInstance }[];
  /**
   * Whether the worldspace has a cell record here. Positions without one (around a city
   * worldspace's few cells) stay empty and keep showing the distant LOD, as in the game.
   */
  exists: boolean;
  ready: boolean;
}

/** Neutral light until the weather has loaded. */
const NO_SKY: Omit<SceneLighting, 'lights'> = {
  sunDirection: [0, 0, 1],
  sunColor: [0, 0, 0],
  ambient: [
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
    [0.3, 0.3, 0.3],
  ],
  fog: { nearColor: [0, 0, 0], farColor: [0, 0, 0], near: 0, far: 1e9, power: 1, max: 0 },
};

const IDENTITY = identity();

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class WorldViewer {
  readonly #renderer: Renderer;
  readonly #canvas: HTMLElement;
  readonly #terminal: Terminal;
  readonly #ui: WorldElements;
  readonly #onActivate: () => void;
  readonly #camera = new FlyCamera();
  #session: GameSession | undefined;
  #db: RecordDatabase | undefined;
  #worlds: WorldspaceInfo[] = [];
  #world: Worldspace | undefined;
  #sky: WorldSky | undefined;
  #lod: WorldLod | undefined;
  readonly #cells = new Map<string, LoadedCell>();
  readonly #queue: [number, number][] = [];
  #loading = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #detachControls: (() => void) | undefined;
  readonly #landTextures = new Map<number, Promise<TerrainTexturePaths>>();
  /** Grass types by LTEX (GNAM), and GRAS records by form id. */
  readonly #landGrass = new Map<number, Promise<readonly GrassType[]>>();
  readonly #grassTypes = new Map<number, Promise<GrassType | undefined>>();
  /** Bumped when the world changes; loads of an older world are dropped. */
  #generation = 0;

  constructor(
    renderer: Renderer,
    canvas: HTMLElement,
    terminal: Terminal,
    ui: WorldElements,
    onActivate: () => void,
  ) {
    this.#renderer = renderer;
    this.#canvas = canvas;
    this.#terminal = terminal;
    this.#ui = ui;
    this.#onActivate = onActivate;
    this.#camera.speed = 900;
    ui.search.addEventListener('input', () => {
      this.#showResults();
    });
  }

  set lensShift(shift: number) {
    this.#camera.lensShift = shift;
  }

  get camera(): FlyCamera {
    return this.#camera;
  }

  get worldspaces(): readonly WorldspaceInfo[] {
    return this.#worlds;
  }

  /** Time of day and weather of the open worldspace (dev helpers). */
  get sky(): WorldSky | undefined {
    return this.#sky;
  }

  /**
   * Development: the placed object the camera looks at (or along `direction`), with its
   * reference, base and model, and how far away it is.
   */
  pick(
    direction: Vec3 = this.#camera.forward,
  ):
    | { reference: string; base: string; editorId: string; model: string; distance: number }
    | undefined {
    const origin: Vec3 = [...this.#camera.position];
    let best: { object: CellObject; distance: number } | undefined;
    for (const cell of this.#cells.values()) {
      if (!cell.ready) continue;
      for (const { object, instance } of cell.placed) {
        const distance = raycastParts(
          placedParts([instance]),
          origin,
          direction,
          best?.distance ?? 100_000,
          true,
        );
        if (distance !== undefined) best = { object, distance };
      }
    }
    if (!best) return undefined;
    const { object, distance } = best;
    return {
      reference: object.reference.toString(16).padStart(8, '0'),
      base: object.baseType,
      editorId: object.editorId,
      model: object.model,
      distance: Math.round(distance),
    };
  }

  /** Cells loaded around the camera (for dev checks). */
  get loadedCells(): number {
    return [...this.#cells.values()].filter((cell) => cell.ready).length;
  }

  async connect(session: GameSession): Promise<void> {
    this.deactivate();
    this.#session = session;
    this.#landTextures.clear();
    const db = await session.db;
    this.#db = db;
    this.#worlds = await db.worldspaces();
    this.#ui.panel.hidden = false;
    this.#ui.count.textContent = `${String(this.#worlds.length)} worlds`;
    this.#terminal.log('world', `${String(this.#worlds.length)} worldspaces`);
    this.#showResults();
  }

  /** Opens a worldspace at a cell (default: its busiest cell). */
  async open(formId: number, cell?: readonly [number, number]): Promise<void> {
    const db = this.#db;
    if (!db) return;
    this.#onActivate();
    this.deactivate();
    const generation = ++this.#generation;
    const start = performance.now();
    const session = this.#session;
    if (!session) return;
    const world = await Worldspace.open(db, formId);
    const [sky, lod] = await Promise.all([
      WorldSky.create(
        session,
        this.#renderer.sky,
        this.#renderer.precipitation,
        this.#renderer.scene,
        world,
        this.#ui,
        this.#terminal,
      ),
      WorldLod.create(session, this.#renderer, world, this.#terminal),
    ]);
    if (generation !== this.#generation) {
      sky.dispose();
      lod?.dispose();
      return;
    }
    this.#world = world;
    this.#sky = sky;
    this.#lod = lod;
    this.#renderer.scene.defaultWater = await session.waterType(
      world.waterWorld.water ?? DEFAULT_WATER,
    );
    const [x, y] = cell ?? world.busiestCell() ?? [0, 0];
    const land = await world.land(x, y);
    const ground = land?.heights[Math.floor(LAND_GRID / 2) * LAND_GRID + Math.floor(LAND_GRID / 2)];
    this.#camera.position = [
      (x + 0.5) * CELL_SIZE,
      (y + 0.5) * CELL_SIZE,
      (ground ?? world.landWorld.defaultLandHeight) + EYE_HEIGHT * 4,
    ];
    this.#camera.yaw = 0;
    this.#camera.pitch = -0.1;
    this.#terminal.log(
      'world',
      `${world.record.editorId}${world.record.name ? ` "${world.record.name}"` : ''} · cell ${String(x)},${String(y)} · ` +
        `land from ${world.landWorld.editorId} · ${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );
    this.#detachControls = this.#camera.attach(this.#canvas);
    this.#renderer.setView({
      scenes: () => this.#readyScenes(),
      trees: () => this.#lod?.trees(),
      grass: () => this.#readyGrass(),
      decals: () => this.#readyDecals(),
      precipitation: () => this.#sky?.precipitation() ?? [],
      lodMask: () => this.#lodMask(),
      terrain: () => this.#readyTerrain(),
      camera: this.#camera,
      lighting: (camera) => this.#lighting(camera.position),
      sky: () => this.#sky?.skyFrame(),
      water: () => this.#waterFrame(),
      imageSpace: () => this.#sky?.imageSpace(),
      backdrop: false,
      shadows: true,
    });
    document.body.classList.add('has-scene', 'content-scene');
    this.#update();
    this.#timer = setInterval(() => {
      this.#update();
      // Cells come and go: keep the session's models and textures under budget.
      session.trim();
    }, 250);
  }

  /** Stops showing the world and frees its cells (another viewer takes the screen). */
  deactivate(): void {
    this.#generation++;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#detachControls?.();
    this.#detachControls = undefined;
    if (this.#world) this.#renderer.setView(undefined);
    for (const cell of this.#cells.values()) this.#free(cell);
    this.#cells.clear();
    this.#queue.length = 0;
    this.#world = undefined;
    this.#sky?.dispose();
    this.#sky = undefined;
    this.#lod?.dispose();
    this.#lod = undefined;
  }

  // --- Streaming ------------------------------------------------------------------------

  /** Queues the cells around the camera, nearest first, and unloads far ones. */
  #update(): void {
    const world = this.#world;
    if (!world) return;
    const [px, py] = this.#camera.position;
    const cx = Math.floor(px / CELL_SIZE);
    const cy = Math.floor(py / CELL_SIZE);
    for (const [key, cell] of this.#cells) {
      if (Math.max(Math.abs(cell.x - cx), Math.abs(cell.y - cy)) > KEEP_RADIUS) {
        this.#free(cell);
        this.#cells.delete(key);
      }
    }
    this.#queue.length = 0;
    for (let dy = -GRID_RADIUS; dy <= GRID_RADIUS; dy++) {
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        if (!this.#cells.has(cellKey(cx + dx, cy + dy))) this.#queue.push([cx + dx, cy + dy]);
      }
    }
    this.#queue.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    this.#pump();
    this.#lod?.update(px, py);
    this.#sky?.update(world, cx, cy).catch((error: unknown) => {
      this.#terminal.log('sky', describe(error), 'warn');
    });
    this.#ui.status.hidden = false;
    this.#ui.status.textContent = `cell ${String(cx)},${String(cy)} · ${String(this.loadedCells)} cells loaded · ${String(this.#queue.length + this.#loading)} loading`;
  }

  #pump(): void {
    while (this.#loading < MAX_PARALLEL_LOADS && this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (!next) break;
      const [x, y] = next;
      const key = cellKey(x, y);
      if (this.#cells.has(key)) continue;
      const cell: LoadedCell = {
        x,
        y,
        terrain: undefined,
        scene: undefined,
        owned: [],
        grass: [],
        decals: undefined,
        lights: [],
        placed: [],
        exists: false,
        ready: false,
      };
      this.#cells.set(key, cell);
      this.#loading++;
      const generation = this.#generation;
      this.#loadCell(cell)
        .catch((error: unknown) => {
          this.#terminal.log('world', `cell ${key}: ${describe(error)}`, 'warn');
        })
        .finally(() => {
          this.#loading--;
          if (generation !== this.#generation || this.#cells.get(key) !== cell) {
            this.#free(cell);
          } else {
            cell.ready = true;
          }
          this.#pump();
        });
    }
  }

  async #loadCell(cell: LoadedCell): Promise<void> {
    const world = this.#world;
    const session = this.#session;
    const db = this.#db;
    if (!world || !session || !db) return;
    const cellId = await world.cell(cell.x, cell.y);
    // No cell record: nothing is loaded here (not even a parent world's landscape).
    if (cellId === undefined) return;
    cell.exists = true;
    const land = await world.land(cell.x, cell.y);

    const terrain = land
      ? this.#renderer.terrain.createCell(
          buildTerrainCell(land, cell.x, cell.y),
          (ltex) => this.#landTexture(ltex),
          session.textures,
        )
      : Promise.resolve(undefined);

    const data = await loadCellData(db, cellId, world.persistentReferences(cell.x, cell.y));
    const toggles = findToggles(data);
    const isEnabled = enabledReferences(data, toggles, gameStartSelection(toggles));
    const objects = data.objects.filter((object) => isEnabled(object.reference));
    const models = await Promise.all(objects.map((object) => session.model(object.model)));
    // Rivers move along the flow map of the cell they lie in.
    const flow = this.#flowMap(world, cell.x, cell.y);
    const waterTypes = await Promise.all(
      objects.map((object) =>
        object.water === undefined
          ? Promise.resolve(undefined)
          : session.waterType(object.water, flow),
      ),
    );
    const instances: ModelInstance[] = [];
    const placed: { object: CellObject; instance: ModelInstance }[] = [];
    objects.forEach((object, i) => {
      const model = models[i];
      const water = waterTypes[i];
      if (!model) return;
      const instance = { model, world: object.world, ...(water && { water }) };
      instances.push(instance);
      placed.push({ object, instance });
    });
    // The cell's water plane (lakes, rivers and the sea are cell water at a height).
    const water = cellWater(data.cell, {
      height: world.waterWorld.defaultWaterHeight,
      type: world.waterWorld.water,
    });
    if (water) {
      const x0 = cell.x * CELL_SIZE;
      const y0 = cell.y * CELL_SIZE;
      const plane = await this.#renderer.scene.createModel(
        waterPlane(x0, y0, x0 + CELL_SIZE, y0 + CELL_SIZE, water.height),
        session.textures,
      );
      cell.owned.push(plane);
      const type = await session.waterType(water.type ?? DEFAULT_WATER, flow);
      instances.push({ model: plane, world: IDENTITY, ...(type && { water: type }) });
    }
    const scene = this.#renderer.scene.createScene(instances);
    const lights = data.lights.filter((light) => isEnabled(light.reference));
    // Decals land on the first surface along their projection (objects or landscape).
    const projected = projectDecals(
      data.decals,
      placedParts(instances),
      land ? (x, y) => landHeightAt(land, cell.x, cell.y, x, y) : undefined,
    );
    const decals = await this.#renderer.decals.createDecals(projected, session.textures);
    decals?.select(isEnabled);
    cell.terrain = await terrain;
    cell.scene = scene;
    cell.decals = decals;
    cell.lights = lights;
    cell.placed = placed;
    if (land) cell.grass = await this.#grass(land, cell, water?.height);
  }

  /** Grass of a cell: placed by its land textures, one instanced field per grass type. */
  async #grass(
    land: LandData,
    cell: LoadedCell,
    waterHeight: number | undefined,
  ): Promise<GpuGrassField[]> {
    const session = this.#session;
    if (!session) return [];
    const textures = new Set<number | undefined>();
    for (const quadrant of land.quadrants) {
      textures.add(quadrant.base);
      for (const layer of quadrant.layers) textures.add(layer.texture);
    }
    const lists = new Map<number | undefined, readonly GrassType[]>();
    await Promise.all(
      [...textures].map(async (ltex) => {
        lists.set(ltex, ltex === undefined ? [] : await this.#grassOf(ltex));
      }),
    );
    const placed = placeGrass(land, cell.x, cell.y, (ltex) => lists.get(ltex) ?? [], waterHeight);
    const fields: GpuGrassField[] = [];
    for (const [type, plants] of placed) {
      const model = await session.model(type.model);
      const field = model && this.#renderer.grass.createField(model, type, plants);
      if (field) fields.push(field);
    }
    return fields;
  }

  #grassOf(ltex: number): Promise<readonly GrassType[]> {
    const db = this.#db;
    if (!db) return Promise.resolve([]);
    let pending = this.#landGrass.get(ltex);
    if (!pending) {
      pending = landTexture((id) => db.get(id), ltex).then(async (texture) => {
        const types = await Promise.all((texture?.grass ?? []).map((id) => this.#grassType(id)));
        return types.filter((type): type is GrassType => type !== undefined);
      });
      this.#landGrass.set(ltex, pending);
    }
    return pending;
  }

  #grassType(formId: number): Promise<GrassType | undefined> {
    const db = this.#db;
    if (!db) return Promise.resolve(undefined);
    let pending = this.#grassTypes.get(formId);
    if (!pending) {
      pending = db
        .get(formId)
        .then((record) => (record?.type === 'GRAS' ? parseGrass(record) : undefined));
      this.#grassTypes.set(formId, pending);
    }
    return pending;
  }

  #landTexture(ltex: number | undefined): Promise<TerrainTexturePaths> {
    const fallback: TerrainTexturePaths = {
      diffuse: DEFAULT_LAND_TEXTURE,
      normal: DEFAULT_LAND_NORMAL,
    };
    const db = this.#db;
    if (ltex === undefined || !db) return Promise.resolve(fallback);
    let pending = this.#landTextures.get(ltex);
    if (!pending) {
      pending = landTexture((id) => db.get(id), ltex).then((texture) =>
        texture
          ? { diffuse: texture.diffuse || DEFAULT_LAND_TEXTURE, normal: texture.normal }
          : fallback,
      );
      this.#landTextures.set(ltex, pending);
    }
    return pending;
  }

  #free(cell: LoadedCell): void {
    cell.terrain?.destroy();
    cell.scene?.destroy();
    cell.decals?.destroy();
    cell.decals = undefined;
    for (const model of cell.owned.splice(0)) model.destroy();
    for (const field of cell.grass.splice(0)) field.destroy();
    cell.terrain = undefined;
    cell.scene = undefined;
    cell.ready = false;
  }

  *#readyScenes(): Iterable<GpuScene> {
    if (this.#sky) yield* this.#sky.skyScenes();
    if (this.#lod) yield* this.#lod.scenes();
    for (const cell of this.#cells.values()) if (cell.ready && cell.scene) yield cell.scene;
  }

  *#readyDecals(): Iterable<GpuDecals> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.decals) yield cell.decals;
  }

  *#readyGrass(): Iterable<GpuGrassField> {
    for (const cell of this.#cells.values()) if (cell.ready) yield* cell.grass;
  }

  /** Loaded cells around the camera, where distant LOD gives way to them. */
  #lodMask(): LodMask {
    const [px, py] = this.#camera.position;
    const originX = Math.floor(px / CELL_SIZE) - 3;
    const originY = Math.floor(py / CELL_SIZE) - 3;
    let low = 0;
    let high = 0;
    for (const cell of this.#cells.values()) {
      if (!cell.ready || !cell.exists) continue;
      const dx = cell.x - originX;
      const dy = cell.y - originY;
      if (dx < 0 || dy < 0 || dx >= 7 || dy >= 7) continue;
      const bit = dy * 7 + dx;
      if (bit < 32) low |= 1 << bit;
      else high |= 1 << (bit - 32);
    }
    return { originX, originY, low, high };
  }

  *#readyTerrain(): Iterable<GpuTerrainCell> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.terrain) yield cell.terrain;
  }

  /** The flow map of a cell (textures\water\<the world's plugin>\flow.x.y.dds). */
  #flowMap(world: Worldspace, x: number, y: number): WaterFlow {
    const plugin = world.db.locateAll(world.waterWorld.formId)[0]?.plugin.entry.name ?? '';
    return {
      texture: `textures\\water\\${plugin.toLowerCase()}\\flow.${String(x)}.${String(y)}.dds`,
      origin: [x * CELL_SIZE, y * CELL_SIZE],
    };
  }

  /** Sky colours and the weather's water tint for the water shader. */
  #waterFrame(): WaterFrame | undefined {
    const frame = this.#sky?.skyFrame();
    if (!frame) return undefined;
    const { state } = frame;
    return {
      horizon: state.horizon,
      lower: state.skyLower,
      upper: state.skyUpper,
      multiplier: state.waterMultiplier,
      profile: frame.sky.profile,
    };
  }

  /** The sky's light (time of day and weather) plus the nearest point lights. */
  #lighting(camera: Vec3): SceneLighting {
    const lights: (PointLight & { distance: number })[] = [];
    const seconds = performance.now() / 1000;
    for (const cell of this.#cells.values()) {
      if (!cell.ready) continue;
      for (const light of pointLights(cell.lights, seconds, camera)) {
        lights.push({
          ...light,
          distance: Math.hypot(
            light.position[0] - camera[0],
            light.position[1] - camera[1],
            light.position[2] - camera[2],
          ),
        });
      }
    }
    lights.sort((a, b) => a.distance - b.distance);
    this.#sky?.frame(performance.now(), camera);
    const sky = this.#sky?.lighting() ?? NO_SKY;
    return { ...sky, lights: lights.slice(0, MAX_LIGHTS) };
  }

  // --- UI -------------------------------------------------------------------------------

  #showResults(): void {
    const terms = this.#ui.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const found = this.#worlds
      .filter((world) => {
        const text = `${world.editorId} ${world.name}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, 80);
    this.#ui.results.replaceChildren(
      ...found.map((world) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'result';
        button.textContent = world.name ? `${world.editorId} · ${world.name}` : world.editorId;
        button.addEventListener('click', () => {
          this.open(world.formId).catch((error: unknown) => {
            this.#terminal.log('err', describe(error), 'error');
          });
        });
        li.append(button);
        return li;
      }),
    );
  }
}
