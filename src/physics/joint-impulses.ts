// The impulses a group of point joints (balls and sockets, a chain's links, hinges' pivots) take
// in a step, solved together and exactly: what Havok's solver results tell a breakable
// constraint (docs/physics.md, "Breakable"). Rapier does not expose its joints' impulses, and a
// body's own change of momentum only tells the sum of all that holds it: the mace trap's mace
// hangs by its pin and by its chain, and the chain's pull, which the pin holds against, cancelled
// out of it (the pin seemed to carry the mace's weight alone and never broke).
//
// The solve: every joint's two pivot points must move as one after the step's impulses. With
// the bodies' velocities before the step (gravity's speed over the step added to the simulated
// ones), the joints' impulses λ satisfy K λ = −u, u the pivots' relative velocities and K the
// effect of each joint's impulse on each joint's relative velocity through the bodies they
// share. A direct solve, as Havok solves a constraint chain (hkpBallSocketChainData) as one.
// TODO(M13): inferred; Havok's own solver iterates, with tau's position correction (not here).
//
// Platform-independent (plain numbers, no Rapier).

import type { Vec3 } from '../render/math.ts';

/** A body as the solve sees it: world frame, Havok units, about its centre of mass. */
export interface ImpulseBody {
  /** 0 for a body nothing moves (fixed, keyframed). */
  readonly invMass: number;
  /** The world inverse inertia, symmetric: xx, xy, xz, yy, yz, zz. */
  readonly invInertia: readonly [number, number, number, number, number, number];
  readonly linear: Vec3;
  readonly angular: Vec3;
}

/** A point joint: the impulse acts on `b` (+) and `a` (−) at the pivot. */
export interface PointJoint {
  readonly a: number;
  readonly b: number;
  /** The pivot from each body's centre of mass (world). */
  readonly ra: Vec3;
  readonly rb: Vec3;
}

type M3 = [number, number, number, number, number, number, number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** [r]× as a matrix (row-major): [r]× p = r × p. */
function skew(r: Vec3): M3 {
  return [0, -r[2], r[1], r[2], 0, -r[0], -r[1], r[0], 0];
}

function sym(i: ImpulseBody['invInertia']): M3 {
  return [i[0], i[1], i[2], i[1], i[3], i[4], i[2], i[4], i[5]];
}

function mul(a: M3, b: M3): M3 {
  const out: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        (a[r * 3] ?? 0) * (b[c] ?? 0) +
        (a[r * 3 + 1] ?? 0) * (b[3 + c] ?? 0) +
        (a[r * 3 + 2] ?? 0) * (b[6 + c] ?? 0);
    }
  }
  return out;
}

/**
 * The velocity change at `rj` on a body from a unit impulse at `rk` on it, as a matrix:
 * m⁻¹ E − [rj]× I⁻¹ [rk]×.
 */
function response(body: ImpulseBody, rj: Vec3, rk: Vec3): M3 {
  const out = mul(mul(skew(rj), sym(body.invInertia)), skew(rk));
  for (let i = 0; i < 9; i++) out[i] = -(out[i] ?? 0);
  out[0] += body.invMass;
  out[4] += body.invMass;
  out[8] += body.invMass;
  return out;
}

/** A joint's two ends: the body, the sign of the joint's impulse on it, its pivot. */
function ends(joint: PointJoint): readonly (readonly [number, number, Vec3])[] {
  return [
    [joint.a, -1, joint.ra],
    [joint.b, 1, joint.rb],
  ];
}

function moves(body: ImpulseBody): boolean {
  return body.invMass > 0 || body.invInertia.some((x) => x !== 0);
}

/** A pivot's velocity on a body. */
function pointVelocity(body: ImpulseBody, r: Vec3): Vec3 {
  const t = cross(body.angular, r);
  return [body.linear[0] + t[0], body.linear[1] + t[1], body.linear[2] + t[2]];
}

