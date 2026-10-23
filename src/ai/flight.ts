// Flying (docs/ai.md, "Flying"): who flies (RACE DATA Flies: the dragons' races), the flying
// states the engine keeps (CommonLibSSE FLY_STATE: GetFlyingState, the idle tree's
// ActionFlyStart / ActionFlyStop conditions) as the dragon graph tells them (its notify events
// FlightTakeOff, FlightCruising, FlightHovering, FlightLanding, FlightPerching, FlightAction,
// FlightLand), and the rules of the engine's flight observed in it: when a flier may fly
// (CanFly), the combat tree's Flight subtree (the maneuvers its combat style's flight section
// weighs, their places and times, the ranges it fights at, its combat area), the package
// procedures' arrival in the air, and how it steers (its flying movement type's turn rate, at
// the speed its graph flies). The load order's game settings count where it has them, else the
// engine's built-in defaults. Platform-independent.

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
 * The flying state a graph's event tells (observed in the original: its flight handlers
 * set the state as the dragon graph raises them: ST_TakeOff_*_Air FlightTakeOff, ST_Flight
 * FlightCruising, ST_Hover FlightHovering, ST_Land FlightLanding, ST_Perch FlightPerching,
 * ST_Flight_Kill_Grab FlightAction; FlightLand puts it on the ground, LandEnd ends the landing
 * there). Undefined: not a flying event.
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
    case 'flightland':
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

/**
 * CanFly (observed in the original): its race flies, its graph's Injured is not set (a hurt
 * dragon cannot fly at all), it is allowed to (SetAllowFlying; Dragonrend), and it lives.
 */
export function canFly(flier: {
  readonly racesFly: boolean;
  readonly injured: boolean;
  readonly allowed: boolean;
  readonly health: number;
}): boolean {
  return flier.racesFly && !flier.injured && flier.allowed && flier.health > 0;
}

/**
 * The combat tree's Takeoff (observed in the original): one that can fly takes off from the
 * ground or its perch; one hovering or landing is taken back into its cruise.
 */
export function wantsTakeoff(able: boolean, state: number): boolean {
  if (state === FlyingState.hovering || state === FlyingState.landing) return true;
  return able && (state === FlyingState.none || state === FlyingState.perching);
}

export interface FlightSettings {
  /** fCombatHoverTimeMin and Max: how long a hover lasts (by the style's hover time). */
  readonly hoverTimeMin: number;
  readonly hoverTimeMax: number;
  /** fCombatPerchAttackTimeMin and Max: how long it stays on a perch to fight from there. */
  readonly perchAttackTimeMin: number;
  readonly perchAttackTimeMax: number;
  /** fCombatGroundAttackTimeMin and Max: how long it fights on the ground before it takes off. */
  readonly groundAttackTimeMin: number;
  readonly groundAttackTimeMax: number;
  /** fCombatOrbitDistance: how far from its target it circles (units). */
  readonly orbitDistance: number;
  /** fCombatOrbitTimeMin and Max: an orbit's length (by its offensive mult, seconds). */
  readonly orbitTimeMin: number;
  readonly orbitTimeMax: number;
  /** fFlyingActorDefaultTurningSpeed: its turn rate without a flying movement type (rad/s). */
  readonly turningSpeed: number;
  /** fCombat…ChanceMin and Max: each maneuver's weight at the style's value 0 and 1. */
  readonly hoverChanceMin: number;
  readonly hoverChanceMax: number;
  readonly diveBombChanceMin: number;
  readonly diveBombChanceMax: number;
  readonly groundAttackChanceMin: number;
  readonly groundAttackChanceMax: number;
  readonly perchAttackChanceMin: number;
  readonly perchAttackChanceMax: number;
  readonly flyingAttackChanceMin: number;
  readonly flyingAttackChanceMax: number;
  /** fCombatHoverAngleMin, Max (degrees): how far up from its target a hover point lies. */
  readonly hoverAngleMin: number;
  readonly hoverAngleMax: number;
  /** iCombatHoverLocationCount: the hover points tried round the target. */
  readonly hoverLocationCount: number;
  /** fCombatPerchMaxTargetAngle (degrees): a perch faces its target within this. */
  readonly perchMaxTargetAngle: number;
  /** fCombatLandingZoneDistance: a landing marker counts within this (units). */
  readonly landingZoneDistance: number;
  /** fCombatLandingSearchDistance: the navmesh near it is searched this far to land. */
  readonly landingSearchDistance: number;
  /** fCombatLandingAvoidActorRadius: actors larger than this are landed clear of. */
  readonly landingAvoidActorRadius: number;
  /** fDragonLandingZoneClearRadius: a landing marker with an actor this near (and its size) is taken. */
  readonly landingZoneClearRadius: number;
  /** fCombatFlyingAttackTargetDistanceThreshold: a grab gives up once its victim moved this far. */
  readonly flyingAttackTargetDistance: number;
  /** fCombatDiveBombSlowDownDistance: a dive bomb slows within this of its target. */
  readonly diveBombSlowDownDistance: number;
  /** fCombatDiveBombOffsetPercent: a dive bomb passes this share of its range to the side. */
  readonly diveBombOffsetPercent: number;
  /** fCombatFlightMinimumRange: its maximum range in the air is at least this. */
  readonly flightMinimumRange: number;
  /** fCombatAnticipateTime: where its target will be this long ahead (seconds). */
  readonly anticipateTime: number;
  /** fCombatMaximumRange: no range an item gives is longer. */
  readonly maximumRange: number;
  /** fCombatAreaStandardRadius, ...AttackedRadius, ...AttackedTime: its combat area. */
  readonly areaRadius: number;
  readonly areaAttackedRadius: number;
  readonly areaAttackedTime: number;
  /** fCombatAreaStandardFlyingRadiusMult: its combat area in the air. */
  readonly areaFlyingRadiusMult: number;
  /** fAIPatrolHysteresisWidth: a patrol's point is reached this much beyond its radius. */
  readonly patrolHysteresis: number;
  /** fAIMarkerDestinationRadius: a furniture's approach radius (ten times in the air). */
  readonly markerDestinationRadius: number;
}

