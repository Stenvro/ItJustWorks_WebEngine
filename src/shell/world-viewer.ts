// Exterior worldspaces: streams the cells around the camera (landscape, objects and lights)
// in and out, like the engine's loaded grid (uGridsToLoad 5), under the sky and weather of
// the worldspace's climate and regions.
// Beyond the loaded cells: the worldspace's distant LOD (terrain, water, objects, trees).

import { FlyCamera } from '../render/fly-camera.ts';
import { identity } from '../render/math.ts';
import type { Mat4, Vec3 } from '../render/math.ts';
import type { Camera, Renderer } from '../render/renderer.ts';
import { RoomCuller } from '../render/room-culler.ts';
import type { CellRooms } from '../world/cell-rooms.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import {
  placedParts,
  type GpuModel,
  type GpuScene,
  type InstanceVisibility,
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
import { waterAreaHeight } from '../audio/water-audio.ts';
import { cellWater, DEFAULT_WATER } from '../world/water.ts';
import { UnderwaterView, withUnderwaterTint } from '../world/underwater.ts';
import type { SceneFog } from '../render/scene-lighting.ts';
import { FlowMaps, waterPlugin } from '../world/flow-map.ts';
import { surfaceOver, waterVolumes, type WaterVolume } from '../world/water-volumes.ts';
import type { GpuTerrainCell, TerrainLodBlock, TerrainTexturePaths } from '../render/terrain.ts';
import { parseLodSettings, type LodSettings } from '../formats/lod/lod.ts';
import {
  buildTerrainCell,
  DEFAULT_LAND_NORMAL,
  DEFAULT_LAND_TEXTURE,
} from '../render/terrain-data.ts';
import { pointLights } from '../world/cell-lighting.ts';
import type { LightProbe } from '../ai/light-level.ts';
import {
  doorDestination,
  type CellLight,
  type CellAcousticArea,
  type CellData,
  referenceMatrix,
  type CellObject,
  type CellSoundEmitter,
  type DoorDestination,
  type Teleport,
  type CellWaterArea,
} from '../world/cell-loader.ts';
import { raycastParts } from '../render/raycast.ts';
import {
  enabledReferences,
  findToggles,
  gameStartSelection,
  type CellToggle,
} from '../world/cell-upgrades.ts';
import {
  cellNavmeshes,
  NAVMESH_TOLERANCE,
  NavmeshSurface,
  NEAREST_TOLERANCE,
} from '../world/navmesh.ts';
import {
  CELL_SIZE,
  LAND_GRID,
  landHeightAt,
  landTexture,
  landTextureAt,
  type LandData,
} from '../world/land.ts';
import type { RecordDatabase, WorldspaceInfo } from '../world/record-db.ts';
import { cellKey, WorldFlag, Worldspace, type Arrival } from '../world/worldspace.ts';
import { LARGE_REFERENCE_GRID, largeReferencesAround } from '../world/large-references.ts';
import {
  animateSkeletons,
  animationRate,
  animationRateSettings,
  fovAcross,
  type AnimatedSkeleton,
  type AnimationRate,
} from '../animation/animated-skeleton.ts';
import { talkTargets, type PlacedActor } from './actors.ts';
import { ActorStage, type StageObstacleCell } from './actor-stage.ts';
import type { DoorObject } from './actor-doors.ts';
import { PlayerFurniture } from './player-furniture.ts';
import type { AdoptedVehicle } from './actor-vehicles.ts';
import { stageObject, type StageObject } from './actor-furniture.ts';
import { summonPlace, type NavmeshSet } from '../ai/pathfinding.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import { noteMoved, placedAsMoved } from './moved-objects.ts';
import {
  instanceNodeWorld,
  MOTION_KEYFRAMED,
  scriptConstraints,
  type ScriptView,
} from './script-world.ts';
import { actorScriptGraph, placedScriptGraph } from '../animation/script-graphs.ts';
import { CreatedObjects } from './created-objects.ts';
import { FloraLooks } from './flora-looks.ts';
import { DestructionLooks } from './destruction-looks.ts';
import { connectPlayerTime } from './time-flow.ts';
import { cellStatesElement } from './cell-states.ts';
import { prepareCameraShake } from './camera-shake.ts';
import { PlayerAvatar } from './player-avatar.ts';
import type { PlayerView } from './race-menu.ts';
import { TreeSway } from '../animation/tree-sway.ts';
import { placeObject, type PlacedObject } from '../sim/placed-objects.ts';
import { groundUnder, type SoundingWorld } from './actor-sounds.ts';
import { CombatTargetKeywords } from './combat-target-keywords.ts';
import type { GameSession } from './game-session.ts';
import { clock } from './object-graphs.ts';
import { WorldLod } from './world-lod.ts';
import { WorldSky, type SkyElements } from './world-sky.ts';
import { sunInView } from '../world/sky-state.ts';
import type { Rgb } from '../world/cell-records.ts';
import type { Terminal } from './terminal.ts';
import { configurePhysics, Player } from './player.ts';
import type { LocalMapContent } from './local-map.ts';
import {
  collisionGroup,
  objectActivation,
  perkActivation,
  PlaySession,
  type Activatable,
  type CollisionGroup,
} from './play-session.ts';

/**
 * Cells loaded around the cell of the streaming centre (#streamCenter: the player while playing)
 * in each direction: half of [General] uGridsToLoad (the default 5 → 2; an even or odd count
 * alike, as the engine centres the grid on the player's cell).
 */
function gridRadius(session: GameSession | undefined): number {
  const grids = session?.ini.number('General', 'uGridsToLoad') ?? 5;
  return Math.max(1, Math.floor(grids / 2));
}
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
  /** The quest and scene states of the cell the camera is in. */
  readonly states: HTMLElement;
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
  /** Its collision is all in the physics world (its actors are set down on it). */
  collided: boolean;
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
  /** The cell's water surface, if it has water, and its type (WATR). */
  waterHeight: number | undefined;
  waterType: number | undefined;
  /** Its landscape (where the water lies above it) and water activators' surfaces. */
  land: LandData | undefined;
  waterAreas: readonly CellWaterArea[];
  /** The water activators' volumes (where one swims and goes under). */
  waterVolumes: readonly WaterVolume[];
  /** Its record and the quest and scene states it has (the dev panel's list). */
  formId: number | undefined;
  toggles: readonly CellToggle[];
  /** The placed objects with their instances (development: what the camera looks at). */
  placed: readonly { readonly object: CellObject; readonly instance: ModelInstance }[];
  /** Its enabled looping sounds and acoustic spaces. */
  emitters: readonly CellSoundEmitter[];
  acousticAreas: readonly CellAcousticArea[];
  /** Where actors walk (its navigation meshes): the player steps onto it off the stairs too. */
  navmesh: NavmeshSurface | undefined;
  /** What animates every frame: the enabled objects whose graph moves their nodes. */
  skeletons: readonly AnimatedSkeleton[];
  /** The cell's references as loaded (all of them, enabled or not). */
  data: CellData | undefined;
  /** Its enable state now (see #enableState). */
  isEnabled: (reference: number) => boolean;
  /** Each drawn reference's visibility (hidden while disabled). */
  readonly visibility: Map<number, InstanceVisibility>;
  /** The enable state each reference with collision was last given. */
  readonly enabledNow: Map<number, boolean>;
  /** Every light that can appear; the enabled ones are `lights`. */
  allLights: readonly CellLight[];
  /** Every water activator's volumes, and every object skeleton, by reference. */
  allWaterVolumes: readonly { reference: number; volumes: WaterVolume[] }[];
  objectSkeletons: readonly { reference: number; skeleton: AnimatedSkeleton }[];
  /** Its references have met the running game's scripts (their cell events). */
  scriptsAttached: boolean;
  /** The instances its scene draws (built again when a script moves a static). */
  sceneInstances: readonly ModelInstance[];
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

/** A cell and the eight around it (offsets), the cell itself first. */
const NEIGHBOURHOOD: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type PlacedEntry = LoadedCell['placed'][number];

/**
 * A cell's placed objects by reference, made once per list (a cell's list is replaced, never
 * changed in place). Scripts ask for references by the thousand (conditions on every candidate
 * of a quest alias, a line's speaker, the compass's targets): a search through every loaded
 * cell's objects for each was most of a quest start's time (docs/rendering.md, "Frame time").
 */
const placedIndexes = new WeakMap<readonly PlacedEntry[], ReadonlyMap<number, PlacedEntry>>();

function placedByReference(cell: LoadedCell, reference: number): PlacedEntry | undefined {
  let index = placedIndexes.get(cell.placed);
  if (!index) {
    const made = new Map<number, PlacedEntry>();
    for (const entry of cell.placed) {
      if (!made.has(entry.object.reference)) made.set(entry.object.reference, entry);
    }
    placedIndexes.set(cell.placed, made);
    index = made;
  }
  return index.get(reference);
}

/** A cell's markers' references (made once per list, as placedByReference). */
const markerIndexes = new WeakMap<readonly { readonly reference: number }[], ReadonlySet<number>>();

