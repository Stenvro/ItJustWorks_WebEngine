// The impulses a group of joints (balls and sockets, a chain's links, hinges) takes in a step:
// what Havok's solver results tell a breakable constraint (docs/physics.md, "Breakable"). Rapier
// does not expose its joints' impulses, and a body's own change of momentum only tells the sum of
// all that holds it: the mace trap's mace hangs by its pin and by its chain, and the chain's
// pull, which the pin holds against, cancelled out of it (the pin seemed to carry the mace's
// weight alone and never broke).
//
// The solve (groupImpulses) is Havok's: the step's iterations, in each one every constraint in
// turn (Gauss-Seidel), a ball and socket's three linear rows and a hinge's two angular rows
// together, a chain's links all at once (hkpBallSocketChainData is solved directly, as one). A
// constraint's impulse in an iteration takes `damping` of the way from its pivots' relative
// velocity to the one that closes `tau` of their error in the step, with its virtual mass scaled
// by its strength (a malleable constraint's) and its constraint force mixing on the diagonal (a
// chain's softness). The step's solver results are the impulses summed over its iterations.
// The velocities solved are the bodies' before the step, gravity's speed of the step added.
// TODO(M13): inferred from Havok's documented solver (hkpSolverInfo's tau and damping,
// hkpMalleableConstraintData's strength as the virtual mass factor); contacts are not solved here.
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

/** A joint as Havok's solver takes it in a group (groupImpulses). */
export interface GroupJoint extends PointJoint {
  /** The share of the pivots' error closed in the step (Havok's tau). */
  readonly tau: number;
  /** The share of the way to that velocity an iteration's impulse takes (Havok's damping). */
  readonly damping: number;
  /** The pivots' error: pivot B − pivot A (world, Havok units); none: 0. */
  readonly error?: Vec3;
  /**
   * World axes about which the bodies' relative turn is held (a hinge's: the two across its
   * axle), each with the turn's error about it (radians).
   */
  readonly angular?: readonly (readonly [Vec3, number])[];
  /** Constraint force mixing: added to the diagonal of its rows (a chain's softness). */
  readonly softness?: number;
  /** Its virtual mass factor (a malleable constraint's strength; 1: none). */
  readonly strength?: number;
  /** Joints with the same block are solved as one (a chain's links); none: on its own. */
  readonly block?: number;
}

/** A joint's solver results over the step: its linear rows' impulses and its angular rows'. */
export interface JointResult {
  /** Havok units, kg·m/s (world). */
  readonly linear: Vec3;
  /** Havok units, kg·m²/s, one per `angular` axis. */
  readonly angular: readonly number[];
  /**
   * What the iterations leave of its rows' velocities (Havok units a second; radians a second
   * about its angular axes): its pivots' error grows by them over the step.
   */
  readonly left: { readonly linear: Vec3; readonly angular: readonly number[] };
}

/**
 * What a breakable constraint weighs against its threshold: the root of the sum of the squares of
 * its solver results (every row of the constraint it wraps, linear and angular).
 */
export function solverResultSize({ linear, angular }: JointResult): number {
  let sum = linear[0] * linear[0] + linear[1] * linear[1] + linear[2] * linear[2];
  for (const x of angular) sum += x * x;
  return Math.sqrt(sum);
}

