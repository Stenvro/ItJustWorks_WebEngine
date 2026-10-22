// The behavior projects' speed data: meshes\speeddatasinglefile.txt. A text head (the project
// count and one "<Project>Data\<Project>.spd" line each), then binary, little-endian, per
// project: u32 1, u32 table count, per table i32 state, u32 curve count, per curve f32
// direction, u32 point count and the points (f32 x, f32 y).
// No documentation found; what it is follows from the data and the graphs: the tables of
// BSSpeedSamplerModifier (the vanilla graphs bind its state, direction, goalSpeed and speedOut
// to iState, Direction, Speed and SpeedSampled). Per locomotion state and direction (0 to 0.9
// by 0.05) a sampled curve: x the locomotion blenders' parameter (SpeedSampled, whose child
// weights are the clips' speeds), y the speed the blend then moves the actor at (units per
// second). The sampler looks the goal speed up in y and outputs its x.
// Notes: docs/formats/hkx.md ("Animation data").

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeWindows1252 } from '../text.ts';
import { projectName } from './animation-set-data.ts';

export interface SpeedCurve {
  /** The Direction variable's value it holds for. */
  readonly direction: number;
  /** (parameter, speed) points, the parameter rising. */
  readonly points: readonly (readonly [number, number])[];
}

export interface SpeedTable {
  /** The iState value it holds for. */
  readonly state: number;
  readonly curves: readonly SpeedCurve[];
}

export interface SpeedDataProject {
  /** The behavior project's file name ("DefaultMale"). */
  readonly name: string;
  readonly path: string;
  /** The block's leading u32: 1 in every vanilla project. */
  readonly version: number;
  readonly tables: readonly SpeedTable[];
}

/** Reads meshes\speeddatasinglefile.txt. */
export function parseSpeedData(bytes: Uint8Array): SpeedDataProject[] {
  let offset = 0;
  const line = (): string => {
    const end = bytes.indexOf(0x0a, offset);
    if (end < 0) throw new FormatError('speed data: the text head ends early', offset);
    const text = decodeWindows1252(bytes, offset, end).replace(/\r$/, '');
    offset = end + 1;
    return text;
  };
  const head = line().trim();
  if (!/^\d+$/.test(head)) throw new FormatError(`speed data: no project count ("${head}")`, 0);
  const paths = Array.from({ length: Number(head) }, line);
  const reader = new BinaryReader(bytes, offset);
  const projects = paths.map((path) => {
    const version = reader.u32();
    const tables = Array.from({ length: reader.u32() }, () => {
      const state = reader.i32();
      const curves = Array.from({ length: reader.u32() }, () => {
        const direction = reader.f32();
        const count = reader.u32();
        if (count * 8 > reader.remaining) {
          throw new FormatError(`speed data of ${path}: ${String(count)} points`, reader.offset);
        }
        const points = Array.from({ length: count }, () => [reader.f32(), reader.f32()] as const);
        return { direction, points };
      });
      return { state, curves };
    });
    return { name: projectName(path), path, version, tables };
  });
  if (reader.remaining !== 0) {
    throw new FormatError(
      `speed data: ${String(reader.remaining)} bytes after the last project`,
      reader.offset,
    );
  }
  return projects;
}

/** Linear lookup in points sorted by `from`: `to` at `value`, held beyond the ends. */
function lookup(
  points: readonly (readonly [number, number])[],
  value: number,
  from: 0 | 1,
): number {
  const to = from === 0 ? 1 : 0;
  const first = points[0];
  if (!first) return value;
  if (value <= first[from]) return first[to];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] ?? first;
    const b = points[i] ?? first;
    if (value > b[from]) continue;
    const span = b[from] - a[from];
    return span > 0 ? a[to] + ((b[to] - a[to]) * (value - a[from])) / span : a[to];
  }
  return points[points.length - 1]?.[to] ?? value;
}

/** The two curves around a direction (wrapping at 1) and the weight of the second. */
function around(
  table: SpeedTable,
  direction: number,
): [SpeedCurve, SpeedCurve, number] | undefined {
  const curves = table.curves;
  const first = curves[0];
  const last = curves[curves.length - 1];
  if (!first || !last) return undefined;
  const d = direction - Math.floor(direction);
  let below = last;
  let from = last.direction - 1;
  for (const curve of curves) {
    if (curve.direction > d) {
      const span = curve.direction - from;
      return [below, curve, span > 0 ? (d - from) / span : 0];
    }
    below = curve;
    from = curve.direction;
  }
  const span = first.direction + 1 - from;
  return [below, first, span > 0 ? (d - from) / span : 0];
}

/** The speed (units per second) the locomotion moves at for a blend parameter and direction. */
export function speedAtParameter(table: SpeedTable, direction: number, parameter: number): number {
  const curves = around(table, direction);
  if (!curves) return parameter;
  const [a, b, t] = curves;
  return lookup(a.points, parameter, 0) * (1 - t) + lookup(b.points, parameter, 0) * t;
}

/**
 * What BSSpeedSamplerModifier outputs: the blend parameter that moves the actor at the goal
 * speed in a direction (each curve inverted, linear between the curves around the direction).
 * Beyond the sampled speeds it holds at the curve's last parameter (TODO(M13): whether the
 * engine extrapolates there, e.g. a run at 370 against state 0's curve ending at 306).
 */
export function speedParameter(table: SpeedTable, direction: number, goal: number): number {
  const curves = around(table, direction);
  if (!curves) return goal;
  const [a, b, t] = curves;
  return lookup(a.points, goal, 1) * (1 - t) + lookup(b.points, goal, 1) * t;
}
