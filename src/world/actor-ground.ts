// Where a placed actor stands: its character controller falls onto what is under it when its
// cell loads (the reference's height is where it was placed in the editor: a little above or
// into the ground; leveled animals and bandits up to 120 units over it), and races that tilt
// (RACE flags "tilt front/back", four-legged animals; "tilt left/right" too, spiders, chaurus,
// mudcrabs, mammoths) lean with the ground under them. Races that do not walk (slaughterfish)
// stay where they were placed, as do actors in furniture (their package's: Falmer in their
// wall pods) and actors with nothing under them (held in a cell until their package moves
// them). TODO(M10): the character controllers themselves.
// Platform-independent. Notes: docs/physics.md ("Actors on the ground").

import type { Mat4, Vec3 } from '../render/math.ts';
import { RaceFlag } from './actor-records.ts';

/** How far above its reference an actor's ground is looked for (sunk into it). */
export const GROUND_ABOVE = 16;
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