/**
 * The impulse each joint takes for its pivots to move as one (Havok units, kg·m/s), in the
 * joints' order. Joints between two bodies that nothing moves take none. A group with joints that
 * hold the same motion twice gets the least of the impulses that do it (a small regularization).
 */
export function jointImpulses(
  bodies: readonly ImpulseBody[],
  joints: readonly PointJoint[],
): Vec3[] {
  const n = joints.length * 3;
  const k = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  joints.forEach((j, row) => {
    const a = bodies[j.a];
    const b = bodies[j.b];
    if (!a || !b) return;
    const va = pointVelocity(a, j.ra);
    const vb = pointVelocity(b, j.rb);
    for (let i = 0; i < 3; i++) rhs[row * 3 + i] = -((vb[i] ?? 0) - (va[i] ?? 0));
    joints.forEach((other, column) => {
      // Each body the two joints share, by the signs of their ends on it (b +, a −).
      for (const [index, sj, rj] of ends(j)) {
        const body = bodies[index];
        if (!body || !moves(body)) continue;
        for (const [otherIndex, sk, rk] of ends(other)) {
          if (otherIndex !== index) continue;
          const m = response(body, rj, rk);
          const sign = sj * sk;
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
              const at = (row * 3 + r) * n + column * 3 + c;
              k[at] = (k[at] ?? 0) + sign * (m[r * 3 + c] ?? 0);
            }
          }
        }
      }
    });
  });
  // A joint between two bodies nothing moves takes nothing.
  for (let joint = 0; joint < joints.length; joint++) {
    let diagonal = 0;
    for (let i = joint * 3; i < joint * 3 + 3; i++) diagonal += k[i * n + i] ?? 0;
    if (diagonal > 0) continue;
    for (let i = joint * 3; i < joint * 3 + 3; i++) {
      for (let c = 0; c < n; c++) {
        k[i * n + c] = 0;
        k[c * n + i] = 0;
      }
      k[i * n + i] = 1;
      rhs[i] = 0;
    }
  }
  // A little on the diagonal: joints that hold the same motion twice leave K singular.
  let trace = 0;
  for (let i = 0; i < n; i++) trace += Math.abs(k[i * n + i] ?? 0);
  const epsilon = (trace / Math.max(1, n)) * 1e-9 + 1e-12;
  for (let i = 0; i < n; i++) k[i * n + i] = (k[i * n + i] ?? 0) + epsilon;
  const x = solve(k, rhs, n);
  return joints.map((_, i) => [x[i * 3] ?? 0, x[i * 3 + 1] ?? 0, x[i * 3 + 2] ?? 0]);
}

/** Gaussian elimination with partial pivoting (k is n × n, row-major; both are overwritten). */
function solve(k: Float64Array, rhs: Float64Array, n: number): Float64Array {
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(k[r * n + c] ?? 0) > Math.abs(k[pivot * n + c] ?? 0)) pivot = r;
    }
    const p = k[pivot * n + c] ?? 0;
    if (Math.abs(p) < 1e-300) continue;
    if (pivot !== c) {
      for (let i = 0; i < n; i++) {
        const t = k[c * n + i] ?? 0;
        k[c * n + i] = k[pivot * n + i] ?? 0;
        k[pivot * n + i] = t;
      }
      const t = rhs[c] ?? 0;
      rhs[c] = rhs[pivot] ?? 0;
      rhs[pivot] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = (k[r * n + c] ?? 0) / p;
      if (f === 0) continue;
      for (let i = c; i < n; i++) k[r * n + i] = (k[r * n + i] ?? 0) - f * (k[c * n + i] ?? 0);
      rhs[r] = (rhs[r] ?? 0) - f * (rhs[c] ?? 0);
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = rhs[r] ?? 0;
    for (let i = r + 1; i < n; i++) s -= (k[r * n + i] ?? 0) * (x[i] ?? 0);
    const d = k[r * n + r] ?? 0;
    x[r] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
  return x;
}
