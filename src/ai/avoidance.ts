// Actors on their way go round those in it (docs/ai.md, "Paths"): another actor or the player
// that the way would bring within reach (their two radii) in the next moment is passed on the
// side away from it, two that meet head-on both keeping right; the way turns just as far as
// passing needs. Which it looks at is the engine's (observed in the original: the nearest
// iMaxActorsToAvoid within its avoidance radius, and of those only the ones that rank above it:
// avoidanceKey). The advanced avoidance is the engine's velocity obstacles (observed in the
// original: a race's RACE DATA Flags 2 bit with bUseVelocityObstacles): only an actor with it
// steers, each one ranked above it an obstacle of the two radii moving at the other's velocity;
// it lays avoid nodes only on those standing; one without it has no such steering and lays nodes
// on those moving too (layAvoidNode). How the velocity is chosen among the obstacles is ours
// (TODO(M13): the original's choice, which also weighs the navmesh's open edges, was not read).
// Platform-independent.

type Vec2 = readonly [number, number];

/**
 * An actor's rank in the engine's avoidance (observed in the original): an actor avoids only
 * those whose key is greater than its own, first number first. One on its way (following a path,
 * faster than 5 units a second) has its radius in whole units, then its form id: of two on their
 * way the narrower avoids the wider, of two as wide the lower form id the higher, and the other
 * keeps its way. One that is not on its way (standing, the player) has the greatest key: it
 * avoids no one and all avoid it. One dead, dying or down (an essential actor's bleedout) has the
 * least: no one avoids it.
 */
export type AvoidanceKey = readonly [number, number];

/** The key of one not on its way (the engine's built-in default: both numbers all ones). */
export const IDLE_AVOIDANCE_KEY: AvoidanceKey = [0xffffffff, 0xffffffff];
/** The key of one dead, dying or down. */
export const DOWN_AVOIDANCE_KEY: AvoidanceKey = [0, 0];

/**
 * Faster than this along its path (units a second), an actor is on its way for its key (observed
 * in the original). TODO(M13): which speed the original measures (ours, actor-movers.ts: the one
 * it asks along its path) was not identified.
 */
const ON_ITS_WAY_SPEED = 5;

/** An actor's avoidance key (AvoidanceKey). */
export function avoidanceKey(actor: {
  readonly down: boolean;
  /** It follows a path (a travel), and its speed (units a second). */
  readonly travelling: boolean;
  readonly speed: number;
  readonly radius: number;
  readonly formId: number;
}): AvoidanceKey {
  if (actor.down) return DOWN_AVOIDANCE_KEY;
  if (!actor.travelling || !(actor.speed > ON_ITS_WAY_SPEED)) return IDLE_AVOIDANCE_KEY;
  return [Math.trunc(actor.radius) >>> 0, actor.formId >>> 0];
}

/** Whether an actor with key `self` avoids one with key `other` (the other ranks above it). */
export function ranksAbove(other: AvoidanceKey, self: AvoidanceKey): boolean {
  return other[0] !== self[0] ? other[0] > self[0] : other[1] > self[1];
}

/** One in the way: where it is, how it moves (game units per second), how wide it is. */
export interface Neighbour {
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly radius: number;
  /** Its avoidance key (undefined: it ranks above every actor). */
  readonly key?: AvoidanceKey;
}

/** Whether an avoider with `key` looks at a neighbour at all (it ranks above it). */
function avoided(key: AvoidanceKey | undefined, other: Neighbour): boolean {
  return key === undefined || other.key === undefined || ranksAbove(other.key, key);
}

/** The one going: where it is, how wide, its speed and the way it wants (any length). */
export interface Avoider {
  readonly position: Vec2;
  readonly radius: number;
  readonly speed: number;
  readonly direction: Vec2;
  /**
   * Its race uses the advanced avoidance (undefined: it does): others' movement foreseen (their
   * velocity obstacles), the head-on rule kept.
   */
  readonly advanced?: boolean;
  /** Its avoidance key (undefined: it looks at every neighbour). */
  readonly key?: AvoidanceKey;
}

/** Those it would come within reach of in this long are gone round (seconds; ours). */
const LOOKAHEAD_SECONDS = 1.5;
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
    // Only those ranked above it (observed in the original: the others keep out of its way).
    if (!avoided(self.key, other)) continue;
    // Without the advanced avoidance one moving is taken where it stands now.
    const otherVelocity: Vec2 = foresees ? other.velocity : [0, 0];
    const rx = other.position[0] - self.position[0];
    const ry = other.position[1] - self.position[1];
    const distance = Math.hypot(rx, ry);
    // The velocity obstacle's radius: the two radii (observed in the original).
    const reach = self.radius + other.radius;
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
 * comes to stand (5 units a second or less); one with a node that sets off has it taken away and
 * the actor's path searched again without it (`clear`; it steers round it now). Without it, also
 * whenever the neighbour starts or stops and at least every fMaxTimeSizeAvoidNode: those moving
 * get nodes too, where they are then.
 */