type M3 = [number, number, number, number, number, number, number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sym(i: ImpulseBody['invInertia']): M3 {
  return [i[0], i[1], i[2], i[1], i[3], i[4], i[2], i[4], i[5]];
}

function times(m: M3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function moves(body: ImpulseBody): boolean {
  return body.invMass > 0 || body.invInertia.some((x) => x !== 0);
}

/** A body's velocities while the solve runs. */
interface Moving {
  readonly invMass: number;
  readonly invInertia: M3;
  readonly v: [number, number, number];
  readonly w: [number, number, number];
}

/**
 * One row of a joint (Havok's Jacobian): its velocity is lin · (vB + ωB × rb − vA − ωA × ra) for
 * a linear row along `lin`, ang · (ωB − ωA) for an angular one about `ang`.
 */
interface Row {
  readonly a: number;
  readonly b: number;
  /** The row's linear and angular parts on body A and on body B. */
  readonly linA: Vec3;
  readonly angA: Vec3;
  readonly linB: Vec3;
  readonly angB: Vec3;
  /** The velocity it drives toward (−tau × its error over the step). */
  readonly target: number;
  readonly damping: number;
  readonly strength: number;
  readonly softness: number;
}

const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const NONE: Vec3 = [0, 0, 0];

/** A joint's rows: three linear, then one per angular axis. */
function rowsOf(joint: GroupJoint, step: number): Row[] {
  const common = {
    a: joint.a,
    b: joint.b,
    damping: joint.damping,
    strength: joint.strength ?? 1,
    softness: joint.softness ?? 0,
  };
  const error = joint.error ?? NONE;
  const rows: Row[] = AXES.map((e) => ({
    ...common,
    linA: [-e[0], -e[1], -e[2]],
    angA: cross(e, joint.ra),
    linB: e,
    angB: cross(joint.rb, e),
    target: (-joint.tau * dot(error, e)) / step,
  }));
  for (const [n, angle] of joint.angular ?? []) {
    rows.push({
      ...common,
      linA: NONE,
      angA: [-n[0], -n[1], -n[2]],
      linB: NONE,
      angB: n,
      target: (-joint.tau * angle) / step,
    });
  }
  return rows;
}

/** A row's velocity now. */
function rowVelocity(row: Row, bodies: readonly Moving[]): number {
  const a = bodies[row.a];
  const b = bodies[row.b];
  if (!a || !b) return 0;
  return dot(row.linA, a.v) + dot(row.angA, a.w) + dot(row.linB, b.v) + dot(row.angB, b.w);
}

/** An impulse λ along a row, on its two bodies. */
function applyRow(row: Row, lambda: number, bodies: readonly Moving[]): void {
  for (const [index, lin, ang] of [
    [row.a, row.linA, row.angA],
    [row.b, row.linB, row.angB],
  ] as const) {
    const body = bodies[index];
    if (!body) continue;
    const dw = times(body.invInertia, ang);
    for (let i = 0; i < 3; i++) {
      body.v[i] = (body.v[i] ?? 0) + lambda * body.invMass * (lin[i] ?? 0);
      body.w[i] = (body.w[i] ?? 0) + lambda * (dw[i] ?? 0);
    }
  }
}

/** The effect of a unit impulse along row `k` on the velocity of row `j`. */
function coupling(j: Row, k: Row, bodies: readonly Moving[], still: readonly boolean[]): number {
  let sum = 0;
  for (const [index, lin, ang] of [
    [j.a, j.linA, j.angA],
    [j.b, j.linB, j.angB],
  ] as const) {
    const body = bodies[index];
    if (!body || still[index]) continue;
    for (const [other, olin, oang] of [
      [k.a, k.linA, k.angA],
      [k.b, k.linB, k.angB],
    ] as const) {
      if (other !== index) continue;
      sum += body.invMass * dot(lin, olin) + dot(ang, times(body.invInertia, oang));
    }
  }
  return sum;
}

/**
 * Solves a block of rows as one: the impulses that take each row `damping` of the way to its
 * target, its virtual mass × strength. Rows whose two bodies nothing moves take none; rows that
 * hold the same motion twice share it (a small regularization). Returns the impulses (applied).
 */
function solveBlock(rows: readonly Row[], bodies: readonly Moving[], still: readonly boolean[]) {
  const n = rows.length;
  const k = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 0; c < n; c++) {
      const other = rows[c];
      if (other) k[r * n + c] = coupling(row, other, bodies, still);
    }
  }
  let trace = 0;
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    const diagonal = k[r * n + r] ?? 0;
    if (!row || !(diagonal > 0)) {
      // Nothing moves it: no impulse.
      for (let c = 0; c < n; c++) {
        k[r * n + c] = 0;
        k[c * n + r] = 0;
      }
      k[r * n + r] = 1;
      rhs[r] = 0;
      continue;
    }
    trace += diagonal;
    k[r * n + r] = diagonal + row.softness;
    rhs[r] = row.damping * row.strength * (row.target - rowVelocity(row, bodies));
  }
  // A little on the diagonal: rows that hold the same motion twice leave K singular.
  const epsilon = (trace / Math.max(1, n)) * 1e-9 + 1e-12;
  for (let i = 0; i < n; i++) k[i * n + i] = (k[i * n + i] ?? 0) + epsilon;
  const lambda = solve(k, rhs, n);
  rows.forEach((row, i) => {
    applyRow(row, lambda[i] ?? 0, bodies);
  });
  return lambda;
}

