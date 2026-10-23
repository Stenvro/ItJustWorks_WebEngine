// The actors of the loaded area that move by themselves (docs/m10-plan.md, 1.2 and 1.3): a
// living actor of a race that walks, near the player (the engine's high process), gets a
// character controller as the player has one (src/physics/character.ts: the shape from its
// skeleton's bound, scaled by its size), set where it stands once its ground is in place. On
// every physics step what its AI wants (a MoveRequest) becomes the controller's velocity and
// its turning at its movement types' speeds (src/ai/locomotion.ts, steer); every frame it is
// drawn where its controller is, leaning with the ground if its race tilts, and its movement
// drives its behavior graph (Locomotion). Its controller is in the world the player moves in:
// the player bumps into it, it into the player and the others, and trigger volumes see it.

import type RAPIER from '@dimforge/rapier3d-compat';
import { driveOf, type MovementDrive } from '../ai/movement-drive.ts';
import {
  angleBetween,
  Locomotion,
  MotionFeedback,
  steer,
  taggedMovementType,
  Turning,
  type Gait,
  type LocomotionActions,
  type MotionFeedbackSettings,
  type MoveRequest,
} from '../ai/locomotion.ts';
import { aiSettingsOf } from '../ai/ai-settings.ts';
import {
  avoidance,
  avoidanceNeighbours,
  type AvoidanceSettings,
  type Neighbour,
} from '../ai/avoidance.ts';
import { PathFollower, type DoorPassage } from '../ai/path-follower.ts';
import { findPath, straightReach, type NavmeshSet, type NavPath } from '../ai/pathfinding.ts';
import type { TravelOptions } from '../ai/package-runtime.ts';
import { RaceSize } from '../ai/race-combat-records.ts';
import type { MovementTypes } from '../ai/locomotion.ts';
import { MovementCatalog, type RaceMovement } from '../ai/movement-types.ts';
import { parseNif } from '../formats/nif/nif.ts';
import { CharacterBody } from '../physics/character.ts';
import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Vec3 } from '../render/math.ts';
import { groundedPlacement, standsOnGround } from '../world/actor-ground.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { HUMAN_BOUND, skeletonInfo } from '../world/player-body.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ActorMotion } from '../scripting/runtime/runtime.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import { controllerSettings, controllerShape } from './player.ts';
import { actorFell } from './time-flow.ts';
import type { Terminal } from './terminal.ts';

/** The physics world of a play and its fixed steps (PlaySession). */
export interface MoverWorld {
  readonly physics: PhysicsWorld;
  readonly stepHooks: Set<(step: number) => void>;
  /** The player: actors go round them and react when they bump into them. */
  readonly player?: {
    readonly character: CharacterBody;
    /** How they move (sprinting into an actor is a big bump). */
    readonly motion?: { readonly sprinting: boolean };
  };
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
/** An NPC sprinting pays its stamina this often (seconds of sprinting at a time). */
const SPRINT_PAYMENT_SECONDS = 0.5;

/** [Animation] bFeedbackToGraphFromCharacterController and fMotionFeedback* (MotionFeedback). */
function motionFeedbackSettings(ini: IniSettings): MotionFeedbackSettings {
  return {
    enabled: ini.bool('Animation', 'bFeedbackToGraphFromCharacterController'),
    minSpeedDelta: ini.number('Animation', 'fMotionFeedbackMinSpeedDelta'),
    minAngleDelta: ini.number('Animation', 'fMotionFeedbackMinAngleDelta'),
    minSpeed: ini.number('Animation', 'fMotionFeedbackMinSpeed'),
    minTime: ini.number('Animation', 'fMotionFeedbackMinTime'),
  };
}

/** An actor moved by its controller. */
interface Mover {
  readonly staged: StagedActor;
  readonly character: CharacterBody;
  readonly locomotion: Locomotion;
  /** Its turning (rate, settled facing) from step to step: the engine's angle controller's. */
  readonly turning: Turning;
  /** What its graph is told it moves: what it wanted, or what its controller made of it. */
  readonly feedback: MotionFeedback;
  readonly race: RaceMovement | undefined;
  /** Its movement types now, and the tagged state they are for. */
  types: MovementTypes | undefined;
  typesFor: string | undefined;
  /** Its feet after the steps it was last measured at, and the ground it leans with. */
  drawn: Vec3;
  /** Its measured horizontal velocity (game units per second of physics time). */
  velocity: [number, number];
  /**
   * What its AI's steering wanted in the last physics step: the velocity and the turn rate
   * (radians per second, clockwise): what drives its graph, as the engine's movement controller
   * does, until its controller has made the same for a while (feedback).
   */
  wish: { velocity: readonly [number, number]; turnRate: number };
  /**
   * How far its steering turned it in the physics steps since it was last drawn (radians,
   * clockwise) and over how long: its graph is told the turn rate of all of them (a frame of two
   * steps whose second had nothing left to turn told it 0, the next frame's single step the
   * turn: turnLeft and turnStop ten times a second for an actor turning steadily), and that rate
   * (`rate`, what a rider's graph turns with: the steps may run between the horse's frame and its
   * rider's).
   */
  turned: { angle: number; seconds: number; rate: number };
  /**
   * How its graph moves it (its clips' root motion: world velocity, the turn in radians per
   * second counter-clockwise) and whether the graph is animation-driven.
   */
  root: {
    readonly velocity: readonly [number, number];
    readonly turn: number;
    readonly driven: boolean;
    /** Animation-driven with the controller still turning it (AllowRotation). */
    readonly rotates: boolean;
  };
  /** Its graph moved it in the last step (not its controller's wish): it stands, to its graph. */
  rooted: boolean;
  /** Its graph was animation-driven when last drawn (bAnimationDriven). */
  heldByGraph: boolean;
  /** When its idle was last stopped for its AI's way (performance.now ms). */
  idleStoppedAt: number;
  tilt: { readonly at: Vec3; readonly normal: Vec3 } | undefined;
  /** The trigger volumes it is in. */
  triggers: Set<number>;
  /** The trigger volumes its bodies reached at their last check. */
  bodyTriggers: Set<number>;
}

export interface ActorMoversOptions {
  readonly session: GameSession;
  /** The player bumped into an actor (its idle, its line). */
  readonly onBump?: (actor: number, bump: Bump) => void;
  readonly terminal: Terminal;
  /** An actor walked into (true) or out of a trigger volume of a reference. */
  readonly onTrigger?: (trigger: number, actor: number, entered: boolean) => void;
  /** A living actor's bodies (src/shell/actor-bodies.ts): they reach into triggers too. */
  readonly bodyColliders?: (actor: number) => readonly RAPIER.Collider[];
  /** The navigation meshes of the loaded area (paths are searched over them). */
  readonly navmeshes?: () => NavmeshSet | undefined;
  /**
   * An actor on its way comes to a door (asked every step until it is through): it opens it if
   * it may; open, still opening (it waits) or shut to it (locked).
   */
  readonly openDoor?: (door: number, actor: number) => DoorPassage | undefined;
  /** The doors found shut to an actor lately (its paths keep off them), and where they are. */
  readonly shutTo?: (actor: number) => ReadonlySet<number>;
  readonly shutPlaces?: (
    actor: number,
  ) => readonly { readonly at: Vec3; readonly radius: number }[];
  /** Whether something else holds an actor now (furniture): it has no controller meanwhile. */
  readonly held?: (actor: number) => boolean;
  /**
   * An actor's AI sends it on its way while an animation-driven idle holds it: its idle stops
   * (ActionIdleStop: the graph's IdleStop), as the engine stops an actor's idle for its path.
   */
  readonly stopIdle?: (actor: number) => void;
  /**
   * Performs a movement action through an actor's idle tree (ActionFall, ActionLand); resolves
   * whether its graph took an idle.
   */
  readonly performAction?: (actor: number, action: string) => Promise<boolean>;
  /** Whether the player sees a point (an actor that cannot find its way is warped unseen). */
  readonly seen?: (point: Vec3) => boolean;
}

/** An idle that did not stop for an actor's way is stopped again after this (ms). */
const IDLE_STOP_AGAIN_MS = 1000;

/** An actor on its way to a place. */
interface Travel {
  /** Where it goes (a moving destination moves it: options.moving). */
  destination: Vec3;
  readonly gait: Gait;
  readonly arrive: number;
  /**
   * Straight there (static pathing), not along a navmesh path; stuck on the way (off its route,
   * something in it: hay bales in Helgen's square), it searches a navmesh path from there.
   */
  direct: boolean;
  follower: PathFollower | undefined;
  /** Searches made (a stuck actor searches again, a few times). */
  searches: number;
  /** Doors found shut to it on the way (its searches keep off them), and where they are. */
  readonly closed: Set<number>;
  readonly blocked: { readonly at: Vec3; readonly radius: number }[];
  readonly done: (arrived: boolean) => void;
  /** A destination that moves, and its speed against its gait's (TravelOptions). */
  readonly moving: TravelOptions['moving'];
  readonly speedMult: TravelOptions['speedMult'];
  /** How long others in its way have kept it from going on (seconds), and the last that did. */
  blockedFor: number;
  blockedBy: { readonly at: Vec3; readonly radius: number } | undefined;
}

/** A travel ended by skipped hours sets the actor on the navmesh within this of its place. */
const SKIP_REACH = 256;
/** Off the navmeshes, a path begins at their nearest point within this (game units). */
const NAVMESH_REACH = 512;
/** A stuck actor searches its way again this many times before it gives up. */
const SEARCHES = 3;
/** An actor beyond the high process walks its paths this wide (units; a human's radius). */
const WALKER_RADIUS = 20;
/** It keeps to the navmesh within this of where it steps (units). */
const WALKER_GROUND = 96;
/**
 * The player bumped into an actor (ActionBumpedInto; the conditions GetLastBumpDirection and
 * IsSmallBump read it).
 */
export interface Bump {
  /** Where the player came from, clockwise from the actor's facing (degrees, 0 to 360). */
  readonly direction: number;
  /**
   * A small bump (observed in the original): not big, a big one being of an actor going at
   * fBigBumpSpeed or faster, or the player sprinting into it. (fSmallBumpSpeed the engine never
   * reads.)
   */
  readonly small: boolean;
}

/**
 * How a bumped actor reacts (the game settings fBumpReaction*): it flinches for the delay,
 * standing it steps off the player's way (ideally so far, at least the minimum), then waits.
 */
interface BumpTiming {
  readonly delay: number;
  readonly wait: number;
  readonly ideal: number;
  readonly min: number;
}

/** The vanilla values (Skyrim.esm). */
const BUMP_TIMING: BumpTiming = { delay: 1, wait: 3, ideal: 125, min: 75 };

/** An actor reacting to a bump: its package's way waits meanwhile. */
interface Reaction {
  phase: 'flinch' | 'aside' | 'wait';
  /** Physics seconds left in the phase (flinch, wait). */
  left: number;
  /** The player's way as they bumped into it (it steps off it). */
  readonly way: readonly [number, number];
  /** It stood when bumped (one on its way only flinches and goes on). */
  readonly stood: boolean;
  follower: PathFollower | undefined;
}

/**
 * The player bumps into an actor going at least this fast towards it (units per second; ours:
 * standing against one is no bump).
 */
const BUMP_SPEED = 40;
/** A place off the player's way counts within this of the navmesh (units). */
const ASIDE_REACH = 48;
/** An actor going round others takes itself to go at least this fast (a walk, units/s). */
const AVOID_SPEED = 80;
/** An actor going slower than this with another in its way is kept from going on (units/s). */
const BLOCKED_SPEED = 16;
/** A door this far ahead of an actor's shape is opened as it comes (units). */
const DOOR_LOOKAHEAD = 96;
/** ... seen at this height over its feet (its chest; units). */
const DOOR_RAY_HEIGHT = 64;
/** The triangles within this of a door shut to an actor are closed to it (units). */
const DOOR_BLOCKED = 64;
/** A stuck actor is set on its path's next point within this of it (units). */
const UNSTICK_REACH = 64;
/** ... on a floor within this over or under that point (units). */
const UNSTICK_FLOOR = 48;
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
  /** Its graph was animation-driven last frame (bAnimationDriven). */
  held: boolean;
  /** When its idle was last stopped for its AI's way (performance.now ms). */
  idleStoppedAt: number;
  /** Its graph has been driven since it became a walker. */
  driven: boolean;
  /**
   * How its graph moves it (its clips' root motion: world velocity, the turn in radians per
   * second counter-clockwise), as a moved actor's (Mover.root).
   */
  root: { readonly velocity: readonly [number, number]; readonly turn: number };
}

