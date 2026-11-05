// Actors on their way go round those in it (docs/ai.md, "Paths"): another actor or the player
// that the way would bring within reach (their radii and a margin) in the next moment is passed
// on the side away from it, two that meet head-on both keeping right; the way turns just as far
// as passing needs. Which it looks at is the engine's (observed in the original: the nearest
// iMaxActorsToAvoid within its avoidance radius). The advanced avoidance is the engine's velocity
// obstacles (observed in the original: a race's RACE DATA Flags 2 bit with
// bUseVelocityObstacles): an actor with it steers round those moving and lays avoid nodes only on
// those standing; one without it has no such steering and lays nodes on those moving too
// (layAvoidNode). The turn itself is ours (TODO(M13): the velocity obstacles' cones, built with
// the navmesh's open edges, are not reproduced). Platform-independent.

type Vec2 = readonly [number, number];

/** One in the way: where it is, how it moves (game units per second), how wide it is. */
export interface Neighbour {
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly radius: number;
}

/** The one going: where it is, how wide, its speed and the way it wants (any length). */
export interface Avoider {
  readonly position: Vec2;
  readonly radius: number;
  readonly speed: number;
  readonly direction: Vec2;
  /**
   * Its race uses the advanced avoidance (undefined: it does): others' movement foreseen, the
   * head-on rule kept. TODO(M13): the plain reading of the flag's name.
   */
  readonly advanced?: boolean;
}

/** Those it would come within reach of in this long are gone round (seconds). */
const LOOKAHEAD_SECONDS = 1.5;
/** Room kept beyond the two radii (game units). */
const MARGIN = 8;
/** The way turns at most this much (radians). */
const MAX_TURN = 1.2;
/** One coming towards it faster than this share of its speed meets it head-on. */
const HEAD_ON = 0.25;

/**
 * The way an actor goes with those around it: `direction` turned to pass the first it would
 * meet, its length kept. Unchanged where nothing is in the way.
 */
export function avoid(self: Avoider, neighbours: Iterable<Neighbour>): Vec2 {
  return avoidance(self, neighbours).direction;
}

/** As avoid, with the one it goes round (undefined: none in its way). */
export function avoidance<N extends Neighbour>(
  self: Avoider,
  neighbours: Iterable<N>,
): { readonly direction: Vec2; readonly blocker: N | undefined } {
  const [dx, dy] = self.direction;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { direction: self.direction, blocker: undefined };
  const ux = dx / length;
  const uy = dy / length;
  const vx = ux * self.speed;
  const vy = uy * self.speed;
  let threat:
    | {
        time: number;
        rx: number;
        ry: number;
        distance: number;
        reach: number;
        headOn: boolean;
        other: N;
      }
    | undefined;
  const foresees = self.advanced !== false;
  for (const other of neighbours) {
    // Without the advanced avoidance one moving is taken where it stands now.
    const otherVelocity: Vec2 = foresees ? other.velocity : [0, 0];
    const rx = other.position[0] - self.position[0];
    const ry = other.position[1] - self.position[1];
    const distance = Math.hypot(rx, ry);
    const reach = self.radius + other.radius + MARGIN;
    const otherSpeed = Math.hypot(otherVelocity[0], otherVelocity[1]);
    if (distance > reach + (self.speed + otherSpeed) * LOOKAHEAD_SECONDS) continue;
    // Only what lies ahead (what is beside or behind it does not block its way).
    if (rx * ux + ry * uy <= 0) continue;
    // Closest approach over the next moment, by their speeds.
    const wx = vx - otherVelocity[0];
    const wy = vy - otherVelocity[1];
    const w2 = wx * wx + wy * wy;
    const time = w2 > 1e-6 ? Math.min(LOOKAHEAD_SECONDS, Math.max(0, (rx * wx + ry * wy) / w2)) : 0;
    const closest = Math.hypot(rx - wx * time, ry - wy * time);
    if (closest >= reach) continue;
    if (threat && time >= threat.time) continue;
    const headOn = otherVelocity[0] * ux + otherVelocity[1] * uy < -self.speed * HEAD_ON;
    threat = { time, rx, ry, distance, reach, headOn, other };
  }
  if (!threat) return { direction: self.direction, blocker: undefined };
  // Its bearing from the way (counter-clockwise, to the left, positive) and the turn that
  // grazes its reach.
  const bearing = Math.atan2(ux * threat.ry - uy * threat.rx, ux * threat.rx + uy * threat.ry);
  const graze =
    threat.distance > threat.reach ? Math.asin(threat.reach / threat.distance) : MAX_TURN;
  // Head-on both keep right; else it passes on the side away from the other (right of one
  // straight ahead).
  const right = threat.headOn || bearing >= 0;
  const turn = right ? Math.min(0, bearing - graze) : Math.max(0, bearing + graze);
  const clamped = Math.max(-MAX_TURN, Math.min(MAX_TURN, turn));
  const cos = Math.cos(clamped);
  const sin = Math.sin(clamped);
  return {
    direction: [(ux * cos - uy * sin) * length, (ux * sin + uy * cos) * length],
    blocker: threat.other,
  };
}

/** One moving no faster than this (units a second) stands, for its avoid node. */
const STANDING_SPEED = 5;