/**
 * Havok's solve of a group of joints over a step of `step` seconds in `iterations`: each joint's
 * solver results (its impulses summed over the iterations), in the joints' order. The joints are
 * solved in their order (a block where its first joint stands).
 */
export function groupImpulses(
  bodies: readonly ImpulseBody[],
  joints: readonly GroupJoint[],
  solver: { readonly step: number; readonly iterations: number },
): JointResult[] {
  const moving: Moving[] = bodies.map((body) => ({
    invMass: body.invMass,
    invInertia: sym(body.invInertia),
    v: [body.linear[0], body.linear[1], body.linear[2]],
    w: [body.angular[0], body.angular[1], body.angular[2]],
  }));
  const still = bodies.map((body) => !moves(body));
  const step = solver.step > 0 ? solver.step : 1;
  const rows = joints.map((joint) => rowsOf(joint, step));
  const sums = rows.map((list) => new Float64Array(list.length));
  // The blocks in order: a chain's links together, the others each on its own.
  const blocks: number[][] = [];
  const byBlock = new Map<number, number[]>();
  joints.forEach((joint, i) => {
    if (joint.block === undefined) {
      blocks.push([i]);
      return;
    }
    const known = byBlock.get(joint.block);
    if (known) {
      known.push(i);
      return;
    }
    const block = [i];
    byBlock.set(joint.block, block);
    blocks.push(block);
  });
  for (let iteration = 0; iteration < Math.max(1, solver.iterations); iteration++) {
    for (const block of blocks) {
      const blockRows = block.flatMap((i) => rows[i] ?? []);
      const lambda = solveBlock(blockRows, moving, still);
      let at = 0;
      for (const i of block) {
        const sum = sums[i];
        if (!sum) continue;
        for (let r = 0; r < sum.length; r++) sum[r] = (sum[r] ?? 0) + (lambda[at++] ?? 0);
      }
    }
  }
  return sums.map((sum, i) => {
    const left = (rows[i] ?? []).map((row) => rowVelocity(row, moving));
    return {
      linear: [sum[0] ?? 0, sum[1] ?? 0, sum[2] ?? 0],
      angular: [...sum.subarray(3)],
      left: { linear: [left[0] ?? 0, left[1] ?? 0, left[2] ?? 0], angular: left.slice(3) },
    };
  });
}

/**
 * The impulse each point joint takes for its pivots to move as one (Havok units, kg·m/s), in the
 * joints' order, all solved together and exactly (one block, no position correction): what a
 * solver converges to. Joints between two bodies that nothing moves take none. A group with
 * joints that hold the same motion twice gets the least of the impulses that do it (a small
 * regularization).
 */
export function jointImpulses(
  bodies: readonly ImpulseBody[],
  joints: readonly PointJoint[],
): Vec3[] {
  return groupImpulses(
    bodies,
    joints.map((joint) => ({ ...joint, tau: 0, damping: 1, block: 0 })),
    { step: 1, iterations: 1 },
  ).map(({ linear }) => linear);
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
