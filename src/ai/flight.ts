// Flying (docs/ai.md, "Flying combat"; docs/m10-plan.md 5.4): who flies (RACE DATA Flies: the
// dragons' races), the flying states the engine keeps (CommonLibSSE FLY_STATE: GetFlyingState,
// the idle tree's ActionFlyStart / ActionFlyStop conditions) as the dragon graph tells them
// (its notify events FlightTakeOff, FlightCruising, FlightHovering, FlightLanding,
// FlightPerching, FlightAction), and a flier's decisions in combat: what it does next by its
// combat style's flight section (CSTY CSFL: hover, dive bomb, ground attack, perch attack and
// flying attack chances, the hover, ground attack and perch attack times), where it goes (its
// orbit round its target, the dive bomb's pass, the hover point, the landing approach) and how
// it steers there (its flying movement type's turn rate, at the speed its graph flies). The
// load order's game settings count where it has them (fCombatHoverTimeMin,
// fCombatPerchAttackTimeMin, fCombatGroundAttackTimeMin and Max, fCombatOrbitDistance,
// fFlyingActorDefaultTurningSpeed); the
// engine's own are in no plugin, their values here are ours (TODO(M13)). How the engine weighs
// the style's chances is not documented: the rules below read each value as its name says
// (TODO(M13)). Platform-independent.

import type { CombatStyleFlight } from './combat-style-records.ts';
import { RaceFlag } from '../world/actor-records.ts';

type Vec3 = readonly [number, number, number];

/** CommonLibSSE FLY_STATE (GetFlyingState, Actor.GetFlyingState). */
export const FlyingState = {
  none: 0,
  takeOff: 1,
  cruising: 2,
  hovering: 3,
  landing: 4,
  perching: 5,
  action: 6,
} as const;

export type FlyingStateValue = (typeof FlyingState)[keyof typeof FlyingState];

/** Whether actors of a race fly (RACE DATA flag Flies, 0x80): the dragons' races in vanilla. */
export function fliesByRace(raceFlags: number): boolean {
  return (raceFlags & RaceFlag.flies) !== 0;
}

/**
 * The flying state a graph's event tells (the dragon graph raises them as its states begin:
 * ST_TakeOff_*_Air FlightTakeOff, ST_Flight FlightCruising, ST_Hover FlightHovering, ST_Land
 * FlightLanding, ST_Perch FlightPerching, ST_Flight_Kill_Grab FlightAction; LandEnd ends the
 * landing on the ground). Undefined: not a flying event.
 */
export function flyingStateOf(event: string): FlyingStateValue | undefined {
  switch (event.toLowerCase()) {
    case 'flighttakeoff':
      return FlyingState.takeOff;
    case 'flightcruising':
      return FlyingState.cruising;
    case 'flighthovering':
      return FlyingState.hovering;
    case 'flightlanding':
      return FlyingState.landing;
    case 'flightperching':
    case 'perchlandend':
      return FlyingState.perching;
    case 'flightaction':
      return FlyingState.action;
    case 'landend':
      return FlyingState.none;
    default:
      return undefined;
  }
}

/** Whether a flying state is in the air (IsFlying): taking off, cruising, hovering, landing, an action. */
export function airborne(state: number): boolean {
  return state !== FlyingState.none && state !== FlyingState.perching;
}

export interface FlightSettings {
  /** fCombatHoverTimeMin and Max: how long a hover lasts (by the style's hover time). */
  readonly hoverTimeMin: number;
  readonly hoverTimeMax: number;
  /** fCombatPerchAttackTimeMin and Max: how long it breathes from a perch. */
  readonly perchAttackTimeMin: number;
  readonly perchAttackTimeMax: number;
  /**
   * fCombatGroundAttackTimeMin and Max: how long it fights on the ground before it takes off
   * again (by the style's ground attack time).
   */
  readonly groundAttackTimeMin: number;
  readonly groundAttackTimeMax: number;
  /** fCombatOrbitDistance: how far from its target it circles (units). */
  readonly orbitDistance: number;
  /** fFlyingActorDefaultTurningSpeed: its turn rate without a flying movement type (rad/s). */
  readonly turningSpeed: number;
  /** How high over its target it circles, passes in a dive bomb, hovers (units). */
  readonly orbitHeight: number;
  readonly diveBombHeight: number;
  readonly hoverHeight: number;
  /** How far from its target it hovers (horizontally, units). */
  readonly hoverDistance: number;
  /** How far from its target it lands to fight on the ground (units). */
  readonly landingDistance: number;
  /** It keeps at least this far over the ground under it while it cruises (units). */
  readonly groundClearance: number;
  /** A perch counts for a perch attack within this of its target (units). */
  readonly perchRadius: number;
  /** A circle of its orbit lasts about this long before it chooses again (seconds). */
  readonly orbitTime: number;
}