/** The load order's settings by name (GMST), else the engine's built-in default (original). */
const SETTINGS: readonly (readonly [keyof FlightSettings, string, number])[] = [
  ['hoverTimeMin', 'fCombatHoverTimeMin', 7.5],
  ['hoverTimeMax', 'fCombatHoverTimeMax', 15],
  ['perchAttackTimeMin', 'fCombatPerchAttackTimeMin', 7.5],
  ['perchAttackTimeMax', 'fCombatPerchAttackTimeMax', 15],
  ['groundAttackTimeMin', 'fCombatGroundAttackTimeMin', 7.5],
  ['groundAttackTimeMax', 'fCombatGroundAttackTimeMax', 15],
  ['orbitDistance', 'fCombatOrbitDistance', 6000],
  ['orbitTimeMin', 'fCombatOrbitTimeMin', 3],
  ['orbitTimeMax', 'fCombatOrbitTimeMax', 12],
  ['turningSpeed', 'fFlyingActorDefaultTurningSpeed', Math.PI / 2],
  ['hoverChanceMin', 'fCombatHoverChanceMin', 0],
  ['hoverChanceMax', 'fCombatHoverChanceMax', 1],
  ['diveBombChanceMin', 'fCombatDiveBombChanceMin', 0],
  ['diveBombChanceMax', 'fCombatDiveBombChanceMax', 1],
  ['groundAttackChanceMin', 'fCombatGroundAttackChanceMin', 0],
  ['groundAttackChanceMax', 'fCombatGroundAttackChanceMax', 1],
  ['perchAttackChanceMin', 'fCombatPerchAttackChanceMin', 0],
  ['perchAttackChanceMax', 'fCombatPerchAttackChanceMax', 1],
  ['flyingAttackChanceMin', 'fCombatFlyingAttackChanceMin', 0],
  ['flyingAttackChanceMax', 'fCombatFlyingAttackChanceMax', 1],
  ['hoverAngleMin', 'fCombatHoverAngleMin', 0],
  ['hoverAngleMax', 'fCombatHoverAngleMax', 20],
  ['hoverLocationCount', 'iCombatHoverLocationCount', 4],
  ['perchMaxTargetAngle', 'fCombatPerchMaxTargetAngle', 75],
  ['landingZoneDistance', 'fCombatLandingZoneDistance', 6000],
  ['landingSearchDistance', 'fCombatLandingSearchDistance', 6000],
  ['landingAvoidActorRadius', 'fCombatLandingAvoidActorRadius', 64],
  ['landingZoneClearRadius', 'fDragonLandingZoneClearRadius', 256],
  ['flyingAttackTargetDistance', 'fCombatFlyingAttackTargetDistanceThreshold', 256],
  ['diveBombSlowDownDistance', 'fCombatDiveBombSlowDownDistance', 4096],
  ['diveBombOffsetPercent', 'fCombatDiveBombOffsetPercent', 0.1],
  ['flightMinimumRange', 'fCombatFlightMinimumRange', 1536],
  ['anticipateTime', 'fCombatAnticipateTime', 0.5],
  ['maximumRange', 'fCombatMaximumRange', 4096],
  ['areaRadius', 'fCombatAreaStandardRadius', 4096],
  ['areaAttackedRadius', 'fCombatAreaStandardAttackedRadius', 8192],
  ['areaAttackedTime', 'fCombatAreaStandardAttackedTime', 1000],
  ['areaFlyingRadiusMult', 'fCombatAreaStandardFlyingRadiusMult', 2],
  ['patrolHysteresis', 'fAIPatrolHysteresisWidth', 50],
  ['markerDestinationRadius', 'fAIMarkerDestinationRadius', 25],
];

