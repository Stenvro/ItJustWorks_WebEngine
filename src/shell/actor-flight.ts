// The fliers of the stage (docs/ai.md, "Flying"): actors of a race that flies (RACE DATA Flies:
// the dragons) take off, cruise, circle, hover, land (on the ground, on a dragon perch, on a
// landing marker), grab an actor in flight and breathe their shouts, through their behavior
// graph as the engine drives it: the idle tree's ActionFlyStart, ActionFlyStop, ActionHoverStart
// and ActionHoverStop (their idles' conditions read GetFlyingState, GetIsHastyLandRequest,
// GetIsCrashLandRequest, GetIsInjured and the landing's target: the perches), the flight grab's
// events (to_Flight_Kill_Grab_Enter, _Action, _Action_Failed), the graph's notify events telling
// the flying state (FlightTakeOff, FlightCruising, FlightHovering, FlightLanding, FlightPerching,
// FlightAction, FlightLand, LandEnd) and the variables the engine sets (TargetSpeed, TurnDelta,
// PitchDelta, MovementDirection, DistToGoal, TweenSpeed, HasTweenSpeed, TweenPosition,
// TweenRotation, TweenEntryDirection, Injured).
//
// What a flier does, observed in the original (src/ai/flight.ts has the rules):
// - its packages' procedures ask it (PackageFlight): a Travel in the air lands at its place (a
//   sky marker is flown to instead), a Patrol flies through its sky markers and lands at a
//   point on the ground, a Sit on a perch lands it on the perch, Hover and Orbit fly; a perched
//   flier stays on its perch until a procedure needs it in the air;
// - its fight is the combat tree's Flight subtree (fight): it takes off, circles its target
//   for an orbit's time, then one maneuver its combat style weighs (a ground attack, a hover, a
//   dive bomb, a perch attack, the talon grab), again and again; it circles its combat area while
//   its target is outside it; one that can no longer fly (hurt: Injured, not allowed, dead) waits
//   for its cruise and lands (a landing marker near, the navmesh near it, a crash strip when
//   hurt and fighting the player);
// - a flier killed in the air dies once it has landed (the engine's deferred kill).
//
// In the air a flier has no character controller (src/shell/actor-movers.ts holds it off):
// while its graph is motion driven (neither bAnimationDriven nor bIsSynced: cruising) it steers
// for what it wants at the speed its graph flies, kept its flight radius over the ground; while
// it is animation driven (taking off, landing, hovering, the grab) its clips' root motion and the
// graph's tweeners (BSTweenerModifier: to TweenPosition) move it.

import {
  airborne,
  anticipated,
  canFly,
  combatAreaRadius,
  diveBombGoal,
  entryDirection,
  FLIGHT_DEFAULTS,
  fliesByRace,
  FlyingState,
  flyingStateOf,
  flightRanges,
  headingRotation,
  hoverPoints,
  landingApproach,
  maneuverSeconds,
  maneuverWeights,
  orbitClockwise,
  orbitPoint,
  orbitSeconds,
  perchFaces,
  pickManeuver,
  pointReached,
  readFlightSettings,
  shoutRanges,
  steerFlight,
  wantsTakeoff,
  type FlightManeuver,
  type FlightRequest,
  type FlightSettings,
  type FlyingStateValue,
} from '../ai/flight.ts';
import type { CombatStyleFlight } from '../ai/combat-style-records.ts';
import type { GraphEvent } from '../animation/graph-events.ts';
import type { ActorGraphSource } from './actor-graph-events.ts';
import { MovementCatalog } from '../ai/movement-types.ts';
import { parseRaceCombat } from '../ai/race-combat-records.ts';
import { parseRaceHits } from '../gameplay/combat/combat-records.ts';
import type { NavmeshSet } from '../ai/pathfinding.ts';
import type { BehaviorRuntime } from '../animation/behavior-runtime.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import { Layer } from '../physics/collision-layers.ts';
import { multiply, transformPoint, type Vec3 } from '../render/math.ts';
import { ActorValue, actorValueIndex } from '../world/actor-values.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { FurnitureMarkerFlag, parseFurniture } from '../world/furniture-records.ts';
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
  /** The enabled objects of the loaded area (the dragon perches, the landing markers). */
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
  /** Its radius (the actors' extents add it). */
  readonly radius?: number;
  /** How it moves (units a second; where it will be: fCombatAnticipateTime). */
  readonly velocity?: Vec3;
  /** Its heading (whether it faces the flier: its combat area's centre). */
  readonly heading?: number;
  /**
   * The talon grab may take it (observed in the original): it moves slower than a jog, a
   * kill move may end it, and one blow of the flier's would.
   */
  readonly grabbable?: boolean;
}

/** What combat tells of a flier's fight beyond its target. */
export interface FlightFight {
  /** Its combat style's flight section. */
  readonly flight: CombatStyleFlight;
  /** Its offensive mult as the engine weighs it (combat-tactics offensiveMult). */
  readonly offensive: number;
  /** Its style's farthest optimal range (combat-tactics maxOptimalRange). */
  readonly styleOptimal: number;
  /** Seconds since it was last attacked (undefined: not in this fight). */
  readonly attackedAgo: number | undefined;
}

/** The phases of a flier's fight (the combat tree's Flight subtree). */
type FightPhase = 'orbit' | 'orbitDistant' | 'maneuver' | 'leavePerch' | 'land';

/** A maneuver under way and its steps. */
interface Maneuver {
  readonly kind: FlightManeuver;
  /** Flying there; there (hovering, perched, on the ground, grabbing); leaving (taking off). */
  step: 'approach' | 'there' | 'leaving';
  /** When its time there ends (Infinity: not there yet). */
  until: number;
  /** A dive bomb's goal and arrival; a hover's point; a landing's spot; a grab's victim's start. */
  readonly goal?: Vec3;
  readonly arrive?: number;
  readonly heading?: number;
  readonly perch?: number;
  readonly from?: Vec3;
  /** When a perch's facing was last checked. */
  checked: number;
}

/** A flier's fight: its phase, its maneuver and its clock. */
interface FlierCombat {
  target: number;
  phase: FightPhase;
  /**
   * When its orbit ends (Infinity until it cruises: the combat tree's Orbit runs in its Attack
   * Sequence, which waits for its cruise), and how long it lasts.
   */
  until: number;
  orbitFor: number;
  maneuver: Maneuver | undefined;
  /** The maneuvers tried since its last orbit (the Attack Selector's). */
  readonly tried: Set<FlightManeuver>;
  /** Its combat area's centre. */
  area: Vec3;
  /** Its landing when it cannot fly (a spot; on a marker; how). */
  landing: FlightRequest | undefined;
  /** The selector's next check (every second). */
  checkAt: number;
  /** When its breath was last tried (the Shout selector waits a second between). */
  breathAt: number;
  /** Its target as last seen (how it moves). */
  seen: { readonly feet: Vec3; readonly at: number; velocity: Vec3 } | undefined;
  /** Whether the talon grab may take its target (checked every second). */
  grabbable: boolean;
  grabCheckAt: number;
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
  /** The landing begun: its spot, heading, target and perch. */
  landing:
    | {
        readonly spot: Vec3;
        readonly heading: number;
        readonly target: number | undefined;
        readonly perch: number | undefined;
      }
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
  /** Its package's flight under way: to a point in the air, or to land at a place. */
  travel:
    | {
        readonly to: Vec3;
        readonly arrive: number;
        readonly aloft: boolean;
        readonly done: (arrived: boolean) => void;
      }
    | undefined;
  /** A package's perch it lands on and stays on (Sit on a DragonPerchTower: MQ101AlduinPerch1). */
  perching: { readonly perch: number; readonly done: (perched: boolean) => void } | undefined;
  /** A package's hover: done once it hovers there. */
  hovering:
    | { readonly at: Vec3; readonly radius: number; readonly done: (there: boolean) => void }
    | undefined;
  /** The trigger volumes it is in while it has no controller (in the air, perched). */
  triggers: Set<number>;
  /** Its controller's shape when it had one (its size for blows in the air). */
  shape: { readonly radius: number; readonly height: number } | undefined;
  /** Placed in the air (no ground under it): it starts cruising. */
  checkedAir: boolean;
  /** Its flying movement type's speeds (walk, run forward) and turn rate. */
  speeds: { readonly walk: number; readonly run: number; readonly turn: number } | undefined;
  /** Its race's flight radius (RACE DATA; times its scale): kept over the ground by it. */
  radius: number | undefined;
  /** Where it circles with nothing to do (fixed as it begins to). */
  idle: Vec3 | undefined;
  /** A breath being begun (not begun twice). */
  breathing: boolean;
  /** Dragonrend on it (the DragonRend actor value): it may not fly, it lands. */
  rended: boolean;
  /** Its health (current) and graph Injured, as last read. */
  health: number;
  injured: boolean;
  /** When its health and Dragonrend were last read. */
  valuesRead: number;
  /** Unable to fly in the air outside a fight: it lands (traced as it begins to). */
  grounded: boolean;
  /**
   * Off the ground, its deferred kill (observed in the original): killed in the air it dies
   * once it has landed, or DEFERRED_KILL after its health ran out (since when).
   */
  deferred: { downSince: number | undefined } | undefined;
  /** Its breath's ranges (its shouts' smallest), once read. */
  ranges: { readonly optimal: number; readonly max: number } | undefined;
}