/**
 * The load order's settings by name (GMST), else the engine's built-in values; those without a
 * name are ours, for engine values no documentation names (TODO(M13)).
 */
const SETTINGS: readonly (readonly [keyof FlightSettings, string | undefined, number])[] = [
  ['hoverTimeMin', 'fCombatHoverTimeMin', 5.5],
  ['hoverTimeMax', 'fCombatHoverTimeMax', 15],
  ['perchAttackTimeMin', 'fCombatPerchAttackTimeMin', 4],
  ['perchAttackTimeMax', 'fCombatPerchAttackTimeMax', 15],
  ['groundAttackTimeMin', 'fCombatGroundAttackTimeMin', 8],
  ['groundAttackTimeMax', 'fCombatGroundAttackTimeMax', 17],
  ['orbitDistance', 'fCombatOrbitDistance', 4000],
  ['turningSpeed', 'fFlyingActorDefaultTurningSpeed', Math.PI / 2],
  ['orbitHeight', undefined, 1536],
  ['diveBombHeight', undefined, 384],
  ['hoverHeight', undefined, 768],
  ['hoverDistance', undefined, 1280],
  ['landingDistance', undefined, 1024],
  ['groundClearance', undefined, 512],
  ['perchRadius', undefined, 6000],
  ['orbitTime', undefined, 8],
];

export function readFlightSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): FlightSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [
      key,
      (name === undefined ? undefined : number(name)) ?? fallback,
    ]),
  ) as unknown as FlightSettings;
}

export const FLIGHT_DEFAULTS = readFlightSettings();

/**
 * What a flier is asked to do (its combat's maneuver, its package's procedure): fly to a point
 * (and circle there; fast: at its running speed), circle a centre, hover at a point facing
 * another, land at a spot (facing a heading; on a perch; hasty or crashing: the idle tree's
 * FlyStopHasty and FlyStopCrash), grab an actor in flight.
 */
export type FlightRequest =
  | { readonly kind: 'cruise'; readonly to: Vec3; readonly fast?: boolean }
  | {
      readonly kind: 'orbit';
      readonly center: Vec3;
      readonly radius: number;
      readonly height: number;
      readonly clockwise?: boolean;
    }
  | { readonly kind: 'hover'; readonly at: Vec3; readonly face: Vec3 }
  | {
      readonly kind: 'land';
      readonly at: Vec3;
      readonly heading?: number;
      readonly perch?: number;
      readonly how?: 'hasty' | 'crash';
    }
  | { readonly kind: 'grab'; readonly victim: number };

// --- Decisions -------------------------------------------------------------------------------

/**
 * What a flier does next in combat: circle its target (orbit), pass low over it breathing
 * (dive bomb), hover before it and breathe, land on a perch near it to breathe from there, or
 * land to fight it on the ground.
 */
export type FlightManeuver = 'orbit' | 'diveBomb' | 'hover' | 'perch' | 'land';

export interface FlightSituation {
  /** A place to land near the target (and it may land: SetAllowFlying, its package). */
  readonly canLand: boolean;
  /** A free dragon perch near the target. */
  readonly perch: boolean;
}

/**
 * Its next maneuver as an orbit ends (or a dive bomb, a hover): each chance of its style tried
 * in turn — dive bomb, hover, perch attack (with a perch near), ground attack (with a place to
 * land) — else it circles on. TODO(M13): the engine's order and weighing are not documented.
 */
