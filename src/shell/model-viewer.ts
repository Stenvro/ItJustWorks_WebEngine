// Viewer for the game's content: single meshes (orbit camera, studio light) and complete
// interior cells (free camera, the cell's own lighting).

import { OrbitCamera, type OrbitView } from '../render/camera.ts';
import type { Rgb } from '../world/cell-records.ts';
import { cellStatesElement, checkboxRow } from './cell-states.ts';
import { InteriorSkyControls } from './interior-sky.ts';
import type { SkyElements } from './world-sky.ts';
import { FlyCamera } from '../render/fly-camera.ts';
import { identity, type Vec3 } from '../render/math.ts';
import type { LightProbe } from '../ai/light-level.ts';
import type { Renderer } from '../render/renderer.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { ActorPose } from '../animation/skeleton.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import { configurePhysics, Player } from './player.ts';
import {
  collisionGroup,
  objectActivation,
  perkActivation,
  PlaySession,
  type Activatable,
  type CellRagdoll,
  type CollisionGroup,
} from './play-session.ts';
import { projectDecals } from '../render/decal-projection.ts';
import type { GpuDecals } from '../render/decals.ts';
import {
  placedParts,
  type GpuModel,
  type GpuScene,
  type GpuWaterType,
  type InstanceVisibility,
  type ModelInstance,
  type PlacedDirectional,
} from '../render/scene-renderer.ts';
import { studioLighting } from '../render/studio-lighting.ts';
import { RoomCuller } from '../render/room-culler.ts';
import { roomIndexAt, type CellRoom } from '../world/cell-rooms.ts';
import { cellSceneLighting, pointLights } from '../world/cell-lighting.ts';
import {
  cellArrival,
  doorDestination,
  loadCellData,
  referenceMatrix,
  type CellData,
  type CellLight,
  type CellWaterArea,
  type DoorDestination,
  type Teleport,
} from '../world/cell-loader.ts';
import type { Arrival } from '../world/worldspace.ts';
import { DEFAULT_WATER } from '../world/water.ts';
import { UnderwaterView } from '../world/underwater.ts';
import type { SceneLighting } from '../render/scene-lighting.ts';
import { surfaceOver, waterVolumes, type WaterVolume } from '../world/water-volumes.ts';
import {
  cellNavmeshes,
  NAVMESH_TOLERANCE,
  NavmeshSurface,
  NEAREST_TOLERANCE,
} from '../world/navmesh.ts';
import { waterAreaHeight } from '../audio/water-audio.ts';
import {
  DEFAULT_INTERIOR_IMAGE_SPACE,
  parseImageSpace,
  type ImageSpace,
} from '../world/image-space.ts';
import {
  enabledReferences,
  findToggles,
  gameStartSelection,
  type CellToggle,
} from '../world/cell-upgrades.ts';
import {
  findHomeActions,
  fullyUpgraded,
  NEW_GAME,
  playHomeActions,
  ScriptEnvironment,
  type HomeActions,
  type HomeChoices,
  type HouseStage,
} from '../world/player-home.ts';
import type { InteriorCell, RecordDatabase } from '../world/record-db.ts';
import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { talkTargets, type PlacedActor } from './actors.ts';
import { ActorStage, type StageObstacleCell } from './actor-stage.ts';
import type { DoorObject } from './actor-doors.ts';
import { PlayerFurniture, sittingAngleLimit } from './player-furniture.ts';
import { stageObject, type StageObject } from './actor-furniture.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { matches, renderResults } from './finder.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import { placedAsMoved } from './moved-objects.ts';
import {
  instanceNodeWorld,
  MOTION_KEYFRAMED,
  scriptConstraints,
  type ScriptView,
} from './script-world.ts';
import { actorScriptGraph, placedScriptGraph } from '../animation/script-graphs.ts';
import { placeObject } from '../sim/placed-objects.ts';
import { CreatedObjects } from './created-objects.ts';
import { itemGlow } from '../gameplay/magic/enchantment-glow.ts';
import { FloraLooks } from './flora-looks.ts';
import { DestructionLooks } from './destruction-looks.ts';
import { connectPlayerTime } from './time-flow.ts';
import { prepareCameraShake } from './camera-shake.ts';
import { PlayerAvatar } from './player-avatar.ts';
import type { PlayerView } from './race-menu.ts';
import { groundUnder, type SoundingWorld } from './actor-sounds.ts';
import { CombatTargetKeywords } from './combat-target-keywords.ts';
import type { GameSession } from './game-session.ts';
import type { CellRecord } from '../world/cell-records.ts';
import { clock, startObjectGraph, startPlacedSkeleton } from './object-graphs.ts';
import type { Terminal } from './terminal.ts';
import type { LocalMapContent } from './local-map.ts';

/** NorthMarker (Skyrim.esm STAT 0x3): which way an interior's local map is up. */
const NORTH_MARKER = 0x3;

export interface SearchElements {
  readonly panel: HTMLElement;
  readonly search: HTMLInputElement;
  readonly results: HTMLOListElement;
  readonly count: HTMLElement;
}

export interface ViewerElements {
  readonly meshes: SearchElements;
  readonly cells: SearchElements;
  /** Cells: container for the upgrade toggles of the cell on screen. */
  readonly upgrades: HTMLElement;
  /** Cells: play controls (the free camera). */
  readonly play: HTMLElement;
  readonly freeCamera: HTMLInputElement;
  /** Cells: what is on screen (the same line as the world's). */
  readonly status: HTMLElement;
  /** Cells: the clock and the weather outside (the same controls as the world's sky). */
  readonly sky: SkyElements;
  /** What the crosshair rests on. */
  readonly prompt: HTMLElement;
}

const MODEL_VIEW: OrbitView = { up: 'z', yaw: 0.6, pitch: 0.3, idleSpin: 10 };
/** Camera height above the floor when entering a cell (≈ 1.7 m). */
const EYE_HEIGHT = 120;

interface CellView {
  readonly data: CellData;
  /** Quest and scene states, and which of them are on. */
  readonly toggles: readonly CellToggle[];
  selection: Set<number>;
  /** What the player can buy or build here, what they chose, and what the scripts did. */
  readonly actions: HomeActions;
  choices: HomeChoices;
  scripted: ReadonlyMap<number, boolean>;
  readonly models: ReadonlyMap<string, GpuModel | undefined>;
  /** The models' collision, by path. */
  readonly collisions: ReadonlyMap<string, CollisionData | undefined>;
  /** The dead actors' ragdolls (their skeletons' bodies). */
  readonly ragdolls: readonly CellRagdoll[];
  /** Statics' directional materials (snow, moss, ice) as placed, by reference. */
  readonly directionals: ReadonlyMap<number, PlacedDirectional>;
  readonly label: string;
  /** The cell's imagespace (XCIM, else the default interior one). */
  readonly imageSpace: ImageSpace | undefined;
  /** Water types of water activators, by WATR form id. */
  readonly waterTypes: ReadonlyMap<number, GpuWaterType | undefined>;
  /** Placed decals (blood, scorch marks, puddles), shown by the selection. */
  readonly decals: GpuDecals | undefined;
  /** Where actors walk (its navigation meshes): the player steps onto it off the stairs too. */
  readonly navmesh: NavmeshSurface;
}

