// Where a placed actor stands: its character controller falls onto what is under it when its
// cell loads (the reference's height is where it was placed in the editor: a little above or
// into the ground; leveled animals and bandits up to 120 units over it), and races that tilt
// (RACE flags "tilt front/back", four-legged animals; "tilt left/right" too, spiders, chaurus,
// mudcrabs, mammoths) lean with the ground under them. Races that do not walk (slaughterfish)
// stay where they were placed, as do actors in furniture (their package's: Falmer in their
// wall pods) and actors with nothing under them (held in a cell until their package moves
// them). Their character controllers take over from there (src/shell/actor-movers.ts), leaning
// them as the engine's orientation controllers do (probedTilt, easeTilt).
// Platform-independent. Notes: docs/physics.md ("Actors on the ground").

import type { Mat4, Vec3 } from '../render/math.ts';
import { RaceFlag } from './actor-records.ts';

/**
 * The engine's check of an actor's position (observed in the original): what it stands on is looked for
 * from a quarter of its height above its feet, at most this far (game units), down to
 * fCheckPositionFallDistance below them. A point a little under a floor (a navmesh lies up to
 * 25 units under the collision it covers: Whiterun's shop porches) so finds the floor, not the
 * ground beneath it.
 */
export const CHECK_ABOVE_MOST = 32;
/** fCheckPositionFallDistance's built-in default (game units). */
export const CHECK_FALL_DISTANCE = 72;

/** How far above an actor's feet the engine's position check begins (its height, units). */
export function checkAbove(height: number): number {
  return Math.min(Math.max(height, 0) / 4, CHECK_ABOVE_MOST);
}

/**
 * How far above its reference an actor's ground is looked for (sunk into it): the engine's
 * position check from a human's height (a quarter of 128 units, the most it reaches).
 */
export const GROUND_ABOVE = CHECK_ABOVE_MOST;
/** How far below its reference: it falls onto whatever is under it, however far. */
export const GROUND_BELOW = 65536;

/** The ground under a point: where a ray straight down meets it and the surface's normal. */
export interface GroundHit {
  readonly point: Vec3;
  readonly normal: Vec3;
}

/** Whether an actor of a race (RACE DATA flags) is set on the ground. */
export function standsOnGround(raceFlags: number): boolean {
  return (raceFlags & RaceFlag.walks) !== 0;
}

/**
 * An actor's placement set on the ground: its feet at the hit point, leaning with the ground's
 * normal as far as its race tilts (its scale and heading kept). `world` is its placement as the
 * reference has it (upright, turned about z).
 */
export function groundedPlacement(world: Mat4, raceFlags: number, ground: GroundHit): Mat4 {
  const out = new Float32Array(world);
  const scale = Math.hypot(world[0] ?? 0, world[1] ?? 0, world[2] ?? 0) || 1;
  const right: Vec3 = [(world[0] ?? 0) / scale, (world[1] ?? 0) / scale, (world[2] ?? 0) / scale];
  const forward: Vec3 = [(world[4] ?? 0) / scale, (world[5] ?? 0) / scale, (world[6] ?? 0) / scale];
  const up: Vec3 = [(world[8] ?? 0) / scale, (world[9] ?? 0) / scale, (world[10] ?? 0) / scale];
  const n = ground.normal;
  const along = (axis: Vec3): number => axis[0] * n[0] + axis[1] * n[1] + axis[2] * n[2];
  // The normal as far as the race leans: its parts along the axes it may tilt about.
  const frontBack = (raceFlags & RaceFlag.tiltFrontBack) !== 0 ? along(forward) : 0;
  const leftRight = (raceFlags & RaceFlag.tiltLeftRight) !== 0 ? along(right) : 0;
  const upright = Math.max(along(up), 0.2);
  let u: Vec3 = [
    up[0] * upright + forward[0] * frontBack + right[0] * leftRight,
    up[1] * upright + forward[1] * frontBack + right[1] * leftRight,
    up[2] * upright + forward[2] * frontBack + right[2] * leftRight,
  ];
  u = normalize(u);
  // Forward and right made square to the new up (the heading kept).
  const f = normalize(subtract(forward, scaled(u, dot(forward, u))));
  const r = cross(f, u);
  out.set([...scaled(r, scale), 0], 0);
  out.set([...scaled(f, scale), 0], 4);
  out.set([...scaled(u, scale), 0], 8);
  out[12] = ground.point[0];
  out[13] = ground.point[1];
  out[14] = ground.point[2];
  return out;
}

