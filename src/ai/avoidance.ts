// Actors on their way go round those in it (docs/ai.md, "Paths"): another actor or the player
// that the way would bring within reach (their radii and a margin) in the next moment is passed
// on the side away from it, two that meet head-on both keeping right; the way turns just as far
// as passing needs. Which it looks at is the engine's (observed in the original: the nearest
// iMaxActorsToAvoid within its avoidance radius); how the engine's own avoidance turns the way is
// not read yet (TODO(M13)). Platform-independent.

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
  for (const other of neighbours) {
    const rx = other.position[0] - self.position[0];
    const ry = other.position[1] - self.position[1];
    const distance = Math.hypot(rx, ry);
    const reach = self.radius + other.radius + MARGIN;
    const otherSpeed = Math.hypot(other.velocity[0], other.velocity[1]);
    if (distance > reach + (self.speed + otherSpeed) * LOOKAHEAD_SECONDS) continue;
    // Only what lies ahead (what is beside or behind it does not block its way).
    if (rx * ux + ry * uy <= 0) continue;
    // Closest approach over the next moment, by their speeds.
    const wx = vx - other.velocity[0];
    const wy = vy - other.velocity[1];
    const w2 = wx * wx + wy * wy;
    const time = w2 > 1e-6 ? Math.min(LOOKAHEAD_SECONDS, Math.max(0, (rx * wx + ry * wy) / w2)) : 0;
    const closest = Math.hypot(rx - wx * time, ry - wy * time);
    if (closest >= reach) continue;
    if (threat && time >= threat.time) continue;
    const headOn = other.velocity[0] * ux + other.velocity[1] * uy < -self.speed * HEAD_ON;
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
