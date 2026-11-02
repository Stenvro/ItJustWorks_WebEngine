// Arrows and bolts in flight (docs/ai.md, "Combat"): loosed at the PROJ's speed along the aim,
// tilted up by [Combat] f1PArrowTiltUpAngle (2°, first person) or f3PArrowTiltUpAngle (2.5°),
// falling under the world's gravity (9.8 m/s², docs/physics.md) times the PROJ's gravity, until
// they hit something or have flown their range. One that hits the world sticks in it
// fCombatMissileStickDepth deep and can be picked up; of those that hit an actor
// iArrowInventoryChance % go into its inventory. UESP "Archery": at most 15 missed arrows lie
// about (the 16th takes the first away). TODO(M13): how much slower a partly drawn arrow flies is
// not documented; here its speed times its draw. Platform-independent.

/** Havok's gravity in game units per second² (9.8 m/s², 69.99125 units a metre). */
export const WORLD_GRAVITY = 9.8 * 69.99125;

/** Arrows that missed and lie about at most (UESP "Archery"). */
export const MAX_STUCK_ARROWS = 15;

/** [Combat] f1PArrowTiltUpAngle, f3PArrowTiltUpAngle (STEP's dump of SSE's INI defaults). */
export const ARROW_TILT = { firstPerson: 2, thirdPerson: 2.5 } as const;

type Vec3 = readonly [number, number, number];

/** An arrow in the air. */
export interface Flight {
  position: [number, number, number];
  velocity: [number, number, number];
  /** Seconds and game units flown. */
  age: number;
  distance: number;
}

/** A unit aim tilted up by `degrees` (about the horizontal axis across it). */
export function tiltUp(aim: Vec3, degrees: number): [number, number, number] {
  const horizontal = Math.hypot(aim[0], aim[1]);
  const pitch = Math.atan2(aim[2], horizontal) + (degrees * Math.PI) / 180;
  const heading = horizontal > 1e-9 ? Math.atan2(aim[0], aim[1]) : 0;
  const c = Math.cos(pitch);
  return [Math.sin(heading) * c, Math.cos(heading) * c, Math.sin(pitch)];
}

/** An arrow loosed from `from` along a unit aim at a speed (times its draw). */
export function launch(from: Vec3, aim: Vec3, speed: number, power = 1): Flight {
  const length = Math.hypot(aim[0], aim[1], aim[2]) || 1;
  const v = speed * Math.min(1, Math.max(0, power));
  return {
    position: [from[0], from[1], from[2]],
    velocity: [(aim[0] / length) * v, (aim[1] / length) * v, (aim[2] / length) * v],
    age: 0,
    distance: 0,
  };
}

/**
 * A shot that always hits (a UseWeapon package's Always Hit: MQ101's archers on Lokir, who
 * runs): its velocity turned onto the target point at its speed, each step, gravity left out.
 * TODO(M13): how the engine makes such a shot hit is not documented; it flies at the target.
 */
export function homeOn(flight: Flight, target: Vec3): void {
  const speed = Math.hypot(flight.velocity[0], flight.velocity[1], flight.velocity[2]);
  const dx = target[0] - flight.position[0];
  const dy = target[1] - flight.position[1];
  const dz = target[2] - flight.position[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-6 || speed < 1e-6) return;
  flight.velocity = [(dx / distance) * speed, (dy / distance) * speed, (dz / distance) * speed];
}

/**
 * One step of flight: gravity (game units/s², the world's × the PROJ's) pulls the velocity
 * down, the arrow moves along it. Returns the segment flown (what it may have hit lies on it).
 */