export class ActorMovers {
  readonly #options: ActorMoversOptions;
  readonly #movers = new Map<number, Mover>();
  /** What the actors' AI wants, by reference (kept while they have no controller). */
  readonly #requests = new Map<number, MoveRequest>();
  readonly #adding = new Set<number>();
  /** The actors in the high process at the last frame (moved, being given a controller, held). */
  readonly #high = new Set<number>();
  /** Actors beyond the high process held by what carries or seats them (their AI runs). */
  readonly #heldAway = new Set<number>();
  /** The actors of the loaded area beyond it that walk without a controller. */
  readonly #walkers = new Map<number, Walker>();
  /** The last bump of each actor (its conditions), and those reacting to one now. */
  readonly #bumps = new Map<number, Bump>();
  readonly #reactions = new Map<number, Reaction>();
  /** The actors that sneak now (src/shell/actor-senses.ts: Always Sneak, StartSneaking). */
  readonly #sneaking = new Set<number>();
  #bumpTiming: BumpTiming | undefined;
  readonly #bounds = new Map<string, Promise<{ center: Vec3; halfExtents: Vec3 } | undefined>>();
  #world: MoverWorld | undefined;
  #catalog: Promise<MovementCatalog> | undefined;
  #catalogRead: MovementCatalog | undefined;
  /** Physics time stepped since the actors were last drawn (their measured speed). */
  #stepped = 0;
  /** What each actor's controller moves through (ignore). */
  readonly #ignored = new Map<number, ReadonlySet<number>>();
  /** Frames so far (actors' body trigger checks take turns). */
  #frames = 0;
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
   * The way each actor was going as a travel arrived in this frame: it goes on so (its request
   * kept) until the next frame, and a travel its AI starts at once (a patrol's next point) goes
   * on from it, not from standing (moveStop, moveStart at every patrol point).
   */
  readonly #arrived = new Map<number, MoveRequest>();
  /** Each actor's travels given up in a row, and where the last one was (the warp's count). */
  readonly #failures = new Map<number, { count: number; at: Vec3 }>();
  /** The warps waiting for the player to look away (or for their time to run out). */
  readonly #warps = new Map<number, { staged: StagedActor; to: Vec3; left: number }>();
  /** Until then (performance.now ms) a travel ends at once at its place: hours were skipped. */
  #skipUntil = 0;

  /**
   * Sends an actor to a place over the navigation meshes of the loaded area, at a gait:
   * resolves true once it is within `arrive` of it, false if it cannot get there (no way over
   * the navmeshes; stuck however often it searched again) or is sent elsewhere or stopped.
   * Its path is searched once it has a controller.
   */
  travel(
    reference: number,
    destination: Vec3,
    gait: Gait,
    arrive = 32,
    options: TravelOptions = {},
  ): Promise<boolean> {
    this.#travels.get(reference)?.done(false);
    const going = this.#arrived.get(reference);
    this.#arrived.delete(reference);
    if (going) this.#requests.set(reference, going);
    const mover = this.#movers.get(reference);
    if (mover && performance.now() < this.#skipUntil) {
      this.#arrive(mover.staged, destination);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const travel: Travel = {
        destination,
        gait,
        arrive,
        direct: options.direct === true,
        follower: undefined,
        searches: 0,
        closed: new Set(),
        blocked: [],
        moving: options.moving,
        speedMult: options.speedMult,
        blockedFor: 0,
        blockedBy: undefined,
        done: (arrived) => {
          if (this.#travels.get(reference) !== travel) return;
          this.#travels.delete(reference);
          const request = this.#requests.get(reference);
          // Arrived on its way, it goes on as it went until the next frame: a travel its AI
          // starts meanwhile (a patrol's next point) takes over without a step of standing,
          // which told its graph moveStop and moveStart at every patrol point (its graph is
          // driven by what it wants, as the engine's).
          if (arrived && request?.direction) this.#arrived.set(reference, request);
          else this.#requests.delete(reference);
          resolve(arrived);
        },
      };
      this.#travels.set(reference, travel);
    });
  }

