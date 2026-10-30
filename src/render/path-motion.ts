// Motion along a path (NiPathInterpolator, nif.xml): a node moves along a curve of position keys
// (NiPosData, its keys' times spanning 0 to 1) by a percentage that its own keys (NiFloatData)
// give over the controller's time. The flags (nif.xml PathFlags):
//   - Constant velocity (0x10): the percentage is a share of the curve's length, so the node
//     moves at an even speed whatever the spacing of the keys; without it the percentage is a
//     time on the curve's keys.
//   - Follow (0x20): the node turns so its follow axis (0 x, 1 y, 2 z) lies along the curve's
//     direction there, with Flip (0x40) the other way along it; its other axes keep world up.
//   - Bank (0x08): a roll into the curve's bends, up to the max bank angle. The only vanilla
//     path that sets it (the hawks', fchawk*.nif) has a max bank angle of 0, so no path rolls.
// The camera paths of the kill cameras (meshes\cameras\base.nif, baseleft.nif), the critters'
// flights (hawks, terns, salmon, ancestor moths), the catapult's stone and the astrolabes use it.
// Models are built in workers: plain data only.

import { KeyType } from '../formats/nif/animation-blocks.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import type { KeyGroup, Quaternion, Ref, Vec3 } from '../formats/nif/types.ts';

/** nif.xml PathFlags. */
export const PathFlag = {
  bank: 0x08,
  constantVelocity: 0x10,
  follow: 0x20,
  flip: 0x40,
} as const;

/** Steps per key segment of the length table (constant velocity). */
const LENGTH_STEPS = 16;

export interface PathSource {
  readonly flags: number;
  /** The axis that follows the curve: 0 x, 1 y, 2 z. */
  readonly followAxis: number;
  /** The curve: position keys over 0..1. */
  readonly path: KeyGroup<Vec3>;
  /** The percentage along it over the controller's time. */
  readonly percent: KeyGroup<number>;
  /**
   * Constant velocity: the curve's length up to each step (LENGTH_STEPS per key segment, from
   * 0 at its start), to turn a share of the length into a place on the curve.
   */
  readonly lengths: Float32Array | undefined;
}

/** Reads an NiPathInterpolator; undefined if it is not one or has no path. */
export function pathSource(file: NifFile, ref: Ref): PathSource | undefined {
  const block = file.blocks[ref];
  if (block?.kind !== 'path-interpolator') return undefined;
  const path = file.blocks[block.pathData];
  const percent = file.blocks[block.percentData];
  if (path?.kind !== 'pos-data' || path.keys.keys.length === 0) return undefined;
  const percentKeys: KeyGroup<number> =
    percent?.kind === 'float-data' ? percent.keys : { interpolation: KeyType.linear, keys: [] };
  const lengths =
    (block.flags & PathFlag.constantVelocity) !== 0 ? lengthTable(path.keys) : undefined;
  return {
    flags: block.flags,
    followAxis: block.followAxis,
    path: path.keys,
    percent: percentKeys,
    lengths,
  };
}

/** The curve's point and its direction (not normalised) in key segment `i` at `s` (0..1). */
function segmentPoint(path: KeyGroup<Vec3>, i: number, s: number): { at: Vec3; way: Vec3 } {
  const keys = path.keys;
  const a = keys[i];
  const b = keys[i + 1] ?? a;
  if (!a || !b) return { at: [0, 0, 0], way: [0, 0, 0] };
  const p0 = a.value;
  const p1 = b.value;
  if (path.interpolation === KeyType.quadratic) {
    // Hermite segments leaving along the first key's backward tangent and arriving along the
    // next key's forward one (as src/render/animation.ts samples quadratic keys).
    const m0 = a.backward ?? [0, 0, 0];
    const m1 = b.forward ?? [0, 0, 0];
    const s2 = s * s;
    const s3 = s2 * s;
    const h = [2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2] as const;
    const d = [6 * s2 - 6 * s, 3 * s2 - 4 * s + 1, -6 * s2 + 6 * s, 3 * s2 - 2 * s] as const;
    const at = (k: 0 | 1 | 2, w: readonly number[]): number =>
      (w[0] ?? 0) * p0[k] + (w[1] ?? 0) * m0[k] + (w[2] ?? 0) * p1[k] + (w[3] ?? 0) * m1[k];
    return { at: [at(0, h), at(1, h), at(2, h)], way: [at(0, d), at(1, d), at(2, d)] };
  }
  const way: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  return { at: [p0[0] + way[0] * s, p0[1] + way[1] * s, p0[2] + way[2] * s], way };
}

/** The curve's length up to each of its steps (constant velocity). */
function lengthTable(path: KeyGroup<Vec3>): Float32Array {
  const segments = Math.max(0, path.keys.length - 1);
  const table = new Float32Array(segments * LENGTH_STEPS + 1);
  let total = 0;
  let last = segmentPoint(path, 0, 0).at;
  for (let i = 0; i < segments; i++) {
    for (let step = 1; step <= LENGTH_STEPS; step++) {
      const at = segmentPoint(path, i, step / LENGTH_STEPS).at;
      total += Math.hypot(at[0] - last[0], at[1] - last[1], at[2] - last[2]);
      table[i * LENGTH_STEPS + step] = total;
      last = at;
    }
  }
  return table;
}