export function chooseFlightManeuver(
  flight: CombatStyleFlight,
  situation: FlightSituation,
  random: () => number,
): FlightManeuver {
  if (random() < flight.diveBombChance) return 'diveBomb';
  if (random() < flight.hoverChance) return 'hover';
  if (situation.perch && random() < flight.perchAttackChance) return 'perch';
  if (situation.canLand && random() < flight.groundAttackChance) return 'land';
  return 'orbit';
}

/** Whether it breathes at its target on a pass (CSFL flying attack chance). */
export function flyingAttack(flight: CombatStyleFlight, random: () => number): boolean {
  return random() < flight.flyingAttackChance;
}

/**
 * How long a hover, a perch attack or a fight on the ground lasts: between the settings' least
 * and most by the style's time (0: the least, 1: the most), a little at random.
 * TODO(M13): how the engine reads the style's times.
 */
export function maneuverSeconds(
  kind: 'hover' | 'perch' | 'ground',
  flight: CombatStyleFlight,
  settings: FlightSettings,
  random: () => number,
): number {
  const [min, max, mult] =
    kind === 'hover'
      ? [settings.hoverTimeMin, settings.hoverTimeMax, flight.hoverTime]
      : kind === 'perch'
        ? [settings.perchAttackTimeMin, settings.perchAttackTimeMax, flight.perchAttackTime]
        : [settings.groundAttackTimeMin, settings.groundAttackTimeMax, flight.groundAttackTime];
  const share = Math.min(1, Math.max(0, mult)) * (0.75 + 0.5 * random());
  return min + (max - min) * Math.min(1, share);
}

/** Whether it takes off again from the ground: its ground time is over, or its target flies away beyond its reach. */
export function takesOff(options: {
  readonly onGround: number;
  readonly groundTime: number;
  readonly targetDistance: number;
  readonly orbitDistance: number;
}): boolean {
  return options.onGround >= options.groundTime || options.targetDistance > options.orbitDistance;
}

// --- Where it goes ---------------------------------------------------------------------------

/**
 * The point it steers for to circle a centre: on the circle of `radius` at `height` over the
 * centre, `lead` radians ahead of where it is now (clockwise or not).
 */
export function orbitPoint(
  center: Vec3,
  radius: number,
  height: number,
  from: Vec3,
  clockwise: boolean,
  lead = 0.5,
): Vec3 {
  const angle = Math.atan2(from[1] - center[1], from[0] - center[0]);
  const next = angle + (clockwise ? -lead : lead);
  return [
    center[0] + Math.cos(next) * radius,
    center[1] + Math.sin(next) * radius,
    center[2] + height,
  ];
}

/**
 * A dive bomb's pass: low over the target (its height above it) and on beyond it as far as it
 * came, so it climbs away the way it went.
 */
export function diveBombPass(
  from: Vec3,
  target: Vec3,
  height: number,
  beyond: number,
): { readonly over: Vec3; readonly past: Vec3 } {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  return {
    over: [target[0], target[1], target[2] + height],
    past: [
      target[0] + (dx / length) * beyond,
      target[1] + (dy / length) * beyond,
      target[2] + height * 4,
    ],
  };
}

/** Where it hovers to face its target: `distance` from it on its own side, `height` above it. */
export function hoverPoint(from: Vec3, target: Vec3, distance: number, height: number): Vec3 {
  const dx = from[0] - target[0];
  const dy = from[1] - target[1];
  const length = Math.hypot(dx, dy) || 1;
  return [
    target[0] + (dx / length) * distance,
    target[1] + (dy / length) * distance,
    target[2] + height,
  ];
}

/**
 * Where a landing begins: the approach clip (MTLand45Approach) carries it 2048 units ahead and
 * 2048 down to its spot (the dragon project's animation data), so it comes to that point,
 * facing the spot, before ActionFlyStop; the graph's tweener takes it the rest of the way.
 */
export const LANDING_APPROACH = { ahead: 2048, above: 2048 } as const;