  /**
   * Hours passed at once (waiting, sleeping): for a moment the travels the actors' packages start
   * end at once, the actor where it was going (it walked there meanwhile).
   */
  skipTravels(ms: number): void {
    this.#skipUntil = performance.now() + ms;
    // Those on their way already (they set out as the hours passed) are there too.
    for (const [reference, travel] of [...this.#travels]) {
      const mover = this.#movers.get(reference);
      if (!mover) continue;
      this.#arrive(mover.staged, travel.destination);
      travel.done(true);
    }
  }

  /** An actor set where it was going, on the navmesh there (hours were skipped). */
  #arrive(staged: StagedActor, destination: Vec3): void {
    const ground = this.#options.navmeshes?.()?.nearest?.(destination, SKIP_REACH);
    staged.position = ground ? [...ground] : [...destination];
    this.teleport(staged);
    this.#requests.delete(staged.reference);
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
    this.#followMoving(travel);
    if (!travel.follower && travel.direct) {
      const path: NavPath = {
        points: [[...mover.staged.position], travel.destination],
        doors: [],
        complete: true,
      };
      travel.follower = new PathFollower(path, { gait: travel.gait, arrive: travel.arrive });
    }
    if (!travel.follower) {
      const set = this.#options.navmeshes?.();
      if (!set) return;
      travel.searches++;
      // Off the navmeshes (a straight way left it: MQ101's second cart before the hay bales in
      // Helgen's square), the path begins at their nearest point.
      const position = mover.staged.position;
      const on = set.locate(position) !== undefined;
      const start = on ? position : set.nearest?.(position, NAVMESH_REACH);
      const found =
        start &&
        findPath(set, start, travel.destination, {
          // Stuck on its way (a corner its path grazed): wider of the edges each time it searches
          // again. TODO(M13): the engine's own way out (not documented).
          radius: mover.character.shape.radius * travel.searches,
          large: (mover.race?.size ?? RaceSize.medium) >= RaceSize.large,
          closedDoors: this.#closedFor(reference, travel),
          blocked: this.#blockedFor(reference, travel),
        });
      const path =
        found && !on ? { ...found, points: [[...position] as Vec3, ...found.points] } : found;
      if (!path || path.points.length < 2) {
        this.#giveUp(reference, travel);
        return;
      }
      travel.follower = new PathFollower(path, { gait: travel.gait, arrive: travel.arrive });
    }
    // A door in its way (the navmesh marks only load doors): it opens it and waits, or the door
    // is shut to it and it goes round.
    const ahead = this.#doorAhead(mover);
    if (ahead?.passage === 'opening') {
      travel.follower.hold();
      const target = travel.follower.target;
      const [x, y] = mover.staged.position;
      this.#requests.set(reference, {
        gait: travel.gait,
        ...(target && { face: Math.atan2(target[0] - x, target[1] - y) }),
      });
      return;
    }
    if (ahead?.passage === 'shut') {
      travel.blocked.push({ at: ahead.at, radius: DOOR_BLOCKED });
      this.#blocked(reference, travel, ahead.door);
      return;
    }
    const step = travel.follower.step(mover.staged.position, seconds, (door) =>
      this.#options.openDoor?.(door, reference),
    );
    if (step.state === 'arrived') {
      // Where the path ends short of the place (another island), it got as near as it can.
      travel.done(travel.follower.path.complete);
      return;
    }
    if (step.state === 'blocked') {
      this.#blocked(reference, travel, step.door);
      return;
    }
    if (step.state === 'stuck' && travel.direct) {
      travel.direct = false;
      travel.follower = undefined;
      return;
    }
    if (step.state === 'stuck') {
      const target = travel.follower.target;
      travel.follower = undefined;
      this.#requests.delete(reference);
      // Still stuck on a path searched wider (wedged where seeking a way round does not get it
      // out): set on the point it went to, if that is near and has a floor.
      // TODO(M13): the engine's own way out (not documented).
      const staged = mover.staged;
      if (
        travel.searches >= 2 &&
        target &&
        Math.hypot(target[0] - staged.position[0], target[1] - staged.position[1]) <= UNSTICK_REACH
      ) {
        this.#unstick(mover, target);
      }
      if (travel.searches >= SEARCHES) this.#giveUp(reference, travel);
      return;
    }
    if (step.request) {
      this.#requests.set(reference, this.#paced(this.#types(mover), travel, step.request));
    }
  }

  /**
   * A destination that moves (an actor followed): once it moved farther than its recalc
   * distance (fAIMoveDistanceToRecalc*) from where the travel leads, the travel goes there and
   * its path is searched again (observed in the original).
   */
  #followMoving(travel: Travel): void {
    const moving = travel.moving;
    const now = moving?.position();
    if (!moving || !now) return;
    const [x, y, z] = travel.destination;
    if (Math.hypot(now[0] - x, now[1] - y, now[2] - z) <= moving.recalc) return;
    travel.destination = [now[0], now[1], now[2]];
    travel.follower = undefined;
    travel.searches = 0;
  }

  /** The INI's avoidance settings ([Pathfinding]). */
  #avoidanceSettings(): AvoidanceSettings & { readonly maxTimeBlocked: number } {
    const ini = this.#options.session.ini;
    return {
      maxActors: ini.number('Pathfinding', 'iMaxActorsToAvoid'),
      timeDelta: ini.number('Pathfinding', 'fAvoidanceTimeDelta'),
      minRadius: ini.number('Pathfinding', 'fMinAvoidanceRadius'),
      maxRadius: ini.number('Pathfinding', 'fMaxAvoidanceRadius'),
      maxTimeBlocked: ini.number('Pathfinding', 'fMaxTimeBlockedByActors'),
    };
  }

  /**
   * An actor on its way whom others keep from going on (one in its way, it hardly moves) for
   * longer than fMaxTimeBlockedByActors searches its path again round them (observed in the
   * original: its path is then blocked by actors).
   */
  #blockedByActors(
    mover: Mover,
    blocker: (Neighbour & { readonly mover: Mover | undefined }) | undefined,
    step: number,
    most: number,
  ): void {
    const travel = this.#travels.get(mover.staged.reference);
    if (!travel) return;
    const stuck = blocker !== undefined && Math.hypot(...mover.velocity) < BLOCKED_SPEED;
    travel.blockedFor = stuck ? travel.blockedFor + step : 0;
    if (!blocker || travel.blockedFor <= most) return;
    travel.blockedFor = 0;
    // Its search keeps off the last one that blocked it (it moves on: only that one).
    const z = mover.character.feet[2];
    travel.blockedBy = {
      at: [blocker.position[0], blocker.position[1], z],
      radius: blocker.radius + mover.character.shape.radius,
    };
    travel.follower = undefined;
  }

  /** A request on its way at the travel's speed (a follower matching its leader's). */
  #paced(types: MovementTypes | undefined, travel: Travel, request: MoveRequest): MoveRequest {
    if (!travel.speedMult || !types) return request;
    const type =
      request.gait === 'walk'
        ? types.walk.walk
        : request.gait === 'sprint'
          ? (types.sprint ?? types.run).run
          : types.run.run;
    return { ...request, speedMult: travel.speedMult(type.forward) };
  }

  /**
   * A travel given up (no way there, stuck, shut doors): it ends, and an actor whose travels
   * failed iWarpMaxPathFailureCount times in a row, each within fMinFailureDistance of the last
   * failure, is warped (bWarpOnConsecutiveFailures; observed in the original): to a point
   * fWarpPathOffset short of where it was going, on the navmesh, once that point and the actor are
   * out of the player's sight or after fWarpMaxTime seconds at the most.
   */
  #giveUp(reference: number, travel: Travel): void {
    const staged = this.#movers.get(reference)?.staged ?? this.#walkers.get(reference)?.staged;
    travel.done(false);
    const ini = this.#options.session.ini;
    if (!staged || !ini.bool('Pathfinding', 'bWarpOnConsecutiveFailures')) return;
    const here = staged.position;
    const last = this.#failures.get(reference);
    const near =
      last !== undefined &&
      Math.hypot(here[0] - last.at[0], here[1] - last.at[1], here[2] - last.at[2]) <=
        ini.number('Pathfinding', 'fMinFailureDistance');
    const count = near ? last.count + 1 : 1;
    if (count < ini.number('Pathfinding', 'iWarpMaxPathFailureCount')) {
      this.#failures.set(reference, { count, at: [...here] });
      return;
    }
    this.#failures.delete(reference);
    const [x, y, z] = travel.destination;
    const away = Math.hypot(here[0] - x, here[1] - y);
    const offset = Math.min(away, ini.number('Pathfinding', 'fWarpPathOffset'));
    const point: Vec3 =
      away > 1e-3
        ? [x + ((here[0] - x) / away) * offset, y + ((here[1] - y) / away) * offset, z]
        : [x, y, z];
    const ground = this.#options.navmeshes?.()?.nearest?.(point, SKIP_REACH);
    this.#warps.set(reference, {
      staged,
      to: ground ? [ground[0], ground[1], ground[2]] : point,
      left: ini.number('Pathfinding', 'fWarpMaxTime'),
    });
  }

  /** The warps waiting: each done once unseen (or its time is up). */
  #warpFrame(seconds: number): void {
    const seen = this.#options.seen;
    for (const [reference, warp] of [...this.#warps]) {
      warp.left -= seconds;
      const staged = warp.staged;
      if (warp.left > 0 && seen && (seen(staged.position) || seen(warp.to))) continue;
      this.#warps.delete(reference);
      if (staged.dead) continue;
      staged.position = [...warp.to];
      this.teleport(staged);
      this.#requests.delete(reference);
      this.#options.terminal.log(
        'actor',
        `${staged.placed.actor.editorId || reference.toString(16)} could not find its way: warped to ` +
          warp.to.map((value) => Math.round(value)).join(', '),
        'info',
      );
    }
  }

  /**
   * A stuck actor set on a point of its path: on the floor just over or under it (none: it
   * stays), out of what it stands in there; back where it was if that took it off that floor
   * (into a counter, through the ground).
   */
  #unstick(mover: Mover, target: Vec3): void {
    const physics = this.#world?.physics;
    if (!physics?.queriesCurrent) return;
    const own = mover.character.collider;
    const [x, y, z] = target;
    const floor = physics.raycast(
      [x, y, z + UNSTICK_FLOOR],
      [0, 0, -1],
      UNSTICK_FLOOR * 2,
      Layer.charController,
      own,
    );
    if (!floor) return;
    const staged = mover.staged;
    const before = mover.character.feet;
    mover.character.teleport([x, y, floor.point[2]]);
    mover.character.recover();
    const feet = mover.character.feet;
    if (Math.abs(feet[2] - floor.point[2]) > UNSTICK_FLOOR / 2) {
      mover.character.teleport(before);
      return;
    }
    mover.drawn = [...feet];
    staged.position = [...feet];
    this.#options.terminal.log(
      'actor',
      `${staged.placed.actor.editorId || staged.reference.toString(16)} was stuck on its way: set on ` +
        `its path at ${feet.map((value) => Math.round(value)).join(', ')}`,
      'info',
    );
  }

  /**
   * A door just ahead of an actor on its way (a ray at its chest along the way it goes): opened
   * if it may open it (the door's passage), and where it is.
   */
  #doorAhead(
    mover: Mover,
  ): { readonly door: number; readonly passage: DoorPassage; readonly at: Vec3 } | undefined {
    const physics = this.#world?.physics;
    const direction = this.#requests.get(mover.staged.reference)?.direction;
    if (!physics?.queriesCurrent || !direction) return undefined;
    const length = Math.hypot(direction[0], direction[1]);
    if (length < 1e-6) return undefined;
    const [x, y, z] = mover.character.feet;
    const hit = physics.raycast(
      [x, y, z + DOOR_RAY_HEIGHT],
      [direction[0] / length, direction[1] / length, 0],
      mover.character.shape.radius + DOOR_LOOKAHEAD,
      Layer.charController,
      mover.character.collider,
    );
    const door = hit?.owner?.kind === 'object' ? hit.owner.reference : undefined;
    if (door === undefined || !hit) return undefined;
    const passage = this.#options.openDoor?.(door, mover.staged.reference);
    return passage && { door, passage, at: hit.point };
  }

  /** The places an actor's search keeps off: doors the navmesh does not mark, shut to it. */
  #blockedFor(
    reference: number,
    travel: Travel,
  ): readonly { readonly at: Vec3; readonly radius: number }[] {
    const lately = this.#options.shutPlaces?.(reference) ?? [];
    const by = travel.blockedBy ? [travel.blockedBy] : [];
    return lately.length === 0 && by.length === 0
      ? travel.blocked
      : [...travel.blocked, ...lately, ...by];
  }

  /** The doors an actor's search keeps off: those shut to it on this way and lately. */
  #closedFor(reference: number, travel: Travel): ReadonlySet<number> {
    const lately = this.#options.shutTo?.(reference);
    if (!lately || lately.size === 0) return travel.closed;
    return new Set([...travel.closed, ...lately]);
  }

  /** A door on the way is shut to the actor: it searches again round it (a few times). */
  #blocked(reference: number, travel: Travel, door: number | undefined): void {
    if (door !== undefined) travel.closed.add(door);
    travel.follower = undefined;
    this.#requests.delete(reference);
    if (travel.searches >= SEARCHES) this.#giveUp(reference, travel);
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

  /** An actor's controller's collider (its own rays leave it out: foot IK), if it has one. */
  colliderOf(reference: number): CharacterBody['collider'] | undefined {
    return this.#movers.get(reference)?.character.collider;
  }

  /** Seconds each actor has sprinted that its stamina has not paid for yet. */
  readonly #sprints = new Map<number, number>();

  /** An actor sprinted `seconds`: its stamina drains (src/scripting/runtime/progression-engine.ts). */
  #sprinted(reference: number, seconds: number): void {
    const total = (this.#sprints.get(reference) ?? 0) + seconds;
    if (total < SPRINT_PAYMENT_SECONDS) {
      this.#sprints.set(reference, total);
      return;
    }
    this.#sprints.delete(reference);
    void this.#options.session.scriptsReady?.progression.sprint(reference, total);
  }

  /**
   * How fast a moved actor's steering turns it now (radians a second, compass: clockwise
   * positive): over the physics steps of the last frame that had any (a rider's graph turns with
   * its horse; measured from frame to frame, frames without a step said it stopped turning).
   */
  turnRate(reference: number): number | undefined {
    return this.#movers.get(reference)?.turned.rate;
  }

  /** How a moved actor moves now (its conditions and natives read it). */
  motion(reference: number): ActorMotion | undefined {
    const mover = this.#movers.get(reference);
    if (!mover) return undefined;
    const request = this.#requests.get(reference);
    const direction = request?.direction;
    const moving = direction !== undefined && (direction[0] !== 0 || direction[1] !== 0);
    const pathing = this.#travels.has(reference);
    return {
      moving,
      running: moving && request?.gait === 'run',
      sprinting: moving && request?.gait === 'sprint',
      sneaking: this.#sneaking.has(reference),
      swimming: mover.character.swimming,
      speed: Math.hypot(mover.velocity[0], mover.velocity[1]),
      pathing,
      bump: this.#bumps.get(reference),
      heading: mover.staged.heading,
      velocity: [mover.velocity[0], mover.velocity[1], mover.character.verticalSpeed],
      // What its controller is asked (the steering's velocity) and the way its path goes on.
      wish: [mover.character.velocity[0], mover.character.velocity[1]],
      aim: pathing && direction ? [direction[0], direction[1]] : undefined,
    };
  }

  /** An actor sneaks (its graph's IsSneaking: it moves as its sneaking movement type) or not. */
  sneak(reference: number, on: boolean): void {
    if (on) this.#sneaking.add(reference);
    else this.#sneaking.delete(reference);
  }

  /** The height of a moved actor's controller (its eyes: src/shell/actor-senses.ts). */
  height(reference: number): number | undefined {
    return this.#movers.get(reference)?.character.shape.height;
  }

  /** The radius of a moved actor's controller (its size for blows: src/shell/actor-combat.ts). */
  radius(reference: number): number | undefined {
    return this.#movers.get(reference)?.character.shape.radius;
  }

  /** A moving actor's race size (RaceSize; head tracking reaches farther for extra large). */
  raceSize(reference: number): number | undefined {
    return (this.#movers.get(reference)?.race ?? this.#walkers.get(reference)?.race)?.size;
  }

  /** The physics world the actors move in (its rays: the fliers' ground, src/shell/actor-flight.ts). */
  get physics(): PhysicsWorld | undefined {
    return this.#world?.physics;
  }

  /** How many actors (not the player) are in a trigger volume of a reference. */
  triggerCount(trigger: number): number {
    let count = 0;
    for (const mover of this.#movers.values()) if (mover.triggers.has(trigger)) count++;
    return count;
  }

  /**
   * What an actor's controller moves through (a horse its cart's colliders: hitched, the cart
   * never stands in its way, also as it turns round).
   */
  ignore(reference: number, colliders: readonly RAPIER.Collider[]): void {
    const handles = new Set(colliders.map((collider) => collider.handle));
    this.#ignored.set(reference, handles);
    const mover = this.#movers.get(reference);
    if (mover) mover.character.ignored = handles;
  }

  // --- How its graph drives its movement --------------------------------------------------------

  /** Each actor's movement drive (its graph's handlers and variables set it). */
  readonly #drives = new Map<
    number,
    { drive: MovementDrive; animation: number; rotation: number }
  >();

  /**
   * The engine's AnimationDriven, MotionDriven and AllowRotation handlers (the graph's
   * StartAnimationDriven, StartMotionDriven, StartAllowRotation): its movement controller
   * switches at once.
   */
  setDrive(reference: number, drive: MovementDrive): void {
    const entry = this.#drives.get(reference);
    if (entry) entry.drive = drive;
    else this.#drives.set(reference, { drive, animation: -1, rotation: -1 });
  }

  /** How an actor's movement is driven now (its controller unless its graph says otherwise). */
  drive(reference: number): MovementDrive {
    return this.#drives.get(reference)?.drive ?? 'controller';
  }

  /**
   * Its drive before a movement update: the engine reads bAnimationDriven and bAllowRotation
   * from the graph and switches the controller by them (docs/animation.md, "Driving the
   * graphs"); here as they change, so that a handler's switch holds until they do.
   * TODO(M13): whether the engine reads them every update or as they change.
   */
  #readDrive(
    reference: number,
    behavior: { variable(name: string): number | undefined },
  ): MovementDrive {
    const animation = behavior.variable('bAnimationDriven') ?? 0;
    const rotation = behavior.variable('bAllowRotation') ?? 0;
    const entry = this.#drives.get(reference);
    if (entry?.animation === animation && entry.rotation === rotation) return entry.drive;
    const drive = driveOf(animation, rotation);
    this.#drives.set(reference, { drive, animation, rotation });
    return drive;
  }

  /** An actor left the stage: its controller goes, and what it was asked to do. */
  remove(reference: number): void {
    this.#drives.delete(reference);
    this.#locomotions.delete(reference);
    this.#dropWalker(reference);
    this.#reactions.delete(reference);
    this.#sneaking.delete(reference);
    this.#failures.delete(reference);
    this.#warps.delete(reference);
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

  /**
   * How far the navmeshes let an actor go straight from where it stands towards `to` (units;
   * the whole way where none is loaded): pathfinding.ts straightReach with its radius.
   */
  straightReach(reference: number, to: Vec3, from?: Vec3): number {
    const mover = this.#movers.get(reference);
    const start = from ?? mover?.character.feet ?? this.#walkers.get(reference)?.staged.position;
    const set = this.#options.navmeshes?.();
    if (!start) return 0;
    if (!set) return Math.hypot(to[0] - start[0], to[1] - start[1]);
    return straightReach(set, start, to, mover?.character.shape.radius ?? WALKER_RADIUS);
  }

  /** An actor's movement actions through its idle tree (its falls and landings). */
  #actionsOf(reference: number): LocomotionActions | undefined {
    const perform = this.#options.performAction;
    return perform ? { perform: (action) => perform(reference, action) } : undefined;
  }

  /** A script moved an actor: its controller goes there (no sliding). */
  teleport(staged: StagedActor): void {
    const mover = this.#movers.get(staged.reference);
    if (!mover) return;
    mover.character.teleport(staged.position);
    mover.turning.reset();
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
    this.#frames++;
    // A travel that arrived in the last frame and was followed by none: the actor stands.
    for (const [reference, request] of this.#arrived) {
      if (this.#requests.get(reference) === request) this.#requests.delete(reference);
    }
    this.#arrived.clear();
    // Their speed is measured over the physics time stepped (the controllers' own time).
    const seconds = this.#stepped;
    this.#stepped = 0;
    this.#high.clear();
    this.#heldAway.clear();
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
      // Beyond it, held by what carries or seats it: its AI goes on (a rider's moves its horse,
      // a walker: MQ101's Tullius rides on to the tower after the player's cart drew away).
      else if (held && this.#lives(staged)) this.#heldAway.add(reference);
      // Beyond the high process: it walks without a controller (not with its AI disabled).
      if (!near && !mover && this.#moves(staged) && !this.aiDisabled(reference)) {
        this.#walk(staged, seconds);
        continue;
      }
      this.#dropWalker(reference);
      if (!mover) {
        if (near && !held && this.#moves(staged)) void this.#add(staged);
        continue;
      }
      // Not set down (moved into a cell whose collision is not in place yet): it waits, standing.
      if (!near || staged.visibility.hidden || held || !staged.grounded) {
        this.#free(mover);
        continue;
      }
      // Its AI disabled (EnableAI false): it stands where it is, its way and wish dropped.
      if (this.aiDisabled(reference)) {
        if (this.#travels.has(reference)) this.stop(reference);
        this.#requests.delete(reference);
      }
      this.#draw(mover, world.physics, seconds);
      const reaction = this.#reactions.get(staged.reference);
      if (reaction) {
        this.#react(mover, reaction, seconds);
        continue;
      }
      const travel = this.#travels.get(staged.reference);
      if (travel) this.#travelFrame(mover, travel, seconds);
    }
    for (const reference of [...this.#walkers.keys()]) {
      if (!seen.has(reference)) this.#dropWalker(reference);
    }
    for (const reference of [...this.#warps.keys()]) {
      if (!seen.has(reference)) this.#warps.delete(reference);
    }
    this.#warpFrame(seconds);
  }

  /** The last time the player bumped into an actor: where from, how (its conditions). */
  bumpOf(reference: number): Bump | undefined {
    return this.#bumps.get(reference);
  }

  /**
   * The actors the player walked into in the last step (their controllers touched): each
   * that stands on its own and is not reacting yet flinches, then steps aside. Actors go round
   * one another (avoidance). TODO(M13): whether the engine has actors bumping each other react.
   */
  #bumped(world: MoverWorld): void {
    const player = world.player?.character;
    if (!player || player.touched.length === 0) return;
    const [px, py] = player.feet;
    const [vx, vy] = player.velocity;
    const speed = Math.hypot(vx, vy);
    if (speed < BUMP_SPEED) return;
    const bigBumpSpeed = aiSettingsOf(this.#options.session).bigBumpSpeed;
    for (const collider of player.touched) {
      const owner = world.physics.ownerOf(collider);
      if (owner?.kind !== 'actor' || owner.reference === player.owner.reference) continue;
      const mover = this.#movers.get(owner.reference);
      if (!mover || this.#reactions.has(owner.reference)) continue;
      const staged = mover.staged;
      const dx = staged.position[0] - px;
      const dy = staged.position[1] - py;
      // Walking into it, not away from it.
      if (dx * vx + dy * vy <= 0) continue;
      // Where the player is from it, clockwise from its facing (compass headings).
      const from = Math.atan2(-dx, -dy) - staged.heading;
      const direction = ((((from * 180) / Math.PI) % 360) + 360) % 360;
      const own = Math.hypot(mover.velocity[0], mover.velocity[1]);
      const big = own >= bigBumpSpeed || world.player.motion?.sprinting === true;
      const bump: Bump = { direction, small: !big };
      this.#bumps.set(owner.reference, bump);
      this.#reactions.set(owner.reference, {
        phase: 'flinch',
        left: this.#timing().delay,
        way: [vx / speed, vy / speed],
        stood: !this.#travels.has(owner.reference),
        follower: undefined,
      });
      this.#requests.delete(owner.reference);
      this.#options.onBump?.(owner.reference, bump);
    }
  }

  /** The bump reaction's timing, from the game settings once read (vanilla until then). */
  #timing(): BumpTiming {
    if (!this.#bumpTiming) {
      this.#bumpTiming = BUMP_TIMING;
      void this.#options.session.settings().then((settings) => {
        this.#bumpTiming = {
          delay: settings.number('fBumpReactionSmallDelayTime') ?? BUMP_TIMING.delay,
          wait: settings.number('fBumpReactionSmallWaitTimer') ?? BUMP_TIMING.wait,
          ideal: settings.number('fBumpReactionIdealMoveDist') ?? BUMP_TIMING.ideal,
          min: settings.number('fBumpReactionMinMoveDist') ?? BUMP_TIMING.min,
        };
      });
    }
    return this.#bumpTiming;
  }

  /**
   * One frame of a bump reaction: it flinches (stands), then one that stood steps off the
   * player's way (fBumpReactionIdealMoveDist, at least the minimum, where the navmesh has
   * room), waits, and its package goes on (its way searched again from where it is now).
   */
  #react(mover: Mover, reaction: Reaction, seconds: number): void {
    const reference = mover.staged.reference;
    const timing = this.#timing();
    if (reaction.phase === 'flinch') {
      reaction.left -= seconds;
      if (reaction.left > 0) return;
      const aside = reaction.stood ? this.#aside(mover, reaction.way, timing) : undefined;
      if (aside) {
        reaction.phase = 'aside';
        reaction.follower = new PathFollower(aside, { gait: 'walk', arrive: 16 });
        return;
      }
      reaction.phase = 'wait';
      reaction.left = reaction.stood ? timing.wait : 0;
      return;
    }
    if (reaction.phase === 'aside') {
      const step = reaction.follower?.step(mover.staged.position, seconds);
      if (step?.state === 'moving') {
        if (step.request) this.#requests.set(reference, step.request);
        return;
      }
      this.#requests.delete(reference);
      reaction.phase = 'wait';
      reaction.left = timing.wait;
      return;
    }
    reaction.left -= seconds;
    if (reaction.left > 0) return;
    this.#reactions.delete(reference);
    // Its package's way, from where it stands now.
    const travel = this.#travels.get(reference);
    if (travel) travel.follower = undefined;
  }

  /** A path off the player's way (to the side the actor stands on), if the navmesh has room. */
  #aside(mover: Mover, way: readonly [number, number], timing: BumpTiming): NavPath | undefined {
    const set = this.#options.navmeshes?.();
    const player = this.#world?.player?.character;
    if (!set || !player) return undefined;
    const [x, y, z] = mover.staged.position;
    // Which side of the player's way it stands on: it steps further that way.
    const side = Math.sign(way[0] * (y - player.feet[1]) - way[1] * (x - player.feet[0])) || 1;
    const left: [number, number] = [-way[1] * side, way[0] * side];
    for (const distance of [timing.ideal, timing.min]) {
      const to = set.nearest?.([x + left[0] * distance, y + left[1] * distance, z], ASIDE_REACH);
      if (!to) continue;
      const path = findPath(set, mover.staged.position, to, {
        radius: mover.character.shape.radius,
      });
      if (path?.complete && path.points.length >= 2) return path;
    }
    return undefined;
  }

  /**
   * Whether an actor's AI runs: in the high process, or walking beyond it; not while a script
   * disabled it (EnableAI false: the engine stops processing the actor's AI, its packages,
   * combat, detection and movement, and stills its controller; its graph animates on).
   */
  runsAi(reference: number): boolean {
    if (this.aiDisabled(reference)) return false;
    return (
      this.#high.has(reference) || this.#walkers.has(reference) || this.#heldAway.has(reference)
    );
  }

  /** Whether a script disabled an actor's AI (EnableAI false). */
  aiDisabled(reference: number): boolean {
    return this.#options.session.scriptsReady?.state.actors.get(reference)?.aiEnabled === false;
  }

  /** One frame of an actor beyond the high process: its travel, its turning, its graph. */
  #walk(staged: StagedActor, seconds: number): void {
    const reference = staged.reference;
    let walker = this.#walkers.get(reference);
    if (!walker) {
      walker = {
        staged,
        locomotion: this.#locomotionOf(reference),
        race: undefined,
        moving: false,
        held: false,
        idleStoppedAt: -Infinity,
        driven: false,
        root: { velocity: [0, 0], turn: 0 },
      };
      this.#walkers.set(reference, walker);
      const created = walker;
      void Promise.all([this.#movementCatalog(), this.#options.session.db]).then(
        async ([catalog, db]) => {
          created.race = await catalog.race(db, staged.placed.look.race);
        },
      );
    }
    // No time stepped (a frame between two physics steps): it moves as it did.
    if (!(seconds > 0)) return;
    // Held by an animation-driven graph (an idle, sitting down: bAnimationDriven) it does not go
    // its way: its graph is told it sets out (moveStart ends such an idle), its idle is stopped
    // as a moved actor's is (ActionIdleStop, again each second while it holds), and it goes once
    // the graph lets it. Moved meanwhile, it glided: a chicken sat in its idle while it went on.
    // Not stopped, a chicken lying down (its LaydownState) gave up every walk its sandbox sent it
    // on (no headway in its searches).
    const behavior = staged.placed.behavior;
    const held = behavior !== undefined && this.#readDrive(reference, behavior) !== 'controller';
    const travel = this.#travels.get(reference);
    if (travel && !this.#walkerTravel(walker, travel, seconds)) return;
    const request = this.#requests.get(reference);
    const types = this.#catalogRead?.forActor(walker.race, undefined);
    if (held && request?.direction !== undefined) {
      const now = performance.now();
      if (now - walker.idleStoppedAt >= IDLE_STOP_AGAIN_MS) {
        walker.idleStoppedAt = now;
        this.#options.stopIdle?.(reference);
      }
    }
    let velocity: [number, number] = [0, 0];
    let turnRate = 0;
    // Held by its graph, its clips' root motion moves and turns it (as a moved actor's: a deer's
    // canned flee turn carries it on; before, a walker held so stood while its clips ran).
    let rooted = false;
    if (held) {
      const root = walker.root;
      rooted = Math.hypot(root.velocity[0], root.velocity[1]) > 1 || root.turn !== 0;
      if (rooted) {
        staged.heading -= root.turn * seconds;
        const [x, y, z] = staged.position;
        const next: Vec3 = [x + root.velocity[0] * seconds, y + root.velocity[1] * seconds, z];
        const on = this.#options.navmeshes?.()?.nearest?.(next, WALKER_GROUND);
        if (on) staged.position = [on[0], on[1], on[2]];
      }
    } else if (request && types && seconds > 0) {
      const steering = steer(request, staged.heading, types, seconds);
      velocity = [steering.velocity[0], steering.velocity[1]];
      turnRate = angleBetween(staged.heading, steering.heading) / seconds;
      staged.heading = steering.heading;
      const [x, y, z] = staged.position;
      const next: Vec3 = [x + velocity[0] * seconds, y + velocity[1] * seconds, z];
      // On the navmesh: its height there (it does not step off it).
      const on = this.#options.navmeshes?.()?.nearest?.(next, WALKER_GROUND);
      if (on) staged.position = [on[0], on[1], on[2]];
    }
    const moving = Math.hypot(velocity[0], velocity[1]) > 1;
    // Driven at least once as a walker: what it was told as a moved actor goes on (a deer that
    // fled past the high process ran on the spot for minutes, its graph never told it stopped).
    if (moving || rooted || walker.moving || request || !walker.driven) {
      walker.driven = true;
      this.#placeWalker(staged);
      const behavior = staged.placed.behavior;
      if (behavior) {
        // Out of an animation-driven idle while it goes on: told again that it moves.
        if (walker.held && !held) walker.locomotion.resume([behavior]);
        // Its graph's channels read it as the graph updates (beyond the high process its graph
        // updates a few times a second).
        walker.locomotion.latch(behavior, {
          velocity,
          turnRate,
          heading: staged.heading,
          seconds: Math.max(seconds, 1e-3),
          grounded: true,
          swimming: false,
          verticalSpeed: 0,
          sprinting: moving && request?.gait === 'sprint',
          sneaking: this.#sneaking.has(reference),
          settingOut: held && request?.direction !== undefined,
        });
      }
    }
    walker.moving = moving;
    walker.held = held;
  }

  /** A walker's travel: its path searched and followed (false: it ended). */
  #walkerTravel(walker: Walker, travel: Travel, seconds: number): boolean {
    const staged = walker.staged;
    const reference = staged.reference;
    this.#followMoving(travel);
    if (!travel.follower) {
      const set = this.#options.navmeshes?.();
      if (!set) return true;
      travel.searches++;
      const path = findPath(set, staged.position, travel.destination, {
        radius: WALKER_RADIUS * travel.searches,
        large: (walker.race?.size ?? RaceSize.medium) >= RaceSize.large,
        closedDoors: this.#closedFor(reference, travel),
        blocked: this.#blockedFor(reference, travel),
      });
      if (!path || path.points.length < 2) {
        this.#giveUp(reference, travel);
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
    if (step.state === 'blocked') {
      this.#blocked(reference, travel, step.door);
      return false;
    }
    if (step.state === 'stuck') {
      travel.follower = undefined;
      this.#requests.delete(reference);
      if (travel.searches >= SEARCHES) this.#giveUp(reference, travel);
      return false;
    }
    if (step.request) {
      const types = this.#catalogRead?.forActor(walker.race, undefined);
      this.#requests.set(reference, this.#paced(types, travel, step.request));
    }
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
      // Blocked on its way, it seeks a way round (a crease, a corner).
      character.seeksAround = true;
      // It steps up onto ground actors walk as the player does (the engine's controller's
      // TryStep: onto the navmesh), not only up stairs: a chicken sent onto a Riverwood porch
      // stood before its edge, its path over the navmesh, its controller stopped by the step.
      character.walkable = (x, y, z) =>
        this.#options.navmeshes?.()?.locate([x, y, z]) !== undefined;
      // Out of what it stands in (set on the floor, its shape may touch it), as the player.
      if (world.physics.queriesCurrent) character.recover();
      this.#movers.set(reference, {
        staged,
        character,
        locomotion: this.#locomotionOf(reference),
        turning: new Turning(),
        feedback: new MotionFeedback(motionFeedbackSettings(session.ini)),
        race,
        types: undefined,
        typesFor: undefined,
        drawn: [...staged.position],
        velocity: [0, 0],
        wish: { velocity: [0, 0], turnRate: 0 },
        turned: { angle: 0, seconds: 0, rate: 0 },
        root: { velocity: [0, 0], turn: 0, driven: false, rotates: false },
        rooted: false,
        heldByGraph: false,
        idleStoppedAt: -Infinity,
        tilt: undefined,
        triggers: new Set(),
        bodyTriggers: new Set(),
      });
      character.ignored = this.#ignored.get(reference) ?? new Set();
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

  /**
   * An actor's movement as its graph was told it (one for the actor, whether its controller or
   * its walk beyond the high process moves it): what it was told goes on as one gives way to the
   * other (its graph is told it stopped when it did).
   */
  readonly #locomotions = new Map<number, Locomotion>();

  #locomotionOf(reference: number): Locomotion {
    let locomotion = this.#locomotions.get(reference);
    if (!locomotion) {
      locomotion = new Locomotion(this.#actionsOf(reference));
      this.#locomotions.set(reference, locomotion);
    }
    return locomotion;
  }

  /** A walker is no longer one: its graph's channels no longer read its movement. */
  #dropWalker(reference: number): void {
    this.#walkers.get(reference)?.locomotion.release();
    this.#walkers.delete(reference);
  }

  #free(mover: Mover): void {
    this.#movers.delete(mover.staged.reference);
    mover.locomotion.release();
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
    // What the player walked into in this step (each step's contacts are its own).
    if (this.#world) this.#bumped(this.#world);
    const others = this.#neighbours();
    const avoiding = this.#avoidanceSettings();
    for (const mover of this.#movers.values()) {
      const staged = mover.staged;
      const wanted = this.#requests.get(staged.reference);
      // On its way it goes round the others and the player in it (the nearest of them within
      // its avoidance radius, iMaxActorsToAvoid at the most).
      let request = wanted;
      if (wanted?.direction && others.length > 1) {
        const self = {
          position: [mover.character.feet[0], mover.character.feet[1]] as const,
          radius: mover.character.shape.radius,
          speed: Math.max(Math.hypot(...mover.velocity), AVOID_SPEED),
          direction: wanted.direction,
        };
        const near = avoidanceNeighbours(
          self,
          others.filter((other) => other.mover !== mover),
          avoiding,
        );
        const passing = avoidance(self, near);
        request = { ...wanted, direction: passing.direction };
        this.#blockedByActors(mover, passing.blocker, step, avoiding.maxTimeBlocked);
      }
      const types = this.#types(mover);
      const root = mover.root;
      // Animation-driven (bAnimationDriven: furniture, staggers, dialogue), or standing while
      // its animation moves it (an attack's lunge, a canned turn): its clips' root motion moves
      // and turns it. A fighter in a melee attack, asked only to face its target, stands so too
      // (MoveRequest.rootMotion): a power attack's lunge carries it forward, its controller
      // still turning it. TODO(M13): the engine's rule is not documented; this is the graphs'.
      const rootMoves = Math.hypot(root.velocity[0], root.velocity[1]) > 1;
      const standing =
        request?.rootMotion === true &&
        (!request.direction || (request.direction[0] === 0 && request.direction[1] === 0));
      const rooted =
        root.driven || (!request && (rootMoves || root.turn !== 0)) || (standing && rootMoves);
      mover.rooted = rooted;
      if (rooted) {
        mover.character.velocity = [root.velocity[0], root.velocity[1]];
        // Allowed to rotate (AllowRotation), or standing to face a way, its controller turns it
        // the way it goes while its animation moves it.
        const turning =
          (root.rotates || (standing && !root.driven)) && request && types
            ? steer(request, staged.heading, types, step, mover.turning, rootMoves)
            : undefined;
        const before = staged.heading;
        if (turning) {
          staged.heading = turning.heading;
        } else {
          // Its clip turns it (a canned turn): its turning goes on from that rate.
          staged.heading -= root.turn * step;
          mover.turning.rate = -root.turn;
        }
        // Its graph moves it: to its graph it stands (its walk would feed the root motion), and
        // turns as it turns now (the engine's TurnDelta is its rotation, its clip's while the
        // clip drives it: told it stopped, a drawn bow's canned turn was left and taken again
        // every frame).
        const turned = angleBetween(before, staged.heading);
        mover.turned.angle += turned;
        mover.wish = { velocity: [0, 0], turnRate: step > 0 ? turned / step : 0 };
      } else if (request && types) {
        const steering = steer(request, staged.heading, types, step, mover.turning);
        mover.character.velocity = [steering.velocity[0], steering.velocity[1]];
        const angle = angleBetween(staged.heading, steering.heading);
        mover.turned.angle += angle;
        mover.wish = { velocity: steering.velocity, turnRate: step > 0 ? angle / step : 0 };
        staged.heading = steering.heading;
      } else {
        mover.character.velocity = [0, 0];
        mover.wish = { velocity: [0, 0], turnRate: 0 };
        mover.turning.reset();
      }
      mover.turned.seconds += step;
      mover.character.step(step);
      // Landed from a fall: the NPCs' falling damage, as the player's (horses too).
      const fell = mover.character.landedFrom;
      const runtime = this.#options.session.scriptsReady;
      if (fell !== undefined && fell > 0 && runtime) {
        void actorFell(runtime, staged.reference, fell).catch(() => undefined);
      }
    }
  }

  /** The actors with controllers and the player, as those on their way go round them. */
  #neighbours(): (Neighbour & { readonly mover: Mover | undefined })[] {
    const list: (Neighbour & { readonly mover: Mover | undefined })[] = [];
    for (const mover of this.#movers.values()) {
      const [x, y] = mover.character.feet;
      list.push({
        position: [x, y],
        velocity: mover.velocity,
        radius: mover.character.shape.radius,
        mover,
      });
    }
    // The player riding (a horse, a cart) is carried: not one to go round. Their horse steered
    // round its own rider every step, its way wavering left and right (turnLeft, turnRight and
    // turnStop many times a second), its speed falling and rising round its moveStart.
    const player =
      this.#options.held?.(PLAYER_REF) === true ? undefined : this.#world?.player?.character;
    if (player) {
      list.push({
        position: [player.feet[0], player.feet[1]],
        velocity: player.velocity,
        radius: player.shape.radius,
        mover: undefined,
      });
    }
    return list;
  }

  /** The turn rate its steering made over the steps since it was last drawn (radians a second). */
  #turnRate(mover: Mover): number {
    const turned = mover.turned;
    // No step since the last frame: as it turned then.
    if (turned.seconds <= 0) return turned.rate;
    const rate = turned.angle / turned.seconds;
    mover.turned = { angle: 0, seconds: 0, rate };
    return rate;
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
    const walker = mover ? undefined : this.#walkers.get(staged.reference);
    if (!behavior || seconds <= 0) return;
    if (walker) {
      const motion = behavior.rootMotion();
      const [x, y] = motion.translation;
      const sin = Math.sin(staged.heading);
      const cos = Math.cos(staged.heading);
      walker.root = {
        velocity: [(x * cos + y * sin) / seconds, (-x * sin + y * cos) / seconds],
        turn: motion.yaw / seconds,
      };
      return;
    }
    if (!mover) return;
    const motion = behavior.rootMotion();
    const drive = this.#readDrive(staged.reference, behavior);
    const [x, y] = motion.translation;
    // The actor's frame (x right, y forward) to the world's: right (cos, −sin), forward
    // (sin, cos) of its compass heading.
    const sin = Math.sin(staged.heading);
    const cos = Math.cos(staged.heading);
    mover.root = {
      velocity: [(x * cos + y * sin) / seconds, (-x * sin + y * cos) / seconds],
      // Counter-clockwise (to the left) lowers the compass heading.
      turn: motion.yaw / seconds,
      driven: drive !== 'controller',
      rotates: drive === 'animation-rotation',
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
    // Sprinting drains its stamina (the progression engine's, half a second at a time).
    const sprintRequest = this.#requests.get(staged.reference);
    if (sprintRequest?.gait === 'sprint' && Math.hypot(velocity[0], velocity[1]) > 5)
      this.#sprinted(staged.reference, dt);
    const behavior = placed.behavior;
    if (behavior) {
      const request = sprintRequest;
      // It sprints while it asks to go at a sprint (its wish, not the speed physics made of it:
      // a horse galloping into a fence went in and out of its sprint many times a second).
      const moving = Math.hypot(mover.wish.velocity[0], mover.wish.velocity[1]) > 5;
      // Out of an animation-driven state (an idle, a stagger, furniture) while it still goes
      // its way: the engine, stopping an idle, performs the movement action again.
      const driven = mover.root.driven;
      if (mover.heldByGraph && !driven) mover.locomotion.resume([behavior]);
      mover.heldByGraph = driven;
      // Held by an animation-driven idle (bAnimationDriven: the dialogue idles MotionDrivenIdle
      // plays) while its AI sends it somewhere: the idle is stopped (its graph's IdleStop ends
      // it and clears bForceIdleStop), then it sets out as any actor does. Its graph leaves
      // standing on moveStart only without bBlendOutSlow and bForceIdleStop, which such an idle
      // sets: told moveStart alone, it never moved, and the idle never ended (Lokir stood in
      // the line while the archers waited for him to run).
      if (mover.rooted && mover.root.driven && request?.direction !== undefined) {
        const now = performance.now();
        if (now - mover.idleStoppedAt >= IDLE_STOP_AGAIN_MS) {
          mover.idleStoppedAt = now;
          this.#options.stopIdle?.(staged.reference);
        }
      }
      // What its steering wants (moved by its graph, a canned turn, a lunge: it stands, as far
      // as its graph is told), read by its graph's channels as the graph updates. Moved by its
      // graph, what it made is its clips' doing, not its controller's: fed back, a drawn bow's
      // slight root motion told it moved, its graph took the moving draw (no root motion), was
      // told it stood, and flipped every frame.
      const made: readonly [number, number] = mover.rooted ? [0, 0] : velocity;
      mover.locomotion.latch(behavior, {
        velocity: mover.feedback.feed(mover.wish.velocity, made, staged.heading, dt),
        turnRate: this.#turnRate(mover),
        heading: staged.heading,
        seconds: dt,
        grounded: mover.character.grounded,
        swimming: mover.character.swimming,
        verticalSpeed: mover.character.verticalSpeed,
        sprinting: moving && request?.gait === 'sprint',
        sneaking: this.#sneaking.has(staged.reference),
      });
    }
    // The trigger volumes it walked into and out of.
    if (physics.queriesCurrent) {
      const inside = physics.triggersOverlapping(mover.character.collider);
      // Its body reaches in too (a horse's head before its capsule: Tullius's horse crosses
      // MQ101SetStage20, a line across the road, as its patrol ends just short of it): every
      // fourth frame, each actor on a frame of its own (its bodies are many shapes).
      if ((this.#frames + staged.reference) % 4 === 0) {
        const reached = new Set<number>();
        for (const body of this.#options.bodyColliders?.(staged.reference) ?? []) {
          for (const trigger of physics.triggersOverlapping(body)) reached.add(trigger);
        }
        mover.bodyTriggers = reached;
      }
      for (const trigger of mover.bodyTriggers) inside.add(trigger);
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
