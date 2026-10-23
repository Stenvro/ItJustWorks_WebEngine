// The fliers of the stage (docs/ai.md, "Flying combat"; docs/m10-plan.md 5.4): actors of a race
// that flies (RACE DATA Flies: the dragons) take off, cruise, circle, hover, land (on the
// ground or on a dragon perch), grab an actor in flight and breathe their shouts, through
// their behavior graph as the engine drives it: the idle tree's ActionFlyStart, ActionFlyStop,
// ActionHoverStart and ActionHoverStop (their idles' conditions read GetFlyingState,
// GetIsHastyLandRequest, GetIsCrashLandRequest, GetIsInjured and the perch, the action's
// target), the flight grab's events (to_Flight_Kill_Grab_Enter, _Action, _Action_Failed), the
// graph's notify events telling the flying state (FlightTakeOff, FlightCruising,
// FlightHovering, FlightLanding, FlightPerching, FlightAction, LandEnd) and the variables the
// engine sets (TargetSpeed, TurnDelta, PitchDelta, MovementDirection, DistToGoal, TweenSpeed,
// HasTweenSpeed, TweenPosition, TweenRotation, TweenEntryDirection, Injured).
//
// In the air a flier has no character controller (src/shell/actor-movers.ts holds it off):
// while its graph is motion driven (neither bAnimationDriven nor bIsSynced: cruising) it
// steers for what it wants (src/ai/flight.ts) at the speed its graph flies (the graph's own
// Speed: its acceleration, drag and turns slowing it), kept over the ground; while it is
// animation driven (taking off, landing, hovering, the grab) its clips' root motion and the
// graph's tweeners (BSTweenerModifier: to TweenPosition) move it. What it wants is a
// FlightRequest: its combat's (fight: the combat style's flight section), its packages'
// (Hover, Orbit, FlightGrab, a Travel flown), else it circles where it is.

import {
  airborne,
  chooseFlightManeuver,
  diveBombPass,
  entryDirection,
  FLIGHT_DEFAULTS,
  fliesByRace,
  flyingAttack,
  FlyingState,
  flyingStateOf,
  headingRotation,
  hoverPoint,
  landingApproach,
  maneuverSeconds,
  orbitPoint,
  readFlightSettings,
  steerFlight,
  takesOff,
  type FlightManeuver,
  type FlightRequest,
  type FlightSettings,
  type FlyingStateValue,
} from '../ai/flight.ts';
import type { CombatStyleFlight } from '../ai/combat-style-records.ts';
import type { GraphEvent } from '../animation/graph-events.ts';
import type { ActorGraphSource } from './actor-graph-events.ts';
import { readIdleTree } from '../ai/idle-records.ts';
import { MovementCatalog } from '../ai/movement-types.ts';
import { parseRaceCombat } from '../ai/race-combat-records.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import type { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { Layer } from '../physics/collision-layers.ts';
import { multiply, transformPoint, type Vec3 } from '../render/math.ts';
import { ActorValue, actorValueIndex } from '../world/actor-values.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { parseFurniture } from '../world/furniture-records.ts';
import { seededRandom } from '../world/actors.ts';
import type { ActorFlightState, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { ActorCasting } from './actor-casting.ts';
import type { ActorFurniture, FurnitureUser, StageObject } from './actor-furniture.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

export interface ActorFlightOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly movers: ActorMovers;
  readonly furniture: ActorFurniture;
  readonly userOf: (staged: StagedActor) => FurnitureUser;
  readonly get: (reference: number) => StagedActor | undefined;
  /** Casting and shouting (their breath). */
  readonly casting: () => ActorCasting | undefined;
  /** The navigation meshes of the loaded area (where they land). */
  readonly navmeshes?: () => NavmeshSet | undefined;
  /** The enabled objects of the loaded area (the dragon perches). */
  readonly objects?: () => Iterable<StageObject>;
  /** The view shows an interior (no flying: CanFlyHere). */
  readonly interior: boolean;
  /** A flier without a controller flew into (or out of) a trigger volume. */
  readonly onTrigger?: (trigger: number, actor: number, entered: boolean) => void;
}

/** A target of a flier's fight, as combat sees it. */
export interface FlightTarget {
  readonly reference: number;
  readonly feet: Vec3;
  readonly height: number;
}

/** A flier's fight: its maneuver and its clock. */
interface FlierCombat {
  target: number;
  maneuver: FlightManeuver;
  /** When its maneuver ends (the flight's clock). */
  until: number;
  /** It breathes on this pass (its style's flying attack chance, rolled per maneuver). */
  breathes: boolean;
  /** A dive bomb's way: over the target, then past it. */
  pass: { readonly over: Vec3; readonly past: Vec3; overDone: boolean } | undefined;
  /** Where it lands to fight (a spot, or a perch). */
  landing: { readonly spot: Vec3; readonly perch: number | undefined } | undefined;
  /** When it came down to fight on the ground, and for how long. */
  landedAt: number | undefined;
  groundTime: number;
  clockwise: boolean;
}

/** One flier. */
interface Flier {
  readonly reference: number;
  staged: StagedActor;
  state: FlyingStateValue;
  /** An action asked of its graph, not answered yet (it is not asked again meanwhile). */
  asked: { readonly what: string; readonly at: number } | undefined;
  pitch: number;
  request: FlightRequest | undefined;
  /** The landing begun: its spot, heading and perch. */
  landing:
    | { readonly spot: Vec3; readonly heading: number; readonly perch: number | undefined }
    | undefined;
  /** The perch it is on (or landing on). */
  perch: number | undefined;
  /** A flight grab under way. */
  grab:
    | {
        readonly victim: number;
        readonly started: number;
        phase: 'approach' | 'enter' | 'carry' | 'done';
        readonly done: (grabbed: boolean) => void;
      }
    | undefined;
  combat: FlierCombat | undefined;
  /** What its packages ask (Hover, Orbit, FlightGrab, a travel flown): its own outside a fight. */
  package: FlightRequest | undefined;
  /**
   * Its travel flown: where to, whether it landed for it, how it ends; a place in the air (a
   * patrol's point over the ground) is flown through, not landed on.
   */
  travel:
    | {
        readonly to: Vec3;
        readonly arrive: number;
        readonly aloft: boolean;
        landing: boolean;
        readonly done: (arrived: boolean) => void;
      }
    | undefined;
  /** A package's perch it lands on and stays on (Sit on a DragonPerchTower: MQ101AlduinPerch1). */
  perching: { readonly perch: number; readonly done: (perched: boolean) => void } | undefined;
  /** The trigger volumes it is in while it has no controller (in the air, perched). */
  triggers: Set<number>;
  /** Its controller's shape when it had one (its size for blows in the air). */
  shape: { readonly radius: number; readonly height: number } | undefined;
  /** Placed in the air (no ground under it): it starts cruising. */
  checkedAir: boolean;
  /** Its flying movement type's speeds (walk, run forward) and turn rate. */
  speeds: { readonly walk: number; readonly run: number; readonly turn: number } | undefined;
  /** Where it circles with nothing to do (fixed as it begins to). */
  idle: Vec3 | undefined;
  /** A breath being begun (not begun twice). */
  breathing: boolean;
  /** Dragonrend on it (the DragonRend actor value): it may not fly, it crash-lands. */
  rended: boolean;
  /** When its health and DragonRend were last read. */
  valuesRead: number;
}