export function layAvoidNode(
  before: AvoidedNeighbour | undefined,
  other: Neighbour,
  width: number,
  way: readonly (readonly number[])[],
  rule: { readonly advanced: boolean; readonly step: number; readonly refresh: number },
): { readonly lay: boolean; readonly clear: boolean; readonly state: AvoidedNeighbour } {
  const moving = Math.hypot(other.velocity[0], other.velocity[1]) > STANDING_SPEED;
  const wasMoving = before?.moving ?? true;
  const age = (before?.age ?? 0) + rule.step;
  const look = rule.advanced
    ? wasMoving && !moving
    : wasMoving !== moving || age > rule.refresh || before === undefined;
  if (!look) {
    const setOff = rule.advanced && moving && !wasMoving && (before?.noded ?? false);
    const noded = (before?.noded ?? false) && !(rule.advanced && moving);
    return { lay: false, clear: setOff, state: { moving, age, noded } };
  }
  const across = distanceToWay(other.position, way) < width / 2 + other.radius;
  return {
    lay: across && !(before?.noded ?? false),
    clear: false,
    state: { moving, age: 0, noded: across },
  };
}

/**
 * What an actor on its way does about those that hold it up (docs/ai.md, "Paths"; observed in the
 * original): nothing while it has been held up no longer than fMaxTimeBlockedByActors; then, with
 * the advanced avoidance and one ranked above it near (avoidanceKey: the others keep out of its
 * way), its way is blocked by actors and its path manager gives the path up: short of its goal,
 * its path fails (`fail`), a path failure as any other (the travel ends, its package asks for a
 * new one, and the failures in a row warp it). Without the advanced avoidance it never reports
 * that: its avoid nodes take it round (`wait`). No one gives way to it: the one ranked above keeps
 * its way, the bodies push. The player standing in its way is asked to move first (`ask`: its
 * ActorCollidewithActor line, the infos' IsSmallBump 0 ones: "Excuse me.", "Mind the way."), once
 * a travel, and given one more fMaxTimeBlockedByActors to step aside. Inferred, TODO(M13): the
 * line and that wait for the player (the engine's Avoid Player package is the player's swings'
 * and shots'). Not short of its goal, its path is not failed: its way is done (`done`; inferred,
 * TODO(M13): what the original then does, and how near counts, were not identified).
 */
export function blockedByActor(input: {
  /**
   * Seconds it has been held up: hardly moving with one ranked above it in its way. TODO(M13):
   * this measure is ours (the movers': under 16 units a second with avoidance's blocker set);
   * the original takes it from its movement controller, which was not read.
   */
  readonly blockedFor: number;
  /** fMaxTimeBlockedByActors. */
  readonly most: number;
  /** The one in its way is the player, standing (not moving). */
  readonly playerStanding: boolean;
  /** It asked the player already on this travel. */
  readonly askedPlayer: boolean;
  /** Its race uses the advanced avoidance (RACE DATA Flags 2). */
  readonly advanced: boolean;
  /** It is still short of its goal (undefined: it is). */
  readonly shortOfGoal?: boolean;
}): 'wait' | 'ask' | 'fail' | 'done' {
  if (input.blockedFor <= input.most) return 'wait';
  if (input.playerStanding && !input.askedPlayer) return 'ask';
  if (!input.advanced) return 'wait';
  return input.shortOfGoal === false ? 'done' : 'fail';
}

/**
 * The node an actor's static avoider lays where it is held by what the navmesh does not know
 * (observed in the original): one radius of the actor ahead of it, towards where it meant to be,
 * the actor's radius wide, at fDefaultAvoidNodeCost. As a search's circle (pathfinding.ts
 * AvoidNode) the actor's own radius is added: the circle its middle keeps out of.
 */
export function staticAvoidNode(
  feet: readonly [number, number, number],
  target: readonly [number, number, number],
  radius: number,
  cost: number,
):
  | { readonly at: [number, number, number]; readonly radius: number; readonly cost: number }
  | undefined {
  const dx = target[0] - feet[0];
  const dy = target[1] - feet[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-3) return undefined;
  return {
    at: [feet[0] + (dx / length) * radius, feet[1] + (dy / length) * radius, feet[2]],
    radius: radius + radius,
    cost,
  };
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