/** A flier asks its graph again after this long without an answer (seconds). */
const ASK_AGAIN = 3;
/** Placed with no ground within this under it, a flier starts in the air (units). */
const AIR_START = 512;
/** It begins its hover this far from the hover point (the hover-enter clips' 3584 forward). */
const HOVER_ENTER = 3584;
/** It begins its landing within this of the approach point (units). */
const APPROACH_REACH = 768;
/**
 * It begins its flight grab this far from its victim (the enter clip's way; observed in the
 * original, the grab's approach starts the enter clip's root motion from the victim).
 */
const GRAB_ENTER = 2048;
/** A grab takes hold of a victim within this of the talons as the enter clip ends (units). */
const GRAB_REACH = 512;
/** The bone the grabbed actor hangs from (the dragon's rear talons; FlightActionGrab names it). */
const GRAB_BONE = 'NPC RLegFoot';
/** A flier breathes at a target within this angle of its facing (radians). */
const BREATH_ANGLE = Math.PI / 5;
/** Breath reaches at most this far without a projectile to say (units). */
const BREATH_RANGE = 2000;
/** A flier with nothing to do circles where it is this wide (units). */
const IDLE_ORBIT = 2048;
/**
 * A flier's size for trigger volumes before it had a controller, and its flight radius without
 * its race's (units; RACE DATA flight radius: the dragons' 400).
 */
const FLIER_RADIUS = 256;
const FLIGHT_RADIUS = 400;
/** A flier's health and Dragonrend are read this often (seconds). */
const VALUES_SECONDS = 0.5;
/** A flight grab gives up after this long (seconds). */
const GRAB_LIMIT = 30;
/** fBetaDeferredKillTimer: one killed in the air dies after this at the latest (seconds). */
const DEFERRED_KILL = 15;
/** The combat tree's Flight Selector and a perch's facing are checked this often (seconds). */
const SELECT_SECONDS = 1;
/** A flier's combat area's centre follows it while its target faces it within this (radians). */
const AREA_FACING = Math.PI / 6;
/** The talon grab is given up once its victim moved this far (fCombat… threshold: settings). */
const PLAYER = 0x14;
/** How many state changes the flight trace keeps. */
const TRACE_LINES = 4000;

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const distance3 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const STATE_NAMES = ['ground', 'takeOff', 'cruising', 'hovering', 'landing', 'perching', 'action'];

/**
 * Fliers landing or fighting on the ground, and hovering, across the stage: one at a time each
 * (observed in the original: the combat tree's Ground Attack, Land and Hover keep counts).
 */
interface Shared {
  readonly landing: Set<number>;
  readonly hovering: Set<number>;
}

export class ActorFlight {
  readonly #options: ActorFlightOptions;
  readonly #fliers = new Map<number, Flier>();
  /** The actors carried in a flier's talons now (no controller of their own). */
  readonly #grabbed = new Set<number>();
  readonly #random = seededRandom(0xf1a7);
  readonly #shared: Shared = { landing: new Set(), hovering: new Set() };
  #settings: FlightSettings = FLIGHT_DEFAULTS;
  #settingsRead = false;
  #catalog: MovementCatalog | undefined;
  #catalogRead = false;
  /** Furniture bases: whether each is a perch (MNAM Is Perch), read once each. */
  readonly #perchBases = new Map<number, boolean | undefined>();
  /** Perch and marker references' headings (their z rotation), read once each. */
  readonly #headings = new Map<number, number | undefined>();
  /** Perches taken, by perch: the flier on it or landing on it. */
  readonly #perchUsers = new Map<number, number>();
  /** Shouts each flier knows (read once). */
  readonly #shouts = new Map<number, Promise<number[]>>();
  /** References read as sky markers (or not). */
  readonly #sky = new Map<number, Promise<boolean>>();
  /** The landing markers (DOBJ DLZM DragonMarker, DCZM DragonMarkerCrashStrip), once read. */
  #markers: { readonly land: number | undefined; readonly crash: number | undefined } | undefined;
  #markersRead = false;
  /** The actors of the stage this frame (landing spots clear of them). */
  #actors: readonly StagedActor[] = [];
  /** State changes and fight phases, a line each (the flight trace: engineDev.flightTrace). */
  readonly #trace: string[] = [];
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

  /**
   * Whether it may fly now (CanFly where flying is: CanFlyHere): its race flies, allowed to
   * (SetAllowFlying, no Dragonrend), not hurt (its graph's Injured), alive.
   */
  mayFly(reference: number): boolean {
    const flier = this.#fliers.get(reference);
    return (
      this.canFlyHere() &&
      canFly({
        racesFly: this.flies(reference),
        injured: flier?.injured === true,
        allowed: this.allowed(reference),
        health: flier?.health ?? 1,
      })
    );
  }

  /** SetAllowFlying (the game state's; true unless a script said no) and no Dragonrend on it. */
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

  /** Whether it sits on a perch now. */
  perched(reference: number): boolean {
    return this.state(reference) === FlyingState.perching;
  }

