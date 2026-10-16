// Sampling a clip's root motion (animation-data.ts): where the actor is and how it is turned
// at a local time of the clip, relative to where the clip started. Translations are linear
// between keys, rotations spherical; before the first key the motion starts from zero and
// the identity, after the last it holds.
// Notes: docs/formats/hkx.md ("Animation data").

import type { ClipMotion, Quat, Vec3 } from './animation-data.ts';

export interface RootTransform {
  /** Game units, in the frame the clip started in (x right, y forward, z up). */
  readonly translation: Vec3;
  /** Quaternion x y z w. */
  readonly rotation: Quat;
}

const IDENTITY: Quat = [0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];

/** The keys around `time` (with the implicit start key) and the fraction between them. */
function bracket<T>(
  keys: readonly { readonly time: number; readonly value: T }[],
  start: T,
  time: number,
): { from: T; to: T; t: number } {
  let previous = { time: 0, value: start };
  for (const key of keys) {
    if (key.time >= time) {
      const span = key.time - previous.time;
      return {
        from: previous.value,
        to: key.value,
        t: span > 0 ? Math.min(1, Math.max(0, (time - previous.time) / span)) : 1,
      };
    }
    previous = key;
  }
  return { from: previous.value, to: previous.value, t: 0 };
}

/** Spherical interpolation along the shorter arc (normalised linear when nearly parallel). */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let wa = 1 - t;
  let wb = t * sign;
  if (dot < 0.9995) {
    const angle = Math.acos(dot);
    const sin = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / sin;
    wb = (Math.sin(t * angle) / sin) * sign;
  }
  const q: Quat = [
    a[0] * wa + b[0] * wb,
    a[1] * wa + b[1] * wb,
    a[2] * wa + b[2] * wb,
    a[3] * wa + b[3] * wb,
  ];
  const length = Math.hypot(...q) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotates a vector by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
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

/** The root at a local time of the clip (clamped to 0..duration). */
export function rootMotionAt(motion: ClipMotion, time: number): RootTransform {
  const t = Math.min(Math.max(time, 0), motion.duration);
  const move = bracket(motion.translations, ZERO, t);
  const turn = bracket(motion.rotations, IDENTITY, t);
  return {
    translation: [
      move.from[0] + (move.to[0] - move.from[0]) * move.t,
      move.from[1] + (move.to[1] - move.from[1]) * move.t,
      move.from[2] + (move.to[2] - move.from[2]) * move.t,
    ],
    rotation: slerp(turn.from, turn.to, turn.t),
  };
}

/** `b` seen from `a`: the motion from transform `a` to transform `b`, in `a`'s frame. */
function relative(a: RootTransform, b: RootTransform): RootTransform {
  const inverse = conjugate(a.rotation);
  return {
    translation: rotate(inverse, [
      b.translation[0] - a.translation[0],
      b.translation[1] - a.translation[1],
      b.translation[2] - a.translation[2],
    ]),
    rotation: multiply(inverse, b.rotation),
  };
}

/** `b` applied after `a` (b in a's end frame). */
function compose(a: RootTransform, b: RootTransform): RootTransform {
  const moved = rotate(a.rotation, b.translation);
  return {
    translation: [
      a.translation[0] + moved[0],
      a.translation[1] + moved[1],
      a.translation[2] + moved[2],
    ],
    rotation: multiply(a.rotation, b.rotation),
  };
}

/**
 * How the actor moves from local time `from` to `to`, in its frame at `from`: what a frame of
 * the clip adds to the actor's position and heading. With `to` < `from` the clip looped: the
 * rest of the clip, then its start up to `to`.
 */
export function rootMotionDelta(motion: ClipMotion, from: number, to: number): RootTransform {
  const start = rootMotionAt(motion, from);
  if (to >= from) return relative(start, rootMotionAt(motion, to));
  return compose(relative(start, rootMotionAt(motion, motion.duration)), rootMotionAt(motion, to));
}

/** The whole clip's motion: where it ends, its turn (radians about z) and its mean speed. */
export function rootMotionTotal(motion: ClipMotion): RootTransform & {
  readonly distance: number;
  readonly speed: number;
  readonly yaw: number;
} {
  const end = rootMotionAt(motion, motion.duration);
  const distance = Math.hypot(...end.translation);
  const [, , z, w] = end.rotation;
  return {
    ...end,
    distance,
    speed: motion.duration > 0 ? distance / motion.duration : 0,
    yaw: 2 * Math.atan2(z, w),
  };
}