/** A flier asks its graph again after this long without an answer (seconds). */
const ASK_AGAIN = 3;
/** Placed with no ground within this under it, a flier starts in the air (units). */
const AIR_START = 512;
/** It begins its hover this far from the hover point (the hover-enter clips' 3584 forward). */
const HOVER_ENTER = 3584;
/** It begins its landing within this of the approach point (units). */
const APPROACH_REACH = 768;
/** It begins its flight grab this far from its victim (units). TODO(M13): the engine's. */
const GRAB_ENTER = 2048;
/** A grab takes hold of a victim within this of the talons as the enter clip ends (units). */
const GRAB_REACH = 512;
/** The bone the grabbed actor hangs from (the dragon's rear talons; TODO(M13): the engine's). */
const GRAB_BONE = 'NPC RLegFoot';
/** A flier breathes at a target within this angle of its facing (radians). */
const BREATH_ANGLE = Math.PI / 5;
/** Breath reaches at most this far without a projectile to say (units). */
const BREATH_RANGE = 2000;
/** A flier with nothing to do circles where it is this wide (units). */
const IDLE_ORBIT = 2048;
/** Its arrival at a travel's end within this (units, at least). */
const ARRIVE = 256;
/**
 * A flier's size for trigger volumes before it had a controller (units; a dragon's skeleton
 * bound is about this wide).
 */
