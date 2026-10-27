// How a fighter moves and faces near its target (docs/ai.md, "Combat movement"), observed in the
// original (behaviour only: the combat tree's close movement, its target locations, its
// aim controllers and the movement parameters its combat paths give the movement controller).
//
// - **Facing:** a fighter faces a point its aim controller sets: its target's position, taken
//   again every fCombatAimMeleeUpdateTime (0.25 s; fCombatAimMeleeHighPriorityUpdateTime, 0.1 s,
//   against the player within its reach), not every frame. Its turning is the combat movement
//   parameters' (`combatTurning`): standing it settles within 1° and holds its facing until the
//   point is more than max(its race's aim angle tolerance, fCombatAngleTolerance) off.
// - **Close movement** (`chooseCloseMovement`): the combat tree's selector, run again whenever
//   the behaviour under way ends. Out of range: Advance (to a target location: a place round the
//   target its attackers reserve, `TargetLocations`), else Surround (into a band round the
//   target). Out of position (its reserved place left behind): Reposition (advance to another).
//   In range: Fallback or Circle by the style's chances, Backoff after an attack, else stand.
//   Each behaviour is a straight path to a goal that the navmesh must allow (`straight`), at a
//   combat speed (fCombatSpeedValue*), ending at its goal or by its own abort rule.
//
// Platform-independent.

import { BehaviourTree, type Status } from './behaviour-tree.ts';
import { CLOSE_MOVEMENT_SELECTOR, COMBAT_TREES } from './combat-tree.ts';
import type { TurnParameters } from './locomotion.ts';

type Vec3 = readonly [number, number, number];

const DEGREES = Math.PI / 180;

/** The engine's settings for combat movement (game settings; its built-in defaults). */
export interface CombatMovementSettings {
  /** fCombatAngleTolerance (degrees): the combat facing's tolerance (at least the race's). */
  readonly angleTolerance: number;
  /** fCombatPathingNormalizedRotationSpeed: the combat paths' turn rate, normalized (2: run). */
  readonly normalizedRotationSpeed: number;
  /** fCombatPathingRotationAccelerationMult: × the race's angular acceleration in combat. */
  readonly rotationAccelerationMult: number;
  /** fCombatAimMeleeUpdateTime, …HighPriorityUpdateTime, fCombatAimProjectileUpdateTime (s). */
  readonly aimMeleeUpdateTime: number;
  readonly aimMeleeHighPriorityUpdateTime: number;
  readonly aimProjectileUpdateTime: number;
  /** fCombatCloseRangeTrackTargetDistance: an advancing fighter faces its target within this. */
  readonly closeRangeTrackTargetDistance: number;
  /** fCombatSpeedValueWalk, …FastWalk, …Jog, …Run: the combat paths' normalized speeds. */
  readonly speedWalk: number;
  readonly speedFastWalk: number;
  readonly speedJog: number;
  readonly speedRun: number;
  /** fCombatApproachTargetSprintStopRange, …SlowdownDistance: an advance's sprint and slowing. */
  readonly approachSprintStopRange: number;
  readonly approachSlowdownDistance: number;
  /** fCombatAnticipateTime: where its target will be (seconds ahead), for the aborts. */
  readonly anticipateTime: number;
  /** fCombatBackoffChance, fCombatBackoffMinDistanceMult. */
  readonly backoffChance: number;
  readonly backoffMinDistanceMult: number;
  /** fCombatSurroundDistanceMin / Max: the band beyond its range it keeps round a crowded target. */
  readonly surroundDistanceMin: number;
  readonly surroundDistanceMax: number;
  /** fCombatCircleAngleMin / Max (degrees), …AnglePlayerMult, …ViewConeAngle (degrees). */
  readonly circleAngleMin: number;
  readonly circleAngleMax: number;
  readonly circleAnglePlayerMult: number;
  readonly circleViewConeAngle: number;
  /** fCombatCircleMinMovementDistance, …MinDistanceRadiusMult, …DistanceMax, …MinDistanceMult. */
  readonly circleMinMovementDistance: number;
  readonly circleMinDistanceRadiusMult: number;
  readonly circleDistanceMax: number;
  readonly circleMinDistanceMult: number;
  /** fCombatFallbackDistanceMin / Max, …MinMovementDistance, …MaxAngle (deg), …WaitTimeMin / Max. */
  readonly fallbackDistanceMin: number;
  readonly fallbackDistanceMax: number;
  readonly fallbackMinMovementDistance: number;
  readonly fallbackMaxAngle: number;
  readonly fallbackWaitTimeMin: number;
  readonly fallbackWaitTimeMax: number;
  /** fCombatStrafeDistanceMin / Max: a strafe's way aside. */
  readonly strafeDistanceMin: number;
  readonly strafeDistanceMax: number;
  /** iCombatTargetLocationCount and the fCombatTargetLocation* sizes (widths in degrees). */
  readonly targetLocationCount: number;
  readonly targetLocationRadiusSizeMult: number;
  readonly targetLocationWidthSizeMult: number;
  readonly targetLocationWidthMin: number;
  readonly targetLocationWidthMax: number;
  readonly targetLocationMinDistanceMult: number;
  readonly targetLocationRepositionAngleMult: number;
  readonly targetLocationCurrentReservationDistanceMult: number;
  readonly targetLocationPathingRadius: number;
}

