// Procedural animation: what the behavior graphs' procedural modifiers do to the pose the clips
// gave (src/animation/behavior-runtime.ts runs them where the graph has them). Look-at turns a
// chain of bones and the eyes towards a target (BSLookAtModifier), direct-at aims a chain
// (BSDirectAtModifier), twist turns a chain about an axis (hkbTwistModifier), foot IK sets the
// feet on the ground found by rays and lowers the body to reach it (hkbFootIkDriver with
// hkbFootIkControlsModifier, hkbFootIkModifier). Members and their meaning: the Havok 2010.2
// class headers (Project Anarchy) and CommonLibSSE's BSLookAtModifier; the rules the engine
// does not document are marked. Model space: x right, y forward, z up, game units.
// Notes: docs/animation.md ("Procedural modifiers"). Platform-independent.

import { TRANSFORM_FLOATS } from '../formats/hkx/animation.ts';
import type { FootIkLeg, FootIkSetup } from '../formats/hkx/behavior.ts';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
type ReadonlyVec3 = readonly [number, number, number];

// --- Vectors and quaternions ---------------------------------------------------------------

const EPSILON = 1e-6;
const DEGREES = Math.PI / 180;

function dot(a: ReadonlyVec3, b: ReadonlyVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: ReadonlyVec3, b: ReadonlyVec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function length(v: ReadonlyVec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** v made unit length (undefined if it is too short to have a direction). */
export function normalize(v: ReadonlyVec3): Vec3 | undefined {
  const l = length(v);
  return l > EPSILON ? [v[0] / l, v[1] / l, v[2] / l] : undefined;
}

/** a · b: b's turn first, then a's (Havok's hkQuaternion product). */
export function quatMultiply(a: readonly number[], b: readonly number[]): Quat {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a;
  const [bx = 0, by = 0, bz = 0, bw = 1] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: readonly number[]): Quat {
  return [-(q[0] ?? 0), -(q[1] ?? 0), -(q[2] ?? 0), q[3] ?? 1];
}

/** v turned by q. */
export function quatRotate(q: readonly number[], v: ReadonlyVec3): Vec3 {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** The turn by `angle` radians about a unit axis. */
export function quatFromAxisAngle(axis: ReadonlyVec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** The shortest turn taking unit vector `from` to unit vector `to`. */
export function quatFromTo(from: ReadonlyVec3, to: ReadonlyVec3): Quat {
  const d = dot(from, to);
  if (d < -1 + 1e-7) {
    // Opposite: half a turn about any axis at right angles to `from`.
    const axis = normalize(cross([1, 0, 0], from)) ??
      normalize(cross([0, 1, 0], from)) ?? [0, 0, 1];
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(from, to);
  const q: Quat = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** The angle (radians) between two unit vectors. */
function angleBetween(a: ReadonlyVec3, b: ReadonlyVec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
}

/** `from` turned towards `to` (unit vectors) by `angle` radians at most. */
function turnTowards(from: ReadonlyVec3, to: ReadonlyVec3, angle: number): Vec3 {
  const between = angleBetween(from, to);
  if (between <= angle) return [to[0], to[1], to[2]];
  const axis = normalize(cross(from, to)) ?? normalize(cross([0, 0, 1], from)) ?? [1, 0, 0];
  return quatRotate(quatFromAxisAngle(axis, angle), from);
}

/**
 * How much of the way a gain moves something in `dt` seconds. Havok's gains are fractions per
 * step; the graphs were made at the Behavior Tool's 30 steps a second, so a gain g takes
 * 1 − (1 − g)^(30 dt) of the way in dt (frame-rate independent). TODO(M13): Bethesda's own
 * time step for the gains is not documented.
 */
export function gainStep(gain: number, dt: number): number {
  const g = Math.min(1, Math.max(0, gain));
  if (g >= 1) return 1;
  if (dt <= 0) return 0;
  return 1 - Math.pow(1 - g, dt * 30);
}

// --- Model space ---------------------------------------------------------------------------

/**
 * A pose's bones in model space (rotation, position, uniform scale), kept in step with the
 * bone-local pose it was made from as procedural modifiers turn bones.
 */
export class ModelSpace {
  readonly parents: Int16Array;
  readonly rotations: Float32Array;
  readonly positions: Float32Array;
  readonly scales: Float32Array;
  /** Each bone and the bones below it, parents first (made when first asked for). */
  readonly #subtrees: (Int16Array | undefined)[];
  /** The bones without a parent. */
  readonly #roots: number[] = [];

  constructor(parents: Int16Array) {
    this.parents = parents;
    const count = parents.length;
    this.rotations = new Float32Array(count * 4);
    this.positions = new Float32Array(count * 3);
    this.scales = new Float32Array(count);
    this.#subtrees = new Array<Int16Array | undefined>(count);
    parents.forEach((parent, bone) => {
      if (parent < 0 || parent >= count) this.#roots.push(bone);
    });
  }

  get count(): number {
    return this.parents.length;
  }

  /** Places every bone from the bone-local pose. */
  update(local: Float32Array): void {
    for (const root of this.#roots) this.#place(local, root);
  }

  /** A bone and the bones below it, parents before children. */
  #subtree(bone: number): Int16Array {
    let subtree = this.#subtrees[bone];
    if (subtree) return subtree;
    const below: number[] = [bone];
    for (let i = 0; i < below.length && below.length < this.parents.length + 1; i++) {
      const at = below[i] ?? -1;
      this.parents.forEach((parent, child) => {
        if (parent === at && child !== at) below.push(child);
      });
    }
    subtree = Int16Array.from(below);
    this.#subtrees[bone] = subtree;
    return subtree;
  }

  rotation(bone: number): Quat {
    const r = this.rotations;
    const o = bone * 4;
    return [r[o] ?? 0, r[o + 1] ?? 0, r[o + 2] ?? 0, r[o + 3] ?? 1];
  }

  position(bone: number): Vec3 {
    const p = this.positions;
    const o = bone * 3;
    return [p[o] ?? 0, p[o + 1] ?? 0, p[o + 2] ?? 0];
  }

  /**
   * Gives a bone a rotation in model space: its local rotation in `local` is written and the
   * bones below it are placed again.
   */
  setRotation(bone: number, rotation: readonly number[], local: Float32Array): void {
    const parent = this.parents[bone] ?? -1;
    const q =
      parent >= 0 ? quatMultiply(quatConjugate(this.rotation(parent)), rotation) : [...rotation];
    const l = Math.hypot(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1) || 1;
    const o = bone * TRANSFORM_FLOATS;
    for (let k = 0; k < 4; k++) local[o + 3 + k] = (q[k] ?? 0) / l;
    this.#place(local, bone);
  }

  /** Moves a root bone by `offset` in model space (its local translation is its model one). */
  translateRoot(bone: number, offset: ReadonlyVec3, local: Float32Array): void {
    const o = bone * TRANSFORM_FLOATS;
    for (let k = 0; k < 3; k++) local[o + k] = (local[o + k] ?? 0) + (offset[k] ?? 0);
    this.#place(local, bone);
  }

  /** Places a bone and the bones below it (model = parent · local, hkQsTransform's product). */
  #place(local: Float32Array, from: number): void {
    const { parents, rotations: r, positions: p, scales } = this;
    for (const bone of this.#subtree(from)) {
      const o = bone * TRANSFORM_FLOATS;
      const lx = local[o + 3] ?? 0;
      const ly = local[o + 4] ?? 0;
      const lz = local[o + 5] ?? 0;
      const lw = local[o + 6] ?? 1;
      const tx = local[o] ?? 0;
      const ty = local[o + 1] ?? 0;
      const tz = local[o + 2] ?? 0;
      const ls = local[o + 7] ?? 1;
      const parent = parents[bone] ?? -1;
      const q = bone * 4;
      const t = bone * 3;
      if (parent < 0) {
        r[q] = lx;
        r[q + 1] = ly;
        r[q + 2] = lz;
        r[q + 3] = lw;
        p[t] = tx;
        p[t + 1] = ty;
        p[t + 2] = tz;
        scales[bone] = ls;
        continue;
      }
      const pq = parent * 4;
      const x = r[pq] ?? 0;
      const y = r[pq + 1] ?? 0;
      const z = r[pq + 2] ?? 0;
      const w = r[pq + 3] ?? 1;
      const ps = scales[parent] ?? 1;
      // The parent's turn of the scaled local translation.
      const vx = tx * ps;
      const vy = ty * ps;
      const vz = tz * ps;
      const cx = 2 * (y * vz - z * vy);
      const cy = 2 * (z * vx - x * vz);
      const cz = 2 * (x * vy - y * vx);
      const pt = parent * 3;
      p[t] = (p[pt] ?? 0) + vx + w * cx + (y * cz - z * cy);
      p[t + 1] = (p[pt + 1] ?? 0) + vy + w * cy + (z * cx - x * cz);
      p[t + 2] = (p[pt + 2] ?? 0) + vz + w * cz + (x * cy - y * cx);
      r[q] = w * lx + x * lw + y * lz - z * ly;
      r[q + 1] = w * ly - x * lz + y * lw + z * lx;
      r[q + 2] = w * lz + x * ly - y * lx + z * lw;
      r[q + 3] = w * lw - x * lx - y * ly - z * lz;
      scales[bone] = ps * ls;
    }
  }

  /** The bones from `start` down to `end` through the parents (just `start` if not above it). */
  chain(start: number, end: number): number[] {
    const chain: number[] = [];
    for (let bone = end; bone >= 0 && chain.length < 64; bone = this.parents[bone] ?? -1) {
      chain.push(bone);
      if (bone === start) return chain.reverse();
    }
    return start >= 0 && start < this.count ? [start] : [];
  }

  /** The root above a bone (the bone itself if it has no parent). */
  root(bone: number): number {
    let at = bone;
    for (let depth = 0; depth < 64; depth++) {
      const parent = this.parents[at] ?? -1;
      if (parent < 0) return at;
      at = parent;
    }
    return at;
  }
}

// --- Look-at (BSLookAtModifier) -----------------------------------------------------------

/** A bone of a look-at with its values now (angles in radians). */
export interface LookAtBoneValues {
  readonly index: number;
  readonly forwardAxis: ReadonlyVec3;
  readonly limit: number;
  readonly onGain: number;
  readonly offGain: number;
  readonly enabled: boolean;
}

export interface LookAtValues {
  readonly bones: readonly LookAtBoneValues[];
  readonly eyeBones: readonly LookAtBoneValues[];
  /** Beyond this angle from the character's forward (radians) the target is outside. */
  readonly limit: number;
  /** Back inside only this much within the limit (radians). */
  readonly threshold: number;
  readonly continueOutsideLimit: boolean;
  readonly onGain: number;
  readonly offGain: number;
  readonly useBoneGains: boolean;
}

/** What a look-at keeps from step to step: each bone's look in its own space. */
export interface LookAtState {
  /** Per bone, then per eye bone: the forward it looks along now, in the bone's space. */
  forwards: Float32Array;
  /** The target is outside the limits. */
  outside: boolean;
}

export function lookAtState(values: LookAtValues): LookAtState {
  const bones = [...values.bones, ...values.eyeBones];
  const forwards = new Float32Array(bones.length * 3);
  bones.forEach((bone, i) => {
    forwards.set(normalize(bone.forwardAxis) ?? [0, 1, 0], i * 3);
  });
  return { forwards, outside: false };
}

/** What a look-at did: whether the target is outside, and where the eyes look. */
export interface LookAtResult {
  readonly outside: boolean;
  /** The target just went outside the limits (targetOutOfLimitEvent). */
  readonly wentOutside: boolean;
  /** The eyes' turn from their animated forward: heading (right +) and pitch (up +), radians. */
  readonly eyes: { readonly heading: number; readonly pitch: number } | undefined;
}

/**
 * BSLookAtModifier: each bone in order (spine, neck, head) turns its forward axis towards the
 * target, as far as its own limit (each bone's turn is taken from the pose the bones before it
 * left, so the chain shares the look); the eyes after them. A bone's look eases towards where it
 * should be by its gains (on while looking, off on the way back to the animation's): onGain and
 * offGain of the bone (useBoneGains) or of the modifier. The target is outside the limits when
 * the way from the last bone to it lies more than the limit angle from the character's forward,
 * inside again once it is the threshold within it; outside, the bones look only if
 * continueOutsideLimit. `advance`: the eased looks move (once a step; a modifier generated twice
 * in one step lays the same turn again).
 */
export function lookAt(
  values: LookAtValues,
  state: LookAtState,
  local: Float32Array,
  space: ModelSpace,
  target: ReadonlyVec3 | undefined,
  on: boolean,
  dt: number,
  advance: boolean,
): LookAtResult {
  const bones = values.bones;
  // Inside or outside the limits, seen from the last bone of the chain (the head).
  let wentOutside = false;
  const last = bones.at(-1) ?? values.eyeBones[0];
  if (target && last && advance) {
    const from = space.position(last.index);
    const way = normalize(sub(target, from));
    if (way) {
      const angle = angleBetween(way, [0, 1, 0]);
      if (!state.outside && angle > values.limit) {
        state.outside = true;
        wentOutside = true;
      } else if (state.outside && angle < values.limit - values.threshold) {
        state.outside = false;
      }
    }
  }
  const looking = on && target !== undefined && (!state.outside || values.continueOutsideLimit);
  const turn = (bone: LookAtBoneValues, slot: number): Vec3 | undefined => {
    if (bone.index < 0 || bone.index >= space.count) return undefined;
    const forward = normalize(bone.forwardAxis) ?? [0, 1, 0];
    const at = slot * 3;
    let current: Vec3 = [
      state.forwards[at] ?? forward[0],
      state.forwards[at + 1] ?? forward[1],
      state.forwards[at + 2] ?? forward[2],
    ];
    if (advance) {
      // Where it should look, in its own space, within its limit.
      let wanted: Vec3 = forward;
      if (looking && bone.enabled) {
        const rotation = space.rotation(bone.index);
        const way = normalize(sub(target, space.position(bone.index)));
        const own = way && quatRotate(quatConjugate(rotation), way);
        if (own) wanted = turnTowards(forward, own, bone.limit);
      }
      const gain = values.useBoneGains
        ? looking && bone.enabled
          ? bone.onGain
          : bone.offGain
        : looking
          ? values.onGain
          : values.offGain;
      const t = gainStep(gain, dt);
      current =
        normalize([
          current[0] + (wanted[0] - current[0]) * t,
          current[1] + (wanted[1] - current[1]) * t,
          current[2] + (wanted[2] - current[2]) * t,
        ]) ?? wanted;
      state.forwards.set(current, at);
    }
    if (angleBetween(forward, current) > 1e-5) {
      const rotation = space.rotation(bone.index);
      space.setRotation(bone.index, quatMultiply(rotation, quatFromTo(forward, current)), local);
    }
    return current;
  };
  bones.forEach((bone, i) => turn(bone, i));
  let eyes: LookAtResult['eyes'];
  values.eyeBones.forEach((bone, i) => {
    const current = turn(bone, bones.length + i);
    if (!current || eyes) return;
    const forward = normalize(bone.forwardAxis) ?? [0, 1, 0];
    // Heading clockwise seen from above (right), pitch up, from the bone's own forward.
    const heading = Math.atan2(current[0], current[1]) - Math.atan2(forward[0], forward[1]);
    const pitch =
      Math.asin(Math.min(1, Math.max(-1, current[2]))) -
      Math.asin(Math.min(1, Math.max(-1, forward[2])));
    eyes = { heading: Math.atan2(Math.sin(heading), Math.cos(heading)), pitch };
  });
  return { outside: state.outside, wentOutside, eyes };
}

// --- Direct-at (BSDirectAtModifier) --------------------------------------------------------

export interface DirectAtValues {
  readonly sourceBone: number;
  readonly startBone: number;
  readonly endBone: number;
  /** Radians. */
  readonly limitHeading: number;
  readonly limitPitch: number;
  readonly offsetHeading: number;
  readonly offsetPitch: number;
  readonly onGain: number;
  readonly offGain: number;
}

/** The heading and pitch a direct-at has turned (radians), eased step to step. */
export interface DirectAtState {
  heading: number;
  pitch: number;
}

/**
 * BSDirectAtModifier: the way from the source bone to the target, as a heading (about the
 * character's up, right +) and a pitch (up +) from the character's forward, plus the offsets,
 * each within its limit, eased in by onGain (out to none by offGain); the chain from the start
 * bone to the end bone shares the turn, heading about model up, pitch about the right axis
 * after it. Returns the turn now. TODO(M13): Bethesda's class is not documented; the engine
 * gives it the aim of a bow or a spell (userInfo) through its target.
 */
export function directAt(
  values: DirectAtValues,
  state: DirectAtState,
  local: Float32Array,
  space: ModelSpace,
  target: ReadonlyVec3 | undefined,
  on: boolean,
  dt: number,
  advance: boolean,
): DirectAtState {
  if (advance) {
    let heading = 0;
    let pitch = 0;
    const source = values.sourceBone >= 0 && values.sourceBone < space.count;
    const way = on && target && source ? sub(target, space.position(values.sourceBone)) : undefined;
    if (way && length(way) > EPSILON) {
      heading = Math.atan2(way[0], way[1]) + values.offsetHeading;
      pitch = Math.atan2(way[2], Math.hypot(way[0], way[1])) + values.offsetPitch;
      heading = Math.min(values.limitHeading, Math.max(-values.limitHeading, heading));
      pitch = Math.min(values.limitPitch, Math.max(-values.limitPitch, pitch));
    }
    const t = gainStep(way ? values.onGain : values.offGain, dt);
    state.heading += (heading - state.heading) * t;
    state.pitch += (pitch - state.pitch) * t;
  }
  const chain = space.chain(values.startBone, values.endBone);
  if (chain.length === 0 || (Math.abs(state.heading) < 1e-6 && Math.abs(state.pitch) < 1e-6)) {
    return { heading: state.heading, pitch: state.pitch };
  }
  const share = 1 / chain.length;
  // Heading turns clockwise seen from above: negative about +z.
  const yaw = quatFromAxisAngle([0, 0, 1], -state.heading * share);
  const right = quatRotate(quatFromAxisAngle([0, 0, 1], -state.heading), [1, 0, 0]);
  const tilt = quatFromAxisAngle(right, state.pitch * share);
  const step = quatMultiply(tilt, yaw);
  for (const bone of chain) {
    space.setRotation(bone, quatMultiply(step, space.rotation(bone)), local);
  }
  return { heading: state.heading, pitch: state.pitch };
}

// --- Twist (hkbTwistModifier) --------------------------------------------------------------

export interface TwistValues {
  readonly axis: ReadonlyVec3;
  /** Radians. */
  readonly angle: number;
  readonly startBone: number;
  readonly endBone: number;
  /** 0 linear (equal shares), 1 ramped (shares growing along the chain). */
  readonly setAngleMethod: number;
  /** 0 model space, 1 the parent's space, 2 the bone's own. */
  readonly rotationAxisCoordinates: number;
  readonly isAdditive: boolean;
}

/**
 * hkbTwistModifier: the bones from the start bone down to the end bone turn about the axis,
 * sharing the angle (linear: equally; ramped: the share growing along the chain, 1, 2, 3 ...).
 * Additive: on the pose; else from the reference pose's rotation (`reference`, bone-local).
 */
export function twist(
  values: TwistValues,
  local: Float32Array,
  space: ModelSpace,
  reference: Float32Array,
): void {
  const axisOwn = normalize(values.axis);
  const chain = space.chain(values.startBone, values.endBone);
  if (!axisOwn || chain.length === 0) return;
  if (Math.abs(values.angle) < 1e-7 && values.isAdditive) return;
  const ramped = values.setAngleMethod === 1;
  const total = ramped ? (chain.length * (chain.length + 1)) / 2 : chain.length;
  chain.forEach((bone, i) => {
    const share = (ramped ? i + 1 : 1) / total;
    if (!values.isAdditive) {
      // From the reference pose: the bone's own rotation is the reference's.
      const o = bone * TRANSFORM_FLOATS;
      for (let k = 3; k < 7; k++) local[o + k] = reference[o + k] ?? (k === 6 ? 1 : 0);
      space.update(local);
    }
    const parent = space.parents[bone] ?? -1;
    const rotation = space.rotation(bone);
    const axis =
      values.rotationAxisCoordinates === 2
        ? quatRotate(rotation, axisOwn)
        : values.rotationAxisCoordinates === 1 && parent >= 0
          ? quatRotate(space.rotation(parent), axisOwn)
          : axisOwn;
    const turn = quatFromAxisAngle(axis, values.angle * share);
    space.setRotation(bone, quatMultiply(turn, rotation), local);
  });
}

// --- Limb IK (BSLimbIKModifier) ------------------------------------------------------------

/** A limb IK's values now (its bindings read). */
export interface LimbIkValues {
  readonly startBone: number;
  readonly endBone: number;
  /** Radians the chain's first bone may turn up at most. */
  readonly limit: number;
  /** A fraction per step (gainStep). */
  readonly gain: number;
  /** How far above its ground a bone of the chain keeps (game units). */
  readonly boneRadius: number;
  /** The rays down start this far above each bone (game units). */
  readonly castOffset: number;
}

/** What a limb IK keeps from step to step: the chain's turn up (radians), eased. */
export interface LimbIkState {
  angle: number;
}

/**
 * BSLimbIKModifier (the dragon's tail on the ground): the bones of the chain from the start
 * bone down to the end bone are probed for their ground (rays from castOffset above them);
 * the deepest any sinks below its ground plus the bone radius sets how far the chain's first
 * bone turns up (about the horizontal across the chain's run), within the limit, eased by the
 * gain. Without ground under it the chain eases back down. TODO(M13): Bethesda's solver and
 * the members' units are not documented (game units are taken).
 */
export function limbIk(
  values: LimbIkValues,
  state: LimbIkState,
  local: Float32Array,
  space: ModelSpace,
  ground: GroundProbe | undefined,
  dt: number,
  advance: boolean,
): void {
  const chain = space.chain(values.startBone, values.endBone);
  const first = chain[0];
  if (first === undefined || chain.length < 2) return;
  const start = space.position(first);
  const last = space.position(chain[chain.length - 1] ?? first);
  const run: Vec3 = [last[0] - start[0], last[1] - start[1], 0];
  const axis = normalize(cross(run, [0, 0, 1]));
  if (!axis) return;
  if (advance) {
    let needed = 0;
    if (ground) {
      for (const bone of chain.slice(1)) {
        const at = space.position(bone);
        const hit = ground(
          [at[0], at[1], at[2] + values.castOffset],
          values.castOffset * 2 + values.boneRadius,
        );
        if (!hit) continue;
        const sink = hit.height + values.boneRadius - at[2];
        const reach = length(sub(at, start));
        if (sink > 0 && reach > EPSILON)
          needed = Math.max(needed, Math.asin(Math.min(1, sink / reach)));
      }
    }
    const target = Math.min(Math.max(0, values.limit), needed);
    state.angle += (target - state.angle) * gainStep(values.gain, dt);
  }
  if (Math.abs(state.angle) < 1e-6) return;
  const turn = quatFromAxisAngle(axis, state.angle);
  space.setRotation(first, quatMultiply(turn, space.rotation(first)), local);
}

// --- Foot IK (hkbFootIkDriver, hkbFootIkModifier) ------------------------------------------

/** The gains of a foot IK now (each a fraction per step: gainStep). */
export interface FootIkGainValues {
  readonly onOffGain: number;
  readonly groundAscendingGain: number;
  readonly groundDescendingGain: number;
  readonly footPlantedGain: number;
  readonly footRaisedGain: number;
  readonly worldFromModelFeedbackGain: number;
  /** 1: the body goes down as far as the lowest foot's ground needs; 0: up to the highest's. */
  readonly errorUpDownBias: number;
  readonly alignWorldFromModelGain: number;
  readonly ankleOrientationGain: number;
}

/** The ground under a point of model space: a ray straight down from it, `length` long. */
export type GroundProbe = (
  from: ReadonlyVec3,
  length: number,
) => { readonly height: number; readonly normal: ReadonlyVec3 } | undefined;

/** What foot IK keeps from step to step. */
export interface FootIkState {
  /** How much it is on (eased by onOffGain). */
  weight: number;
  /** Per leg: how far its ground lies above (+) or below the model's ground, eased. */
  readonly errors: Float32Array;
  /** Per leg: how far its foot is turned to the ground's slope (radians), eased. */
  readonly tilts: Float32Array;
  /** How far the body is lowered (−) or raised, eased (the worldFromModel feedback). */
  offset: number;
  /** The body's lean to the ground under the feet (quadrupeds), eased. */
  align: Quat;
}

export function footIkState(legs: number): FootIkState {
  return {
    weight: 0,
    errors: new Float32Array(legs),
    tilts: new Float32Array(legs),
    offset: 0,
    align: [0, 0, 0, 1],
  };
}

/** What foot IK found, per leg (the modifiers' outputs) and for the body. */
export interface FootIkResult {
  readonly legs: readonly {
    readonly error: number;
    readonly hit: boolean;
    readonly planted: boolean;
  }[];
  /** How far the body was moved (model z). */
  readonly offset: number;
}

/**
 * Foot IK: under each ankle a ray finds the ground (from raycastDistanceUp above it to
 * raycastDistanceDown below); the leg's error is how far that ground lies from the model's
 * ground (originalGroundHeightMS), eased up and down by the ground gains. With
 * alignWorldFromModelGain the body leans to the plane of the feet's ground (three legs or
 * more); with worldFromModelFeedbackGain it goes down (errorUpDownBias 1) so the lowest foot
 * can reach its ground. Each ankle then goes to its animated height above its own ground
 * (within minAnkleHeight..maxAnkleHeight of the body), the hip and knee turned to reach it
 * (the knee's interior angle within its limits, about its hinge), the foot keeping its
 * animated orientation, turned towards the ground's slope where it is planted (by
 * ankleOrientationGain, within maxAnkleAngleDegrees). The whole by the on/off weight.
 * TODO(M13): Havok's driver internals (track data, locking planted feet, the gains of planted
 * and raised feet) are not documented; these are the plain reading of its members.
 */
export function footIk(
  setup: FootIkSetup,
  gains: FootIkGainValues,
  enabled: boolean,
  state: FootIkState,
  local: Float32Array,
  space: ModelSpace,
  ground: GroundProbe | undefined,
  dt: number,
  advance: boolean,
): FootIkResult {
  const legs = setup.legs.filter(
    (leg) =>
      leg.hipIndex >= 0 &&
      leg.kneeIndex >= 0 &&
      leg.ankleIndex >= 0 &&
      Math.max(leg.hipIndex, leg.kneeIndex, leg.ankleIndex) < space.count,
  );
  const on = enabled && ground !== undefined;
  if (advance) state.weight += ((on ? 1 : 0) - state.weight) * gainStep(gains.onOffGain, dt);
  const weight = state.weight;
  const none: FootIkResult = {
    legs: legs.map((_, i) => ({ error: state.errors[i] ?? 0, hit: false, planted: false })),
    offset: 0,
  };
  if (weight < 1e-3 || legs.length === 0) {
    if (advance && !on && weight < 1e-3) {
      state.errors.fill(0);
      state.tilts.fill(0);
      state.offset = 0;
      state.align = [0, 0, 0, 1];
    }
    return none;
  }
  const base = setup.originalGroundHeightMS + setup.verticalOffset;
  // The animated ankles, and the ground under each.
  const ankles = legs.map((leg) => space.position(leg.ankleIndex));
  const found = legs.map((_, i) => {
    const ankle = ankles[i] ?? [0, 0, 0];
    return on
      ? ground(
          [ankle[0], ankle[1], ankle[2] + setup.raycastDistanceUp],
          setup.raycastDistanceUp + setup.raycastDistanceDown,
        )
      : undefined;
  });
  // Easing off, it keeps what it last found (the feet go back with the weight alone).
  const moving = advance && on;
  if (moving) {
    found.forEach((hit, i) => {
      const error = hit ? hit.height - base : 0;
      const was = state.errors[i] ?? 0;
      const gain = error > was ? gains.groundAscendingGain : gains.groundDescendingGain;
      state.errors[i] = was + (error - was) * gainStep(gain, dt);
    });
  }
  const errors = legs.map((_, i) => state.errors[i] ?? 0);
  const root = space.root(legs[0]?.hipIndex ?? 0);

  // The body leans to the plane of the feet's ground (quadrupeds).
  if (legs.length >= 3 && gains.alignWorldFromModelGain > 0) {
    const wanted = groundPlaneTurn(ankles, errors);
    if (moving)
      state.align = nlerp(state.align, wanted, gainStep(gains.alignWorldFromModelGain, dt));
    const lean = nlerp([0, 0, 0, 1], state.align, weight);
    leanRoot(root, lean, local, space);
  }

  // Where each ankle should be: its animated height above its own ground.
  const targets = legs.map((leg, i): Vec3 => {
    const animated = ankles[i] ?? [0, 0, 0];
    const now = space.position(leg.ankleIndex);
    return [now[0], now[1], animated[2] + (errors[i] ?? 0)];
  });
  // The body goes down (or up) so the feet can reach.
  if (gains.worldFromModelFeedbackGain > 0) {
    const needs = legs.map((leg, i) => (targets[i]?.[2] ?? 0) - space.position(leg.ankleIndex)[2]);
    const bias = Math.min(1, Math.max(0, gains.errorUpDownBias));
    const wanted = bias * Math.min(...needs) + (1 - bias) * Math.max(...needs);
    if (moving)
      state.offset += (wanted - state.offset) * gainStep(gains.worldFromModelFeedbackGain, dt);
  } else if (moving) {
    state.offset = 0;
  }
  const offset = state.offset * weight;
  if (Math.abs(offset) > 1e-4) space.translateRoot(root, [0, 0, offset], local);

  const results = legs.map((leg, i) => {
    const animated = ankles[i] ?? [0, 0, 0];
    const height = animated[2] - base;
    const planted = height <= leg.footPlantedAnkleHeight;
    const now = space.position(leg.ankleIndex);
    const target = targets[i] ?? now;
    // Within the ankle's heights over the (moved) body.
    const z = Math.min(
      leg.maxAnkleHeight + offset + base,
      Math.max(leg.minAnkleHeight + offset + base, target[2]),
    );
    const goal: Vec3 = [now[0], now[1], now[2] + (z - now[2]) * weight];
    const footRotation = space.rotation(leg.ankleIndex);
    solveLeg(leg, goal, local, space);
    // The foot keeps its animated turn, tilted to the ground's slope where it is planted.
    const hit = found[i];
    const plantedness = Math.min(
      1,
      Math.max(
        0,
        (leg.footRaisedAnkleHeight - height) /
          Math.max(EPSILON, leg.footRaisedAnkleHeight - leg.footPlantedAnkleHeight),
      ),
    );
    let tilt = 0;
    let axis: Vec3 = [1, 0, 0];
    if (hit) {
      const normal = normalize(hit.normal) ?? [0, 0, 1];
      axis = normalize(cross([0, 0, 1], normal)) ?? axis;
      tilt = Math.min(leg.maxAnkleAngleDegrees * DEGREES, angleBetween([0, 0, 1], normal));
    }
    if (moving) {
      const was = state.tilts[i] ?? 0;
      state.tilts[i] = was + (tilt * plantedness - was) * gainStep(gains.ankleOrientationGain, dt);
    }
    const lean = (state.tilts[i] ?? 0) * weight;
    const foot =
      Math.abs(lean) > 1e-5
        ? quatMultiply(quatFromAxisAngle(axis, lean), footRotation)
        : footRotation;
    space.setRotation(leg.ankleIndex, foot, local);
    return { error: errors[i] ?? 0, hit: hit !== undefined, planted };
  });
  return { legs: results, offset };
}

/** The turn that leans model up to the plane through the feet's grounds (least squares). */
function groundPlaneTurn(ankles: readonly ReadonlyVec3[], errors: readonly number[]): Quat {
  // z = a x + b y + c over the ground points.
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  const n = ankles.length;
  ankles.forEach((ankle, i) => {
    const x = ankle[0];
    const y = ankle[1];
    const z = errors[i] ?? 0;
    sx += x;
    sy += y;
    sz += z;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
  });
  // Centred normal equations for a and b.
  const cxx = sxx - (sx * sx) / n;
  const cyy = syy - (sy * sy) / n;
  const cxy = sxy - (sx * sy) / n;
  const cxz = sxz - (sx * sz) / n;
  const cyz = syz - (sy * sz) / n;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < EPSILON) return [0, 0, 0, 1];
  const a = (cxz * cyy - cyz * cxy) / det;
  const b = (cyz * cxx - cxz * cxy) / det;
  const normal = normalize([-a, -b, 1]) ?? [0, 0, 1];
  return quatFromTo([0, 0, 1], normal);
}

function nlerp(a: readonly number[], b: readonly number[], t: number): Quat {
  const sign =
    (a[0] ?? 0) * (b[0] ?? 0) +
      (a[1] ?? 0) * (b[1] ?? 0) +
      (a[2] ?? 0) * (b[2] ?? 0) +
      (a[3] ?? 1) * (b[3] ?? 1) <
    0
      ? -1
      : 1;
  const q: Quat = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) q[k] = (a[k] ?? 0) * (1 - t) + (b[k] ?? 0) * sign * t;
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Turns a root bone (and everything under it) about the model's origin. */
function leanRoot(root: number, turn: Quat, local: Float32Array, space: ModelSpace): void {
  if (Math.abs(turn[3]) > 1 - 1e-9) return;
  const o = root * TRANSFORM_FLOATS;
  const moved = quatRotate(turn, [local[o] ?? 0, local[o + 1] ?? 0, local[o + 2] ?? 0]);
  local[o] = moved[0];
  local[o + 1] = moved[1];
  local[o + 2] = moved[2];
  space.setRotation(root, quatMultiply(turn, space.rotation(root)), local);
}

/**
 * Two-joint IK: the knee turns about its hinge until hip and ankle are as far apart as the
 * goal is from the hip (the interior angle at the knee within its limits), then the hip swings
 * the leg so the ankle is on the goal.
 */
export function solveLeg(
  leg: FootIkLeg,
  goal: ReadonlyVec3,
  local: Float32Array,
  space: ModelSpace,
): void {
  const hip = space.position(leg.hipIndex);
  const knee = space.position(leg.kneeIndex);
  const ankle = space.position(leg.ankleIndex);
  const thigh = length(sub(knee, hip));
  const calf = length(sub(ankle, knee));
  if (thigh < EPSILON || calf < EPSILON) return;
  const reach = (angle: number): number =>
    Math.sqrt(Math.max(0, thigh * thigh + calf * calf - 2 * thigh * calf * Math.cos(angle)));
  const minKnee = Math.max(0, leg.minKneeAngleDegrees) * DEGREES;
  const maxKnee =
    Math.min(180, leg.maxKneeAngleDegrees > 0 ? leg.maxKneeAngleDegrees : 180) * DEGREES;
  const distance = Math.min(reach(maxKnee), Math.max(reach(minKnee), length(sub(goal, hip))));
  // The knee: the interior angle that puts the ankle that far from the hip.
  const cosine = (thigh * thigh + calf * calf - distance * distance) / (2 * thigh * calf);
  const wanted = Math.acos(Math.min(1, Math.max(-1, cosine)));
  const hinge = normalize(quatRotate(space.rotation(leg.kneeIndex), leg.kneeAxis));
  const up = normalize(sub(hip, knee));
  const down = normalize(sub(ankle, knee));
  if (hinge && up && down) {
    // The signed angle from the thigh (back up) to the calf about the hinge.
    const now = Math.atan2(dot(hinge, cross(up, down)), dot(up, down));
    const side = Math.abs(now) > 1e-4 ? Math.sign(now) : 1;
    const turn = side * wanted - now;
    if (Math.abs(turn) > 1e-6) {
      const rotation = space.rotation(leg.kneeIndex);
      space.setRotation(
        leg.kneeIndex,
        quatMultiply(quatFromAxisAngle(hinge, turn), rotation),
        local,
      );
    }
  }
  // The hip swings the leg onto the goal.
  const from = normalize(sub(space.position(leg.ankleIndex), hip));
  const to = normalize(sub(goal, hip));
  if (from && to && angleBetween(from, to) > 1e-6) {
    const rotation = space.rotation(leg.hipIndex);
    space.setRotation(leg.hipIndex, quatMultiply(quatFromTo(from, to), rotation), local);
  }
}

// --- The engine's touches after the graph -------------------------------------------------

/**
 * A spoken line's head turn (the LIP's head pitch, roll and yaw, radians) laid on the head
 * bone, in the character's frame: pitch about its right axis (down +), roll about its forward
 * axis, yaw about up (right +). TODO(M13): the axes' signs of FaceFX's head curves are not
 * documented.
 */
export function turnHead(
  local: Float32Array,
  space: ModelSpace,
  head: number,
  pitch: number,
  roll: number,
  yaw: number,
): void {
  if (head < 0 || head >= space.count) return;
  if (Math.abs(pitch) + Math.abs(roll) + Math.abs(yaw) < 1e-6) return;
  const turn = quatMultiply(
    quatFromAxisAngle([0, 0, 1], -yaw),
    quatMultiply(quatFromAxisAngle([0, 1, 0], roll), quatFromAxisAngle([1, 0, 0], -pitch)),
  );
  space.setRotation(head, quatMultiply(turn, space.rotation(head)), local);
}