const FLIER_RADIUS = 256;
/** GetIsID's condition function index, and a condition run on its target (ConditionRunOn). */
const GET_IS_ID = 72;
const RUN_ON_TARGET = 1;
/** A flier's health and Dragonrend are read this often (seconds). */
const VALUES_SECONDS = 1;
/** A flight grab gives up after this long (seconds). */
const GRAB_LIMIT = 30;

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const distance3 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ActorFlight {
  readonly #options: ActorFlightOptions;
  readonly #fliers = new Map<number, Flier>();
  /** The actors carried in a flier's talons now (no controller of their own). */
  readonly #grabbed = new Set<number>();
  readonly #random = seededRandom(0xf1a7);
  #settings: FlightSettings = FLIGHT_DEFAULTS;
  #settingsRead = false;
  #catalog: MovementCatalog | undefined;
  #catalogRead = false;
  /** Perch furniture by base (whether it is one: its interaction keyword), read once each. */
  readonly #perchBases = new Map<number, Promise<number | undefined>>();
  readonly #perchKeywords = new Map<number, number | undefined>();
  /** Perches taken, by perch: the flier on it or landing on it. */
  readonly #perchUsers = new Map<number, number>();
  /** Shouts each flier knows (read once). */
  readonly #shouts = new Map<number, Promise<number[]>>();
  #clock = 0;

  constructor(options: ActorFlightOptions) {
    this.#options = options;
  }

  // --- What others ask --------------------------------------------------------------------

  /** Whether an actor flies at all (its race flies, it lives). */
  flies(reference: number): boolean {
    const staged = this.#options.get(reference);
    return staged !== undefined && !staged.dead && fliesByRace(staged.placed.look.raceFlags);
  }

  /** Whether it may fly now: a flier allowed to (SetAllowFlying) where flying is (CanFlyHere). */
  mayFly(reference: number): boolean {
    return this.flies(reference) && this.allowed(reference) && this.canFlyHere();
  }

  /** SetAllowFlying (the game state's; true unless a script said no). */
  allowed(reference: number): boolean {
    if (this.#fliers.get(reference)?.rended === true) return false;
    return this.#options.session.scriptsReady?.state.actors.get(reference)?.allowFlying !== false;
  }

  /** CanFlyHere: outside (interiors have no sky to fly). TODO(M13): worldspaces' own rule. */
  canFlyHere(): boolean {
    return !this.#options.interior;
  }

  /** GetFlyingState (FlyingState): 0 on the ground. */
  state(reference: number): FlyingStateValue {
    return this.#fliers.get(reference)?.state ?? FlyingState.none;
  }

  /** IsFlying: in the air (taking off, cruising, hovering, landing, an action). */
  isFlying(reference: number): boolean {
    return airborne(this.state(reference));
  }

  /** Whether the flight holds an actor (it has no controller): in the air, taking off, perched. */
  holds(reference: number): boolean {
    const flier = this.#fliers.get(reference);
    if (this.#grabbed.has(reference)) return true;
    return (
      flier !== undefined && (flier.state !== FlyingState.none || flier.asked?.what === 'takeoff')
    );
  }

  /** GetIsHastyLandRequest, GetIsCrashLandRequest: how its landing was asked for. */
  landRequest(reference: number): 'hasty' | 'crash' | undefined {
    const request = this.#fliers.get(reference)?.request;
    return request?.kind === 'land' ? request.how : undefined;
  }

  /** What the scripts and conditions read of a flier (undefined: not one). */
  scriptState(reference: number): ActorFlightState | undefined {
    if (!this.flies(reference)) return undefined;
    return {
      state: this.state(reference),
      landRequest: this.landRequest(reference),
      canFlyHere: this.canFlyHere(),
    };
  }

  /** The size it had on the ground (blows reach it by it in the air too). */
  shape(reference: number): { readonly radius: number; readonly height: number } | undefined {
    return this.#fliers.get(reference)?.shape;
  }

  /** What a flier is asked to do now (undefined: circle where it is, or stay on the ground). */
  request(reference: number, request: FlightRequest | undefined): void {
    const flier = this.#flier(reference);
    if (!flier) return;
    flier.package = request;
  }

  requestOf(reference: number): FlightRequest | undefined {
    return this.#fliers.get(reference)?.request;
  }

  /**
   * A travel flown (a package's way for a flier): it flies to the place and lands there
   * (on the navmesh near it); resolves true once it stands there, false if it is sent
   * elsewhere or cannot fly.
   */
  travel(reference: number, to: Vec3, arrive: number): Promise<boolean> {
    const flier = this.#flier(reference);
    if (!flier || !this.mayFly(reference)) return Promise.resolve(false);
    flier.travel?.done(false);
    flier.perching?.done(false);
    // A place high over the ground (MQ101AlduinApproachPatrol's points, 2,000 to 4,000 units
    // up) is flown to at its height and through: it arrives where it circles (IDLE_ORBIT).
    // TODO(M13): the engine's rule for a flier's travel to a point in the air.
    const ground = this.#groundUnder(to);
    const aloft = ground !== undefined && to[2] - ground > AIR_START;
    return new Promise((resolve) => {
      const travel = {
        to,
        arrive: Math.max(arrive, aloft ? IDLE_ORBIT / 2 : ARRIVE),
        aloft,
        landing: false,
        done: (arrived: boolean): void => {
          if (flier.travel !== travel) return;
          flier.travel = undefined;
          if (flier.package?.kind === 'cruise' || flier.package?.kind === 'land') {
            flier.package = undefined;
          }
          resolve(arrived);
        },
      };
      flier.travel = travel;
      flier.package = {
        kind: 'cruise',
        to: aloft ? [...to] : raised(to, this.#settings.orbitHeight),
      };
    });
  }

  /**
   * A package's perch (Sit on dragon perch furniture: MQ101AlduinPerch1 on the Helgen tower's
   * DragonPerchTower): it flies there and lands on it (ActionFlyStop with the perch as target:
   * FlyStopPerch*, its FlightLanding and TowerLandImpact), resolving true once it perches;
   * it stays until leavePerch. False if it cannot fly or is sent elsewhere.
   */
  async perch(reference: number, perch: number): Promise<boolean> {
    const flier = this.#flier(reference);
    const at =
      this.#perchPlace(perch) ??
      (await this.#options.session.scriptsReady?.placement(perch))?.position;
    if (!flier || !at || !this.mayFly(reference)) return false;
    flier.travel?.done(false);
    flier.perching?.done(false);
    if (flier.state === FlyingState.perching && flier.perch === perch) {
      flier.package = { kind: 'land', at: [...at], perch };
      return true;
    }
    return new Promise((resolve) => {
      const perching = {
        perch,
        done: (perched: boolean): void => {
          if (flier.perching !== perching) return;
          flier.perching = undefined;
          resolve(perched);
        },
      };
      flier.perching = perching;
      flier.package = { kind: 'land', at: [...at], perch };
    });
  }

  /** Whether a reference is perch furniture a flier lands on (the idle tree's perches). */
  async isPerch(reference: number): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return false;
    const [perches, base] = await Promise.all([this.#perchSet(), runtime.baseOf(reference)]);
    return base !== undefined && perches.has(base);
  }

  /** Its package let go of its perch: it takes off from it (and does what it is asked next). */
  leavePerch(reference: number): void {
    const flier = this.#fliers.get(reference);
    if (!flier) return;
    flier.perching?.done(false);
    if (flier.package?.kind === 'land' && flier.package.perch !== undefined) {
      flier.package = undefined;
    }
  }

  /** A flight grab (the FlightGrab procedure): resolves whether it took the victim. */
  grab(reference: number, victim: number): Promise<boolean> {
    const flier = this.#flier(reference);
    if (!flier || !this.mayFly(reference)) return Promise.resolve(false);
    flier.grab?.done(false);
    return new Promise((resolve) => {
      const grab = {
        victim,
        started: this.#clock,
        phase: 'approach' as 'approach' | 'enter' | 'carry' | 'done',
        done: (grabbed: boolean): void => {
          if (flier.grab !== grab) return;
          flier.grab = undefined;
          this.#grabbed.delete(victim);
          if (flier.package?.kind === 'grab') flier.package = undefined;
          resolve(grabbed);
        },
      };
      flier.grab = grab;
      flier.package = { kind: 'grab', victim };
    });
  }

  /** The point a flier's graph watches it pass (DragonPassByEffect): its combat target. */
  passByTarget(reference: number): Vec3 | undefined {
    const target = this.#fliers.get(reference)?.combat?.target;
    return target === undefined ? undefined : this.#options.get(target)?.position;
  }

  // --- Combat ------------------------------------------------------------------------------

  /**
   * One frame of a flier's fight (the combat AI asks it of fliers that may fly): its next
   * maneuver by its style's flight section as one ends (orbit, dive bomb, hover, perch attack,
   * landing to fight on the ground), its breath at the target. True while the flight has it (in
   * the air, landing, perched); false while it fights on the ground (the combat AI's melee
   * fights then, until its ground time is over and it takes off again).
   */
  fight(reference: number, target: FlightTarget, flight: CombatStyleFlight): boolean {
    const flier = this.#flier(reference);
    if (!flier) return false;
    const settings = this.#settings;
    let combat = flier.combat;
    if (combat?.target !== target.reference) {
      combat = {
        target: target.reference,
        maneuver: 'orbit',
        until: this.#clock + settings.orbitTime * (0.5 + this.#random()),
        breathes: flyingAttack(flight, this.#random),
        pass: undefined,
        landing: undefined,
        landedAt: flier.state === FlyingState.none ? this.#clock : undefined,
        groundTime: maneuverSeconds('ground', flight, settings, this.#random),
        clockwise: this.#random() < 0.5,
      };
      flier.combat = combat;
    }
    const here = flier.staged.position;
    // On the ground: it fights there for its ground time, then takes off (its target far: at once).
    if (flier.state === FlyingState.none && flier.asked?.what !== 'takeoff') {
      combat.landedAt ??= this.#clock;
      if (
        !takesOff({
          onGround: this.#clock - combat.landedAt,
          groundTime: combat.groundTime,
          targetDistance: flat(here, target.feet),
          orbitDistance: settings.orbitDistance,
        })
      ) {
        flier.request = undefined;
        return false;
      }
      combat.landedAt = undefined;
      this.#next(flier, combat, flight, target, 'orbit');
    }
    // Perched: it breathes from there for its perch time, then takes off.
    if (flier.state === FlyingState.perching && this.#clock >= combat.until) {
      this.#next(flier, combat, flight, target, 'orbit');
    }
    // Hurt (its race's injured health: the graph's Injured), it comes down to fight on the
    // ground (the idle tree's FlyStopInjured). TODO(M13): the engine's rule.
    const injured = flier.staged.placed.behavior?.variable('Injured') === 1;
    if (
      injured &&
      airborne(flier.state) &&
      combat.maneuver !== 'land' &&
      combat.maneuver !== 'perch'
    ) {
      this.#next(flier, combat, flight, target, 'land');
    } else if (this.#clock >= combat.until && combat.maneuver !== 'land') {
      this.#choose(flier, combat, flight, target);
    }
    this.#maneuver(flier, combat, flight, target);
    // Its breath: at the target before it within reach, by its style (passes: once rolled).
    const breathes =
      combat.breathes ||
      flier.state === FlyingState.hovering ||
      flier.state === FlyingState.perching;
    if (breathes && !flier.breathing) {
      flier.breathing = true;
      void this.#breathe(flier, target)
        .catch((error: unknown) => {
          this.#warn(`${reference.toString(16)} breath: ${describe(error)}`);
        })
        .finally(() => {
          flier.breathing = false;
        });
    }
    return true;
  }

  /** Its fight ended: it circles where it is (its packages take it from there). */
  endFight(reference: number): void {
    const flier = this.#fliers.get(reference);
    if (!flier?.combat) return;
    flier.combat = undefined;
    flier.request = flier.package;
  }

  /** The next maneuver as one ends: by the style's chances, what is near the target. */
  #choose(
    flier: Flier,
    combat: FlierCombat,
    flight: CombatStyleFlight,
    target: FlightTarget,
  ): void {
    const perch = this.#freePerch(flier, target.feet) !== undefined;
    const spot = this.#landingSpot(flier, target.feet);
    const maneuver = chooseFlightManeuver(
      flight,
      { canLand: spot !== undefined && this.allowed(flier.reference), perch },
      this.#random,
    );
    this.#next(flier, combat, flight, target, maneuver);
  }

  #next(
    flier: Flier,
    combat: FlierCombat,
    flight: CombatStyleFlight,
    target: FlightTarget,
    maneuver: FlightManeuver,
  ): void {
    const settings = this.#settings;
    combat.maneuver = maneuver;
    combat.breathes = flyingAttack(flight, this.#random);
    combat.pass = undefined;
    combat.landing = undefined;
    switch (maneuver) {
      case 'hover':
        combat.until = this.#clock + maneuverSeconds('hover', flight, settings, this.#random);
        break;
      case 'perch': {
        const perch = this.#freePerch(flier, target.feet);
        const at = perch === undefined ? undefined : this.#perchPlace(perch);
        if (perch === undefined || !at) {
          this.#next(flier, combat, flight, target, 'orbit');
          return;
        }
        combat.landing = { spot: at, perch };
        combat.until = Infinity;
        break;
      }
      case 'land': {
        const spot = this.#landingSpot(flier, target.feet);
        if (!spot) {
          this.#next(flier, combat, flight, target, 'orbit');
          return;
        }
        combat.landing = { spot, perch: undefined };
        combat.groundTime = maneuverSeconds('ground', flight, settings, this.#random);
        combat.until = Infinity;
        break;
      }
      case 'diveBomb': {
        const pass = diveBombPass(
          flier.staged.position,
          target.feet,
          settings.diveBombHeight,
          settings.orbitDistance / 2,
        );
        combat.pass = { ...pass, overDone: false };
        combat.until = Infinity;
        break;
      }
      default:
        combat.until = this.#clock + settings.orbitTime * (0.75 + 0.5 * this.#random());
        combat.clockwise = this.#random() < 0.5 ? !combat.clockwise : combat.clockwise;
    }
  }

  /** What its maneuver asks of its flight this frame. */
  #maneuver(
    flier: Flier,
    combat: FlierCombat,
    flight: CombatStyleFlight,
    target: FlightTarget,
  ): void {
    const settings = this.#settings;
    const here = flier.staged.position;
    switch (combat.maneuver) {
      case 'hover':
        flier.request = {
          kind: 'hover',
          at: hoverPoint(here, target.feet, settings.hoverDistance, settings.hoverHeight),
          face: [target.feet[0], target.feet[1], target.feet[2] + target.height * 0.75],
        };
        return;
      case 'diveBomb': {
        const pass = combat.pass;
        if (!pass) return;
        // Over the target (or past it: too fast to turn onto it), then on to beyond it.
        if (!pass.overDone && passed(here, flier.staged.heading, pass.over)) pass.overDone = true;
        if (pass.overDone && passed(here, flier.staged.heading, pass.past)) {
          this.#next(flier, combat, flight, target, 'orbit');
          return;
        }
        flier.request = { kind: 'cruise', to: pass.overDone ? pass.past : pass.over, fast: true };
        return;
      }
      case 'perch':
      case 'land': {
        const landing = combat.landing;
        if (!landing) return;
        // Down: on the perch for its perch time; on the ground (the combat AI fights there).
        if (flier.state === FlyingState.perching && combat.until === Infinity) {
          combat.until = this.#clock + maneuverSeconds('perch', flight, settings, this.#random);
        }
        flier.request = {
          kind: 'land',
          at: landing.spot,
          heading: Math.atan2(target.feet[0] - landing.spot[0], target.feet[1] - landing.spot[1]),
          ...(landing.perch !== undefined && { perch: landing.perch }),
        };
        if (flier.state === FlyingState.none && flier.asked === undefined) {
          combat.landedAt = this.#clock;
        }
        return;
      }
      default:
        flier.request = {
          kind: 'orbit',
          center: target.feet,
          radius: settings.orbitDistance,
          height: settings.orbitHeight,
          clockwise: combat.clockwise,
        };
    }
  }

  /**
   * It breathes at its target (its shouts: the casting system's shoutAt, the one it uses
   * chosen at random among those it knows) when the target is before it within the breath's
   * reach and its voice has recovered; the graph's neck states play the inhale and exhale.
   */
  async #breathe(flier: Flier, target: FlightTarget): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const casting = this.#options.casting();
    if (!runtime || !casting) return;
    const reference = flier.reference;
    if (runtime.casting.isShouting(reference)) return;
    if ((runtime.state.actors.get(reference)?.voiceRecoveryTime ?? 0) > 0) return;
    if (flier.state === FlyingState.takeOff || flier.state === FlyingState.landing) return;
    if (flier.asked !== undefined || flier.grab) return;
    const here = flier.staged.position;
    const aim = [target.feet[0], target.feet[1], target.feet[2] + target.height * 0.75] as const;
    const facing = Math.atan2(aim[0] - here[0], aim[1] - here[1]);
    const off = Math.atan2(
      Math.sin(facing - flier.staged.heading),
      Math.cos(facing - flier.staged.heading),
    );
    if (Math.abs(off) > BREATH_ANGLE) return;
    const shouts = await this.#knownShouts(runtime, reference);
    const shout = shouts[Math.floor(this.#random() * shouts.length)];
    if (shout === undefined) return;
    const range = await this.#shoutRange(runtime, shout);
    if (distance3(here, [aim[0], aim[1], aim[2]]) > range) return;
    if (runtime.casting.isShouting(reference)) return;
    if ((await runtime.equipment.of(reference)).voice !== shout) {
      await runtime.equipment.equipShout(reference, shout);
    }
    await casting.shoutAt(reference, target.reference);
  }

  /** The shouts an actor knows (its spell list's SHOU), read once. */
  #knownShouts(runtime: ScriptRuntime, reference: number): Promise<number[]> {
    let entry = this.#shouts.get(reference);
    if (!entry) {
      entry = (async (): Promise<number[]> => {
        const found: number[] = [];
        for (const id of await runtime.actors.spells(reference)) {
          if ((await runtime.forms.record(id))?.type === 'SHOU') found.push(id);
        }
        return found;
      })().catch(() => []);
      this.#shouts.set(reference, entry);
    }
    return entry;
  }

  /** How far a shout's breath reaches: its last word's projectile's range. */
  async #shoutRange(runtime: ScriptRuntime, shout: number): Promise<number> {
    const record = await runtime.casting.shout(shout);
    const word = record?.words.at(-1);
    const item = word ? await runtime.magic.item(word.spell) : undefined;
    const effect = item ? await runtime.casting.mainEffect(item) : undefined;
    const projectile =
      effect?.projectile === undefined
        ? undefined
        : await runtime.casting.projectile(effect.projectile);
    return projectile && projectile.range > 0 ? projectile.range : BREATH_RANGE;
  }

  // --- The frame ---------------------------------------------------------------------------

  /**
   * Every frame (seconds since the last), after the movers and before the skeletons animate:
   * each flier of the stage hears its graph, takes off or lands as asked, and steers while its
   * graph is motion driven.
   */
  frame(actors: Iterable<StagedActor>, seconds: number): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    this.#clock += seconds;
    this.#readSettings();
    this.#readCatalog();
    const seen = new Set<number>();
    for (const staged of actors) {
      if (staged.dead || staged.visibility.hidden) continue;
      if (!fliesByRace(staged.placed.look.raceFlags)) continue;
      seen.add(staged.reference);
      const flier = this.#flier(staged.reference);
      if (!flier) continue;
      flier.staged = staged;
      try {
        this.#update(flier, runtime, seconds);
      } catch (error) {
        this.#warn(`${staged.reference.toString(16)}: ${describe(error)}`);
      }
    }
    for (const reference of [...this.#fliers.keys()]) {
      if (!seen.has(reference)) this.remove(reference);
    }
  }

  /**
   * After the skeletons animated: an animation-driven flier in the air (taking off, landing,
   * hovering, grabbing, perched) moves by its graph's root motion (its tweeners' with it).
   */
  animated(staged: StagedActor, seconds: number): void {
    const flier = this.#fliers.get(staged.reference);
    const behavior = staged.placed.behavior;
    if (!flier || !behavior || seconds <= 0 || !this.holds(staged.reference)) return;
    if (!animationDriven(behavior)) return;
    const { translation, yaw } = behavior.rootMotion();
    const [x, y, z] = translation;
    const sin = Math.sin(staged.heading);
    const cos = Math.cos(staged.heading);
    staged.position = [
      staged.position[0] + x * cos + y * sin,
      staged.position[1] - x * sin + y * cos,
      staged.position[2] + z,
    ];
    // Counter-clockwise turns lower the compass heading.
    staged.heading -= yaw;
    this.#draw(flier);
  }

  #update(flier: Flier, runtime: ScriptRuntime, seconds: number): void {
    const staged = flier.staged;
    const reference = flier.reference;
    const behavior = staged.placed.behavior;
    if (!behavior) return;
    // Its size, while it has a controller.
    const radius = this.#options.movers.radius(reference);
    const height = this.#options.movers.height(reference);
    if (radius !== undefined && height !== undefined) flier.shape = { radius, height };
    this.#triggerFrame(flier, radius === undefined);
    // Injured (the graph's Injured: its flight hurt, its landings crashing) and Dragonrend.
    if (this.#clock - flier.valuesRead >= VALUES_SECONDS) {
      flier.valuesRead = this.#clock;
      void this.#readValues(flier, runtime, behavior).catch(() => undefined);
    }
    if (flier.asked && this.#clock - flier.asked.at > ASK_AGAIN) flier.asked = undefined;
    // Placed in the air: it starts cruising there.
    if (!flier.checkedAir && staged.grounded) {
      flier.checkedAir = true;
      if (
        flier.state === FlyingState.none &&
        this.mayFly(reference) &&
        this.#highAboveGround(staged)
      ) {
        if (behavior.sendEvent('FlyStartCruise')) flier.state = FlyingState.cruising;
      }
    }
    this.#grabFrame(flier, behavior);
    this.#travelFrame(flier);
    // Outside a fight it does what its packages ask.
    if (!flier.combat) flier.request = flier.package;
    const request = flier.request;
    if (flier.state === FlyingState.none) {
      // On the ground: it takes off for what it wants in the air.
      if (
        flier.asked === undefined &&
        request &&
        wantsAir(request, staged.position) &&
        this.mayFly(reference)
      ) {
        this.#takeOff(flier, behavior, request);
        this.#options.movers.release(reference);
      }
      return;
    }
    if (flier.state === FlyingState.perching) {
      // On a perch: off again for anything but its landing there.
      const stays =
        request?.kind === 'land' && request.perch !== undefined && request.perch === flier.perch;
      if (!stays && flier.asked === undefined && this.mayFly(reference)) {
        this.#takeOff(flier, behavior, request);
      }
      this.#face(flier, behavior, request);
      return;
    }
    if (flier.state === FlyingState.hovering) {
      this.#hover(flier, behavior, request);
      return;
    }
    if (flier.state !== FlyingState.cruising || flier.asked !== undefined) return;
    if (animationDriven(behavior)) return;
    // Not allowed to fly any more (SetAllowFlying false, a script): it lands where it can.
    const goal = this.allowed(reference) ? request : this.#landNear(flier);
    this.#cruise(flier, behavior, goal, seconds);
  }

  /** Cruising for what it wants: steering, and the hover, landing and grab begun near them. */
  #cruise(
    flier: Flier,
    behavior: BehaviorRuntime,
    request: FlightRequest | undefined,
    seconds: number,
  ): void {
    const staged = flier.staged;
    const here = staged.position;
    const settings = this.#settings;
    let goal: Vec3;
    let stopAt: Vec3 | undefined;
    let fast = false;
    switch (request?.kind) {
      case 'cruise':
        goal = request.to;
        fast = request.fast === true;
        // Arrived: it circles there.
        if (flat(here, request.to) < IDLE_ORBIT / 2) {
          goal = orbitPoint(request.to, IDLE_ORBIT, 0, here, true);
        }
        break;
      case 'orbit':
        goal = orbitPoint(
          request.center,
          request.radius,
          request.height,
          here,
          request.clockwise ?? true,
        );
        break;
      case 'hover': {
        goal = request.at;
        stopAt = request.at;
        if (distance3(here, request.at) <= HOVER_ENTER) {
          this.#tween(behavior, request.at, faceHeading(request.at, request.face), staged.heading);
          this.#ask(flier, 'hover', 'ActionHoverStart');
          return;
        }
        break;
      }
      case 'land': {
        const approach = landingApproach(request.at, here);
        goal = approach;
        stopAt = approach;
        if (distance3(here, approach) <= APPROACH_REACH) {
          this.#land(flier, behavior, request);
          return;
        }
        break;
      }
      case 'grab': {
        const victim = this.#options.get(request.victim);
        if (!victim || victim.dead) {
          flier.grab?.done(false);
          return;
        }
        goal = [
          victim.position[0],
          victim.position[1],
          victim.position[2] + settings.diveBombHeight,
        ];
        if (distance3(here, victim.position) <= GRAB_ENTER && flier.grab?.phase === 'approach') {
          const heading = Math.atan2(victim.position[0] - here[0], victim.position[1] - here[1]);
          this.#tween(behavior, victim.position, heading, staged.heading);
          behavior.setVariable('TweenEntryDirectionFlightKillGrab', 0);
          if (behavior.sendEvent('to_Flight_Kill_Grab_Enter')) flier.grab.phase = 'enter';
          return;
        }
        fast = true;
        break;
      }
      default: {
        // Nothing asked: it circles where it began to.
        flier.idle ??= [...here];
        goal = orbitPoint(flier.idle, IDLE_ORBIT, 0, here, true);
      }
    }
    if (request) flier.idle = undefined;
    this.#steer(flier, behavior, goal, stopAt, fast, seconds);
  }

  /** One step of steering for a goal at the graph's speed, kept over the ground. */
  #steer(
    flier: Flier,
    behavior: BehaviorRuntime,
    goal: Vec3,
    stopAt: Vec3 | undefined,
    fast: boolean,
    seconds: number,
  ): void {
    const staged = flier.staged;
    const speeds = flier.speeds ?? this.#speeds(flier);
    const graphSpeed = behavior.variable('Speed');
    // The graph flies at its own Speed (its acceleration, drag and turns), towards TargetSpeed.
    const speed = graphSpeed !== undefined && graphSpeed > 0 ? graphSpeed : speeds.walk;
    const ground = this.#groundUnder(staged.position);
    const clearance = this.#settings.groundClearance;
    const safe: Vec3 =
      ground !== undefined && goal[2] < ground + clearance
        ? [goal[0], goal[1], ground + clearance]
        : goal;
    const step = steerFlight(
      { position: staged.position, heading: staged.heading, pitch: flier.pitch },
      safe,
      speed,
      speeds.turn,
      seconds,
    );
    flier.pitch = step.pitch;
    let next = step.position;
    // Never into the ground under it.
    const below = this.#groundUnder(next);
    if (below !== undefined && next[2] < below + clearance / 2)
      next = [next[0], next[1], below + clearance / 2];
    staged.position = [...next];
    staged.heading = step.heading;
    behavior.setVariable('TargetSpeed', fast ? speeds.run : speeds.walk);
    behavior.setVariable('TurnDelta', step.turnDelta);
    behavior.setVariable('PitchDelta', step.pitchDelta);
    behavior.setVector('MovementDirection', [...step.direction, 0]);
    if (stopAt) {
      const left = distance3(staged.position, stopAt);
      behavior.setVariable('HasTweenSpeed', 1);
      behavior.setVariable('DistToGoal', left);
      // It slows towards its stop (TODO(M13): the engine's arrival speed).
      behavior.setVariable('TweenSpeed', Math.min(speeds.walk, left));
    } else {
      behavior.setVariable('HasTweenSpeed', 0);
      behavior.setVariable('DistToGoal', distance3(staged.position, goal));
    }
    this.#draw(flier);
  }

  /** Hovering: it turns to face what it hovers for; another wish ends the hover. */
  #hover(flier: Flier, behavior: BehaviorRuntime, request: FlightRequest | undefined): void {
    if (flier.asked !== undefined) return;
    const here = flier.staged.position;
    const stays = request?.kind === 'hover' && distance3(here, request.at) <= HOVER_ENTER / 2;
    if (!stays) {
      behavior.setVariable('TurnDelta', 0);
      this.#ask(flier, 'unhover', 'ActionHoverStop');
      return;
    }
    this.#face(flier, behavior, request);
  }

  /** Turning in place (hovering, perched) to face what it wants to face (the graph turns it). */
  #face(flier: Flier, behavior: BehaviorRuntime, request: FlightRequest | undefined): void {
    const here = flier.staged.position;
    const face =
      request?.kind === 'hover'
        ? request.face
        : flier.combat
          ? this.#options.get(flier.combat.target)?.position
          : undefined;
    if (!face) {
      behavior.setVariable('TurnDelta', 0);
      return;
    }
    const want = Math.atan2(face[0] - here[0], face[1] - here[1]);
    const off = Math.atan2(
      Math.sin(want - flier.staged.heading),
      Math.cos(want - flier.staged.heading),
    );
    // Left positive, degrees a second: the hover turn clips turn it (90° a second).
    behavior.setVariable('TurnDelta', Math.abs(off) < 0.1 ? 0 : -Math.sign(off) * 90);
  }

  /**
   * It takes off (ActionFlyStart: off the ground, or off its perch), turning as it rises to
   * where it goes (the take-off's tweener: TweenRotation).
   */
  #takeOff(flier: Flier, behavior: BehaviorRuntime, request: FlightRequest | undefined): void {
    const staged = flier.staged;
    const to = request && goalOf(request, this.#options.get);
    const heading = to
      ? Math.atan2(to[0] - staged.position[0], to[1] - staged.position[1])
      : staged.heading;
    this.#tween(behavior, staged.position, heading, staged.heading);
    this.#ask(flier, 'takeoff', 'ActionFlyStart');
  }

  /** It begins its landing: the spot and its heading for the tweener, then ActionFlyStop. */
  #land(
    flier: Flier,
    behavior: BehaviorRuntime,
    request: Extract<FlightRequest, { kind: 'land' }>,
  ): void {
    const staged = flier.staged;
    const heading =
      request.heading ??
      Math.atan2(request.at[0] - staged.position[0], request.at[1] - staged.position[1]);
    this.#tween(behavior, request.at, heading, staged.heading);
    flier.landing = { spot: request.at, heading, perch: request.perch };
    if (request.perch !== undefined) this.#perchUsers.set(request.perch, flier.reference);
    const runtime = this.#options.session.scriptsReady;
    const target =
      request.perch === undefined || !runtime ? undefined : runtime.referenceHandle(request.perch);
    this.#ask(flier, 'land', 'ActionFlyStop', target);
  }

  /**
   * Not allowed to fly: a landing near where it is (on the navmesh), else none: a crash landing
   * under Dragonrend (unless SetAllowFlyingEx forbade crashing), else a hasty one.
   * TODO(M13): how the engine lands a flier a script grounds.
   */
  #landNear(flier: Flier): FlightRequest | undefined {
    const spot = this.#landingSpot(flier, flier.staged.position);
    if (!spot) return undefined;
    const crash =
      flier.rended &&
      this.#options.session.scriptsReady?.state.actors.get(flier.reference)?.allowCrashLand !==
        false;
    return { kind: 'land', at: spot, how: crash ? 'crash' : 'hasty' };
  }

  /** The tweener's target: where it ends (TweenPosition), facing (TweenRotation), the entry blend. */
  #tween(behavior: BehaviorRuntime, at: Vec3, heading: number, from: number): void {
    behavior.setVector('TweenPosition', [at[0], at[1], at[2], 0]);
    behavior.setVector('TweenRotation', headingRotation(heading));
    behavior.setVariable('TweenEntryDirection', entryDirection(from, heading));
  }

  /** An action through its idle tree, remembered until its graph answers. */
  #ask(
    flier: Flier,
    what: string,
    action: string,
    target?: ReturnType<ScriptRuntime['referenceHandle']>,
  ): void {
    flier.asked = { what, at: this.#clock };
    void this.#options.furniture
      .playAction(this.#options.userOf(flier.staged), action, target, target === undefined)
      .then((played) => {
        if (!played && flier.asked?.what === what) flier.asked = undefined;
      })
      .catch((error: unknown) => {
        if (flier.asked?.what === what) flier.asked = undefined;
        this.#warn(`${flier.reference.toString(16)} ${action}: ${describe(error)}`);
      });
  }

  /** A travel flown: on its way it cruises there; there it lands near; landed it ends. */
  #travelFrame(flier: Flier): void {
    const travel = flier.travel;
    if (!travel) return;
    const here = flier.staged.position;
    if (flier.state === FlyingState.none && flier.asked === undefined) {
      // Landed where it went (as near as the navmesh let it), or there already.
      if (travel.landing || flat(here, travel.to) <= travel.arrive) travel.done(true);
      else if (flier.package?.kind !== 'cruise' && flier.package?.kind !== 'land') {
        flier.package = {
          kind: 'cruise',
          to: travel.aloft ? [...travel.to] : raised(travel.to, this.#settings.orbitHeight),
        };
      }
      return;
    }
    // A place in the air: there once it flies within reach of it (on to the next point).
    if (travel.aloft) {
      if (distance3(here, travel.to) <= travel.arrive) travel.done(true);
      return;
    }
    if (flier.package?.kind === 'cruise' && flat(here, travel.to) <= IDLE_ORBIT) {
      const spot =
        this.#options.navmeshes?.()?.nearest?.(travel.to, travel.arrive * 4) ?? travel.to;
      flier.package = { kind: 'land', at: [spot[0], spot[1], spot[2]] };
    }
    if (flier.state === FlyingState.landing && flier.package?.kind === 'land') {
      travel.landing = true;
    }
  }

  /** A flight grab: its victim taken at the end of the enter clip, carried, let go. */
  #grabFrame(flier: Flier, behavior: BehaviorRuntime): void {
    const grab = flier.grab;
    // It gives up after a while (its victim out of reach, its graph not answering).
    if (grab && grab.phase !== 'carry' && this.#clock - grab.started > GRAB_LIMIT) {
      grab.done(false);
      return;
    }
    if (grab?.phase !== 'carry') return;
    const victim = this.#options.get(grab.victim);
    if (!victim) {
      grab.done(false);
      return;
    }
    // It hangs from the talons, at the graph's ConstraintOffset in the talon's frame.
    const placed = flier.staged.placed;
    const node = placed.pose.world(GRAB_BONE);
    const instance = placed.instances[0];
    if (!node || !instance) return;
    const offset = behavior.vector('ConstraintOffset') ?? [0, 0, 0, 0];
    const at = transformPoint(multiply(instance.world, node), [offset[0], offset[1], offset[2]]);
    victim.position = [at[0], at[1], at[2] - (this.#options.movers.height(grab.victim) ?? 0)];
    const world = victim.placed.instances[0];
    if (world?.motion) {
      world.world.set(
        referenceMatrix({
          position: victim.position,
          rotation: [0, 0, victim.heading],
          scale: victim.placed.actor.scale * victim.placed.look.scale,
        }),
      );
      world.motion.version++;
    }
  }

  // --- The graph's events -------------------------------------------------------------------

  /**
   * What a flier's graph raised (the stage's dispatch, src/shell/actor-graph-events.ts): its
   * flight states (the engine's Flight*Handler answers of FlightTakeOff, FlightCruising, ...),
   * its grab's steps, its breath's end.
   */
  graphEvents(source: ActorGraphSource, events: readonly GraphEvent[]): void {
    const flier = this.#fliers.get(source.reference);
    if (flier?.staged.placed !== source.skeleton) return;
    for (const event of events) this.#heard(flier, event.name);
  }

  #heard(flier: Flier, event: string): void {
    const state = flyingStateOf(event);
    if (state !== undefined) this.#stateChanged(flier, state, event);
    const behavior = flier.staged.placed.behavior;
    switch (event.toLowerCase()) {
      case 'flightactionentryend': {
        // The talons reach: the victim taken if it is there, else the grab fails.
        const grab = flier.grab;
        if (!grab || !behavior) return;
        const victim = this.#options.get(grab.victim);
        const near =
          victim !== undefined &&
          !victim.dead &&
          distance3(flier.staged.position, victim.position) <= GRAB_REACH * 4;
        behavior.sendEvent(
          near ? 'to_Flight_Kill_Grab_Action' : 'to_Flight_Kill_Grab_Action_Failed',
        );
        if (!near) grab.done(false);
        return;
      }
      case 'flightactiongrab': {
        const grab = flier.grab;
        if (!grab) return;
        grab.phase = 'carry';
        // Its victim is held: no controller of its own meanwhile.
        this.#grabbed.add(grab.victim);
        this.#options.movers.release(grab.victim);
        return;
      }
      case 'flightactionrelease': {
        const grab = flier.grab;
        if (!grab) return;
        grab.phase = 'done';
        this.#grabbed.delete(grab.victim);
        // Let go high over the ground: it dies of the fall (the engine's flight kill grab).
        // TODO(M13): whether the engine kills it or the fall's damage does.
        void this.#options.session.scriptsReady?.actors.kill(grab.victim, flier.reference);
        grab.done(true);
        return;
      }
      case 'shoutstop':
        this.#options.casting()?.stopBreath(flier.reference);
        return;
      default:
        return;
    }
  }

  #stateChanged(flier: Flier, state: FlyingStateValue, event: string): void {
    const was = flier.state;
    flier.state = state;
    const lower = event.toLowerCase();
    // Answered: what it asked has begun.
    if (
      (lower === 'flighttakeoff' && flier.asked?.what === 'takeoff') ||
      (lower === 'flighthovering' && flier.asked?.what === 'hover') ||
      (lower === 'flightcruising' &&
        (flier.asked?.what === 'unhover' || flier.asked?.what === 'takeoff')) ||
      (lower === 'flightlanding' && flier.asked?.what === 'land')
    ) {
      flier.asked = undefined;
    }
    if (state === FlyingState.takeOff) {
      // Off its perch.
      if (flier.perch !== undefined) this.#perchUsers.delete(flier.perch);
      flier.perch = undefined;
      this.#options.movers.release(flier.reference);
    }
    if (state === FlyingState.perching) {
      flier.perch = flier.landing?.perch;
      if (flier.perching && flier.perching.perch === flier.perch) flier.perching.done(true);
    }
    // Into its cruise (off the ground, out of a hover): it flies on at half its walking speed
    // at least (the graph accelerates from there).
    const behavior = flier.staged.placed.behavior;
    if (state === FlyingState.cruising && behavior) {
      const walk = (flier.speeds ?? this.#speeds(flier)).walk;
      if ((behavior.variable('Speed') ?? 0) < walk / 2) behavior.setVariable('Speed', walk / 2);
    }
    if (state === FlyingState.none && was !== FlyingState.none) {
      // Landed: its controller again where it stands (the movers make it).
      const landing = flier.landing;
      if (landing) {
        flier.staged.position = [...landing.spot];
        flier.staged.heading = landing.heading;
      }
      flier.landing = undefined;
      flier.pitch = 0;
      if (flier.request?.kind === 'land') flier.request = undefined;
      if (flier.package?.kind === 'land') flier.package = undefined;
    }
  }

  // --- Places -------------------------------------------------------------------------------

  /**
   * Where it lands to fight a target: its forced landing marker (SetForcedLandingMarker), else
   * the navmesh near the target on its own side (the landing distance from it).
   */
  #landingSpot(flier: Flier, target: Vec3): Vec3 | undefined {
    const runtime = this.#options.session.scriptsReady;
    const forced = runtime?.state.actors.get(flier.reference)?.forcedLandingMarker;
    const marker =
      forced === undefined ? undefined : runtime?.world.livePlacement?.(forced)?.position;
    if (marker) return [marker[0], marker[1], marker[2]];
    const here = flier.staged.position;
    const dx = here[0] - target[0];
    const dy = here[1] - target[1];
    const length = Math.hypot(dx, dy) || 1;
    const near: Vec3 = [
      target[0] + (dx / length) * this.#settings.landingDistance,
      target[1] + (dy / length) * this.#settings.landingDistance,
      target[2],
    ];
    const spot = this.#options.navmeshes?.()?.nearest?.(near, this.#settings.landingDistance);
    return spot && [spot[0], spot[1], spot[2]];
  }

  /**
   * A dragon perch near a target that no other flier holds: furniture the idle tree lands on
   * (ActionFlyStop's GetIsID of its target: vanilla's DragonPerchTower, DragonPerchWordwall,
   * DragonPerchRockL02, DragonTowerHole01, DLC1's DragonWaterDive) whose interaction keyword
   * (KNAM: ActorTypeDragon) its race has.
   */
  #freePerch(flier: Flier, target: Vec3): number | undefined {
    const objects = this.#options.objects?.();
    const runtime = this.#options.session.scriptsReady;
    if (!objects || !runtime) return undefined;
    const race = flier.staged.placed.look.race;
    let best: { reference: number; distance: number } | undefined;
    const perches = this.#perches();
    for (const object of objects) {
      if (object.baseType !== 'FURN' || perches?.has(object.base) !== true) continue;
      const keyword = this.#perchKeyword(runtime, object.base);
      if (keyword === undefined) continue;
      const user = this.#perchUsers.get(object.reference);
      if (user !== undefined && user !== flier.reference) continue;
      const distance = flat(object.position, target);
      if (distance > this.#settings.perchRadius) continue;
      if (!this.#raceHas(runtime, race, keyword)) continue;
      if (!best || distance < best.distance) best = { reference: object.reference, distance };
    }
    return best?.reference;
  }

  #perchList: Set<number> | undefined;
  #perchListRead: Promise<Set<number>> | undefined;

  /**
   * The perch furniture: the forms the idle tree's ActionFlyStop idles test their target to be
   * (GetIsID run on the target), read once (undefined meanwhile).
   */
  #perches(): Set<number> | undefined {
    void this.#perchSet();
    return this.#perchList;
  }

  /** The perch furniture, once read. */
  #perchSet(): Promise<Set<number>> {
    if (!this.#perchListRead) {
      this.#perchListRead = this.#options.session.db
        .then((db) => readIdleTree(db))
        .then((tree) => {
          const found = new Set<number>();
          const action = tree.action('ActionFlyStop');
          const walk = (parent: number, depth: number): void => {
            if (depth > 16) return;
            for (const idle of tree.children(parent)) {
              for (const condition of idle.conditions) {
                if (condition.function === GET_IS_ID && condition.runOn === RUN_ON_TARGET)
                  found.add(condition.form);
              }
              walk(idle.formId, depth + 1);
            }
          };
          if (action) walk(action.formId, 0);
          this.#perchList = found;
          return found;
        })
        .catch(() => new Set<number>());
    }
    return this.#perchListRead;
  }

  /** A furniture's interaction keyword, if it has one (read once per base; undefined meanwhile). */
  #perchKeyword(runtime: ScriptRuntime, base: number): number | undefined {
    if (!this.#perchBases.has(base)) {
      const entry = runtime.forms
        .record(base)
        .then((record) =>
          record?.type === 'FURN' ? parseFurniture(record).interactionKeyword : undefined,
        )
        .catch(() => undefined);
      this.#perchBases.set(base, entry);
      void entry.then((keyword) => this.#perchKeywords.set(base, keyword));
    }
    return this.#perchKeywords.get(base);
  }

  readonly #raceKeywords = new Map<string, boolean>();

  /** Whether a race has a keyword (read once per pair; false meanwhile). */
  #raceHas(runtime: ScriptRuntime, race: number, keyword: number): boolean {
    const key = `${String(race)}:${String(keyword)}`;
    const known = this.#raceKeywords.get(key);
    if (known !== undefined) return known;
    this.#raceKeywords.set(key, false);
    void runtime.hasKeyword(race, keyword).then((has) => this.#raceKeywords.set(key, has));
    return false;
  }

  /** Where a perch is (its reference's place). */
  #perchPlace(perch: number): Vec3 | undefined {
    for (const object of this.#options.objects?.() ?? []) {
      if (object.reference === perch) return [...object.position];
    }
    return undefined;
  }

  /**
   * The trigger volumes a flier without a controller reaches (a ball of its size about its
   * middle): their scripts hear it enter and leave, as the movers tell those of the actors
   * that walk (MQ101SetStage99, across Alduin's way to Helgen's tower). With its controller
   * again, the movers tell them: it leaves those it was in.
   */
  #triggerFrame(flier: Flier, free: boolean): void {
    const physics = this.#options.movers.physics;
    const onTrigger = this.#options.onTrigger;
    if (!onTrigger || !physics?.queriesCurrent) return;
    let inside = new Set<number>();
    if (free) {
      const radius = flier.shape?.radius ?? FLIER_RADIUS;
      const height = flier.shape?.height ?? radius * 2;
      const [x, y, z] = flier.staged.position;
      inside = physics.triggersNear([x, y, z + height / 2], radius);
    }
    for (const trigger of inside) {
      if (!flier.triggers.has(trigger)) onTrigger(trigger, flier.reference, true);
    }
    for (const trigger of flier.triggers) {
      if (!inside.has(trigger)) onTrigger(trigger, flier.reference, false);
    }
    flier.triggers = inside;
  }

  /** The ground under a point (the collision ray straight down), if any within a long way. */
  #groundUnder(at: Vec3): number | undefined {
    const physics = this.#options.movers.physics;
    if (!physics?.queriesCurrent) return undefined;
    const hit = physics.raycast([at[0], at[1], at[2] + 64], [0, 0, -1], 8192, Layer.charController);
    return hit?.point[2];
  }

  /** Whether an actor stands high over the ground (placed in the air; its own controller left out). */
  #highAboveGround(staged: StagedActor): boolean {
    const physics = this.#options.movers.physics;
    if (!physics?.queriesCurrent) return false;
    const [x, y, z] = staged.position;
    return !physics.raycast(
      [x, y, z + 16],
      [0, 0, -1],
      AIR_START,
      Layer.charController,
      this.#options.movers.colliderOf(staged.reference),
    );
  }

  // --- Reading --------------------------------------------------------------------------------

  #flier(reference: number): Flier | undefined {
    let flier = this.#fliers.get(reference);
    if (flier) return flier;
    const staged = this.#options.get(reference);
    if (!staged || !fliesByRace(staged.placed.look.raceFlags)) return undefined;
    flier = {
      reference,
      staged,
      state: FlyingState.none,
      asked: undefined,
      pitch: 0,
      request: undefined,
      package: undefined,
      landing: undefined,
      perch: undefined,
      grab: undefined,
      combat: undefined,
      travel: undefined,
      perching: undefined,
      triggers: new Set(),
      shape: undefined,
      checkedAir: false,
      speeds: undefined,
      idle: undefined,
      breathing: false,
      rended: false,
      valuesRead: -Infinity,
    };
    this.#fliers.set(reference, flier);
    return flier;
  }

  /**
   * Its flying speeds and turn rate: its race's flying movement type (RACE FLMV:
   * Dragon_Flying_MT, forward 2000 walking and 7400 running, turning 90° a second), else
   * fFlyingActorDefaultTurningSpeed and the graph's own.
   */
  /** The fliers whose speeds are being read. */
  readonly #speedsAsked = new WeakSet<Flier>();

  #speeds(flier: Flier): { readonly walk: number; readonly run: number; readonly turn: number } {
    const fallback = { walk: 2500, run: 7500, turn: this.#settings.turningSpeed };
    const catalog = this.#catalog;
    if (!catalog || this.#speedsAsked.has(flier)) return fallback;
    this.#speedsAsked.add(flier);
    void this.#options.session.db
      .then(async (db) => {
        const race = await catalog.race(db, flier.staged.placed.look.race);
        const id = race?.movementTypes.fly;
        const type = id === undefined ? undefined : catalog.byId(id);
        flier.speeds = type
          ? {
              walk: type.walk.forward || fallback.walk,
              run: type.run.forward || fallback.run,
              turn: type.rotateWhileMoving || fallback.turn,
            }
          : fallback;
      })
      .catch(() => undefined);
    return fallback;
  }

  /**
   * Its health against its race's injured share (the graph's Injured), and Dragonrend on it
   * (the DragonRend actor value the shout's effect raises: it may not fly meanwhile).
   */
  async #readValues(
    flier: Flier,
    runtime: ScriptRuntime,
    behavior: BehaviorRuntime,
  ): Promise<void> {
    const [health, rend] = await Promise.all([
      runtime.actors.value(flier.reference, ActorValue.health),
      runtime.actors.value(flier.reference, DRAGON_REND),
    ]);
    const share = health.max > 0 ? health.current / health.max : 1;
    const race = await this.#raceInjured(runtime, flier.staged.placed.look.race);
    behavior.setVariable('Injured', race > 0 && share < race ? 1 : 0);
    flier.rended = rend.current > 0;
  }

  readonly #injuredPct = new Map<number, Promise<number>>();

  #raceInjured(runtime: ScriptRuntime, race: number): Promise<number> {
    let entry = this.#injuredPct.get(race);
    if (!entry) {
      entry = runtime.forms
        .record(race)
        .then((record) => (record?.type === 'RACE' ? parseRaceCombat(record).injuredHealthPct : 0))
        .catch(() => 0);
      this.#injuredPct.set(race, entry);
    }
    return entry;
  }

  #readSettings(): void {
    if (this.#settingsRead) return;
    this.#settingsRead = true;
    void this.#options.session.settings().then((settings) => {
      this.#settings = readFlightSettings((name) => settings.number(name));
    });
  }

  #readCatalog(): void {
    if (this.#catalogRead) return;
    this.#catalogRead = true;
    void this.#options.session.db
      .then((db) => MovementCatalog.read(db))
      .then((catalog) => {
        this.#catalog = catalog;
      })
      .catch(() => undefined);
  }

  // --- Drawing ----------------------------------------------------------------------------------

  /** A flier drawn where it is, level and turned to its heading (its clips pitch and bank it). */
  #draw(flier: Flier): void {
    const staged = flier.staged;
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

  // --- Leaving ----------------------------------------------------------------------------------

  remove(reference: number): void {
    const flier = this.#fliers.get(reference);
    if (!flier) return;
    flier.grab?.done(false);
    flier.travel?.done(false);
    flier.perching?.done(false);
    for (const trigger of flier.triggers) this.#options.onTrigger?.(trigger, reference, false);
    if (flier.perch !== undefined) this.#perchUsers.delete(flier.perch);
    this.#fliers.delete(reference);
  }

  clear(): void {
    for (const reference of [...this.#fliers.keys()]) this.remove(reference);
    this.#shouts.clear();
  }

  #warn(message: string): void {
    this.#options.terminal.log('flight', message, 'warn');
  }
}