/**
 * The most an actor leans with the ground, either way (radians: the engine's orientation
 * controllers clamp their pitch and roll to a built-in 47°; observed in the original).
 */
export const MAX_TILT = (47 * Math.PI) / 180;

/** How an actor leans: pitch (its nose up, positive) and roll (its left side up, positive). */
export interface Tilt {
  readonly pitch: number;
  readonly roll: number;
}

export const UPRIGHT: Tilt = { pitch: 0, roll: 0 };

/**
 * The ground's height under a moving actor's ends (observed in the original: the engine's quadruped
 * orientation controller): ahead and behind along its length, and for those that tilt across
 * too, to its left and right.
 */
export interface TiltProbes {
  readonly front: number;
  readonly back: number;
  readonly left?: number | undefined;
  readonly right?: number | undefined;
}

/**
 * The lean the ground under its ends gives an actor whose race tilts (observed in the original: the
 * engine's quadruped orientation controller): the angle whose tangent is the height between its
 * front and back probes over `base`, the same across from its left and right probes over
 * `across` for races that tilt left and right, each clamped to MAX_TILT. Races that do not tilt
 * that way get 0. The engine divides by its controller's length less its two end radii; ours by
 * the distance between the probes (inferred: what its controller's length holds was not read,
 * and less than the probes' distance it would lean a horse 1.45 times as steep as its ground).
 */
export function probedTilt(
  probes: TiltProbes,
  base: number,
  raceFlags: number,
  across = base,
): Tilt {
  const lean = (high: number, low: number, over: number): number => {
    if (!(over > 0) || high === low) return 0;
    const angle = Math.atan((high - low) / over);
    return Math.max(-MAX_TILT, Math.min(MAX_TILT, angle));
  };
  const pitch =
    (raceFlags & RaceFlag.tiltFrontBack) !== 0 ? lean(probes.front, probes.back, base) : 0;
  const roll =
    (raceFlags & RaceFlag.tiltLeftRight) !== 0 &&
    probes.left !== undefined &&
    probes.right !== undefined
      ? lean(probes.left, probes.right, across)
      : 0;
  return { pitch, roll };
}

/**
 * One update of the engine's lean (observed in the original): its pitch and roll move towards the ground's
 * by fQuadrupedPitchMult ([HAVOK], 10) times the update's time of what is left, so a step onto
 * another slope is leaned into over about a tenth of a second instead of at once.
 */
export function easeTilt(current: Tilt, target: Tilt, seconds: number, rate: number): Tilt {
  const k = Math.max(0, Math.min(1, rate * seconds));
  return {
    pitch: current.pitch + (target.pitch - current.pitch) * k,
    roll: current.roll + (target.roll - current.roll) * k,
  };
}

/** The ground normal (world) a lean stands for, for an actor facing `heading` (compass). */
export function tiltNormal(tilt: Tilt, heading: number): Vec3 {
  const forward: Vec3 = [Math.sin(heading), Math.cos(heading), 0];
  const right: Vec3 = [Math.cos(heading), -Math.sin(heading), 0];
  // The plane rising tan(pitch) ahead and tan(roll) to the left: its normal leans back and right.
  const ahead = Math.tan(tilt.pitch);
  const across = Math.tan(tilt.roll);
  return normalize([
    -forward[0] * ahead + right[0] * across,
    -forward[1] * ahead + right[1] * across,
    1,
  ]);
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaled = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}