const numberFormat = new Intl.NumberFormat('en-US');
/** The glow of an enchanted item lying in the cell (its effects' key). */
const groundGlow = (reference: number): string => `ground:${String(reference)}`;
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ModelViewer {
  readonly #renderer: Renderer;
  readonly #canvas: HTMLElement;
  readonly #terminal: Terminal;
  readonly #ui: ViewerElements;
  readonly #orbit = new OrbitCamera();
  readonly #fly = new FlyCamera();
  #detachControls: (() => void) | undefined;
  #session: GameSession | undefined;
  /** The player's combat target's keywords (the combat music's conditions). */
  readonly #combatTarget = new CombatTargetKeywords();
  #db: RecordDatabase | undefined;
  /** Guards against slow script runs finishing after newer choices. */
  #choiceToken = 0;
  #statesOpen = false;
  /** Dev checks: models not drawn. */
  #hidden: RegExp | undefined;
  #meshes: string[] = [];
  #cells: InteriorCell[] = [];
  /** The single mesh shown in mesh mode (not cached). */
  #meshModel: GpuModel | undefined;
  #scene: GpuScene | undefined;
  /** Guards against a slow load finishing after a newer one. */
  #loadToken = 0;
  /** The cell on screen, with everything needed to switch upgrades instantly. */
  #cell: CellView | undefined;
  /** The name of the interior cell being loaded, until the player stands in it. */
  #loading: string | undefined;
  /** The physics world and the player in the cell on screen. */
  #play: PlaySession | undefined;
  /** The collision of the objects shown. */
  #collision: CollisionGroup = collisionGroup();

  constructor(renderer: Renderer, canvas: HTMLElement, terminal: Terminal, ui: ViewerElements) {
    this.#renderer = renderer;
    this.#canvas = canvas;
    this.#terminal = terminal;
    this.#ui = ui;

    ui.meshes.search.addEventListener('input', () => {
      this.#showMeshResults();
    });
    ui.meshes.search.addEventListener('keydown', (event) => {
      const first = this.#meshMatches()[0];
      if (event.key === 'Enter' && first) this.#run(this.showMesh(first, MODEL_VIEW));
    });
    ui.cells.search.addEventListener('input', () => {
      this.#showCellResults();
    });
    ui.cells.search.addEventListener('keydown', (event) => {
      const first = this.#cellMatches()[0];
      if (event.key === 'Enter' && first) this.#run(this.showCell(first.formId));
    });
    ui.freeCamera.addEventListener('change', () => {
      this.#play?.setFreeCamera(ui.freeCamera.checked);
    });
  }

  /** The physics world and player of the cell on screen. */
  get play(): PlaySession | undefined {
    return this.#play;
  }

  /** The interior cell being loaded until the player stands in it (the loading screen). */
  get loading(): string | undefined {
    if (this.#loading === undefined) return undefined;
    if (this.#play?.spawned === true) this.#loading = undefined;
    return this.#loading;
  }

  /** Called when the player goes through a load door (the app takes them there). */
  onTravel: ((teleport: Teleport) => void) | undefined;
  /** Play: a script's MoveTo takes the player (the sandbox: never). */
  followsScripts = false;
  /** A script sent the player somewhere this view does not show (Play). */
  onPlayerSent: ((at: Placement) => void) | undefined;

  /** The player in this view's scene, if one plays it. */
  /**
   * What the map's local map shows in the cell played in: its objects and load doors (enabled)
   * and the area they span. Undefined unless a cell is played in.
   */
  localMapContent(): LocalMapContent | undefined {
    const cell = this.#cell;
    const scene = this.#scene;
    if (!cell || !scene || !this.#play) return undefined;
    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    const isEnabled = this.#enableState(cell);
    for (const object of cell.data.objects) {
      if (!isEnabled(object.reference)) continue;
      const x = object.world[12] ?? 0;
      const y = object.world[13] ?? 0;
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
    if (!Number.isFinite(min[0])) return undefined;
    // The cell's NorthMarker (STAT 0x3): its +Y is up on the local map.
    const north = cell.data.objects.find((object) => object.base === NORTH_MARKER)?.world;
    return {
      scenes: () => [scene, ...(this.#created?.scenes() ?? [])],
      terrain: () => [],
      area: { min, max },
      interior: true,
      cell: cell.data.cell.formId,
      ...(north && { north: Math.atan2(north[4] ?? 0, north[5] ?? 1) }),
      doors: () =>
        cell.data.objects.flatMap((object) =>
          object.teleport && isEnabled(object.reference)
            ? [
                {
                  reference: object.reference,
                  teleport: object.teleport,
                  position: [object.world[12] ?? 0, object.world[13] ?? 0, object.world[14] ?? 0],
                },
              ]
            : [],
        ),
    };
  }

  get player(): Player | undefined {
    return this.#play?.player;
  }

  /** The player being played: their session and body (the race menu's). */
  get playerView(): PlayerView | undefined {
    const play = this.#play;
    return play && { play, avatar: this.#avatar };
  }

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

  /** Puts the player at a place in the scene on screen: false if it is not in this cell. */
  sendPlayer(at: Placement): boolean {
    if (!this.#play || at.world !== undefined || at.cell !== this.#cell?.data.cell.formId) {
      return false;
    }
    this.#play.placePlayer(at.position, at.rotation[2]);
    return true;
  }

  /** The interior cell on screen, if any. */
  get shownCell(): number | undefined {
    return this.#cell?.data.cell.formId;
  }
  /** Load door destinations by destination door. */
  readonly #destinations = new Map<number, DoorDestination | undefined>();

  /**
   * What activating a reference does: its scripts get OnActivate; by default load doors take
   * the player to their destination and doors open (unless a script blocks activation).
   * References with scripts and no default (levers, shrines) are activated for the scripts.
   */
  #activatable(reference: number): Activatable | undefined {
    // The crosshair offers what the engine's prompt rule shows (play-session.ts
    // objectActivation: never a static, an unnamed object or a light that is not carried).
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

  /** What activating a reference does by default (a load door, a door that opens). */
  #defaultActivation(reference: number, activator?: number): Activatable | undefined {
    const created = this.#created?.get(reference);
    const object =
      this.#cell?.data.objects.find((candidate) => candidate.reference === reference) ??
      created?.object;
    if (!object) return undefined;
    return objectActivation(
      object,
      this.#instances.get(reference) ?? created?.instance,
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

  /** The drawn instances of the cell on screen, by reference. */
  #instances = new Map<number, ModelInstance>();
  #detachScripts: (() => void) | undefined;
  /** What the scripts created in the cell on screen (PlaceAtMe). */
  #created: CreatedObjects | undefined;
  /** The cell's harvestable flora (their harvested look). */
  #flora: FloraLooks | undefined;
  /** The cell's destructible objects (their stages' looks, their debris). */
  #destruction: DestructionLooks | undefined;

  /** What the running game's scripts see of, and do to, the cell on screen. */
  readonly #scriptView: ScriptView = {
    created: (reference) => {
      void this.#showCreated(reference);
      void this.#stage?.created(reference, this.#play?.physics);
    },
    loadedReferences: () => this.#loadedReferences(),
    loaded: (reference) => this.#loadedReferences().includes(reference),
    livePlacement: (reference) => {
      const player = this.#play?.player;
      if (reference === PLAYER_REF && player && this.#cell) {
        const [x, y, z] = player.feet;
        return {
          position: [x, y, z],
          rotation: [0, 0, player.yaw],
          cell: this.#cell.data.cell.formId,
        };
      }
      const actor = this.#stage?.livePlacement(reference);
      if (actor) return actor;
      const world =
        (this.#instances.get(reference)?.motion
          ? this.#instances.get(reference)?.world
          : undefined) ?? this.#created?.get(reference)?.instance?.world;
      return world && { position: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0] };
    },
    enableStatesChanged: () => {
      if (this.#cell) this.#refreshEnabled();
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
    graphOf: (reference) =>
      placedScriptGraph(
        this.#instances.get(reference)?.graph,
        this.#allObjectSkeletons.find((entry) => entry.reference === reference)?.skeleton.behavior,
        clock,
      ) ?? actorScriptGraph(this.#stage?.get(reference)?.placed.behavior),
    motionTypeChanged: (reference, motionType) => {
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
    openChanged: (reference, open) => {
      this.#stage?.doors.setOpen(reference, open);
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
    playerRegions: () => [],
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
    interactionLocation: (furniture, from) =>
      this.#stage?.furniture.interactionLocation(furniture, from) ?? Promise.resolve(undefined),
    dependentAnimated: (reference, dependent, added) =>
      this.#stage?.dependentAnimated(reference, dependent, added) ?? false,
    // Carts and their riders, horses and theirs (src/shell/actor-vehicles.ts, actor-mounts.ts).
    alphaSet: (actor, fade) => {
      this.#stage?.alphaSet(actor, fade);
    },
    vehicleChanged: (actor) => {
      this.#stage?.vehicles.changed(actor);
    },
    tether: (cart, horse) => {
      void this.#stage?.vehicles.tether(cart, horse);
    },
    mountOf: (actor) => this.#stage?.mounts.horseOf(actor),
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
    addRagdoll: (reference) => this.#stage?.addRagdoll(reference) ?? Promise.resolve(),
    sittingRotation: (radians) => this.#seat?.setSittingRotation(radians),
    evaluatePackage: (reference, restart) => {
      this.#stage?.evaluatePackage(reference, restart);
    },
    combat: () => this.#stage?.combat,
    launchSpell: (spell, source, target, blame) =>
      this.#stage?.launchSpell(spell, source, target, blame) ?? false,
    nodeWorld: (reference, node) =>
      instanceNodeWorld(
        this.#instances.get(reference) ?? this.#created?.get(reference)?.instance,
        node,
      ),
  };

  /**
   * An actor's look changed: the player's body is made again (its appearance, its race); an
   * actor of the cell on screen is placed again in its new race where it stands.
   */
  async #lookChanged(reference: number): Promise<void> {
    if (reference === PLAYER_REF) {
      // The decapitation armor goes on in place (src/shell/actor-dismemberment.ts).
      if (await this.#stage?.dismemberment.dressedInPlace(reference)) return;
      await this.#avatar?.rebuild();
      return;
    }
    await this.#stage?.lookChanged(reference);
  }

  /**
   * The enabled objects and markers of the cell on screen, and those the scripts created
   * (what actors use and search for).
   */
  /** The cell's navmesh obstacles (the stage cuts the navmesh under them). */
  *#stageObstacles(): Iterable<StageObstacleCell> {
    const obstacles = this.#cell?.data.obstacles;
    if (this.#stageCell === undefined || !obstacles?.length) return;
    yield { key: String(this.#stageCell), obstacles, isEnabled: this.#isEnabled };
  }

  *#stageObjects(): Iterable<StageObject> {
    const data = this.#cell?.data;
    if (!data) return;
    for (const object of data.objects) {
      if (this.#isEnabled(object.reference)) yield stageObject(object);
    }
    for (const marker of data.markers) if (this.#isEnabled(marker.reference)) yield marker;
    for (const entry of this.#created?.all ?? []) {
      if (!entry.visibility.hidden) yield stageObject(entry.object);
    }
  }

  /**
   * The references of the cell on screen whose 3D is loaded (the enabled ones drawn) and its
   * enabled markers.
   */
  #loadedReferences(): number[] {
    const cell = this.#cell;
    if (!cell) return [];
    return [
      ...[...this.#instances.keys()].filter((reference) => this.#isEnabled(reference)),
      ...cell.data.markers
        .map((marker) => marker.reference)
        .filter((reference) => this.#isEnabled(reference)),
      ...[...(this.#stage?.shown() ?? [])].map((actor) => actor.actor.reference),
      ...[...(this.#created?.all ?? [])]
        .filter((entry) => !entry.visibility.hidden)
        .map((entry) => entry.reference),
    ];
  }

  /** A reference the scripts created: shown if it is in the cell on screen. */
  async #showCreated(reference: number): Promise<void> {
    const runtime = this.#session?.scriptsReady;
    const cell = this.#cell;
    if (!runtime || !cell || !this.#created) return;
    const at = await runtime.placement(reference);
    if (at?.cell !== cell.data.cell.formId || this.#cell !== cell) return;
    await this.#created.add(runtime, reference, this.#play);
    // An enchanted weapon or armour the game made (dropped, an enchanted copy) glows.
    const created = this.#created.get(reference);
    const type = created?.object.baseType;
    if (!created || (type !== 'WEAP' && type !== 'ARMO')) return;
    const glow = await itemGlow((formId) => runtime.forms.record(formId), created.object.base);
    if (!glow || this.#created.get(reference) !== created) return;
    this.#stage?.effects.glow(groundGlow(reference), reference, glow, () =>
      created.instance
        ? { placed: { instances: [created.instance] }, visibility: created.visibility }
        : undefined,
    );
  }

  /**
   * The enchanted weapons and armour lying in the cell glow (their enchantment's shader and
   * art: src/gameplay/magic/enchantment-glow.ts), hidden with them when taken; the stage's
   * effects are cleared as the cell is left.
   */
  async #glowCell(token: number): Promise<void> {
    const session = this.#session;
    const cell = this.#cell;
    if (!session || !cell) return;
    const db = await session.db;
    for (const object of cell.data.objects) {
      if (object.baseType !== 'WEAP' && object.baseType !== 'ARMO') continue;
      const reference = object.reference;
      void itemGlow((formId) => db.get(formId), object.base).then((glow) => {
        if (!glow || token !== this.#loadToken) return;
        this.#stage?.effects.glow(groundGlow(reference), reference, glow, () => {
          const instance = this.#instances.get(reference);
          const visibility = this.#visibility.get(reference);
          return instance
            ? { placed: { instances: [instance] }, ...(visibility && { visibility }) }
            : undefined;
        });
      });
    }
  }

  /** A script moved a reference: its drawn instance and its collision follow. */
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
    if (this.#stage?.get(reference)) {
      await this.#stage.moved(reference, this.#play?.physics);
      return;
    }
    const created = this.#created?.get(reference);
    if (created) {
      const world = referenceMatrix({
        position: at.position,
        rotation: at.rotation,
        scale: at.scale,
      });
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.teleport(
          placed,
          created.instance?.world ?? created.object.world,
          world,
        );
      }
      if (created.instance?.motion) {
        created.instance.world.set(world);
        created.instance.motion.version++;
      } else {
        // Its scene holds one instance: built again at the new place.
        this.#stage?.effects.unglow(groundGlow(reference));
        this.#created?.remove(reference, this.#play);
        await this.#showCreated(reference);
      }
      return;
    }
    const instance = this.#instances.get(reference);
    const object = this.#cell?.data.objects.find((candidate) => candidate.reference === reference);
    if (!object) {
      // An actor from elsewhere moved into the cell on screen.
      await this.#stage?.moved(reference, this.#play?.physics);
      return;
    }
    const world = referenceMatrix({
      position: at.position,
      rotation: at.rotation,
      scale: at.scale,
    });
    for (const placed of this.#play?.placementsOf(reference) ?? []) {
      this.#play?.physics.teleport(placed, instance?.world ?? object.world, world);
    }
    if (instance?.motion) {
      instance.world.set(world);
      instance.motion.version++;
    } else {
      // A static instance is part of the built scene: it is built again at its new place.
      object.world.set(world);
      this.#applyCellSelection();
    }
  }
  /** The enable state of the cell on screen (see #enableState). */
  #isEnabled: (reference: number) => boolean = () => true;
  /** Each drawn reference's visibility (hidden while disabled). */
  #visibility = new Map<number, InstanceVisibility>();
  /** The enable state each reference with collision was last given. */
  #enabledNow = new Map<number, boolean>();
  /** Every water activator's volumes; those of the enabled ones are #waterVolumes. */
  #allWaterVolumes: readonly { reference: number; volumes: WaterVolume[] }[] = [];
  /** Every object skeleton; those of the enabled objects animate. */
  #allObjectSkeletons: readonly { reference: number; skeleton: AnimatedSkeleton }[] = [];
  /** The cell's lighting with its enabled lights (see #refreshEnabled). */
  #cellLighting: ReturnType<typeof cellSceneLighting> | undefined;
  /** The lighting in a room with its own template, for the cell's lighting it is of. */
  #roomLighting:
    { room: number; of: SceneLighting | undefined; lighting: SceneLighting } | undefined;
  /** The rooms' own image spaces (INAM) of the cell shown, by room index. */
  #roomImageSpaces = new Map<number, ImageSpace>();
  /** The time and weather controls while a cell is shown. */
  #sky: InteriorSkyControls | undefined;
  /** The enabled water activators: their surfaces (heard) and volumes (entered). */
  #waterAreas: readonly CellWaterArea[] = [];
  #waterVolumes: readonly WaterVolume[] = [];
  /** The navigation meshes of the cell on screen (actors' paths). */
  readonly #navmeshes: NavmeshSet = {
    navmesh: (formId) => this.#cell?.navmesh.meshes.find((mesh) => mesh.formId === formId),
    locate: ([x, y, z]) => this.#cell?.navmesh.near(x, y, z, NAVMESH_TOLERANCE),
    nearest: ([x, y, z], reach) =>
      this.#cell?.navmesh.nearest(x, y, z, reach, NEAREST_TOLERANCE)?.point,
  };

  /** A door of the cell on screen, for the actors going through it (src/shell/actor-doors.ts). */
  #doorOf(reference: number): DoorObject | undefined {
    const object = this.#cell?.data.objects.find((candidate) => candidate.reference === reference);
    return object && { object, instance: this.#instances.get(reference) };
  }

  /** The actors of the cell on screen (src/shell/actor-stage.ts). */
  #stage: ActorStage | undefined;
  /** The cell the stage holds (its key is the form id). */
  #stageCell: number | undefined;

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
      sittingAngleLimit: () => sittingAngleLimit(this.#session?.scriptsReady),
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
  /** The player's body while playing. */
  #avatar: PlayerAvatar | undefined;
  /** Shown objects whose behavior graph moves their skeleton. */
  #objectSkeletons: readonly AnimatedSkeleton[] = [];

  /** Starts playing the cell on screen: physics, and the player standing at `feet`. */
  async #startPlay(
    feet: readonly [number, number, number],
    yaw: number,
    /** The player arrives through a door: on the floor at its feet. */
    onFloor: boolean,
  ): Promise<void> {
    const session = this.#session;
    if (!session) return;
    const token = this.#loadToken;
    const [matrix, playerData] = await Promise.all([
      session.collisionMatrix(),
      session.playerData(),
      initPhysics(),
    ]);
    if (token !== this.#loadToken) return;
    this.#stopPlay();
    const physics = new PhysicsWorld(matrix, GRAVITY);
    configurePhysics(physics, playerData);
    const player = new Player(
      {
        ...playerData,
        physics,
        waterHeight: (x, y, z) => this.#waterAt(x, y, z)?.height,
        controlsNow: () => playerData.controls,
      },
      feet,
      yaw,
    );
    // Game.DisablePlayerControls' abCamSwitch keeps the camera as it is.
    player.povSwitchAllowed = () => this.#session?.scriptsReady?.controls.camSwitch !== false;
    player.character.walkable = (x, y, z) =>
      this.#cell?.navmesh.heightNear(x, y, z, NAVMESH_TOLERANCE) !== undefined;
    player.overEncumbered = () => this.#session?.overEncumbered === true;
    // Slow Time's pace and the falls' damage (src/shell/time-flow.ts).
    connectPlayerTime(player, () => this.#session, physics);
    // What the player does that the actors near comment on (src/shell/actor-talk.ts).
    player.onAction = (subtype) => {
      void this.#stage?.talk.playerAction(subtype);
    };
    const play = new PlaySession({
      physics,
      player,
      waterAt: (x, y, z) => this.#waterAt(x, y, z),
      waterRules: playerData.water,
      camera: this.#fly,
      canvas: this.#canvas,
      groundReady: () => this.#collision.ready,
      // Arrival points lie on the floor; search a little above it (not up to a floor above).
      searchAbove: 64,
      arrivesOnFloor: onFloor,
      activatable: (reference) => this.#activatable(reference),
      actorAt: talkTargets(
        () => this.#stage?.shown() ?? [],
        () => this.#session,
        this.#terminal,
        // A horse is ridden (src/shell/actor-mounts.ts).
        (placed) => this.#stage?.mounts.activation(placed),
      ),
      // The player's perks on activation (Filter Activation, Activate's choices, labels).
      perks: perkActivation(() => this.#session?.scriptsReady),
      prompt: this.#ui.prompt,
      hud: session.hud,
      onImpact: (impact) => {
        // Its sound is a noise the actors may hear (the impact's sound level).
        this.#session?.soundSystem?.impact(impact, (sounded) => {
          this.#stage?.senses.noise(impact.position, undefined, sounded.soundLevel);
        });
      },
    });
    play.lensShift = this.#fly.lensShift;
    play.onFreeCamera = (free) => {
      this.#ui.freeCamera.checked = free;
    };
    this.#play = play;
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
  }

  #stopPlay(): void {
    this.#avatar?.destroy();
    this.#avatar = undefined;
    this.#seat = undefined;
    this.#playerIdle = undefined;
    this.#stage?.combat.attachPlayer(undefined, undefined);
    this.#stage?.attachPlay(undefined);
    this.#play?.dispose();
    this.#play = undefined;
    this.#collision = collisionGroup();
    this.#ui.play.hidden = true;
  }

  /** Called when the viewer takes the screen (another viewer then steps back). */
  onActivate: (() => void) | undefined;
  /** Whether the renderer shows this viewer's view. */
  #viewShown = false;
  /** Real seconds of the last clock tick (cells). */
  #lastClock: number | undefined;

  /** Centres the image in the part of the screen the shell does not cover. */
  set lensShift(shift: number) {
    this.#orbit.lensShift = shift;
    this.#fly.lensShift = shift;
    if (this.#play) this.#play.lensShift = shift;
  }

  /** Every mesh path in the VFS (for tools and dev checks). */
  get meshes(): readonly string[] {
    return this.#meshes;
  }

  /** The free camera used for cells (for dev checks). */
  get flyCamera(): FlyCamera {
    return this.#fly;
  }

  get cells(): readonly InteriorCell[] {
    return this.#cells;
  }

  /** The cell's lighting near a place (the light on actors: src/shell/actor-senses.ts). */
  #lightProbe(at: Vec3): LightProbe | undefined {
    const cell = this.#cell;
    if (!cell) return undefined;
    const lighting = this.#cellLighting ?? cellSceneLighting(cell.data, this.#isEnabled);
    return {
      ambient: lighting.ambient,
      sunColor: lighting.sunColor,
      sunDirection: lighting.sunDirection,
      lights: pointLights(
        [
          ...cell.data.lights.filter((light) => this.#isEnabled(light.reference)),
          ...(this.#created?.lights() ?? []),
          ...(this.#stage?.lights() ?? []),
        ],
        this.#tickClock(),
        at,
        (id) => this.#emittanceRgb(id),
      ),
      interior: true,
    };
  }

  /** Starts using a (new) game session: lists its meshes and cells. */
  async connect(session: GameSession): Promise<void> {
    this.#reset();
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
      focus: () => this.#play?.player.feet,
      // Actors walking into trigger volumes tell their scripts.
      onTrigger: (trigger, actor, entered) => {
        this.#session?.scriptsReady?.triggered(trigger, actor, entered);
      },
      cellOf: (at) =>
        at.cell !== undefined && at.cell === this.#stageCell ? String(at.cell) : undefined,
      navmeshes: () => this.#navmeshes,
      objects: () => this.#stageObjects(),
      obstacles: () => this.#stageObstacles(),
      door: (reference) => this.#doorOf(reference),
      interior: true,
      light: (at) => this.#lightProbe(at),
      player: () => this.playerView,
    });
    const { vfs, loader } = session;
    this.#meshes = vfs.list('meshes').filter((path) => path.endsWith('.nif'));
    this.#terminal.log(
      'sys',
      `${loader.workerCount} asset workers · ${numberFormat.format(this.#meshes.length)} meshes`,
    );
    this.#ui.meshes.panel.hidden = false;
    this.#ui.meshes.count.textContent = `${numberFormat.format(this.#meshes.length)} meshes`;
    this.#showMeshResults();

    const db = await session.db;
    this.#db = db;
    this.#cells = await db.interiorCells();
    this.#terminal.log('esm', `${numberFormat.format(this.#cells.length)} interior cells`);
    this.#ui.cells.panel.hidden = false;
    this.#ui.cells.count.textContent = `${numberFormat.format(this.#cells.length)} cells`;
    this.#showCellResults();
  }

  /** Loads a mesh and shows it on its own. */
  async showMesh(path: string, view: OrbitView): Promise<void> {
    const loader = this.#session?.loader;
    const textures = this.#session?.textures;
    if (!loader || !textures) return;
    // A single model has no sounds of its own (a cell shown before had).
    this.#session?.soundSystem?.stopAll();
    const token = ++this.#loadToken;
    const start = performance.now();
    this.#terminal.log('nif', `loading ${path}`);

    const loaded = await loader.loadModel(path);
    const model = await this.#renderer.scene.createModel(loaded.model, textures);
    model.addons = (await this.#session?.addons(loaded.model.addons)) ?? [];
    if (token !== this.#loadToken) {
      model.destroy();
      return;
    }
    for (const problem of loaded.problems) this.#terminal.log('nif', problem, 'warn');
    for (const skipped of loaded.model.skipped) this.#terminal.log('nif', skipped, 'warn');
    for (const failure of textures.takeFailures())
      this.#terminal.log('dds', failure.text, failure.gameLacks ? 'info' : 'warn');
    this.#releaseCell();
    this.#renderUpgrades();
    const triangles = loaded.model.parts.reduce((sum, part) => sum + part.indices.length / 3, 0);
    this.#terminal.log(
      'nif',
      `${path.replace(/^meshes\\/, '')} · ${loaded.model.parts.length} parts · ` +
        `${numberFormat.format(triangles)} triangles · ${(performance.now() - start).toFixed(0)} ms ` +
        `(worker ${loaded.workMs.toFixed(0)} ms)`,
      'ok',
    );

    this.#orbit.setView(view);
    // Particle-only models (master particle systems) have no shapes to measure.
    this.#orbit.fit(model.center, model.radius > 0 ? model.radius : 64);
    const graph = startObjectGraph(model, 0);
    const skeletal = startPlacedSkeleton(model, 0);
    const instance: ModelInstance = {
      model,
      world: identity(),
      ...(graph && { graph }),
      ...(skeletal && { pose: skeletal.skeleton.pose, poseNodes: skeletal.poseNodes }),
    };
    this.#objectSkeletons = skeletal ? [skeletal.skeleton] : [];
    this.#present(this.#renderer.scene.createScene([instance]), model, { camera: 'orbit' });
  }

  /** Opens a mesh with the regular model view. */
  showModel(path: string): Promise<void> {
    return this.showMesh(path, MODEL_VIEW);
  }

  /**
   * Loads an interior cell with all its objects and lights. The player arrives at `arrival`
   * (a load door's destination), else as through the cell's own door.
   */
  async showCell(formId: number, arrival?: Arrival): Promise<void> {
    const info = this.#cells.find((cell) => cell.formId === formId);
    this.#loading = info ? (info.name !== '' ? info.name : info.editorId) : 'interior';
    try {
      await this.#showCell(formId, arrival);
    } catch (error) {
      this.#loading = undefined;
      throw error;
    }
  }

  async #showCell(formId: number, arrival: Arrival | undefined): Promise<void> {
    const db = this.#db;
    if (!db) return;
    const token = ++this.#loadToken;
    const start = performance.now();
    // It resets if its time has come, before its references load (cell-reset.ts).
    await this.#session?.scriptsReady?.cellResets.attaching(formId);
    const loadedData = await (this.#session?.cellData(formId) ?? loadCellData(db, formId));
    // Its objects where the game left them (moved-objects.ts).
    const scripts = this.#session?.scriptsReady;
    const data = scripts
      ? { ...loadedData, objects: placedAsMoved(loadedData.objects, scripts.state, formId) }
      : loadedData;
    const label = `${data.cell.editorId}${data.cell.name ? ` "${data.cell.name}"` : ''}`;
    for (const skipped of data.skipped) this.#terminal.log('cell', skipped, 'warn');

    // Load every model that can appear, so switching upgrades is instant, and find what the
    // player can buy or build here.
    const paths = [...new Set(data.objects.map((object) => object.model))];
    const session = this.#session;
    const waterIds = [
      ...new Set(
        data.objects.flatMap((object) => (object.water === undefined ? [] : [object.water])),
      ),
    ];
    // The actors of the cell come onto the stage (those of the cell shown before leave it).
    this.#stage?.clear();
    this.#stageCell = formId;
    const [models, collisions, directionals, actions, imageSpace, waterTypes, ragdolls] =
      await Promise.all([
        Promise.all(paths.map(async (path) => [path, await this.#cellModel(path)] as const)).then(
          (entries) => new Map(entries),
        ),
        Promise.all(
          paths.map(async (path) => [path, await session?.collision(path)] as const),
        ).then((entries) => new Map(entries)),
        Promise.all(
          data.objects.map(
            async (object) =>
              [object.reference, await session?.directionalMaterial(object.directional)] as const,
          ),
        ).then(
          (entries) =>
            new Map(
              entries.flatMap(([reference, directional]) =>
                directional ? [[reference, directional] as const] : [],
              ),
            ),
        ),
        this.#homeActions(data),
        db
          .get(data.cell.imageSpace ?? DEFAULT_INTERIOR_IMAGE_SPACE)
          .then((record) => (record?.type === 'IMGS' ? parseImageSpace(record) : undefined)),
        Promise.all(waterIds.map(async (id) => [id, await session?.waterType(id)] as const)).then(
          (entries) => new Map(entries),
        ),
        this.#stage?.attachCell(String(formId), data.actors, (reference) =>
          this.#isEnabled(reference),
        ) ?? Promise.resolve([]),
        session?.waterType(DEFAULT_WATER).then((type) => {
          this.#renderer.scene.defaultWater = type;
        }),
      ]);
    const toggles = findToggles(data, actions.controlled);
    // Homes open as the running game has them: bought, built and furnished only as far as its
    // scripts did (their enable states); the panel's presets preview the rest.
    const choices = NEW_GAME;
    const scripted = await this.#playActions(actions, choices);
    if (token !== this.#loadToken) return;

    // Decals land on the nearest surface along their projection (of the objects shown when
    // the cell opens).
    const opening = enabledReferences(data, toggles, gameStartSelection(toggles), scripted);
    const placed = data.objects.flatMap((object) => {
      const model = opening(object.reference) ? models.get(object.model) : undefined;
      return model ? [{ model, world: object.world }] : [];
    });
    const decals =
      session &&
      (await this.#renderer.decals.createDecals(
        projectDecals(data.decals, placedParts(placed)),
        session.textures,
      ));
    if (token !== this.#loadToken) {
      decals?.destroy();
      return;
    }
    for (const failure of this.#session?.textures.takeFailures() ?? []) {
      this.#terminal.log('dds', failure.text, failure.gameLacks ? 'info' : 'warn');
    }
    const previousDecals = this.#cell?.decals;
    this.#cell = {
      data,
      toggles,
      selection: new Set(session?.cellSelections.get(formId) ?? gameStartSelection(toggles)),
      actions,
      choices,
      scripted,
      models,
      collisions,
      directionals,
      label,
      imageSpace,
      waterTypes,
      decals,
      navmesh: new NavmeshSurface(await cellNavmeshes(db, formId)),
      ragdolls,
    };
    // The player arrives as through the cell's door; without one, at its middle.
    const comeIn = arrival ?? (await cellArrival(db, data));
    if (token !== this.#loadToken) return;
    // Load doors: where they lead (for the activation prompt).
    for (const object of data.objects) {
      if (object.teleport && !this.#destinations.has(object.teleport.door)) {
        this.#destinations.set(object.teleport.door, await doorDestination(db, object.teleport));
      }
    }
    const [x, y, z] = comeIn?.position ?? data.entrance;
    this.#fly.position = [x, y, z + EYE_HEIGHT];
    const centre = data.objects.reduce<[number, number, number]>(
      (sum, object) => [
        sum[0] + (object.world[12] ?? 0),
        sum[1] + (object.world[13] ?? 0),
        sum[2] + (object.world[14] ?? 0),
      ],
      [0, 0, 0],
    );
    const count = Math.max(1, data.objects.length);
    this.#fly.lookAtPoint([centre[0] / count, centre[1] / count, z + EYE_HEIGHT]);
    await this.#startPlay([x, y, z], comeIn ? comeIn.heading : this.#fly.yaw, comeIn !== undefined);
    if (token !== this.#loadToken) return;

    this.#renderUpgrades();
    const visible = this.#applyCellSelection();
    void this.#glowCell(token);
    void this.#attachToScripts(token);
    if (session) {
      this.#sky?.dispose();
      this.#sky = new InteriorSkyControls(session, this.#ui.sky);
      void this.#enterSky(session, data.cell, token);
    }
    this.#ui.status.hidden = false;
    const actorsShown = [...(this.#stage?.shown() ?? [])].length;
    this.#ui.status.textContent =
      `${label} · ${String(visible)} of ${String(data.objects.length)} objects · ` +
      `${String(actorsShown)} of ${String(data.actors.length)} actors`;
    if (previousDecals !== decals) previousDecals?.destroy();
    const what = [
      actions.purchases.length > 0 ? `${String(actions.purchases.length)} purchases` : '',
      actions.house ? 'HearthFire house' : '',
      toggles.length > 0 ? `${String(toggles.length)} quest states` : '',
    ].filter(Boolean);
    this.#terminal.log(
      'cell',
      `${label} ${hex(formId)} · ${visible} of ${data.objects.length} objects shown · ` +
        `${actorsShown} of ${data.actors.length} actors · ` +
        `${models.size} models${what.length > 0 ? ` · ${what.join(' · ')}` : ''} · ` +
        `${(performance.now() - start).toFixed(0)} ms`,
      'ok',
    );
    this.#terminal.log(
      'cell',
      'click the scene to look around · WASD to move · shift to run · esc to release',
    );
  }

  /** What actors' animations sound with: the session's sounds, the play's collision. */
  readonly #soundingWorld: SoundingWorld = {
    sounds: () => this.#session?.soundSystem,
    ground: (at, exclude) => groundUnder(this.#play?.physics, at, exclude),
    water: (at) => this.#waterAt(at[0], at[1], at[2]),
  };

  #scriptEnvironment(): Promise<ScriptEnvironment> | undefined {
    return this.#session?.scripts();
  }

  async #homeActions(data: CellData): Promise<HomeActions> {
    const none: HomeActions = { purchases: [], house: undefined, controlled: new Set() };
    try {
      const env = await this.#scriptEnvironment();
      return env ? await findHomeActions(env, data) : none;
    } catch (error) {
      this.#terminal.log('papyrus', `player actions not available: ${describe(error)}`, 'warn');
      return none;
    }
  }

  /** Plays the player's actions in the Papyrus VM; returns the scripted enable states. */
  async #playActions(
    actions: HomeActions,
    choices: HomeChoices,
  ): Promise<ReadonlyMap<number, boolean>> {
    if (actions.purchases.length === 0 && !actions.house) return new Map();
    const env = await this.#scriptEnvironment();
    if (!env) return new Map();
    const result = await playHomeActions(env, actions, choices);
    for (const warning of result.warnings.slice(0, 3)) {
      this.#terminal.log('papyrus', warning, 'warn');
    }
    if (result.warnings.length > 3) {
      this.#terminal.log('papyrus', `… ${String(result.warnings.length - 3)} more script warnings`);
    }
    return result.enabled;
  }

  /**
   * The enable state of the cell's references now: what the scripts set (the running game's
   * and the home's actions), else the states panel's choice, else the plugin's.
   */
  #enableState(cell: CellView): (reference: number) => boolean {
    const scripted = new Map(cell.scripted);
    for (const [reference, enabled] of this.#session?.scriptedEnables() ?? []) {
      scripted.set(reference, enabled);
    }
    return enabledReferences(cell.data, cell.toggles, cell.selection, scripted);
  }

  /**
   * Builds the cell scene: every object and actor that can appear, each with its visibility,
   * and all their collision (a disabled reference's switched off); then applies the enable
   * state. Returns the number of objects shown.
   */
  #applyCellSelection(): number {
    const cell = this.#cell;
    if (!cell) return 0;
    const session = this.#session;
    const instances: ModelInstance[] = [];
    const placed = new Map<CellData['objects'][number], ModelInstance>();
    const articulatedPoses = new Map<CellData['objects'][number], ActorPose>();
    const shown = new Map<number, ModelInstance>();
    this.#instances = shown;
    const visibility = new Map<number, InstanceVisibility>();
    this.#visibility = visibility;
    this.#enabledNow = new Map();
    const shownBy = (reference: number): InstanceVisibility => {
      let entry = visibility.get(reference);
      if (!entry) {
        entry = { hidden: false };
        visibility.set(reference, entry);
      }
      return entry;
    };
    const volumes: { reference: number; volumes: WaterVolume[] }[] = [];
    this.#allWaterVolumes = volumes;
    const skeletons: { reference: number; skeleton: AnimatedSkeleton }[] = [];
    this.#allObjectSkeletons = skeletons;
    for (const object of cell.data.objects) {
      const collision = cell.collisions.get(object.model);
      if (object.water !== undefined) {
        volumes.push({
          reference: object.reference,
          volumes: waterVolumes(collision, object.world, object.water),
        });
      }
      if (this.#hidden?.test(object.model)) continue;
      const model = cell.models.get(object.model);
      const water = object.water === undefined ? undefined : cell.waterTypes.get(object.water);
      const directional = cell.directionals.get(object.reference);
      if (model && session) {
        const { instance, skeleton, articulated } = placeObject(
          session,
          object,
          { model, collision, water, directional },
          { simulated: this.#play !== undefined, visibility: shownBy(object.reference) },
        );
        if (skeleton) skeletons.push({ reference: object.reference, skeleton });
        if (articulated) articulatedPoses.set(object, articulated);
        instances.push(instance);
        placed.set(object, instance);
        shown.set(object.reference, instance);
        this.#flora?.add(object, instance.world, shownBy(object.reference), () =>
          this.#isEnabled(object.reference),
        );
        this.#destruction?.add(object, instance.world, shownBy(object.reference), () =>
          this.#isEnabled(object.reference),
        );
      }
    }
    // All the collision; a disabled reference's is switched off as it is placed.
    const play = this.#play;
    if (play) {
      play.remove(this.#collision);
      this.#collision = collisionGroup();
      const key = String(cell.data.cell.formId);
      play.add(this.#collision, {
        // Its actors stand on the ground once it is in place.
        whenComplete: () => {
          this.#stage?.ground(key, play.physics);
        },
        objects: cell.data.objects.map((object) => {
          const articulated = articulatedPoses.get(object);
          return {
            object,
            collision: cell.collisions.get(object.model),
            instance: placed.get(object),
            ...(articulated && { articulated }),
          };
        }),
        primitives: cell.data.primitives,
        ragdolls: cell.ragdolls,
        isEnabled: (reference) => this.#isEnabled(reference),
      });
    }
    // Each placed object stands in the room holding its position (portal-strict lights).
    const cellRooms = cell.data.rooms?.rooms ?? [];
    const roomOfInstance = new Map<ModelInstance, number>();
    if (cellRooms.length > 0) {
      for (const [object, instance] of placed) {
        const room = roomIndexAt(cellRooms, [
          object.world[12] ?? 0,
          object.world[13] ?? 0,
          object.world[14] ?? 0,
        ]);
        if (room >= 0 && room < 255) roomOfInstance.set(instance, room + 1);
      }
    }
    const scene = this.#renderer.scene.createScene(instances, {
      roomOf: (instance) => roomOfInstance.get(instance),
    });
    const rooms = cell.data.rooms && new RoomCuller([cell.data.rooms]);
    const shownCount = this.#refreshEnabled();
    // The cell's imagespace with the image-space modifiers on the screen over it.
    // The room the camera is in: its own lighting template and image space while it is there.
    const cameraRoom = (): number => {
      const at = this.#renderer.view?.camera.position;
      return at && cellRooms.length > 0 ? roomIndexAt(cellRooms, at) : -1;
    };
    this.#roomImageSpaces = new Map();
    this.#loadRoomImageSpaces(cellRooms);
    const imageSpace = (): ImageSpace | undefined => {
      const own = this.#roomImageSpaces.get(cameraRoom()) ?? cell.imageSpace;
      return this.#session?.imageSpaceModifiers.imageSpace(own) ?? own;
    };
    this.#present(scene, undefined, {
      camera: 'fly',
      lighting: () => {
        const lighting = this.#lightingInRoom(cell.data, cameraRoom());
        // The imagespace's Sunlight Scale brightens the cell's directional light (HDR).
        const scale = imageSpace()?.hdr.sunlightScale ?? 1;
        return {
          ...lighting,
          sunColor: [
            lighting.sunColor[0] * scale,
            lighting.sunColor[1] * scale,
            lighting.sunColor[2] * scale,
          ],
        };
      },
      imageSpace,
      lights: cell.data.lights,
      decals: cell.decals,
      ...(rooms && { rooms }),
      ...(cellRooms.length > 0 && {
        roomAt: (point: Vec3): number => {
          const room = roomIndexAt(cellRooms, point);
          return room >= 0 && room < 255 ? room + 1 : 0;
        },
      }),
    });
    return shownCount;
  }

  /** The cell's lighting with the camera in `room`: its own template's while it has one. */
  #lightingInRoom(data: CellData, room: number): SceneLighting {
    const cellLighting = this.#cellLighting ?? cellSceneLighting(data, this.#isEnabled);
    if (room < 0 || data.roomLighting?.[room] === undefined) return cellLighting;
    const cached = this.#roomLighting;
    if (cached?.room === room && cached.of === this.#cellLighting) return cached.lighting;
    const lighting = cellSceneLighting(data, this.#isEnabled, room);
    this.#roomLighting = { room, of: this.#cellLighting, lighting };
    return lighting;
  }

  /** Reads the rooms' own image spaces (INAM) for the cell shown. */
  #loadRoomImageSpaces(rooms: readonly CellRoom[]): void {
    const db = this.#session?.db;
    if (!db) return;
    const own = this.#roomImageSpaces;
    rooms.forEach((room, i) => {
      const formId = room.imageSpace;
      if (formId === undefined) return;
      void db
        .then((records) => records.get(formId))
        .then((record) => {
          if (record?.type === 'IMGS') own.set(i, parseImageSpace(record));
        })
        .catch((error: unknown) => {
          this.#terminal.log('world', `room image space: ${String(error)}`, 'warn');
        });
    });
  }

  /**
   * Applies the enable state to the cell on screen (a script enabled or disabled references,
   * the home's actions or the states panel changed): what is drawn, collides, sounds, lights
   * and holds water, without building the scene again. Returns the number of objects shown.
   */
  #refreshEnabled(): number {
    const cell = this.#cell;
    if (!cell) return 0;
    const isEnabled = this.#enableState(cell);
    this.#isEnabled = isEnabled;
    for (const [reference, entry] of this.#visibility) entry.hidden = !isEnabled(reference);
    // Collision: every reference that has some, switched as its state changes.
    const play = this.#play;
    const references = [
      ...cell.data.objects.map((object) => object.reference),
      ...cell.data.primitives.map((primitive) => primitive.reference),
      ...cell.ragdolls.map((ragdoll) => ragdoll.reference),
    ];
    for (const reference of references) {
      const enabled = isEnabled(reference);
      const before = this.#enabledNow.get(reference);
      this.#enabledNow.set(reference, enabled);
      if (before !== undefined && before !== enabled) play?.setReferenceEnabled(reference, enabled);
    }
    this.#stage?.refresh();
    this.#objectSkeletons = this.#allObjectSkeletons
      .filter((entry) => isEnabled(entry.reference))
      .map((entry) => entry.skeleton);
    this.#waterAreas = cell.data.waterAreas.filter((area) => isEnabled(area.reference));
    this.#waterVolumes = this.#allWaterVolumes
      .filter((entry) => isEnabled(entry.reference))
      .flatMap((entry) => entry.volumes);
    // The cell's sounds: its enabled loops, acoustic spaces and its own acoustic space.
    const session = this.#session;
    if (session) {
      const emitters = cell.data.emitters.filter((emitter) => isEnabled(emitter.reference));
      const areas = cell.data.acousticAreas.filter((area) => isEnabled(area.reference));
      const space = cell.data.cell.acousticSpace;
      void session.sounds().then((sounds) => {
        if (this.#cell !== cell) return;
        sounds.setEmitters(emitters);
        sounds.setAcousticAreas(areas);
        sounds.setCellAcousticSpace(space);
      });
    }
    cell.decals?.select(isEnabled);
    this.#cellLighting = cellSceneLighting(cell.data, isEnabled);
    return [...this.#instances.keys()].filter((reference) => isEnabled(reference)).length;
  }

  /** Plays new choices for the cell on screen and shows the result. */
  async #setChoices(choices: HomeChoices): Promise<void> {
    const cell = this.#cell;
    if (!cell) return;
    cell.choices = choices;
    const token = ++this.#choiceToken;
    const scripted = await this.#playActions(cell.actions, choices);
    if (token !== this.#choiceToken || this.#cell !== cell) return;
    cell.scripted = scripted;
    this.#renderUpgrades();
    this.#refreshEnabled();
  }

  /**
   * The cell's controls: what the player buys or builds (played with the game's scripts),
   * presets for a new game and a fully upgraded home, and, folded away, quest states.
   */
  #renderUpgrades(): void {
    const cell = this.#cell;
    const container = this.#ui.upgrades;
    const { actions, choices } = cell ?? {};
    if (!cell || !actions || !choices) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    const hasActions = actions.purchases.length > 0 || actions.house !== undefined;
    if (!hasActions && cell.toggles.length === 0) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    const button = (text: string, onClick: () => void): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'preset';
      element.textContent = text;
      element.addEventListener('click', onClick);
      return element;
    };
    const checkbox = checkboxRow;
    const select = (
      text: string,
      options: readonly (readonly [string, string])[],
      value: string,
      onChange: (value: string) => void,
    ): HTMLLIElement => {
      const item = document.createElement('li');
      const labelElement = document.createElement('label');
      labelElement.className = 'choice';
      const element = document.createElement('select');
      for (const [optionValue, optionText] of options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionText;
        element.append(option);
      }
      element.value = value;
      element.addEventListener('change', () => {
        onChange(element.value);
      });
      labelElement.append(text, element);
      item.append(labelElement);
      return item;
    };
    const update = (change: Partial<HomeChoices>): void => {
      this.#run(this.#setChoices({ ...choices, ...change }));
    };
    const parts: HTMLElement[] = [];

    if (hasActions) {
      const head = document.createElement('div');
      head.className = 'upgrades-head';
      const title = document.createElement('span');
      title.textContent = actions.house ? 'build' : 'purchases';
      head.append(
        title,
        button('not bought', () => {
          this.#setCellPreset('not bought');
        }),
        button('fully upgraded', () => {
          this.#setCellPreset('fully upgraded');
        }),
      );
      parts.push(head);
      const list = document.createElement('ul');
      list.className = 'upgrade-list';
      const { house } = actions;
      if (house) {
        list.append(
          select(
            'house',
            [
              ['plot', 'empty plot'],
              ['small house', 'small house'],
              ['full', 'main hall and wings'],
            ],
            choices.stage,
            (stage) => {
              update({ stage: stage as HouseStage });
            },
          ),
        );
        for (const wing of house.wings) {
          list.append(
            select(
              wing.name.toLowerCase(),
              [['', 'none'], ...wing.rooms.map((room) => [room, room] as const)],
              choices.wings.get(wing.name) ?? '',
              (room) => {
                const wings = new Map(choices.wings);
                wings.set(wing.name, room === '' ? undefined : room);
                update({ wings });
              },
            ),
          );
        }
        list.append(
          checkbox('furnish finished rooms', choices.furnished, (on) => {
            update({ furnished: on });
          }),
        );
      }
      for (const purchase of actions.purchases) {
        list.append(
          checkbox(
            purchase.label,
            choices.purchases.has(purchase.info),
            (on) => {
              const purchases = new Set(choices.purchases);
              if (on) purchases.add(purchase.info);
              else purchases.delete(purchase.info);
              update({ purchases });
            },
            `dialogue ${hex(purchase.info)}`,
          ),
        );
      }
      parts.push(list);
    }

    if (cell.toggles.length > 0) {
      parts.push(
        cellStatesElement(
          cell.toggles,
          cell.selection,
          (selection) => {
            cell.selection = selection;
            this.#session?.cellSelections.set(cell.data.cell.formId, selection);
            this.#refreshEnabled();
          },
          this.#statesOpen,
          (open) => {
            this.#statesOpen = open;
          },
        ),
      );
    }

    container.replaceChildren(...parts);
    container.hidden = false;
  }

  #setCellPreset(preset: 'not bought' | 'fully upgraded'): void {
    const cell = this.#cell;
    if (!cell) return;
    cell.selection = gameStartSelection(cell.toggles);
    this.#run(
      this.#setChoices(
        preset === 'not bought' ? NEW_GAME : fullyUpgraded(cell.actions, cell.choices),
      ),
    );
  }

  /** What the player can buy and build in the cell on screen (for dev checks). */
  get cellActions(): HomeActions | undefined {
    return this.#cell?.actions;
  }

  /** Quest states of the cell on screen (for dev checks). */
  get cellToggles(): readonly CellToggle[] {
    return this.#cell?.toggles ?? [];
  }

  /** Plays new choices for the cell on screen (for dev checks). */
  setCellChoices(choices: HomeChoices): Promise<void> {
    return this.#setChoices(choices);
  }

  /** Applies a preset to the cell on screen (for dev checks). */
  setCellPreset(preset: 'not bought' | 'fully upgraded'): void {
    this.#setCellPreset(preset);
  }

  /** Objects of the cell on screen near a point, with their state (for dev checks). */
  cellObjectsNear(
    point: readonly [number, number, number],
    distance: number,
  ): { reference: string; model: string; enabled: boolean; loaded: boolean }[] {
    const cell = this.#cell;
    if (!cell) return [];
    const isEnabled = this.#enableState(cell);
    return cell.data.objects
      .filter(
        (o) =>
          Math.hypot(
            (o.world[12] ?? 0) - point[0],
            (o.world[13] ?? 0) - point[1],
            (o.world[14] ?? 0) - point[2],
          ) <= distance,
      )
      .map((o) => ({
        reference: hex(o.reference),
        model: o.model,
        enabled: isEnabled(o.reference),
        loaded: cell.models.get(o.model) !== undefined,
      }));
  }

  /** Hides objects whose model path matches (for dev checks); undefined shows all. */
  hideModels(pattern: RegExp | undefined): void {
    this.#hidden = pattern;
    this.#applyCellSelection();
  }

  /** The player's body while playing. */
  get avatar(): PlayerAvatar | undefined {
    return this.#avatar;
  }

  /** The player's body, in third person or seen from the free camera or a menu's. */
  #avatarScenes(): GpuScene[] {
    const play = this.#play;
    const avatar = this.#avatar;
    if (!play || !avatar) return [];
    return play.bodyShown && avatar.scene ? [avatar.scene] : [];
  }

  /** Number of objects shown in the cell on screen (for dev checks). */
  get cellObjectsShown(): number {
    const cell = this.#cell;
    if (!cell) return 0;
    const isEnabled = this.#enableState(cell);
    return cell.data.objects.filter((object) => isEnabled(object.reference)).length;
  }

  /** A cell model from the session's cache; undefined for editor markers and broken files. */
  #cellModel(path: string): Promise<GpuModel | undefined> {
    return this.#session?.model(path) ?? Promise.resolve(undefined);
  }

  #present(
    scene: GpuScene,
    meshModel: GpuModel | undefined,
    view:
      | { camera: 'orbit' }
      | {
          camera: 'fly';
          lighting: () => ReturnType<typeof cellSceneLighting>;
          /** The imagespace of each frame (the image-space modifiers change it). */
          imageSpace: () => ImageSpace | undefined;
          /** Placed lights, flickering and pulsing per frame. */
          lights: readonly CellLight[];
          decals: GpuDecals | undefined;
          /** The cell's rooms, portals and occluders. */
          rooms?: RoomCuller;
          /** The room holding a point (1-255; 0 none): moving actors take theirs. */
          roomAt?: (point: Vec3) => number;
        },
  ): void {
    this.onActivate?.();
    const previousScene = this.#scene;
    const previousMesh = this.#meshModel;
    this.#scene = scene;
    this.#meshModel = meshModel;
    this.#detachControls?.();
    if (view.camera === 'orbit') {
      this.#detachControls = this.#orbit.attach(this.#canvas);
      this.#renderer.setView({
        scenes: () => [scene],
        camera: this.#orbit,
        lighting: () => studioLighting(this.#orbit),
        backdrop: true,
        update: (seconds) => {
          animateSkeletons(this.#objectSkeletons, seconds);
        },
      });
    } else {
      // Playing: the player's camera (or the free camera); before that the free camera.
      const play = this.#play;
      const camera = play?.view ?? this.#fly;
      if (play) {
        play.attach();
        this.#detachControls = () => {
          play.detach();
        };
      } else {
        this.#detachControls = this.#fly.attach(this.#canvas);
      }
      const { lighting, imageSpace, lights, decals, rooms, roomAt } = view;
      this.#renderer.setView({
        // The cell's scene now (built again when an actor is made again in a new race).
        scenes: () => [
          this.#scene ?? scene,
          ...this.#avatarScenes(),
          ...(this.#stage?.scenes() ?? []),
          ...(this.#created?.scenes() ?? []),
          ...(this.#flora?.scenes() ?? []),
          ...(this.#destruction?.scenes() ?? []),
        ],
        camera,
        lighting: () =>
          this.#withUnderwater(camera.position, {
            ...lighting(),
            lights: [
              // A menu's lights (the race menu's) first: they light what it shows.
              ...(this.#play?.extraLights ?? []),
              ...pointLights(
                [
                  ...lights.filter((light) => this.#isEnabled(light.reference)),
                  ...(this.#created?.lights() ?? []),
                  // Magic's: effects on actors, casts in hands, what flies and bursts.
                  ...(this.#stage?.lights() ?? []),
                ],
                this.#tickClock(),
                camera.position,
                (id) => this.#emittanceRgb(id),
                this.#session?.ini.number('Display', 'fLightLODStartFade'),
              ),
            ],
          }),
        imageSpace,
        // The cell's shadow lights cast shadows (interiors have no sun shadow).
        lightShadows: true,
        ...(rooms && { rooms: () => rooms }),
        ...(roomAt && { roomAt }),
        // The cell's decals and the hits' blood (src/shell/combat-impacts.ts).
        decals: () => [...(decals ? [decals] : []), ...(this.#stage?.combat.decals() ?? [])],
        backdrop: false,
        update: (seconds) => {
          // The player animates at their own pace in slowed time.
          this.#avatar?.update(seconds * (this.#session?.time.playerPace ?? 1));
          if (this.#avatar) this.#seat?.frame(this.#avatar.stepped);
          this.#stage?.animate(seconds);
          animateSkeletons(this.#objectSkeletons, seconds);
        },
      });
    }
    this.#viewShown = true;
    previousScene?.destroy();
    if (previousMesh !== meshModel) previousMesh?.destroy();
    document.body.classList.add('has-scene');
    // The CRT overlay belongs to the page background, never over a model, cell or world.
    document.body.classList.add('content-scene');
  }

  /** The water a point of the interior is in or over: a water activator's volume. */
  readonly #waterAt = (
    x: number,
    y: number,
    z: number,
  ): { height: number; type: number } | undefined => surfaceOver(this.#waterVolumes, x, y, z);

  /** The water one hears around a point (height `z`): the water activators' surfaces. */
  readonly #waterSurfaceAt = (
    x: number,
    y: number,
    z: number,
  ): { height: number; type: number } | undefined => {
    for (const area of this.#waterAreas) {
      const height = waterAreaHeight(area, x, y, z);
      if (height !== undefined) return { height, type: area.type };
    }
    return undefined;
  };

  /** Whether the camera is under the interior's water. */
  /** The view below water surfaces: the water type's underwater fog (underwater.ts). */
  readonly #underwaterView = new UnderwaterView((formId) =>
    this.#session?.waterType(formId).then((gpu) => gpu?.type),
  );

  /** A cell's lighting, with the water type's underwater fog when the camera is under water. */
  #withUnderwater(camera: Vec3, lighting: SceneLighting): SceneLighting {
    const water = this.#waterAt(camera[0], camera[1], camera[2]);
    const fog = this.#underwaterView.fog(camera[2], water, lighting);
    return fog ? { ...lighting, fog } : lighting;
  }

  #underwater(): boolean {
    const camera = this.#renderer.view?.camera.position;
    if (!camera) return false;
    const water = this.#waterAt(camera[0], camera[1], camera[2]);
    return water !== undefined && camera[2] < water.height;
  }

  /**
   * Advances the session's game clock at the timescale (time passes indoors too) and moves the
   * emittance colours with it (sunlight bounce lights dark at night); returns real seconds.
   */
  #tickClock(): number {
    const now = performance.now() / 1000;
    const session = this.#session;
    if (session) {
      const delta = this.#lastClock === undefined ? 0 : Math.min(0.25, now - this.#lastClock);
      // At the TimeScale times the panel's fast-forward (the slider sets the hour); it stands
      // still while the game is in a menu.
      if (!session.menuMode && !session.loading) {
        session.advanceClock((delta * session.clockRate) / 3600);
      }
      // The sky's weather runs indoors too where the interior has a sky (Show Sky); without
      // one it stands still until the player is out again.
      if (this.#cell) session.sky.frame();
      this.#sky?.sync();
      session.updateEmittance(session.gameHour);
      // Indoors the sound system plays the region of the cell's acoustic space.
      session.soundSystem?.setAmbience(
        this.#cell && {
          regions: [],
          weather: undefined,
          previousWeather: undefined,
          transition: 1,
          hour: session.gameHour,
          interior: true,
          swimming: this.#play?.player.swimming ?? false,
          flash: undefined,
          cellMusic: this.#cell.data.cell.musicType,
          worldMusic: undefined,
          waterAt: this.#waterSurfaceAt,
          underwater: this.#underwater(),
          combatTargetHasKeyword: this.#combatTarget.of(session.scriptsReady),
        },
      );
    }
    this.#lastClock = now;
    return now;
  }

  /**
   * The player is in an interior: the sky's mode follows its Show Sky and Use Sky Lighting, and
   * its weather comes from the interior's sky region (XCCM) if it names one.
   */
  async #enterSky(session: GameSession, cell: CellRecord, token: number): Promise<void> {
    session.sky.setPlace({ interior: true, cellFlags: cell.flags });
    const region =
      cell.skyRegion === undefined ? undefined : await session.weatherRegion(cell.skyRegion);
    if (token !== this.#loadToken) return;
    session.sky.enterInterior(
      region && { formId: region.formId, weathers: region.weather?.weathers ?? [] },
    );
  }

  #emittanceRgb(formId: number): Rgb {
    return this.#session?.emittance(formId).rgb ?? [0, 0, 0];
  }

  /** Forgets the shown cell and frees what was made for it. */
  /**
   * The cell on screen joins the running game: its references' scripts start (OnInit the first
   * time) and get their cell and load events, once the scripts' new game has started.
   */
  async #attachToScripts(token: number): Promise<void> {
    const session = this.#session;
    if (!session) return;
    try {
      const runtime = await session.runtime();
      const cell = this.#cell;
      if (token !== this.#loadToken || !cell) return;
      this.#refreshEnabled();
      const references = [
        ...cell.data.objects.map((object) => object.reference),
        // Triggers (activators with a primitive) hear who enters them.
        ...cell.data.primitives.map((primitive) => primitive.reference),
        ...(this.#stage?.referencesIn(String(cell.data.cell.formId)) ?? []),
      ];
      const loaded = new Set(this.#loadedReferences());
      await runtime.cellAttached(references, (reference) => loaded.has(reference));
      for (const [reference, state] of runtime.state.references) {
        if (runtime.state.created.has(reference) && state.cell === cell.data.cell.formId) {
          await this.#showCreated(reference);
        }
      }
    } catch (error) {
      this.#terminal.log('papyrus', `scripts not running: ${describe(error)}`, 'warn');
    }
  }

  #releaseCell(): void {
    const cell = this.#cell;
    const runtime = this.#session?.scriptsReady;
    if (cell && runtime) {
      const loaded = new Set(this.#loadedReferences());
      // Its reset waits from now (cell-reset.ts). TODO(sim): its moved objects' places are noted
      // by the headless simulation and the world viewer only (moved-objects.ts noteMoved).
      runtime.detach(runtime.cellResets.detached(cell.data.cell.formId));
      runtime.detach(
        runtime.cellDetached(
          [
            ...cell.data.objects.map((object) => object.reference),
            ...(this.#stage?.referencesIn(String(cell.data.cell.formId)) ?? []),
          ],
          (reference) => loaded.has(reference),
        ),
      );
    }
    this.#stage?.clear();
    this.#stageCell = undefined;
    this.#created?.clear(this.#play);
    this.#flora?.clear();
    this.#destruction?.clear();
    this.#stopPlay();
    this.#sky?.dispose();
    this.#sky = undefined;
    this.#ui.status.hidden = true;
    const decals = this.#cell?.decals;
    this.#cell = undefined;
    this.#waterAreas = [];
    this.#waterVolumes = [];
    decals?.destroy();
  }

  #reset(): void {
    this.#loadToken++;
    this.#renderer.setView(undefined);
    this.#viewShown = false;
    this.#scene?.destroy();
    this.#scene = undefined;
    this.#releaseCell();
    this.#meshModel?.destroy();
    this.#meshModel = undefined;
    this.#db = undefined;
  }

  /** Stops showing anything (another viewer takes the screen); the session stays. */
  deactivate(): void {
    this.#loadToken++;
    this.#loading = undefined;
    this.#session?.soundSystem?.stopAll();
    this.#detachControls?.();
    this.#detachControls = undefined;
    // The renderer must stop drawing the scene before it is freed (the other viewer may take
    // a while to show its own).
    if (this.#viewShown) this.#renderer.setView(undefined);
    this.#viewShown = false;
    this.#scene?.destroy();
    this.#scene = undefined;
    this.#releaseCell();
    this.#meshModel?.destroy();
    this.#meshModel = undefined;
    this.#ui.upgrades.hidden = true;
  }

  #run(task: Promise<void>): void {
    task.catch((error: unknown) => {
      this.#terminal.log('err', describe(error), 'error');
    });
  }

  #meshMatches(): string[] {
    return matches(this.#meshes, (path) => path, this.#ui.meshes.search.value);
  }

  #cellMatches(): InteriorCell[] {
    return matches(
      this.#cells,
      (cell) => `${cell.editorId} ${cell.name}`.toLowerCase(),
      this.#ui.cells.search.value,
    );
  }

  #showMeshResults(): void {
    renderResults(
      this.#ui.meshes.results,
      this.#meshMatches(),
      (path) => path.replace(/^meshes\\/, ''),
      (path) => {
        this.#run(this.showMesh(path, MODEL_VIEW));
      },
    );
  }

  #showCellResults(): void {
    renderResults(
      this.#ui.cells.results,
      this.#cellMatches(),
      (cell) => (cell.name ? `${cell.editorId} · ${cell.name}` : cell.editorId),
      (cell) => {
        this.#run(this.showCell(cell.formId));
      },
    );
  }
}
