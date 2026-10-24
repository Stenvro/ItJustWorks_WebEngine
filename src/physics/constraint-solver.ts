// What Havok's solver does for the joints of ragdolls and hinged objects that Rapier's joints do
// not (docs/physics.md, "Constraints and ragdolls"), as the engine sets it up (observed in the
// original):
//
// - Friction: a ragdoll's and a limited hinge's maximum friction torque holds the joint's
//   relative turn still on each of its axes up to that torque (Havok's angular friction: no
//   relative motion, at most the torque × the step), solved before each Rapier step together
//   with the joint's pivot and with gravity's speed of the step: friction holds a limb against
//   its weight, and lets it go when the weight's torque is the greater. Rapier's motors cannot
//   do this (a velocity motor of any strength let a pendulum swing down as a damper would).
// - Soft limits: a joint let go past its limits (a dying actor's animated pose) comes back by
//   the solver's tau (× the limit's tau factor) of the way each step, not within one step
//   (Rapier's limits are stiff: a body flew off at 2,000 units a second): easedLimits.
// - Solver deactivation: a slow body is slowed down further (slowBodyFactor).
//
// Platform-independent (Rapier bodies, no browser).

import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../render/math.ts';

/**
 * The solver's settings (Havok's hkpSolverInfo as the engine sets it every step): tau, the share
 * of a limit's error corrected in a step; damping, the share of the speed into a limit taken
 * out; the solver's iterations.
 */
export interface SolverSettings {
  readonly tau: number;
  readonly damping: number;
  readonly iterations: number;
}

/**
 * Observed in the original: its world is made with Havok's medium solver (tau 0.6, damping
 * 1, four iterations), and every step it sets tau and the iterations again (solverSettings);
 * at its own step (fMaxTime) they are these.
 */
export const SOLVER_DEFAULTS: SolverSettings = { tau: 0.6, damping: 1, iterations: 4 };

/**
 * The solver's settings for a step of `step` seconds, observed in the original: with r the
 * step over [HAVOK] fMaxTime × the time multiplier, tau is 0.6 × (fHavokTauRatio × r + 1 −
 * fHavokTauRatio) and the iterations the larger of 4 and 3.9 × the time multiplier (rounded up),
 * times r, at least 2; the damping stays 1.
 */
export function solverSettings(
  step: number,
  maxTime: number,
  tauRatio: number,
  timeMultiplier = 1,
): SolverSettings {
  const r = maxTime * timeMultiplier > 0 ? step / (maxTime * timeMultiplier) : 1;
  const iterations = Math.max(2, Math.trunc(Math.max(4, Math.ceil(timeMultiplier * 3.9)) * r));
  return { tau: 0.6 * (tauRatio * r + 1 - tauRatio), damping: 1, iterations };
}

/**
 * The share of the solver's tau a limit gets (Havok's angular limits' tau factor), observed in
 * the original: hkpRagdollConstraintData makes its twist, cone and plane limits with 0.8,
 * hkpLimitedHingeConstraintData its angle limit with 1 (the files do not set it).
 */
export const RAGDOLL_LIMIT_TAU_FACTOR = 0.8;
export const HINGE_LIMIT_TAU_FACTOR = 1;

/** A joint's frame on one of its bodies: the pivot and the axes, in the body's space. */
export interface SolverFrame {
  /** Havok units, relative to the body's origin. */
  readonly pivot: Vec3;
  /** Unit vectors: a ragdoll's twist and plane axes, a hinge's axle and its perpendicular. */
  readonly axes: readonly [Vec3, Vec3];
}

/** A ragdoll or limited hinge constraint as the solver keeps it. */
export interface SolverConstraint {
  readonly type: 'ragdoll' | 'limited-hinge';
  readonly a: SolverFrame;
  readonly b: SolverFrame;
  /** Havok units (kg·m²/s²). */
  readonly maxFriction: number;
}

/** A constraint between two bodies the solver keeps. */
export interface SolverJoint {
  readonly a: RAPIER.RigidBody;
  readonly b: RAPIER.RigidBody;
  readonly constraint: SolverConstraint;
}