const SETTINGS: readonly (readonly [keyof CombatMovementSettings, string, number])[] = [
  ['angleTolerance', 'fCombatAngleTolerance', 1],
  ['normalizedRotationSpeed', 'fCombatPathingNormalizedRotationSpeed', 2.25],
  ['rotationAccelerationMult', 'fCombatPathingRotationAccelerationMult', 2],
  ['aimMeleeUpdateTime', 'fCombatAimMeleeUpdateTime', 0.25],
  ['aimMeleeHighPriorityUpdateTime', 'fCombatAimMeleeHighPriorityUpdateTime', 0.1],
  ['aimProjectileUpdateTime', 'fCombatAimProjectileUpdateTime', 0.25],
  ['closeRangeTrackTargetDistance', 'fCombatCloseRangeTrackTargetDistance', 768],
  ['speedWalk', 'fCombatSpeedValueWalk', 1],
  ['speedFastWalk', 'fCombatSpeedValueFastWalk', 1.33],
  ['speedJog', 'fCombatSpeedValueJog', 1.66],
  ['speedRun', 'fCombatSpeedValueRun', 2],
  ['approachSprintStopRange', 'fCombatApproachTargetSprintStopRange', 768],
  ['approachSlowdownDistance', 'fCombatApproachTargetSlowdownDistance', 96],
  ['anticipateTime', 'fCombatAnticipateTime', 0.5],
  ['backoffChance', 'fCombatBackoffChance', 0.25],
  ['backoffMinDistanceMult', 'fCombatBackoffMinDistanceMult', 0.75],
  ['surroundDistanceMin', 'fCombatSurroundDistanceMin', 128],
  ['surroundDistanceMax', 'fCombatSurroundDistanceMax', 384],
  ['circleAngleMin', 'fCombatCircleAngleMin', 30],
  ['circleAngleMax', 'fCombatCircleAngleMax', 90],
  ['circleAnglePlayerMult', 'fCombatCircleAnglePlayerMult', 0.75],
  ['circleViewConeAngle', 'fCombatCircleViewConeAngle', 150],
  ['circleMinMovementDistance', 'fCombatCircleMinMovementDistance', 64],
  ['circleMinDistanceRadiusMult', 'fCombatCircleMinDistanceRadiusMult', 3],
  ['circleDistanceMax', 'fCombatCircleDistanceMax', 1024],
  ['circleMinDistanceMult', 'fCombatCircleMinDistanceMult', 0.5],
  ['fallbackDistanceMin', 'fCombatFallbackDistanceMin', 96],
  ['fallbackDistanceMax', 'fCombatFallbackDistanceMax', 256],
  ['fallbackMinMovementDistance', 'fCombatFallbackMinMovementDistance', 64],
  ['fallbackMaxAngle', 'fCombatFallbackMaxAngle', 20],
  ['fallbackWaitTimeMin', 'fCombatFallbackWaitTimeMin', 0.75],
  ['fallbackWaitTimeMax', 'fCombatFallbackWaitTimeMax', 1.5],
  ['strafeDistanceMin', 'fCombatStrafeDistanceMin', 96],
  ['strafeDistanceMax', 'fCombatStrafeDistanceMax', 256],
  ['targetLocationCount', 'iCombatTargetLocationCount', 24],
  ['targetLocationRadiusSizeMult', 'fCombatTargetLocationRadiusSizeMult', 1.25],
  ['targetLocationWidthSizeMult', 'fCombatTargetLocationWidthSizeMult', 2],
  ['targetLocationWidthMin', 'fCombatTargetLocationWidthMin', 10],
  ['targetLocationWidthMax', 'fCombatTargetLocationWidthMax', 180],
  ['targetLocationMinDistanceMult', 'fCombatTargetLocationMinDistanceMult', 0.67],
  ['targetLocationRepositionAngleMult', 'fCombatTargetLocationRepositionAngleMult', 0.67],
  [
    'targetLocationCurrentReservationDistanceMult',
    'fCombatTargetLocationCurrentReservationDistanceMult',
    0.75,
  ],
  ['targetLocationPathingRadius', 'fCombatTargetLocationPathingRadius', 10],
];