/** The DragonRend actor value (Dragonrend's effect: the flier may not fly). */
const DRAGON_REND = actorValueIndex('DragonRend') ?? -1;

/** Where a request takes a flier (its goal: for the take-off's turn). */
function goalOf(
  request: FlightRequest,
  get: (reference: number) => StagedActor | undefined,
): Vec3 | undefined {
  switch (request.kind) {
    case 'cruise':
      return request.to;
    case 'orbit':
      return request.center;
    case 'hover':
    case 'land':
      return request.at;
    case 'grab':
      return get(request.victim)?.position;
  }
}

/** Whether its graph moves it now (bAnimationDriven, bIsSynced): its clips and tweeners do. */
function animationDriven(behavior: BehaviorRuntime): boolean {
  return behavior.variable('bAnimationDriven') === 1 || behavior.variable('bIsSynced') === 1;
}

/** Whether a request has a flier in the air (a landing far off: flown to). */
function wantsAir(request: FlightRequest, here: Vec3): boolean {
  // A perch is landed on from the air (FlyStopPerch*), however near it stands: MQ101's Alduin
  // came down by the Helgen tower's perch at the end of his travel there and stood beside it,
  // his Sit never done, while the attack scene waited for him to perch.
  if (request.kind === 'land')
    return request.perch !== undefined || flat(here, request.at) > IDLE_ORBIT;
  return true;
}

/**
 * Whether a flier has reached a point of its way: near it, or gone by it (behind it, not far).
 */
function passed(here: Vec3, heading: number, point: Vec3): boolean {
  const dx = point[0] - here[0];
  const dy = point[1] - here[1];
  const apart = Math.hypot(dx, dy);
  if (apart < APPROACH_REACH) return true;
  const ahead = dx * Math.sin(heading) + dy * Math.cos(heading);
  return ahead < 0 && apart < APPROACH_REACH * 3;
}

/** A point raised by a height (a flight's way over a place on the ground). */
function raised(at: Vec3, height: number): Vec3 {
  return [at[0], at[1], at[2] + height];
}

/** The heading from a point to what it faces. */
function faceHeading(from: Vec3, face: Vec3): number {
  return Math.atan2(face[0] - from[0], face[1] - from[1]);
}
