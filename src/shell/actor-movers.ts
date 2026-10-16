// The actors of the loaded area that move by themselves (docs/m10-plan.md, 1.2 and 1.3): a
// living actor of a race that walks, near the player (the engine's high process), gets a
// character controller as the player has one (src/physics/character.ts: the shape from its
// skeleton's bound, scaled by its size), set where it stands once its ground is in place. On
// every physics step what its AI wants (a MoveRequest) becomes the controller's velocity and
// its turning at its movement types' speeds (src/ai/locomotion.ts, steer); every frame it is
// drawn where its controller is, leaning with the ground if its race tilts, and its movement
// drives its behavior graph (Locomotion). Its controller is in the world the player moves in:
// the player bumps into it, it into the player and the others, and trigger volumes see it.

import {
  Locomotion,
  steer,
  taggedMovementType,
  type Gait,
  type MoveRequest,
} from '../ai/locomotion.ts';
import { PathFollower } from '../ai/path-follower.ts';
import { findPath, type NavmeshSet } from '../ai/pathfinding.ts';
import { RaceSize } from '../ai/race-combat-records.ts';
import type { MovementTypes } from '../ai/locomotion.ts';
import { MovementCatalog, type RaceMovement } from '../ai/movement-types.ts';
import { parseNif } from '../formats/nif/nif.ts';
import { CharacterBody } from '../physics/character.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import { groundedPlacement, standsOnGround } from '../world/actor-ground.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { HUMAN_BOUND, skeletonInfo } from '../world/player-body.ts';
import type { ActorMotion } from '../scripting/runtime/runtime.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import { controllerSettings, controllerShape } from './player.ts';
import type { Terminal } from './terminal.ts';

/** The physics world of a play and its fixed steps (PlaySession). */
export interface MoverWorld {
  readonly physics: PhysicsWorld;
  readonly stepHooks: Set<(step: number) => void>;
}

/**
 * Actors nearer the player than this are in the high process: their controller moves them
 * (game units, one exterior cell). The engine's rule for its process levels is not documented
 * (CommonLibSSE: ProcessLists' high, middle-high, middle-low and low lists). TODO(M13).
 */
export const HIGH_PROCESS_DISTANCE = 4096;
/** They leave it beyond this (no churn at the edge). */
const LEAVE_HIGH_DISTANCE = HIGH_PROCESS_DISTANCE * 1.25;
/** A tilting race leans again with the ground once it moved this far (game units). */
const TILT_AGAIN = 4;

/** An actor moved by its controller. */
interface Mover {
  readonly staged: StagedActor;
  readonly character: CharacterBody;
  readonly locomotion: Locomotion;
  readonly race: RaceMovement | undefined;
  /** Its movement types now, and the tagged state they are for. */
  types: MovementTypes | undefined;
  typesFor: string | undefined;
  /** Its feet after the steps it was last measured at, and the ground it leans with. */
  drawn: Vec3;
  /** Its measured horizontal velocity (game units per second of physics time). */
  velocity: [number, number];
  /**
   * How its graph moves it (its clips' root motion: world velocity, the turn in radians per
   * second counter-clockwise) and whether the graph is animation-driven.
   */
  root: {
    readonly velocity: readonly [number, number];
    readonly turn: number;
    readonly driven: boolean;
  };
  /** Its graph moved it in the last step (not its controller's wish): it stands, to its graph. */
  rooted: boolean;
  tilt: { readonly at: Vec3; readonly normal: Vec3 } | undefined;
  /** The trigger volumes it is in. */
  triggers: Set<number>;
}

export interface ActorMoversOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  /** An actor walked into (true) or out of a trigger volume of a reference. */
  readonly onTrigger?: (trigger: number, actor: number, entered: boolean) => void;
  /** The navigation meshes of the loaded area (paths are searched over them). */
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** An actor on its way comes to a door (it opens it if it can). */
  readonly openDoor?: (door: number, actor: number) => void;
  /** Whether something else holds an actor now (furniture): it has no controller meanwhile. */
  readonly held?: (actor: number) => boolean;
}

