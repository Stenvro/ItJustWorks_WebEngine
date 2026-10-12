// Exterior worldspaces: streams the cells around the camera (landscape, objects and lights)
// in and out, like the engine's loaded grid (uGridsToLoad 5).
// TODO(M4): distant LOD, sky, weather and time of day, water.

import { FlyCamera } from '../render/fly-camera.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, ModelInstance, SceneLighting } from '../render/scene-renderer.ts';
import type { GpuTerrainCell, TerrainTexturePaths } from '../render/terrain.ts';
import {
  buildTerrainCell,
  DEFAULT_LAND_NORMAL,
  DEFAULT_LAND_TEXTURE,
} from '../render/terrain-data.ts';
import { loadCellData, type CellLight } from '../world/cell-loader.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../world/cell-upgrades.ts';
import { CELL_SIZE, LAND_GRID, landTexture } from '../world/land.ts';
import type { RecordDatabase, WorldspaceInfo } from '../world/record-db.ts';
import { cellKey, Worldspace } from '../world/worldspace.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Cells loaded around the camera's cell in each direction (uGridsToLoad 5 → 2). */
const GRID_RADIUS = 2;
/** Cells further than this are unloaded (one cell of slack against thrashing). */
const KEEP_RADIUS = GRID_RADIUS + 1;
const MAX_PARALLEL_LOADS = 3;
const MAX_LIGHTS = 256;
const EYE_HEIGHT = 120;

export interface WorldElements {
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
  lights: readonly CellLight[];
  ready: boolean;
}

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
  readonly #cells = new Map<string, LoadedCell>();
  readonly #queue: [number, number][] = [];
  #loading = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #detachControls: (() => void) | undefined;
  readonly #landTextures = new Map<number, Promise<TerrainTexturePaths>>();
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
    const world = await Worldspace.open(db, formId);
    if (generation !== this.#generation) return;
    this.#world = world;
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
      terrain: () => this.#readyTerrain(),
      camera: this.#camera,
      lighting: (camera) => this.#lighting(camera.position),
      backdrop: false,
    });
    document.body.classList.add('has-scene');
    this.#update();
    this.#timer = setInterval(() => {
      this.#update();
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
        lights: [],
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
    const [land, cellId] = await Promise.all([
      world.land(cell.x, cell.y),
      world.cell(cell.x, cell.y),
    ]);

    const terrain = land
      ? this.#renderer.terrain.createCell(
          buildTerrainCell(land, cell.x, cell.y),
          (ltex) => this.#landTexture(ltex),
          session.textures,
        )
      : Promise.resolve(undefined);

    let scene: GpuScene | undefined;
    let lights: CellLight[] = [];
    if (cellId !== undefined) {
      const data = await loadCellData(db, cellId, world.persistentReferences(cell.x, cell.y));
      const toggles = findToggles(data);
      const isEnabled = enabledReferences(data, toggles, gameStartSelection(toggles));
      const objects = data.objects.filter((object) => isEnabled(object.reference));
      const models = await Promise.all(objects.map((object) => session.model(object.model)));
      const instances: ModelInstance[] = [];
      objects.forEach((object, i) => {
        const model = models[i];
        if (model) instances.push({ model, world: object.world });
      });
      scene = this.#renderer.scene.createScene(instances);
      lights = data.lights.filter((light) => isEnabled(light.reference));
    }
    cell.terrain = await terrain;
    cell.scene = scene;
    cell.lights = lights;
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
    cell.terrain = undefined;
    cell.scene = undefined;
    cell.ready = false;
  }

  *#readyScenes(): Iterable<GpuScene> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.scene) yield cell.scene;
  }

  *#readyTerrain(): Iterable<GpuTerrainCell> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.terrain) yield cell.terrain;
  }

  /** Daylight for now, plus the nearest point lights. TODO(M4): climate, weather, time of day. */
  #lighting(camera: Vec3): SceneLighting {
    const lights: { position: Vec3; radius: number; color: Vec3; distance: number }[] = [];
    for (const cell of this.#cells.values()) {
      if (!cell.ready) continue;
      for (const light of cell.lights) {
        lights.push({
          position: [...light.position],
          radius: light.radius,
          color: [
            light.color[0] * light.fade,
            light.color[1] * light.fade,
            light.color[2] * light.fade,
          ],
          distance: Math.hypot(
            light.position[0] - camera[0],
            light.position[1] - camera[1],
            light.position[2] - camera[2],
          ),
        });
      }
    }
    lights.sort((a, b) => a.distance - b.distance);
    const sun: Vec3 = [0.4, -0.5, 0.77];
    const length = Math.hypot(...sun);
    return {
      sunDirection: [sun[0] / length, sun[1] / length, sun[2] / length],
      sunColor: [1.0, 0.92, 0.8],
      ambient: [
        [0.32, 0.34, 0.38],
        [0.3, 0.32, 0.36],
        [0.32, 0.34, 0.38],
        [0.3, 0.32, 0.36],
        [0.42, 0.45, 0.5],
        [0.18, 0.18, 0.18],
      ],
      fog: {
        nearColor: [0.62, 0.68, 0.75],
        farColor: [0.62, 0.68, 0.75],
        near: 4000,
        far: 60000,
        power: 1,
        max: 1,
      },
      lights: lights.slice(0, MAX_LIGHTS),
    };
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
