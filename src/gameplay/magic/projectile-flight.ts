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
// - Cones (Unrelenting Force) sweep out at their speed to their range, reaching everything
//   within their cone spread (degrees either side of the aim) as their front passes it.
// - Lobbers (runes) bounce off a surface by fGrenadeRestitution or rest there; with an
//   alternative trigger they wait at rest for an actor within their proximity or their timer.
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
  /** A lobber come to rest on a surface: it waits there for its trigger (restLobber). */
  resting?: boolean;
}

/** How a projectile reaches what it hits. */
export type FlightKind = 'flying' | 'lobber' | 'instant' | 'spray' | 'cone';

export function flightKind(data: Pick<FlightData, 'type' | 'flags'>): FlightKind {
  if (data.type === ProjectileType.cone) return 'cone';
  if (data.type === ProjectileType.beam || (data.flags & ProjectileFlag.hitscan) !== 0)
    return 'instant';
  if (data.type === ProjectileType.flame) return 'spray';
  if (data.type === ProjectileType.lobber) return 'lobber';
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
  if (flight.resting) {
    // At rest it only ages (its lifetime, its alternative trigger's timer).
    flight.age += seconds;
    if (data.lifetime > 0 && flight.age >= data.lifetime) flight.spent = true;
    if (
      (data.flags & ProjectileFlag.altTrigger) !== 0 &&
      data.timer > 0 &&
      flight.age >= data.timer
    )
      flight.spent = true;
    return { from, to: from };
  }
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

/** The lobbers' surface settings (GMSTs; the engine's defaults, Skyrim.esm keeps them). */
export interface LobberSettings {
  /** fGrenadeRestitution: the share of its speed into the surface it bounces back with. */
  readonly restitution: number;
  /** fGrenadeFriction: the share of its speed along the surface the bounce takes away. */
  readonly friction: number;
}

export const LOBBER_DEFAULTS: LobberSettings = { restitution: 0, friction: 0 };

/** Below this speed (units a second) off a surface a lobber stops bouncing and lies still. */
const LOBBER_REST_SPEED = 20;

/**
 * A lobber (runes, thrown things: CommonLibSSE GrenadeProjectile) meets a surface: it bounces
 * off it (its speed into the surface back by fGrenadeRestitution, along it less by
 * fGrenadeFriction) or, too slow to bounce, comes to rest where it met it. Without an
 * alternative trigger a lobber bursts where it meets a surface (the caller ends it); with one it
 * waits, at rest, for an actor within its proximity or its timer. Returns whether it rests.
 * Vanilla's lobbers (the runes) keep both settings at 0: they stop where they land.
 * TODO(M13): a lobber's slide along a slope with friction below 1 (it rests at once here).
 */
export function bounceLobber(
  flight: Flight,
  point: Vec3,
  normal: Vec3 | undefined,
  settings: LobberSettings = LOBBER_DEFAULTS,
): boolean {
  flight.position = [...point];
  const n = normalize(normal ?? [0, 0, 1]);
  const [vx, vy, vz] = flight.velocity;
  const into = vx * n[0] + vy * n[1] + vz * n[2];
  const along: Vec3 = [vx - into * n[0], vy - into * n[1], vz - into * n[2]];
  const back = -into * Math.max(0, settings.restitution);
  const keep = 1 - Math.min(1, Math.max(0, settings.friction));
  if (back < LOBBER_REST_SPEED) {
    flight.velocity = [0, 0, 0];
    flight.resting = true;
    return true;
  }
  flight.velocity = [
    along[0] * keep + n[0] * back,
    along[1] * keep + n[1] * back,
    along[2] * keep + n[2] * back,
  ];
  return false;
}

/**
 * A cone's wave (Unrelenting Force, Fire Breath; CommonLibSSE ConeProjectile): it sweeps out
 * from its apex at its projectile's speed to its range, reaching each actor or object as its
 * front passes it (within its spread either side of its direction).
 */
export interface ConeWave {
  readonly apex: Vec3;
  readonly direction: Vec3;
  readonly range: number;
  /** Degrees either side of its direction. */
  readonly spread: number;
  /** Units a second its front moves out (its range at once without a speed). */
  readonly speed: number;
  /** How far its front has come. */
  front: number;
  /** What it has reached (each once). */
  readonly reached: Set<number>;
}

export function launchCone(
  apex: Vec3,
  direction: Vec3,
  range: number,
  spread: number,
  speed: number,
): ConeWave {
  return {
    apex: [...apex],
    direction: normalize(direction),
    range,
    spread,
    speed: speed > 0 ? speed : Infinity,
    front: 0,
    reached: new Set(),
  };
}

/** Whether the wave has reached its range (it is done). */
export function coneDone(wave: ConeWave): boolean {
  return wave.front >= wave.range;
}

/**
 * The wave moves out for `seconds`: the shapes it newly reaches (keyed), each once. Call with 0
 * as it leaves (those at its apex).
 */
export function sweepCone<K extends number>(
  wave: ConeWave,
  seconds: number,
  shapes: Iterable<readonly [K, ActorShape]>,
): K[] {
  wave.front = Math.min(wave.range, wave.front + wave.speed * Math.max(0, seconds));
  const reached: K[] = [];
  for (const [key, shape] of shapes) {
    if (wave.reached.has(key)) continue;
    if (!inCone(wave.apex, wave.direction, wave.front, wave.spread, shape)) continue;
    wave.reached.add(key);
    reached.push(key);
  }
  return reached;
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
