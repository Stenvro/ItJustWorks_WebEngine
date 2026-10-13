// Poses of a Havok skeleton: bone-local hkQsTransforms (TRANSFORM_FLOATS per bone: translation,
// quaternion xyzw, scale), and how behavior graphs blend them: weighted sums of the poses of
// their active generators, per bone when a bone weight array limits a child to some bones,
// quaternions normalised after the sum (with their signs aligned), and additive poses laid on
// top. Platform-independent.

import { TRANSFORM_FLOATS } from '../formats/hkx/animation.ts';

/** Sums weighted poses bone by bone, then normalises them (bones nothing reached: fallback). */
export class PoseAccumulator {
  readonly boneCount: number;
  readonly #sum: Float32Array;
  readonly #weights: Float32Array;

  constructor(boneCount: number) {
    this.boneCount = boneCount;
    this.#sum = new Float32Array(boneCount * TRANSFORM_FLOATS);
    this.#weights = new Float32Array(boneCount);
  }

  reset(): void {
    this.#sum.fill(0);
    this.#weights.fill(0);
  }

  /** Adds a pose with a weight, per bone times `boneWeights` (missing: 1). */
  add(pose: Float32Array, weight: number, boneWeights?: Float32Array): void {
    if (!(weight > 0)) return;
    const sum = this.#sum;
    for (let bone = 0; bone < this.boneCount; bone++) {
      const w = weight * (boneWeights ? (boneWeights[bone] ?? 0) : 1);
      if (!(w > 0)) continue;
      const o = bone * TRANSFORM_FLOATS;
      // A quaternion and its negation are the same turn: add on the side of what is there.
      let dot = 0;
      for (let k = 3; k < 7; k++) dot += (sum[o + k] ?? 0) * (pose[o + k] ?? 0);
      const sign = dot < 0 ? -1 : 1;
      for (let k = 0; k < 3; k++) sum[o + k] = (sum[o + k] ?? 0) + (pose[o + k] ?? 0) * w;
      for (let k = 3; k < 7; k++) sum[o + k] = (sum[o + k] ?? 0) + (pose[o + k] ?? 0) * w * sign;
      for (let k = 7; k < 10; k++) sum[o + k] = (sum[o + k] ?? 0) + (pose[o + k] ?? 0) * w;
      this.#weights[bone] = (this.#weights[bone] ?? 0) + w;
    }
  }

  /** The total weight a bone got. */
  weight(bone: number): number {
    return this.#weights[bone] ?? 0;
  }

  /** Writes the blended pose; bones that got no weight take `fallback`'s. */
  finish(out: Float32Array, fallback: Float32Array): void {
    const sum = this.#sum;
    for (let bone = 0; bone < this.boneCount; bone++) {
      const o = bone * TRANSFORM_FLOATS;
      const w = this.#weights[bone] ?? 0;
      if (!(w > 0)) {
        for (let k = 0; k < TRANSFORM_FLOATS; k++) out[o + k] = fallback[o + k] ?? 0;
        continue;
      }
      for (let k = 0; k < 3; k++) out[o + k] = (sum[o + k] ?? 0) / w;
      for (let k = 7; k < 10; k++) out[o + k] = (sum[o + k] ?? 0) / w;
      const length = Math.hypot(sum[o + 3] ?? 0, sum[o + 4] ?? 0, sum[o + 5] ?? 0, sum[o + 6] ?? 0);
      if (length > 1e-8) {
        for (let k = 3; k < 7; k++) out[o + k] = (sum[o + k] ?? 0) / length;
      } else {
        for (let k = 3; k < 7; k++) out[o + k] = fallback[o + k] ?? 0;
      }
    }
  }
}

/** out = a blended towards b by t (0..1), per bone times `boneWeights` (missing: 1). */
export function blendPoses(
  a: Float32Array,
  b: Float32Array,
  t: number,
  out: Float32Array,
  boneWeights?: Float32Array,
): void {
  const bones = Math.floor(Math.min(a.length, b.length, out.length) / TRANSFORM_FLOATS);
  for (let bone = 0; bone < bones; bone++) {
    const o = bone * TRANSFORM_FLOATS;
    const w = t * (boneWeights ? (boneWeights[bone] ?? 0) : 1);
    for (let k = 0; k < 3; k++) out[o + k] = (a[o + k] ?? 0) * (1 - w) + (b[o + k] ?? 0) * w;
    for (let k = 7; k < 10; k++) out[o + k] = (a[o + k] ?? 0) * (1 - w) + (b[o + k] ?? 0) * w;
    let dot = 0;
    for (let k = 3; k < 7; k++) dot += (a[o + k] ?? 0) * (b[o + k] ?? 0);
    const sign = dot < 0 ? -1 : 1;
    let length = 0;
    for (let k = 3; k < 7; k++) {
      const value = (a[o + k] ?? 0) * (1 - w) + (b[o + k] ?? 0) * w * sign;
      out[o + k] = value;
      length += value * value;
    }
    length = Math.sqrt(length) || 1;
    for (let k = 3; k < 7; k++) out[o + k] = (out[o + k] ?? 0) / length;
  }
}

/**
 * Lays an additive pose on a base pose with a weight: translations add, rotations turn by
 * the additive's rotation (towards it by the weight), scales multiply.
 */
export function addPose(
  base: Float32Array,
  additive: Float32Array,
  weight: number,
  boneWeights?: Float32Array,
): void {
  const bones = Math.floor(Math.min(base.length, additive.length) / TRANSFORM_FLOATS);
  for (let bone = 0; bone < bones; bone++) {
    const o = bone * TRANSFORM_FLOATS;
    const w = weight * (boneWeights ? (boneWeights[bone] ?? 0) : 1);
    if (!(w > 0)) continue;
    for (let k = 0; k < 3; k++) base[o + k] = (base[o + k] ?? 0) + (additive[o + k] ?? 0) * w;
    for (let k = 7; k < 10; k++) {
      base[o + k] = (base[o + k] ?? 1) * (1 + ((additive[o + k] ?? 1) - 1) * w);
    }
    // The additive turn, nlerped from no turn by the weight.
    let ax = (additive[o + 3] ?? 0) * w;
    let ay = (additive[o + 4] ?? 0) * w;
    let az = (additive[o + 5] ?? 0) * w;
    let aw = 1 - w + (additive[o + 6] ?? 1) * w;
    const length = Math.hypot(ax, ay, az, aw) || 1;
    ax /= length;
    ay /= length;
    az /= length;
    aw /= length;
    const bx = base[o + 3] ?? 0;
    const by = base[o + 4] ?? 0;
    const bz = base[o + 5] ?? 0;
    const bw = base[o + 6] ?? 1;
    // base · additive
    base[o + 3] = bw * ax + bx * aw + by * az - bz * ay;
    base[o + 4] = bw * ay - bx * az + by * aw + bz * ax;
    base[o + 5] = bw * az + bx * ay - by * ax + bz * aw;
    base[o + 6] = bw * aw - bx * ax - by * ay - bz * az;
  }
}
