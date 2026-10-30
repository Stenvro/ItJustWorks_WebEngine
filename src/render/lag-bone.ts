// Lag bones (BSLagBoneController, in 108 models: creature tails and antennae, the flame
// atronach's trail, torches' and spells' trailing emitters): a bone that trails its parent's
// motion. Its rule as observed in the original, each update of `dt` seconds:
//
// 1. Where the bone would be: its parent's world transform times its local rotation and scale
//    with its rest translation (the translation it had when the controller started).
// 2. The way from where it was last (its last world position) to there. With a linear velocity
//    above 0 it covers a share of that way: velocity × dt of it; what lies beyond the maximum
//    distance is covered at once (the bone never falls further behind than that), and a way
//    shorter than velocity × dt is covered whole.
// 3. Its new local transform keeps its last world rotation at the new position, under the
//    parent. The translation is taken (velocity above 0); with a linear rotation above 0 the
//    rotation turns from there back toward its rest rotation by rotation × dt (clamped to 0..1).
//
// Platform-independent: matrices are column-major 4x4 with a uniform scale, as the poses'.

import type { LagBoneControllerBlock, NifTransform } from '../formats/nif/types.ts';
import { fromNifTransform } from './math.ts';

/** One lag bone of a skeleton: its node and the controller's values. */
export interface LagBone {
  readonly node: number;
  readonly linearVelocity: number;
  readonly linearRotation: number;
  readonly maximumDistance: number;
}

/** A lag bone from its controller block and the node index of its target. */
export function lagBone(block: LagBoneControllerBlock, node: number): LagBone {
  return {
    node,
    linearVelocity: block.linearVelocity,
    linearRotation: block.linearRotation,
    maximumDistance: block.maximumDistance,
  };
}

type Quat = [number, number, number, number];

/** The rotation of a column-major matrix with uniform scale `scale`, as a unit quaternion. */
function matrixQuat(m: ArrayLike<number>, at: number, scale: number): Quat {
  const s = scale > 1e-8 ? 1 / scale : 1;
  const m00 = (m[at] ?? 0) * s;
  const m10 = (m[at + 1] ?? 0) * s;
  const m20 = (m[at + 2] ?? 0) * s;
  const m01 = (m[at + 4] ?? 0) * s;
  const m11 = (m[at + 5] ?? 0) * s;
  const m21 = (m[at + 6] ?? 0) * s;
  const m02 = (m[at + 8] ?? 0) * s;
  const m12 = (m[at + 9] ?? 0) * s;
  const m22 = (m[at + 10] ?? 0) * s;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const r = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / r, (m02 - m20) / r, (m10 - m01) / r, r / 4];
  } else if (m00 > m11 && m00 > m22) {
    const r = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [r / 4, (m01 + m10) / r, (m02 + m20) / r, (m21 - m12) / r];
  } else if (m11 > m22) {
    const r = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / r, r / 4, (m12 + m21) / r, (m02 - m20) / r];
  } else {
    const r = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / r, (m12 + m21) / r, r / 4, (m10 - m01) / r];
  }
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Spherical interpolation from `a` to `b` by `t`. */
function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa = 1 - t;
  let wb = t;
  if (cos < 0.9995) {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / sin;
    wb = Math.sin(t * angle) / sin;
  }
  const q: Quat = [
    a[0] * wa + bx * wb,
    a[1] * wa + by * wb,
    a[2] * wa + bz * wb,
    a[3] * wa + bw * wb,
  ];
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Writes a rotation (unit quaternion) times a uniform scale into a matrix's upper 3x3. */
function writeRotation(q: Quat, scale: number, out: Float32Array): void {
  const [x, y, z, w] = q;
  out[0] = (1 - 2 * (y * y + z * z)) * scale;
  out[1] = 2 * (x * y + z * w) * scale;
  out[2] = 2 * (x * z - y * w) * scale;
  out[4] = 2 * (x * y - z * w) * scale;
  out[5] = (1 - 2 * (x * x + z * z)) * scale;
  out[6] = 2 * (y * z + x * w) * scale;
  out[8] = 2 * (x * z + y * w) * scale;
  out[9] = 2 * (y * z - x * w) * scale;
  out[10] = (1 - 2 * (x * x + y * y)) * scale;
}

