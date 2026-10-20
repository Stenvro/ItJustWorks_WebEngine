// How a projectile flies and what it hits (PROJ: src/world/projectile-data.ts; CommonLibSSE
// MissileProjectile, ArrowProjectile, GrenadeProjectile (lobbers), BeamProjectile,
// FlameProjectile, ConeProjectile):
//
// - Missiles, lobbers and arrows leave the caster's hand (the bow) at the projectile's speed
//   along the aim and fall by its gravity × the world's (9.8 m/s², Havok's 69.99 units a
//   metre); they end at their range or lifetime, at the first surface or actor their path meets
//   (as thick as their collision radius), or, with an alternative trigger, within its proximity
//   of an actor or after its timer.
// - Beams (lightning) and hitscan projectiles reach their range at once: the first surface or
//   actor along it.
// - Flames are sprays: a concentration spell sends one every relaunch interval while held,
//   each flying a short range.
// - Cones (Unrelenting Force) sweep everything within their range and cone spread (degrees
//   either side of the aim) at once.
// - Where one ends it may burst (its explosion, or the effect's: EXPL radius), and an effect
//   with an area (feet) reaches every actor within it of that point.
//
// Platform-independent: src/shell/magic-projectiles.ts flies them in the world.
// Notes: docs/ai.md ("Magic in combat").

import { HAVOK_SCALE } from '../../physics/collision-data.ts';
import type { Vec3 } from '../../render/math.ts';
import { ProjectileFlag, ProjectileType } from '../../world/projectile-data.ts';

/** The world's gravity in game units per second² (the physics world's 9.8 m/s²). */
export const WORLD_GRAVITY = 9.8 * HAVOK_SCALE;

/** What flying needs of a projectile record. */
export interface FlightData {
  readonly type: number;
  readonly flags: number;
  readonly speed: number;
  readonly gravity: number;
  readonly range: number;
  readonly lifetime: number;
  readonly collisionRadius: number;
  readonly proximity: number;
  readonly timer: number;
}

/** A projectile on its way. */
export interface Flight {
  readonly data: FlightData;
  position: Vec3;
  velocity: Vec3;
  /** Units flown, and seconds since it left. */
  traveled: number;
  age: number;
  /** It reached its range, lifetime or timer: it ends where it is. */
  spent: boolean;
}

/** How a projectile reaches what it hits. */
export type FlightKind = 'flying' | 'instant' | 'spray' | 'cone';

export function flightKind(data: Pick<FlightData, 'type' | 'flags'>): FlightKind {
  if (data.type === ProjectileType.cone) return 'cone';
  if (data.type === ProjectileType.beam || (data.flags & ProjectileFlag.hitscan) !== 0)
    return 'instant';
  if (data.type === ProjectileType.flame) return 'spray';
  // Missiles, lobbers, arrows; barriers (none in the vanilla records) fly as missiles.
  // TODO(M13): barrier projectiles' walls.
  return 'flying';
}

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

export function normalize(v: Vec3): Vec3 {
  const l = length(v);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

/** The direction of a yaw (radians: 0 north +Y, π/2 east +X) and a pitch (up positive). */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch)];
}

/** A projectile leaves `origin` along `direction` at its speed. */
export function launchFlight(data: FlightData, origin: Vec3, direction: Vec3): Flight {
  const d = normalize(direction);
  const speed = Math.max(0, data.speed);
  return {
    data,
    position: [...origin],
    velocity: [d[0] * speed, d[1] * speed, d[2] * speed],
    traveled: 0,
    age: 0,
    spent: false,
  };
}

/**
 * Flies on for `seconds`: the path of this step (from, to). Gravity bends it; past its range,
 * lifetime or timer it is spent (the step ends at its range).
 */