/** The key segment and the place in it at a time on the curve's keys. */
function segmentAtTime(path: KeyGroup<Vec3>, time: number): { i: number; s: number } {
  const keys = path.keys;
  const last = keys.length - 1;
  if (last <= 0 || time <= (keys[0]?.time ?? 0)) return { i: 0, s: 0 };
  if (time >= (keys[last]?.time ?? 0)) return { i: last - 1, s: 1 };
  let i = 0;
  while (i < last - 1 && (keys[i + 1]?.time ?? 0) <= time) i++;
  const a = keys[i]?.time ?? 0;
  const b = keys[i + 1]?.time ?? a;
  return { i, s: b > a ? (time - a) / (b - a) : 0 };
}

/** The key segment and the place in it at a share of the curve's length. */
function segmentAtLength(lengths: Float32Array, share: number): { i: number; s: number } {
  const total = lengths[lengths.length - 1] ?? 0;
  const steps = lengths.length - 1;
  if (steps <= 0 || total <= 0) return { i: 0, s: 0 };
  const want = Math.min(1, Math.max(0, share)) * total;
  let lo = 0;
  let hi = steps;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((lengths[mid] ?? 0) <= want) lo = mid;
    else hi = mid;
  }
  const a = lengths[lo] ?? 0;
  const b = lengths[hi] ?? a;
  const step = lo + (b > a ? (want - a) / (b - a) : 0);
  const i = Math.min(Math.floor(step / LENGTH_STEPS), steps / LENGTH_STEPS - 1);
  return { i, s: (step - i * LENGTH_STEPS) / LENGTH_STEPS };
}

/** Samples a float key group (linear, quadratic or constant), clamped at its ends. */
function samplePercent(group: KeyGroup<number>, time: number): number {
  const keys = group.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return 0;
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;
  let i = 0;
  while (i < keys.length - 2 && (keys[i + 1]?.time ?? 0) <= time) i++;
  const a = keys[i] ?? first;
  const b = keys[i + 1] ?? last;
  const span = b.time - a.time;
  const s = span > 0 ? (time - a.time) / span : 0;
  if (group.interpolation === KeyType.constant) return a.value;
  if (group.interpolation === KeyType.quadratic) {
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * a.value +
      (s3 - 2 * s2 + s) * (a.backward ?? 0) +
      (-2 * s3 + 3 * s2) * b.value +
      (s3 - s2) * (b.forward ?? 0)
    );
  }
  return a.value + (b.value - a.value) * s;
}

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** A rotation (w, x, y, z) from its axes (columns: where local x, y and z point). */
function axesQuaternion(x: Vec3, y: Vec3, z: Vec3): Quaternion {
  const trace = x[0] + y[1] + z[2];
  let q: Quaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [s / 4, (y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s];
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    q = [(y[2] - z[1]) / s, s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s];
  } else if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    q = [(z[0] - x[2]) / s, (y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s];
  } else {
    const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
    q = [(x[1] - y[0]) / s, (z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4];
  }
  const length = Math.hypot(...q) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/**
 * The rotation that lays `axis` along `direction` and keeps world up (+z) as near the node's
 * up as it can (for a vertical follow axis: its x level).
 */
export function followRotation(direction: Vec3, axis: number): Quaternion | undefined {
  const along = normalize(direction);
  if (along[0] === 0 && along[1] === 0 && along[2] === 0) return undefined;
  const up: Vec3 = Math.abs(along[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  if (axis === 2) {
    const x = normalize(cross(up, along));
    return axesQuaternion(x, cross(along, x), along);
  }
  if (axis === 1) {
    const x = normalize(cross(along, up));
    return axesQuaternion(x, along, cross(x, along));
  }
  const y = normalize(cross(up, along));
  return axesQuaternion(along, y, cross(along, y));
}

/** Where a path puts its node at a controller time, and its turn when it follows the curve. */
export function samplePath(
  source: PathSource,
  time: number,
): { translation: Vec3; rotation: Quaternion | undefined } {
  const share = samplePercent(source.percent, time);
  const keys = source.path.keys;
  const first = keys[0]?.time ?? 0;
  const last = keys[keys.length - 1]?.time ?? 1;
  const { i, s } = source.lengths
    ? segmentAtLength(source.lengths, share)
    : segmentAtTime(source.path, first + Math.min(1, Math.max(0, share)) * (last - first));
  const { at, way } = segmentPoint(source.path, i, s);
  let rotation: Quaternion | undefined;
  if ((source.flags & PathFlag.follow) !== 0) {
    const sign = (source.flags & PathFlag.flip) !== 0 ? -1 : 1;
    rotation = followRotation([way[0] * sign, way[1] * sign, way[2] * sign], source.followAxis);
  }
  return { translation: at, rotation };
}