const columnScale = (m: ArrayLike<number>, at: number): number =>
  Math.hypot(m[at] ?? 0, m[at + 1] ?? 0, m[at + 2] ?? 0);

/** out = a × b (column-major 4x4). */
function multiply(
  a: ArrayLike<number>,
  aAt: number,
  b: ArrayLike<number>,
  bAt: number,
  out: Float32Array,
): void {
  for (let col = 0; col < 4; col++) {
    const b0 = b[bAt + col * 4] ?? 0;
    const b1 = b[bAt + col * 4 + 1] ?? 0;
    const b2 = b[bAt + col * 4 + 2] ?? 0;
    const b3 = b[bAt + col * 4 + 3] ?? 0;
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        (a[aAt + row] ?? 0) * b0 +
        (a[aAt + 4 + row] ?? 0) * b1 +
        (a[aAt + 8 + row] ?? 0) * b2 +
        (a[aAt + 12 + row] ?? 0) * b3;
    }
  }
}

/** The inverse of a rotation, uniform scale and translation (column-major). */
function invertRigid(m: ArrayLike<number>, at: number, out: Float32Array): void {
  const scale = columnScale(m, at);
  const k = scale > 1e-8 ? 1 / (scale * scale) : 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = (m[at + row * 4 + col] ?? 0) * k;
  }
  const tx = m[at + 12] ?? 0;
  const ty = m[at + 13] ?? 0;
  const tz = m[at + 14] ?? 0;
  for (let row = 0; row < 3; row++) {
    out[12 + row] = -((out[row] ?? 0) * tx + (out[4 + row] ?? 0) * ty + (out[8 + row] ?? 0) * tz);
  }
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;
}

/** The state of one skeleton's lag bones: where each was last, and its rest transform. */
export class LagBoneState {
  readonly bones: ReadonlyMap<number, LagBone>;
  readonly #rest = new Map<number, { readonly rotation: Quat; readonly translation: number[] }>();
  readonly #last = new Map<number, Float32Array>();
  readonly #wanted = new Float32Array(16);
  readonly #inverse = new Float32Array(16);
  readonly #moved = new Float32Array(16);

