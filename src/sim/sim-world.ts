// The headless simulation: the game's world running in Node with its real systems and no
// screen, speaker or page. One game session (records, the VFS, the Papyrus runtime with its
// quests and story manager), the loaded area as the viewers load it (an interior cell, or a grid
// of exterior cells around the player: their objects placed, their collision in a Rapier physics
// world, their navmeshes, their actors on the actor stage with AI packages, movers, behavior
// graphs, combat and magic), and the player as a controllable actor. It steps at a fixed time
// step on a virtual clock (src/sim/virtual-clock.ts); what happens goes into a typed log
// (src/sim/sim-log.ts). The presentation is behind ports: the render port draws nothing
// (headless-render.ts), the HUD, the menus and the sounds are recorded.
//
// It loads cells by the same rules as the page's viewers (src/shell/model-viewer.ts for
// interiors, world-viewer.ts for exteriors): objects placed by src/sim/placed-objects.ts, the
// enable state by cell-upgrades.ts, the actors by the actor stage. TODO(sim): the viewers still
// carry their own copy of the rest of this glue (the script view, activation, streaming): they
// are to run on this world and only draw it.

import { animateSkeletons, type AnimatedSkeleton } from '../animation/animated-skeleton.ts';
import { actorScriptGraph, placedScriptGraph } from '../animation/script-graphs.ts';
import type { LightProbe } from '../ai/light-level.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import type { InstanceVisibility } from '../render/scene-renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorStage, type StagePlace } from '../shell/actor-stage.ts';
import type { DoorObject } from '../shell/actor-doors.ts';
import { stageObject, type StageObject } from '../shell/actor-furniture.ts';
import { groundUnder, type SoundingWorld } from '../shell/actor-sounds.ts';
import { talkTargets } from '../shell/actors.ts';
import { CreatedObjects } from '../shell/created-objects.ts';
import { DestructionLooks } from '../shell/destruction-looks.ts';
import { FloraLooks } from '../shell/flora-looks.ts';
import { GameSession } from '../shell/game-session.ts';
import { clock as objectClock } from '../shell/object-graphs.ts';
import { tellSwing } from '../shell/open-close.ts';
import {
  collisionGroup,
  objectActivation,
  perkActivation,
  PlaySession,
  type Activatable,
  type CellRagdoll,
  type CollisionGroup,
} from '../shell/play-session.ts';
import { noteMoved, placedAsMoved } from '../shell/moved-objects.ts';
import { configurePhysics, Player } from '../shell/player.ts';
import { PlayerAvatar } from '../shell/player-avatar.ts';
import { PlayerFurniture } from '../shell/player-furniture.ts';
import type { PlayerView } from '../shell/race-menu.ts';
import { instanceNodeWorld, MOTION_KEYFRAMED, type ScriptView } from '../shell/script-world.ts';
import { connectPlayerTime } from '../shell/time-flow.ts';
import { FlyCamera } from '../render/fly-camera.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { cellSceneLighting, pointLights } from '../world/cell-lighting.ts';
import {
  cellArrival,
  doorDestination,
  loadCellData,
  referenceMatrix,
  type CellData,
  type CellObject,
  type DoorDestination,
  type Teleport,
} from '../world/cell-loader.ts';
import {
  enabledReferences,
  findToggles,
  gameStartSelection,
  type CellToggle,
} from '../world/cell-upgrades.ts';
import { CELL_SIZE, LAND_GRID, type LandData } from '../world/land.ts';
import {
  cellNavmeshes,
  NAVMESH_TOLERANCE,
  NavmeshSurface,
  NEAREST_TOLERANCE,
} from '../world/navmesh.ts';
import { cellWater } from '../world/water.ts';
import { surfaceOver, waterVolumes, type WaterVolume } from '../world/water-volumes.ts';
import { weatherRegionAt } from '../world/sky-weather.ts';
import { parseClimate } from '../world/weather.ts';
import { cellKey, WorldFlag, type Arrival, type Worldspace } from '../world/worldspace.ts';
import { HeadlessRender } from './headless-render.ts';
import { HeadlessVoices } from './headless-voices.ts';
import { placeObject, type PlacedObject } from './placed-objects.ts';
import { SimLog, SimTerminal } from './sim-log.ts';
import { VirtualClock } from './virtual-clock.ts';

/** The simulation's fixed step (seconds): the game's 60 frames a second. */
export const SIM_STEP = 1 / 60;
/** A step's settling waits at most this many rounds of the event loop for its work. */
const SETTLE_ROUNDS = 10_000;
/** Exterior cells loaded around the player's: uGridsToLoad 5 loads two on each side. */
const DEFAULT_GRID_RADIUS = 2;
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

export interface SimOptions {
  readonly vfs: Vfs;
  /** The new game runs its opening (Unbound); without, it starts as the main menu's coc does. */
  readonly opening?: boolean;
  /** The seed of the simulation's dice (Math.random while it runs). */
  readonly seed?: number;
  /** Exterior cells loaded on each side of the player's (default 2: uGridsToLoad 5). */
  readonly gridRadius?: number;
  /**
   * The game folder's reads in flight: a step waits for the reads its work started, so that
   * every run loads what it loads in the same step (without, a load may land a step later).
   */
  readonly reads?: SimReads;
}

/** The game folder's reads, as a step settles them (tools/node-game-folder.ts). */
export interface SimReads {
  readonly pending: number;
  /** Holds the results of the reads asked from now on (true), or lets them all through. */
  hold(holding: boolean): void;
  /** Lets the earliest held read's result through, once it is read; false if none is held. */
  deliverNext(): Promise<boolean>;
  /** Resolves once a read is held. */
  whenHeld(): Promise<void>;
}

/** A loaded cell of the simulation. */
interface SimCell {
  /** The actor stage's key: an interior's form id, an exterior cell's grid "x,y". */
  readonly key: string;
  readonly formId: number;
  readonly grid: readonly [number, number] | undefined;
  readonly data: CellData;
  /** Its objects (a cart its horse pulls is the vehicles') and their collision. */
  readonly objects: readonly {
    readonly object: CellObject;
    readonly collision: CollisionData | undefined;
  }[];
  readonly toggles: readonly CellToggle[];
  isEnabled: (reference: number) => boolean;
  readonly placed: readonly PlacedObject[];
  readonly byReference: ReadonlyMap<number, PlacedObject>;
  readonly visibility: Map<number, InstanceVisibility>;
  readonly enabledNow: Map<number, boolean>;
  readonly collision: CollisionGroup;
  collided: boolean;
  readonly navmesh: NavmeshSurface;
  readonly ragdolls: readonly CellRagdoll[];
  readonly objectSkeletons: readonly { reference: number; skeleton: AnimatedSkeleton }[];
  skeletons: readonly AnimatedSkeleton[];
  readonly allWaterVolumes: readonly { reference: number; volumes: WaterVolume[] }[];
  waterVolumes: readonly WaterVolume[];
  readonly waterHeight: number | undefined;
  readonly waterType: number | undefined;
  readonly land: LandData | undefined;
  scriptsAttached: boolean;
}