  /** Whether the flight holds an actor (it has no controller): in the air, taking off, perched. */
  holds(reference: number): boolean {
    if (this.#grabbed.has(reference)) return true;
    const flier = this.#fliers.get(reference);
    if (flier !== undefined)
      return flier.state !== FlyingState.none || flier.asked?.what === 'takeoff';
    // A flier its package starts at a sky marker is kept in the air until its package runs.
    const staged = this.#options.get(reference);
    const start = staged?.placed.start;
    return (
      staged !== undefined &&
      start?.kind === 'at' &&
      start.sky === true &&
      fliesByRace(staged.placed.look.raceFlags) &&
      !staged.dead
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

  /** What a flier is asked to do now (undefined: it stays as it is: circling, hovering, perched). */
  request(reference: number, request: FlightRequest | undefined): void {
    const flier = this.#flier(reference);
    if (!flier) return;
    flier.package = request;
  }

  requestOf(reference: number): FlightRequest | undefined {
    return this.#fliers.get(reference)?.request;
  }

  /**
   * A package's way flown (observed in the original: a Travel, a Patrol's point, a furniture's
   * approach): to a sky marker (REFR flag 0x2000; a place high in the air without a reference) it
   * flies there and through, reached within its radius and fAIPatrolHysteresisWidth across and
   * the location's height window; to anything else it lands there (the engine's Landing package:
   * at the place, facing the reference's heading unless it is a plain XMarker, the reference as
   * the landing's target: a perch's idles). A perched flier takes off first. Resolves true once
   * there (landed), false if it is sent elsewhere or cannot fly.
   */
  async travel(reference: number, to: Vec3, arrive: number, target?: number): Promise<boolean> {
    const flier = this.#flier(reference);
    if (!flier || !this.mayFly(reference)) return false;
    const sky = target !== undefined ? await this.isSkyMarker(target) : this.#aloft(to);
    const heading = target === undefined ? undefined : await this.#landingHeading(target);
    // A perch landed on is sat on (its Sit then done at once).
    const perch = target !== undefined && !sky && (await this.isPerch(target)) ? target : undefined;
    flier.travel?.done(false);
    flier.perching?.done(false);
    flier.hovering?.done(false);
    this.#trace.push(
      `${this.#stamp()} ${hex(reference)} travel ${sky ? 'through' : 'to land at'} ${round(to)} r${String(Math.round(arrive))}`,
    );
    return new Promise((resolve) => {
      const travel = {
        to,
        arrive,
        aloft: sky,
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
      flier.package = sky
        ? { kind: 'cruise', to: [...to] }
        : {
            kind: 'land',
            at: [...to],
            ...(heading !== undefined && { heading }),
            ...(target !== undefined && { target }),
            ...(perch !== undefined && { perch }),
          };
    });
  }

  /**
   * A Patrol whose first point is a sky marker starts its flier cruising at once (observed in the
   * original: no take-off; its flying state set to cruising and ActionFlyStart, whose
   * in-air idle is FlyStartCruise). One perched leaves its perch by its take-off (a procedure's
   * get-up: TakeOff_Perch) as its way to the patrol's point asks.
   */
  startCruising(reference: number): void {
    const flier = this.#flier(reference);
    const behavior = flier?.staged.placed.behavior;
    if (!flier || !behavior || !this.mayFly(reference)) return;
    if (flier.state !== FlyingState.none) return;
    this.#setState(flier, FlyingState.cruising, 'start cruising');
    flier.checkedAir = true;
    this.#options.movers.release(reference);
    this.#tween(behavior, flier.staged.position, flier.staged.heading, flier.staged.heading);
    void this.#options.furniture
      .playAction(this.#options.userOf(flier.staged), 'ActionFlyStart', undefined, true)
      .then((played) => {
        if (!played) behavior.sendEvent('FlyStartCruise');
      })
      .catch((error: unknown) => {
        this.#warn(`${hex(reference)} ActionFlyStart: ${describe(error)}`);
      });
  }

  /** Whether a reference is a sky marker (REFR record flag 0x2000), read once. */
  isSkyMarker(reference: number): Promise<boolean> {
    let entry = this.#sky.get(reference);
    if (!entry) {
      const runtime = this.#options.session.scriptsReady;
      entry = (runtime?.forms.record(reference) ?? Promise.resolve(undefined))
        .then((record) => record?.type === 'REFR' && (record.flags & RecordFlag.skyMarker) !== 0)
        .catch(() => false);
      this.#sky.set(reference, entry);
    }
    return entry;
  }

  /**
   * A package's perch (Sit on perch furniture: MQ101AlduinPerch1 on the Helgen tower's
   * DragonPerchTower): in the air it lands on it (the engine's Landing package with the perch
   * as the landing's target and its heading: ActionFlyStop's FlyStopPerch*, its FlightLanding
   * and TowerLandImpact); on that perch already it is done at once and stays (a Sit whose
   * furniture it sits in); on another or on the ground it takes off first. Resolves true once
   * perched; false if it cannot fly or is sent elsewhere. It stays until a procedure needs it
   * in the air.
   */
  async perch(reference: number, perch: number): Promise<boolean> {
    const flier = this.#flier(reference);
    const at = await this.#placeOf(perch);
    if (!flier || !at || !this.mayFly(reference)) {
      if (flier) this.#log(flier, `perch ${hex(perch)} refused`);
      return false;
    }
    this.#log(flier, `perch ${hex(perch)}`);
    const heading = await this.#landingHeading(perch);
    flier.travel?.done(false);
    flier.perching?.done(false);
    flier.hovering?.done(false);
    const request: FlightRequest = {
      kind: 'land',
      at: [...at],
      target: perch,
      perch,
      ...(heading !== undefined && { heading }),
    };
    if (flier.state === FlyingState.perching && flier.perch === perch) {
      flier.package = request;
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
      flier.package = request;
    });
  }

  /** Whether a reference is perch furniture (FURN MNAM Is Perch: observed in the original). */
  async isPerch(reference: number): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const base = runtime ? await runtime.baseOf(reference) : undefined;
    if (base === undefined || !runtime) return false;
    return this.#perchBase(runtime, base);
  }

  /**
   * Its package let go of its perch (a procedure's stand-up): a flier does not leave its perch
   * for that (observed in the original: a procedure that needs it in the air takes it off;
   * Wait and DoNothing leave it there).
   */
  leavePerch(reference: number): void {
    const flier = this.#fliers.get(reference);
    if (!flier) return;
    flier.perching?.done(false);
    if (flier.package?.kind === 'land' && flier.package.perch !== undefined) {
      flier.package = undefined;
    }
  }

  /**
   * A package's hover (the Hover procedure): it flies there and hovers facing `face`; resolves
   * true once it hovers within `radius` of the point (it stays hovering), false if it cannot fly
   * or is sent elsewhere.
   */
  hover(reference: number, at: Vec3, face: Vec3, radius: number): Promise<boolean> {
    const flier = this.#flier(reference);
    if (!flier || !this.mayFly(reference)) return Promise.resolve(false);
    flier.travel?.done(false);
    flier.perching?.done(false);
    flier.hovering?.done(false);
    flier.package = { kind: 'hover', at: [...at], face: [...face] };
    return new Promise((resolve) => {
      const hovering = {
        at,
        radius: Math.max(radius, APPROACH_REACH),
        done: (there: boolean): void => {
          if (flier.hovering !== hovering) return;
          flier.hovering = undefined;
          resolve(there);
        },
      };
      flier.hovering = hovering;
    });
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

  /** The flight trace so far: a line per state change and fight phase. */
  traceText(): string {
    return this.#trace.join('\n');
  }

  // --- Combat ------------------------------------------------------------------------------

  /**
   * One frame of a flier's fight, the combat tree's Flight subtree (observed in the
   * original; the combat AI asks it of a flier that can fly or is not on the ground): it takes off,
   * then while it can fly circles its target for an orbit's time and then tries one maneuver its
   * style weighs (ground attack, hover, dive bomb, perch attack, the talon grab), again and again;
   * while its target is outside its combat area it circles that area instead; perched and unable
   * to fly it takes off; in the air and unable to fly it waits for its cruise and lands. True
   * while the flight has it; false while it fights on the ground (a ground attack's time, or
   * landed and unable to fly): the combat AI's melee and shouts fight then.
   */
  fight(reference: number, seen: FlightTarget, fight: FlightFight): boolean {
    const flier = this.#flier(reference);
    if (!flier) return false;
    const settings = this.#settings;
    const here = flier.staged.position;
    const able = this.mayFly(reference);
    let combat = flier.combat;
    if (combat?.target !== seen.reference) {
      combat = {
        target: seen.reference,
        phase: 'orbit',
        until: Infinity,
        orbitFor: orbitSeconds(fight.offensive, settings, this.#random),
        maneuver: undefined,
        tried: new Set(),
        area: [...here],
        landing: undefined,
        checkAt: 0,
        breathAt: 0,
        seen: undefined,
        grabbable: false,
        grabCheckAt: 0,
      };
      flier.combat = combat;
      this.#log(flier, `fights ${hex(seen.reference)}`);
    }
    const target = this.#observe(flier, combat, seen);
    // On the ground and unable to fly: it fights there (the combat tree's other movement).
    if (!able && flier.state === FlyingState.none && flier.asked?.what !== 'takeoff') {
      this.#endManeuver(flier, combat, 'grounded');
      flier.request = undefined;
      return false;
    }
    this.#updateArea(flier, combat, target, fight);
    // The Flight Selector (checked every second): able to fly, the attack loop; perched and
    // unable, off the perch; in the air and unable, the landing.
    if (this.#clock >= combat.checkAt) {
      combat.checkAt = this.#clock + SELECT_SECONDS;
      const phase: FightPhase = able
        ? this.#attackPhase(flier, combat, target, fight)
        : flier.state === FlyingState.perching
          ? 'leavePerch'
          : 'land';
      if (phase !== combat.phase) this.#enter(flier, combat, phase, fight);
    }
    switch (combat.phase) {
      case 'orbitDistant': {
        const radius = combatAreaRadius(fight.attackedAgo, true, settings);
        this.#orbit(flier, [combat.area[0], combat.area[1], target.feet[2]], radius);
        break;
      }
      case 'orbit':
        this.#orbit(flier, target.feet, settings.orbitDistance);
        if (combat.until === Infinity && flier.state === FlyingState.cruising) {
          combat.until = this.#clock + combat.orbitFor;
        }
        // Its orbit's time over (and not busy: a breath finishes first), the next maneuver.
        if (
          this.#clock >= combat.until &&
          flier.state === FlyingState.cruising &&
          !this.#busy(flier)
        ) {
          this.#nextManeuver(flier, combat, target, fight);
        }
        break;
      case 'maneuver':
        if (!this.#maneuverFrame(flier, combat, target, fight)) {
          this.#endManeuver(flier, combat, 'done');
          this.#enter(flier, combat, 'orbit', fight);
        }
        break;
      case 'leavePerch':
        flier.request = { kind: 'cruise', to: ahead(flier.staged, 4096) };
        break;
      case 'land':
        this.#landFrame(flier, combat, target);
        break;
    }
    // Its breath (the combat tree's Shout action), while its actions are not held.
    if (this.#actionsFree(flier, combat) && !flier.breathing && this.#clock >= combat.breathAt) {
      combat.breathAt = this.#clock + 1;
      flier.breathing = true;
      void this.#breathe(flier, target)
        .catch((error: unknown) => {
          this.#warn(`${hex(reference)} breath: ${describe(error)}`);
        })
        .finally(() => {
          flier.breathing = false;
        });
    }
    // A ground attack's time on the ground: the combat AI fights.
    const maneuver = combat.maneuver;
    if (
      maneuver?.kind === 'groundAttack' &&
      maneuver.step === 'there' &&
      flier.state === FlyingState.none
    ) {
      return false;
    }
    return true;
  }

  /** Its fight ended: what its packages ask takes it from here (perched, it stays). */
  endFight(reference: number): void {
    const flier = this.#fliers.get(reference);
    if (!flier?.combat) return;
    this.#endManeuver(flier, flier.combat, 'fight over');
    this.#shared.landing.delete(reference);
    flier.combat = undefined;
    flier.request = flier.package;
    this.#log(flier, 'fight over');
  }

  /**
   * Its target as the fight sees it: how it moves (from where it was), and whether the talon
   * grab may take it (checked every second).
   */
  #observe(flier: Flier, combat: FlierCombat, seen: FlightTarget): FlightTarget {
    const last = combat.seen;
    if (!last) {
      combat.seen = { feet: seen.feet, at: this.#clock, velocity: [0, 0, 0] };
    } else if (this.#clock - last.at >= 0.25) {
      const dt = this.#clock - last.at;
      combat.seen = {
        feet: seen.feet,
        at: this.#clock,
        velocity: [
          (seen.feet[0] - last.feet[0]) / dt,
          (seen.feet[1] - last.feet[1]) / dt,
          (seen.feet[2] - last.feet[2]) / dt,
        ],
      };
    }
    if (this.#clock >= combat.grabCheckAt) {
      combat.grabCheckAt = this.#clock + SELECT_SECONDS;
      void this.#grabbable(flier, seen, combat.seen?.velocity)
        .then((grabbable) => {
          combat.grabbable = grabbable;
        })
        .catch(() => undefined);
    }
    return {
      ...seen,
      velocity: seen.velocity ?? combat.seen?.velocity,
      grabbable: seen.grabbable ?? combat.grabbable,
    };
  }

  /**
   * Whether the talon grab may take a target (observed in the original): it moves slower
   * than a jog (three quarters of the way from its walk to its run), a kill move may end it (not
   * essential), and one blow of the flier's (its race's unarmed damage on its strongest attack)
   * would kill it. TODO(M13): the engine's combat check does not leave out the player; whether
   * the fly action's own idles do is not read: the player is not grabbed here.
   */
  async #grabbable(
    flier: Flier,
    target: FlightTarget,
    velocity: Vec3 | undefined,
  ): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const catalog = this.#catalog;
    const victim = this.#options.get(target.reference);
    if (!runtime || !catalog || !victim || victim.dead || target.reference === PLAYER) return false;
    const db = await this.#options.session.db;
    const race = await catalog.race(db, victim.placed.look.race);
    const walkId = race?.movementTypes.walk;
    const type = walkId === undefined ? undefined : catalog.byId(walkId);
    const walk = type?.walk.forward ?? 80;
    const run = type?.run.forward ?? 370;
    const speed = velocity ? Math.hypot(velocity[0], velocity[1]) : 0;
    if (speed >= walk + 0.75 * (run - walk)) return false;
    if (await runtime.actors.isEssential(target.reference)) return false;
    const record = await runtime.forms.record(flier.staged.placed.look.race);
    if (record?.type !== 'RACE') return false;
    const blow = parseRaceHits(record).unarmedDamage;
    const mult = Math.max(1, ...parseRaceCombat(record).attacks.map((attack) => attack.damageMult));
    const health = (await runtime.actors.value(target.reference, ActorValue.health)).current;
    return health <= blow * mult;
  }

  /** The attack loop's branch now: its combat area's orbit while its target is outside it. */
  #attackPhase(
    flier: Flier,
    combat: FlierCombat,
    target: FlightTarget,
    fight: FlightFight,
  ): FightPhase {
    if (combat.phase === 'maneuver') return 'maneuver';
    const radius = combatAreaRadius(fight.attackedAgo, airborne(flier.state), this.#settings);
    if (flat(target.feet, combat.area) > radius) return 'orbitDistant';
    return 'orbit';
  }

  #enter(flier: Flier, combat: FlierCombat, phase: FightPhase, fight: FlightFight): void {
    if (combat.phase === 'maneuver' && phase !== 'maneuver') {
      this.#endManeuver(flier, combat, phase);
    }
    if (combat.phase === 'land' && phase !== 'land') this.#shared.landing.delete(flier.reference);
    combat.phase = phase;
    if (phase === 'orbit') {
      combat.until = Infinity;
      combat.orbitFor = orbitSeconds(fight.offensive, this.#settings, this.#random);
      combat.tried.clear();
    }
    if (phase === 'land') combat.landing = undefined;
    this.#log(flier, phase);
  }

  /** Its combat area's centre (observed in the original): where it is, as it began, when attacked, when its target faces it near. */
  #updateArea(flier: Flier, combat: FlierCombat, target: FlightTarget, fight: FlightFight): void {
    const here = flier.staged.position;
    let reset = fight.attackedAgo !== undefined && fight.attackedAgo < SELECT_SECONDS;
    if (!reset && target.heading !== undefined) {
      const toward = Math.atan2(here[0] - target.feet[0], here[1] - target.feet[1]);
      const off = Math.abs(
        Math.atan2(Math.sin(toward - target.heading), Math.cos(toward - target.heading)),
      );
      if (off <= AREA_FACING) {
        const extents = this.#extents(flier, target);
        const view = extents + 4096 - (off / AREA_FACING) * (4096 - 1024);
        reset = distance3(here, target.feet) <= view;
      }
    }
    if (reset) combat.area = [...here];
  }

  /** An orbit round a centre at a radius: on its way round as it already turns. */
  #orbit(flier: Flier, center: Vec3, radius: number): void {
    const request = flier.request;
    const same =
      request?.kind === 'orbit' && request.radius === radius && flat(request.center, center) < 512;
    flier.request = {
      kind: 'orbit',
      center: [...center],
      radius,
      // The orbit path's points are raised over the ground under them by its flight radius.
      height: this.#flightRadius(flier),
      clockwise:
        same && request.clockwise !== undefined
          ? request.clockwise
          : orbitClockwise(flier.staged.position, flier.staged.heading, center),
    };
  }