function hasMarker(markers: readonly { readonly reference: number }[], reference: number): boolean {
  let index = markerIndexes.get(markers);
  if (!index) {
    index = new Set(markers.map((marker) => marker.reference));
    markerIndexes.set(markers, index);
  }
  return index.has(reference);
}

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
  /** The swaying skeletons of tree models (BSTreeNode), shared by their placements. */
  readonly #treeSways = new Map<string, TreeSway | undefined>();
  /** The cell whose states the panel lists, and whether that list is unfolded. */
  #statesShown: number | undefined;
  #statesOpen = false;
  /** Where placed objects' skeletons are (their instance's placement). */
  readonly #skeletonPlaces = new WeakMap<AnimatedSkeleton, Float32Array>();
  /** Land textures' materials (LTEX MNAM) by LTEX, as cells load. */
  readonly #landMaterials = new Map<number, number | undefined>();
  /** The player's body while playing. */
  #avatar: PlayerAvatar | undefined;
  #session: GameSession | undefined;
  /** The player's combat target's keywords (the combat music's conditions). */
  readonly #combatTarget = new CombatTargetKeywords();
  #db: RecordDatabase | undefined;
  #worlds: WorldspaceInfo[] = [];
  /** The name of the worldspace being opened, until the player stands in it. */
  #opening: string | undefined;
  #world: Worldspace | undefined;
  #sky: WorldSky | undefined;

  /** Whether the open world has no sky (WRLD DATA flag 0x20). */
  get #noSky(): boolean {
    return ((this.#world?.record.flags ?? 0) & WorldFlag.noSky) !== 0;
  }
  #lod: WorldLod | undefined;
  readonly #cells = new Map<string, LoadedCell>();
  /** The loaded cells' culling markers, and the culler made of them (#rooms). */
  #roomSets: readonly CellRooms[] = [];
  #roomCuller: RoomCuller | undefined;
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

  /**
   * Where the loaded area is centred. Playing, the player's feet: the engine's loaded grid is the
   * uGridsToLoad cells around the player's cell (UESP: Skyrim INI), so a camera of its own (the
   * free camera, a menu's, a kill camera, the QA harness's framing of a far anomaly) does not
   * move it and the actors and carts around the player stay loaded. Before the player is placed,
   * and without a play (the viewer), the camera.
   */
  get #streamCenter(): Vec3 {
    const play = this.#play;
    return play?.spawned === true ? play.player.feet : this.#view.position;
  }

  /** The player (while playing a world). */
  get player(): Player | undefined {
    return this.#play?.player;
  }

  /** The player being played: their session and body (the race menu's). */
  get playerView(): PlayerView | undefined {
    const play = this.#play;
    return play && { play, avatar: this.#avatar };
  }

  /**
   * What the map's local map shows here: the loaded cells' landscape, objects and load doors
   * (enabled), and the area they span. Undefined before a world is open.
   */
  localMapContent(): LocalMapContent | undefined {
    const session = this.#session;
    if (!this.#world || !session) return undefined;
    const cells = [...this.#cells.values()].filter((cell) => cell.ready);
    if (cells.length === 0) return undefined;
    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    for (const cell of cells) {
      min[0] = Math.min(min[0], cell.x * CELL_SIZE);
      min[1] = Math.min(min[1], cell.y * CELL_SIZE);
      max[0] = Math.max(max[0], (cell.x + 1) * CELL_SIZE);
      max[1] = Math.max(max[1], (cell.y + 1) * CELL_SIZE);
    }
    return {
      scenes: () => this.#localMapScenes(),
      terrain: () => this.#readyTerrain(),
      area: { min, max },
      interior: false,
      doors: () =>
        [...this.#cells.values()].flatMap((cell) => {
          const data = cell.ready ? cell.data : undefined;
          if (!data || cell.formId === undefined) return [];
          const isEnabled = this.#enableState(session, data, cell.formId, cell.toggles);
          return data.objects.flatMap((object) =>
            object.teleport && isEnabled(object.reference)
              ? [
                  {
                    reference: object.reference,
                    teleport: object.teleport,
                    position: [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0],
                  },
                ]
              : [],
          );
        }),
    };
  }

  *#localMapScenes(): Iterable<GpuScene> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.scene) yield cell.scene;
    if (this.#created) yield* this.#created.scenes();
  }

  /** The physics world and player of the open world. */
  get play(): PlaySession | undefined {
    return this.#play;
  }

  /** What is being opened until the player stands in it (the loading screen's line). */
  get loading(): string | undefined {
    if (this.#opening === undefined) return undefined;
    if (this.#play?.spawned === true) this.#opening = undefined;
    return this.#opening;
  }

  /** Called when the player goes through a load door (the app takes them there). */
  onTravel: ((teleport: Teleport) => void) | undefined;
  /** Play: a script's MoveTo takes the player (the sandbox: never). */
  followsScripts = false;
  /** A script sent the player somewhere this view does not show (Play). */
  onPlayerSent: ((at: Placement) => void) | undefined;

  /** Whether the player is in this view's scene (playing it). */
  /**
   * Play: the place is loaded but what stands in it is not yet: the player's body, the actors
   * of its cells (a loading screen stays until they are there).
   */
  get populating(): boolean {
    return this.playing && (this.#avatar === undefined || this.#stage?.placing === true);
  }

  get playing(): boolean {
    return this.#play !== undefined;
  }

  /**
   * The player goes to a place elsewhere: their followers (and on fast travel, `horse`, their
   * horse) come along (src/shell/actor-followers.ts).
   */
  bringFollowers(at: Placement, horse: boolean): Promise<void> {
    return this.#stage?.followers.comeAlong(at, horse) ?? Promise.resolve();
  }

  /** Puts the player at a place in the worldspace on screen: false if it is not in it. */
  sendPlayer(at: Placement): boolean {
    if (!this.#play || at.world === undefined || at.world !== this.#world?.record.formId) {
      return false;
    }
    this.#play.placePlayer(at.position, at.rotation[2]);
    return true;
  }

  /** The worldspace on screen, if any. */
  get shownWorld(): number | undefined {
    return this.#world?.record.formId;
  }
  /** Load door destinations by destination door. */
  readonly #destinations = new Map<number, DoorDestination | undefined>();

  async #destination(teleport: Teleport): Promise<DoorDestination | undefined> {
    if (!this.#destinations.has(teleport.door) && this.#db) {
      this.#destinations.set(teleport.door, await doorDestination(this.#db, teleport));
    }
    return this.#destinations.get(teleport.door);
  }

  /** The actors of the loaded area (src/shell/actor-stage.ts). */
  #stage: ActorStage | undefined;

  /** The player in furniture (made with their body, for the stage's furniture). */
  #seat: PlayerFurniture | undefined;
  /**
   * An idle a script played on the player before their body was there (the opening's
   * IdleCartPrisonerCIdle as the world loads): played once it is.
   */
  #playerIdle: { readonly idle: number; readonly target: number | undefined } | undefined;

  #makeSeat(play: PlaySession, avatar: PlayerAvatar): PlayerFurniture | undefined {
    const stage = this.#stage;
    if (!stage) return undefined;
    return new PlayerFurniture({
      furniture: stage.furniture,
      play,
      avatar,
      hasKeyword: async (reference, keyword) =>
        (await this.#session?.scriptsReady?.hasKeyword(reference, keyword)) ?? false,
      menuOpen: () => this.#session?.menuMode === true,
    });
  }

  /** The player in furniture (development checks). */
  get playerFurniture(): PlayerFurniture | undefined {
    return this.#seat;
  }

  /** The actors of the loaded area (development checks drive them). */
  get actorStage(): ActorStage | undefined {
    return this.#stage;
  }

  /** A placed actor shown now, by its reference. */
  placedActor(reference: number): PlacedActor | undefined {
    const staged = this.#stage?.get(reference);
    return staged && !staged.visibility.hidden ? staged.placed : undefined;
  }

  /** The actors shown now (enabled, in the loaded area). */
  readyActors(): Iterable<PlacedActor> {
    return this.#stage?.shown() ?? [];
  }

  /** The navigation meshes of the loaded cells (actors' paths). */
  readonly #navmeshes: NavmeshSet = {
    navmesh: (formId) => {
      for (const cell of this.#cells.values()) {
        for (const mesh of cell.navmesh?.meshes ?? []) if (mesh.formId === formId) return mesh;
      }
      return undefined;
    },
    locate: ([x, y, z]) => {
      const cx = Math.floor(x / CELL_SIZE);
      const cy = Math.floor(y / CELL_SIZE);
      // The cell the point is in, else a neighbour's mesh reaching over its edge.
      for (const [dx, dy] of NEIGHBOURHOOD) {
        const found = this.#cells
          .get(cellKey(cx + dx, cy + dy))
          ?.navmesh?.near(x, y, z, NAVMESH_TOLERANCE);
        if (found) return found;
      }
      return undefined;
    },
    nearest: ([x, y, z], reach) => {
      const cx = Math.floor(x / CELL_SIZE);
      const cy = Math.floor(y / CELL_SIZE);
      let best: { point: [number, number, number]; distance: number } | undefined;
      for (const [dx, dy] of NEIGHBOURHOOD) {
        const found = this.#cells
          .get(cellKey(cx + dx, cy + dy))
          ?.navmesh?.nearest(x, y, z, reach, NEAREST_TOLERANCE);
        if (found && (!best || found.distance < best.distance)) best = found;
      }
      return best?.point;
    },
  };

  /** Doors of the loaded cells found for the actors (by reference), with the cell they are in. */
  readonly #doorsFound = new Map<
    number,
    { readonly cell: LoadedCell; readonly door: DoorObject }
  >();

  /** A door of a loaded cell, for the actors going through it (src/shell/actor-doors.ts). */
  #doorOf(reference: number): DoorObject | undefined {
    const found = this.#doorsFound.get(reference);
    if (found && this.#cells.get(cellKey(found.cell.x, found.cell.y)) === found.cell)
      return found.door;
    this.#doorsFound.delete(reference);
    for (const cell of this.#cells.values()) {
      const placed = placedByReference(cell, reference);
      if (!placed) continue;
      const door: DoorObject = { object: placed.object, instance: placed.instance };
      this.#doorsFound.set(reference, { cell, door });
      return door;
    }
    return undefined;
  }

  /** The loaded cell of this world a place is in (the actor stage's key), if any. */
  #stageCellOf(at: {
    position: Vec3;
    cell?: number | undefined;
    world?: number | undefined;
  }): string | undefined {
    const world = this.#world?.record.formId;
    if (world === undefined || (at.world !== undefined && at.world !== world)) return undefined;
    // In an interior cell (a cell and no worldspace): none of the view's.
    if (at.world === undefined && at.cell !== undefined) return undefined;
    return cellKey(Math.floor(at.position[0] / CELL_SIZE), Math.floor(at.position[1] / CELL_SIZE));
  }

  /**
   * What activating a reference does: its scripts get OnActivate; by default load doors take
   * the player to their destination and doors open (unless a script blocks activation). One
   * without a default of its own (an activator) is activated for its scripts.
   */
  #activatable(reference: number): Activatable | undefined {
    // The crosshair offers what the engine's prompt rule shows (a named activator, door,
    // container, item, ...; never a static, an unnamed object or a light that is not carried).
    const target = this.#defaultActivation(reference);
    if (target?.shown === false) return undefined;
    const runtime = this.#session?.scriptsReady;
    if (!runtime || !target) return target;
    return {
      ...target,
      activate: () => {
        runtime.playerActivated(reference, () => {
          target.activate();
        });
      },
    };
  }

  #detachScripts: (() => void) | undefined;
  /** What the scripts created in the loaded cells (PlaceAtMe). */
  #created: CreatedObjects | undefined;
  /** The loaded cells' harvestable flora (their harvested look). */
  #flora: FloraLooks | undefined;
  /** The loaded cells' destructible objects (their stages' looks, their debris). */
  #destruction: DestructionLooks | undefined;

  /** What the running game's scripts see of, and do to, the loaded cells. */
  readonly #scriptView: ScriptView = {
    loadedReferences: () =>
      [...this.#cells.values()].flatMap((cell) => this.#cellLoadedReferences(cell)),
    loaded: (reference) =>
      [...this.#cells.values()].some((cell) => this.#cellHasLoaded(cell, reference)),
    created: (reference) => {
      void this.#showCreated(reference);
      void this.#stage?.created(reference, this.#play?.physics);
    },
    livePlacement: (reference) => {
      const player = this.#play?.player;
      if (reference === PLAYER_REF && player && this.#world) {
        const [x, y, z] = player.feet;
        const cell = this.#cells.get(cellKey(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE)));
        return {
          position: [x, y, z],
          rotation: [0, 0, player.yaw],
          world: this.#world.record.formId,
          ...(cell?.formId !== undefined && { cell: cell.formId }),
        };
      }
      const created = this.#created?.get(reference)?.instance?.world;
      if (created) return { position: [created[12] ?? 0, created[13] ?? 0, created[14] ?? 0] };
      const actor = this.#stage?.livePlacement(reference);
      if (actor) return actor;
      for (const cell of this.#cells.values()) {
        if (!cell.ready) continue;
        const placed = placedByReference(cell, reference);
        const world = placed?.instance.motion ? placed.instance.world : undefined;
        if (world) return { position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] };
      }
      return undefined;
    },
    enableStatesChanged: () => {
      for (const cell of this.#cells.values()) if (cell.ready) this.#refreshCell(cell);
      this.#refreshSounds();
      const runtime = this.#session?.scriptsReady;
      if (runtime) this.#created?.refresh(runtime, this.#play);
    },
    moved: (reference) => {
      void this.#scriptMoved(reference);
    },
    magicEffect: (shown) => {
      this.#stage?.magicEffect(shown);
    },
    effectShader: (shader, target, play, duration) => {
      this.#stage?.effects.shader(shader, target, play, duration);
    },
    visualEffect: (effect, target, play, duration) => {
      this.#stage?.effects.visual(effect, target, play, duration);
    },
    artEffect: (art, target, seconds) => {
      this.#stage?.effects.art(art, target, seconds);
    },
    animated: (reference, event) => {
      this.#stage?.obstacleAnimated(reference, event);
    },
    graphOf: (reference) => {
      for (const cell of this.#cells.values()) {
        const placed = placedByReference(cell, reference);
        const skeleton = cell.objectSkeletons.find((entry) => entry.reference === reference);
        const graph = placedScriptGraph(placed?.instance.graph, skeleton?.skeleton.behavior, clock);
        if (graph) return graph;
      }
      return actorScriptGraph(this.#stage?.get(reference)?.placed.behavior);
    },
    motionTypeChanged: (reference, motionType) => {
      // A cart its horse pulls: its collision is the vehicles' (src/shell/actor-vehicles.ts).
      if (this.#stage?.vehicles.motionTypeChanged(reference, motionType === MOTION_KEYFRAMED))
        return;
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.setMotion(placed, motionType === MOTION_KEYFRAMED);
      }
    },
    fireWeapon: (weapon, source, ammo) => {
      void this.#stage?.combat.fire(weapon, source, ammo);
    },
    ...scriptConstraints(
      () => this.#play?.physics,
      (reference) => [
        ...(this.#play?.placementsOf(reference) ?? []),
        ...(this.#stage?.bodies.placements(reference) ?? []),
      ],
    ),
    impulse: (reference, direction, magnitude, share) => {
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.impulse(placed, direction, magnitude, share);
      }
    },
    explosionPush: (reference, center, push) => {
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.pushFrom(placed, center, push);
      }
    },
    explosionReaches: (from, target, buffer) =>
      this.#stage?.projectiles.reaches(from, target, buffer),
    summonPlace: (from, to, radius) => summonPlace(this.#navmeshes, from, to, radius),
    destructionChanged: (reference, reached) => {
      this.#destruction?.changed(reference, reached);
    },
    explosion: (explosion, at, source) => {
      void this.#stage?.projectiles.burst(explosion, at, source ?? 0);
    },
    activate: (reference, activator) => {
      this.#defaultActivation(reference, activator)?.activate();
    },
    triggerCount: (reference) =>
      (this.#play?.triggerCount(reference) ?? 0) +
      (this.#stage?.movers.triggerCount(reference) ?? 0),
    sunGazed: (direction) => {
      const state = this.#sky?.skyFrame()?.state;
      return state !== undefined && sunInView(state, direction);
    },
    openChanged: (reference, open) => {
      this.#stage?.doors.setOpen(reference, open);
    },
    nodeWorld: (reference, node) => {
      for (const cell of this.#cells.values()) {
        const placed = placedByReference(cell, reference);
        if (placed) return instanceNodeWorld(placed.instance, node);
      }
      return undefined;
    },
    lookChanged: (reference) => this.#lookChanged(reference),
    killed: (reference, killer, silent) => {
      // The dead player's furniture lets go of them first (their body falls from it).
      if (reference === PLAYER_REF) this.#seat?.release();
      this.#stage?.killed(reference, killer, silent);
    },
    currentPackage: (reference) => this.#stage?.ai.current(reference)?.id,
    currentProcedure: (reference) => this.#stage?.ai.current(reference)?.procedure,
    randomSceneStarts: (scene, first, second) =>
      this.#stage?.talk.randomSceneStarts(scene, first, second),
    facesForLine: (speaker, target) => this.#stage?.talk.faces(speaker, target),
    saveActors: () => this.#stage?.saveActors() ?? [],
    saveProjectiles: () => this.#stage?.projectiles.save() ?? [],
    impactAt: (impactDataSet, from, direction, length) =>
      this.#stage?.combat.impactAt(impactDataSet, from, direction, length) ?? false,
    pathTo: (actor, target, walkRun) => {
      const stage = this.#stage;
      const runtime = this.#session?.scriptsReady;
      if (!stage || !runtime || !stage.movers.moves(actor)) return undefined;
      return runtime
        .placement(target)
        .then((at) =>
          at
            ? stage.movers.travel(actor, [...at.position], walkRun >= 0.5 ? 'run' : 'walk')
            : false,
        );
    },
    changingSpace: () => this.#session?.loading === true,
    playerRegions: () => this.#sky?.regions ?? [],
    interaction: (reference) =>
      this.#stage?.furniture.interaction(reference) ?? this.#stage?.mounts.interaction(reference),
    playIdle: (actor, idle, target) => {
      // The player's idles too (the opening's IdleCartPrisonerCIdle in the cart).
      const staged = this.#stage?.get(actor);
      const user = actor === PLAYER_REF ? this.#seat?.user : staged && this.#stage?.userOf(staged);
      if (!user && actor === PLAYER_REF) {
        this.#playerIdle = { idle, target };
        return true;
      }
      if (!user) return false;
      // A script's idle plays in furniture too, and goes to the actor's dependents.
      void this.#stage?.furniture.playIdle(user, idle, target, {
        inFurniture: true,
        dependents: this.#stage.dependentUsers(actor),
      });
      return true;
    },
    // Game.ForceFirstPerson / ForceThirdPerson (the beast forms change in third person).
    pointOfView: (pov) => {
      this.#play?.player.setPov(pov);
    },
    // Game.ShakeCamera: from its source's place (src/shell/camera-shake.ts).
    shakeCamera: (strength, seconds, source) => {
      this.#stage?.graphEvents.shakeCameraFrom(strength, seconds, source);
    },
    // Game.TriggerScreenBlood (src/shell/screen-blood-view.ts).
    screenBlood: (count) => {
      this.#session?.screenBlood.splatter(count);
    },
    interactionLocation: (furniture, from) =>
      this.#stage?.furniture.interactionLocation(furniture, from) ?? Promise.resolve(undefined),
    dependentAnimated: (reference, dependent, added) =>
      this.#stage?.dependentAnimated(reference, dependent, added) ?? false,
    // Carts and their riders, horses and theirs (src/shell/actor-vehicles.ts, actor-mounts.ts).
    vehicleChanged: (actor) => {
      this.#stage?.vehicles.changed(actor);
    },
    tether: (cart, horse) => {
      void this.#stage?.vehicles.tether(cart, horse);
    },
    mountOf: (actor) => this.#stage?.mounts.horseOf(actor),
    flyingMount: (actor) => this.#stage?.mounts.flyingMount(actor),
    flight: (actor) => this.#stage?.flight.scriptState(actor),
    riderOf: (horse) => this.#stage?.mounts.riderOf(horse),
    dismount: (actor) => this.#stage?.mounts.dismount(actor) ?? false,
    motion: (reference) => {
      const motion =
        reference === PLAYER_REF
          ? this.#play?.playerMotion()
          : this.#stage?.movers.motion(reference);
      // The water it stands in (IsInDangerousWater).
      const at =
        reference === PLAYER_REF
          ? this.#play?.player.feet
          : this.#stage?.livePlacement(reference)?.position;
      const water = at && this.#waterAt(at[0], at[1], at[2]);
      return motion && { ...motion, water: water && at[2] < water.height ? water.type : undefined };
    },
    furnitureInUse: (reference, marker) => this.#stage?.furniture.inUse(reference, marker) ?? false,
    evaluatePackage: (reference, restart) => {
      this.#stage?.evaluatePackage(reference, restart);
    },
    combat: () => this.#stage?.combat,
    launchSpell: (spell, source, target, blame) =>
      this.#stage?.launchSpell(spell, source, target, blame) ?? false,
  };

  /**
   * An actor's look changed: the player's body is made again (its appearance, its race); an
   * actor of the loaded area is placed again in its new race where it stands.
   */
  async #lookChanged(reference: number): Promise<void> {
    if (reference === PLAYER_REF) {
      // The decapitation armor goes on in place (src/shell/actor-dismemberment.ts).
      if (await this.#stage?.dismemberment.dressedInPlace(reference)) return;
      await this.#avatar?.rebuild();
      // In furniture, the new body's graph is put back in it.
      const seat = this.#seat;
      if (seat?.seated) await this.#stage?.furniture.bodyReplaced(seat.user);
      return;
    }
    await this.#stage?.lookChanged(reference);
  }

  /**
   * A cart its horse pulls (src/shell/actor-vehicles.ts): out of its cell, its draws and
   * collision (the vehicles show and collide it wherever it goes).
   */
  #adoptVehicle(reference: number): AdoptedVehicle | undefined {
    for (const cell of this.#cells.values()) {
      const entry = placedByReference(cell, reference);
      if (!entry || !cell.ready) continue;
      cell.placed = cell.placed.filter((placed) => placed !== entry);
      cell.sceneInstances = cell.sceneInstances.filter((instance) => instance !== entry.instance);
      const previous = cell.scene;
      cell.scene = this.#renderer.scene.createScene(cell.sceneInstances);
      previous?.destroy();
      const group = cell.collision;
      const pose = entry.instance.pose;
      for (let i = group.articulated.length - 1; i >= 0; i--) {
        if (pose && group.articulated[i]?.pose === pose) group.articulated.splice(i, 1);
      }
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.removePlacement(group, placed);
      }
      return { object: entry.object, instance: entry.instance };
    }
    return undefined;
  }

  /** A script moved a reference of a loaded cell: its instance and its collision follow. */
  async #scriptMoved(reference: number): Promise<void> {
    const runtime = this.#session?.scriptsReady;
    // Where the script sent it, not where the world shows it still (the player, a moving object).
    const at = runtime && (await runtime.placement(reference, false));
    if (!at) return;
    if (reference === PLAYER_REF) {
      // Play: the player goes where the scripts send them, through a journey as a load door
      // does when it is elsewhere. The sandbox is not the game: scripts do not move its player
      // (a new game's opening would send them to the cart to Helgen).
      if (this.followsScripts && !this.sendPlayer(at)) this.onPlayerSent?.(at);
      return;
    }
    const created = this.#created?.get(reference);
    if (created) {
      const world = referenceMatrix({
        position: at.position,
        rotation: at.rotation,
        scale: at.scale,
      });
      for (const collision of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.teleport(
          collision,
          created.instance?.world ?? created.object.world,
          world,
        );
      }
      if (created.instance?.motion) {
        created.instance.world.set(world);
        created.instance.motion.version++;
      } else {
        this.#created?.remove(reference, this.#play);
        await this.#showCreated(reference);
      }
      return;
    }
    if (this.#stage?.get(reference)) {
      await this.#stage.moved(reference, this.#play?.physics);
      return;
    }
    for (const cell of this.#cells.values()) {
      const placed = placedByReference(cell, reference);
      if (!placed) continue;
      const world = referenceMatrix({
        position: at.position,
        rotation: at.rotation,
        scale: at.scale,
      });
      for (const collision of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.teleport(collision, placed.instance.world, world);
      }
      if (placed.instance.motion) {
        placed.instance.world.set(world);
        placed.instance.motion.version++;
      } else {
        // A static instance is part of its cell's scene: the scene is built again with it
        // at its new place.
        placed.instance.world.set(world);
        const previous = cell.scene;
        cell.scene = this.#renderer.scene.createScene(cell.sceneInstances);
        previous?.destroy();
      }
      return;
    }
    // An actor from elsewhere moved into the loaded area.
    await this.#stage?.moved(reference, this.#play?.physics);
  }

  /** What activating a reference does by default (a load door, a door that opens). */
  #defaultActivation(reference: number, activator?: number): Activatable | undefined {
    const created = this.#created?.get(reference);
    for (const cell of created ? [] : this.#cells.values()) {
      const object = cell.objects.get(reference);
      if (!object) continue;
      const instance = cell.placed.find((placed) => placed.object === object)?.instance;
      return this.#objectActivation(object, instance, activator);
    }
    return created && this.#objectActivation(created.object, created.instance, activator);
  }

  #objectActivation(
    object: CellObject,
    instance: ModelInstance | undefined,
    activator?: number,
  ): Activatable | undefined {
    return objectActivation(
      object,
      instance,
      {
        name: (teleport) => this.#destinations.get(teleport.door)?.name ?? '',
        go: (teleport) => this.onTravel?.(teleport),
      },
      (descriptor, at) => void this.#session?.playSound(descriptor, at),
      this.#session?.hud.uses,
      this.#seat,
      activator,
    );
  }

  /** Whether the collision under a point is in place (the player can stand there). */
  /**
   * Whether the collision around a point is in place: its cell and the eight around it (a
   * floor near a cell's edge, a bridge or a city's street may belong to a neighbour).
   */
  #groundReady(feet: Vec3): boolean {
    const cx = Math.floor(feet[0] / CELL_SIZE);
    const cy = Math.floor(feet[1] / CELL_SIZE);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.#cells.get(cellKey(cx + dx, cy + dy));
        if (!cell) {
          // Only the cell itself must be loading; neighbours beyond the loaded grid are not.
          if (dx === 0 && dy === 0) return false;
          continue;
        }
        if (!cell.ready || (cell.exists && !cell.collision.ready)) return false;
      }
    }
    return true;
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
    this.#detachScripts?.();
    this.#detachScripts = session.scriptWorld.attach(this.#scriptView);
    this.#created = new CreatedObjects(session, this.#renderer);
    this.#flora?.clear();
    this.#flora = new FloraLooks(session, this.#renderer);
    this.#destruction?.clear();
    this.#destruction = new DestructionLooks(
      session,
      this.#renderer,
      () => this.#play,
      (message) => {
        this.#terminal.log('world', message, 'warn');
      },
    );
    this.#stage = new ActorStage({
      session,
      seat: () => this.#seat,
      renderer: this.#renderer,
      terminal: this.#terminal,
      sounding: this.#soundingWorld,
      cellOf: (at) => this.#stageCellOf(at),
      cellShown: (key) => this.#cells.get(key)?.ready === true,
      collided: (key) => this.#cells.get(key)?.collided,
      navmeshes: () => this.#navmeshes,
      door: (reference) => this.#doorOf(reference),
      objects: () => this.#stageObjects(),
      obstacles: () => this.#stageObstacles(),
      light: (at) => this.#lightProbe(at),
      focus: () => this.#play?.player.feet,
      // Actors walking into trigger volumes tell their scripts.
      onTrigger: (trigger, actor, entered) => {
        this.#session?.scriptsReady?.triggered(trigger, actor, entered);
      },
      player: () => this.playerView,
      adoptVehicle: (reference) => this.#adoptVehicle(reference),
    });
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
    const info = this.#worlds.find((world) => world.formId === formId);
    try {
      const name = info ? (info.name !== '' ? info.name : info.editorId) : 'worldspace';
      await this.#open(formId, cell, arrival, name);
    } catch (error) {
      this.#opening = undefined;
      throw error;
    }
  }

  async #open(
    formId: number,
    cell: readonly [number, number] | undefined,
    arrival: Arrival | undefined,
    name: string,
  ): Promise<void> {
    const db = this.#db;
    if (!db) return;
    this.#onActivate();
    this.deactivate();
    this.#opening = name;
    const generation = ++this.#generation;
    const start = performance.now();
    const session = this.#session;
    if (!session) return;
    // The sound system (made once) takes the loaded cells' sounds as they come.
    void session.sounds().then(() => {
      if (generation === this.#generation) this.#refreshSounds();
    });
    const world = await session.worldspace(formId);
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
    configurePhysics(physics, playerData);
    const player = new Player(
      {
        ...playerData,
        physics,
        waterHeight: (px, py, pz) => this.#waterAt(px, py, pz)?.height,
        controlsNow: () => playerData.controls,
      },
      feet,
      comeIn?.heading ?? 0,
    );
    // Game.DisablePlayerControls' abCamSwitch keeps the camera as it is.
    player.povSwitchAllowed = () => this.#session?.scriptsReady?.controls.camSwitch !== false;
    player.character.walkable = (px, py, pz) =>
      this.#cells
        .get(cellKey(Math.floor(px / CELL_SIZE), Math.floor(py / CELL_SIZE)))
        ?.navmesh?.heightNear(px, py, pz, NAVMESH_TOLERANCE) !== undefined;
    player.overEncumbered = () => this.#session?.overEncumbered === true;
    // The mount's and the dragon's camera states (src/shell/camera-states.ts).
    player.mount = () => {
      const mounts = this.#stage?.mounts;
      if (mounts?.horseOf(PLAYER_REF) === undefined) return undefined;
      return mounts.flyingMount(PLAYER_REF) ? 'dragon' : 'horse';
    };
    // The vanity camera waits while a menu is open or the player fights.
    player.vanityAllowed = () => {
      const session = this.#session;
      if (!session || session.menuMode) return false;
      return session.scriptsReady?.world.combat?.(PLAYER_REF)?.inCombat !== true;
    };
    // Slow Time's pace and the falls' damage (src/shell/time-flow.ts).
    connectPlayerTime(player, () => this.#session, physics);
    // Sprinting takes stamina (src/scripting/runtime/progression-engine.ts).
    player.canSprint = () => this.#session?.scriptsReady?.progression.canSprint(PLAYER_REF) ?? true;
    player.onSprintRefused = () => {
      this.#session?.scriptsReady?.progression.refused(PLAYER_REF, 'stamina');
    };
    // What the player does that the actors near comment on (src/shell/actor-talk.ts).
    player.onAction = (subtype) => {
      void this.#stage?.talk.playerAction(subtype);
    };
    const play = new PlaySession({
      physics,
      player,
      waterAt: (x, y, z) => this.#waterAt(x, y, z),
      waterRules: playerData.water,
      camera: this.#camera,
      canvas: this.#canvas,
      groundReady: (at) => this.#groundReady(at),
      // Arrival points stand on the ground; without one the landscape may be anywhere below
      // or above the guess.
      searchAbove: comeIn ? 64 : 8192,
      arrivesOnFloor: comeIn !== undefined,
      activatable: (reference) => this.#activatable(reference),
      actorAt: talkTargets(
        () => this.readyActors(),
        () => this.#session,
        this.#terminal,
        // A horse is ridden (src/shell/actor-mounts.ts).
        (placed) => this.#stage?.mounts.activation(placed),
      ),
      // The player's perks on activation (Filter Activation, Activate's choices, labels).
      perks: perkActivation(() => this.#session?.scriptsReady),
      prompt: this.#ui.prompt,
      hud: session.hud,
      notice: this.#ui.notice,
      onImpact: (impact) => {
        // Its sound is a noise the actors may hear (the impact's sound level).
        this.#session?.soundSystem?.impact(impact, (sounded) => {
          this.#stage?.senses.noise(impact.position, undefined, sounded.soundLevel);
        });
      },
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
    // Rivers carry what floats along their cells' flow maps.
    const flows = new FlowMaps((path) =>
      session.vfs.has(path) ? session.vfs.read(path) : Promise.resolve(undefined),
    );
    if (play.water) {
      play.water.flowAt = (x, y) => {
        const world = this.#world;
        return world ? flows.at(waterPlugin(world), x, y) : undefined;
      };
    }
    // The actors near the player move in its physics world.
    this.#stage?.attachPlay(play);
    // The player walking into trigger volumes tells their scripts.
    play.onTrigger = (reference, entered) => {
      this.#session?.scriptsReady?.triggered(reference, PLAYER_REF, entered);
    };
    play.onObjectTrigger = (trigger, object, entered) => {
      this.#session?.scriptsReady?.triggered(trigger, object, entered);
    };
    // The traps the player touches hit them (OnTrapHitStart, ...: trap-hits.ts).
    play.onTrapTouch = (touching) => {
      this.#session?.scriptsReady?.trapHits.touching(PLAYER_REF, touching);
    };
    // The player taking hold of an object and letting it go tells its scripts (OnGrab, OnRelease).
    play.onGrab = (reference, grabbed) => {
      this.#session?.scriptsReady?.events.emit('grabRelease', { reference, grabbed });
    };
    this.#ui.freeCamera.checked = false;
    this.#ui.play.hidden = false;
    // Impacts and footsteps on the landscape sound by its land textures.
    void session.sounds().then((sounds) => {
      sounds.landMaterialAt = (position) => this.#landMaterialAt(position);
    });
    // The camera's shake: its settings and its model's motion (src/shell/camera-shake.ts).
    prepareCameraShake(session, play.player.shake).catch((error: unknown) => {
      this.#terminal.log('world', `the camera's shake: ${describe(error)}`, 'warn');
    });
    // The player's body (third person) and first-person camera animation.
    PlayerAvatar.create(session, this.#renderer, player, this.#soundingWorld).then(
      (avatar) => {
        if (this.#play === play) {
          this.#avatar = avatar;
          if (avatar) {
            // The player's graphs' events go to the engine's handlers as an actor's do (a cart's
            // rider's exit, furniture, strikes, casts: src/shell/actor-graph-events.ts).
            avatar.onGraphEvents = (events, firstPerson) => {
              this.#stage?.graphEvents.player(avatar, events, firstPerson);
            };
          }
          this.#seat = avatar && this.#makeSeat(play, avatar);
          // Made while the player uses furniture (a new play: a script moved them), its graph
          // is put back in it.
          if (this.#seat) void this.#stage?.furniture.bodyReplaced(this.#seat.user);
          const pending = this.#playerIdle;
          this.#playerIdle = undefined;
          const seat = this.#seat;
          if (pending && seat) {
            void this.#stage?.furniture.playIdle(seat.user, pending.idle, pending.target);
          }
          this.#stage?.combat.attachPlayer(play, avatar);
        } else avatar?.destroy();
      },
      (error: unknown) => {
        this.#terminal.log('actor', `player: ${describe(error)}`, 'warn');
      },
    );
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
      rooms: () => this.#rooms(),
      terrain: () => this.#readyTerrain(),
      camera: this.#view,
      lighting: (camera) => this.#lighting(camera.position),
      // Worlds without a sky (WRLD DATA 0x20, e.g. Blackreach) draw no dome, sun, moons,
      // stars or clouds; their weather still lights and fogs them.
      sky: () => (this.#noSky ? undefined : this.#sky?.skyFrame()),
      water: () => this.#waterFrame(),
      // Under water the water's colour lies over everything (src/world/underwater.ts).
      imageSpace: () => withUnderwaterTint(this.#sky?.imageSpace(), this.#under),
      // No sun in a world without a sky: no rays or flare either.
      sunEffects: () => (this.#noSky ? undefined : this.#sky?.sunEffects()),
      screenBlood: () => this.#session?.screenBlood.frame(),
      backdrop: false,
      shadows: true,
      update: (seconds) => {
        // The player animates at their own pace in slowed time.
        this.#avatar?.update(seconds * (this.#session?.time.playerPace ?? 1));
        if (this.#avatar) this.#seat?.frame(this.#avatar.stepped);
        // Pines' branches sway with the weather's wind.
        const wind = this.#sky?.lighting()?.wind ?? 0;
        for (const sway of this.#treeSways.values()) sway?.update(seconds, wind);
        const rate = this.#animationRate();
        for (const cell of this.#cells.values())
          if (cell.ready) animateSkeletons(cell.skeletons, seconds, rate);
        this.#stage?.animate(seconds);
      },
    });
    document.body.classList.add('has-scene', 'content-scene');
    this.#update();
    this.#timer = setInterval(() => {
      this.#update();
      // Cells come and go: keep the session's models and textures under budget.
      session.trim();
    }, 250);
  }

  /** A cell's quest and scene states: as set in the panel, else as a new game has them. */
  #selection(
    session: GameSession,
    cellId: number,
    toggles: readonly CellToggle[],
  ): ReadonlySet<number> {
    return session.cellSelections.get(cellId) ?? gameStartSelection(toggles);
  }

  /** The panel's states: those of the cell the camera is in, once it is loaded. */
  #showStates(cx: number, cy: number): void {
    const cell = this.#cells.get(cellKey(cx, cy));
    const session = this.#session;
    const shown = cell?.ready === true ? cell.formId : undefined;
    if (shown === this.#statesShown) return;
    this.#statesShown = shown;
    const container = this.#ui.states;
    if (!cell || !session || shown === undefined || cell.toggles.length === 0) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    container.replaceChildren(
      cellStatesElement(
        cell.toggles,
        this.#selection(session, shown, cell.toggles),
        (selection) => {
          session.cellSelections.set(shown, selection);
          this.#refreshCell(cell);
          this.#refreshSounds();
        },
        this.#statesOpen,
        (open) => {
          this.#statesOpen = open;
        },
        `quest & scene states of cell ${String(cx)},${String(cy)}`,
      ),
    );
    container.hidden = false;
  }

  /**
   * A cell's enable state: what the running game's scripts set, else the states panel's
   * choice, else the plugin's.
   */
  #enableState(
    session: GameSession,
    data: CellData,
    cellId: number,
    toggles: readonly CellToggle[],
  ): (reference: number) => boolean {
    return enabledReferences(
      data,
      toggles,
      this.#selection(session, cellId, toggles),
      session.scriptedEnables(),
    );
  }

  /**
   * Applies a loaded cell's enable state (scripts or the states panel changed it): what is
   * drawn, collides, animates, lights, sounds and holds water, without loading it again.
   */
  #refreshCell(cell: LoadedCell): void {
    const data = cell.data;
    const session = this.#session;
    if (!data || !session || cell.formId === undefined) return;
    const isEnabled = this.#enableState(session, data, cell.formId, cell.toggles);
    cell.isEnabled = isEnabled;
    for (const [reference, entry] of cell.visibility) entry.hidden = !isEnabled(reference);
    const references = [
      ...data.objects.map((object) => object.reference),
      ...data.primitives.map((primitive) => primitive.reference),
      // The dead's ragdolls.
      ...data.actors.map((actor) => actor.reference),
    ];
    for (const reference of references) {
      const enabled = isEnabled(reference);
      const before = cell.enabledNow.get(reference);
      cell.enabledNow.set(reference, enabled);
      if (before !== undefined && before !== enabled)
        this.#play?.setReferenceEnabled(reference, enabled);
    }
    const objects = data.objects.filter((object) => isEnabled(object.reference));
    cell.objects = new Map(objects.map((object) => [object.reference, object]));
    cell.skeletons = cell.objectSkeletons
      .filter((entry) => isEnabled(entry.reference))
      .map((entry) => entry.skeleton);
    cell.lights = cell.allLights.filter((light) => isEnabled(light.reference));
    cell.waterAreas = data.waterAreas.filter((area) => isEnabled(area.reference));
    cell.waterVolumes = cell.allWaterVolumes
      .filter((entry) => isEnabled(entry.reference))
      .flatMap((entry) => entry.volumes);
    cell.emitters = data.emitters.filter((emitter) => isEnabled(emitter.reference));
    cell.acousticAreas = data.acousticAreas.filter((area) => isEnabled(area.reference));
    cell.decals?.select(isEnabled);
    this.#stage?.refresh();
  }

  /** A loaded cell's references meet the running game's scripts (once their game started). */
  async #attachCellToScripts(cell: LoadedCell): Promise<void> {
    const session = this.#session;
    const data = cell.data;
    if (!session || !data) return;
    try {
      const runtime = await session.runtime();
      if (!cell.ready || cell.scriptsAttached || this.#cells.get(cellKey(cell.x, cell.y)) !== cell)
        return;
      cell.scriptsAttached = true;
      this.#refreshCell(cell);
      const loaded = new Set(this.#cellLoadedReferences(cell));
      await runtime.cellAttached(
        [
          ...data.objects.map((object) => object.reference),
          // Triggers (activators with a primitive) hear who enters them.
          ...data.primitives.map((primitive) => primitive.reference),
          ...(this.#stage?.referencesIn(cellKey(cell.x, cell.y)) ?? []),
        ],
        (reference) => loaded.has(reference),
      );
      for (const [reference, state] of runtime.state.references) {
        if (!runtime.state.created.has(reference) || !state.position) continue;
        const key = cellKey(
          Math.floor(state.position[0] / CELL_SIZE),
          Math.floor(state.position[1] / CELL_SIZE),
        );
        if (key === cellKey(cell.x, cell.y)) await this.#showCreated(reference);
      }
    } catch (error) {
      this.#terminal.log('papyrus', `scripts not running: ${describe(error)}`, 'warn');
    }
  }

  /**
   * The enabled objects and markers of the loaded cells, and those the scripts created (what
   * actors use and search for).
   */
  /** The loaded cells' navmesh obstacles (the stage cuts the navmesh under them). */
  *#stageObstacles(): Iterable<StageObstacleCell> {
    for (const [key, cell] of this.#cells) {
      if (!cell.ready || !cell.data?.obstacles?.length) continue;
      yield { key, obstacles: cell.data.obstacles, isEnabled: cell.isEnabled };
    }
  }

  *#stageObjects(): Iterable<StageObject> {
    for (const cell of this.#cells.values()) {
      if (!cell.ready || !cell.data) continue;
      for (const object of cell.data.objects) {
        if (cell.isEnabled(object.reference)) yield stageObject(object);
      }
      for (const marker of cell.data.markers) if (cell.isEnabled(marker.reference)) yield marker;
    }
    for (const entry of this.#created?.all ?? []) {
      if (!entry.visibility.hidden) yield stageObject(entry.object);
    }
  }

  /** A cell's references whose 3D is loaded (its enabled drawn objects and actors). */
  #cellLoadedReferences(cell: LoadedCell): number[] {
    if (!cell.ready) return [];
    return [
      ...cell.placed
        .map(({ object }) => object.reference)
        .filter((reference) => cell.isEnabled(reference)),
      ...(cell.data?.markers ?? [])
        .map((marker) => marker.reference)
        .filter((reference) => cell.isEnabled(reference)),
      ...(this.#stage?.shownIn(cellKey(cell.x, cell.y)).map((actor) => actor.actor.reference) ??
        []),
      ...[...(this.#created?.all ?? [])]
        .filter(
          (entry) => !entry.visibility.hidden && this.#cellOfCreated(entry.object.world) === cell,
        )
        .map((entry) => entry.reference),
    ];
  }

  /** Whether a reference is among a cell's loaded references (#cellLoadedReferences). */
  #cellHasLoaded(cell: LoadedCell, reference: number): boolean {
    if (!cell.ready) return false;
    if (
      (placedByReference(cell, reference) !== undefined ||
        hasMarker(cell.data?.markers ?? [], reference)) &&
      cell.isEnabled(reference)
    ) {
      return true;
    }
    const staged = this.#stage?.get(reference);
    if (staged?.cell === cellKey(cell.x, cell.y) && !staged.visibility.hidden) return true;
    const created = this.#created?.get(reference);
    return (
      created !== undefined &&
      !created.visibility.hidden &&
      this.#cellOfCreated(created.object.world) === cell
    );
  }

  /** The loaded cell a created reference stands in. */
  #cellOfCreated(world: Mat4): LoadedCell | undefined {
    const key = cellKey(
      Math.floor((world[12] ?? 0) / CELL_SIZE),
      Math.floor((world[13] ?? 0) / CELL_SIZE),
    );
    const cell = this.#cells.get(key);
    return cell?.ready === true ? cell : undefined;
  }

  /** A reference the scripts created: shown if it stands in a loaded cell of this world. */
  async #showCreated(reference: number): Promise<void> {
    const runtime = this.#session?.scriptsReady;
    const world = this.#world;
    if (!runtime || !world || !this.#created) return;
    const at = await runtime.placement(reference);
    if (at?.world !== world.record.formId) return;
    const key = cellKey(
      Math.floor(at.position[0] / CELL_SIZE),
      Math.floor(at.position[1] / CELL_SIZE),
    );
    if (this.#cells.get(key)?.ready !== true || this.#world !== world) return;
    await this.#created.add(runtime, reference, this.#play);
  }

  /** How often each skeleton's graph updates, by where it is seen from (animationRate). */
  #animationRate(): ((animated: AnimatedSkeleton) => AnimationRate) | undefined {
    const camera = this.#renderer.view?.camera;
    const session = this.#session;
    if (!camera || !session) return undefined;
    const settings = animationRateSettings(session.ini);
    const view = {
      position: camera.position,
      forward: camera.forward,
      fov: camera.fovY === undefined ? 80 : fovAcross(camera.fovY),
    };
    return (animated) => {
      const world = this.#skeletonPlaces.get(animated);
      return animationRate(
        world ? [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] : view.position,
        view,
        settings,
      );
    };
  }

  /** Stops showing the world and frees its cells (another viewer takes the screen). */
  deactivate(): void {
    // The panel's controls are shared with the interiors: only a world that was open puts
    // them away (the interior viewer may already show its own).
    const active = this.#world !== undefined || this.#play !== undefined;
    this.#generation++;
    this.#opening = undefined;
    if (this.#world) this.#session?.soundSystem?.stopAll();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#world) this.#renderer.setView(undefined);
    for (const cell of this.#cells.values()) this.#free(cell);
    this.#cells.clear();
    this.#stage?.clear();
    this.#queue.length = 0;
    for (const large of this.#largeCells.values()) large.scene?.destroy();
    this.#largeCells.clear();
    this.#largeQueue.length = 0;
    this.#world = undefined;
    this.#sky?.dispose();
    this.#sky = undefined;
    if (active) {
      this.#ui.status.hidden = true;
      this.#ui.states.hidden = true;
      this.#ui.states.replaceChildren();
    }
    this.#statesShown = undefined;
    this.#lod?.dispose();
    this.#lod = undefined;
    this.#avatar?.destroy();
    this.#avatar = undefined;
    this.#seat = undefined;
    this.#playerIdle = undefined;
    this.#stage?.combat.attachPlayer(undefined, undefined);
    this.#stage?.attachPlay(undefined);
    this.#play?.dispose();
    this.#play = undefined;
    if (this.#session?.soundSystem) this.#session.soundSystem.landMaterialAt = undefined;
    if (active) this.#ui.play.hidden = true;
  }

  // --- Streaming ------------------------------------------------------------------------

  /** Queues the cells around the streaming centre, nearest first, and unloads far ones. */
  #update(): void {
    const world = this.#world;
    if (!world) return;
    const [px, py] = this.#streamCenter;
    const cx = Math.floor(px / CELL_SIZE);
    const cy = Math.floor(py / CELL_SIZE);
    const radius = gridRadius(this.#session);
    // Cells further than one past the grid are unloaded (one cell of slack against thrashing).
    for (const [key, cell] of this.#cells) {
      if (Math.max(Math.abs(cell.x - cx), Math.abs(cell.y - cy)) > radius + 1) {
        this.#free(cell);
        this.#cells.delete(key);
        this.#refreshSounds();
      }
    }
    this.#queue.length = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!this.#cells.has(cellKey(cx + dx, cy + dy))) this.#queue.push([cx + dx, cy + dy]);
      }
    }
    this.#queue.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    if (this.streamLargeReferences) this.#updateLargeReferences(world, cx, cy);
    this.#pump();
    this.#lod?.update(px, py);
    this.#sky?.update(world, cx, cy, [px, py]).catch((error: unknown) => {
      this.#terminal.log('sky', describe(error), 'warn');
    });
    this.#ui.status.hidden = false;
    this.#ui.status.textContent = `cell ${String(cx)},${String(cy)} · ${String(this.loadedCells)} cells loaded · ${String(this.#queue.length + this.#loading)} loading`;
    this.#showStates(cx, cy);
  }

  /**
   * Large references of the grid around the camera: the cells beyond the loaded ones get a
   * scene of only those (the loaded cells show them anyway, those kept just outside the grid
   * too). A cell's scene is kept until the full cell is ready there.
   */
  #updateLargeReferences(world: Worldspace, cx: number, cy: number): void {
    const wanted = largeReferencesAround(world.largeReferences, cx, cy);
    const radius = gridRadius(this.#session);
    const inGrid = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= radius;
    const beyond = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - cx), Math.abs(y - cy)) > LARGE_REFERENCE_RADIUS + 1;
    /** The references of cells reloaded because more of theirs are wanted (kept with the new). */
    const grown = new Map<string, ReadonlySet<number>>();
    for (const [key, large] of this.#largeCells) {
      const references = wanted.get(key);
      // A full cell loaded there (in the grid, or kept just outside it) shows them anyway.
      const covered = this.#cells.get(key)?.ready === true;
      // No longer listed: kept until well outside the grid (no churn at its edge). Listed with
      // fewer references (a reference that only reaches into cells at the grid's edge, which the
      // camera just left): kept as it is. Only one that wants more is loaded again, with what it
      // had, so a camera going to and fro over a cell border (a fight, a walk along it) loads
      // each cell at most once more instead of every time.
      const stale = references
        ? [...references].some((id) => !large.references.has(id))
        : beyond(large.x, large.y);
      if (covered || stale) {
        if (stale && references) grown.set(key, large.references);
        large.scene?.destroy();
        this.#largeCells.delete(key);
      }
    }
    this.#largeQueue.length = 0;
    for (const [key, references] of wanted) {
      if (this.#largeCells.has(key)) continue;
      const [x = 0, y = 0] = key.split(',').map(Number);
      if (inGrid(x, y) || this.#cells.has(key)) continue;
      const had = grown.get(key);
      this.#largeQueue.push({
        x,
        y,
        references: had ? new Set([...had, ...references]) : references,
      });
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
        waterType: undefined,
        land: undefined,
        waterAreas: [],
        waterVolumes: [],
        formId: undefined,
        toggles: [],
        placed: [],
        emitters: [],
        acousticAreas: [],
        navmesh: undefined,
        skeletons: [],
        data: undefined,
        isEnabled: () => true,
        visibility: new Map(),
        enabledNow: new Map(),
        allLights: [],
        allWaterVolumes: [],
        objectSkeletons: [],
        scriptsAttached: false,
        sceneInstances: [],
        exists: false,
        ready: false,
        collided: false,
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
          // Textures that failed are reported with the cell that asked for them (otherwise
          // they wait for the next interior and look as if it had asked).
          for (const failure of this.#session?.textures.takeFailures() ?? []) {
            this.#terminal.log('dds', failure.text, failure.gameLacks ? 'info' : 'warn');
          }
          if (generation !== this.#generation || this.#cells.get(key) !== cell) {
            this.#free(cell);
          } else {
            cell.ready = true;
            void this.#attachCellToScripts(cell);
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

    const persistent = world.persistentReferences(cell.x, cell.y);
    // It resets if its time has come, before its references load (cell-reset.ts).
    await session.scriptsReady?.cellResets.attaching(cellId, persistent);
    const data = await session.cellData(cellId, persistent);
    const toggles = findToggles(data);
    const isEnabled = this.#enableState(session, data, cellId, toggles);
    cell.isEnabled = isEnabled;
    // Every reference that can appear (a script may enable it), drawn while enabled.
    // A cart its horse pulls is not its cell's any more (src/shell/actor-vehicles.ts).
    const unpulled = data.objects.filter(
      (object) => this.#stage?.vehicles.owns(object.reference) !== true,
    );
    // Where the game left them (moved-objects.ts).
    const objects = session.scriptsReady
      ? placedAsMoved(unpulled, session.scriptsReady.state, cellId)
      : unpulled;
    const shownBy = (reference: number): InstanceVisibility => {
      let entry = cell.visibility.get(reference);
      if (!entry) {
        entry = { hidden: !isEnabled(reference) };
        cell.visibility.set(reference, entry);
      }
      return entry;
    };
    // Rivers move along the flow map of the cell they lie in.
    const flow = this.#flowMap(world, cell.x, cell.y);
    const placed = await this.#place(session, objects, flow, true, shownBy);
    const instances = placed.map(({ instance }) => instance);
    for (const { object, instance } of placed) {
      this.#flora?.add(object, instance.world, shownBy(object.reference), () =>
        cell.isEnabled(object.reference),
      );
      this.#destruction?.add(object, instance.world, shownBy(object.reference), () =>
        cell.isEnabled(object.reference),
      );
    }
    // Its actors (those in it now) come onto the stage; the dead lie as ragdolls.
    const ragdolls =
      (await this.#stage?.attachCell(cellKey(cell.x, cell.y), data.actors, (reference) =>
        cell.isEnabled(reference),
      )) ?? [];
    // The cell's water plane (lakes, rivers and the sea are cell water at a height).
    const water = cellWater(data.cell, {
      height: world.defaultWaterHeight,
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
    cell.sceneInstances = instances;
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
    cell.data = data;
    cell.allLights = data.lights;
    cell.placed = placed;
    cell.objectSkeletons = placed.flatMap(({ object, skeleton }) =>
      skeleton ? [{ reference: object.reference, skeleton }] : [],
    );
    for (const { skeleton, instance } of placed) {
      if (skeleton) this.#skeletonPlaces.set(skeleton, instance.world);
    }
    cell.waterHeight = water?.height;
    cell.waterType = water ? (water.type ?? DEFAULT_WATER) : undefined;
    cell.land = land;
    if (land) this.#learnLandMaterials(land);
    cell.formId = cellId;
    cell.toggles = toggles;
    cell.allWaterVolumes = await Promise.all(
      objects
        .filter((object) => object.water !== undefined)
        .map(async ({ reference, model, world: matrix, water: type }) => ({
          reference,
          volumes: waterVolumes(await session.collision(model), matrix, type ?? 0),
        })),
    );
    cell.navmesh = new NavmeshSurface(await cellNavmeshes(db, cellId));
    this.#refreshCell(cell);
    this.#refreshSounds();
    // Load doors: where they lead (for the activation prompt).
    await Promise.all(
      objects.map(async (object) => {
        if (object.teleport) await this.#destination(object.teleport);
      }),
    );
    const play = this.#play;
    if (play) {
      // Collision: the landscape, the objects (also those with nothing to draw; a disabled
      // one's switched off) and collision primitives.
      const collisions = await Promise.all(
        objects.map(async (object) => session.collision(object.model)),
      );
      if (play !== this.#play) return;
      const entries = new Map(placed.map((entry) => [entry.object, entry]));
      cell.collided = false;
      play.add(cell.collision, {
        ...(land && { land: { data: land, x: cell.x, y: cell.y } }),
        // Its actors stand on the ground once it is in place.
        whenComplete: () => {
          cell.collided = true;
          this.#stage?.ground(cellKey(cell.x, cell.y), play.physics);
        },
        objects: objects.map((object, i) => {
          const entry = entries.get(object);
          return {
            object,
            collision: collisions[i],
            instance: entry?.instance,
            ...(entry?.articulated && { articulated: entry.articulated }),
          };
        }),
        primitives: data.primitives,
        ragdolls,
        isEnabled: (reference) => cell.isEnabled(reference),
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
    visibility?: (reference: number) => InstanceVisibility,
  ): Promise<PlacedObject[]> {
    const models = await Promise.all(objects.map((object) => session.model(object.model)));
    // In loaded cells, objects with simulated collision move: they get a matrix of their own.
    const collisions = simulated
      ? await Promise.all(objects.map(async (object) => session.collision(object.model)))
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
    const placed: PlacedObject[] = [];
    objects.forEach((object, i) => {
      const model = models[i];
      if (!model) return;
      placed.push(
        placeObject(
          session,
          object,
          {
            model,
            collision: collisions[i],
            water: waterTypes[i],
            directional: directionals[i],
          },
          {
            simulated,
            ...(visibility && { visibility: visibility(object.reference) }),
            sway: (swayed, swaying) => this.#treeSway(swayed, swaying),
          },
        ),
      );
    });
    return placed;
  }

  /** What actors' animations sound with: the session's sounds, the play's collision. */
  readonly #soundingWorld: SoundingWorld = {
    sounds: () => this.#session?.soundSystem,
    ground: (at, exclude) => groundUnder(this.#play?.physics, at, exclude),
    water: (at) => this.#waterAt(at[0], at[1], at[2]),
  };

  /**
   * The material (MATT form id) of the land texture showing most at a point of the loaded
   * landscape (LTEX MNAM); undefined: the default land material.
   */
  #landMaterialAt(position: Vec3): number | undefined {
    const x = Math.floor(position[0] / CELL_SIZE);
    const y = Math.floor(position[1] / CELL_SIZE);
    const land = this.#cells.get(cellKey(x, y))?.land;
    if (!land) return undefined;
    const ltex = landTextureAt(land, position[0] - x * CELL_SIZE, position[1] - y * CELL_SIZE);
    return ltex === undefined ? undefined : this.#landMaterials.get(ltex);
  }

  /** Land textures' materials, read as cells with them load. */
  #learnLandMaterials(land: LandData): void {
    const db = this.#db;
    if (!db) return;
    for (const quadrant of land.quadrants) {
      for (const ltex of [quadrant.base, ...quadrant.layers.map((layer) => layer.texture)]) {
        if (ltex === undefined || this.#landMaterials.has(ltex)) continue;
        this.#landMaterials.set(ltex, undefined);
        void landTexture((id) => db.get(id), ltex).then((texture) => {
          this.#landMaterials.set(ltex, texture?.material);
        });
      }
    }
  }

  /** A tree model's swaying skeleton (shared by its placements), if the wind moves it. */
  #treeSway(model: GpuModel, object: CellObject): TreeSway | undefined {
    const settings = object.treeSway;
    if (!settings || !model.treeBones || !model.nodes) return undefined;
    const key = `${object.model}|${JSON.stringify(settings)}`;
    if (!this.#treeSways.has(key)) {
      const sway = new TreeSway(model.nodes, model.treeBones, settings);
      this.#treeSways.set(key, sway.moves ? sway : undefined);
    }
    return this.#treeSways.get(key);
  }

  /** A cell beyond the loaded grid: a scene of just its large references. */
  async #loadLargeCell(large: LargeReferenceCell): Promise<void> {
    const world = this.#world;
    const session = this.#session;
    const db = this.#db;
    if (!world || !session || !db) return;
    const cellId = await world.cell(large.x, large.y);
    if (cellId === undefined) return;
    const data = await session.cellData(cellId, world.persistentReferences(large.x, large.y));
    const toggles = findToggles(data);
    const isEnabled = enabledReferences(data, toggles, this.#selection(session, cellId, toggles));
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

  /**
   * The water a point of the loaded cells is in or over (swimming, under water): a water
   * activator's volume, or the cell's water where it lies above the landscape; the higher.
   */
  readonly #waterAt = (
    x: number,
    y: number,
    z: number,
  ): { height: number; type: number } | undefined => {
    const cell = this.#cells.get(cellKey(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE)));
    if (!cell?.ready) return undefined;
    const volume = surfaceOver(cell.waterVolumes, x, y, z);
    const plane = this.#cellWaterAt(cell, x, y);
    return volume && (!plane || volume.height > plane.height) ? volume : plane;
  };

  /** The water one hears around a point (height `z`): water activators' surfaces, cell water. */
  readonly #waterSurfaceAt = (
    x: number,
    y: number,
    z: number,
  ): { height: number; type: number } | undefined => {
    const cell = this.#cells.get(cellKey(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE)));
    if (!cell?.ready) return undefined;
    for (const area of cell.waterAreas) {
      const height = waterAreaHeight(area, x, y, z);
      if (height !== undefined) return { height, type: area.type };
    }
    return this.#cellWaterAt(cell, x, y);
  };

  /** A cell's water plane at a point, where it lies above the landscape. */
  #cellWaterAt(
    cell: LoadedCell,
    x: number,
    y: number,
  ): { height: number; type: number } | undefined {
    if (cell.waterHeight === undefined || cell.waterType === undefined) return undefined;
    const ground = cell.land ? landHeightAt(cell.land, cell.x, cell.y, x, y) : undefined;
    if (ground !== undefined && ground >= cell.waterHeight) return undefined;
    return { height: cell.waterHeight, type: cell.waterType };
  }

  /** The surroundings for region and weather sounds. */
  #ambientState(sky: WorldSky): AmbientState {
    const flash = sky.flashStart;
    // What the renderer looks through: the player's camera while playing, not the free one
    // (left where it was, it once put the player "under water" far from any).
    const camera = this.#view.position;
    const water = this.#waterAt(camera[0], camera[1], camera[2]);
    return {
      regions: sky.regions,
      weather: sky.weather,
      previousWeather: sky.previousWeather,
      transition: sky.transition,
      hour: sky.hour,
      interior: false,
      swimming: this.#play?.player.swimming ?? false,
      flash: Number.isFinite(flash) ? flash : undefined,
      cellMusic: sky.cellMusic,
      worldMusic: this.#world?.record.music,
      waterAt: this.#waterSurfaceAt,
      underwater: water !== undefined && camera[2] < water.height,
      combatTargetHasKeyword: this.#combatTarget.of(this.#session?.scriptsReady),
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
    const runtime = this.#session?.scriptsReady;
    const key = cellKey(cell.x, cell.y);
    if (cell.scriptsAttached && cell.data && runtime) {
      const loaded = new Set(this.#cellLoadedReferences(cell));
      // Its moved objects keep their places; its reset waits from now (cell-reset.ts).
      noteMoved(cell.placed, runtime.state);
      if (cell.formId !== undefined) runtime.detach(runtime.cellResets.detached(cell.formId));
      const data = cell.data;
      runtime.detach(
        runtime.cellDetached(
          [
            ...data.objects.map((object) => object.reference),
            ...(this.#stage?.referencesIn(key) ?? []),
          ],
          (reference) => loaded.has(reference),
        ),
      );
    }
    cell.scriptsAttached = false;
    // A cell being replaced by a new load of the same place keeps the new one's actors.
    if (this.#cells.get(key) === cell || !this.#cells.has(key)) this.#stage?.detachCell(key);
    for (const entry of [...(this.#created?.all ?? [])]) {
      const at = entry.object.world;
      const key = cellKey(
        Math.floor((at[12] ?? 0) / CELL_SIZE),
        Math.floor((at[13] ?? 0) / CELL_SIZE),
      );
      if (key === cellKey(cell.x, cell.y)) this.#created?.remove(entry.reference, this.#play);
    }
    this.#play?.remove(cell.collision);
    for (const object of cell.data?.objects ?? []) {
      this.#flora?.remove(object.reference);
      this.#destruction?.remove(object.reference);
    }
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

  /** The map's fast travel riding a dragon: it flies the player there; false riding none. */
  flyMountTo(to: Vec3): boolean {
    return this.#stage?.mounts.flyTo(to) ?? false;
  }

  /**
   * Whether the player's first-person arms and weapons are drawn: in first person (not from the
   * free camera or a menu's), unless Game.ShowFirstPersonGeometry hid them, nor dead.
   */
  #firstPersonShown(play: PlaySession): boolean {
    return (
      !play.bodyShown && !play.dead && this.#session?.scriptsReady?.firstPersonGeometry !== false
    );
  }

  *#readyScenes(): Iterable<GpuScene> {
    if (this.#sky && !this.#noSky) yield* this.#sky.skyScenes();
    // The player's body, in third person or seen from the free camera or a menu's.
    const play = this.#play;
    const avatar = this.#avatar;
    if (play && avatar?.scene && play.bodyShown) yield avatar.scene;
    // In first person its arms, unless a script hides them (ShowFirstPersonGeometry).
    const firstScene = avatar?.firstPersonBody?.scene;
    if (play && firstScene && this.#firstPersonShown(play)) yield firstScene;
    if (this.#lod) yield* this.#lod.scenes();
    for (const cell of this.#cells.values()) if (cell.ready && cell.scene) yield cell.scene;
    if (this.#stage) yield* this.#stage.scenes();
    if (this.#created) yield* this.#created.scenes();
    if (this.#flora) yield* this.#flora.scenes();
    if (this.#destruction) yield* this.#destruction.scenes();
    for (const [key, large] of this.#largeCells) {
      // The full cell shows them once it is ready.
      if (large.ready && large.scene && this.#cells.get(key)?.ready !== true) yield large.scene;
    }
  }

  *#readyDecals(): Iterable<GpuDecals> {
    for (const cell of this.#cells.values()) if (cell.ready && cell.decals) yield cell.decals;
    // The hits' blood (src/shell/combat-impacts.ts).
    if (this.#stage) yield* this.#stage.combat.decals();
  }

  *#readyGrass(): Iterable<GpuGrassField> {
    for (const cell of this.#cells.values()) if (cell.ready) yield* cell.grass;
  }

  /** Loaded cells around the streaming centre, where distant LOD gives way to them. */
  #lodMask(): LodMask {
    const [px, py] = this.#streamCenter;
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

  /**
   * The occluders (and any rooms) of the loaded cells, culling their objects; made again when
   * the loaded cells change.
   */
  #rooms(): RoomCuller | undefined {
    const sets: CellRooms[] = [];
    for (const cell of this.#cells.values()) {
      const rooms = cell.ready ? cell.data?.rooms : undefined;
      if (rooms && (rooms.occluders.length > 0 || rooms.rooms.length > 0)) sets.push(rooms);
    }
    const same =
      sets.length === this.#roomSets.length && sets.every((set, i) => set === this.#roomSets[i]);
    if (!same) {
      this.#roomSets = sets;
      this.#roomCuller = sets.length > 0 ? new RoomCuller(sets) : undefined;
    }
    return this.#roomCuller;
  }

  /** Cells of the large-reference grid whose large references are shown in full detail. */
  #largeRefMask(): LargeRefMask {
    const [px, py] = this.#streamCenter;
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
      // Rings from splashes and wakes (water-ripples.ts).
      ...(this.#play && { ripples: this.#play.ripples.active(performance.now() / 1000) }),
    };
  }

  /** The current colour of an emittance source (lights with REFR XEMI). */
  readonly #emittanceRgb = (formId: number): Rgb =>
    this.#session?.emittance(formId).rgb ?? [0, 0, 0];

  /**
   * The lighting near a place (the light on actors: src/shell/actor-senses.ts): the sky's, and
   * the lights of the loaded cells round it.
   */
  #lightProbe(at: Vec3): LightProbe | undefined {
    const sky = this.#sky?.lighting();
    if (!sky) return undefined;
    const x = Math.floor(at[0] / CELL_SIZE);
    const y = Math.floor(at[1] / CELL_SIZE);
    const lights: PointLight[] = [];
    const seconds = performance.now() / 1000;
    for (const cell of this.#cells.values()) {
      if (!cell.ready || Math.abs(cell.x - x) > 1 || Math.abs(cell.y - y) > 1) continue;
      lights.push(...pointLights(cell.lights, seconds, at, this.#emittanceRgb));
    }
    // What moves with the actors and the created objects: torches carried, spells in hand,
    // magic's lights (as indoors: src/shell/model-viewer.ts).
    lights.push(
      ...pointLights(
        [...(this.#created?.lights() ?? []), ...(this.#stage?.lights() ?? [])],
        seconds,
        at,
        this.#emittanceRgb,
      ),
    );
    return {
      ambient: sky.ambient,
      sunColor: sky.sunColor,
      sunDirection: sky.sunDirection,
      lights,
      interior: false,
    };
  }

  /** The sky's light (time of day and weather) plus the nearest point lights. */
  #lighting(camera: Vec3): SceneLighting {
    const lights: (PointLight & { distance: number })[] = [];
    const seconds = performance.now() / 1000;
    const created = this.#created?.lights() ?? [];
    for (const cell of this.#cells.values()) {
      if (!cell.ready) continue;
      const cellLights = [
        ...cell.lights,
        ...created.filter(
          (light) =>
            cellKey(
              Math.floor(light.position[0] / CELL_SIZE),
              Math.floor(light.position[1] / CELL_SIZE),
            ) === cellKey(cell.x, cell.y),
        ),
      ];
      const startFade = this.#session?.ini.number('Display', 'fLightLODStartFade');
      for (const light of pointLights(cellLights, seconds, camera, this.#emittanceRgb, startFade)) {
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
    // Magic's lights: effects on actors, casts in hands, what flies and bursts.
    const startFade = this.#session?.ini.number('Display', 'fLightLODStartFade');
    for (const light of pointLights(
      this.#stage?.lights() ?? [],
      seconds,
      camera,
      this.#emittanceRgb,
      startFade,
    )) {
      lights.push({
        ...light,
        distance: Math.hypot(
          light.position[0] - camera[0],
          light.position[1] - camera[1],
          light.position[2] - camera[2],
        ),
      });
    }
    lights.sort((a, b) => a.distance - b.distance);
    this.#sky?.frame(performance.now(), camera);
    // The surroundings once the camera's cell is known (else the world's music would start).
    const world = this.#sky;
    if (world?.located) this.#session?.soundSystem?.setAmbience(this.#ambientState(world));
    const sky = this.#sky?.lighting() ?? NO_SKY;
    // A menu's lights (the race menu's) first: they light what it shows.
    const extra = this.#play?.extraLights ?? [];
    const under = this.#underwaterFog(camera, sky);
    this.#under = under;
    return {
      ...sky,
      ...(under && { fog: under }),
      lights: [...extra, ...lights].slice(0, MAX_LIGHTS),
    };
  }

  /** The view below water surfaces: the water type's underwater fog (underwater.ts). */
  readonly #underwater = new UnderwaterView((formId) =>
    this.#session?.waterType(formId).then((gpu) => gpu?.type),
  );

  /** The underwater fog of the last frame (its full-screen tint goes on the imagespace). */
  #under: SceneFog | undefined;

  #underwaterFog(camera: Vec3, sky: Omit<SceneLighting, 'lights'>): SceneFog | undefined {
    return this.#underwater.fog(camera[2], this.#waterAt(camera[0], camera[1], camera[2]), sky);
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