/** Where the simulation is: an interior cell, or a worldspace streamed around the player. */
type SimPlace =
  | { readonly kind: 'interior'; readonly cell: number }
  | { readonly kind: 'exterior'; readonly world: Worldspace; readonly radius: number };

/** A message for an unexpected failure. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The browser's next task (a message to ourselves): lets ready I/O and timers run. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

export class SimWorld {
  readonly session: GameSession;
  readonly runtime: ScriptRuntime;
  /** What happened (see sim-log.ts). */
  readonly log: SimLog;
  /** The engine's log lines. */
  readonly terminal: SimTerminal;
  readonly clock: VirtualClock;
  /** The actor stages: one for interiors, one for exteriors (their detection differs). */
  readonly #stages: { interior?: ActorStage; exterior?: ActorStage } = {};
  #stage: ActorStage;
  readonly #gridRadius: number;
  readonly #reads: SimReads | undefined;
  /** Seconds the simulation has run (the renderer's clock in the page). */
  #time = 0;
  #place: SimPlace | undefined;
  readonly #cells = new Map<string, SimCell>();
  /** Exterior cells being loaded, by key. */
  readonly #loading = new Map<string, Promise<void>>();
  #play: PlaySession | undefined;
  #avatar: PlayerAvatar | undefined;
  #seat: PlayerFurniture | undefined;
  #playerIdle: { readonly idle: number; readonly target: number | undefined } | undefined;
  readonly #created: CreatedObjects;
  readonly #flora: FloraLooks;
  readonly #destruction: DestructionLooks;
  readonly #destinations = new Map<number, DoorDestination | undefined>();
  /** Travel through a load door started by an activation (awaited by the next step). */
  #travel: Promise<void> | undefined;
  /** Work started by the world that the next settle waits for (cells, created objects). */
  readonly #pending = new Set<Promise<unknown>>();

  private constructor(
    session: GameSession,
    runtime: ScriptRuntime,
    log: SimLog,
    terminal: SimTerminal,
    clock: VirtualClock,
    gridRadius: number,
    reads: SimReads | undefined,
  ) {
    this.#reads = reads;
    this.session = session;
    this.runtime = runtime;
    this.log = log;
    this.terminal = terminal;
    this.clock = clock;
    this.#gridRadius = gridRadius;
    log.clock = () => this.#time;
    const render = session.render;
    this.#created = new CreatedObjects(session, render);
    this.#flora = new FloraLooks(session, render);
    this.#destruction = new DestructionLooks(
      session,
      render,
      () => this.#play,
      (message) => {
        terminal.log('world', message, 'warn');
      },
    );
    this.#stage = this.#stageFor('interior');
    session.scriptWorld.attach(this.#scriptView);
  }

  /** The actors of the loaded area. */
  get stage(): ActorStage {
    return this.#stage;
  }

  /** The stage for interiors or exteriors, made once (as each viewer has its own). */
  #stageFor(kind: 'interior' | 'exterior'): ActorStage {
    let stage = this.#stages[kind];
    if (!stage) {
      stage = new ActorStage({
        session: this.session,
        renderer: this.session.render,
        terminal: this.terminal,
        seat: () => this.#seat,
        sounding: this.#sounding,
        focus: () => this.#play?.player.feet,
        onTrigger: (trigger, actor, entered) => {
          this.runtime.triggered(trigger, actor, entered);
        },
        cellOf: (at) => this.#stageCellOf(at),
        collided: (key) => this.#cells.get(key)?.collided,
        navmeshes: () => this.#navmeshes,
        objects: () => this.#stageObjects(),
        door: (reference) => this.#doorOf(reference),
        interior: kind === 'interior',
        light: (at) => this.#lightProbe(at),
        player: () => this.playerView,
      });
      this.#stages[kind] = stage;
    }
    return stage;
  }

  /**
   * Starts a new game headless: the session over the game data, its scripts' new game, the
   * recording ports. The virtual clock replaces the page's clock and dice from here on (until
   * `dispose`).
   */
  static async create(options: SimOptions): Promise<SimWorld> {
    const clock = new VirtualClock(options.seed ?? 1);
    clock.install();
    const terminal = new SimTerminal();
    const log = new SimLog();
    const voices = new HeadlessVoices(options.vfs);
    voices.onLine = (file, place) => {
      log.voice(file, place);
    };
    const session = new GameSession(options.vfs, terminal, {
      render: new HeadlessRender(),
      workers: false,
      voices,
      storage: null,
    });
    // The game's HUD and menus listen (as in Play): notifications go to the HUD.
    log.attachSession(session);
    const runtime = await session.runtime(options.opening ?? false);
    log.attachRuntime(runtime);
    return new SimWorld(
      session,
      runtime,
      log,
      terminal,
      clock,
      options.gridRadius ?? DEFAULT_GRID_RADIUS,
      options.reads,
    );
  }

  /** Seconds the simulation has run. */
  get time(): number {
    return this.#time;
  }

  /** The player's physics world and controls (undefined until a place is opened). */
  get play(): PlaySession | undefined {
    return this.#play;
  }

  get player(): Player {
    const play = this.#play;
    if (!play) throw new Error('No place is open: open an interior or an exterior first');
    return play.player;
  }

  get playerView(): PlayerView | undefined {
    const play = this.#play;
    return play && { play, avatar: this.#avatar };
  }

  /** The loaded cells' keys (an interior's form id, exterior cells' "x,y"). */
  get loadedCells(): string[] {
    return [...this.#cells.keys()];
  }

  /** A loaded cell's form id by the stage's key. */
  cellFormId(key: string): number | undefined {
    return this.#cells.get(key)?.formId;
  }

  /** The placed object of a loaded cell by its reference (its instance, its open sequence). */
  placed(reference: number): PlacedObject | undefined {
    for (const cell of this.#cells.values()) {
      const placed = cell.byReference.get(reference);
      if (placed) return placed;
    }
    return undefined;
  }

  // --- Opening places ---------------------------------------------------------------------

  /** Opens an interior cell, the player arriving as through its door (or at `arrival`). */
  async openInterior(formId: number, arrival?: Arrival): Promise<void> {
    this.#close();
    const db = await this.session.db;
    this.#place = { kind: 'interior', cell: formId };
    this.#stage = this.#stageFor('interior');
    const cell = await this.#loadCell(formId, String(formId), undefined, undefined);
    const comeIn = arrival ?? (await cellArrival(db, cell.data));
    const feet = comeIn?.position ?? cell.data.entrance;
    await this.#startPlay([...feet], comeIn?.heading ?? 0, comeIn !== undefined, 64);
    this.#addCollision(cell);
    this.#refreshCell(cell);
    this.session.sky.setPlace({ interior: true, cellFlags: cell.data.cell.flags });
    const region =
      cell.data.cell.skyRegion === undefined
        ? undefined
        : await this.session.weatherRegion(cell.data.cell.skyRegion);
    this.session.sky.enterInterior(
      region && { formId: region.formId, weathers: region.weather?.weathers ?? [] },
    );
    await this.#attachToScripts(cell);
    await this.settle();
  }

  /**
   * Opens a worldspace with the player at `arrival`, or as the game brings them in near a cell
   * (in front of the nearest load door, else at the nearest map marker); the cells around them
   * load as they move, the sky takes the climate and the weather regions they walk into.
   * TODO(sim): the sky's light outdoors (src/shell/world-sky.ts makes it with the sky's draws and
   * panel): headless exteriors have no daylight for detection yet, nor player regions.
   */
  async openExterior(
    formId: number,
    at: { readonly cell: readonly [number, number] } | { readonly arrival: Arrival },
  ): Promise<void> {
    this.#close();
    const world = await this.session.worldspace(formId);
    this.#place = { kind: 'exterior', world, radius: this.#gridRadius };
    this.#stage = this.#stageFor('exterior');
    let comeIn: Arrival | undefined;
    let feet: [number, number, number];
    if ('arrival' in at) {
      comeIn = at.arrival;
      feet = [...at.arrival.position];
    } else {
      const [x, y] = at.cell;
      comeIn = await world.arrivalNear((x + 0.5) * CELL_SIZE, (y + 0.5) * CELL_SIZE);
      const land = comeIn ? undefined : await world.land(x, y);
      const middle = Math.floor(LAND_GRID / 2);
      const ground = land?.heights[middle * LAND_GRID + middle];
      feet = comeIn
        ? [...comeIn.position]
        : [
            (x + 0.5) * CELL_SIZE,
            (y + 0.5) * CELL_SIZE,
            ground ?? world.landWorld.defaultLandHeight,
          ];
    }
    // The sky's climate is the worldspace's; the place is outside (as src/shell/world-sky.ts).
    const db = await this.session.db;
    const climateId = world.climateWorld.climate;
    const climateRecord = climateId === undefined ? undefined : await db.get(climateId);
    const climate = climateRecord ? parseClimate(climateRecord) : undefined;
    await this.session.weathers();
    if (climate) await this.session.weatherGlobals(climate.weathers);
    this.session.sky.setClimate(climate);
    this.session.sky.setPlace({
      interior: false,
      lightingTemplate: world.record.lightingTemplate !== undefined,
      noSky: (world.record.flags & WorldFlag.noSky) !== 0,
    });
    await this.#startPlay(feet, comeIn?.heading ?? 0, comeIn !== undefined, comeIn ? 64 : 8192);
    await this.#stream();
    await this.settle();
  }

  /** Goes through a load door to where it leads (as the player's activation of it does). */
  async travel(teleport: Teleport): Promise<void> {
    const db = await this.session.db;
    const destination = await doorDestination(db, teleport);
    if (!destination) return;
    const arrival: Arrival = { position: teleport.position, heading: teleport.rotation[2] };
    if (destination.world === undefined) await this.openInterior(destination.cell, arrival);
    else await this.openExterior(destination.world, { arrival });
  }

  // --- Stepping ---------------------------------------------------------------------------

  /**
   * One fixed step of the game's frame, in the page's order: the player and the physics, the
   * game clock and the sky, the player's body, the actors (AI, senses, combat, magic, movers,
   * graphs), the objects' graphs, then the scripts' clocks. Waits for the work the step
   * started (scripts run until they wait, cells and actors finish loading).
   */
  async step(seconds = SIM_STEP): Promise<void> {
    const session = this.session;
    const play = this.#play;
    // The game's clock stands still in menus; Slow Time runs it slower (main.ts's frame clock).
    const frame = session.menuMode ? 0 : seconds * session.time.multiplier;
    this.clock.advance(seconds);
    this.#time += frame;
    play?.view.update(frame);
    if (!session.menuMode && !session.loading) {
      session.advanceClock((frame * session.clockRate) / 3600);
    }
    if (this.#place) session.sky.frame();
    session.updateEmittance(session.gameHour);
    // The player animates at their own pace in slowed time.
    this.#avatar?.update(this.#time * session.time.playerPace);
    if (this.#avatar) this.#seat?.frame(this.#avatar.stepped);
    this.stage.animate(this.#time);
    for (const cell of this.#cells.values()) animateSkeletons(cell.skeletons, this.#time);
    session.tickScripts(seconds);
    if (this.#place?.kind === 'exterior') this.#track(this.#stream());
    if (this.#travel) {
      const travel = this.#travel;
      this.#travel = undefined;
      await travel;
    }
    await this.settle();
  }

  /** Steps the world `seconds` at the fixed step. */
  async run(seconds: number, step = SIM_STEP): Promise<void> {
    const steps = Math.round(seconds / step);
    for (let i = 0; i < steps; i++) await this.step(step);
  }

  /** Steps until `done` holds (true) or `seconds` have passed (false). */
  async until(done: () => boolean, seconds: number, step = SIM_STEP): Promise<boolean> {
    const steps = Math.round(seconds / step);
    for (let i = 0; i < steps; i++) {
      if (done()) return true;
      await this.step(step);
    }
    return done();
  }

  /**
   * Waits for what the world started: the scripts' running threads (until they wait), the
   * story manager's events, the cells and objects being placed, and the tasks they queued.
   */
  async settle(): Promise<void> {
    const reads = this.#reads;
    // Reads asked while settling come back one at a time, in the order asked (SimReads).
    reads?.hold(true);
    try {
      for (let round = 0; round < SETTLE_ROUNDS; round++) {
        // The timers the step's clock reached (waits that end now).
        this.clock.runDue();
        await nextTask();
        await this.#awaitReading(this.runtime.vm.idle());
        // The story manager works through the events raised (quests start, their aliases fill).
        await this.#awaitReading(this.runtime.storyManager.idle());
        await this.#awaitReading(this.runtime.vm.idle());
        if (reads && (await this.#deliver(reads))) continue;
        if (this.#pending.size > 0) {
          await this.#awaitReading(Promise.all([...this.#pending]));
          continue;
        }
        if ((reads?.pending ?? 0) === 0 && !this.clock.due) break;
      }
    } finally {
      reads?.hold(false);
    }
    await nextTask();
  }

  /**
   * Waits for work that may wait on reads, handing the held reads out while it waits: each in a
   * task of its own, once everything else has run, so the disk's timing never decides what runs
   * before what.
   */
  async #awaitReading(work: Promise<unknown>): Promise<void> {
    const reads = this.#reads;
    if (!reads) {
      await work;
      return;
    }
    const done = work.then(() => true);
    for (;;) {
      if (await Promise.race([done, reads.whenHeld().then(() => false)])) return;
      await this.#deliver(reads);
    }
  }

  /** Hands out the earliest held read, then lets what waited on it run; false if none is held. */
  async #deliver(reads: SimReads): Promise<boolean> {
    if (!(await reads.deliverNext())) return false;
    await nextTask();
    return true;
  }

  #track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.terminal.log('sim', describe(error), 'warn');
    });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  // --- The player's actions ---------------------------------------------------------------

  /**
   * The player activates a reference, as through the crosshair: the scripts' OnActivate (unless
   * one blocks it) and the default (a door opens, a load door travels, an item is taken, an
   * actor is talked to). False if it cannot be activated.
   */
  activate(reference: number): boolean {
    const target = this.#activatable(reference) ?? this.#actorActivation(reference);
    if (!target) return false;
    target.activate();
    return true;
  }

  /** Puts the player somewhere (they wait for the ground there, then stand on it). */
  teleportPlayer(feet: Vec3, yaw = this.player.yaw): void {
    this.#play?.placePlayer(feet, yaw);
  }

  /** Presses (or releases) one of the player's user events ("Forward", "Activate", ...). */
  press(event: string, down: boolean): void {
    this.player.press(event, down);
  }

  /** Turns the player to look along a heading (radians about z, 0: north) and pitch. */
  look(yaw: number, pitch = 0): void {
    const player = this.player;
    player.yaw = yaw;
    player.pitch = pitch;
  }

  /** Releases the world: the physics, the virtual clock (the page's clock and dice return). */
  dispose(): void {
    this.#close();
    this.clock.restore();
  }

  // --- Loading cells ----------------------------------------------------------------------

  /** Loads a cell's references: objects placed, actors staged (collision is added later). */
  async #loadCell(
    formId: number,
    key: string,
    grid: readonly [number, number] | undefined,
    world: Worldspace | undefined,
  ): Promise<SimCell> {
    const session = this.session;
    const db = await session.db;
    const persistent = grid && world ? world.persistentReferences(grid[0], grid[1]) : [];
    // It resets if its time has come, before its references load (cell-reset.ts).
    await this.runtime.cellResets.attaching(formId, persistent);
    const data = await loadCellData(db, formId, persistent);
    for (const skipped of data.skipped) this.terminal.log('cell', skipped, 'warn');
    const toggles = findToggles(data);
    const isEnabled = this.#enableState(formId, data, toggles);
    // The cell's enable state as it is now (refreshed once the cell is in).
    const enabledNow = (reference: number): boolean =>
      (this.#cells.get(key)?.isEnabled ?? isEnabled)(reference);
    const visibility = new Map<number, InstanceVisibility>();
    const shownBy = (reference: number): InstanceVisibility => {
      let entry = visibility.get(reference);
      if (!entry) {
        entry = { hidden: !isEnabled(reference) };
        visibility.set(reference, entry);
      }
      return entry;
    };
    // A cart its horse pulls is not its cell's any more (src/shell/actor-vehicles.ts).
    // Where the game left them (moved-objects.ts).
    const objects = placedAsMoved(
      data.objects.filter((object) => !this.stage.vehicles.owns(object.reference)),
      this.runtime.state,
      formId,
    );
    const [models, collisions] = await Promise.all([
      Promise.all(objects.map((object) => session.model(object.model))),
      Promise.all(objects.map((object) => session.collision(object.model))),
    ]);
    const placed: PlacedObject[] = [];
    objects.forEach((object, i) => {
      const model = models[i];
      if (!model) return;
      const entry = placeObject(
        session,
        object,
        { model, collision: collisions[i] },
        { simulated: true, visibility: shownBy(object.reference) },
      );
      placed.push(entry);
      this.#flora.add(object, entry.instance.world, shownBy(object.reference), () =>
        enabledNow(object.reference),
      );
      this.#destruction.add(object, entry.instance.world, shownBy(object.reference), () =>
        enabledNow(object.reference),
      );
    });
    const ragdolls = await this.stage.attachCell(key, data.actors, enabledNow);
    const land = grid && world ? await world.land(grid[0], grid[1]) : undefined;
    const water =
      world &&
      cellWater(data.cell, { height: world.defaultWaterHeight, type: world.waterWorld.water });
    const byReference = new Map<number, PlacedObject>();
    for (const entry of placed) {
      if (!byReference.has(entry.object.reference)) byReference.set(entry.object.reference, entry);
    }
    const cell: SimCell = {
      key,
      formId,
      grid,
      data,
      objects: objects.map((object, i) => ({ object, collision: collisions[i] })),
      toggles,
      isEnabled,
      placed,
      byReference,
      visibility,
      enabledNow: new Map(),
      collision: collisionGroup(),
      collided: false,
      navmesh: new NavmeshSurface(await cellNavmeshes(db, formId)),
      ragdolls,
      objectSkeletons: placed.flatMap(({ object, skeleton }) =>
        skeleton ? [{ reference: object.reference, skeleton }] : [],
      ),
      skeletons: [],
      allWaterVolumes: objects.flatMap((object, i) =>
        object.water === undefined
          ? []
          : [
              {
                reference: object.reference,
                volumes: waterVolumes(collisions[i], object.world, object.water),
              },
            ],
      ),
      waterVolumes: [],
      waterHeight: water?.height,
      waterType: water ? water.type : undefined,
      land,
      scriptsAttached: false,
    };
    this.#cells.set(key, cell);
    for (const object of objects) {
      if (object.teleport && !this.#destinations.has(object.teleport.door)) {
        this.#destinations.set(object.teleport.door, await doorDestination(db, object.teleport));
      }
    }
    return cell;
  }

  /** A cell's collision goes into the physics world (its actors stand on it once it is in). */
  #addCollision(cell: SimCell): void {
    const play = this.#play;
    if (!play) return;
    const entries = new Map(cell.placed.map((entry) => [entry.object, entry]));
    cell.collided = false;
    play.add(cell.collision, {
      ...(cell.land &&
        cell.grid && { land: { data: cell.land, x: cell.grid[0], y: cell.grid[1] } }),
      whenComplete: () => {
        cell.collided = true;
        this.stage.ground(cell.key, play.physics);
      },
      objects: cell.objects.map(({ object, collision }) => {
        const entry = entries.get(object);
        return {
          object,
          collision,
          instance: entry?.instance,
          ...(entry?.articulated && { articulated: entry.articulated }),
        };
      }),
      primitives: cell.data.primitives,
      ragdolls: cell.ragdolls,
      isEnabled: (reference) => cell.isEnabled(reference),
    });
  }

  /** A cell's enable state: the running game's scripts', else as a new game has it. */
  #enableState(
    formId: number,
    data: CellData,
    toggles: readonly CellToggle[],
  ): (reference: number) => boolean {
    return enabledReferences(
      data,
      toggles,
      this.session.cellSelections.get(formId) ?? gameStartSelection(toggles),
      this.session.scriptedEnables(),
    );
  }

  /** Applies a cell's enable state: what collides, animates and holds water. */
  #refreshCell(cell: SimCell): void {
    const isEnabled = this.#enableState(cell.formId, cell.data, cell.toggles);
    cell.isEnabled = isEnabled;
    for (const [reference, entry] of cell.visibility) entry.hidden = !isEnabled(reference);
    const references = [
      ...cell.data.objects.map((object) => object.reference),
      ...cell.data.primitives.map((primitive) => primitive.reference),
      ...cell.data.actors.map((actor) => actor.reference),
    ];
    for (const reference of references) {
      const enabled = isEnabled(reference);
      const before = cell.enabledNow.get(reference);
      cell.enabledNow.set(reference, enabled);
      if (before !== undefined && before !== enabled) {
        this.#play?.setReferenceEnabled(reference, enabled);
      }
    }
    cell.skeletons = cell.objectSkeletons
      .filter((entry) => isEnabled(entry.reference))
      .map((entry) => entry.skeleton);
    cell.waterVolumes = cell.allWaterVolumes
      .filter((entry) => isEnabled(entry.reference))
      .flatMap((entry) => entry.volumes);
    this.stage.refresh();
  }

  /** A loaded cell's references meet the running game's scripts (their cell and 3D events). */
  async #attachToScripts(cell: SimCell): Promise<void> {
    if (cell.scriptsAttached) return;
    cell.scriptsAttached = true;
    const runtime = this.runtime;
    this.#refreshCell(cell);
    const loaded = new Set(this.#cellLoadedReferences(cell));
    await runtime.cellAttached(
      [
        ...cell.data.objects.map((object) => object.reference),
        ...cell.data.primitives.map((primitive) => primitive.reference),
        ...this.stage.referencesIn(cell.key),
      ],
      (reference) => loaded.has(reference),
    );
    for (const [reference, state] of runtime.state.references) {
      if (!runtime.state.created.has(reference)) continue;
      if (
        state.position &&
        this.#stageCellOf({ position: state.position, cell: state.cell }) === cell.key
      )
        await this.#showCreated(reference);
    }
  }

  /** Loads the exterior cells around the player and frees those far away. */
  async #stream(): Promise<void> {
    const place = this.#place;
    const play = this.#play;
    if (place?.kind !== 'exterior' || !play) return;
    const [px, py] = play.player.feet;
    const cx = Math.floor(px / CELL_SIZE);
    const cy = Math.floor(py / CELL_SIZE);
    await this.#enterRegion(place.world, cx, cy, px, py);
    for (const [key, cell] of this.#cells) {
      const grid = cell.grid;
      if (grid && Math.max(Math.abs(grid[0] - cx), Math.abs(grid[1] - cy)) > place.radius + 1) {
        this.#free(cell);
        this.#cells.delete(key);
      }
    }
    const loads: Promise<void>[] = [];
    for (let dy = -place.radius; dy <= place.radius; dy++) {
      for (let dx = -place.radius; dx <= place.radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const key = cellKey(x, y);
        if (this.#cells.has(key)) continue;
        let loading = this.#loading.get(key);
        if (!loading) {
          loading = this.#loadExterior(place.world, x, y, key).finally(() => {
            this.#loading.delete(key);
          });
          this.#loading.set(key, loading);
        }
        loads.push(loading);
      }
    }
    await Promise.all(loads);
  }

  /** The exterior cell the player entered last (its weather region was looked up). */
  #regionCell: string | undefined;

  /**
   * The player entered a cell: the sky learns the weather region there, chosen among the cell's
   * regions by where the player stands (as src/shell/world-sky.ts on the change of cell).
   */
  async #enterRegion(
    world: Worldspace,
    x: number,
    y: number,
    px: number,
    py: number,
  ): Promise<void> {
    const key = cellKey(x, y);
    if (key === this.#regionCell) return;
    this.#regionCell = key;
    const ids = await world.regions(x, y);
    const regions = await Promise.all(ids.map((id) => this.session.weatherRegion(id)));
    if (key !== this.#regionCell) return;
    const region = weatherRegionAt(regions, world.record.formId, px, py);
    this.session.sky.enterExterior(
      region && { formId: region.formId, weathers: region.weather?.weathers ?? [] },
    );
  }

  async #loadExterior(world: Worldspace, x: number, y: number, key: string): Promise<void> {
    const formId = await world.cell(x, y);
    // No cell record: nothing is there.
    if (formId === undefined || this.#place?.kind !== 'exterior') return;
    const cell = await this.#loadCell(formId, key, [x, y], world);
    if (this.#cells.get(key) !== cell) return;
    this.#addCollision(cell);
    this.#refreshCell(cell);
    await this.#attachToScripts(cell);
  }

  /** A cell goes: its scripts hear it detach, its actors and collision leave. */
  #free(cell: SimCell): void {
    const loaded = new Set(this.#cellLoadedReferences(cell));
    // Its moved objects keep their places; its reset waits from now (cell-reset.ts).
    noteMoved(cell.placed, this.runtime.state);
    this.runtime.detach(this.runtime.cellResets.detached(cell.formId));
    this.runtime.detach(
      this.runtime.cellDetached(
        [
          ...cell.data.objects.map((object) => object.reference),
          ...this.stage.referencesIn(cell.key),
        ],
        (reference) => loaded.has(reference),
      ),
    );
    this.stage.detachCell(cell.key);
    this.#play?.remove(cell.collision);
  }

  /** Leaves the place open now: its cells, the play and the player's body. */
  #close(): void {
    for (const cell of this.#cells.values()) this.#free(cell);
    this.#cells.clear();
    this.stage.clear();
    this.#created.clear(this.#play);
    this.#flora.clear();
    this.#destruction.clear();
    this.#avatar?.destroy();
    this.#avatar = undefined;
    this.#seat = undefined;
    this.#playerIdle = undefined;
    this.stage.combat.attachPlayer(undefined, undefined);
    this.stage.attachPlay(undefined);
    this.#play?.dispose();
    this.#play = undefined;
    this.#place = undefined;
    this.#regionCell = undefined;
  }

  // --- The player -------------------------------------------------------------------------

  /** The player in a new physics world, standing at `feet` once the ground there is in. */
  async #startPlay(
    feet: [number, number, number],
    yaw: number,
    onFloor: boolean,
    searchAbove: number,
  ): Promise<void> {
    const session = this.session;
    const [matrix, playerData] = await Promise.all([
      session.collisionMatrix(),
      session.playerData(),
      initPhysics(),
    ]);
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
    player.povSwitchAllowed = () => this.runtime.controls.camSwitch;
    player.character.walkable = (x, y, z) =>
      this.#cellAt([x, y, z])?.navmesh.heightNear(x, y, z, NAVMESH_TOLERANCE) !== undefined;
    player.overEncumbered = () => session.overEncumbered;
    connectPlayerTime(player, () => session);
    player.canSprint = () => this.runtime.progression.canSprint(PLAYER_REF);
    player.onSprintRefused = () => {
      this.runtime.progression.refused(PLAYER_REF, 'stamina');
    };
    player.onAction = (subtype) => {
      void this.stage.talk.playerAction(subtype);
    };
    const play = new PlaySession({
      physics,
      player,
      camera: new FlyCamera(),
      groundReady: (at) => this.#groundReady(at),
      searchAbove,
      arrivesOnFloor: onFloor,
      activatable: (reference) => this.#activatable(reference),
      actorAt: talkTargets(
        () => this.stage.shown(),
        () => session,
        this.terminal,
        (placed) => this.stage.mounts.activation(placed),
      ),
      perks: perkActivation(() => this.runtime),
      hud: session.hud,
      // TODO(sim): headless there is no sound system: an impact's sound (and the noise the
      // actors hear from it) is not decided; the sound system's choice of a descriptor, its
      // conditions, the ambience and the music run only in the page.
      onImpact: (impact) => {
        session.soundSystem?.impact(impact, (sounded) => {
          this.stage.senses.noise(impact.position, undefined, sounded.soundLevel);
        });
      },
    });
    this.#play = play;
    this.stage.attachPlay(play);
    play.onTrigger = (reference, entered) => {
      this.runtime.triggered(reference, PLAYER_REF, entered);
    };
    play.onTrapTouch = (touching) => {
      this.runtime.trapHits.touching(PLAYER_REF, touching);
    };
    play.onGrab = (reference, grabbed) => {
      this.runtime.events.emit('grabRelease', { reference, grabbed });
    };
    // The player's body: their graphs (third and first person) run as an actor's do.
    try {
      const avatar = await PlayerAvatar.create(session, session.render, player, this.#sounding);
      if (this.#play !== play) {
        avatar?.destroy();
        return;
      }
      this.#avatar = avatar;
      if (avatar) {
        avatar.onGraphEvents = (events, firstPerson) => {
          this.stage.graphEvents.player(avatar, events, firstPerson);
        };
        this.#seat = new PlayerFurniture({
          furniture: this.stage.furniture,
          play,
          avatar,
          hasKeyword: (reference, keyword) => this.runtime.hasKeyword(reference, keyword),
          menuOpen: () => session.menuMode,
        });
        const pending = this.#playerIdle;
        this.#playerIdle = undefined;
        if (pending)
          void this.stage.furniture.playIdle(this.#seat.user, pending.idle, pending.target);
      }
      this.stage.combat.attachPlayer(play, avatar);
    } catch (error) {
      this.terminal.log('actor', `player: ${describe(error)}`, 'warn');
    }
  }

  /** Whether the collision around a point is in place (the player can be set down there). */
  #groundReady(feet: Vec3): boolean {
    const place = this.#place;
    if (place?.kind !== 'exterior') {
      const cell = [...this.#cells.values()][0];
      return cell?.collision.ready === true;
    }
    const cx = Math.floor(feet[0] / CELL_SIZE);
    const cy = Math.floor(feet[1] / CELL_SIZE);
    for (const [dx, dy] of NEIGHBOURHOOD) {
      const key = cellKey(cx + dx, cy + dy);
      const cell = this.#cells.get(key);
      if (!cell) {
        if ((dx === 0 && dy === 0) || this.#loading.has(key)) return false;
        continue;
      }
      if (!cell.collision.ready) return false;
    }
    return true;
  }

  // --- What the world's systems ask of the loaded area ---------------------------------------

  /** The loaded cell a point is in. */
  #cellAt(at: Vec3): SimCell | undefined {
    if (this.#place?.kind !== 'exterior') return [...this.#cells.values()][0];
    return this.#cells.get(cellKey(Math.floor(at[0] / CELL_SIZE), Math.floor(at[1] / CELL_SIZE)));
  }

  /** The stage's key of a place, if the simulation holds it. */
  #stageCellOf(at: StagePlace): string | undefined {
    const place = this.#place;
    if (!place) return undefined;
    if (place.kind === 'interior') {
      return at.cell !== undefined && at.cell === place.cell ? String(at.cell) : undefined;
    }
    if (at.world !== undefined && at.world !== place.world.record.formId) return undefined;
    if (at.world === undefined && at.cell !== undefined) return undefined;
    return cellKey(Math.floor(at.position[0] / CELL_SIZE), Math.floor(at.position[1] / CELL_SIZE));
  }

  readonly #navmeshes: NavmeshSet = {
    navmesh: (formId) => {
      for (const cell of this.#cells.values()) {
        for (const mesh of cell.navmesh.meshes) if (mesh.formId === formId) return mesh;
      }
      return undefined;
    },
    locate: ([x, y, z]) => {
      for (const cell of this.#nearCells([x, y, z])) {
        const found = cell.navmesh.near(x, y, z, NAVMESH_TOLERANCE);
        if (found) return found;
      }
      return undefined;
    },
    nearest: ([x, y, z], reach) => {
      let best: { point: [number, number, number]; distance: number } | undefined;
      for (const cell of this.#nearCells([x, y, z])) {
        const found = cell.navmesh.nearest(x, y, z, reach, NEAREST_TOLERANCE);
        if (found && (!best || found.distance < best.distance)) best = found;
      }
      return best?.point;
    },
  };

  /** The cell of a point and its neighbours (exteriors), the interior's cell. */
  *#nearCells(at: Vec3): Iterable<SimCell> {
    if (this.#place?.kind !== 'exterior') {
      yield* this.#cells.values();
      return;
    }
    const cx = Math.floor(at[0] / CELL_SIZE);
    const cy = Math.floor(at[1] / CELL_SIZE);
    for (const [dx, dy] of NEIGHBOURHOOD) {
      const cell = this.#cells.get(cellKey(cx + dx, cy + dy));
      if (cell) yield cell;
    }
  }

  #doorOf(reference: number): DoorObject | undefined {
    const placed = this.placed(reference);
    return placed && { object: placed.object, instance: placed.instance };
  }

  *#stageObjects(): Iterable<StageObject> {
    for (const cell of this.#cells.values()) {
      for (const object of cell.data.objects) {
        if (cell.isEnabled(object.reference)) yield stageObject(object);
      }
      for (const marker of cell.data.markers) if (cell.isEnabled(marker.reference)) yield marker;
    }
    for (const entry of this.#created.all) {
      if (!entry.visibility.hidden) yield stageObject(entry.object);
    }
  }

  /** The water a point is in or over: a water activator's volume, an exterior cell's water. */
  #waterAt(x: number, y: number, z: number): { height: number; type: number } | undefined {
    const cell = this.#cellAt([x, y, z]);
    if (!cell) return undefined;
    const volume = surfaceOver(cell.waterVolumes, x, y, z);
    if (volume) return volume;
    return cell.waterHeight === undefined || cell.waterType === undefined
      ? undefined
      : { height: cell.waterHeight, type: cell.waterType };
  }

  /**
   * The light near a place (detection): an interior's own lighting and lights. Outdoors none
   * yet (see openExterior).
   */
  #lightProbe(at: Vec3): LightProbe | undefined {
    const cell = this.#cellAt(at);
    if (!cell || this.#place?.kind !== 'interior') return undefined;
    const lighting = cellSceneLighting(cell.data, cell.isEnabled);
    return {
      ambient: lighting.ambient,
      sunColor: lighting.sunColor,
      sunDirection: lighting.sunDirection,
      lights: pointLights(
        [
          ...cell.data.lights.filter((light) => cell.isEnabled(light.reference)),
          ...this.#created.lights(),
          ...this.stage.lights(),
        ],
        objectClock(),
        at,
        (id) => this.session.emittance(id).rgb,
      ),
      interior: true,
    };
  }

  /** What actors' animations sound with: the recorded output, the play's collision. */
  readonly #sounding: SoundingWorld = {
    sounds: () => this.log.actorSounds,
    ground: (at, exclude) => groundUnder(this.#play?.physics, at, exclude),
    water: (at) => this.#waterAt(at[0], at[1], at[2]),
  };

  #cellLoadedReferences(cell: SimCell): number[] {
    return [
      ...cell.placed
        .map(({ object }) => object.reference)
        .filter((reference) => cell.isEnabled(reference)),
      ...cell.data.markers
        .map((marker) => marker.reference)
        .filter((reference) => cell.isEnabled(reference)),
      ...this.stage.shownIn(cell.key).map((actor) => actor.actor.reference),
      ...[...this.#created.all]
        .filter(
          (entry) => !entry.visibility.hidden && this.#cellOfWorld(entry.object.world) === cell,
        )
        .map((entry) => entry.reference),
    ];
  }

  #cellOfWorld(world: Float32Array): SimCell | undefined {
    return this.#cellAt([world[12] ?? 0, world[13] ?? 0, world[14] ?? 0]);
  }

  #loaded(reference: number): boolean {
    for (const cell of this.#cells.values()) {
      if (
        (cell.byReference.has(reference) ||
          cell.data.markers.some((marker) => marker.reference === reference)) &&
        cell.isEnabled(reference)
      ) {
        return true;
      }
    }
    const staged = this.stage.get(reference);
    if (staged && !staged.visibility.hidden) return true;
    const created = this.#created.get(reference);
    return created !== undefined && !created.visibility.hidden;
  }

  /** A reference the scripts created: placed if it stands in a loaded cell. */
  async #showCreated(reference: number): Promise<void> {
    const at = await this.runtime.placement(reference);
    if (!at || this.#stageCellOf(at) === undefined) return;
    await this.#created.add(this.runtime, reference, this.#play);
  }

  /** What activating a reference does, its scripts first (see the viewers' #activatable). */
  #activatable(reference: number): Activatable | undefined {
    const target = this.#defaultActivation(reference);
    if (target?.shown === false) return undefined;
    if (!target) return undefined;
    return {
      ...target,
      activate: () => {
        this.runtime.playerActivated(reference, () => {
          target.activate();
        });
      },
    };
  }

  #defaultActivation(reference: number, activator?: number): Activatable | undefined {
    const created = this.#created.get(reference);
    const placed = created ? undefined : this.placed(reference);
    const object = placed?.object ?? created?.object;
    if (!object) return undefined;
    const instance = placed?.instance ?? created?.instance;
    const target = objectActivation(
      object,
      instance,
      {
        name: (teleport) => this.#destinations.get(teleport.door)?.name ?? '',
        go: (teleport) => {
          this.#travel = this.travel(teleport);
        },
      },
      (descriptor, at) => void this.session.playSound(descriptor, at),
      this.session.hud.uses,
      this.#seat,
      activator,
    );
    const playback = instance?.playback;
    if (!target || !playback || this.session.hud.uses?.swung) return target;
    // Without Play's object uses (the HUD's), a door's swing is told here as Play tells it
    // (OnOpen, OnClose: who activated it).
    return {
      ...target,
      activate: () => {
        const { sequence, start } = playback;
        target.activate();
        if (playback.sequence !== sequence || playback.start !== start) {
          tellSwing(
            this.runtime,
            object.reference,
            playback,
            instance.model.sequences,
            activator ?? PLAYER_REF,
          );
        }
      },
    };
  }

  /** Activating an actor (talking to it, riding a horse): as the crosshair on it does. */
  #actorActivation(reference: number): Activatable | undefined {
    const staged = this.stage.get(reference);
    const play = this.#play;
    if (!staged || !play) return undefined;
    const ray = talkTargets(
      () => [staged.placed],
      () => this.session,
      this.terminal,
      (placed) => this.stage.mounts.activation(placed),
    );
    const eye = play.player.position;
    const to = staged.position;
    const direction: Vec3 = [to[0] - eye[0], to[1] - eye[1], to[2] + 100 - eye[2]];
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (length === 0) return undefined;
    const hit = ray(
      eye,
      [direction[0] / length, direction[1] / length, direction[2] / length],
      length + 100,
      64,
    );
    return hit?.target;
  }

  /** What the running game's scripts see of, and do to, the loaded area. */
  readonly #scriptView: ScriptView = {
    loadedReferences: () =>
      [...this.#cells.values()].flatMap((cell) => this.#cellLoadedReferences(cell)),
    loaded: (reference) => this.#loaded(reference),
    created: (reference) => {
      this.#track(this.#showCreated(reference));
      this.#track(this.stage.created(reference, this.#play?.physics));
    },
    livePlacement: (reference) => {
      const player = this.#play?.player;
      const place = this.#place;
      if (reference === PLAYER_REF && player && place) {
        const [x, y, z] = player.feet;
        if (place.kind === 'interior') {
          return { position: [x, y, z], rotation: [0, 0, player.yaw], cell: place.cell };
        }
        const cell = this.#cellAt([x, y, z]);
        return {
          position: [x, y, z],
          rotation: [0, 0, player.yaw],
          world: place.world.record.formId,
          ...(cell && { cell: cell.formId }),
        };
      }
      const created = this.#created.get(reference)?.instance?.world;
      if (created) return { position: [created[12] ?? 0, created[13] ?? 0, created[14] ?? 0] };
      const actor = this.stage.livePlacement(reference);
      if (actor) return actor;
      const world = this.placed(reference)?.instance;
      const moving = world?.motion ? world.world : undefined;
      return moving && { position: [moving[12] ?? 0, moving[13] ?? 0, moving[14] ?? 0] };
    },
    enableStatesChanged: () => {
      for (const cell of this.#cells.values()) this.#refreshCell(cell);
      this.#created.refresh(this.runtime, this.#play);
    },
    moved: (reference) => {
      this.#track(this.#scriptMoved(reference));
    },
    magicEffect: (shown) => {
      this.stage.magicEffect(shown);
    },
    effectShader: (shader, target, play, duration) => {
      this.stage.effects.shader(shader, target, play, duration);
    },
    visualEffect: (effect, target, play, duration) => {
      this.stage.effects.visual(effect, target, play, duration);
    },
    artEffect: (art, target, seconds) => {
      this.stage.effects.art(art, target, seconds);
    },
    graphOf: (reference) => {
      for (const cell of this.#cells.values()) {
        const placed = cell.byReference.get(reference);
        const skeleton = cell.objectSkeletons.find((entry) => entry.reference === reference);
        const graph = placedScriptGraph(
          placed?.instance.graph,
          skeleton?.skeleton.behavior,
          objectClock,
        );
        if (graph) return graph;
      }
      return actorScriptGraph(this.stage.get(reference)?.placed.behavior);
    },
    motionTypeChanged: (reference, motionType) => {
      if (this.stage.vehicles.motionTypeChanged(reference, motionType === MOTION_KEYFRAMED)) return;
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.setMotion(placed, motionType === MOTION_KEYFRAMED);
      }
    },
    impulse: (reference, direction, magnitude) => {
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.impulse(placed, direction, magnitude);
      }
    },
    explosionPush: (reference, center, push) => {
      for (const placed of this.#play?.placementsOf(reference) ?? []) {
        this.#play?.physics.pushFrom(placed, center, push);
      }
    },
    explosionReaches: (from, target, buffer) =>
      this.stage.projectiles.reaches(from, target, buffer),
    destructionChanged: (reference, reached) => {
      this.#destruction.changed(reference, reached);
    },
    explosion: (explosion, at, source) => {
      this.#track(this.stage.projectiles.burst(explosion, at, source ?? 0));
    },
    activate: (reference, activator) => {
      this.#defaultActivation(reference, activator)?.activate();
    },
    triggerCount: (reference) =>
      (this.#play?.triggerCount(reference) ?? 0) + this.stage.movers.triggerCount(reference),
    openChanged: (reference, open) => {
      this.stage.doors.setOpen(reference, open);
    },
    nodeWorld: (reference, node) => {
      const placed = this.placed(reference) ?? this.#created.get(reference);
      return placed?.instance && instanceNodeWorld(placed.instance, node);
    },
    lookChanged: async (reference) => {
      if (reference === PLAYER_REF) {
        if (await this.stage.dismemberment.dressedInPlace(reference)) return;
        await this.#avatar?.rebuild();
        const seat = this.#seat;
        if (seat?.seated) await this.stage.furniture.bodyReplaced(seat.user);
        return;
      }
      await this.stage.lookChanged(reference);
    },
    killed: (reference, killer, silent) => {
      if (reference === PLAYER_REF) this.#seat?.release();
      this.stage.killed(reference, killer, silent);
    },
    currentPackage: (reference) => this.stage.ai.current(reference)?.id,
    currentProcedure: (reference) => this.stage.ai.current(reference)?.procedure,
    randomSceneStarts: (scene, first, second) =>
      this.stage.talk.randomSceneStarts(scene, first, second),
    impactAt: (impactDataSet, from, direction, length) =>
      this.stage.combat.impactAt(impactDataSet, from, direction, length),
    pathTo: (actor, target, walkRun) => {
      if (!this.stage.movers.moves(actor)) return undefined;
      return this.runtime
        .placement(target)
        .then((at) =>
          at
            ? this.stage.movers.travel(actor, [...at.position], walkRun >= 0.5 ? 'run' : 'walk')
            : false,
        );
    },
    changingSpace: () => this.session.loading,
    // TODO(sim): the regions the player stands in come from the sky (see openExterior).
    playerRegions: () => [],
    interaction: (reference) =>
      this.stage.furniture.interaction(reference) ?? this.stage.mounts.interaction(reference),
    playIdle: (actor, idle, target) => {
      const staged = this.stage.get(actor);
      const user = actor === PLAYER_REF ? this.#seat?.user : staged && this.stage.userOf(staged);
      if (!user && actor === PLAYER_REF) {
        this.#playerIdle = { idle, target };
        return true;
      }
      if (!user) return false;
      void this.stage.furniture.playIdle(user, idle, target, {
        inFurniture: true,
        dependents: this.stage.dependentUsers(actor),
      });
      return true;
    },
    pointOfView: (pov) => {
      this.#play?.player.setPov(pov);
    },
    shakeCamera: (strength, seconds, source) => {
      this.stage.graphEvents.shakeCameraFrom(strength, seconds, source);
    },
    interactionLocation: (furniture, from) =>
      this.stage.furniture.interactionLocation(furniture, from),
    dependentAnimated: (reference, dependent, added) =>
      this.stage.dependentAnimated(reference, dependent, added),
    vehicleChanged: (actor) => {
      this.stage.vehicles.changed(actor);
    },
    tether: (cart, horse) => {
      this.#track(this.stage.vehicles.tether(cart, horse));
    },
    mountOf: (actor) => this.stage.mounts.horseOf(actor),
    flyingMount: (actor) => this.stage.mounts.flyingMount(actor),
    flight: (actor) => this.stage.flight.scriptState(actor),
    riderOf: (horse) => this.stage.mounts.riderOf(horse),
    dismount: (actor) => this.stage.mounts.dismount(actor),
    motion: (reference) => {
      const motion =
        reference === PLAYER_REF ? this.#play?.playerMotion() : this.stage.movers.motion(reference);
      const at =
        reference === PLAYER_REF
          ? this.#play?.player.feet
          : this.stage.livePlacement(reference)?.position;
      const water = at && this.#waterAt(at[0], at[1], at[2]);
      return motion && { ...motion, water: water && at[2] < water.height ? water.type : undefined };
    },
    furnitureInUse: (reference, marker) => this.stage.furniture.inUse(reference, marker),
    evaluatePackage: (reference, restart) => {
      this.stage.evaluatePackage(reference, restart);
    },
    combat: () => this.stage.combat,
    launchSpell: (spell, source, target, blame) =>
      this.stage.launchSpell(spell, source, target, blame),
  };

  /** A script moved a reference: the player goes there, an actor or object follows. */
  async #scriptMoved(reference: number): Promise<void> {
    const runtime = this.runtime;
    // Where the script put it (the world still shows it where it was).
    const at = await runtime.placement(reference, false);
    if (!at) return;
    if (reference === PLAYER_REF) {
      // As Play: the player goes where the scripts send them, to another place through a journey.
      if (!this.#sendPlayer(at)) await this.#journey(at);
      return;
    }
    if (this.stage.get(reference)) {
      await this.stage.moved(reference, this.#play?.physics);
      return;
    }
    const world = referenceMatrix({
      position: at.position,
      rotation: at.rotation,
      scale: at.scale,
    });
    const created = this.#created.get(reference);
    if (created) {
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
        this.#created.remove(reference, this.#play);
        await this.#showCreated(reference);
      }
      return;
    }
    const placed = this.placed(reference);
    if (!placed) {
      // An actor from elsewhere moved into the loaded area.
      await this.stage.moved(reference, this.#play?.physics);
      return;
    }
    for (const collision of this.#play?.placementsOf(reference) ?? []) {
      this.#play?.physics.teleport(collision, placed.instance.world, world);
    }
    placed.instance.world.set(world);
    if (placed.instance.motion) placed.instance.motion.version++;
  }

  /** Puts the player at a place of the loaded area: false if it is elsewhere. */
  #sendPlayer(at: Placement): boolean {
    const place = this.#place;
    const play = this.#play;
    if (!place || !play) return false;
    const here =
      place.kind === 'interior'
        ? at.world === undefined && at.cell === place.cell
        : at.world === place.world.record.formId;
    if (!here) return false;
    play.placePlayer(at.position, at.rotation[2]);
    return true;
  }

  /** The player is sent to another place: it opens with them there. */
  async #journey(at: Placement): Promise<void> {
    const arrival: Arrival = { position: at.position, heading: at.rotation[2] };
    if (at.world !== undefined) await this.openExterior(at.world, { arrival });
    else if (at.cell !== undefined) await this.openInterior(at.cell, arrival);
  }
}
