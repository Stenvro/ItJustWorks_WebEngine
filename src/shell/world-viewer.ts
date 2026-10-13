// Exterior worldspaces: streams the cells around the camera (landscape, objects and lights)
// in and out, like the engine's loaded grid (uGridsToLoad 5), under the sky and weather of
// the worldspace's climate and regions.
// Beyond the loaded cells: the worldspace's distant LOD (terrain, water, objects, trees).

import { FlyCamera } from '../render/fly-camera.ts';
import { identity } from '../render/math.ts';
import type { Vec3 } from '../render/math.ts';
import type { Camera, Renderer } from '../render/renderer.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import {
  placedParts,
  type GpuModel,
  type GpuScene,
  type ModelInstance,
  type LargeRefMask,
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
import type { AmbientState } from '../audio/ambience.ts';
import { cellWater, DEFAULT_WATER } from '../world/water.ts';
import type { GpuTerrainCell, TerrainLodBlock, TerrainTexturePaths } from '../render/terrain.ts';
import { parseLodSettings, type LodSettings } from '../formats/lod/lod.ts';
import {
  buildTerrainCell,
  DEFAULT_LAND_NORMAL,
  DEFAULT_LAND_TEXTURE,
} from '../render/terrain-data.ts';
import { pointLights } from '../world/cell-lighting.ts';
import {
  doorDestination,
  loadCellData,
  type CellLight,
  type CellAcousticArea,
  type CellObject,
  type CellSoundEmitter,
  type DoorDestination,
  type Teleport,
} from '../world/cell-loader.ts';
import { raycastParts } from '../render/raycast.ts';
import { enabledReferences, findToggles, gameStartSelection } from '../world/cell-upgrades.ts';
import { CELL_SIZE, LAND_GRID, landHeightAt, landTexture, type LandData } from '../world/land.ts';
import type { RecordDatabase, WorldspaceInfo } from '../world/record-db.ts';
import { cellKey, WorldFlag, Worldspace, type Arrival } from '../world/worldspace.ts';
import { LARGE_REFERENCE_GRID, largeReferencesAround } from '../world/large-references.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph } from './object-graphs.ts';
import { WorldLod } from './world-lod.ts';
import { WorldSky, type SkyElements } from './world-sky.ts';
import type { Rgb } from '../world/cell-records.ts';
import type { Terminal } from './terminal.ts';
import { Player } from './player.ts';
import {
  collisionGroup,
  objectActivation,
  openable,
  PlaySession,
  type Activatable,
  type CollisionGroup,
} from './play-session.ts';

/** Cells loaded around the camera's cell in each direction (uGridsToLoad 5 → 2). */
const GRID_RADIUS = 2;
/** Cells further than this are unloaded (one cell of slack against thrashing). */
const KEEP_RADIUS = GRID_RADIUS + 1;
const MAX_PARALLEL_LOADS = 3;
/** Large references load this many cells around the camera (uLargeRefLODGridSize 11). */
const LARGE_REFERENCE_RADIUS = Math.floor(LARGE_REFERENCE_GRID / 2);

const MAX_LIGHTS = 256;
const EYE_HEIGHT = 120;

export interface WorldElements extends SkyElements {
  readonly panel: HTMLElement;
  readonly search: HTMLInputElement;
  readonly results: HTMLOListElement;
  readonly count: HTMLElement;
  readonly status: HTMLElement;
  /** Play controls (the free camera). */
  readonly play: HTMLElement;
  readonly freeCamera: HTMLInputElement;
  /** What the crosshair rests on. */
  readonly prompt: HTMLElement;
  /** The game's notifications. */
  readonly notice: HTMLElement;
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
  /** Collision of its landscape and objects in the physics world. */
  readonly collision: CollisionGroup;
  /** Its enabled objects by reference (what the crosshair can rest on). */
  objects: ReadonlyMap<number, CellObject>;
  /** The cell's water surface, if it has water. */
  waterHeight: number | undefined;
  /** The placed objects with their instances (development: what the camera looks at). */
  placed: readonly { readonly object: CellObject; readonly instance: ModelInstance }[];
  /** Its enabled looping sounds and acoustic spaces. */
  emitters: readonly CellSoundEmitter[];
  acousticAreas: readonly CellAcousticArea[];
  /**
   * Whether the worldspace has a cell record here. Positions without one (around a city
   * worldspace's few cells) stay empty and keep showing the distant LOD, as in the game.
   */
  exists: boolean;
  ready: boolean;
}