  /** The Attack Selector: the next maneuver drawn by weight; one that cannot start is passed over. */
  #nextManeuver(flier: Flier, combat: FlierCombat, target: FlightTarget, fight: FlightFight): void {
    const weights = maneuverWeights(fight.flight, this.#settings);
    for (;;) {
      const kind = pickManeuver(weights, combat.tried, this.#random);
      if (kind === undefined) {
        // None could: it circles again and draws anew.
        this.#enter(flier, combat, 'orbit', fight);
        return;
      }
      combat.tried.add(kind);
      const maneuver = this.#startManeuver(flier, kind, target, fight);
      if (maneuver) {
        combat.maneuver = maneuver;
        combat.phase = 'maneuver';
        this.#log(flier, `${kind}${maneuver.goal ? ` to ${round(maneuver.goal)}` : ''}`);
        return;
      }
    }
  }

  /** A maneuver's start (observed in the original); undefined: it cannot (another is drawn). */
  #startManeuver(
    flier: Flier,
    kind: FlightManeuver,
    target: FlightTarget,
    fight: FlightFight,
  ): Maneuver | undefined {
    const settings = this.#settings;
    const here = flier.staged.position;
    const ranges = this.#ranges(flier, target, fight);
    const at = anticipated(target.feet, target.velocity, settings.anticipateTime);
    switch (kind) {
      case 'diveBomb': {
        const { goal, arrive } = diveBombGoal(at, here, ranges.optimal, settings, this.#random);
        return { kind, step: 'approach', until: Infinity, goal, arrive, checked: 0 };
      }
      case 'hover': {
        // One flier hovers at a time; its points within its combat area.
        if (this.#othersIn(this.#shared.hovering, flier)) return undefined;
        const area = flier.combat?.area ?? here;
        const radius = combatAreaRadius(fight.attackedAgo, true, settings);
        const point = hoverPoints(at, here, ranges.optimal, settings, this.#random).find(
          (candidate) => flat(candidate.at, area) <= radius,
        );
        if (!point) return undefined;
        this.#shared.hovering.add(flier.reference);
        return {
          kind,
          step: 'approach',
          until: Infinity,
          goal: this.#overGround(point.at, flier),
          heading: point.heading,
          checked: 0,
        };
      }
      case 'groundAttack': {
        // One flier lands or fights on the ground at a time.
        if (this.#othersIn(this.#shared.landing, flier)) return undefined;
        const spot = this.#groundSpot(flier, target, ranges.optimal);
        if (!spot) return undefined;
        this.#shared.landing.add(flier.reference);
        return {
          kind,
          step: 'approach',
          until: Infinity,
          goal: spot,
          heading: Math.atan2(spot[0] - here[0], spot[1] - here[1]),
          checked: 0,
        };
      }
      case 'perchAttack': {
        const perch = this.#perchFor(flier, target, ranges.reach);
        if (!perch) return undefined;
        this.#perchUsers.set(perch.reference, flier.reference);
        return {
          kind,
          step: 'approach',
          until: Infinity,
          goal: perch.position,
          heading: perch.heading,
          perch: perch.reference,
          checked: this.#clock,
        };
      }
      case 'flyingAttack': {
        if (target.grabbable !== true) return undefined;
        flier.grab?.done(false);
        const grab = {
          victim: target.reference,
          started: this.#clock,
          phase: 'approach' as 'approach' | 'enter' | 'carry' | 'done',
          done: (): void => {
            if (flier.grab !== grab) return;
            flier.grab = undefined;
            this.#grabbed.delete(grab.victim);
          },
        };
        flier.grab = grab;
        return { kind, step: 'approach', until: Infinity, from: [...target.feet], checked: 0 };
      }
    }
  }

  /** One frame of a maneuver; false once it is over (success or failure: the loop orbits again). */
  #maneuverFrame(
    flier: Flier,
    combat: FlierCombat,
    target: FlightTarget,
    fight: FlightFight,
  ): boolean {
    const maneuver = combat.maneuver;
    if (!maneuver) return false;
    const settings = this.#settings;
    const here = flier.staged.position;
    const able = this.mayFly(flier.reference);
    switch (maneuver.kind) {
      case 'diveBomb': {
        const goal = maneuver.goal ?? target.feet;
        const lifted = this.#overGround(goal, flier);
        // Fast, slowing within fCombatDiveBombSlowDownDistance of its target.
        const slow = distance3(here, target.feet) <= settings.diveBombSlowDownDistance;
        flier.request = { kind: 'cruise', to: lifted, ...(slow ? { slow: true } : { fast: true }) };
        return !(
          distance3(here, lifted) <= (maneuver.arrive ?? 0) ||
          passed(here, flier.staged.heading, lifted)
        );
      }
      case 'hover': {
        if (maneuver.step === 'approach') {
          const at = maneuver.goal ?? here;
          flier.request = {
            kind: 'hover',
            at,
            face: [target.feet[0], target.feet[1], target.feet[2] + target.height * 0.75],
          };
          if (flier.state === FlyingState.hovering) {
            maneuver.step = 'there';
            maneuver.until =
              this.#clock + maneuverSeconds('hover', fight.flight, settings, this.#random);
          }
          return true;
        }
        if (maneuver.step === 'there') {
          // It faces its target while it hovers.
          flier.request = {
            kind: 'hover',
            at: here,
            face: [target.feet[0], target.feet[1], target.feet[2] + target.height * 0.75],
          };
          if (this.#clock >= maneuver.until && !this.#busy(flier)) {
            maneuver.step = 'leaving';
            this.#shared.hovering.delete(flier.reference);
          }
          return flier.state === FlyingState.hovering;
        }
        // Leaving: back into its cruise (ActionHoverStop).
        flier.request = { kind: 'cruise', to: ahead(flier.staged, 4096) };
        return flier.state !== FlyingState.cruising;
      }
      case 'groundAttack': {
        if (maneuver.step === 'approach') {
          const spot = maneuver.goal ?? target.feet;
          flier.request = {
            kind: 'land',
            at: spot,
            how: 'hasty',
            ...(maneuver.heading !== undefined && { heading: maneuver.heading }),
          };
          if (flier.state === FlyingState.none && flier.asked === undefined) {
            maneuver.step = 'there';
            maneuver.until =
              this.#clock + maneuverSeconds('ground', fight.flight, settings, this.#random);
            this.#log(flier, 'groundAttack: landed');
          }
          return true;
        }
        if (maneuver.step === 'there') {
          flier.request = undefined;
          if (this.#clock >= maneuver.until && !this.#busy(flier) && able) {
            maneuver.step = 'leaving';
            this.#shared.landing.delete(flier.reference);
            this.#log(flier, 'groundAttack: takes off');
          }
          return true;
        }
        flier.request = { kind: 'cruise', to: ahead(flier.staged, 4096) };
        return flier.state !== FlyingState.cruising;
      }
      case 'perchAttack': {
        const perch = maneuver.perch;
        if (perch === undefined) return false;
        // Its target out of the perch's view (checked every second): it leaves.
        if (this.#clock - maneuver.checked >= SELECT_SECONDS && maneuver.step !== 'leaving') {
          maneuver.checked = this.#clock;
          const faces = perchFaces(
            { position: maneuver.goal ?? here, heading: maneuver.heading ?? 0 },
            target.feet,
            settings,
          );
          if (!faces) {
            if (maneuver.step === 'approach') return false;
            maneuver.until = this.#clock;
          }
        }
        if (maneuver.step === 'approach') {
          flier.request = {
            kind: 'land',
            at: maneuver.goal ?? here,
            target: perch,
            perch,
            ...(maneuver.heading !== undefined && { heading: maneuver.heading }),
          };
          if (flier.state === FlyingState.perching) {
            maneuver.step = 'there';
            maneuver.until =
              this.#clock + maneuverSeconds('perch', fight.flight, settings, this.#random);
          }
          return true;
        }
        if (maneuver.step === 'there') {
          flier.request = {
            kind: 'land',
            at: maneuver.goal ?? here,
            target: perch,
            perch,
          };
          if (this.#clock >= maneuver.until && !this.#busy(flier) && able) {
            maneuver.step = 'leaving';
            this.#perchUsers.delete(perch);
          }
          return true;
        }
        flier.request = { kind: 'cruise', to: ahead(flier.staged, 4096) };
        return flier.state !== FlyingState.cruising;
      }
      case 'flyingAttack': {
        const grab = flier.grab;
        if (!grab) return flier.state === FlyingState.action;
        const victim = this.#options.get(grab.victim);
        // Its victim moved on beyond the threshold before it reached it: it gives up.
        if (
          grab.phase === 'approach' &&
          (!victim ||
            victim.dead ||
            flat(victim.position, maneuver.from ?? victim.position) >
              settings.flyingAttackTargetDistance)
        ) {
          grab.done(false);
          return false;
        }
        flier.request = { kind: 'grab', victim: grab.victim };
        return true;
      }
    }
  }

  /** A maneuver ends: what it holds is let go. */
  #endManeuver(flier: Flier, combat: FlierCombat, why: string): void {
    const maneuver = combat.maneuver;
    if (!maneuver) return;
    combat.maneuver = undefined;
    this.#shared.hovering.delete(flier.reference);
    this.#shared.landing.delete(flier.reference);
    if (maneuver.perch !== undefined && this.#perchUsers.get(maneuver.perch) === flier.reference) {
      if (flier.state !== FlyingState.perching) this.#perchUsers.delete(maneuver.perch);
    }
    if (maneuver.kind === 'flyingAttack' && flier.grab?.phase === 'approach')
      flier.grab.done(false);
    this.#log(flier, `${maneuver.kind} ends (${why})`);
  }

  /**
   * Unable to fly in the air (observed in the original: the Crash Land Sequence): once it
   * cruises, it lands: on its forced landing marker, else the nearest landing marker within
   * fCombatLandingZoneDistance of it (of the player when hurt and fighting them, where a crash
   * strip near competes: a crash landing), else the navmesh near it within
   * fCombatLandingSearchDistance, else any landing marker, else it circles and tries again.
   */
  #landFrame(flier: Flier, combat: FlierCombat, target: FlightTarget): void {
    if (combat.landing) {
      flier.request = combat.landing;
      return;
    }
    if (flier.state !== FlyingState.cruising) {
      // Out of a hover, it cruises first.
      if (flier.state === FlyingState.hovering) {
        flier.request = { kind: 'cruise', to: ahead(flier.staged, 4096) };
      }
      return;
    }
    if (this.#othersIn(this.#shared.landing, flier)) {
      this.#orbit(flier, target.feet, this.#settings.orbitDistance);
      return;
    }
    const landing = this.#forcedLanding(flier, target);
    if (!landing) {
      this.#orbit(flier, target.feet, this.#settings.orbitDistance);
      return;
    }
    this.#shared.landing.add(flier.reference);
    combat.landing = landing;
    flier.request = landing;
    this.#log(flier, `lands at ${round(landing.kind === 'land' ? landing.at : [0, 0, 0])}`);
  }