export function landingApproach(spot: Vec3, from: Vec3): Vec3 {
  const dx = spot[0] - from[0];
  const dy = spot[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  return [
    spot[0] - (dx / length) * LANDING_APPROACH.ahead,
    spot[1] - (dy / length) * LANDING_APPROACH.ahead,
    spot[2] + LANDING_APPROACH.above,
  ];
}

/**
 * The graph's TweenEntryDirection: the turn from its heading to the heading it ends at, in
 * turns clockwise (0 ahead, 0.25 right, 0.5 about, 0.75 left: the approach and hover-enter
 * blends' children).
 */
export function entryDirection(heading: number, to: number): number {
  const turn = (to - heading) / (2 * Math.PI);
  return ((turn % 1) + 1) % 1;
}

/** A compass heading's rotation about z (TweenRotation: a quaternion, counter-clockwise). */
export function headingRotation(heading: number): readonly [number, number, number, number] {
  return [0, 0, Math.sin(-heading / 2), Math.cos(-heading / 2)];
}

// --- Steering --------------------------------------------------------------------------------

/** One step of a flier steering for a point. */
export interface FlightStep {
  readonly position: Vec3;
  readonly heading: number;
  /** Its turn rate this step (degrees per second, left positive: the graph's TurnDelta). */
  readonly turnDelta: number;
  /** Its climb rate (degrees per second, up positive: the graph's PitchDelta). */
  readonly pitchDelta: number;
  /** The way it moved (unit; the graph's MovementDirection). */
  readonly direction: Vec3;
  /** Its pitch (radians, up positive). */
  readonly pitch: number;
}

/**
 * Steers a flier for a goal: it turns towards it at most `turnRate` radians a second, pitches
 * towards it (at most `maxPitch` up or down, turning its pitch at the same rate), and flies on
 * at `speed` along its facing. TODO(M13): the engine's flight controller is not documented.
 */
export function steerFlight(
  body: { readonly position: Vec3; readonly heading: number; readonly pitch: number },
  goal: Vec3,
  speed: number,
  turnRate: number,
  seconds: number,
  maxPitch = Math.PI / 4,
): FlightStep {
  const [x, y, z] = body.position;
  const dx = goal[0] - x;
  const dy = goal[1] - y;
  const dz = goal[2] - z;
  const flat = Math.hypot(dx, dy);
  const step = Math.max(0, turnRate) * seconds;
  const want = flat > 1e-3 ? Math.atan2(dx, dy) : body.heading;
  const turn = Math.atan2(Math.sin(want - body.heading), Math.cos(want - body.heading));
  const turned = Math.abs(turn) <= step ? turn : Math.sign(turn) * step;
  const heading = body.heading + turned;
  const wantPitch = Math.max(-maxPitch, Math.min(maxPitch, Math.atan2(dz, Math.max(flat, 1))));
  const climb = wantPitch - body.pitch;
  const pitched = Math.abs(climb) <= step ? climb : Math.sign(climb) * step;
  const pitch = body.pitch + pitched;
  const direction: Vec3 = [
    Math.sin(heading) * Math.cos(pitch),
    Math.cos(heading) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  // Not past the goal in one step.
  const distance = Math.min(speed * seconds, Math.hypot(dx, dy, dz));
  const perSecond = seconds > 0 ? 180 / Math.PI / seconds : 0;
  return {
    position: [
      x + direction[0] * distance,
      y + direction[1] * distance,
      z + direction[2] * distance,
    ],
    heading,
    // Compass headings grow clockwise; TurnDelta is left positive.
    turnDelta: -turned * perSecond,
    pitchDelta: pitched * perSecond,
    direction,
    pitch,
  };
}

/**
 * Whether one on the ground can reach a target with its blow: the target's feet are no higher
 * than the attacker's head and half its reach above that (src/gameplay/combat/hit-test.ts's
 * heights), nor its head lower than half its reach under its feet. A flier overhead is out of
 * reach: melee fighters wait for it to land and archers and casters shoot it down.
 */
export function withinReach(
  attacker: { readonly feet: Vec3; readonly height: number; readonly reach: number },
  target: { readonly feet: Vec3; readonly height: number },
): boolean {
  if (target.feet[2] > attacker.feet[2] + attacker.height + attacker.reach / 2) return false;
  return target.feet[2] + target.height >= attacker.feet[2] - attacker.reach / 2;
}