export function readFlightSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): FlightSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback]),
  ) as unknown as FlightSettings;
}

export const FLIGHT_DEFAULTS = readFlightSettings();

/**
 * The Orbit procedure's defaults (observed in the original; built into the procedure, no
 * setting): a radius at random between its two radii (3000 and 3500), Height (1000) above its
 * place. A Hover's Height is 0 without one.
 */
export const ORBIT_PROCEDURE = { inner: 3000, outer: 3500, height: 1000 } as const;

/**
 * A patrol's point in the air is reached (observed in the original) within its radius and
 * fAIPatrolHysteresisWidth beyond horizontally, and within this of its height (the location's
 * height window: the larger of fAIMinLocationHeight and 180).
 */
export const LOCATION_HEIGHT = 180;

/**
 * What a flier is asked to do (its combat's maneuver, its package's procedure): fly to a point
 * (fast: at its running speed; slow: at its walking speed), circle a centre, hover at a point
 * facing a heading, land at a spot (facing a heading; onto a target such as a perch or a landing
 * marker; hasty or crashing: GetIsHastyLandRequest, GetIsCrashLandRequest), grab an actor in
 * flight.
 */
export type FlightRequest =
  | { readonly kind: 'cruise'; readonly to: Vec3; readonly fast?: boolean; readonly slow?: boolean }
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
      readonly target?: number;
      readonly perch?: number;
      readonly how?: 'hasty' | 'crash';
    }
  | { readonly kind: 'grab'; readonly victim: number };

// --- The combat tree's Flight subtree ---------------------------------------------------------

/** The attack maneuvers the combat tree's Attack Selector weighs, after each orbit. */
export type FlightManeuver = 'groundAttack' | 'hover' | 'diveBomb' | 'perchAttack' | 'flyingAttack';

export const FLIGHT_MANEUVERS: readonly FlightManeuver[] = [
  'groundAttack',
  'hover',
  'diveBomb',
  'perchAttack',
  'flyingAttack',
];

const lerp = (t: number, from: number, to: number): number => from + (to - from) * t;

/**
 * Each maneuver's weight (observed in the original): its CSFL chance on its fCombat…ChanceMin
 * .. Max. Weights, not chances: the selector draws one of those not tried by them.
 */
export function maneuverWeights(
  flight: CombatStyleFlight,
  settings: FlightSettings,
): Readonly<Record<FlightManeuver, number>> {
  return {
    groundAttack: lerp(
      flight.groundAttackChance,
      settings.groundAttackChanceMin,
      settings.groundAttackChanceMax,
    ),
    hover: lerp(flight.hoverChance, settings.hoverChanceMin, settings.hoverChanceMax),
    diveBomb: lerp(flight.diveBombChance, settings.diveBombChanceMin, settings.diveBombChanceMax),
    perchAttack: lerp(
      flight.perchAttackChance,
      settings.perchAttackChanceMin,
      settings.perchAttackChanceMax,
    ),
    flyingAttack: lerp(
      flight.flyingAttackChance,
      settings.flyingAttackChanceMin,
      settings.flyingAttackChanceMax,
    ),
  };
}

/**
 * The combat tree's Attack Selector (a weighted random fallback, observed in the original):
 * one of the maneuvers not tried yet, drawn by weight; one whose start fails is marked tried and
 * another is drawn. Undefined: none left (it orbits again and draws anew).
 */
export function pickManeuver(
  weights: Readonly<Record<FlightManeuver, number>>,
  tried: ReadonlySet<FlightManeuver>,
  random: () => number,
): FlightManeuver | undefined {
  const open = FLIGHT_MANEUVERS.filter((m) => !tried.has(m) && weights[m] > 0);
  const sum = open.reduce((total, m) => total + weights[m], 0);
  if (sum <= 0) return undefined;
  let roll = random() * sum;
  for (const maneuver of open) {
    roll -= weights[maneuver];
    if (roll < 0) return maneuver;
  }
  return open.at(-1);
}