// --- Vectors ------------------------------------------------------------------------------------

interface V {
  x: number;
  y: number;
  z: number;
}

interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

const v3 = (x = 0, y = 0, z = 0): V => ({ x, y, z });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

/** `a` scaled to unit length, or undefined when it has none. */
function unit(a: V): V | undefined {
  const length = Math.hypot(a.x, a.y, a.z);
  return length > 1e-9 ? v3(a.x / length, a.y / length, a.z / length) : undefined;
}

function rotate(q: Quat, v: Vec3): V {
  const tx = 2 * (q.y * v[2] - q.z * v[1]);
  const ty = 2 * (q.z * v[0] - q.x * v[2]);
  const tz = 2 * (q.x * v[1] - q.y * v[0]);
  return v3(
    v[0] + q.w * tx + (q.y * tz - q.z * ty),
    v[1] + q.w * ty + (q.z * tx - q.x * tz),
    v[2] + q.w * tz + (q.x * ty - q.y * tx),
  );
}

/** A symmetric 3×3 matrix (a world inverse inertia). */
interface Sym {
  readonly xx: number;
  readonly xy: number;
  readonly xz: number;
  readonly yy: number;
  readonly yz: number;
  readonly zz: number;
}

const ZERO_SYM: Sym = { xx: 0, xy: 0, xz: 0, yy: 0, yz: 0, zz: 0 };

const symTimes = (m: Sym, v: V): V =>
  v3(
    m.xx * v.x + m.xy * v.y + m.xz * v.z,
    m.xy * v.x + m.yy * v.y + m.yz * v.z,
    m.xz * v.x + m.yz * v.y + m.zz * v.z,
  );

// --- Friction -----------------------------------------------------------------------------------

/** A body's velocities and mass properties for the solve (world, Havok units). */
interface BodyState {
  readonly body: RAPIER.RigidBody;
  readonly dynamic: boolean;
  readonly invMass: number;
  readonly invInertia: Sym;
  readonly v: V;
  readonly w: V;
  /** Gravity's speed over the step (its share: gravityShare): added before the solve, taken off after. */
  readonly gravity: V;
  changed: boolean;
}

/** One friction axis of a joint: its effective mass, its bound and its impulse so far. */
interface Row {
  readonly a: BodyState;
  readonly b: BodyState;
  /** World axis; the row's speed is n · (ωB − ωA). */
  readonly n: V;
  /** IA⁻¹ n and IB⁻¹ n. */
  readonly ia: V;
  readonly ib: V;
  readonly mass: number;
  /** |impulse| ≤ limit. */
  readonly limit: number;
  impulse: number;
}

/** A pivot's velocity block (Havok's ball and socket; its position is Rapier's). */
interface Pivot {
  readonly a: BodyState;
  readonly b: BodyState;
  /** The pivot from each body's centre of mass (world). */
  readonly ra: V;
  readonly rb: V;
  /** The inverse of the block's effective mass matrix, by rows. */
  readonly k: readonly [V, V, V];
}

/**
 * How often a joint's friction and pivot are solved in turn within each of the solver's
 * iterations. A limb's turn and its pivot's motion depend on each other (a long limb turns most
 * of all about its pivot): solved once each per iteration they converged so slowly that a limb
 * held by its joint's friction crept down (a rod held by more than its weight's torque sank
 * 2° a second); in turn four times a joint, it holds (Havok solves a constraint's pivot and
 * angles as one constraint).
 */
const JOINT_SWEEPS = 4;

/**
 * A body's state for the solve, with the speed gravity gives it over Rapier's step (on average:
 * `share` of the step's, GRAVITY_SHARE) added; it is taken off again after the solve.
 */
