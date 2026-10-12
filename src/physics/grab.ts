// Grabbing loose objects (holding Activate on one, the old "Z key"): the engine hangs the
// object on Havok's mouse spring (hkpMouseSpringAction, the player's grabSpring), which pulls
// the point the player took hold of towards a point in front of the camera at the distance it
// was taken. Every step the spring applies an impulse at that point that removes
// fZKeySpringElasticity of the distance per step and fZKeySpringDamping of the point's
// velocity, through the body's effective mass at the point; the impulse is limited to the
// body's mass × the step × the maximum relative force; then the body's velocities are scaled
// by fZKeyObjectDamping. Notes: docs/physics.md.

import RAPIER from '@dimforge/rapier3d-compat';
import { HAVOK_SCALE } from './collision-data.ts';

type Vec3 = [number, number, number];
type Point = readonly [number, number, number];

/** The grab settings (GMST fZKey*; the game's own defaults). */
export interface GrabSettings {
  readonly springDamping: number;
  readonly springElasticity: number;
  readonly objectDamping: number;
  /** fZKeyMaxForce, scaled by the object's weight between the two scales. */
  readonly maxForce: number;
  readonly maxForceScaleLow: number;
  readonly maxForceScaleHigh: number;
  readonly maxForceWeightLow: number;
  readonly maxForceWeightHigh: number;
}

/**
 * The executable's defaults of the grab settings (a dump of every game setting; the plugins
 * set fZKeyMaxForce and fZKeyMaxForceWeightHigh to the same values).
 */
export const GRAB_DEFAULTS: GrabSettings = {
  springDamping: 0.5,
  springElasticity: 0.2,
  objectDamping: 0.75,
  maxForce: 100,
  maxForceScaleLow: 0.2,
  maxForceScaleHigh: 1,
  maxForceWeightLow: 0,
  maxForceWeightHigh: 150,
};

/**
 * The spring's maximum relative force (acceleration, m/s²) for an object's weight:
 * fZKeyMaxForce × the scale from fZKeyMaxForceScaleLow at fZKeyMaxForceWeightLow to
 * fZKeyMaxForceScaleHigh at fZKeyMaxForceWeightHigh. The engine's use of the weight is not
 * documented; here the body's Havok mass is the weight. TODO(M13): calibrate against the game.
 */
export function maxRelativeForce(settings: GrabSettings, weight: number): number {
  const span = settings.maxForceWeightHigh - settings.maxForceWeightLow;
  const t = span > 0 ? Math.min(1, Math.max(0, (weight - settings.maxForceWeightLow) / span)) : 1;
  return (
    settings.maxForce *
    (settings.maxForceScaleLow + (settings.maxForceScaleHigh - settings.maxForceScaleLow) * t)
  );
}

/** A held object: the body, the point taken hold of (in the body's frame) and the spring. */
export class GrabSpring {
  readonly body: RAPIER.RigidBody;
  /** Where the spring pulls to (game units); the holder moves it every step. */
  target: Point;
  readonly #local: Vec3;
  readonly #settings: GrabSettings;
  readonly #maxRelativeForce: number;

  /** Takes hold of `body` at `point` (game units, on or near the body). */
  constructor(body: RAPIER.RigidBody, point: Point, settings: GrabSettings) {
    this.body = body;
    this.target = [...point];
    this.#settings = settings;
    this.#maxRelativeForce = maxRelativeForce(settings, body.mass());
    const t = body.translation();
    const offset: Vec3 = [
      point[0] / HAVOK_SCALE - t.x,
      point[1] / HAVOK_SCALE - t.y,
      point[2] / HAVOK_SCALE - t.z,
    ];
    this.#local = rotate(conjugate(body.rotation()), offset);
  }

  /** The point held, in the world (game units). */
  get point(): Point {
    const p = this.#worldPoint();
    return [p[0] * HAVOK_SCALE, p[1] * HAVOK_SCALE, p[2] * HAVOK_SCALE];
  }