/** The load order's settings (GMST) by name, else the engine's built-in defaults. */
export function readCombatMovementSettings(
  number: (editorId: string) => number | undefined = () => undefined,
): CombatMovementSettings {
  return Object.fromEntries(
    SETTINGS.map(([key, name, fallback]) => [key, number(name) ?? fallback]),
  ) as unknown as CombatMovementSettings;
}

export const COMBAT_MOVEMENT_DEFAULTS = readCombatMovementSettings();

/**
 * How a fighter turns (observed in the original: the movement parameters its combat paths and facing
 * give): its facing's tolerance fCombatAngleTolerance (at least its race's aim angle
 * tolerance), its turn rate fCombatPathingNormalizedRotationSpeed on the normalized scale (1
 * its movement type's walking turn rate, 2 its running one, beyond that in running rates: 2.25
 * is 1.25 × its running rate), its angular acceleration × fCombatPathingRotationAccelerationMult.
 */
export function combatTurning(settings: CombatMovementSettings): TurnParameters {
  const normalized = settings.normalizedRotationSpeed;
  return {
    tolerance: settings.angleTolerance * DEGREES,
    raceTolerance: true,
    rateMult: normalized > 2 ? normalized - 1 : 1,
    accelerationMult: settings.rotationAccelerationMult,
  };
}

/**
 * How often its aim point (where it faces) is taken again (seconds): the melee aim controller's
 * update time, its high-priority one against the player within its reach; a shooter's the
 * projectile aim's.
 */
export function aimUpdateTime(
  ranged: boolean,
  targetIsPlayer: boolean,
  withinReach: boolean,
  settings: CombatMovementSettings,
): number {
  if (ranged) return settings.aimProjectileUpdateTime;
  return targetIsPlayer && withinReach
    ? settings.aimMeleeHighPriorityUpdateTime
    : settings.aimMeleeUpdateTime;
}

// --- Geometry --------------------------------------------------------------------------------

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The compass bearing from `from` to `to` (0 along +Y, π/2 along +X). */
export function bearing(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}