function bodyState(
  body: RAPIER.RigidBody,
  step: number,
  gravity: RAPIER.Vector,
  share: number,
): BodyState {
  const dynamic = body.isDynamic();
  let invInertia = ZERO_SYM;
  let g = v3();
  if (dynamic) {
    const m = body.effectiveWorldInvInertia();
    invInertia = { xx: m.m11, xy: m.m12, xz: m.m13, yy: m.m22, yz: m.m23, zz: m.m33 };
    const scale = body.gravityScale() * step * share;
    g = v3(gravity.x * scale, gravity.y * scale, gravity.z * scale);
  }
  const lin = body.linvel();
  const ang = body.angvel();
  return {
    body,
    dynamic,
    invMass: dynamic ? body.invMass() : 0,
    invInertia,
    v: v3(lin.x + g.x, lin.y + g.y, lin.z + g.z),
    w: v3(ang.x, ang.y, ang.z),
    gravity: g,
    changed: false,
  };
}

/**
 * GRAVITY_SHARE: the share of a step's gravity speed the solve takes as given: Rapier adds
 * gravity in each of its `substeps` and moves the bodies after each, so over the step a body
 * moves as if it went at its speed plus (substeps + 1) / (2 × substeps) of the step's gravity
 * speed. Solved with that, a limb held by friction stays where it is (solved with all of it, it
 * rose; with none, it sank).
 */
export function gravityShare(substeps: number): number {
  const n = Math.max(1, substeps);
  return (n + 1) / (2 * n);
}

/** Whether the solver takes a joint this step (one of its bodies simulated and awake). */
function solved({ a, b }: SolverJoint): boolean {
  if (!a.isValid() || !b.isValid()) return false;
  if (!a.isDynamic() && !b.isDynamic()) return false;
  if (a.isSleeping() && b.isSleeping()) return false;
  return a.isEnabled() && b.isEnabled();
}

/**
 * Before a step of `step` seconds (`gravity`: the world's, Havok units/s²; `substeps`:
 * Rapier's for the step): the joints' friction, as changes of their bodies' velocities (Rapier
 * then steps them, with the joints' pivots, limits and contacts).
 */
export function solveJoints(
  joints: Iterable<SolverJoint>,
  step: number,
  gravity: RAPIER.Vector,
  substeps: number,
  settings: SolverSettings = SOLVER_DEFAULTS,
): void {
  const share = gravityShare(substeps);
  const states = new Map<number, BodyState>();
  const stateOf = (body: RAPIER.RigidBody): BodyState => {
    let state = states.get(body.handle);
    if (!state) {
      state = bodyState(body, step, gravity, share);
      states.set(body.handle, state);
    }
    return state;
  };
  const groups: { readonly rows: Row[]; readonly pivot: Pivot | undefined }[] = [];
  for (const joint of joints) {
    if (!solved(joint)) continue;
    const { a: bodyA, b: bodyB, constraint: c } = joint;
    const a = stateOf(bodyA);
    const b = stateOf(bodyB);
    const qa = bodyA.rotation();
    const qb = bodyB.rotation();
    const rows: Row[] = [];
    // Friction about the first body's frame axes (a ragdoll's three, a hinge's axle).
    const limit = c.maxFriction * step;
    if (limit > 0) {
      const twist = rotate(qa, c.a.axes[0]);
      const plane = rotate(qa, c.a.axes[1]);
      const axes = c.type === 'ragdoll' ? [twist, plane, unit(cross(twist, plane))] : [twist];
      for (const n of axes) {
        if (!n) continue;
        const ia = symTimes(a.invInertia, n);
        const ib = symTimes(b.invInertia, n);
        const k = dot(n, ia) + dot(n, ib);
        if (k > 1e-12) rows.push({ a, b, n, ia, ib, mass: 1 / k, limit, impulse: 0 });
      }
    }
    // The pivot: its two points' velocities kept together.
    const pa = rotate(qa, c.a.pivot);
    const pb = rotate(qb, c.b.pivot);
    const oa = bodyA.translation();
    const ob = bodyB.translation();
    const ca = bodyA.worldCom();
    const cb = bodyB.worldCom();
    const ra = v3(oa.x + pa.x - ca.x, oa.y + pa.y - ca.y, oa.z + pa.z - ca.z);
    const rb = v3(ob.x + pb.x - cb.x, ob.y + pb.y - cb.y, ob.z + pb.z - cb.z);
    const k = pivotInverse(a, ra, b, rb);
    groups.push({ rows, pivot: k && { a, b, ra, rb, k } });
  }
  const iterations = Math.max(1, settings.iterations);
  for (let i = 0; i < iterations; i++) {
    for (const { rows, pivot } of groups) {
      if (rows.length === 0) continue;
      for (let sweep = 0; sweep < JOINT_SWEEPS; sweep++) {
        for (const row of rows) solveRow(row);
        if (pivot) solvePivot(pivot);
      }
    }
  }
  for (const { body, dynamic, changed, v, w, gravity: g } of states.values()) {
    if (!dynamic || !changed) continue;
    body.setLinvel({ x: v.x - g.x, y: v.y - g.y, z: v.z - g.z }, false);
    body.setAngvel({ x: w.x, y: w.y, z: w.z }, false);
  }
}