/** An actor on its way to a place. */
interface Travel {
  readonly destination: Vec3;
  readonly gait: Gait;
  readonly arrive: number;
  follower: PathFollower | undefined;
  /** Searches made (a stuck actor searches again, a few times). */
  searches: number;
  readonly done: (arrived: boolean) => void;
}

/** A stuck actor searches its way again this many times before it gives up. */
const SEARCHES = 3;
/** An actor beyond the high process walks its paths this wide (units; a human's radius). */
const WALKER_RADIUS = 20;
/** It keeps to the navmesh within this of where it steps (units). */
const WALKER_GROUND = 96;
/** A stuck actor is set on its path's next point within this of it (units). */
const UNSTICK_REACH = 64;
/** A controller is set on the floor found from this far above its feet (units). */
const FLOOR_ABOVE = 24;

/**
 * An actor of the loaded area beyond the high process (the middle-high process): its AI runs,
 * and it walks its paths without a controller, kept on the navmesh, its graph driven.
 * TODO(M13): the engine's own middle process (how often it moves them, collision).
 */
interface Walker {
  readonly staged: StagedActor;
  readonly locomotion: Locomotion;
  race: RaceMovement | undefined;
  /** It moved last frame (its graph is told when it stops). */
  moving: boolean;
}

export class ActorMovers {
  readonly #options: ActorMoversOptions;
  readonly #movers = new Map<number, Mover>();
  /** What the actors' AI wants, by reference (kept while they have no controller). */
  readonly #requests = new Map<number, MoveRequest>();
  readonly #adding = new Set<number>();
  /** The actors in the high process at the last frame (moved, being given a controller, held). */
  readonly #high = new Set<number>();
  /** The actors of the loaded area beyond it that walk without a controller. */
  readonly #walkers = new Map<number, Walker>();
  readonly #bounds = new Map<string, Promise<{ center: Vec3; halfExtents: Vec3 } | undefined>>();
  #world: MoverWorld | undefined;
  #catalog: Promise<MovementCatalog> | undefined;
  #catalogRead: MovementCatalog | undefined;
  /** Physics time stepped since the actors were last drawn (their measured speed). */
  #stepped = 0;
  readonly #step = (step: number): void => {
    this.#stepAll(step);
  };

  constructor(options: ActorMoversOptions) {
    this.#options = options;
  }

  /** The play the actors move in (undefined: none; their controllers go). */
  attach(world: MoverWorld | undefined): void {
    if (world === this.#world) return;
    for (const mover of [...this.#movers.values()]) this.#free(mover);
    this.#world?.stepHooks.delete(this.#step);
    this.#world = world;
    world?.stepHooks.add(this.#step);
  }

  readonly #travels = new Map<number, Travel>();

  /**
   * Sends an actor to a place over the navigation meshes of the loaded area, at a gait:
   * resolves true once it is within `arrive` of it, false if it cannot get there (no way over
   * the navmeshes; stuck however often it searched again) or is sent elsewhere or stopped.
   * Its path is searched once it has a controller.
   */
  travel(reference: number, destination: Vec3, gait: Gait, arrive = 32): Promise<boolean> {
    this.#travels.get(reference)?.done(false);
    return new Promise((resolve) => {
      const travel: Travel = {
        destination,
        gait,
        arrive,
        follower: undefined,
        searches: 0,
        done: (arrived) => {
          if (this.#travels.get(reference) !== travel) return;
          this.#travels.delete(reference);
          this.#requests.delete(reference);
          resolve(arrived);
        },
      };
      this.#travels.set(reference, travel);
    });
  }

  /** The actor stops travelling (its travel resolves false) and stands. */
  stop(reference: number): void {
    this.#travels.get(reference)?.done(false);
    this.#requests.delete(reference);
  }

  /** Where an actor travels to now, and the points of its path (development checks). */
  travelOf(reference: number): { destination: Vec3; points: readonly Vec3[] } | undefined {
    const travel = this.#travels.get(reference);
    return (
      travel && { destination: travel.destination, points: travel.follower?.path.points ?? [] }
    );
  }

  /** One frame of an actor's travel: its path searched (again), followed, ended. */
  #travelFrame(mover: Mover, travel: Travel, seconds: number): void {
    const reference = mover.staged.reference;
    if (!travel.follower) {
      const set = this.#options.navmeshes?.();
      if (!set) return;
      travel.searches++;
      const path = findPath(set, mover.staged.position, travel.destination, {
        // Stuck on its way (a corner its path grazed): wider of the edges each time it searches
        // again. TODO(M13): the engine's own way out (not documented).
        radius: mover.character.shape.radius * travel.searches,
        large: (mover.race?.size ?? RaceSize.medium) >= RaceSize.large,
      });
      if (!path || path.points.length < 2) {
        travel.done(false);
        return;
      }
      travel.follower = new PathFollower(path, { gait: travel.gait, arrive: travel.arrive });
    }
    const step = travel.follower.step(mover.staged.position, seconds, (door) =>
      this.#options.openDoor?.(door, reference),
    );
    if (step.state === 'arrived') {
      // Where the path ends short of the place (another island), it got as near as it can.
      travel.done(travel.follower.path.complete);
      return;
    }
    if (step.state === 'stuck') {
      const target = travel.follower.target;
      travel.follower = undefined;
      this.#requests.delete(reference);
      // Still stuck on a path searched wider (wedged where the collision and the navmesh part,
      // under the navmesh's surface): set on the navmesh at the point it went to, if near.
      // TODO(M13): the engine's own way out (not documented).
      const staged = mover.staged;
      if (
        travel.searches >= 2 &&
        target &&
        Math.hypot(target[0] - staged.position[0], target[1] - staged.position[1]) <= UNSTICK_REACH
      ) {
        staged.position = [target[0], target[1], target[2]];
        mover.character.teleport(staged.position);
        if (this.#world?.physics.queriesCurrent) mover.character.recover();
        mover.drawn = [...mover.character.feet];
        staged.position = [...mover.character.feet];
      }
      if (travel.searches >= SEARCHES) travel.done(false);
      return;
    }
    if (step.request) this.#requests.set(reference, step.request);
  }

  /** What an actor's AI wants now (undefined: it stands). */
  request(reference: number, request: MoveRequest | undefined): void {
    if (request) this.#requests.set(reference, request);
    else this.#requests.delete(reference);
  }

  /** What an actor is asked to do now. */
  requestOf(reference: number): MoveRequest | undefined {
    return this.#requests.get(reference);
  }

  /** A moved actor's controller now (development checks). */
  state(reference: number):
    | {
        readonly velocity: readonly [number, number];
        readonly grounded: boolean;
        readonly feet: Vec3;
        readonly types: string | undefined;
      }
    | undefined {
    const mover = this.#movers.get(reference);
    return (
      mover && {
        velocity: mover.character.velocity,
        grounded: mover.character.grounded,
        feet: mover.character.feet,
        types: mover.types && `${mover.types.walk.editorId}/${mover.types.run.editorId}`,
      }
    );
  }

  /** Whether an actor's controller moves it now. */
  moves(reference: number): boolean {
    return this.#movers.has(reference);
  }

  /** How a moved actor moves now (its conditions and natives read it). */
  motion(reference: number): ActorMotion | undefined {
    const mover = this.#movers.get(reference);
    if (!mover) return undefined;
    const request = this.#requests.get(reference);
    const direction = request?.direction;
    const moving = direction !== undefined && (direction[0] !== 0 || direction[1] !== 0);
    return {
      moving,
      running: moving && request?.gait === 'run',
      sprinting: moving && request?.gait === 'sprint',
      // TODO(M10) 4.1: actors sneak (their detection, a package's flag).
      sneaking: false,
      swimming: mover.character.swimming,
      speed: Math.hypot(mover.velocity[0], mover.velocity[1]),
      pathing: this.#travels.has(reference),
    };
  }

  /** How many actors (not the player) are in a trigger volume of a reference. */
  triggerCount(trigger: number): number {
    let count = 0;
    for (const mover of this.#movers.values()) if (mover.triggers.has(trigger)) count++;
    return count;
  }

  /** An actor left the stage: its controller goes, and what it was asked to do. */
  remove(reference: number): void {
    this.#walkers.delete(reference);
    const mover = this.#movers.get(reference);
    if (mover) this.#free(mover);
    this.#travels.get(reference)?.done(false);
    this.#requests.delete(reference);
  }

  /** An actor's controller goes (its body is made again); what it was asked to do stays. */
  release(reference: number): void {
    const mover = this.#movers.get(reference);
    if (mover) this.#free(mover);
  }

  /** A script moved an actor: its controller goes there (no sliding). */
  teleport(staged: StagedActor): void {
    const mover = this.#movers.get(staged.reference);
    if (!mover) return;
    mover.character.teleport(staged.position);
    mover.drawn = [...staged.position];
    mover.tilt = undefined;
  }

  /**
   * Every frame, before the skeletons animate: actors near `focus` get a controller (those
   * set on their ground), far ones lose it; each moved one is drawn where its controller is and
   * drives its graph; trigger volumes are told who walked in and out.
   */
  frame(actors: Iterable<StagedActor>, focus: Vec3 | undefined): void {
    const world = this.#world;
    if (!world) return;
    // Their speed is measured over the physics time stepped (the controllers' own time).
    const seconds = this.#stepped;
    this.#stepped = 0;
    this.#high.clear();
    const seen = new Set<number>();
    for (const staged of actors) {
      const reference = staged.reference;
      seen.add(reference);
      const mover = this.#movers.get(reference);
      const distance = focus
        ? Math.hypot(staged.position[0] - focus[0], staged.position[1] - focus[1])
        : 0;
      const held = this.#options.held?.(reference) === true;
      const near = distance < (mover || held ? LEAVE_HIGH_DISTANCE : HIGH_PROCESS_DISTANCE);
      if (near && this.#lives(staged)) this.#high.add(reference);
      // Beyond the high process: it walks without a controller.
      if (!near && !mover && this.#moves(staged)) {
        this.#walk(staged, seconds);
        continue;
      }
      this.#walkers.delete(reference);
      if (!mover) {
        if (near && !held && this.#moves(staged)) void this.#add(staged);
        continue;
      }
      if (!near || staged.visibility.hidden || held) {
        this.#free(mover);
        continue;
      }
      this.#draw(mover, world.physics, seconds);
      const travel = this.#travels.get(staged.reference);
      if (travel) this.#travelFrame(mover, travel, seconds);
    }
    for (const reference of [...this.#walkers.keys()]) {
      if (!seen.has(reference)) this.#walkers.delete(reference);
    }
  }

  /** Whether an actor's AI runs: in the high process, or walking beyond it. */
  runsAi(reference: number): boolean {
    return this.#high.has(reference) || this.#walkers.has(reference);
  }

  /** One frame of an actor beyond the high process: its travel, its turning, its graph. */
  #walk(staged: StagedActor, seconds: number): void {
    const reference = staged.reference;
    let walker = this.#walkers.get(reference);
    if (!walker) {
      walker = { staged, locomotion: new Locomotion(), race: undefined, moving: false };
      this.#walkers.set(reference, walker);
      const created = walker;
      void Promise.all([this.#movementCatalog(), this.#options.session.db]).then(
        async ([catalog, db]) => {
          created.race = await catalog.race(db, staged.placed.look.race);
        },
      );
    }
    const travel = this.#travels.get(reference);
    if (travel && !this.#walkerTravel(walker, travel, seconds)) return;
    const request = this.#requests.get(reference);
    const types = this.#catalogRead?.forActor(walker.race, undefined);
    let velocity: [number, number] = [0, 0];
    if (request && types && seconds > 0) {
      const steering = steer(request, staged.heading, types, seconds);
      velocity = [steering.velocity[0], steering.velocity[1]];
      staged.heading = steering.heading;
      const [x, y, z] = staged.position;
      const next: Vec3 = [x + velocity[0] * seconds, y + velocity[1] * seconds, z];
      // On the navmesh: its height there (it does not step off it).
      const on = this.#options.navmeshes?.()?.nearest?.(next, WALKER_GROUND);
      if (on) staged.position = [on[0], on[1], on[2]];
    }
    const moving = Math.hypot(velocity[0], velocity[1]) > 1;
    if (moving || walker.moving || request) {
      this.#placeWalker(staged);
      const behavior = staged.placed.behavior;
      if (behavior) {
        walker.locomotion.drive([behavior], {
          velocity,
          heading: staged.heading,
          seconds: Math.max(seconds, 1e-3),
          grounded: true,
          swimming: false,
          verticalSpeed: 0,
          sprinting: moving && request?.gait === 'sprint',
          sneaking: false,
        });
      }
    }
    walker.moving = moving;
  }

  /** A walker's travel: its path searched and followed (false: it ended). */
  #walkerTravel(walker: Walker, travel: Travel, seconds: number): boolean {
    const staged = walker.staged;
    const reference = staged.reference;
    if (!travel.follower) {
      const set = this.#options.navmeshes?.();
      if (!set) return true;
      travel.searches++;
      const path = findPath(set, staged.position, travel.destination, {
        radius: WALKER_RADIUS * travel.searches,
        large: (walker.race?.size ?? RaceSize.medium) >= RaceSize.large,
      });
      if (!path || path.points.length < 2) {
        travel.done(false);
        return false;
      }
      travel.follower = new PathFollower(path, { gait: travel.gait, arrive: travel.arrive });
    }
    const step = travel.follower.step(staged.position, seconds, (door) =>
      this.#options.openDoor?.(door, reference),
    );
    if (step.state === 'arrived') {
      travel.done(travel.follower.path.complete);
      return false;
    }
    if (step.state === 'stuck') {
      travel.follower = undefined;
      this.#requests.delete(reference);
      if (travel.searches >= SEARCHES) travel.done(false);
      return false;
    }
    if (step.request) this.#requests.set(reference, step.request);
    return true;
  }

  /** A walker drawn where it is, upright. */
  #placeWalker(staged: StagedActor): void {
    const placed = staged.placed;
    const instance = placed.instances[0];
    if (!instance?.motion) return;
    instance.world.set(
      referenceMatrix({
        position: staged.position,
        rotation: [0, 0, staged.heading],
        scale: placed.actor.scale * placed.look.scale,
      }),
    );
    instance.motion.version++;
  }

  /**
   * Whether an actor is in the high process (CommonLibSSE's ProcessLists): near the player
   * (HIGH_PROCESS_DISTANCE), alive, shown, of a race that walks. Its AI runs; it has a
   * controller unless furniture holds it.
   */
  inHighProcess(reference: number): boolean {
    return this.#high.has(reference);
  }

  /** Whether an actor lives on its own: alive, shown, of a race that walks, with a graph. */
  #lives(staged: StagedActor): boolean {
    const placed = staged.placed;
    return (
      !staged.dead &&
      !staged.visibility.hidden &&
      !placed.actor.startsDead &&
      placed.behavior !== undefined &&
      standsOnGround(placed.look.raceFlags)
    );
  }

  /** Whether an actor moves by itself: it lives, is set down and nothing else holds it. */
  #moves(staged: StagedActor): boolean {
    return (
      staged.grounded && this.#lives(staged) && this.#options.held?.(staged.reference) !== true
    );
  }

  async #add(staged: StagedActor): Promise<void> {
    const reference = staged.reference;
    if (this.#adding.has(reference)) return;
    this.#adding.add(reference);
    try {
      const world = this.#world;
      const { session } = this.#options;
      const look = staged.placed.look;
      const [data, bound, catalog, db] = await Promise.all([
        session.playerData(),
        look.skeleton === undefined ? undefined : this.#bound(look.skeleton),
        this.#movementCatalog(),
        session.db,
      ]);
      const race = await catalog.race(db, look.race);
      // It left, its play ended or it got one meanwhile.
      if (!world || world !== this.#world || this.#movers.has(reference)) return;
      if (!this.#moves(staged)) return;
      const scale = look.scale * staged.placed.actor.scale;
      const sized = bound ?? HUMAN_BOUND;
      // On the floor first (the collision just under or over its feet), so its shape is not in
      // it: one that walked beyond the high process stood on its navmesh, which may lie a
      // little under the floor.
      if (world.physics.queriesCurrent) {
        const [x, y, z] = staged.position;
        const hit = world.physics.raycast(
          [x, y, z + FLOOR_ABOVE],
          [0, 0, -1],
          FLOOR_ABOVE * 3,
          Layer.charController,
        );
        if (hit) staged.position = [x, y, hit.point[2]];
      }
      const character = new CharacterBody(
        world.physics,
        controllerShape({
          center: [sized.center[0] * scale, sized.center[1] * scale, sized.center[2] * scale],
          halfExtents: [
            sized.halfExtents[0] * scale,
            sized.halfExtents[1] * scale,
            sized.halfExtents[2] * scale,
          ],
        }),
        controllerSettings(data),
        staged.position,
        { reference, kind: 'actor' },
      );
      // Out of what it stands in (set on the floor, its shape may touch it), as the player.
      if (world.physics.queriesCurrent) character.recover();
      this.#movers.set(reference, {
        staged,
        character,
        locomotion: new Locomotion(),
        race,
        types: undefined,
        typesFor: undefined,
        drawn: [...staged.position],
        velocity: [0, 0],
        root: { velocity: [0, 0], turn: 0, driven: false },
        rooted: false,
        tilt: undefined,
        triggers: new Set(),
      });
    } catch (error) {
      this.#options.terminal.log(
        'actor',
        `${staged.placed.look.editorId}: no controller: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    } finally {
      this.#adding.delete(reference);
    }
  }

  #free(mover: Mover): void {
    this.#movers.delete(mover.staged.reference);
    mover.character.free();
    for (const trigger of mover.triggers) {
      this.#options.onTrigger?.(trigger, mover.staged.reference, false);
    }
  }

  /** The collision bound "BBX" of a skeleton model, unscaled (read once per skeleton). */
  #bound(path: string): Promise<{ center: Vec3; halfExtents: Vec3 } | undefined> {
    let entry = this.#bounds.get(path);
    if (!entry) {
      const vfs = this.#options.session.vfs;
      entry = (vfs.has(path) ? vfs.read(path) : Promise.resolve(undefined))
        .then((bytes) => (bytes ? skeletonInfo(parseNif(bytes)).bound : undefined))
        .catch(() => undefined);
      this.#bounds.set(path, entry);
    }
    return entry;
  }

  #movementCatalog(): Promise<MovementCatalog> {
    this.#catalog ??= this.#options.session.db
      .then((db) => MovementCatalog.read(db))
      .then((catalog) => {
        this.#catalogRead = catalog;
        return catalog;
      });
    return this.#catalog;
  }

  /** One physics step of every moved actor: what it wants, then its controller's movement. */
  #stepAll(step: number): void {
    this.#stepped += step;
    for (const mover of this.#movers.values()) {
      const staged = mover.staged;
      const request = this.#requests.get(staged.reference);
      const types = this.#types(mover);
      const root = mover.root;
      // Animation-driven (bAnimationDriven: furniture, staggers, dialogue), or standing while
      // its animation moves it (an attack's lunge, a canned turn): its clips' root motion moves
      // and turns it. TODO(M13): the engine's rule is not documented; this is the graphs'.
      const rooted =
        root.driven ||
        (!request && (Math.hypot(root.velocity[0], root.velocity[1]) > 1 || root.turn !== 0));
      mover.rooted = rooted;
      if (rooted) {
        mover.character.velocity = [root.velocity[0], root.velocity[1]];
        staged.heading -= root.turn * step;
      } else if (request && types) {
        const steering = steer(request, staged.heading, types, step);
        mover.character.velocity = [steering.velocity[0], steering.velocity[1]];
        staged.heading = steering.heading;
      } else {
        mover.character.velocity = [0, 0];
      }
      mover.character.step(step);
    }
  }

  /** Its movement types for the state its graph tags now. */
  #types(mover: Mover): MovementTypes | undefined {
    const behavior = mover.staged.placed.behavior;
    const tagged = behavior ? taggedMovementType(behavior) : undefined;
    if (mover.types && tagged === mover.typesFor) return mover.types;
    const catalog = this.#catalogRead;
    if (!catalog) return mover.types;
    mover.types = catalog.forActor(mover.race, tagged);
    mover.typesFor = tagged;
    return mover.types;
  }

  /**
   * After the skeletons animated: how each moved actor's graph moved it in its update (its
   * clips' root motion over `seconds` of the graph's time), for the next physics steps.
   */
  animated(staged: StagedActor, seconds: number): void {
    const mover = this.#movers.get(staged.reference);
    const behavior = staged.placed.behavior;
    if (!mover || !behavior || seconds <= 0) return;
    const motion = behavior.rootMotion();
    const [x, y] = motion.translation;
    // The actor's frame (x right, y forward) to the world's: right (cos, −sin), forward
    // (sin, cos) of its compass heading.
    const sin = Math.sin(staged.heading);
    const cos = Math.cos(staged.heading);
    mover.root = {
      velocity: [(x * cos + y * sin) / seconds, (-x * sin + y * cos) / seconds],
      // Counter-clockwise (to the left) lowers the compass heading.
      turn: motion.yaw / seconds,
      driven: behavior.variable('bAnimationDriven') === 1,
    };
  }

  /** Draws a moved actor where its controller has it and drives its graph. */
  #draw(mover: Mover, physics: PhysicsWorld, seconds: number): void {
    const staged = mover.staged;
    const placed = staged.placed;
    // Drawn between the last two steps; its speed is measured from step to step (no step
    // since the last frame: it moves as it did).
    const feet = mover.character.feetAt(physics.alpha);
    const stepped = mover.character.feet;
    const dt = Math.max(seconds, 1e-3);
    const velocity: [number, number] =
      seconds > 0
        ? [(stepped[0] - mover.drawn[0]) / dt, (stepped[1] - mover.drawn[1]) / dt]
        : mover.velocity;
    mover.velocity = velocity;
    mover.drawn = [...stepped];
    staged.position = [...feet];
    const instance = placed.instances[0];
    if (instance?.motion) {
      const upright = referenceMatrix({
        position: feet,
        rotation: [0, 0, staged.heading],
        scale: placed.actor.scale * placed.look.scale,
      });
      const flags = placed.look.raceFlags;
      const tilts = (flags & (RaceFlag.tiltFrontBack | RaceFlag.tiltLeftRight)) !== 0;
      if (tilts) {
        const last = mover.tilt?.at;
        if (!last || Math.hypot(feet[0] - last[0], feet[1] - last[1]) > TILT_AGAIN) {
          const hit = physics.raycast(
            [feet[0], feet[1], feet[2] + 16],
            [0, 0, -1],
            64,
            Layer.charController,
            mover.character.collider,
          );
          mover.tilt = { at: [...feet], normal: hit ? hit.normal : [0, 0, 1] };
        }
      }
      instance.world.set(
        tilts && mover.tilt
          ? groundedPlacement(upright, flags, { point: feet, normal: mover.tilt.normal })
          : upright,
      );
      instance.motion.version++;
    }
    const behavior = placed.behavior;
    if (behavior) {
      const request = this.#requests.get(staged.reference);
      const moving = Math.hypot(velocity[0], velocity[1]) > 5;
      // Moved by its graph (a canned turn, a lunge), it stands as far as its speed goes: its
      // walk would otherwise feed the root motion that moves it.
      mover.locomotion.drive([behavior], {
        velocity: mover.rooted ? [0, 0] : velocity,
        heading: staged.heading,
        seconds: dt,
        grounded: mover.character.grounded,
        swimming: mover.character.swimming,
        verticalSpeed: mover.character.verticalSpeed,
        sprinting: moving && request?.gait === 'sprint',
        sneaking: false,
      });
    }
    // The trigger volumes it walked into and out of.
    if (physics.queriesCurrent) {
      const inside = physics.triggersOverlapping(mover.character.collider);
      for (const trigger of inside) {
        if (!mover.triggers.has(trigger))
          this.#options.onTrigger?.(trigger, staged.reference, true);
      }
      for (const trigger of mover.triggers) {
        if (!inside.has(trigger)) this.#options.onTrigger?.(trigger, staged.reference, false);
      }
      mover.triggers = inside;
    }
  }
}
