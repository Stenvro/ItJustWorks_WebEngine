// Animation of placed models from their NIF controllers: active time controllers on nodes,
// shaders and alpha properties, and the sequences of the model's NiControllerManager (the
// idle one, or those its behavior graph plays: src/animation/object-graph.ts).
// Evaluates keyframes (linear, quadratic, TBC, constant; quaternion and XYZ rotations)
// with the controllers' timing and cycle types. Platform-independent.
// Notes: docs/formats/nif.md ("Animation").

import { CycleType, KeyType } from '../formats/nif/animation-blocks.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import type {
  ControllerBlock,
  ControllerSequenceBlock,
  KeyGroup,
  NifTransform,
  Quaternion,
  Ref,
  TransformDataBlock,
  Vec3,
} from '../formats/nif/types.ts';
import { fromNifTransform, multiply, type Mat4 } from './math.ts';

export interface Timing {
  readonly frequency: number;
  readonly phase: number;
  readonly start: number;
  readonly stop: number;
  /** CycleType. */
  readonly cycle: number;
}

export interface TransformSample {
  readonly translation: Vec3 | undefined;
  readonly rotation: Quaternion | undefined;
  readonly scale: number | undefined;
}

/** Keyframes of a value, or a constant (models are built in workers: no functions). */
export interface FloatSource {
  readonly constant: number;
  readonly keys: KeyGroup<number> | undefined;
}

export interface Vec3Source {
  readonly constant: Vec3;
  readonly keys: KeyGroup<Vec3> | undefined;
}

export interface BoolSource {
  readonly constant: boolean;
  readonly keys: KeyGroup<number> | undefined;
}

export interface TransformSource {
  readonly translation: Vec3 | undefined;
  readonly rotation: Quaternion | undefined;
  readonly scale: number | undefined;
  readonly data: TransformDataBlock | undefined;
}

/** What a controller animates, and how its value changes over its time. */
export type AnimationTrack = { readonly timing: Timing } & (
  | { readonly kind: 'transform'; readonly block: Ref; readonly source: TransformSource }
  | { readonly kind: 'visibility'; readonly block: Ref; readonly source: BoolSource }
  | {
      readonly kind: 'shader-float';
      readonly shader: Ref;
      readonly variable: number;
      readonly source: FloatSource;
    }
  | {
      readonly kind: 'shader-color';
      readonly shader: Ref;
      readonly variable: number;
      readonly source: Vec3Source;
    }
  | { readonly kind: 'alpha-test'; readonly alpha: Ref; readonly source: FloatSource }
);

export interface ModelAnimation {
  readonly tracks: readonly AnimationTrack[];
  /** Parent of every scene-graph object (−1 for roots), and its own transform. */
  readonly parents: ReadonlyMap<Ref, Ref>;
  readonly transforms: ReadonlyMap<Ref, NifTransform>;
  readonly roots: readonly Ref[];
}

/**
 * A named sequence the game plays on demand (a door's "Open" and "Close") or a behavior graph
 * plays. Its clock: start and stop in its own time, frequency, cycle type and text keys.
 */
export interface ModelSequence {
  readonly tracks: readonly AnimationTrack[];
  /** Seconds from start to stop. */
  readonly duration: number;
  readonly start: number;
  readonly stop: number;
  readonly frequency: number;
  /** CycleType. */
  readonly cycle: number;
  readonly textKeys: readonly { readonly time: number; readonly text: string }[];
}

/**
 * The sequences of a model's controller manager by lower-case name, with the scene graph
 * they move (parents, rest transforms, roots) and the objects by name.
 */
export interface ModelSequences {
  readonly byName: ReadonlyMap<string, ModelSequence>;
  readonly parents: ReadonlyMap<Ref, Ref>;
  readonly transforms: ReadonlyMap<Ref, NifTransform>;
  readonly roots: readonly Ref[];
  /** Scene-graph objects by name. */
  readonly objects: ReadonlyMap<string, Ref>;
}

/**
 * Which sequence an instance plays, and since when (in the renderer's clock, seconds). The
 * game sets it (a door opens); the instance holds the sequence's end once it has run.
 */
export interface Playback {
  sequence: string | undefined;
  start: number;
}