/** Holds a friction axis still, within its bound. */
function solveRow(row: Row): void {
  const { a, b, n } = row;
  const speed = n.x * (b.w.x - a.w.x) + n.y * (b.w.y - a.w.y) + n.z * (b.w.z - a.w.z);
  const before = row.impulse;
  const after = Math.max(-row.limit, Math.min(row.limit, before - row.mass * speed));
  row.impulse = after;
  const impulse = after - before;
  if (impulse === 0) return;
  if (a.dynamic) {
    a.w.x -= row.ia.x * impulse;
    a.w.y -= row.ia.y * impulse;
    a.w.z -= row.ia.z * impulse;
    a.changed = true;
  }
  if (b.dynamic) {
    b.w.x += row.ib.x * impulse;
    b.w.y += row.ib.y * impulse;
    b.w.z += row.ib.z * impulse;
    b.changed = true;
  }
}

/** −[r]× M [r]× for a symmetric M, by rows: entry (i, j) is (r × eᵢ) · M (r × eⱼ). */
function crossInertiaCross(r: V, m: Sym): [V, V, V] {
  const ex = v3(0, r.z, -r.y);
  const ey = v3(-r.z, 0, r.x);
  const ez = v3(r.y, -r.x, 0);
  const mx = symTimes(m, ex);
  const my = symTimes(m, ey);
  const mz = symTimes(m, ez);
  return [
    v3(dot(ex, mx), dot(ex, my), dot(ex, mz)),
    v3(dot(ey, mx), dot(ey, my), dot(ey, mz)),
    v3(dot(ez, mx), dot(ez, my), dot(ez, mz)),
  ];
}

/**
 * The inverse of a pivot's effective mass matrix K = (mA⁻¹ + mB⁻¹) I − [rA]× IA⁻¹ [rA]× −
 * [rB]× IB⁻¹ [rB]×, or undefined (two unmovable bodies).
 */
function pivotInverse(a: BodyState, ra: V, b: BodyState, rb: V): [V, V, V] | undefined {
  const m = a.invMass + b.invMass;
  const ka = crossInertiaCross(ra, a.invInertia);
  const kb = crossInertiaCross(rb, b.invInertia);
  const r0 = v3(m + ka[0].x + kb[0].x, ka[0].y + kb[0].y, ka[0].z + kb[0].z);
  const r1 = v3(ka[1].x + kb[1].x, m + ka[1].y + kb[1].y, ka[1].z + kb[1].z);
  const r2 = v3(ka[2].x + kb[2].x, ka[2].y + kb[2].y, m + ka[2].z + kb[2].z);
  // By cofactors: the inverse's columns are the rows' crosses over the determinant.
  const c0 = cross(r1, r2);
  const c1 = cross(r2, r0);
  const c2 = cross(r0, r1);
  const det = dot(r0, c0);
  if (!(Math.abs(det) > 1e-18)) return undefined;
  const d = 1 / det;
  return [
    v3(c0.x * d, c1.x * d, c2.x * d),
    v3(c0.y * d, c1.y * d, c2.y * d),
    v3(c0.z * d, c1.z * d, c2.z * d),
  ];
}