/** A cell beyond the loaded grid whose large references are shown (uLargeRefLODGridSize). */
interface LargeReferenceCell {
  readonly x: number;
  readonly y: number;
  /** The references this cell's scene was made for. */
  readonly references: ReadonlySet<number>;
  scene: GpuScene | undefined;
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
  /** The free camera (tfc), also used while the player waits for the ground to load. */
  readonly #camera = new FlyCamera();
  /** The physics world and the player while a world is open. */
  #play: PlaySession | undefined;
  #session: GameSession | undefined;
  #db: RecordDatabase | undefined;
  #worlds: WorldspaceInfo[] = [];
  #world: Worldspace | undefined;
  #sky: WorldSky | undefined;

  /** Whether the open world has no sky (WRLD DATA flag 0x20). */
  get #noSky(): boolean {
    return ((this.#world?.record.flags ?? 0) & WorldFlag.noSky) !== 0;
  }
  #lod: WorldLod | undefined;
  readonly #cells = new Map<string, LoadedCell>();
  readonly #queue: [number, number][] = [];
  #loading = 0;
  /** Whether large references stream in beyond the loaded cells (development switch). */
  streamLargeReferences = true;
  /** Cells beyond the loaded grid showing only their large references. */
  readonly #largeCells = new Map<string, LargeReferenceCell>();
  readonly #largeQueue: { x: number; y: number; references: ReadonlySet<number> }[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #landTextures = new Map<number, Promise<TerrainTexturePaths>>();
  /** The LOD world's settings (LOD terrain blocks), if it has terrain LOD. */
  #lodSettings: { readonly name: string; readonly settings: LodSettings } | undefined;
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
    ui.freeCamera.addEventListener('change', () => {
      this.#play?.setFreeCamera(ui.freeCamera.checked);
    });
  }

