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