/** A neighbour as an actor's avoidance last saw it. */
export interface AvoidedNeighbour {
  readonly moving: boolean;
  /** Seconds since its node was last looked at. */
  readonly age: number;
  /** It has a node across the way. */
  readonly noded: boolean;
}

/** The shortest distance from a place to a way, seen from above. */
function distanceToWay(at: Vec2, way: readonly (readonly number[])[]): number {
  let nearest = Infinity;
  for (let i = 1; i < way.length; i++) {
    const [ax = 0, ay = 0] = way[i - 1] ?? [];
    const [bx = 0, by = 0] = way[i] ?? [];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.min(
      1,
      Math.max(0, ((at[0] - ax) * dx + (at[1] - ay) * dy) / (dx * dx + dy * dy || 1)),
    );
    nearest = Math.min(nearest, Math.hypot(at[0] - ax - dx * t, at[1] - ay - dy * t));
  }
  return nearest;
}

/**
 * Whether an actor on its way lays an avoid node on a neighbour now and searches round it
 * (observed in the original). A node goes on one whose middle lies within half the actor's width
 * and its own radius of the way. With the advanced avoidance it is looked at only as the neighbour
 * comes to stand (5 units a second or less; one that sets off keeps none: the actor steers round
 * it). Without it, also whenever the neighbour starts or stops and at least every
 * fMaxTimeSizeAvoidNode: those moving get nodes too, where they are then.
 */
export function layAvoidNode(
  before: AvoidedNeighbour | undefined,
  other: Neighbour,
  width: number,
  way: readonly (readonly number[])[],
  rule: { readonly advanced: boolean; readonly step: number; readonly refresh: number },
): { readonly lay: boolean; readonly state: AvoidedNeighbour } {
  const moving = Math.hypot(other.velocity[0], other.velocity[1]) > STANDING_SPEED;
  const wasMoving = before?.moving ?? true;
  const age = (before?.age ?? 0) + rule.step;
  const look = rule.advanced
    ? wasMoving && !moving
    : wasMoving !== moving || age > rule.refresh || before === undefined;
  if (!look) {
    const noded = (before?.noded ?? false) && !(rule.advanced && moving);
    return { lay: false, state: { moving, age, noded } };
  }
  const across = distanceToWay(other.position, way) < width / 2 + other.radius;
  return {
    lay: across && !(before?.noded ?? false),
    state: { moving, age: 0, noded: across },
  };
}

/** Two actors on their way that keep each other from going on: who gives way. */
export interface WayGiver {
  readonly reference: number;
  /** Its gait's rank: walk 0, run 1, sprint 2. */
  readonly gait: number;
  /** Others push it aside (RACE DATA Not Pushable clear; undefined: they do). */
  readonly pushable?: boolean;
}

/**
 * Of two actors on their way into each other (a narrow way, neither able to go round), the one
 * that gives way: the slower gait, else the lower reference (always the same one of a pair,
 * whichever of the two asks). Ours, not the original's (inferred): the original's avoider has no
 * rule for who yields (observed in it): each with the advanced avoidance lays no node for the
 * other moving and after fMaxTimeBlockedByActors reports its way blocked by actors. What its path
 * manager does with that report was not read (TODO(M13)); this one only ensures one of the two
 * goes on.
 */
export function givesWay<A extends WayGiver>(a: A, b: A): A {
  // One its race keeps from being pushed (the dragons) gives way to no one.
  if ((a.pushable === false) !== (b.pushable === false)) return a.pushable === false ? b : a;
  if (a.gait !== b.gait) return a.gait < b.gait ? a : b;
  return a.reference < b.reference ? a : b;
}

/** The INI's avoidance settings ([Pathfinding]). */
export interface AvoidanceSettings {
  /** iMaxActorsToAvoid: at most this many are gone round (the engine: at most 32). */
  readonly maxActors: number;
  /**
   * fAvoidanceTimeDelta, fMinAvoidanceRadius, fMaxAvoidanceRadius: those within its speed
   * times the delta (kept between the radii), and half its width, are looked at.
   */
  readonly timeDelta: number;
  readonly minRadius: number;
  readonly maxRadius: number;
}

/** The engine's most actors avoided at once, whatever iMaxActorsToAvoid says. */
const MAX_AVOIDED = 32;

/**
 * Those an actor looks at to go round (observed in the original): the nearest
 * iMaxActorsToAvoid within its avoidance radius (its speed × fAvoidanceTimeDelta, between
 * fMinAvoidanceRadius and fMaxAvoidanceRadius, and half its width).
 */
export function avoidanceNeighbours<N extends Neighbour>(
  self: Avoider,
  neighbours: Iterable<N>,
  settings: AvoidanceSettings,
): N[] {
  const radius =
    Math.min(settings.maxRadius, Math.max(settings.minRadius, settings.timeDelta * self.speed)) +
    self.radius;
  const near: { readonly other: N; readonly distance: number }[] = [];
  for (const other of neighbours) {
    const distance = Math.hypot(
      other.position[0] - self.position[0],
      other.position[1] - self.position[1],
    );
    if (distance <= radius) near.push({ other, distance });
  }
  near.sort((a, b) => a.distance - b.distance);
  return near
    .slice(0, Math.max(0, Math.min(MAX_AVOIDED, settings.maxActors)))
    .map(({ other }) => other);
}
