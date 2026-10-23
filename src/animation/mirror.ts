// Mirrored clips (hkbClipGenerator flag 0x4: 200 vanilla clips in 37 graphs, every quadruped's
// right turns among them, played from its left turns): the pose a clip gives is mirrored across
// the character's mirror plane, each bone's transform going to its mirror partner. Observed in the
// original (Havok's hkaMirroredSkeleton as the executable builds and runs it), in our
// words: docs/animation.md, "Mirrored clips". Platform-independent.

import { TRANSFORM_FLOATS, type HkxSkeleton } from '../formats/hkx/animation.ts';
import type { MirrorSetup } from '../formats/hkx/behavior.ts';
import { ModelSpace, quatConjugate, quatMultiply, quatRotate, type Quat } from './procedural.ts';

/** How far (1 − |cos|) an invariant may be from a quarter-turn rotation to be snapped to it. */
const SNAP_TOLERANCE = 0.1;

/** The 24 rotations of a cube (quarter turns about the axes and their combinations). */
const CUBE_ROTATIONS: readonly Quat[] = (() => {
  const h = Math.SQRT1_2;
  const rotations: Quat[] = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  // Two components ±√½ (each pair, both relative signs).
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      for (const sign of [1, -1]) {
        const q: Quat = [0, 0, 0, 0];
        q[a] = h;
        q[b] = sign * h;
        rotations.push(q);
      }
    }
  }
  // All four components ±½ (up to the sign of the whole).
  for (let signs = 0; signs < 8; signs++) {
    rotations.push([0.5, signs & 1 ? -0.5 : 0.5, signs & 2 ? -0.5 : 0.5, signs & 4 ? -0.5 : 0.5]);
  }
  return rotations;
})();

/** A rotation snapped to the cube rotation it is within the tolerance of (else itself). */
function snap(q: Quat): Quat {
  for (const r of CUBE_ROTATIONS) {
    const dot = q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3];
    if (Math.abs(dot) >= 1 - SNAP_TOLERANCE) return [...r];
  }
  return q;
}