  /** Where a flier that cannot fly lands (the Land Selector), if anywhere now. */
  #forcedLanding(flier: Flier, target: FlightTarget | undefined): FlightRequest | undefined {
    const settings = this.#settings;
    const runtime = this.#options.session.scriptsReady;
    const forced = runtime?.state.actors.get(flier.reference)?.forcedLandingMarker;
    const marker =
      forced === undefined ? undefined : runtime?.world.livePlacement?.(forced)?.position;
    if (marker) {
      return {
        kind: 'land',
        at: [marker[0], marker[1], marker[2]],
        target: forced,
        ...(this.#headings.get(forced ?? 0) !== undefined && {
          heading: this.#headings.get(forced ?? 0),
        }),
      };
    }
    // Hurt and fighting the player: round the player, a crash strip competing.
    const hurtByPlayer = flier.injured && target?.reference === PLAYER;
    const centre = hurtByPlayer ? target.feet : flier.staged.position;
    const near = this.#landingMarker(centre, settings.landingZoneDistance, hurtByPlayer);
    if (near) return near;
    const nav = this.#options.navmeshes?.()?.nearest?.(centre, settings.landingSearchDistance);
    if (nav) return { kind: 'land', at: [nav[0], nav[1], nav[2]] };
    return this.#landingMarker(centre, Infinity, false);
  }

  /** The nearest landing marker (DragonMarker; a crash strip too) in reach, clear of actors. */
  #landingMarker(centre: Vec3, reach: number, crash: boolean): FlightRequest | undefined {
    const markers = this.#landingMarkers();
    if (!markers) return undefined;
    let best: { object: StageObject; distance: number; crash: boolean } | undefined;
    for (const object of this.#options.objects?.() ?? []) {
      const isLand = object.base === markers.land;
      const isCrash = crash && object.base === markers.crash;
      if (!isLand && !isCrash) continue;
      const distance = flat(object.position, centre);
      if (distance > reach || (best && distance >= best.distance)) continue;
      if (!this.#clearOfActors(object.position, this.#settings.landingZoneClearRadius)) continue;
      best = { object, distance, crash: isCrash };
    }
    if (!best) return undefined;
    void this.#landingHeading(best.object.reference);
    const heading = this.#headings.get(best.object.reference);
    return {
      kind: 'land',
      at: [...best.object.position],
      target: best.object.reference,
      ...(heading !== undefined && { heading }),
      ...(best.crash && { how: 'crash' as const }),
    };
  }

  /** The landing markers' bases (DOBJ), read once (undefined meanwhile). */
  #landingMarkers():
    { readonly land: number | undefined; readonly crash: number | undefined } | undefined {
    if (!this.#markersRead) {
      this.#markersRead = true;
      void this.#options.session
        .defaultObjects()
        .then((objects) => {
          this.#markers = { land: objects.get('DLZM'), crash: objects.get('DCZM') };
        })
        .catch(() => undefined);
    }
    return this.#markers;
  }

  /** Whether no actor of the stage stands within its size and `clear` of a point. */
  #clearOfActors(point: Vec3, clear: number): boolean {
    for (const staged of this.#actors) {
      if (staged.dead || staged.visibility.hidden) continue;
      const radius = this.#options.movers.radius(staged.reference) ?? 0;
      if (flat(staged.position, point) <= radius + clear) return false;
    }
    return true;
  }

  /**
   * A ground attack's spot (observed in the original: a hasty landing round its target
   * within its optimal range, clear of the target and of every large actor): the navmesh nearest
   * the point on its own side of the target beyond both their sizes.
   */
  #groundSpot(flier: Flier, target: FlightTarget, range: number): Vec3 | undefined {
    const navmeshes = this.#options.navmeshes?.();
    if (!navmeshes?.nearest) return undefined;
    const here = flier.staged.position;
    const extents = this.#extents(flier, target);
    const dx = here[0] - target.feet[0];
    const dy = here[1] - target.feet[1];
    const length = Math.hypot(dx, dy) || 1;
    const near: Vec3 = [
      target.feet[0] + (dx / length) * extents,
      target.feet[1] + (dy / length) * extents,
      target.feet[2],
    ];
    const spot = navmeshes.nearest(near, range);
    if (!spot) return undefined;
    const at: Vec3 = [spot[0], spot[1], spot[2]];
    if (flat(at, target.feet) > range) return undefined;
    // Clear of the large actors (and of its target).
    for (const staged of this.#actors) {
      if (staged.dead || staged.reference === flier.reference) continue;
      const radius = this.#options.movers.radius(staged.reference) ?? 0;
      if (staged.reference !== target.reference && radius <= this.#settings.landingAvoidActorRadius)
        continue;
      if (flat(staged.position, at) < radius + (flier.shape?.radius ?? FLIER_RADIUS))
        return undefined;
    }
    return at;
  }

  /**
   * A perch for a perch attack (observed in the original): one of the loaded perches at
   * random, within its reach of the target, facing the target within fCombatPerchMaxTargetAngle,
   * free, with a clear line from it to the target.
   */
  #perchFor(
    flier: Flier,
    target: FlightTarget,
    reach: number,
  ): { reference: number; position: Vec3; heading: number } | undefined {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return undefined;
    const candidates: { reference: number; position: Vec3; heading: number }[] = [];
    for (const object of this.#options.objects?.() ?? []) {
      if (object.baseType !== 'FURN' || this.#perchBaseNow(runtime, object.base) !== true) continue;
      const user = this.#perchUsers.get(object.reference);
      if (user !== undefined && user !== flier.reference) continue;
      if (distance3(object.position, target.feet) > reach) continue;
      void this.#landingHeading(object.reference);
      const heading = this.#headings.get(object.reference);
      if (heading === undefined) continue;
      const perch = {
        reference: object.reference,
        position: [...object.position] as Vec3,
        heading,
      };
      if (!perchFaces(perch, target.feet, this.#settings)) continue;
      candidates.push(perch);
    }
    while (candidates.length > 0) {
      const index = Math.floor(this.#random() * candidates.length);
      const [perch] = candidates.splice(index, 1);
      if (perch && this.#lineOfSight(perch.position, target)) return perch;
    }
    return undefined;
  }

  /** A clear line from a point (a perch's marker) to a target's chest. */
  #lineOfSight(from: Vec3, target: FlightTarget): boolean {
    const physics = this.#options.movers.physics;
    if (!physics?.queriesCurrent) return true;
    const start: Vec3 = [from[0], from[1], from[2] + 200];
    const end: Vec3 = [target.feet[0], target.feet[1], target.feet[2] + target.height * 0.75];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const dz = end[2] - start[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 1) return true;
    const hit = physics.raycast(
      start,
      [dx / length, dy / length, dz / length],
      length,
      Layer.lineOfSight,
    );
    return hit === undefined || length - hit.distance < 64;
  }

  /** Whether another flier is in a shared set (landing, hovering). */
  #othersIn(set: ReadonlySet<number>, flier: Flier): boolean {
    for (const reference of set) {
      if (reference !== flier.reference && this.#fliers.has(reference)) return true;
    }
    return false;
  }

  /**
   * Whether its actions are free (observed in the original: the combat tree holds them
   * while it flies to a hover point, lands, comes to a perch or grabs; free while it circles and
   * dive bombs, hovering and perched once there). On the ground the combat AI's own shouts fight.
   */
  #actionsFree(flier: Flier, combat: FlierCombat): boolean {
    if (flier.state === FlyingState.none) return false;
    if (flier.state === FlyingState.takeOff || flier.state === FlyingState.landing) return false;
    if (combat.phase === 'land' || combat.phase === 'leavePerch') return false;
    const maneuver = combat.maneuver;
    if (!maneuver) return true;
    if (maneuver.kind === 'diveBomb') return true;
    if (maneuver.kind === 'flyingAttack') return false;
    return maneuver.step === 'there';
  }

  /** Busy (observed in the original): a timed maneuver does not end while it breathes. */
  #busy(flier: Flier): boolean {
    const runtime = this.#options.session.scriptsReady;
    if (runtime?.casting.isShouting(flier.reference) === true) return true;
    return flier.staged.placed.behavior?.variable('IsBusy') === 1;
  }

  /** Its ranges against its target (flightRanges), its breath's read once. */
  #ranges(
    flier: Flier,
    target: FlightTarget,
    fight: FlightFight,
  ): { readonly optimal: number; readonly reach: number } {
    if (!flier.ranges) {
      const runtime = this.#options.session.scriptsReady;
      flier.ranges = shoutRanges(BREATH_RANGE, 0, this.#settings);
      if (runtime) {
        void this.#breathRanges(runtime, flier.reference)
          .then((ranges) => {
            if (ranges) flier.ranges = ranges;
          })
          .catch(() => undefined);
      }
    }
    return flightRanges({
      extents: this.#extents(flier, target),
      optimal: flier.ranges.optimal,
      max: Math.max(flier.ranges.max, this.#settings.flightMinimumRange),
      styleOptimal: fight.styleOptimal,
    });
  }

  /** Its shouts' ranges, the smallest of them (the combat inventory's set). */
  async #breathRanges(
    runtime: ScriptRuntime,
    reference: number,
  ): Promise<{ optimal: number; max: number } | undefined> {
    let best: { optimal: number; max: number } | undefined;
    for (const shout of await this.#knownShouts(runtime, reference)) {
      const range = await this.#shoutRange(runtime, shout);
      const ranges = shoutRanges(range, 0, this.#settings);
      if (!best || ranges.max < best.max) best = { optimal: ranges.optimal, max: ranges.max };
    }
    return best;
  }

  /** Its radius and its target's. */
  #extents(flier: Flier, target: FlightTarget): number {
    return (flier.shape?.radius ?? FLIER_RADIUS) + (target.radius ?? 32);
  }

  /** Its race's flight radius (RACE DATA; dragons 400), kept over the ground. */
  #flightRadius(flier: Flier): number {
    return flier.radius ?? FLIGHT_RADIUS;
  }

  /** A point raised to its flight radius over the ground under it (the fly path's goal). */
  #overGround(point: Vec3, flier: Flier): Vec3 {
    const ground = this.#groundUnder(point);
    const least = (ground ?? point[2]) + this.#flightRadius(flier);
    return point[2] < least ? [point[0], point[1], least] : point;
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
    this.#actors = [...actors];
    const seen = new Set<number>();
    for (const staged of this.#actors) {
      if (staged.dead || staged.visibility.hidden) continue;
      if (!fliesByRace(staged.placed.look.raceFlags)) continue;
      seen.add(staged.reference);
      const flier = this.#flier(staged.reference);
      if (!flier) continue;
      flier.staged = staged;
      try {
        this.#update(flier, runtime, seconds);
      } catch (error) {
        this.#warn(`${hex(staged.reference)}: ${describe(error)}`);
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
    // Injured (the graph's Injured: it cannot fly, its landings hurt) and Dragonrend.
    if (this.#clock - flier.valuesRead >= VALUES_SECONDS) {
      flier.valuesRead = this.#clock;
      void this.#readValues(flier, runtime, behavior).catch(() => undefined);
    }
    if (flier.asked && this.#clock - flier.asked.at > ASK_AGAIN) flier.asked = undefined;
    // Killed in the air: it comes down (it cannot fly without health) and dies as it lands, at
    // the latest after the deferred kill's time.
    const deferred = flier.deferred;
    if (deferred && flier.health <= 0) {
      deferred.downSince ??= this.#clock;
      if (this.#clock - deferred.downSince >= DEFERRED_KILL) this.#endDeferredKill(flier);
    }
    // Placed in the air: it starts cruising there.
    if (!flier.checkedAir && staged.grounded) {
      flier.checkedAir = true;
      const start = staged.placed.start;
      if (
        flier.state === FlyingState.none &&
        this.mayFly(reference) &&
        ((start?.kind === 'at' && start.sky === true) || this.#highAboveGround(staged))
      ) {
        this.startCruising(reference);
      }
    }
    this.#grabFrame(flier, behavior);
    this.#travelFrame(flier);
    this.#hoverFrame(flier);
    // Outside a fight it does what its packages ask.
    if (!flier.combat) flier.request = flier.package;
    // Unable to fly in the air outside a fight (hurt, not allowed, killed): it lands (observed in
    // the original: the AI process lands a hurt flier at its forced landing marker, else a
    // landing marker; the navmesh near it else).
    const grounded = !flier.combat && airborne(flier.state) && !this.mayFly(reference);
    if (grounded) flier.request = this.#landNear(flier);
    if (grounded !== flier.grounded) {
      flier.grounded = grounded;
      if (grounded) {
        const why = [
          flier.injured ? 'hurt' : '',
          flier.health <= 0 ? 'no health' : '',
          this.allowed(reference) ? '' : 'not allowed',
        ].filter((reason) => reason !== '');
        this.#log(flier, `cannot fly (${why.join(', ')}): ${describeRequest(flier.request)}`);
      }
    }
    const request = flier.request;
    if (flier.state === FlyingState.none) {
      // On the ground: it takes off for what it wants in the air.
      if (
        flier.asked === undefined &&
        request &&
        wantsAir(request, staged.position) &&
        this.mayFly(reference)
      ) {
        this.#takeOff(flier, behavior);
        this.#options.movers.release(reference);
      }
      return;
    }
    if (flier.state === FlyingState.perching) {
      // On a perch: off again only for what needs it in the air (not its landing there, not
      // nothing asked).
      const stays =
        request === undefined ||
        (request.kind === 'land' && request.perch !== undefined && request.perch === flier.perch);
      // (Unable to fly, a fight still takes it off its perch: its Leave Perch.)
      const leaves =
        wantsTakeoff(this.mayFly(reference), flier.state) || flier.combat?.phase === 'leavePerch';
      if (!stays && flier.asked === undefined && leaves) this.#takeOff(flier, behavior);
      this.#face(flier, behavior, request);
      return;
    }
    if (flier.state === FlyingState.hovering) {
      this.#hover(flier, behavior, request);
      return;
    }
    if (flier.state !== FlyingState.cruising || flier.asked !== undefined) return;
    if (animationDriven(behavior)) return;
    this.#cruise(flier, behavior, request, seconds);
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
    let goal: Vec3;
    let stopAt: Vec3 | undefined;
    let speed: 'walk' | 'run' = 'walk';
    switch (request?.kind) {
      case 'cruise':
        goal = this.#overGround(request.to, flier);
        speed = request.fast === true ? 'run' : 'walk';
        break;
      case 'orbit':
        goal = orbitPoint(
          request.center,
          request.radius,
          request.height,
          here,
          request.clockwise ?? true,
        );
        // Its orbit at combat's speed (the fastest), a package's at its walk.
        speed = flier.combat ? 'run' : 'walk';
        break;
      case 'hover': {
        goal = request.at;
        stopAt = request.at;
        if (distance3(here, request.at) <= HOVER_ENTER) {
          this.#tween(behavior, request.at, faceHeading(request.at, request.face), staged.heading);
          this.#ask(flier, 'hover', 'ActionHoverStart');
          return;
        }
        speed = flier.combat ? 'run' : 'walk';
        break;
      }
      case 'land': {
        const heading =
          request.heading ?? Math.atan2(request.at[0] - here[0], request.at[1] - here[1]);
        const approach = landingApproach(request.at, heading);
        goal = approach;
        stopAt = approach;
        if (distance3(here, approach) <= APPROACH_REACH) {
          this.#land(flier, behavior, request, heading);
          return;
        }
        speed = flier.combat ? 'run' : 'walk';
        break;
      }
      case 'grab': {
        const victim = this.#options.get(request.victim);
        if (!victim || victim.dead) {
          flier.grab?.done(false);
          return;
        }
        goal = this.#overGround(victim.position, flier);
        if (distance3(here, victim.position) <= GRAB_ENTER && flier.grab?.phase === 'approach') {
          const heading = Math.atan2(victim.position[0] - here[0], victim.position[1] - here[1]);
          this.#tween(behavior, victim.position, heading, staged.heading);
          behavior.setVariable('TweenEntryDirectionFlightKillGrab', 0);
          if (behavior.sendEvent('to_Flight_Kill_Grab_Enter')) {
            flier.grab.phase = 'enter';
            this.#log(flier, `grabs ${hex(request.victim)}`);
          }
          return;
        }
        speed = 'run';
        break;
      }
      default: {
        // Nothing asked: it circles where it began to. TODO(M13): what the engine's flight path
        // follower does once its path is done and no procedure asks again is not read.
        flier.idle ??= [...here];
        goal = orbitPoint(flier.idle, IDLE_ORBIT, 0, here, true);
      }
    }
    if (request) flier.idle = undefined;
    this.#steer(flier, behavior, goal, stopAt, speed, seconds);
  }

  /** One step of steering for a goal at the graph's speed, kept its flight radius over the ground. */
  #steer(
    flier: Flier,
    behavior: BehaviorRuntime,
    goal: Vec3,
    stopAt: Vec3 | undefined,
    gait: 'walk' | 'run',
    seconds: number,
  ): void {
    const staged = flier.staged;
    const speeds = flier.speeds ?? this.#speeds(flier);
    const graphSpeed = behavior.variable('Speed');
    // The graph flies at its own Speed (its acceleration, drag and turns), towards TargetSpeed.
    const speed = graphSpeed !== undefined && graphSpeed > 0 ? graphSpeed : speeds.walk;
    const clearance = this.#flightRadius(flier);
    const ground = this.#groundUnder(goal);
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
    behavior.setVariable('TargetSpeed', gait === 'run' ? speeds.run : speeds.walk);
    behavior.setVariable('TurnDelta', step.turnDelta);
    behavior.setVariable('PitchDelta', step.pitchDelta);
    behavior.setVector('MovementDirection', [...step.direction, 0]);
    if (stopAt) {
      // Coming to a landing, a hover: the remaining way, and the clip's own speed to slow to
      // (observed in the original: TweenSpeed the chosen clip's root-motion speed).
      const left = distance3(staged.position, stopAt);
      behavior.setVariable('HasTweenSpeed', 1);
      behavior.setVariable('DistToGoal', left);
      behavior.setVariable('TweenSpeed', speeds.walk);
    } else {
      behavior.setVariable('HasTweenSpeed', 0);
      behavior.setVariable('DistToGoal', distance3(staged.position, goal));
    }
    this.#draw(flier);
  }

  /** Hovering: it turns to face what it hovers for; another wish ends the hover (nothing: it stays). */
  #hover(flier: Flier, behavior: BehaviorRuntime, request: FlightRequest | undefined): void {
    if (flier.asked !== undefined) return;
    const here = flier.staged.position;
    const stays =
      request === undefined ||
      (request.kind === 'hover' && distance3(here, request.at) <= HOVER_ENTER / 2);
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
    // Held in place, it has no way to go: no speed for the graph's hover and perch blends.
    behavior.setVariable('TargetSpeed', 0);
    behavior.setVector('MovementDirection', [0, 0, 0, 0]);
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
   * It takes off (ActionFlyStart: off the ground, or off its perch). Observed in the
   * original: the take-off keeps where it is and the way it faces (TweenPosition its place,
   * TweenRotation its heading); it turns for its goal once it cruises.
   */
  #takeOff(flier: Flier, behavior: BehaviorRuntime): void {
    const staged = flier.staged;
    this.#tween(behavior, staged.position, staged.heading, staged.heading);
    this.#ask(flier, 'takeoff', 'ActionFlyStart');
    this.#log(flier, `takes off for ${describeRequest(flier.request)}`);
  }

  /** It begins its landing: the spot and its heading for the tweener, then ActionFlyStop. */
  #land(
    flier: Flier,
    behavior: BehaviorRuntime,
    request: Extract<FlightRequest, { kind: 'land' }>,
    heading: number,
  ): void {
    const staged = flier.staged;
    this.#tween(behavior, request.at, heading, staged.heading);
    flier.landing = { spot: request.at, heading, target: request.target, perch: request.perch };
    if (request.perch !== undefined) this.#perchUsers.set(request.perch, flier.reference);
    const runtime = this.#options.session.scriptsReady;
    const target =
      request.target === undefined || !runtime
        ? undefined
        : runtime.referenceHandle(request.target);
    this.#ask(flier, 'land', 'ActionFlyStop', target);
    this.#log(flier, `lands: ${describeRequest(request)}`);
  }

  /**
   * Unable to fly outside a fight: a landing near where it is (its forced landing marker, a
   * landing marker, the navmesh near it); a crash landing under Dragonrend (unless
   * SetAllowFlyingEx forbade crashing), a hasty one when a script grounds it.
   */
  #landNear(flier: Flier): FlightRequest | undefined {
    const landing = this.#forcedLanding(flier, undefined);
    if (landing?.kind !== 'land') return landing;
    if (flier.injured || flier.health <= 0) return landing;
    const crash =
      flier.rended &&
      this.#options.session.scriptsReady?.state.actors.get(flier.reference)?.allowCrashLand !==
        false;
    return { ...landing, how: crash ? 'crash' : (landing.how ?? 'hasty') };
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
        this.#warn(`${hex(flier.reference)} ${action}: ${describe(error)}`);
      });
  }

  /** A package's way flown: to a point in the air, through it; to a place, landed there. */
  #travelFrame(flier: Flier): void {
    const travel = flier.travel;
    if (!travel) return;
    const here = flier.staged.position;
    if (travel.aloft) {
      // Reached within its radius and the hysteresis across, its height window up and down
      // (or flown by: the fly path ends at its point).
      if (
        airborne(flier.state) &&
        (pointReached(here, travel.to, travel.arrive, this.#settings) ||
          (flat(here, travel.to) <= travel.arrive + APPROACH_REACH &&
            passed(here, flier.staged.heading, travel.to)))
      ) {
        travel.done(true);
      }
      return;
    }
    // Landed there (on the ground, or on a perch).
    if (
      (flier.state === FlyingState.none || flier.state === FlyingState.perching) &&
      flier.asked === undefined &&
      flier.landing === undefined &&
      flat(here, travel.to) <= Math.max(travel.arrive, APPROACH_REACH)
    ) {
      travel.done(true);
    }
  }

  /** A package's hover: done once it hovers within its radius of the point. */
  #hoverFrame(flier: Flier): void {
    const hovering = flier.hovering;
    if (!hovering || flier.state !== FlyingState.hovering) return;
    if (distance3(flier.staged.position, hovering.at) <= hovering.radius) hovering.done(true);
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
        // Let go high over the ground (observed in the original: the release only detaches
        // it from the talons; the fall kills it). TODO(M13): actors' fall damage (that of
        // src/gameplay/falling.ts is the player's); until it is theirs, the release kills it.
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
    this.#setState(flier, state, event);
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
    if (
      state === FlyingState.takeOff ||
      (state === FlyingState.cruising && was === FlyingState.perching)
    ) {
      // Off its perch.
      if (flier.perch !== undefined) this.#perchUsers.delete(flier.perch);
      flier.perch = undefined;
      this.#options.movers.release(flier.reference);
    }
    if (state === FlyingState.perching) {
      // (Perched: its landing was onto a perch, its target; FlightPerching and PerchLandEnd
      // both tell it, the landing gone by the second.)
      const landing = flier.landing;
      if (landing) flier.perch = landing.perch ?? landing.target;
      if (landing) {
        flier.staged.position = [...landing.spot];
        flier.staged.heading = landing.heading;
        this.#draw(flier);
      }
      flier.landing = undefined;
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
      this.#shared.landing.delete(flier.reference);
      if (flier.combat?.phase === 'land') flier.combat.landing = undefined;
    }
  }

  /** Its flying state set, the change traced; off the ground its deferred kill. */
  #setState(flier: Flier, state: FlyingStateValue, why: string): void {
    if (flier.state === state) return;
    if (flier.state === FlyingState.none && !flier.deferred) {
      flier.deferred = { downSince: undefined };
      this.#options.session.scriptsReady?.actors.startDeferredKill(flier.reference);
    } else if (state === FlyingState.none) {
      this.#endDeferredKill(flier);
    }
    this.#trace.push(
      `${this.#stamp()} ${hex(flier.reference)} ${STATE_NAMES[flier.state] ?? '?'} -> ${STATE_NAMES[state] ?? '?'} (${why}) at ${round(flier.staged.position)}`,
    );
    if (this.#trace.length > TRACE_LINES) this.#trace.splice(0, this.#trace.length - TRACE_LINES);
    flier.state = state;
  }

  /** Its deferred kill ends: if its health ran out meanwhile, it dies now. */
  #endDeferredKill(flier: Flier): void {
    if (!flier.deferred) return;
    flier.deferred = undefined;
    const runtime = this.#options.session.scriptsReady;
    if (flier.health <= 0) this.#log(flier, 'dies as it lands');
    void runtime?.actors.endDeferredKill(flier.reference).catch((error: unknown) => {
      this.#warn(`${hex(flier.reference)} deferred kill: ${describe(error)}`);
    });
  }

  #log(flier: Flier, what: string): void {
    this.#trace.push(
      `${this.#stamp()} ${hex(flier.reference)} ${what} at ${round(flier.staged.position)}`,
    );
    if (this.#trace.length > TRACE_LINES) this.#trace.splice(0, this.#trace.length - TRACE_LINES);
  }

  #stamp(): string {
    return this.#clock.toFixed(1).padStart(7);
  }

  // --- Places -------------------------------------------------------------------------------

  /**
   * The heading a flier lands at on a reference (observed in the original): the
   * reference's own (its z rotation), but none for a plain XMarker (the way it comes in).
   * Read once each; undefined meanwhile and for markers.
   */
  async #landingHeading(reference: number): Promise<number | undefined> {
    if (this.#headings.has(reference)) return this.#headings.get(reference);
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return undefined;
    const [placement, base] = await Promise.all([
      runtime.placement(reference),
      runtime.baseOf(reference),
    ]);
    const record = base === undefined ? undefined : await runtime.forms.record(base);
    const plain = record?.editorId === 'XMarker';
    const heading = placement && !plain ? placement.rotation[2] : undefined;
    this.#headings.set(reference, heading);
    return heading;
  }

  /** Where a reference is (the loaded area's objects, else its placement). */
  async #placeOf(reference: number): Promise<Vec3 | undefined> {
    for (const object of this.#options.objects?.() ?? []) {
      if (object.reference === reference) return [...object.position];
    }
    const at = await this.#options.session.scriptsReady?.placement(reference);
    return at && [at.position[0], at.position[1], at.position[2]];
  }

  /** Whether a furniture base is a perch (MNAM Is Perch), read once. */
  async #perchBase(runtime: ScriptRuntime, base: number): Promise<boolean> {
    const known = this.#perchBases.get(base);
    if (known !== undefined) return known;
    const record = await runtime.forms.record(base).catch(() => undefined);
    const perch =
      record?.type === 'FURN' &&
      ((parseFurniture(record).markerFlags ?? 0) & FurnitureMarkerFlag.isPerch) !== 0;
    this.#perchBases.set(base, perch);
    return perch;
  }

  /** As #perchBase, without waiting (undefined until read). */
  #perchBaseNow(runtime: ScriptRuntime, base: number): boolean | undefined {
    if (!this.#perchBases.has(base)) {
      this.#perchBases.set(base, undefined);
      void this.#perchBase(runtime, base);
    }
    return this.#perchBases.get(base);
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
    const hit = physics.raycast(
      [at[0], at[1], at[2] + 64],
      [0, 0, -1],
      16384,
      Layer.charController,
    );
    return hit?.point[2];
  }

  /** A point high over the ground (more than AIR_START over it): flown to, not landed at. */
  #aloft(at: Vec3): boolean {
    const ground = this.#groundUnder(at);
    return ground !== undefined && at[2] - ground > AIR_START;
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
      hovering: undefined,
      triggers: new Set(),
      shape: undefined,
      checkedAir: false,
      speeds: undefined,
      radius: undefined,
      idle: undefined,
      breathing: false,
      rended: false,
      health: 1,
      injured: false,
      valuesRead: -Infinity,
      grounded: false,
      deferred: undefined,
      ranges: undefined,
    };
    this.#fliers.set(reference, flier);
    void this.#readRadius(flier).catch(() => undefined);
    return flier;
  }

  /** Its race's flight radius (RACE DATA) times its scale. */
  async #readRadius(flier: Flier): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const record = runtime ? await runtime.forms.record(flier.staged.placed.look.race) : undefined;
    if (record?.type !== 'RACE') return;
    const radius = parseRaceCombat(record).flightRadius;
    const scale = flier.staged.placed.actor.scale * flier.staged.placed.look.scale;
    if (radius > 0) flier.radius = radius * scale;
  }

  /** The fliers whose speeds are being read. */
  readonly #speedsAsked = new WeakSet<Flier>();

  /**
   * Its flying speeds and turn rate: its race's flying movement type (RACE FLMV:
   * Dragon_Flying_MT, forward 2000 walking and 7400 running, turning 90° a second), else
   * fFlyingActorDefaultTurningSpeed and the graph's own.
   */
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
   * Its health and its race's injured share (the graph's Injured), and Dragonrend on it (the
   * DragonRend actor value the shout's effect raises: it may not fly meanwhile).
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
    const injured = race > 0 && share < race;
    behavior.setVariable('Injured', injured ? 1 : 0);
    if (injured !== flier.injured) this.#log(flier, injured ? 'injured' : 'recovered');
    flier.injured = injured;
    flier.health = health.current;
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
    flier.hovering?.done(false);
    this.#endDeferredKill(flier);
    for (const trigger of flier.triggers) this.#options.onTrigger?.(trigger, reference, false);
    if (flier.perch !== undefined) this.#perchUsers.delete(flier.perch);
    for (const [perch, user] of this.#perchUsers) {
      if (user === reference) this.#perchUsers.delete(perch);
    }
    this.#shared.landing.delete(reference);
    this.#shared.hovering.delete(reference);
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

const hex = (reference: number): string => reference.toString(16);
const round = (at: Vec3): string => at.map((v) => Math.round(v)).join(',');

/** A request in a few words (the flight trace). */
function describeRequest(request: FlightRequest | undefined): string {
  if (!request) return 'nothing';
  switch (request.kind) {
    case 'cruise':
      return `cruise to ${round(request.to)}`;
    case 'orbit':
      return `orbit ${round(request.center)} r${String(Math.round(request.radius))}`;
    case 'hover':
      return `hover at ${round(request.at)}`;
    case 'land': {
      const on = request.target === undefined ? '' : ` on ${hex(request.target)}`;
      const perch = request.perch === undefined ? '' : ' (perch)';
      return `land at ${round(request.at)}${on}${perch}${request.how ? ` ${request.how}` : ''}`;
    }
    case 'grab':
      return `grab ${hex(request.victim)}`;
  }
}

/** Whether its graph moves it now (bAnimationDriven, bIsSynced): its clips and tweeners do. */
function animationDriven(behavior: BehaviorRuntime): boolean {
  return behavior.variable('bAnimationDriven') === 1 || behavior.variable('bIsSynced') === 1;
}

/**
 * Whether a request has a flier on the ground in the air: a flight anywhere; a landing on a
 * perch (landed on from the air, however near) or far off (flown to: a Travel on the ground
 * walks, actor-ai.ts).
 */
function wantsAir(request: FlightRequest, here: Vec3): boolean {
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

/** A point ahead of an actor (the way it flies on), at its height. */
function ahead(staged: StagedActor, distance: number): Vec3 {
  return [
    staged.position[0] + Math.sin(staged.heading) * distance,
    staged.position[1] + Math.cos(staged.heading) * distance,
    staged.position[2],
  ];
}

/** The heading from a point to what it faces. */
function faceHeading(from: Vec3, face: Vec3): number {
  return Math.atan2(face[0] - from[0], face[1] - from[1]);
}