/** Brings the pivot's two points to one velocity (an impulse at the pivot, both ways). */
function solvePivot({ a, b, ra, rb, k }: Pivot): void {
  const at = cross(a.w, ra);
  const bt = cross(b.w, rb);
  const d = v3(
    b.v.x + bt.x - a.v.x - at.x,
    b.v.y + bt.y - a.v.y - at.y,
    b.v.z + bt.z - a.v.z - at.z,
  );
  const p = v3(-dot(k[0], d), -dot(k[1], d), -dot(k[2], d));
  if (a.dynamic) {
    const t = symTimes(a.invInertia, cross(ra, p));
    a.v.x -= a.invMass * p.x;
    a.v.y -= a.invMass * p.y;
    a.v.z -= a.invMass * p.z;
    a.w.x -= t.x;
    a.w.y -= t.y;
    a.w.z -= t.z;
    a.changed = true;
  }
  if (b.dynamic) {
    const t = symTimes(b.invInertia, cross(rb, p));
    b.v.x += b.invMass * p.x;
    b.v.y += b.invMass * p.y;
    b.v.z += b.invMass * p.z;
    b.w.x += t.x;
    b.w.y += t.y;
    b.w.z += t.z;
    b.changed = true;
  }
}

// --- Soft limits --------------------------------------------------------------------------------

/**
 * The bounds a joint's limit on one axis gets for the next step when its angle `angle` lies past
 * the limit [`min`, `max`]: the limit moves to tau of the way from the angle back to it (Havok
 * corrects a violated limit by tau of its error a step, solved with everything else; Rapier's
 * limits are stiff, so the limit itself is eased), the other side stays. Undefined when the
 * angle lies within the limit (the limit holds as it is).
 */
export function easedLimit(
  angle: number,
  min: number,
  max: number,
  tau: number,
): readonly [number, number] | undefined {
  if (angle < min - EASED_EXCESS) return [angle + tau * (min - angle), max];
  if (angle > max + EASED_EXCESS) return [min, angle - tau * (angle - max)];
  return undefined;
}

/**
 * Angles closer to a limit than this (radians) are left to Rapier's limit as they are: a step's
 * correction of so little is no snap, and joints held at a single angle (the Dwemer spider's,
 * whose limits are a point) lay a hair past it every step, eased for good, and never slept.
 */
const EASED_EXCESS = 0.05;

// --- Solver deactivation ------------------------------------------------------------------------

/**
 * Havok's solver deactivation, observed in the original (its world's solver info, made from
 * the gravity's strength g): a body of the classes low, medium, high and max (the files' solver
 * deactivation, 2 to 5; every race skeleton's bodies are low) that moves slower than `speed` ×
 * g (Havok units a second) and turns slower than that × 0.1 g (radians a second) is slowed by
 * the solver, its velocities multiplied in each of its iterations by 1 − `rate` / `speed` ×
 * 0.016 over the iterations: a slow ragdoll comes to rest instead of creeping. Classes off and
 * invalid (0, 1) are never slowed. TODO(M13): Havok slows a body only while its velocity
 * relative to its neighbours is below a threshold per class too (how it is measured is not
 * known); here every slow body is slowed.
 */
const SOLVER_DEACTIVATION: Readonly<
  Partial<Record<number, { readonly speed: number; readonly rate: number }>>
> = {
  2: { speed: 0.01, rate: 0.08 },
  3: { speed: 0.017, rate: 0.2 },
  4: { speed: 0.02, rate: 0.3 },
  5: { speed: 0.025, rate: 0.4 },
};

/**
 * The factor a body's velocities are multiplied by after a step (Havok's solver deactivation:
 * SOLVER_DEACTIVATION), 1 when it is not slow enough or its class is never slowed. `g`: the
 * gravity's strength (Havok units/s²); `speed`, `turn`: its speed and turn now.
 */
export function slowBodyFactor(
  solverDeactivation: number,
  g: number,
  speed: number,
  turn: number,
  iterations: number,
): number {
  const entry = SOLVER_DEACTIVATION[solverDeactivation];
  if (!entry) return 1;
  const strength = g > 0 ? g : 9.81;
  const threshold = entry.speed * strength;
  if (speed >= threshold || turn >= threshold * 0.1 * strength) return 1;
  const steps = Math.max(1, iterations);
  const factor = 1 - (entry.rate / entry.speed) * (0.016 / steps);
  return Math.max(0, factor) ** steps;
}