  /** What the renderer looks through: the player's camera, or the free camera. */
  get #view(): Camera {
    return this.#play?.view ?? this.#camera;
  }

  /** The player (while playing a world). */
  get player(): Player | undefined {
    return this.#play?.player;
  }

  /** The physics world and player of the open world. */
  get play(): PlaySession | undefined {
    return this.#play;
  }

  /** Called when the player goes through a load door (the app takes them there). */
  onTravel: ((teleport: Teleport) => void) | undefined;
  /** Load door destinations by destination door. */
  readonly #destinations = new Map<number, DoorDestination | undefined>();

  async #destination(teleport: Teleport): Promise<DoorDestination | undefined> {
    if (!this.#destinations.has(teleport.door) && this.#db) {
      this.#destinations.set(teleport.door, await doorDestination(this.#db, teleport));
    }
    return this.#destinations.get(teleport.door);
  }

  /** What activating a reference does: load doors take the player to their destination. */
  #activatable(reference: number): Activatable | undefined {
    for (const cell of this.#cells.values()) {
      const object = cell.objects.get(reference);
      if (!object) continue;
      const instance = cell.placed.find((placed) => placed.object === object)?.instance;
      return objectActivation(
        object,
        instance,
        {
          name: (teleport) => this.#destinations.get(teleport.door)?.name ?? '',
          go: (teleport) => this.onTravel?.(teleport),
        },
        (descriptor, at) => void this.#session?.soundSystem?.play(descriptor, at),
      );
    }
    return undefined;
  }

  /** Whether the collision under a point is in place (the player can stand there). */
  #groundReady(feet: Vec3): boolean {
    const cell = this.#cells.get(
      cellKey(Math.floor(feet[0] / CELL_SIZE), Math.floor(feet[1] / CELL_SIZE)),
    );
    return cell?.ready === true && (!cell.exists || cell.collision.ready);
  }

  set lensShift(shift: number) {
    this.#camera.lensShift = shift;
    if (this.#play) this.#play.lensShift = shift;
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
    direction: Vec3 = this.#play?.forward ?? this.#camera.forward,
  ):
    | { reference: string; base: string; editorId: string; model: string; distance: number }
    | undefined {
    const origin: Vec3 = [...this.#view.position];
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
  /**
   * Opens a worldspace. The player arrives at `arrival` (a load door's destination), or as
   * the game would bring them in near `cell` (default: the busiest cell): in front of the
   * nearest load door, else at the nearest map marker.
   */
  async open(formId: number, cell?: readonly [number, number], arrival?: Arrival): Promise<void> {
    const db = this.#db;
    if (!db) return;
    this.#onActivate();
    this.deactivate();
    const generation = ++this.#generation;
    const start = performance.now();
    const session = this.#session;
    if (!session) return;
    // The sound system (made once) takes the loaded cells' sounds as they come.
    void session.sounds().then(() => {
      if (generation === this.#generation) this.#refreshSounds();
    });
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
    this.#lodSettings = await this.#readLodSettings(world, session);
    this.#renderer.scene.defaultWater = await session.waterType(
      world.waterWorld.water ?? DEFAULT_WATER,
    );
    const [targetX, targetY] = cell ?? world.busiestCell() ?? [0, 0];
    const comeIn =
      arrival ??
      (await world.arrivalNear((targetX + 0.5) * CELL_SIZE, (targetY + 0.5) * CELL_SIZE));
    // Without a door or map marker: the middle of the cell, on whatever is below.
    const land = comeIn ? undefined : await world.land(targetX, targetY);
    const ground = land?.heights[Math.floor(LAND_GRID / 2) * LAND_GRID + Math.floor(LAND_GRID / 2)];
    const feet: [number, number, number] = comeIn
      ? [...comeIn.position]
      : [
          (targetX + 0.5) * CELL_SIZE,
          (targetY + 0.5) * CELL_SIZE,
          ground ?? world.landWorld.defaultLandHeight,
        ];
    const x = Math.floor(feet[0] / CELL_SIZE);
    const y = Math.floor(feet[1] / CELL_SIZE);
    this.#camera.position = [feet[0], feet[1], feet[2] + EYE_HEIGHT];
    this.#camera.yaw = comeIn?.heading ?? 0;
    this.#camera.pitch = 0;
    // The physics world and the player, standing on the ground of the starting cell.
    const [matrix, playerData] = await Promise.all([
      session.collisionMatrix(),
      session.playerData(),
      initPhysics(),
    ]);
    if (generation !== this.#generation) return;
    const physics = new PhysicsWorld(matrix, GRAVITY);
    const player = new Player(
      {
        ...playerData,
        physics,
        waterHeight: (px, py) =>
          this.#cells.get(cellKey(Math.floor(px / CELL_SIZE), Math.floor(py / CELL_SIZE)))
            ?.waterHeight,
      },
      feet,
      comeIn?.heading ?? 0,
    );
    const play = new PlaySession({
      physics,
      player,
      camera: this.#camera,
      canvas: this.#canvas,
      groundReady: (at) => this.#groundReady(at),
      // Arrival points stand on the ground; without one the landscape may be anywhere below
      // or above the guess.
      searchAbove: comeIn ? 64 : 8192,
      activatable: (reference) => this.#activatable(reference),
      prompt: this.#ui.prompt,
      notice: this.#ui.notice,
    });
    // bBorderRegionsEnabled: the worldspace's border regions stop the player.
    if (playerData.ini.number('General', 'bBorderRegionsEnabled') !== 0) {
      const [border, settings] = await Promise.all([
        session.worldBorder(world.record.formId),
        session.settings(),
      ]);
      const message = settings.string('sPlayerLeavingBorderRegion') ?? '';
      player.border = (px, py) => border.contains(px, py);
      player.onBorder = () => {
        play.notify(message);
      };
    }
    play.lensShift = this.#camera.lensShift;
    play.onFreeCamera = (free) => {
      this.#ui.freeCamera.checked = free;
    };
    this.#play = play;
    this.#ui.freeCamera.checked = false;
    this.#ui.play.hidden = false;
    this.#terminal.log(
      'world',
      `${world.record.editorId}${world.record.name ? ` "${world.record.name}"` : ''} · cell ${String(x)},${String(y)} · ` +
        `land from ${world.landWorld.editorId} · ${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );
    play.attach();
    this.#renderer.setView({
      scenes: () => this.#readyScenes(),
      trees: () => this.#lod?.trees(),
      grass: () => this.#readyGrass(),
      decals: () => this.#readyDecals(),
      precipitation: () => this.#sky?.precipitation() ?? [],
      lodMask: () => this.#lodMask(),
      largeRefMask: () => this.#largeRefMask(),
      terrain: () => this.#readyTerrain(),
      camera: this.#view,
      lighting: (camera) => this.#lighting(camera.position),
      // Worlds without a sky (WRLD DATA 0x20, e.g. Blackreach) draw no dome, sun, moons,
      // stars or clouds; their weather still lights and fogs them.
      sky: () => (this.#noSky ? undefined : this.#sky?.skyFrame()),
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
    if (this.#world) this.#session?.soundSystem?.stopAll();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#world) this.#renderer.setView(undefined);
    for (const cell of this.#cells.values()) this.#free(cell);
    this.#cells.clear();
    this.#queue.length = 0;
    for (const large of this.#largeCells.values()) large.scene?.destroy();
    this.#largeCells.clear();
    this.#largeQueue.length = 0;
    this.#world = undefined;
    this.#sky?.dispose();
    this.#sky = undefined;
    this.#lod?.dispose();
    this.#lod = undefined;
    this.#play?.dispose();
    this.#play = undefined;
    this.#ui.play.hidden = true;
  }

  // --- Streaming ------------------------------------------------------------------------

  /** Queues the cells around the camera, nearest first, and unloads far ones. */
  #update(): void {
    const world = this.#world;
    if (!world) return;
    const [px, py] = this.#view.position;
    const cx = Math.floor(px / CELL_SIZE);
    const cy = Math.floor(py / CELL_SIZE);
    for (const [key, cell] of this.#cells) {
      if (Math.max(Math.abs(cell.x - cx), Math.abs(cell.y - cy)) > KEEP_RADIUS) {
        this.#free(cell);
        this.#cells.delete(key);
        this.#refreshSounds();
      }
    }
    this.#queue.length = 0;
    for (let dy = -GRID_RADIUS; dy <= GRID_RADIUS; dy++) {
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        if (!this.#cells.has(cellKey(cx + dx, cy + dy))) this.#queue.push([cx + dx, cy + dy]);
      }
    }
    this.#queue.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    if (this.streamLargeReferences) this.#updateLargeReferences(world, cx, cy);
    this.#pump();
    this.#lod?.update(px, py);
    this.#sky?.update(world, cx, cy).catch((error: unknown) => {
      this.#terminal.log('sky', describe(error), 'warn');
    });
    this.#ui.status.hidden = false;
    this.#ui.status.textContent = `cell ${String(cx)},${String(cy)} · ${String(this.loadedCells)} cells loaded · ${String(this.#queue.length + this.#loading)} loading`;
  }

  /**
   * Large references of the grid around the camera: the cells beyond the loaded ones get a
   * scene of only those (the loaded cells show them anyway). A cell's scene is kept until the
   * full cell is ready there.
   */
  #updateLargeReferences(world: Worldspace, cx: number, cy: number): void {
    const wanted = largeReferencesAround(world.largeReferences, cx, cy);
    const inGrid = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= GRID_RADIUS;
    const beyond = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - cx), Math.abs(y - cy)) > LARGE_REFERENCE_RADIUS + 1;
    for (const [key, large] of this.#largeCells) {
      const references = wanted.get(key);
      const covered = inGrid(large.x, large.y) && this.#cells.get(key)?.ready === true;
      // No longer listed: kept until well outside the grid (no churn at its edge).
      const stale = references
        ? references.size !== large.references.size ||
          [...references].some((id) => !large.references.has(id))
        : beyond(large.x, large.y);
      if (covered || stale) {
        large.scene?.destroy();
        this.#largeCells.delete(key);
      }
    }
    this.#largeQueue.length = 0;
    for (const [key, references] of wanted) {
      if (this.#largeCells.has(key)) continue;
      const [x = 0, y = 0] = key.split(',').map(Number);
      if (inGrid(x, y)) continue;
      this.#largeQueue.push({ x, y, references });
    }
    this.#largeQueue.sort(
      (a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
    );
  }

  #pump(): void {
    // Large references only once the cells around the camera are on their way.
    while (
      this.#loading < MAX_PARALLEL_LOADS &&
      this.#queue.length === 0 &&
      this.#largeQueue.length > 0
    ) {
      const next = this.#largeQueue.shift();
      if (!next) break;
      const key = cellKey(next.x, next.y);
      if (this.#largeCells.has(key)) continue;
      const large: LargeReferenceCell = { ...next, scene: undefined, ready: false };
      this.#largeCells.set(key, large);
      this.#loading++;
      const generation = this.#generation;
      this.#loadLargeCell(large)
        .catch((error: unknown) => {
          this.#terminal.log('world', `large references ${key}: ${describe(error)}`, 'warn');
        })
        .finally(() => {
          this.#loading--;
          if (generation !== this.#generation || this.#largeCells.get(key) !== large) {
            large.scene?.destroy();
          } else {
            large.ready = true;
          }
          this.#pump();
        });
    }
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
        collision: collisionGroup(),
        objects: new Map(),
        waterHeight: undefined,
        placed: [],
        emitters: [],
        acousticAreas: [],
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
          this.#lodBlock(cell.x, cell.y, session),
        )
      : Promise.resolve(undefined);

    const data = await loadCellData(db, cellId, world.persistentReferences(cell.x, cell.y));
    const toggles = findToggles(data);
    const isEnabled = enabledReferences(data, toggles, gameStartSelection(toggles));
    const objects = data.objects.filter((object) => isEnabled(object.reference));
    // Rivers move along the flow map of the cell they lie in.
    const flow = this.#flowMap(world, cell.x, cell.y);
    const placed = await this.#place(session, objects, flow, true);
    const instances = placed.map(({ instance }) => instance);
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
    cell.waterHeight = water?.height;
    cell.objects = new Map(objects.map((object) => [object.reference, object]));
    cell.emitters = data.emitters.filter((emitter) => isEnabled(emitter.reference));
    cell.acousticAreas = data.acousticAreas.filter((area) => isEnabled(area.reference));
    this.#refreshSounds();
    // Load doors: where they lead (for the activation prompt).
    await Promise.all(
      objects.map(async (object) => {
        if (object.teleport) await this.#destination(object.teleport);
      }),
    );
    const play = this.#play;
    if (play) {
      // Collision: the landscape, the enabled objects (also those with nothing to draw) and
      // collision primitives.
      const collisions = await Promise.all(
        objects.map((object) => session.collision(object.model)),
      );
      if (play !== this.#play) return;
      const instances = new Map(placed.map(({ object, instance }) => [object, instance]));
      play.add(cell.collision, {
        ...(land && { land: { data: land, x: cell.x, y: cell.y } }),
        objects: objects.map((object, i) => ({
          object,
          collision: collisions[i],
          instance: instances.get(object),
        })),
        primitives: data.primitives.filter((primitive) => isEnabled(primitive.reference)),
      });
    }
    if (land) cell.grass = await this.#grass(land, cell, water?.height);
  }

  /** The models of placed objects with their instances (missing models are left out). */
  async #place(
    session: GameSession,
    objects: readonly CellObject[],
    flow: WaterFlow,
    simulated = false,
  ): Promise<{ object: CellObject; instance: ModelInstance }[]> {
    const models = await Promise.all(objects.map((object) => session.model(object.model)));
    // In loaded cells, objects with simulated collision move: they get a matrix of their own.
    const collisions = simulated
      ? await Promise.all(objects.map((object) => session.collision(object.model)))
      : [];
    // Statics' directional materials (snow, moss, ice) as placed.
    const directionals = await Promise.all(
      objects.map((object) => session.directionalMaterial(object.directional)),
    );
    const waterTypes = await Promise.all(
      objects.map((object) =>
        object.water === undefined
          ? Promise.resolve(undefined)
          : session.waterType(object.water, flow),
      ),
    );
    const placed: { object: CellObject; instance: ModelInstance }[] = [];
    objects.forEach((object, i) => {
      const model = models[i];
      const water = waterTypes[i];
      const directional = directionals[i];
      if (!model) return;
      const moves =
        collisions[i]?.bodies.some((body) => body.motion === 'dynamic' && !body.phantom) === true;
      const graph = startObjectGraph(model, object.reference);
      placed.push({
        object,
        instance: {
          model,
          world: moves ? new Float32Array(object.world) : object.world,
          ...(moves && { motion: { version: 0 } }),
          ...(graph && { graph }),
          ...(simulated && {
            playback: openable(object, model.sequences?.byName.has('open') === true),
          }),
          ...(water && { water }),
          ...(directional && { directional }),
          ...(object.leafAnimation && { leafAnimation: object.leafAnimation }),
          ...(object.emittance !== undefined && {
            emittance: session.emittance(object.emittance),
          }),
        },
      });
    });
    return placed;
  }

  /** A cell beyond the loaded grid: a scene of just its large references. */
  async #loadLargeCell(large: LargeReferenceCell): Promise<void> {
    const world = this.#world;
    const session = this.#session;
    const db = this.#db;
    if (!world || !session || !db) return;
    const cellId = await world.cell(large.x, large.y);
    if (cellId === undefined) return;
    const data = await loadCellData(db, cellId, world.persistentReferences(large.x, large.y));
    const toggles = findToggles(data);
    const isEnabled = enabledReferences(data, toggles, gameStartSelection(toggles));
    const objects = data.objects.filter(
      (object) => large.references.has(object.reference) && isEnabled(object.reference),
    );
    const placed = await this.#place(session, objects, this.#flowMap(world, large.x, large.y));
    large.scene = this.#renderer.scene.createScene(placed.map(({ instance }) => instance));
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
      specularPower: 30,
      snow: false,
    };
    const db = this.#db;
    if (ltex === undefined || !db) return Promise.resolve(fallback);
    let pending = this.#landTextures.get(ltex);
    if (!pending) {
      pending = landTexture((id) => db.get(id), ltex).then((texture) =>
        texture
          ? {
              diffuse: texture.diffuse || DEFAULT_LAND_TEXTURE,
              normal: texture.normal,
              specularPower: texture.specularExponent,
              snow: texture.snow,
            }
          : fallback,
      );
      this.#landTextures.set(ltex, pending);
    }
    return pending;
  }

  async #readLodSettings(
    world: Worldspace,
    session: GameSession,
  ): Promise<{ name: string; settings: LodSettings } | undefined> {
    const name = world.lodWorld.editorId.toLowerCase();
    const path = `lodsettings\\${name}.lod`;
    if (!session.vfs.has(path)) return undefined;
    try {
      return { name, settings: parseLodSettings(await session.vfs.read(path)) };
    } catch {
      return undefined;
    }
  }

  /** The smallest LOD terrain block a cell lies in, whose texture its land blends into. */
  #lodBlock(x: number, y: number, session: GameSession): TerrainLodBlock | undefined {
    const lod = this.#lodSettings;
    if (!lod) return undefined;
    const { southWestX, southWestY, lowestLevel } = lod.settings;
    const level = Math.max(1, lowestLevel);
    const bx = southWestX + Math.floor((x - southWestX) / level) * level;
    const by = southWestY + Math.floor((y - southWestY) / level) * level;
    const block = `${lod.name}.${String(level)}.${String(bx)}.${String(by)}`;
    const texture = `textures\\terrain\\${lod.name}\\${block}.dds`;
    if (!session.vfs.has(texture)) return undefined;
    return { texture, x: bx * CELL_SIZE, y: by * CELL_SIZE, size: level * CELL_SIZE };
  }

  /** The surroundings for region and weather sounds. */
  #ambientState(sky: WorldSky): AmbientState {
    const flash = sky.flashStart;
    return {
      regions: sky.regions,
      weather: sky.weather,
      previousWeather: sky.previousWeather,
      transition: sky.transition,
      hour: sky.hour,
      interior: false,
      swimming: this.#play?.player.swimming ?? false,
      flash: Number.isFinite(flash) ? flash : undefined,
    };
  }

  /** The looping sounds and acoustic spaces of the loaded cells, for the sound system. */
  #refreshSounds(): void {
    const sounds = this.#session?.soundSystem;
    if (!sounds || !this.#world) return;
    const cells = [...this.#cells.values()];
    sounds.setEmitters(cells.flatMap((cell) => cell.emitters));
    sounds.setAcousticAreas(cells.flatMap((cell) => cell.acousticAreas));
    sounds.setCellAcousticSpace(undefined);
  }

  #free(cell: LoadedCell): void {
    this.#play?.remove(cell.collision);
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
    if (this.#sky && !this.#noSky) yield* this.#sky.skyScenes();
    if (this.#lod) yield* this.#lod.scenes();
    for (const cell of this.#cells.values()) if (cell.ready && cell.scene) yield cell.scene;
    for (const [key, large] of this.#largeCells) {
      // The full cell shows them once it is ready.
      if (large.ready && large.scene && this.#cells.get(key)?.ready !== true) yield large.scene;
    }
  }

  *#readyDecals(): Iterable<GpuDecals> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.decals) yield cell.decals;
  }

  *#readyGrass(): Iterable<GpuGrassField> {
    for (const cell of this.#cells.values()) if (cell.ready) yield* cell.grass;
  }

  /** Loaded cells around the camera, where distant LOD gives way to them. */
  #lodMask(): LodMask {
    const [px, py] = this.#view.position;
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

  /** Cells of the large-reference grid whose large references are shown in full detail. */
  #largeRefMask(): LargeRefMask {
    const [px, py] = this.#view.position;
    const originX = Math.floor(px / CELL_SIZE) - LARGE_REFERENCE_RADIUS;
    const originY = Math.floor(py / CELL_SIZE) - LARGE_REFERENCE_RADIUS;
    const bits = new Uint32Array(4);
    const mark = (x: number, y: number): void => {
      const dx = x - originX;
      const dy = y - originY;
      if (dx < 0 || dy < 0 || dx >= LARGE_REFERENCE_GRID || dy >= LARGE_REFERENCE_GRID) return;
      const bit = dy * LARGE_REFERENCE_GRID + dx;
      bits[bit >>> 5] = (bits[bit >>> 5] ?? 0) | (1 << (bit & 31));
    };
    for (const large of this.#largeCells.values()) if (large.ready) mark(large.x, large.y);
    for (const cell of this.#cells.values()) if (cell.ready && cell.exists) mark(cell.x, cell.y);
    return { originX, originY, bits };
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

  /** The current colour of an emittance source (lights with REFR XEMI). */
  readonly #emittanceRgb = (formId: number): Rgb =>
    this.#session?.emittance(formId).rgb ?? [0, 0, 0];

  /** The sky's light (time of day and weather) plus the nearest point lights. */
  #lighting(camera: Vec3): SceneLighting {
    const lights: (PointLight & { distance: number })[] = [];
    const seconds = performance.now() / 1000;
    for (const cell of this.#cells.values()) {
      if (!cell.ready) continue;
      for (const light of pointLights(cell.lights, seconds, camera, this.#emittanceRgb)) {
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
    this.#session?.soundSystem?.setAmbience(this.#sky && this.#ambientState(this.#sky));
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