  /** `rest`: the skeleton's local transforms (16 floats per node), the bones' rest. */
  constructor(bones: readonly LagBone[], rest: Float32Array) {
    this.bones = new Map(bones.map((bone) => [bone.node, bone]));
    for (const bone of bones) {
      const at = bone.node * 16;
      this.#rest.set(bone.node, {
        rotation: matrixQuat(rest, at, columnScale(rest, at)),
        translation: [rest[at + 12] ?? 0, rest[at + 13] ?? 0, rest[at + 14] ?? 0],
      });
    }
  }

  /** Forgets where the bones were (a teleport): the next update places them at rest. */
  reset(): void {
    this.#last.clear();
  }

  /**
   * The local transform of lag bone `node` this update (written to `out` and returned; `out` may
   * be `local` itself), from its parent's world transform and its local transform as animated
   * (`local` at `localAt`); `dt` seconds since the last update. Any other node: its local
   * transform as it is.
   */
  solve(
    node: number,
    parentWorld: ArrayLike<number>,
    parentAt: number,
    local: ArrayLike<number>,
    localAt: number,
    dt: number,
    out: Float32Array,
  ): Float32Array {
    const bone = this.bones.get(node);
    const rest = this.#rest.get(node);
    const animated = [local[localAt + 12] ?? 0, local[localAt + 13] ?? 0, local[localAt + 14] ?? 0];
    const scale = columnScale(local, localAt);
    for (let i = 0; i < 16; i++) out[i] = local[localAt + i] ?? 0;
    if (!bone || !rest) return out;
    // 1. Where it would be: its rotation and scale at its rest translation.
    out[12] = rest.translation[0] ?? 0;
    out[13] = rest.translation[1] ?? 0;
    out[14] = rest.translation[2] ?? 0;
    const wanted = this.#wanted;
    multiply(parentWorld, parentAt, out, 0, wanted);
    let last = this.#last.get(node);
    if (!last) {
      last = wanted.slice();
      this.#last.set(node, last);
      return out;
    }
    // 2. The share of the way it covers.
    let dx = (wanted[12] ?? 0) - (last[12] ?? 0);
    let dy = (wanted[13] ?? 0) - (last[13] ?? 0);
    let dz = (wanted[14] ?? 0) - (last[14] ?? 0);
    const velocity = bone.linearVelocity;
    if (velocity > 0 && dt > 0) {
      const step = velocity * dt;
      const squared = dx * dx + dy * dy + dz * dz;
      if (step * step <= squared) {
        const maximum = bone.maximumDistance;
        if (squared <= maximum * maximum) {
          dx *= step;
          dy *= step;
          dz *= step;
        } else {
          const length = Math.sqrt(squared);
          const beyond = (length - maximum) / length;
          const bx = dx * beyond;
          const by = dy * beyond;
          const bz = dz * beyond;
          dx = (dx - bx) * step + bx;
          dy = (dy - by) * step + by;
          dz = (dz - bz) * step + bz;
        }
      }
    } else {
      dx = 0;
      dy = 0;
      dz = 0;
    }
    // 3. Its last world rotation at the new position, under the parent.
    const moved = this.#moved;
    moved.set(last);
    moved[12] = (last[12] ?? 0) + dx;
    moved[13] = (last[13] ?? 0) + dy;
    moved[14] = (last[14] ?? 0) + dz;
    invertRigid(parentWorld, parentAt, this.#inverse);
    multiply(this.#inverse, 0, moved, 0, wanted);
    if (velocity > 0) {
      out[12] = wanted[12] ?? 0;
      out[13] = wanted[13] ?? 0;
      out[14] = wanted[14] ?? 0;
    } else {
      out[12] = animated[0] ?? 0;
      out[13] = animated[1] ?? 0;
      out[14] = animated[2] ?? 0;
    }
    if (bone.linearRotation > 0) {
      const t = Math.min(1, Math.max(0, dt * bone.linearRotation));
      const kept = matrixQuat(wanted, 0, columnScale(wanted, 0));
      writeRotation(slerp(kept, rest.rotation, t), scale, out);
    }
    multiply(parentWorld, parentAt, out, 0, last);
    return out;
  }
}

/** A model's scene graph as its animation keeps it (animation.ts ModelAnimation). */
export interface LagBoneGraph {
  /** The model's lag bones, by the block of the node each moves. */
  readonly lagBones?: readonly LagBone[];
  readonly parents: ReadonlyMap<number, number>;
  readonly transforms: ReadonlyMap<number, NifTransform>;
  readonly roots: readonly number[];
}

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The lag bones of one placed instance of a model (an effect model, a torch, a worn piece: the
 * scene renderer keeps one per instance, as each trails its own motion). `update` gives the
 * frame's model-space node matrices with the lag bones trailing in world space and the nodes
 * under them following.
 */
export class ModelLagBones {
  readonly #graph: LagBoneGraph;
  readonly #bones: readonly LagBone[];
  readonly #state: LagBoneState;
  #lastSeconds: number | undefined;
  #seconds: number | undefined;
  #worlds: ReadonlyMap<number, Float32Array> = new Map();
  readonly #parentWorld = new Float32Array(16);
  readonly #local = new Float32Array(16);
  readonly #inverse = new Float32Array(16);

  constructor(graph: LagBoneGraph) {
    this.#graph = graph;
    // Parents before children: a lag bone under another trails the other's trailed place.
    const depth = (node: number): number => {
      let d = 0;
      for (let r = graph.parents.get(node); r !== undefined; r = graph.parents.get(r)) d++;
      return d;
    };
    this.#bones = [...(graph.lagBones ?? [])].sort((a, b) => depth(a.node) - depth(b.node));
    const rest = new Float32Array(this.#bones.length * 16);
    this.#bones.forEach((bone, i) => {
      rest.set(this.#restLocal(bone.node), i * 16);
    });
    this.#state = new LagBoneState(
      this.#bones.map((bone, i) => ({ ...bone, node: i })),
      rest,
    );
  }

  /** Forgets where the bones were (a teleport). */
  reset(): void {
    this.#state.reset();
    this.#lastSeconds = undefined;
  }

  /**
   * The model-space matrices of this frame (`seconds`): the animated ones (`animated`, from the
   * model's controllers; the others at rest), with the lag bones and everything under them
   * trailing as the instance moves (`instanceWorld`). Solved once per frame; later calls in
   * the same frame return the same matrices.
   */
  update(
    animated: ReadonlyMap<number, ArrayLike<number>> | undefined,
    instanceWorld: ArrayLike<number>,
    seconds: number,
  ): ReadonlyMap<number, Float32Array> {
    if (this.#seconds === seconds) return this.#worlds;
    this.#seconds = seconds;
    const dt = this.#lastSeconds === undefined ? 0 : Math.max(0, seconds - this.#lastSeconds);
    this.#lastSeconds = seconds;
    const graph = this.#graph;
    // As for every model, a root's own transform is not used.
    const roots = new Set(graph.roots.filter((root) => graph.parents.get(root) === undefined));
    const original = new Map<number, Float32Array>();
    const originalOf = (ref: number): Float32Array => {
      const known = original.get(ref);
      if (known) return known;
      const world = new Float32Array(16);
      const moved = animated?.get(ref);
      const parent = graph.parents.get(ref);
      if (moved) {
        for (let i = 0; i < 16; i++) world[i] = moved[i] ?? 0;
      } else if (parent === undefined) {
        world.set(roots.has(ref) ? IDENTITY : this.#restLocal(ref));
      } else {
        multiply(originalOf(parent), 0, this.#restLocal(ref), 0, world);
      }
      original.set(ref, world);
      return world;
    };
    // A node's transform under its parent this frame (as animated, or at rest).
    const localOf = (ref: number, out: Float32Array): Float32Array => {
      const parent = graph.parents.get(ref);
      if (parent === undefined) {
        out.set(originalOf(ref));
        return out;
      }
      invertRigid(originalOf(parent), 0, this.#inverse);
      multiply(this.#inverse, 0, originalOf(ref), 0, out);
      return out;
    };
    const lagged = new Map<number, Float32Array>();
    const worldOf = (ref: number): Float32Array => {
      const known = lagged.get(ref);
      if (known) return known;
      const parent = graph.parents.get(ref);
      if (parent === undefined) return originalOf(ref);
      const above = worldOf(parent);
      if (above === originalOf(parent)) return originalOf(ref);
      const world = new Float32Array(16);
      multiply(above, 0, localOf(ref, this.#local), 0, world);
      lagged.set(ref, world);
      return world;
    };
    this.#bones.forEach((bone, i) => {
      const parent = graph.parents.get(bone.node);
      if (parent === undefined) return;
      const parentModel = worldOf(parent);
      multiply(instanceWorld, 0, parentModel, 0, this.#parentWorld);
      const local = localOf(bone.node, this.#local);
      this.#state.solve(i, this.#parentWorld, 0, local, 0, dt, local);
      const world = new Float32Array(16);
      multiply(parentModel, 0, local, 0, world);
      lagged.set(bone.node, world);
    });
    const worlds = new Map<number, Float32Array>();
    for (const [ref, world] of animated ?? []) worlds.set(ref, Float32Array.from(world));
    for (const ref of graph.transforms.keys()) {
      const world = worldOf(ref);
      if (world !== originalOf(ref)) worlds.set(ref, world);
    }
    this.#worlds = worlds;
    return worlds;
  }

  /** A node's rest transform under its parent. */
  #restLocal(ref: number): Float32Array {
    const transform = this.#graph.transforms.get(ref);
    return transform
      ? fromNifTransform(transform.translation, transform.rotation, transform.scale)
      : IDENTITY;
  }
}