/** The angle from `from` to `to`, in −π..π. */
function turn(from: number, to: number): number {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/** A point `distance` from `center` along a compass bearing, at the center's height. */
export function around(center: Vec3, angle: number, distance: number): Vec3 {
  return [
    center[0] + Math.sin(angle) * distance,
    center[1] + Math.cos(angle) * distance,
    center[2],
  ];
}

/** Whether `point` lies within a cone of `angle` (full width, radians) about `heading` from `from`. */
export function withinCone(from: Vec3, heading: number, point: Vec3, angle: number): boolean {
  return Math.abs(turn(heading, bearing(from, point))) <= angle / 2;
}

// --- Target locations --------------------------------------------------------------------------

/** A place round a target an attacker holds: its bearing from the target and its width. */
export interface Reservation {
  readonly target: number;
  readonly angle: number;
  /** Its angular width (radians). */
  readonly width: number;
}

/**
 * The width an attacker takes round its target (radians, at `distance`; observed in the original): its
 * size, the larger of twice its radius × fCombatTargetLocationRadiusSizeMult and a second size
 * of its × fCombatTargetLocationWidthSizeMult, over the distance, within
 * fCombatTargetLocationWidthMin .. Max. TODO(M13): the second size is a cached size of the
 * actor's the code does not name; read here as its radius.
 */
export function locationWidth(
  radius: number,
  distance: number,
  settings: CombatMovementSettings,
): number {
  const size = Math.max(
    radius * 2 * settings.targetLocationRadiusSizeMult,
    radius * settings.targetLocationWidthSizeMult,
  );
  const angle = size / Math.max(1, distance);
  return Math.min(
    settings.targetLocationWidthMax * DEGREES,
    Math.max(settings.targetLocationWidthMin * DEGREES, angle),
  );
}

/**
 * The target locations (observed in the original): round each target its attackers reserve places, each
 * an angular width at their distance; a place another holds is not taken. An attacker that
 * advances looks at iCombatTargetLocationCount bearings round its target, at the distance it
 * fights from, takes the free one nearest to itself whose way from the target the navmesh
 * allows (cut short where it stops, down to fCombatTargetLocationMinDistanceMult of the
 * distance), its own place counting fCombatTargetLocationCurrentReservationDistanceMult nearer.
 */
export class TargetLocations {
  readonly #reservations = new Map<number, Reservation>();

  /** What an attacker holds (undefined: nothing). */
  of(attacker: number): Reservation | undefined {
    return this.#reservations.get(attacker);
  }

  reserve(attacker: number, reservation: Reservation): void {
    this.#reservations.set(attacker, reservation);
  }

  release(attacker: number): void {
    this.#reservations.delete(attacker);
  }

  clear(): void {
    this.#reservations.clear();
  }

  /** Whether a place round `target` is free of the others' (`attacker`'s own does not count). */
  free(attacker: number, target: number, angle: number, width: number): boolean {
    for (const [other, held] of this.#reservations) {
      if (other === attacker || held.target !== target) continue;
      if (Math.abs(turn(held.angle, angle)) < (held.width + width) / 2) return false;
    }
    return true;
  }

  /**
   * The place `attacker` takes round `target` at `distance` (its radius `radius`): the point and
   * its reservation, or undefined when none is free (it surrounds instead). `reach(from, to)`
   * is how far the navmesh lets one go straight from the target towards a place (the whole way
   * when it is clear).
   */
  choose(
    attacker: number,
    from: Vec3,
    target: number,
    at: Vec3,
    distance: number,
    radius: number,
    reach: (from: Vec3, to: Vec3) => number,
    settings: CombatMovementSettings,
  ): { readonly point: Vec3; readonly reservation: Reservation } | undefined {
    const count = Math.max(1, Math.round(settings.targetLocationCount));
    const own = this.#reservations.get(attacker);
    const width = locationWidth(radius, distance, settings);
    // The bearings start from the attacker's own (the nearest place is straight between).
    const start = bearing(at, from);
    let best: { point: Vec3; reservation: Reservation; score: number } | undefined;
    for (let i = 0; i < count; i++) {
      const angle = start + (i * 2 * Math.PI) / count;
      if (!this.free(attacker, target, angle, width)) continue;
      const wanted = around(at, angle, distance);
      let got = reach(at, wanted);
      if (got < distance) {
        // Cut short by the navmesh: far enough still, and wide enough there.
        if (got < distance * settings.targetLocationMinDistanceMult) continue;
        got = Math.max(radius, got - radius);
        if (!this.free(attacker, target, angle, locationWidth(radius, got, settings))) continue;
      }
      const point = around(at, angle, got);
      let score = flat(from, point) ** 2;
      if (own?.target === target && Math.abs(turn(own.angle, angle)) < own.width / 2) {
        score *= settings.targetLocationCurrentReservationDistanceMult ** 2;
      }
      if (!best || score < best.score) {
        best = { point, reservation: { target, angle, width }, score };
      }
    }
    return best && { point: best.point, reservation: best.reservation };
  }

  /**
   * Whether an attacker has left its place: its bearing from its target is off its reservation
   * by more than fCombatTargetLocationRepositionAngleMult × its width (observed in the original: the
   * reposition check), or another holds it now.
   */
  outOfPosition(
    attacker: number,
    target: number,
    from: Vec3,
    at: Vec3,
    settings: CombatMovementSettings,
  ): boolean {
    const own = this.#reservations.get(attacker);
    if (own?.target !== target) return false;
    const off = Math.abs(turn(own.angle, bearing(at, from)));
    return (
      off > settings.targetLocationRepositionAngleMult * own.width ||
      !this.free(attacker, target, own.angle, own.width)
    );
  }
}

// --- The close movement behaviours ---------------------------------------------------------

/** The combat tree's close movement behaviours (and the flanking and ranged ones we run here). */
export type CloseBehaviour =
  | 'advance'
  | 'surround'
  | 'circleDistant'
  | 'reposition'
  | 'circle'
  | 'fallback'
  | 'backoff'
  | 'idle';

/** One behaviour under way: where it goes, how fast, until when. */
export interface MovementRun {
  readonly behaviour: CloseBehaviour | 'flank' | 'stalk' | 'strafe' | 'hold';
  /** Its goal (undefined: it stands). */
  goal: Vec3 | undefined;
  /** Its speed on the normalized scale (its gait: run beyond 2, sprint where allowed). */
  readonly pace: number;
  /** It may sprint on its way (an advance from afar: bCombatPathSprinting). */
  readonly sprint: boolean;
  /** Its clock time it ends at the latest. */
  readonly until: number;
  /** Arrived, it waits until then (a fallback's wait), else it ends. */
  wait: number;
  readonly waitTime: number;
  /** When its abort rule is next checked (every 0.1 s, the engine's behaviours' rate). */
  check: number;
}

/** What the selector weighs (one fighter against its target, now). */
export interface CloseMovementInput {
  readonly distance: number;
  /** Where it fights from: its reach (with the target's radius) and its inner advance radius. */
  readonly range: number;
  /** Its outer advance radius beyond its range (beyond it, an advance runs). */
  readonly outer: number;
  /** Its reservation is left behind (TargetLocations.outOfPosition). */
  readonly outOfPosition: boolean;
  /** The style's chances (combat-tactics fallbackChance, circleChance, circleDistantChance). */
  readonly fallbackChance: number;
  readonly circleChance: number;
  readonly circleDistantChance: number;
}

/**
 * The close movement selector (observed in the original: the combat tree's Close Movement: out of range
 * [Fallback To Ranged, Advance, Surround, Circle Distant, idle], out of position [Reposition,
 * Surround, idle], in range [Fallback / Circle, Backoff, idle]): the behaviours it tries in
 * turn; the first whose goal can be found runs, else it stands for the tree's Close Movement
 * Idle (0.25 s) and the selector runs again. Fallback and Circle by the style's chances (the
 * Fallback / Circle selector's value nodes), Backoff by fCombatBackoffChance and Circle Distant
 * by the style's circle distant chance (random nodes; their own conditions decide the rest).
 * Out of range is beyond its range (TODO(M13): the value that splits out of range, out of
 * position and in range is not read, nor Fallback To Ranged's condition: its behaviour, backing
 * off to fCombatRangedDistance to shoot, is left to the equipment choice).
 */
export function chooseCloseMovement(
  input: CloseMovementInput,
  random: () => number,
  settings: CombatMovementSettings,
): readonly CloseBehaviour[] {
  // The combat tree's selector (combat-tree.ts CLOSE_MOVEMENT_SELECTOR), run with behaviours
  // that only note that they were tried: the order the AI tries them in.
  const tries: CloseBehaviour[] = [];
  const tried = (behaviour: CloseBehaviour) => (): Status => {
    tries.push(behaviour);
    return behaviour === 'idle' ? 'success' : 'failure';
  };
  const tree = new BehaviourTree<undefined>(
    {
      trees: { ...COMBAT_TREES, Selector: CLOSE_MOVEMENT_SELECTOR },
      values: {
        outOfRange: () => input.distance > input.range,
        outOfPosition: () => input.outOfPosition,
        fallbackChance: () => input.fallbackChance,
        circleChance: () => input.circleChance,
        circleDistantChance: () => input.circleDistantChance,
        backoffChance: () => settings.backoffChance,
      },
      actions: {
        advance: tried('advance'),
        surround: tried('surround'),
        circleDistant: tried('circleDistant'),
        reposition: tried('reposition'),
        circle: tried('circle'),
        fallback: tried('fallback'),
        backoff: tried('backoff'),
        closeIdle: tried('idle'),
      },
    },
    'Selector',
  );
  tree.instance(random).tick(undefined, 0);
  return tries;
}

/** Its target as the behaviours read it. */
export interface MovementTarget {
  readonly feet: Vec3;
  readonly heading: number;
  /** Where it will be fCombatAnticipateTime ahead (its velocity). */
  readonly anticipated: Vec3;
  readonly isPlayer: boolean;
}

/** The fighter as the behaviours read it. */
export interface Mover {
  readonly feet: Vec3;
  readonly heading: number;
  readonly radius: number;
}

/**
 * Its target moves away from a point (observed in the original: its velocity points away from it), from
 * where it will be fCombatAnticipateTime ahead.
 */
function movingAway(target: MovementTarget, point: Vec3): boolean {
  const vx = target.anticipated[0] - target.feet[0];
  const vy = target.anticipated[1] - target.feet[1];
  if (vx * vx + vy * vy < 1e-8) return false;
  return (point[0] - target.feet[0]) * vx + (point[1] - target.feet[1]) * vy < 0;
}

/** It faces its target within 60° (the behaviours' first condition, observed in the original). */
const FACING_CONE = 60 * DEGREES;
/** Its target faces it within 120° (a fallback's condition, observed in the original). */
const TARGET_FACING_CONE = 120 * DEGREES;

/**
 * Backoff (observed in the original): facing its target that does not move away from it, closer than
 * fCombatBackoffMinDistanceMult × its range, it backs straight away to its range (at least
 * 64 units of it through the navmesh).
 */
export function backoffGoal(
  self: Mover,
  target: MovementTarget,
  range: number,
  settings: CombatMovementSettings,
): Vec3 | undefined {
  if (movingAway(target, self.feet)) return undefined;
  if (!withinCone(self.feet, self.heading, target.feet, FACING_CONE)) return undefined;
  const distance = flat(self.feet, target.feet);
  if (distance >= settings.backoffMinDistanceMult * range) return undefined;
  const away = bearing(target.feet, self.feet);
  return around(self.feet, away, range - distance);
}

/**
 * Fallback (observed in the original): facing its target that faces it (within 120°) and does not move
 * away from it, it falls back straight away by fCombatFallbackDistanceMin .. Max, then waits
 * fCombatFallbackWaitTimeMin .. Max.
 */
export function fallbackGoal(
  self: Mover,
  target: MovementTarget,
  random: () => number,
  settings: CombatMovementSettings,
): Vec3 | undefined {
  if (!withinCone(target.feet, target.heading, self.feet, TARGET_FACING_CONE)) return undefined;
  if (movingAway(target, self.feet)) return undefined;
  if (!withinCone(self.feet, self.heading, target.feet, FACING_CONE)) return undefined;
  const distance =
    settings.fallbackDistanceMin +
    random() * (settings.fallbackDistanceMax - settings.fallbackDistanceMin);
  if (distance < Math.max(self.radius, settings.fallbackMinMovementDistance)) return undefined;
  return around(self.feet, bearing(target.feet, self.feet), distance);
}

/**
 * The angle a circle goes round its target (degrees; observed in the original): at random from
 * fCombatCircleAngleMin up to the style's circle mult on fCombatCircleAngleMin .. Max, ×
 * fCombatCircleAnglePlayerMult against the player, at least the angle fCombatCircleMinDistance-
 * RadiusMult × its radius takes at its distance.
 */
export function circleAngle(
  circleMult: number,
  targetIsPlayer: boolean,
  radius: number,
  distance: number,
  random: () => number,
  settings: CombatMovementSettings,
): number {
  const most =
    settings.circleAngleMin +
    Math.min(1, Math.max(0, circleMult)) * (settings.circleAngleMax - settings.circleAngleMin);
  let angle = settings.circleAngleMin + random() * (most - settings.circleAngleMin);
  if (targetIsPlayer) angle *= settings.circleAnglePlayerMult;
  const least = (radius * settings.circleMinDistanceRadiusMult) / Math.max(1, distance) / DEGREES;
  return Math.max(angle, least);
}

/**
 * Circle (observed in the original): facing its target, it goes round it by `angle` degrees at its
 * distance (no nearer than `range`), to the side `side` first, else the other: a goal its
 * target sees (within fCombatCircleViewConeAngle) at least fCombatCircleMinMovementDistance
 * away that `clear` allows. The goals in the order to try.
 */
export function circleGoals(
  self: Mover,
  target: MovementTarget,
  range: number,
  angle: number,
  side: number,
  settings: CombatMovementSettings,
): readonly Vec3[] {
  if (angle > settings.circleAngleMax) return [];
  if (!withinCone(self.feet, self.heading, target.feet, FACING_CONE)) return [];
  const distance = Math.max(range, flat(self.feet, target.feet));
  const from = bearing(target.feet, self.feet);
  const goals: Vec3[] = [];
  for (const way of [side, -side]) {
    const goal = around(target.feet, from + way * angle * DEGREES, distance);
    const cone = settings.circleViewConeAngle * DEGREES;
    if (!withinCone(target.feet, target.heading, goal, cone)) continue;
    if (flat(self.feet, goal) < Math.max(self.radius, settings.circleMinMovementDistance)) continue;
    goals.push([goal[0], goal[1], self.feet[2]]);
  }
  return goals;
}

/**
 * Circle Distant (observed in the original): as a circle, round its target at its own distance by the
 * circle's angle, either side, but with no sight cone of the target's and no place reserved:
 * the goals in the order to try.
 */
export function circleDistantGoals(
  self: Mover,
  target: MovementTarget,
  angle: number,
  side: number,
  settings: CombatMovementSettings,
): readonly Vec3[] {
  if (!withinCone(self.feet, self.heading, target.feet, FACING_CONE)) return [];
  const distance = flat(self.feet, target.feet);
  const from = bearing(target.feet, self.feet);
  const goals: Vec3[] = [];
  for (const way of [side, -side]) {
    const goal = around(target.feet, from + way * angle * DEGREES, distance);
    if (flat(self.feet, goal) < Math.max(self.radius, settings.circleMinMovementDistance)) continue;
    goals.push([goal[0], goal[1], self.feet[2]]);
  }
  return goals;
}

/**
 * Surround (observed in the original): it keeps within the band fCombatSurroundDistanceMin .. Max beyond
 * its range round its target: nearer, it retreats to the band's middle; farther, it makes for
 * the middle (a target location there; here the place on its own bearing); within, nothing.
 */
export function surroundGoal(
  self: Mover,
  target: MovementTarget,
  range: number,
  settings: CombatMovementSettings,
): Vec3 | undefined {
  const near = range + settings.surroundDistanceMin;
  const far = range + settings.surroundDistanceMax;
  const distance = flat(self.feet, target.feet);
  if (distance >= near && distance <= far) return undefined;
  const middle = (near + far) / 2;
  const goal = around(target.feet, bearing(target.feet, self.feet), middle);
  return [goal[0], goal[1], self.feet[2]];
}

/** A strafe's goal: aside of the line to its target by fCombatStrafeDistanceMin .. Max. */
export function strafeGoal(
  self: Mover,
  target: MovementTarget,
  side: number,
  random: () => number,
  settings: CombatMovementSettings,
): Vec3 {
  const distance =
    settings.strafeDistanceMin +
    random() * (settings.strafeDistanceMax - settings.strafeDistanceMin);
  return around(self.feet, bearing(self.feet, target.feet) + (side * Math.PI) / 2, distance);
}

/**
 * Whether a behaviour under way gives up now (observed in the original; checked every 0.1 s): a circle
 * once its target will be beyond fCombatCircleDistanceMax past its range or has come within
 * fCombatCircleMinDistanceMult × its range of the goal; a fallback once its target will be
 * beyond fCombatFallbackDistanceMax past its range, or its way turns more than
 * fCombatFallbackMaxAngle off straight away from its target.
 */
export function abortsRun(
  run: MovementRun,
  self: Mover,
  target: MovementTarget,
  range: number,
  settings: CombatMovementSettings,
): boolean {
  const goal = run.goal;
  if (!goal) return false;
  const ahead = flat(self.feet, target.anticipated);
  switch (run.behaviour) {
    case 'circle':
    case 'stalk':
      return (
        ahead > settings.circleDistanceMax + range ||
        flat(target.feet, goal) < settings.circleMinDistanceMult * range
      );
    case 'fallback': {
      if (ahead > range + settings.fallbackDistanceMax) return true;
      if (flat(self.feet, goal) < 1) return false;
      const off = Math.abs(turn(bearing(target.feet, self.feet), bearing(self.feet, goal)));
      return off > settings.fallbackMaxAngle * DEGREES;
    }
    default:
      return false;
  }
}