export function stepFlight(flight: Flight, seconds: number): { from: Vec3; to: Vec3 } {
  const from = flight.position;
  if (flight.spent || seconds <= 0) return { from, to: from };
  const data = flight.data;
  const fall = data.gravity * WORLD_GRAVITY;
  const [vx, vy, vz] = flight.velocity;
  let to: Vec3 = [
    from[0] + vx * seconds,
    from[1] + vy * seconds,
    from[2] + vz * seconds - 0.5 * fall * seconds * seconds,
  ];
  flight.velocity = [vx, vy, vz - fall * seconds];
  let step = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const range = data.range > 0 ? data.range : Infinity;
  if (flight.traveled + step >= range && step > 0) {
    const share = Math.max(0, range - flight.traveled) / step;
    to = [
      from[0] + (to[0] - from[0]) * share,
      from[1] + (to[1] - from[1]) * share,
      from[2] + (to[2] - from[2]) * share,
    ];
    step *= share;
    flight.spent = true;
  }
  flight.traveled += step;
  flight.age += seconds;
  if (data.lifetime > 0 && flight.age >= data.lifetime) flight.spent = true;
  if ((data.flags & ProjectileFlag.altTrigger) !== 0 && data.timer > 0 && flight.age >= data.timer)
    flight.spent = true;
  flight.position = to;
  return { from, to };
}

/** An actor as projectiles meet it: an upright capsule from its feet. */
export interface ActorShape {
  readonly feet: Vec3;
  readonly height: number;
  readonly radius: number;
}

/**
 * Where along a path (0..1) a sphere of `radius` moving from `from` to `to` first touches an
 * upright capsule (undefined: it does not).
 */
export function pathHitsActor(
  from: Vec3,
  to: Vec3,
  radius: number,
  shape: ActorShape,
): number | undefined {
  const r = shape.radius + Math.max(0, radius);
  const bottom = shape.feet[2] + shape.radius;
  const top = shape.feet[2] + Math.max(shape.radius, shape.height - shape.radius);
  // Sampled along the path against the capsule's axis (exact enough for a frame's step).
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / (r * 0.5)),
  );
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    const z = from[2] + (to[2] - from[2]) * t;
    const axisZ = Math.min(top, Math.max(bottom, z));
    if (Math.hypot(x - shape.feet[0], y - shape.feet[1], z - axisZ) <= r) return t;
  }
  return undefined;
}

/** The point at a share of a path. */
export function pointAt(from: Vec3, to: Vec3, t: number): Vec3 {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

/** Whether a point is within a projectile's proximity (its alternative trigger) of an actor. */
export function withinProximity(data: FlightData, point: Vec3, shape: ActorShape): boolean {
  if ((data.flags & ProjectileFlag.altTrigger) === 0 || !(data.proximity > 0)) return false;
  return pathHitsActor(point, point, data.proximity, shape) !== undefined;
}

/**
 * Whether an actor is within a cone: no farther than `range` from its apex and within
 * `spread` degrees either side of its direction (at its middle height).
 */
export function inCone(
  apex: Vec3,
  direction: Vec3,
  range: number,
  spread: number,
  shape: ActorShape,
): boolean {
  const middle: Vec3 = [shape.feet[0], shape.feet[1], shape.feet[2] + shape.height / 2];
  const to: Vec3 = [middle[0] - apex[0], middle[1] - apex[1], middle[2] - apex[2]];
  const distance = length(to);
  if (distance > range + shape.radius) return false;
  if (distance <= shape.radius) return true;
  const d = normalize(direction);
  const cos = (to[0] * d[0] + to[1] * d[1] + to[2] * d[2]) / distance;
  // The actor's own width widens the angle it can be met at.
  const widen = Math.atan2(shape.radius, distance);
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= (spread * Math.PI) / 180 + widen;
}

/** Whether an actor is within a radius of a point (its nearest part). */
export function inRadius(center: Vec3, radius: number, shape: ActorShape): boolean {
  return pathHitsActor(center, center, radius, shape) !== undefined;
}

/**
 * How much of an explosion's force (or damage) reaches a distance: all at its centre, none at
 * its radius (TODO(M13): the engine's falloff is not documented; linear).
 */
export function explosionFalloff(distance: number, radius: number): number {
  if (!(radius > 0)) return 0;
  return Math.max(0, 1 - distance / radius);
}