/**
 * How long a hover, a perch attack or a fight on the ground lasts: at random from its setting's
 * least up to the style's time on that setting's Min .. Max.
 */
export function maneuverSeconds(
  kind: 'hover' | 'perch' | 'ground',
  flight: CombatStyleFlight,
  settings: FlightSettings,
  random: () => number,
): number {
  const [min, max, time] =
    kind === 'hover'
      ? [settings.hoverTimeMin, settings.hoverTimeMax, flight.hoverTime]
      : kind === 'perch'
        ? [settings.perchAttackTimeMin, settings.perchAttackTimeMax, flight.perchAttackTime]
        : [settings.groundAttackTimeMin, settings.groundAttackTimeMax, flight.groundAttackTime];
  return lerp(random(), min, lerp(time, min, max));
}

/**
 * How long an orbit lasts before the next maneuver: at random from fCombatOrbitTimeMin up to its
 * offensive mult (as the engine weighs it: combat-tactics offensiveMult) on
 * fCombatOrbitTimeMax .. Min.
 */
export function orbitSeconds(
  offensive: number,
  settings: FlightSettings,
  random: () => number,
): number {
  return lerp(
    random(),
    settings.orbitTimeMin,
    lerp(offensive, settings.orbitTimeMax, settings.orbitTimeMin),
  );
}

/**
 * A shout's (or spell's) ranges as the combat inventory gives them (observed in the
 * original): its farthest 0.9 of its projectile's range (at most fCombatMaximumRange), its nearest at
 * least 256 once the farthest is over 1024 (and at least its explosion's radius, never within 256
 * of the farthest), its optimal three quarters of the way between.
 */
export function shoutRanges(
  projectileRange: number,
  explosionRadius: number,
  settings: FlightSettings,
): { readonly min: number; readonly max: number; readonly optimal: number } {
  const max = Math.min(0.9 * projectileRange, settings.maximumRange);
  let min = max > 1024 ? Math.max(256, explosionRadius) : explosionRadius;
  min = Math.max(0, Math.min(min, max - 256));
  return { min, max, optimal: min + 0.75 * (max - min) };
}

/**
 * The two ranges a flier fights at (observed in the original): its optimal range (where it
 * hovers, lands, ends a dive bomb) the nearer of its style's farthest optimal range
 * (combat-tactics maxOptimalRange) and its item's optimal range, each beyond both actors' size;
 * its reach (a perch counts within it of the target) its item's farthest beyond their size.
 */
export function flightRanges(input: {
  /** The flier's radius and its target's together. */
  readonly extents: number;
  /** Its weapon's (its breath's) optimal and farthest range. */
  readonly optimal: number;
  readonly max: number;
  /** Its style's farthest optimal range (maxOptimalRange). */
  readonly styleOptimal: number;
}): { readonly optimal: number; readonly reach: number } {
  const e = input.extents;
  return {
    optimal: Math.min(e + input.styleOptimal, Math.max(e, e + input.optimal)),
    reach: e + input.max,
  };
}

/**
 * Its combat area's radius (observed in the original): fCombatAreaStandardRadius, the
 * larger fCombatAreaStandardAttackedRadius for fCombatAreaStandardAttackedTime after it was
 * attacked, times fCombatAreaStandardFlyingRadiusMult in the air.
 */
export function combatAreaRadius(
  attackedAgo: number | undefined,
  inAir: boolean,
  settings: FlightSettings,
): number {
  const base =
    attackedAgo !== undefined && attackedAgo <= settings.areaAttackedTime
      ? settings.areaAttackedRadius
      : settings.areaRadius;
  return inAir ? base * settings.areaFlyingRadiusMult : base;
}

/**
 * Where a target will be (fCombatAnticipateTime ahead at its velocity): where a hover and a dive
 * bomb aim.
 */
export function anticipated(at: Vec3, velocity: Vec3 | undefined, seconds: number): Vec3 {
  if (!velocity) return at;
  return [
    at[0] + velocity[0] * seconds,
    at[1] + velocity[1] * seconds,
    at[2] + velocity[2] * seconds,
  ];
}

/**
 * The combat Hover's points (observed in the original): iCombatHoverLocationCount of them
 * round its (anticipated) target at its optimal range, the first on the flier's own side and
 * each next a turn further, each raised by an angle at random between fCombatHoverAngleMin and
 * Max; each faces the target.
 */