/** Tracks evaluated at their own moment (a sequence that started at its own time). */
export interface AnimationLayer {
  readonly tracks: readonly AnimationTrack[];
  /** Seconds into the layer. */
  readonly seconds: number;
  /**
   * A sequence's blend weight (the sequences a behavior graph plays); layers without one
   * (free controllers) set their values outright.
   */
  readonly weight?: number;
}

/** Everything a model's animation sets at one moment. */
export interface AnimationFrame {
  /** World matrices (model space) of the objects that moved, or are below one that did. */
  readonly worlds: ReadonlyMap<Ref, Mat4>;
  readonly hidden: ReadonlySet<Ref>;
  readonly shaderFloats: ReadonlyMap<Ref, ReadonlyMap<number, number>>;
  readonly shaderColors: ReadonlyMap<Ref, ReadonlyMap<number, Vec3>>;
  readonly alphaTest: ReadonlyMap<Ref, number>;
}

/**
 * Sequences that play on their own when an object is placed (first one found). AmIdle is the
 * resting state of furniture-like objects (e.g. the forge's idle smoke; Playing is its use);
 * SpecialIdle_AreaEffect is the only sequence of the shock explosions (explosionshock01: its
 * lightning and particles).
 */
const IDLE_SEQUENCES = [
  'idle',
  'autoloop',
  'specialidle',
  'specialidle_areaeffect',
  'waiting',
  'mloop',
  'midle',
  'animidle',
  'animidle01',
  'loop',
  'amidle',
];

/** NIF stores unset transform components of interpolators as ±FLT_MAX. */
const UNSET = 3.0e38;
/** TimeControllerFlags. */
const ACTIVE = 0x8;
const MANAGER_CONTROLLED = 0x20;

/** Controller time: scaled by frequency and phase, then wrapped by the cycle type. */
export function controllerTime(timing: Timing, seconds: number): number {
  const time = seconds * timing.frequency + timing.phase;
  const { start, stop } = timing;
  const span = stop - start;
  if (span <= 0) return start;
  switch (timing.cycle) {
    case CycleType.loop: {
      const t = (time - start) % span;
      return start + (t < 0 ? t + span : t);
    }
    case CycleType.reverse: {
      const t = (time - start) % (2 * span);
      const u = t < 0 ? t + 2 * span : t;
      return start + (u <= span ? u : 2 * span - u);
    }
    default:
      return Math.min(stop, Math.max(start, time));
  }
}

// --- Keyframes ----------------------------------------------------------------------------

type Lerp<T> = (a: T, b: T, s: number) => T;
type Hermite<T> = (p0: T, m0: T, p1: T, m1: T, s: number) => T;
type Combine<T> = (a: T, b: T, wa: number, wb: number) => T;

interface ValueOps<T> {
  readonly lerp: Lerp<T>;
  readonly hermite: Hermite<T>;
  readonly combine: Combine<T>;
}

const hermiteWeights = (s: number): [number, number, number, number] => {
  const s2 = s * s;
  const s3 = s2 * s;
  return [2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2];
};

const NUMBER_OPS: ValueOps<number> = {
  lerp: (a, b, s) => a + (b - a) * s,
  hermite: (p0, m0, p1, m1, s) => {
    const [h00, h10, h01, h11] = hermiteWeights(s);
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
  },
  combine: (a, b, wa, wb) => a * wa + b * wb,
};

const VEC3_OPS: ValueOps<Vec3> = {
  lerp: (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s],
  hermite: (p0, m0, p1, m1, s) => {
    const [h00, h10, h01, h11] = hermiteWeights(s);
    const at = (k: 0 | 1 | 2): number => h00 * p0[k] + h10 * m0[k] + h01 * p1[k] + h11 * m1[k];
    return [at(0), at(1), at(2)];
  },
  combine: (a, b, wa, wb) => [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb],
};