export function fly(flight: Flight, seconds: number, gravity: number): { from: Vec3; to: Vec3 } {
  const from: Vec3 = [flight.position[0], flight.position[1], flight.position[2]];
  flight.velocity[2] -= gravity * seconds;
  flight.position[0] += flight.velocity[0] * seconds;
  flight.position[1] += flight.velocity[1] * seconds;
  flight.position[2] += flight.velocity[2] * seconds;
  flight.age += seconds;
  flight.distance += Math.hypot(
    flight.position[0] - from[0],
    flight.position[1] - from[1],
    flight.position[2] - from[2],
  );
  return { from, to: [flight.position[0], flight.position[1], flight.position[2]] };
}

/**
 * Where along a segment (0..length, `direction` a unit vector) it enters an upright cylinder
 * standing on `feet` (a character controller's shape): through its side, its top or its bottom
 * (a shot from below into a flier overhead); 0 if it starts inside; undefined if it misses.
 */
export function segmentEntersCylinder(
  from: Vec3,
  direction: Vec3,
  length: number,
  shape: { readonly feet: Vec3; readonly radius: number; readonly height: number },
): number | undefined {
  let enter = 0;
  let leave = length;
  // Within the radius (seen from above).
  const ox = from[0] - shape.feet[0];
  const oy = from[1] - shape.feet[1];
  const a = direction[0] * direction[0] + direction[1] * direction[1];
  const c = ox * ox + oy * oy - shape.radius * shape.radius;
  if (a < 1e-12) {
    if (c > 0) return undefined;
  } else {
    const b = 2 * (ox * direction[0] + oy * direction[1]);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return undefined;
    const root = Math.sqrt(disc);
    enter = Math.max(enter, (-b - root) / (2 * a));
    leave = Math.min(leave, (-b + root) / (2 * a));
  }
  // Between its bottom and its top.
  const bottom = shape.feet[2];
  const top = shape.feet[2] + shape.height;
  if (Math.abs(direction[2]) < 1e-12) {
    if (from[2] < bottom || from[2] > top) return undefined;
  } else {
    const t0 = (bottom - from[2]) / direction[2];
    const t1 = (top - from[2]) / direction[2];
    enter = Math.max(enter, Math.min(t0, t1));
    leave = Math.min(leave, Math.max(t0, t1));
  }
  return enter <= leave ? enter : undefined;
}

/** Whether an arrow has flown its PROJ's range (0: no limit) or lifetime (0: none). */
export function spent(flight: Flight, range: number, lifetime: number): boolean {
  return (range > 0 && flight.distance >= range) || (lifetime > 0 && flight.age >= lifetime);
}

/** The heading and pitch an arrow points along (radians; its model's +Y along its flight). */
export function pointing(velocity: Vec3): { readonly heading: number; readonly pitch: number } {
  return {
    heading: Math.atan2(velocity[0], velocity[1]),
    pitch: Math.atan2(velocity[2], Math.hypot(velocity[0], velocity[1])),
  };
}

/** A pseudo-random draw (0..1) from a seed (the arrow inventory chance, reproducible in tests). */
export function chance(percent: number, roll: number): boolean {
  return roll * 100 < percent;
}

/** An arrow stuck in an actor's body (its ExtraAttachedArrows3D). */
export interface AttachedArrow {
  readonly target: number;
  /** When it goes (the clock's seconds): fAttachedArrowAgeMax after it struck. */
  readonly until: number;
}

/**
 * Which of the arrows stuck in actors go now (oldest first in `arrows`): those older than
 * fAttachedArrowAgeMax, those of an actor gone (`present` false), and each actor's oldest over
 * iMaxAttachedArrows.
 */
export function expiredArrows<A extends AttachedArrow>(
  arrows: readonly A[],
  now: number,
  max: number,
  present: (target: number) => boolean,
): A[] {
  const gone: A[] = [];
  const kept = new Map<number, number>();
  for (let i = arrows.length - 1; i >= 0; i--) {
    const arrow = arrows[i];
    if (!arrow) continue;
    const count = kept.get(arrow.target) ?? 0;
    if (arrow.until <= now || count >= max || !present(arrow.target)) gone.push(arrow);
    else kept.set(arrow.target, count + 1);
  }
  return gone;
}