export function hoverPoints(
  target: Vec3,
  from: Vec3,
  range: number,
  settings: FlightSettings,
  random: () => number,
): { readonly at: Vec3; readonly heading: number }[] {
  const count = Math.max(1, Math.round(settings.hoverLocationCount));
  const base = Math.atan2(from[0] - target[0], from[1] - target[1]);
  const points: { at: Vec3; heading: number }[] = [];
  for (let i = 0; i < count; i++) {
    const direction = base + (i * 2 * Math.PI) / count;
    const angle = lerp(random(), settings.hoverAngleMin, settings.hoverAngleMax) * DEGREES;
    const at: Vec3 = [
      target[0] + Math.sin(direction) * range,
      target[1] + Math.cos(direction) * range,
      target[2] + Math.tan(angle) * range,
    ];
    points.push({ at, heading: Math.atan2(target[0] - at[0], target[1] - at[1]) });
  }
  return points;
}

/**
 * The combat Dive Bomb's goal (observed in the original): its target where it will be, to
 * one side by up to fCombatDiveBombOffsetPercent of its optimal range (at random), reached within
 * its optimal range less that offset.
 */
export function diveBombGoal(
  target: Vec3,
  from: Vec3,
  range: number,
  settings: FlightSettings,
  random: () => number,
): { readonly goal: Vec3; readonly arrive: number } {
  const most = settings.diveBombOffsetPercent * range;
  const side = (random() * 2 - 1) * most;
  const dx = from[0] - target[0];
  const dy = from[1] - target[1];
  const length = Math.hypot(dx, dy) || 1;
  // Across the way in: the horizontal perpendicular.
  return {
    goal: [target[0] - (dy / length) * side, target[1] + (dx / length) * side, target[2]],
    arrive: Math.max(0, range - most),
  };
}

/**
 * Whether a perch faces its target (observed in the original): the target lies within
 * fCombatPerchMaxTargetAngle of the perch's own heading.
 */
export function perchFaces(
  perch: { readonly position: Vec3; readonly heading: number },
  target: Vec3,
  settings: FlightSettings,
): boolean {
  const toward = Math.atan2(target[0] - perch.position[0], target[1] - perch.position[1]);
  const off = Math.atan2(Math.sin(toward - perch.heading), Math.cos(toward - perch.heading));
  return Math.abs(off) <= settings.perchMaxTargetAngle * DEGREES;
}

/** A patrol's point in the air reached: within its radius and hysteresis across, its height window up and down. */
export function pointReached(
  here: Vec3,
  point: Vec3,
  radius: number,
  settings: FlightSettings,
): boolean {
  return (
    Math.hypot(here[0] - point[0], here[1] - point[1]) <= radius + settings.patrolHysteresis &&
    Math.abs(here[2] - point[2]) <= LOCATION_HEIGHT
  );
}

const DEGREES = Math.PI / 180;

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
 * Which way round a circle a flier goes (observed in the original: an orbit goes on the way
 * it already turns): clockwise seen from above when the centre lies to its right.
 */
export function orbitClockwise(from: Vec3, heading: number, center: Vec3): boolean {
  const toward = Math.atan2(center[0] - from[0], center[1] - from[1]);
  return Math.sin(toward - heading) > 0;
}

/**
 * Where a landing begins: the approach clip (MTLand45Approach) carries it 2048 units ahead and
 * 2048 down to its spot (the dragon project's animation data), so it comes to that point,
 * facing the spot's heading, before ActionFlyStop; the graph's tweener takes it the rest of the
 * way (observed in the original: the land path's goal is the spot less the chosen clip's
 * root motion, turned to the landing heading).
 */
export const LANDING_APPROACH = { ahead: 2048, above: 2048 } as const;

export function landingApproach(spot: Vec3, heading: number): Vec3 {
  return [
    spot[0] - Math.sin(heading) * LANDING_APPROACH.ahead,
    spot[1] - Math.cos(heading) * LANDING_APPROACH.ahead,
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
 * Steers a flier for a goal (observed in the original: its path's curve turns at most its
 * turn rate, split between heading and pitch; the follower flies along it at its speed): it
 * turns towards the goal at most `turnRate` radians a second, pitches towards it (at most
 * `maxPitch` up or down, at the same rate), and flies on at `speed` along its facing.
 */
export function steerFlight(
  body: { readonly position: Vec3; readonly heading: number; readonly pitch: number },
  goal: Vec3,
  speed: number,
  turnRate: number,
  seconds: number,
  maxPitch = Math.PI / 2,
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