/** Index of the last key at or before `time` (keys sorted by time). */
function keyIndex(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((times[mid] ?? 0) <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Samples a key group at a time; undefined if it has no keys. */
export function sampleKeys<T>(group: KeyGroup<T>, time: number, ops: ValueOps<T>): T | undefined {
  const keys = group.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return undefined;
  if (keys.length === 1 || time <= first.time) return first.value;
  if (time >= last.time) return last.value;
  const i = keyIndex(
    keys.map((k) => k.time),
    time,
  );
  const a = keys[i];
  const b = keys[i + 1];
  if (!a || !b) return last.value;
  const span = b.time - a.time;
  const s = span > 0 ? (time - a.time) / span : 0;
  switch (group.interpolation) {
    case KeyType.constant:
      return a.value;
    case KeyType.quadratic:
      // A segment leaves its first key along that key's "backward" tangent and arrives at
      // the next along its "forward" one (nif.xml's names; NifSkope reads them so). The
      // vanilla UV scrolls rely on it: 0 to -1 with tangents -1 is a steady scroll.
      return ops.hermite(a.value, a.backward ?? a.value, b.value, b.forward ?? b.value, s);
    case KeyType.tbc: {
      // Kochanek-Bartels tangents from the neighbouring keys.
      const prev = keys[i - 1] ?? a;
      const next = keys[i + 2] ?? b;
      const tangent = (p: T, k: T, n: T, tbc: readonly number[] | undefined, out: boolean): T => {
        const [t, bias, c] = [tbc?.[0] ?? 0, tbc?.[1] ?? 0, tbc?.[2] ?? 0];
        const w1 = out
          ? ((1 - t) * (1 + bias) * (1 - c)) / 2
          : ((1 - t) * (1 + bias) * (1 + c)) / 2;
        const w2 = out
          ? ((1 - t) * (1 - bias) * (1 + c)) / 2
          : ((1 - t) * (1 - bias) * (1 - c)) / 2;
        return ops.combine(ops.combine(k, p, 1, -1), ops.combine(n, k, 1, -1), w1, w2);
      };
      const m0 = tangent(prev.value, a.value, b.value, a.tbc, true);
      const m1 = tangent(a.value, b.value, next.value, b.tbc, false);
      return ops.hermite(a.value, m0, b.value, m1, s);
    }
    default:
      return ops.lerp(a.value, b.value, s);
  }
}

function slerp(a: Quaternion, b: Quaternion, s: number): Quaternion {
  let [bw, bx, by, bz] = b;
  let dot = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
  if (dot < 0) {
    dot = -dot;
    [bw, bx, by, bz] = [-bw, -bx, -by, -bz];
  }
  let wa = 1 - s;
  let wb = s;
  if (dot < 0.9995) {
    const theta = Math.acos(dot);
    const sin = Math.sin(theta);
    wa = Math.sin((1 - s) * theta) / sin;
    wb = Math.sin(s * theta) / sin;
  }
  const q: Quaternion = [
    a[0] * wa + bw * wb,
    a[1] * wa + bx * wb,
    a[2] * wa + by * wb,
    a[3] * wa + bz * wb,
  ];
  const length = Math.hypot(...q) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Quaternion (w, x, y, z) of Euler angles applied X, then Y, then Z. */
function eulerQuaternion(x: number, y: number, z: number): Quaternion {
  const [cx, sx] = [Math.cos(x / 2), Math.sin(x / 2)];
  const [cy, sy] = [Math.cos(y / 2), Math.sin(y / 2)];
  const [cz, sz] = [Math.cos(z / 2), Math.sin(z / 2)];
  // q = qz * qy * qx
  return [
    cz * cy * cx + sz * sy * sx,
    cz * cy * sx - sz * sy * cx,
    cz * sy * cx + sz * cy * sx,
    sz * cy * cx - cz * sy * sx,
  ];
}

function rotationAt(data: TransformDataBlock, time: number): Quaternion | undefined {
  if (data.rotationType === KeyType.xyzRotation) {
    const [x, y, z] = data.xyzRotations.map((group) => sampleKeys(group, time, NUMBER_OPS) ?? 0);
    return eulerQuaternion(x ?? 0, y ?? 0, z ?? 0);
  }
  const keys = data.quaternionKeys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (!first || !last) return undefined;
  if (keys.length === 1 || time <= first.time) return first.value;
  if (time >= last.time) return last.value;
  const i = keyIndex(
    keys.map((k) => k.time),
    time,
  );
  const a = keys[i];
  const b = keys[i + 1];
  if (!a || !b) return last.value;
  if (data.rotationType === KeyType.constant) return a.value;
  const span = b.time - a.time;
  return slerp(a.value, b.value, span > 0 ? (time - a.time) / span : 0);
}

// --- Samplers from interpolators ------------------------------------------------------------

export function floatSource(file: NifFile, ref: Ref): FloatSource | undefined {
  const interpolator = file.blocks[ref];
  if (interpolator?.kind === 'float-interpolator') {
    const data = file.blocks[interpolator.data];
    if (data?.kind === 'float-data' && data.keys.keys.length > 0) {
      return { constant: interpolator.value, keys: data.keys };
    }
    return Math.abs(interpolator.value) < UNSET
      ? { constant: interpolator.value, keys: undefined }
      : undefined;
  }
  if (
    interpolator?.kind === 'blend-interpolator' &&
    typeof interpolator.value === 'number' &&
    Math.abs(interpolator.value) < UNSET
  ) {
    return { constant: interpolator.value, keys: undefined };
  }
  return undefined;
}

function vec3Source(file: NifFile, ref: Ref): Vec3Source | undefined {
  const interpolator = file.blocks[ref];
  if (interpolator?.kind !== 'point3-interpolator') return undefined;
  const data = file.blocks[interpolator.data];
  return {
    constant: interpolator.value,
    keys: data?.kind === 'pos-data' && data.keys.keys.length > 0 ? data.keys : undefined,
  };
}

export function boolSource(file: NifFile, ref: Ref): BoolSource | undefined {
  const interpolator = file.blocks[ref];
  if (interpolator?.kind !== 'bool-interpolator') return undefined;
  const data = file.blocks[interpolator.data];
  return {
    constant: interpolator.value,
    keys: data?.kind === 'bool-data' && data.keys.keys.length > 0 ? data.keys : undefined,
  };
}

function transformSource(file: NifFile, ref: Ref): TransformSource | undefined {
  const interpolator = file.blocks[ref];
  if (interpolator?.kind !== 'transform-interpolator') return undefined;
  const data = file.blocks[interpolator.data];
  const set = (v: number): boolean => Math.abs(v) < UNSET;
  return {
    translation: interpolator.translation.every(set) ? interpolator.translation : undefined,
    rotation: interpolator.rotation.every(set) ? interpolator.rotation : undefined,
    scale: set(interpolator.scale) ? interpolator.scale : undefined,
    data: data?.kind === 'transform-data' ? data : undefined,
  };
}

export function sampleFloat(source: FloatSource, time: number): number {
  return source.keys
    ? (sampleKeys(source.keys, time, NUMBER_OPS) ?? source.constant)
    : source.constant;
}

export function sampleVec3(source: Vec3Source, time: number): Vec3 {
  return source.keys
    ? (sampleKeys(source.keys, time, VEC3_OPS) ?? source.constant)
    : source.constant;
}

export function sampleBool(source: BoolSource, time: number): boolean {
  const keys = source.keys?.keys;
  if (!keys || keys.length === 0) return source.constant;
  const i = keyIndex(
    keys.map((k) => k.time),
    time,
  );
  return (keys[i]?.value ?? 0) !== 0;
}

export function sampleTransform(source: TransformSource, time: number): TransformSample {
  const data = source.data;
  if (!data) return source;
  return {
    translation: sampleKeys(data.translations, time, VEC3_OPS) ?? source.translation,
    rotation: rotationAt(data, time) ?? source.rotation,
    scale: sampleKeys(data.scales, time, NUMBER_OPS) ?? source.scale,
  };
}

// --- Building the tracks ------------------------------------------------------------------

export function timingOf(controller: {
  frequency: number;
  phase: number;
  startTime: number;
  stopTime: number;
  flags: number;
}): Timing {
  return {
    frequency: controller.frequency,
    phase: controller.phase,
    start: controller.startTime,
    stop: controller.stopTime,
    cycle: (controller.flags >> 1) & 3,
  };
}

/** A track for a controller acting on its target with an interpolator. */
function trackFor(
  file: NifFile,
  controller: ControllerBlock,
  target: Ref,
  interpolator: Ref,
  timing: Timing,
): AnimationTrack | undefined {
  switch (controller.type) {
    case 'NiTransformController':
    case 'NiMultiTargetTransformController': {
      const source = transformSource(file, interpolator);
      return source && { kind: 'transform', block: target, timing, source };
    }
    case 'NiVisController': {
      const source = boolSource(file, interpolator);
      return source && { kind: 'visibility', block: target, timing, source };
    }
    case 'BSEffectShaderPropertyFloatController':
    case 'BSLightingShaderPropertyFloatController': {
      const source = floatSource(file, interpolator);
      return (
        source && {
          kind: 'shader-float',
          shader: target,
          variable: controller.variable,
          timing,
          source,
        }
      );
    }
    case 'BSEffectShaderPropertyColorController':
    case 'BSLightingShaderPropertyColorController': {
      const source = vec3Source(file, interpolator);
      return (
        source && {
          kind: 'shader-color',
          shader: target,
          variable: controller.variable,
          timing,
          source,
        }
      );
    }
    case 'BSNiAlphaPropertyTestRefController': {
      const source = floatSource(file, interpolator);
      return source && { kind: 'alpha-test', alpha: target, timing, source };
    }
    default:
      return undefined;
  }
}

function objectByName(file: NifFile, name: string): Ref {
  if (name === '') return -1;
  return file.blocks.findIndex((block) => 'transform' in block && block.name === name);
}

function sequenceTracks(file: NifFile, sequence: ControllerSequenceBlock): AnimationTrack[] {
  const timing = sequenceTiming(sequence);
  const tracks: AnimationTrack[] = [];
  for (const block of sequence.blocks) {
    const controller = file.blocks[block.controller];
    if (controller?.kind !== 'controller') continue;
    // Transforms name their node; properties are the controller's own target.
    const target =
      controller.type === 'NiMultiTargetTransformController' ||
      controller.type === 'NiTransformController'
        ? objectByName(file, block.nodeName)
        : controller.target;
    if (target < 0) continue;
    const track = trackFor(file, controller, target, block.interpolator, timing);
    if (track) tracks.push(track);
  }
  return tracks;
}

/**
 * The Havok Behavior project a mesh names on its root (BSBehaviorGraphExtraData), as a path
 * under meshes\, or undefined.
 */
export function behaviorGraphPath(file: NifFile): string | undefined {
  for (const root of file.roots) {
    const node = file.blocks[root];
    if (!node || !('extraData' in node)) continue;
    for (const ref of node.extraData) {
      const extra = file.blocks[ref];
      if (extra?.kind === 'behavior-graph-extra-data' && extra.graph !== '') {
        return `meshes\\${extra.graph}`.toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * The sequence of a controller manager that plays when the object is placed, for meshes
 * without a behavior graph (the graph decides otherwise).
 */
export function idleSequence(
  file: NifFile,
  sequences: readonly Ref[],
): ControllerSequenceBlock | undefined {
  const blocks = sequences
    .map((ref) => file.blocks[ref])
    .filter((s): s is ControllerSequenceBlock => s?.kind === 'controller-sequence');
  return IDLE_SEQUENCES.map((name) => blocks.find((s) => s.name.toLowerCase() === name)).find(
    (s) => s !== undefined,
  );
}

/** Timing of a sequence (its controlled blocks run on the sequence's clock). */
export function sequenceTiming(sequence: ControllerSequenceBlock): Timing {
  return {
    frequency: sequence.frequency,
    phase: 0,
    start: sequence.startTime,
    stop: sequence.stopTime,
    cycle: sequence.cycleType,
  };
}

/** The scene graph of a model: each object's parent and rest transform. */
function sceneGraph(file: NifFile): {
  parents: Map<Ref, Ref>;
  transforms: Map<Ref, NifTransform>;
} {
  const parents = new Map<Ref, Ref>();
  const transforms = new Map<Ref, NifTransform>();
  file.blocks.forEach((block, ref) => {
    if (!('transform' in block)) return;
    transforms.set(ref, block.transform);
    if (block.kind === 'node') for (const child of block.children) parents.set(child, ref);
  });
  return { parents, transforms };
}

/**
 * The named sequences of a model's controller managers, or undefined if it has none. Without
 * a behavior graph the idle one is left out (it plays on its own, see buildAnimation); with
 * one, all of them are kept, also those that only send events by their text keys.
 */
export function buildSequences(file: NifFile, graphDriven = false): ModelSequences | undefined {
  const byName = new Map<string, ModelSequence>();
  for (const block of file.blocks) {
    if (block.kind !== 'controller-manager') continue;
    const idle = graphDriven ? undefined : idleSequence(file, block.sequences);
    for (const ref of block.sequences) {
      const sequence = file.blocks[ref];
      if (sequence?.kind !== 'controller-sequence' || sequence === idle) continue;
      const tracks = sequenceTracks(file, sequence);
      const keys = file.blocks[sequence.textKeys];
      const textKeys = keys?.kind === 'text-keys' ? keys.keys : [];
      if (tracks.length === 0 && !(graphDriven && textKeys.length > 0)) continue;
      const frequency = sequence.frequency || 1;
      byName.set(sequence.name.toLowerCase(), {
        tracks,
        duration: Math.max(0, (sequence.stopTime - sequence.startTime) / frequency),
        start: sequence.startTime,
        stop: sequence.stopTime,
        frequency,
        cycle: sequence.cycleType,
        textKeys,
      });
    }
  }
  if (byName.size === 0) return undefined;
  const objects = new Map<string, Ref>();
  file.blocks.forEach((block, ref) => {
    if ('transform' in block && 'name' in block && block.name !== '') objects.set(block.name, ref);
  });
  return { byName, ...sceneGraph(file), roots: file.roots, objects };
}

/** Where a sequence playback puts the model's objects at `seconds` (renderer clock). */
export function playSequence(
  sequences: ModelSequences,
  playback: Playback,
  seconds: number,
): AnimationFrame | undefined {
  const sequence =
    playback.sequence === undefined ? undefined : sequences.byName.get(playback.sequence);
  if (!sequence) return undefined;
  return animateTracks(sequences, sequence.tracks, seconds - playback.start);
}

/**
 * A scene-graph object's model-space matrix in a frame (moved), or at rest. Undefined for
 * unknown objects.
 */
export function objectWorld(
  graph: Pick<ModelSequences, 'parents' | 'transforms' | 'roots'>,
  frame: AnimationFrame | undefined,
  ref: Ref,
): Mat4 | undefined {
  const moved = frame?.worlds.get(ref);
  if (moved) return moved;
  if (!graph.transforms.has(ref)) return undefined;
  const roots = new Set(graph.roots);
  const chain: Ref[] = [];
  for (let r: Ref | undefined = ref; r !== undefined; r = graph.parents.get(r)) chain.unshift(r);
  let world = fromNifTransform([0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1);
  for (const r of chain) {
    const above = frame?.worlds.get(r);
    if (above) {
      world = above;
      continue;
    }
    const transform = graph.transforms.get(r);
    // As for every model, the root's own transform is not used.
    if (!transform || (roots.has(r) && graph.parents.get(r) === undefined)) continue;
    world = multiply(
      world,
      fromNifTransform(transform.translation, transform.rotation, transform.scale),
    );
  }
  return world;
}

/**
 * The animation of a model, or undefined if nothing in it moves: controllers that play on
 * their own, and the idle sequence unless a behavior graph decides what plays.
 */
export function buildAnimation(file: NifFile, graphDriven = false): ModelAnimation | undefined {
  const tracks: AnimationTrack[] = [];
  file.blocks.forEach((block) => {
    if (block.kind === 'controller-manager') {
      if (graphDriven) return;
      const idle = idleSequence(file, block.sequences);
      if (idle) tracks.push(...sequenceTracks(file, idle));
      return;
    }
    if (block.kind !== 'controller') return;
    // Active controllers that a manager does not drive play on their own.
    if ((block.flags & ACTIVE) === 0 || (block.flags & MANAGER_CONTROLLED) !== 0) return;
    if (block.target < 0 || block.interpolator < 0) return;
    const track = trackFor(file, block, block.target, block.interpolator, timingOf(block));
    if (track) tracks.push(track);
  });
  if (tracks.length === 0) return undefined;
  return { tracks, ...sceneGraph(file), roots: file.roots };
}

/** Quaternion (w, x, y, z) to a row-major 3×3 rotation (as NIF transforms store it). */
function quaternionRotation(q: Quaternion): number[] {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

/** Evaluates a model's animation at a moment (seconds since the scene started). */
export function animate(animation: ModelAnimation, seconds: number): AnimationFrame {
  return animateTracks(animation, animation.tracks, seconds);
}

/**
 * Evaluates layers of tracks over a model's scene graph (the model's own controllers and the
 * sequences its behavior graph plays, each at its own moment). Layers without a weight set
 * their values outright, later ones winning. Weighted layers blend as Gamebryo's blend
 * interpolators do: where several animate the same value, their weighted mean (weights
 * normalised; a value one sequence alone animates is that sequence's, whatever its weight),
 * rotations as a normalised weighted sum of aligned quaternions, a visibility the heaviest
 * one's; they override the unweighted layers.
 */
export function animateLayers(
  animation: Pick<ModelAnimation, 'parents' | 'transforms' | 'roots'>,
  layers: readonly AnimationLayer[],
): AnimationFrame {
  return evaluate(
    animation,
    layers.flatMap((layer) =>
      layer.tracks.map((track) => ({
        track,
        seconds: layer.seconds,
        ...(layer.weight !== undefined && { weight: layer.weight }),
      })),
    ),
  );
}

/** Weighted values of one target, normalised when read. */
class WeightedSum {
  readonly sum: number[];
  total = 0;
  constructor(size: number) {
    this.sum = new Array<number>(size).fill(0);
  }
  add(values: readonly number[], weight: number): void {
    for (let i = 0; i < this.sum.length; i++) {
      this.sum[i] = (this.sum[i] ?? 0) + (values[i] ?? 0) * weight;
    }
    this.total += weight;
  }
  mean(): number[] {
    return this.sum.map((value) => value / (this.total || 1));
  }
}

/** Weighted rotations (w, x, y, z), each aligned with the first so opposite signs add up. */
class WeightedRotation {
  readonly #sum = [0, 0, 0, 0];
  #first: readonly number[] | undefined;
  add(q: readonly number[], weight: number): void {
    this.#first ??= q;
    const first = this.#first;
    const dot = q.reduce((sum, value, i) => sum + value * (first[i] ?? 0), 0);
    const sign = dot < 0 ? -weight : weight;
    for (let i = 0; i < 4; i++) this.#sum[i] = (this.#sum[i] ?? 0) + (q[i] ?? 0) * sign;
  }
  mean(): Quaternion {
    const [w, x, y, z] = this.#sum;
    const length = Math.hypot(w ?? 0, x ?? 0, y ?? 0, z ?? 0) || 1;
    return [(w ?? 1) / length, (x ?? 0) / length, (y ?? 0) / length, (z ?? 0) / length];
  }
}

/** Evaluates tracks over a model's scene graph at a moment. */
function animateTracks(
  animation: Pick<ModelAnimation, 'parents' | 'transforms' | 'roots'>,
  tracks: readonly AnimationTrack[],
  seconds: number,
): AnimationFrame {
  return evaluate(
    animation,
    tracks.map((track) => ({ track, seconds })),
  );
}

function evaluate(
  animation: Pick<ModelAnimation, 'parents' | 'transforms' | 'roots'>,
  timed: readonly {
    readonly track: AnimationTrack;
    readonly seconds: number;
    readonly weight?: number;
  }[],
): AnimationFrame {
  const locals = new Map<Ref, NifTransform>();
  const hidden = new Set<Ref>();
  const shaderFloats = new Map<Ref, Map<number, number>>();
  const shaderColors = new Map<Ref, Map<number, Vec3>>();
  const alphaTest = new Map<Ref, number>();
  // Weighted layers: per target, blended after the outright ones.
  const blended = new Map<string, WeightedSum>();
  const rotations = new Map<Ref, WeightedRotation>();
  const visibility = new Map<Ref, { weight: number; visible: boolean }>();
  const weighted = (key: string, size: number): WeightedSum => {
    let entry = blended.get(key);
    if (!entry) blended.set(key, (entry = new WeightedSum(size)));
    return entry;
  };
  for (const { track, seconds, weight } of timed) {
    const time = controllerTime(track.timing, seconds);
    if (weight !== undefined) {
      if (!(weight > 0)) continue;
      switch (track.kind) {
        case 'transform': {
          const sample = sampleTransform(track.source, time);
          if (sample.translation) {
            weighted(`t${String(track.block)}`, 3).add(sample.translation, weight);
          }
          if (sample.rotation) {
            let rotation = rotations.get(track.block);
            if (!rotation) rotations.set(track.block, (rotation = new WeightedRotation()));
            rotation.add(sample.rotation, weight);
          }
          if (sample.scale !== undefined) {
            weighted(`s${String(track.block)}`, 1).add([sample.scale], weight);
          }
          break;
        }
        case 'visibility': {
          const before = visibility.get(track.block);
          if (!before || weight > before.weight) {
            visibility.set(track.block, { weight, visible: sampleBool(track.source, time) });
          }
          break;
        }
        case 'shader-float':
          weighted(`f${String(track.shader)}:${String(track.variable)}`, 1).add(
            [sampleFloat(track.source, time)],
            weight,
          );
          break;
        case 'shader-color':
          weighted(`c${String(track.shader)}:${String(track.variable)}`, 3).add(
            sampleVec3(track.source, time),
            weight,
          );
          break;
        case 'alpha-test':
          weighted(`a${String(track.alpha)}`, 1).add([sampleFloat(track.source, time)], weight);
          break;
      }
      continue;
    }
    switch (track.kind) {
      case 'transform': {
        const rest = animation.transforms.get(track.block);
        if (!rest) break;
        const sample = sampleTransform(track.source, time);
        locals.set(track.block, {
          translation: sample.translation ?? rest.translation,
          rotation: sample.rotation ? quaternionRotation(sample.rotation) : rest.rotation,
          scale: sample.scale ?? rest.scale,
        });
        break;
      }
      case 'visibility':
        if (sampleBool(track.source, time)) hidden.delete(track.block);
        else hidden.add(track.block);
        break;
      case 'shader-float': {
        const values = shaderFloats.get(track.shader) ?? new Map<number, number>();
        values.set(track.variable, sampleFloat(track.source, time));
        shaderFloats.set(track.shader, values);
        break;
      }
      case 'shader-color': {
        const values = shaderColors.get(track.shader) ?? new Map<number, Vec3>();
        values.set(track.variable, sampleVec3(track.source, time));
        shaderColors.set(track.shader, values);
        break;
      }
      case 'alpha-test':
        alphaTest.set(track.alpha, sampleFloat(track.source, time));
        break;
    }
  }
  // The weighted layers' means.
  const transformBlocks = new Set<Ref>(rotations.keys());
  for (const key of blended.keys()) {
    if (key.startsWith('t') || key.startsWith('s')) transformBlocks.add(Number(key.slice(1)));
  }
  for (const block of transformBlocks) {
    const rest = locals.get(block) ?? animation.transforms.get(block);
    if (!rest) continue;
    const translation = blended.get(`t${String(block)}`)?.mean();
    const scale = blended.get(`s${String(block)}`)?.mean()[0];
    const rotation = rotations.get(block)?.mean();
    locals.set(block, {
      translation: translation
        ? [translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0]
        : rest.translation,
      rotation: rotation ? quaternionRotation(rotation) : rest.rotation,
      scale: scale ?? rest.scale,
    });
  }
  for (const [block, { visible }] of visibility) {
    if (visible) hidden.delete(block);
    else hidden.add(block);
  }
  for (const [key, entry] of blended) {
    const mean = entry.mean();
    if (key.startsWith('f') || key.startsWith('c')) {
      const [shader, variable] = key.slice(1).split(':').map(Number);
      if (shader === undefined || variable === undefined) continue;
      if (key.startsWith('f')) {
        const values = shaderFloats.get(shader) ?? new Map<number, number>();
        values.set(variable, mean[0] ?? 0);
        shaderFloats.set(shader, values);
      } else {
        const values = shaderColors.get(shader) ?? new Map<number, Vec3>();
        values.set(variable, [mean[0] ?? 0, mean[1] ?? 0, mean[2] ?? 0]);
        shaderColors.set(shader, values);
      }
    } else if (key.startsWith('a')) {
      alphaTest.set(Number(key.slice(1)), mean[0] ?? 0);
    }
  }
  // World matrices of the moved objects and everything below them.
  const worlds = new Map<Ref, Mat4>();
  if (locals.size > 0) {
    const roots = new Set(animation.roots);
    const affected = (ref: Ref): boolean => {
      for (let r: Ref | undefined = ref; r !== undefined; r = animation.parents.get(r)) {
        if (locals.has(r)) return true;
      }
      return false;
    };
    const worldOf = (ref: Ref): Mat4 => {
      const cached = worlds.get(ref);
      if (cached) return cached;
      const transform = locals.get(ref) ?? animation.transforms.get(ref);
      const parent = animation.parents.get(ref);
      // As for every model, the root's own transform is not used.
      const local =
        !transform || (roots.has(ref) && parent === undefined)
          ? fromNifTransform([0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], 1)
          : fromNifTransform(transform.translation, transform.rotation, transform.scale);
      const world = parent === undefined ? local : multiply(worldOf(parent), local);
      worlds.set(ref, world);
      return world;
    };
    for (const ref of animation.transforms.keys()) if (affected(ref)) worldOf(ref);
  }
  return { worlds, hidden, shaderFloats, shaderColors, alphaTest };
}