function normalized(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * A skeleton's mirroring. Each bone has an invariant rotation, made from the reference pose as
 * the skeleton is set up: the inverse of its model-space rotation, then the mirror axis, then its
 * partner's model-space rotation (snapped to a quarter-turn rotation when that close), so that the
 * reference pose mirrors onto itself. A pose is mirrored bone by bone in local space: a bone's
 * rotation becomes its parent's invariant (the axis for a root) times the rotation times its own
 * invariant inverted, its translation the parent's invariant turning it, negated; then every bone
 * swaps its transform with its partner's. With the axis (1, 0, 0, 0) and a symmetric skeleton
 * every invariant is the axis: a reflection across the plane x = 0.
 */
export class MirroredSkeleton {
  readonly #parents: Int16Array;
  readonly #pairs: Int16Array;
  /** The axis, then each bone's invariant: four floats each. */
  readonly #invariants: Float32Array;

  constructor(skeleton: HkxSkeleton, setup: MirrorSetup) {
    const count = skeleton.bones.length;
    this.#parents = skeleton.parents;
    // Without a pairing every bone is its own partner.
    this.#pairs = Int16Array.from({ length: count }, (_, bone) => {
      const pair = setup.pairs[bone];
      return pair !== undefined && pair >= 0 && pair < count ? pair : bone;
    });
    const axis = normalized([...setup.axis]);
    const space = new ModelSpace(skeleton.parents);
    space.update(skeleton.referencePose);
    this.#invariants = new Float32Array((count + 1) * 4);
    this.#invariants.set(axis, 0);
    for (let bone = 0; bone < count; bone++) {
      const own = space.rotation(bone);
      const partner = space.rotation(this.#pairs[bone] ?? bone);
      const invariant = snap(
        normalized(quatMultiply(quatMultiply(quatConjugate(own), axis), partner)),
      );
      this.#invariants.set(invariant, (bone + 1) * 4);
    }
  }

  #invariant(bone: number): Quat {
    const o = (bone + 1) * 4;
    const i = this.#invariants;
    return [i[o] ?? 0, i[o + 1] ?? 0, i[o + 2] ?? 0, i[o + 3] ?? 1];
  }

  /** Mirrors a bone-local pose (TRANSFORM_FLOATS per bone) in place. */
  mirrorPose(pose: Float32Array): void {
    const count = this.#parents.length;
    for (let bone = 0; bone < count; bone++) {
      const o = bone * TRANSFORM_FLOATS;
      const parent = this.#invariant(this.#parents[bone] ?? -1);
      const own = this.#invariant(bone);
      const q: Quat = [pose[o + 3] ?? 0, pose[o + 4] ?? 0, pose[o + 5] ?? 0, pose[o + 6] ?? 1];
      const r = normalized(quatMultiply(quatMultiply(parent, q), quatConjugate(own)));
      const t = quatRotate(parent, [pose[o] ?? 0, pose[o + 1] ?? 0, pose[o + 2] ?? 0]);
      pose[o] = -t[0];
      pose[o + 1] = -t[1];
      pose[o + 2] = -t[2];
      for (let k = 0; k < 4; k++) pose[o + 3 + k] = r[k] ?? 0;
    }
    // Partners swap their transforms.
    const swap = new Float32Array(TRANSFORM_FLOATS);
    for (let bone = 0; bone < count; bone++) {
      const pair = this.#pairs[bone] ?? bone;
      if (pair >= bone) continue;
      const a = bone * TRANSFORM_FLOATS;
      const b = pair * TRANSFORM_FLOATS;
      swap.set(pose.subarray(a, a + TRANSFORM_FLOATS));
      pose.copyWithin(a, b, b + TRANSFORM_FLOATS);
      pose.set(swap, b);
    }
  }

  /**
   * Mirrors an additive pose (differences to the pose below: translations added, rotations
   * turning it, scales multiplying): laid on the reference pose, mirrored, then taken again as
   * the difference to the mirrored reference pose.
   */
  mirrorAdditive(delta: Float32Array, reference: Float32Array): void {
    const count = this.#parents.length;
    const full = reference.slice(0, count * TRANSFORM_FLOATS);
    for (let bone = 0; bone < count; bone++) {
      const o = bone * TRANSFORM_FLOATS;
      const q = quatMultiply(
        [full[o + 3] ?? 0, full[o + 4] ?? 0, full[o + 5] ?? 0, full[o + 6] ?? 1],
        [delta[o + 3] ?? 0, delta[o + 4] ?? 0, delta[o + 5] ?? 0, delta[o + 6] ?? 1],
      );
      for (let k = 0; k < 3; k++) full[o + k] = (full[o + k] ?? 0) + (delta[o + k] ?? 0);
      for (let k = 0; k < 4; k++) full[o + 3 + k] = q[k] ?? 0;
      for (let k = 7; k < 10; k++) full[o + k] = (full[o + k] ?? 1) * (delta[o + k] ?? 1);
    }
    const base = reference.slice(0, count * TRANSFORM_FLOATS);
    this.mirrorPose(full);
    this.mirrorPose(base);
    for (let bone = 0; bone < count; bone++) {
      const o = bone * TRANSFORM_FLOATS;
      const q = quatMultiply(
        quatConjugate([base[o + 3] ?? 0, base[o + 4] ?? 0, base[o + 5] ?? 0, base[o + 6] ?? 1]),
        [full[o + 3] ?? 0, full[o + 4] ?? 0, full[o + 5] ?? 0, full[o + 6] ?? 1],
      );
      for (let k = 0; k < 3; k++) delta[o + k] = (full[o + k] ?? 0) - (base[o + k] ?? 0);
      for (let k = 0; k < 4; k++) delta[o + 3 + k] = q[k] ?? 0;
      for (let k = 7; k < 10; k++) delta[o + k] = (full[o + k] ?? 1) / ((base[o + k] ?? 1) || 1);
    }
  }

  /**
   * Mirrors how a clip moves the character (its extracted motion: a translation in the
   * character's frame and a turn about z, counter-clockwise radians): by the axis alone.
   */
  mirrorMotion(
    translation: readonly [number, number, number],
    yaw: number,
  ): { readonly translation: [number, number, number]; readonly yaw: number } {
    const axis = this.#invariant(-1);
    const t = quatRotate(axis, translation);
    const turn: Quat = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
    const r = quatMultiply(quatMultiply(axis, turn), quatConjugate(axis));
    // The mirrored turn about z (an axis in the mirror plane keeps the turn upright).
    const mirroredYaw = 2 * Math.atan2(r[2], r[3]);
    return { translation: [-t[0], -t[1], -t[2]], yaw: mirroredYaw };
  }
}
