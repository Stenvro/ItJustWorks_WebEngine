// Matching a ragdoll's pose to the poses a character gets up from (hkbPoseMatchingGenerator,
// docs/animation.md "Ragdolls and getting up"): of the get-up clips' first poses, the one whose
// matching bones (the ragdoll skeleton's root, other and another: the human's COM, neck and left
// upper arm) lie as the ragdoll's do once it is turned about the up axis to fit; the turn and
// the shift that lay it over the ragdoll are where the character stands to get up. The bones'
// places are model-space positions (ModelSpace.positions: x, y, z per bone). Havok's own
// weighing of the bones is not documented (TODO(M13)): the match here is the least squared
// distance of the two bones' offsets from the root after the best turn. Platform-independent.

import { TRANSFORM_FLOATS } from '../formats/hkx/animation.ts';

/** The animation bones a pose is matched by (the ragdoll bones mapped to the skeleton's). */
export interface MatchBones {
  readonly root: number;
  readonly other: number;
  readonly another: number;
}

/** The best match: which candidate, and the turn and shift that lay it over the ragdoll. */
export interface PoseMatch {
  readonly index: number;
  /** Radians about z, counter-clockwise (the model's own frame). */
  readonly yaw: number;
  /** The candidate's model origin in the ragdoll's model frame (x, y; on its ground). */
  readonly offset: readonly [number, number];
  /** The squared distances left (0: a perfect fit). */
  readonly error: number;
}

type Positions = ArrayLike<number>;

const at = (positions: Positions, bone: number): [number, number, number] => [
  positions[bone * 3] ?? 0,
  positions[bone * 3 + 1] ?? 0,
  positions[bone * 3 + 2] ?? 0,
];

/**
 * The candidate (model-space bone positions of each get-up pose) that best matches the
 * ragdoll's positions, its turn about z and the shift of its origin.
 */
export function matchPose(
  ragdoll: Positions,
  candidates: readonly Positions[],
  bones: MatchBones,
): PoseMatch | undefined {
  const r0 = at(ragdoll, bones.root);
  const rv = [bones.other, bones.another].map((bone) => {
    const p = at(ragdoll, bone);
    return [p[0] - r0[0], p[1] - r0[1], p[2] - r0[2]] as const;
  });
  let best: PoseMatch | undefined;
  candidates.forEach((candidate, index) => {
    const c0 = at(candidate, bones.root);
    const cv = [bones.other, bones.another].map((bone) => {
      const p = at(candidate, bone);
      return [p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]] as const;
    });
    // The turn about z that best lays the candidate's offsets over the ragdoll's (least squares
    // in the ground plane: the angle of Σ c × r against Σ c · r).
    let cross = 0;
    let dot = 0;
    cv.forEach((c, i) => {
      const r = rv[i] ?? [0, 0, 0];
      cross += c[0] * r[1] - c[1] * r[0];
      dot += c[0] * r[0] + c[1] * r[1];
    });
    const yaw = Math.atan2(cross, dot);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    let error = 0;
    cv.forEach((c, i) => {
      const r = rv[i] ?? [0, 0, 0];
      const x = c[0] * cos - c[1] * sin;
      const y = c[0] * sin + c[1] * cos;
      error += (x - r[0]) ** 2 + (y - r[1]) ** 2 + (c[2] - r[2]) ** 2;
    });
    // Where the candidate's origin goes so its root lies over the ragdoll's.
    const offset: [number, number] = [
      r0[0] - (c0[0] * cos - c0[1] * sin),
      r0[1] - (c0[0] * sin + c0[1] * cos),
    ];
    if (!best || error < best.error) best = { index, yaw, offset, error };
  });
  return best;
}

/**
 * A pose (bone-local transforms) moved into the frame of a match: its root bones (those without
 * a parent, whose local transform is their model one) turned by −yaw about z and shifted by
 * −offset, so that it shows where it was once the character stands at the match.
 */
export function intoMatchFrame(
  pose: Float32Array,
  parents: ArrayLike<number>,
  match: Pick<PoseMatch, 'yaw' | 'offset'>,
): void {
  const half = -match.yaw / 2;
  const qz = Math.sin(half);
  const qw = Math.cos(half);
  const cos = Math.cos(-match.yaw);
  const sin = Math.sin(-match.yaw);
  for (let bone = 0; bone < parents.length; bone++) {
    if ((parents[bone] ?? -1) >= 0) continue;
    const o = bone * TRANSFORM_FLOATS;
    const x = (pose[o] ?? 0) - match.offset[0];
    const y = (pose[o + 1] ?? 0) - match.offset[1];
    pose[o] = x * cos - y * sin;
    pose[o + 1] = x * sin + y * cos;
    // q' = qz(−yaw) · q.
    const ax = pose[o + 3] ?? 0;
    const ay = pose[o + 4] ?? 0;
    const az = pose[o + 5] ?? 0;
    const aw = pose[o + 6] ?? 1;
    pose[o + 3] = qw * ax - qz * ay;
    pose[o + 4] = qw * ay + qz * ax;
    pose[o + 5] = qw * az + qz * aw;
    pose[o + 6] = qw * aw - qz * az;
  }
}