  /** One physics step of the spring (before the world steps). */
  apply(dt: number): void {
    const body = this.body;
    const settings = this.#settings;
    const point = this.#worldPoint();
    const com = body.worldCom();
    const r: Vec3 = [point[0] - com.x, point[1] - com.y, point[2] - com.z];
    const linear = body.linvel();
    const angular = body.angvel();
    const velocity: Vec3 = add(
      [linear.x, linear.y, linear.z],
      cross([angular.x, angular.y, angular.z], r),
    );
    // Desired change: pull fZKeySpringElasticity of the gap per step, damp the velocity.
    const toTarget = settings.springElasticity / dt;
    const delta: Vec3 = [
      (point[0] - this.target[0] / HAVOK_SCALE) * toTarget + velocity[0] * settings.springDamping,
      (point[1] - this.target[1] / HAVOK_SCALE) * toTarget + velocity[1] * settings.springDamping,
      (point[2] - this.target[2] / HAVOK_SCALE) * toTarget + velocity[2] * settings.springDamping,
    ];
    // The body's effective mass at the point: K = m⁻¹·1 − [r]× I⁻¹ [r]×.
    const inverse = body.effectiveWorldInvInertia().elements;
    const k = pointInverseMass(body.invMass(), inverse, r);
    const massMatrix = invert3(k);
    if (!massMatrix) return;
    const impulse = multiply3(massMatrix, delta).map((value) => -value) as Vec3;
    const limit = body.mass() * dt * this.#maxRelativeForce;
    const length = Math.hypot(...impulse);
    if (length > limit && length > 0) {
      for (let i = 0; i < 3; i++) impulse[i] = (impulse[i] ?? 0) * (limit / length);
    }
    body.applyImpulseAtPoint(
      { x: impulse[0], y: impulse[1], z: impulse[2] },
      { x: point[0], y: point[1], z: point[2] },
      true,
    );
    const v = body.linvel();
    const w = body.angvel();
    const damping = settings.objectDamping;
    body.setLinvel({ x: v.x * damping, y: v.y * damping, z: v.z * damping }, true);
    body.setAngvel({ x: w.x * damping, y: w.y * damping, z: w.z * damping }, true);
  }

  /** The held point in Havok units. */
  #worldPoint(): Vec3 {
    const t = this.body.translation();
    const p = rotate(this.body.rotation(), this.#local);
    return [p[0] + t.x, p[1] + t.y, p[2] + t.z];
  }
}

interface Quaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

function conjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function rotate(q: Quaternion, v: Vec3): Vec3 {
  // v + 2w(q×v) + 2 q×(q×v)
  const u: Vec3 = [q.x, q.y, q.z];
  const t = cross(u, v).map((value) => value * 2) as Vec3;
  return add(add(v, t.map((value) => value * q.w) as Vec3), cross(u, t));
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * m⁻¹·1 − [r]× I⁻¹ [r]× as a row-major 3×3, with I⁻¹ given as the upper triangle of a
 * symmetric matrix (m11 m12 m13 m22 m23 m33).
 */
export function pointInverseMass(
  inverseMass: number,
  inertia: ArrayLike<number>,
  r: Vec3,
): number[] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from(inertia);
  const inv = [a, b, c, b, d, e, c, e, f];
  const skew = [0, -r[2], r[1], r[2], 0, -r[0], -r[1], r[0], 0];
  const product = mul3x3(mul3x3(skew, inv), skew);
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(
    (i) => (i % 4 === 0 ? inverseMass : 0) - (product[i] ?? 0),
  );
}

function mul3x3(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (a[row * 3 + k] ?? 0) * (b[k * 3 + col] ?? 0);
      out.push(sum);
    }
  }
  return out;
}

function multiply3(m: readonly number[], v: Vec3): Vec3 {
  return [0, 1, 2].map(
    (row) => (m[row * 3] ?? 0) * v[0] + (m[row * 3 + 1] ?? 0) * v[1] + (m[row * 3 + 2] ?? 0) * v[2],
  ) as Vec3;
}

/** Inverse of a row-major 3×3, or undefined if it is singular. */
export function invert3(m: readonly number[]): number[] | undefined {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return undefined;
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}
