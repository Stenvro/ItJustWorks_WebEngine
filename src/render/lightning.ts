// Procedural lightning (BSProceduralLightningController): the bolts of shock spells, their
// explosions and impacts, built at run time into the empty BSTriShape below the controller's
// target node, the way the engine builds them (observed in the original; docs/rendering.md,
// "Procedural lightning"). Each controller is a particle system of its model (particle-data.ts)
// whose source is a LightningSimulation: the scene draws its bolts' ribbons with the shape's
// effect material, through the particle pipeline (particle.wgsl, vs_ribbon).
// Platform-independent (no GPU).

import type { NifFile } from '../formats/nif/nif.ts';
import type {
  ControllerSequenceBlock,
  LightningControllerBlock,
  Ref,
} from '../formats/nif/types.ts';
import {
  boolSource,
  controllerTime,
  floatSource,
  idleSequence,
  sampleBool,
  sampleFloat,
  sequenceTiming,
  timingOf,
  type Timing,
} from './animation.ts';
import { identity, multiply, type Mat4 } from './math.ts';
import type { AlphaState, PartMaterial } from './model-data.ts';
import type {
  LightningParam,
  LightningSettings,
  ParticleModifiers,
  ParticleSystemData,
  ParticleTrack,
} from './particle-data.ts';
import {
  PARTICLE_FLOATS,
  random,
  type ParticleContext,
  type ParticleSource,
} from './particle-sim.ts';

/** The controller's interpolators in file order, and the ids its sequences name them by. */
const INTERPOLATORS: readonly (readonly [LightningParam, string])[] = [
  ['generation', 'generation'],
  ['mutation', 'mutation'],
  ['subdivisions', 'subdivision'],
  ['branches', 'numbranches'],
  ['branchesVariation', 'numbranchesvar'],
  ['length', 'length'],
  ['lengthVariation', 'lengthvar'],
  ['width', 'width'],
  ['arcOffset', 'arcoffset'],
];
const BOOL_PARAMS: ReadonlySet<LightningParam> = new Set(['generation', 'mutation']);
const MANAGER_CONTROLLED = 0x20;
/** The engine builds bolts of 2^1 to 2^12 segments only. */
const MAX_SUBDIVISIONS = 12;

const NO_MODIFIERS: ParticleModifiers = {
  spawnOnDeath: false,
  spawn: undefined,
  gravity: [],
  drag: [],
  bombs: [],
  colliders: [],
  rotation: undefined,
  color: undefined,
  scales: undefined,
  subTexture: undefined,
  recycleBound: undefined,
  inheritVelocity: undefined,
  wind: 0,
  lod: undefined,
  inactive: [],
};

/**
 * The shapes the model's lightning controllers build into (empty in the file: drawn as
 * lightning, not as parts), each with its controller.
 */
export function lightningShapes(file: NifFile): Map<Ref, Ref> {
  const shapes = new Map<Ref, Ref>();
  file.blocks.forEach((block, ref) => {
    if (block.kind !== 'lightning-controller') return;
    const shape = templateShape(file, block.target);
    if (shape !== undefined) shapes.set(shape, ref);
  });
  return shapes;
}

/**
 * A lightning controller as a particle system of its model (`block`: the shape it builds into,
 * at `world` in the model). `material` and `alpha`: the shape's shader and alpha property as
 * the model reads them.
 */
export function buildLightningSystem(
  file: NifFile,
  controller: Ref,
  shape: Ref,
  world: Mat4,
  material: PartMaterial | undefined,
  alpha: AlphaState | undefined,
  graphDriven: boolean,
): ParticleSystemData | undefined {
  const block = file.blocks[controller];
  const tri = file.blocks[shape];
  if (block?.kind !== 'lightning-controller' || tri?.kind !== 'tri-shape') return undefined;
  const manager = file.blocks.find((candidate) => candidate.kind === 'controller-manager');
  const sequences = manager?.kind === 'controller-manager' ? manager.sequences : [];
  const managed = (block.flags & MANAGER_CONTROLLED) !== 0;
  // A manager drives it: its values come from the sequence playing (the idle one, or those
  // the model's behavior graph plays); else its own interpolators play from when it loads.
  const idle = managed && !graphDriven ? idleSequence(file, sequences) : undefined;
  const tracks: ParticleTrack[] = managed
    ? idle
      ? sequenceTracks(file, controller, idle)
      : []
    : INTERPOLATORS.flatMap(([param], index) =>
        track(file, param, block.interpolators[index] ?? -1, timingOf(block)),
      );
  const byName = new Map<string, readonly ParticleTrack[]>();
  if (managed && graphDriven) {
    for (const sequenceRef of sequences) {
      const sequence = file.blocks[sequenceRef];
      if (sequence?.kind !== 'controller-sequence') continue;
      const found = sequenceTracks(file, controller, sequence);
      if (found.length > 0) byName.set(sequence.name.toLowerCase(), found);
    }
  }
  const settings = lightningSettings(block);
  return {
    name: tri.name,
    block: shape,
    worldSpace: false,
    maxParticles: Math.max(1, maxRibbons(settings)),
    subtextures: [[0, 0, 1, 1]],
    aspectRatio: 1,
    velocityOriented: false,
    material,
    alpha,
    shader: tri.shaderProperty,
    alphaProperty: tri.alphaProperty,
    strip: undefined,
    lightning: settings,
    emitters: [],
    modifiers: NO_MODIFIERS,
    tracks,
    sequenceTracks: byName,
    objects: new Map([[shape, world]]),
    billboards: new Map(),
  };
}

/** The shape a controller builds into: its target node's first child (a BSTriShape). */
function templateShape(file: NifFile, target: Ref): Ref | undefined {
  const node = file.blocks[target];
  const first = node?.kind === 'node' ? node.children[0] : undefined;
  return first !== undefined && file.blocks[first]?.kind === 'tri-shape' ? first : undefined;
}

function lightningSettings(block: LightningControllerBlock): LightningSettings {
  return {
    subdivisions: block.subdivisions,
    branches: block.branches,
    branchesVariation: block.branchesVariation,
    length: block.length,
    lengthVariation: block.lengthVariation,
    width: block.width,
    childWidthMultiplier: block.childWidthMultiplier,
    arcOffset: block.arcOffset,
    fadeMainBolt: block.fadeMainBolt,
    fadeChildBolts: block.fadeChildBolts,
    animateArcOffset: block.animateArcOffset,
  };
}

function track(file: NifFile, param: LightningParam, ref: Ref, timing: Timing): ParticleTrack[] {
  if (BOOL_PARAMS.has(param)) {
    const source = boolSource(file, ref);
    return source ? [{ kind: 'bool', target: '', param, timing, source }] : [];
  }
  const source = floatSource(file, ref);
  return source ? [{ kind: 'float', target: '', param, timing, source }] : [];
}

/** A sequence's tracks for the controller `controller`, by the interpolator ids it names. */
function sequenceTracks(
  file: NifFile,
  controller: Ref,
  sequence: ControllerSequenceBlock,
): ParticleTrack[] {
  const timing = sequenceTiming(sequence);
  return sequence.blocks.flatMap((block) => {
    if (block.controller !== controller) return [];
    const id = block.interpolatorId.toLowerCase();
    const param = INTERPOLATORS.find(([, name]) => name === id)?.[0];
    return param ? track(file, param, block.interpolator, timing) : [];
  });
}

// --- The bolts --------------------------------------------------------------------------------

/** One bolt of a lightning: the main one or a branch of another. */
interface Bolt {
  /** The bolt it branches from (an earlier one), or -1 for a main bolt. */
  readonly parent: number;
  /** Subdivision level: 2^level segments. */
  readonly level: number;
  /** How many branchings below a main bolt (0: a main bolt). */
  readonly depth: number;
  /** Its centre line, segments + 1 points (x, y, z), in the shape's space. */
  points: Float32Array;
  halfWidth: number;
}

/** The parameters of one generation (the settings, as the controller's tracks have them now). */
interface Shape {
  readonly length: number;
  readonly lengthVariation: number;
  readonly width: number;
  readonly childWidthMultiplier: number;
  readonly arcOffset: number;
}

/**
 * The tree of bolts the engine grows for a lightning: a main bolt of 2^subdivisions segments,
 * each bolt with between branches − variation (at least 0) and branches + variation branches
 * of one level fewer, their own branches with half the branches and variation. Parents come
 * before their branches.
 */
export function growBolts(
  subdivisions: number,
  branches: number,
  variation: number,
  next: () => number,
): Bolt[] {
  const bolts: Bolt[] = [];
  const grow = (parent: number, level: number, count: number, spread: number, depth: number) => {
    const index = bolts.length;
    bolts.push({ parent, level, depth, points: new Float32Array(0), halfWidth: 0 });
    const least = Math.max(0, count - spread);
    const children = least + Math.floor(next() * (count + spread - least + 1));
    for (let i = 0; i < children; i++) {
      grow(index, Math.max(0, level - 1), count >> 1, spread >> 1, depth + 1);
    }
  };
  grow(-1, subdivisions, branches, variation, 0);
  return bolts;
}

/** The most bolts a tree can grow and the ribbons they draw (two per segment). */
function maxRibbons(settings: LightningSettings): number {
  const count = (level: number, branches: number, variation: number): number => {
    const children = branches + variation;
    let segments = 2 ** level;
    for (let i = 0; i < children; i++) {
      segments += count(Math.max(0, level - 1), branches >> 1, variation >> 1);
    }
    return segments;
  };
  const level = Math.min(MAX_SUBDIVISIONS, Math.max(1, settings.subdivisions));
  return 2 * count(level, settings.branches, settings.branchesVariation);
}

/**
 * Lays out every bolt anew (a generation, or a mutation of the same tree): along the shape's Y
 * axis, each 0.5^depth × length ± 0.25^depth × length variation long, 0.5^depth × arc offset
 * astray (each half of a stretch again half as far, along a random direction across the bolt:
 * a tent over the stretch, so its ends stay on the line), childWidthMultiplier^depth × width
 * wide. A branch starts at a random point of the first half of its parent.
 */
export function layOutBolts(bolts: readonly Bolt[], shape: Shape, next: () => number): void {
  for (const bolt of bolts) {
    const segments = 2 ** bolt.level;
    const depth = bolt.depth;
    const length =
      0.5 ** depth * shape.length + 0.25 ** depth * (next() * 2 - 1) * shape.lengthVariation;
    bolt.halfWidth = shape.childWidthMultiplier ** depth * shape.width * 0.5;
    const offsets = new Float32Array((segments + 1) * 2);
    displace(offsets, 0, segments, 0.5 ** depth * shape.arcOffset, next);
    let origin: readonly [number, number, number] = [0, 0, 0];
    const parent = bolts[bolt.parent];
    if (parent) {
      const half = Math.max(1, 2 ** parent.level / 2);
      const at = Math.floor(next() * half) * 3;
      origin = [parent.points[at] ?? 0, parent.points[at + 1] ?? 0, parent.points[at + 2] ?? 0];
    }
    const points = new Float32Array((segments + 1) * 3);
    for (let k = 0; k <= segments; k++) {
      points[k * 3] = origin[0] + (offsets[k * 2] ?? 0);
      points[k * 3 + 1] = origin[1] + (k / segments) * length;
      points[k * 3 + 2] = origin[2] + (offsets[k * 2 + 1] ?? 0);
    }
    bolt.points = points;
  }
}

/**
 * Moves the points between `from` and `to` (x, z pairs) astray along a random direction, most
 * in the middle (a tent), `amplitude` at most; then each half again at half the amplitude.
 */
function displace(
  offsets: Float32Array,
  from: number,
  to: number,
  amplitude: number,
  next: () => number,
): void {
  let start = from;
  let reach = amplitude;
  for (;;) {
    const angle = next() * 2 * Math.PI;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const span = to - start;
    for (let i = 1; i < span; i++) {
      const tent = 1 - 2 * Math.abs(i / span - 0.5);
      const at = (start + i) * 2;
      offsets[at] = (offsets[at] ?? 0) + tent * dx * reach;
      offsets[at + 1] = (offsets[at + 1] ?? 0) + tent * dz * reach;
    }
    const middle = start + (span >> 1);
    if (to <= middle + 1) return;
    reach *= 0.5;
    displace(offsets, start, middle, reach, next);
    start = middle;
  }
}

/** The arc offset changed between mutations: every bolt strays `ratio` times as far. */
export function scaleArc(bolts: readonly Bolt[], ratio: number): void {
  for (const bolt of bolts) {
    const points = bolt.points;
    for (let i = 0; i < points.length; i += 3) {
      points[i] = (points[i] ?? 0) * ratio;
      points[i + 2] = (points[i + 2] ?? 0) * ratio;
    }
  }
}

/**
 * How opaque a bolt is at point `k` of `segments`: a main bolt is clear at both ends, a branch
 * at its end only; with its fade flag it thins out towards its end (1 − (k / segments)²).
 */
export function boltAlpha(main: boolean, fades: boolean, k: number, segments: number): number {
  if (k === 0) return main ? 0 : 1;
  if (k >= segments) return 0;
  return fades ? 1 - (k * k) / (segments * segments) : 1;
}

// --- The simulation ---------------------------------------------------------------------------

export interface LightningOptions {
  /**
   * A beam's stretch (BeamProjectile): the shape's Y axis is scaled by this (the beam's length
   * over its model's BeamEnd distance), read every frame.
   */
  readonly stretch?: () => number;
  /** How opaque the bolts are now (a beam fading out), read every frame. */
  readonly opacity?: () => number;
}

/**
 * A lightning controller at work on one placed model: while its generation track is on it
 * keeps a tree of bolts, lays them out anew whenever its mutation track flips, and between
 * mutations scales how far they stray with the animated arc offset. Writes two crossed
 * ribbons per segment (the engine's shape: one across the shape's X axis, one across its Z).
 */
export class LightningSimulation implements ParticleSource {
  readonly data: ParticleSystemData;
  count = 0;
  readonly center: [number, number, number] = [0, 0, 0];
  radius = 0;
  readonly #settings: LightningSettings;
  readonly #options: LightningOptions;
  readonly #next: () => number;
  readonly #values = new Map<LightningParam, number>();
  #bolts: Bolt[] | undefined;
  #mutation = 0;
  #arc = 0;
  /** The shape's world matrix this update (stretched). */
  readonly #world = identity();

  constructor(data: ParticleSystemData, seed: number, options: LightningOptions = {}) {
    this.data = data;
    this.#settings = data.lightning ?? {
      subdivisions: 0,
      branches: 0,
      branchesVariation: 0,
      length: 0,
      lengthVariation: 0,
      width: 0,
      childWidthMultiplier: 1,
      arcOffset: 0,
      fadeMainBolt: false,
      fadeChildBolts: false,
      animateArcOffset: false,
    };
    this.#options = options;
    this.#next = random(seed);
  }

  get instanceCount(): number {
    return this.count;
  }

  update(context: ParticleContext): void {
    this.#sample(context);
    const values = this.#values;
    const settings = this.#settings;
    const generating = (values.get('generation') ?? 0) !== 0;
    if (!generating) {
      // Its geometry goes; the next generation grows a new tree.
      this.#bolts = undefined;
      this.count = 0;
      return;
    }
    const mutation = values.get('mutation') ?? 0;
    const arc = values.get('arcOffset') ?? settings.arcOffset;
    if (!this.#bolts) {
      const subdivisions = Math.round(values.get('subdivisions') ?? settings.subdivisions);
      // The engine builds nothing of a bolt subdivided less than once or more than 12 times.
      if (subdivisions < 1 || subdivisions > MAX_SUBDIVISIONS) return;
      this.#bolts = growBolts(
        subdivisions,
        Math.round(values.get('branches') ?? settings.branches),
        Math.round(values.get('branchesVariation') ?? settings.branchesVariation),
        this.#next,
      );
      layOutBolts(this.#bolts, this.#shape(arc), this.#next);
      this.#mutation = mutation;
      this.#arc = arc;
    } else if (mutation !== this.#mutation) {
      this.#mutation = mutation;
      layOutBolts(this.#bolts, this.#shape(arc), this.#next);
      this.#arc = arc;
    } else if (settings.animateArcOffset && arc !== this.#arc && this.#arc !== 0) {
      scaleArc(this.#bolts, arc / this.#arc);
      this.#arc = arc;
    }
    let ribbons = 0;
    for (const bolt of this.#bolts) ribbons += 2 * 2 ** bolt.level;
    this.count = ribbons;
    this.#place(context);
  }

  write(out: Float32Array, offset: number, context: ParticleContext): number {
    const bolts = this.#bolts;
    if (!bolts) return 0;
    this.#place(context);
    const m = this.#world;
    const opacity = Math.max(0, Math.min(1, this.#options.opacity?.() ?? 1));
    const settings = this.#settings;
    const capacity = Math.floor((out.length - offset) / PARTICLE_FLOATS);
    // The ribbons' sides: the shape's X and Z axes (not stretched with its Y).
    const ax = [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
    const az = [m[8] ?? 0, m[9] ?? 0, m[10] ?? 0];
    const point = (p: Float32Array, k: number, target: number[]): void => {
      const x = p[k * 3] ?? 0;
      const y = p[k * 3 + 1] ?? 0;
      const z = p[k * 3 + 2] ?? 0;
      target[0] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
      target[1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
      target[2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
    };
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    let written = 0;
    for (const bolt of bolts) {
      const segments = 2 ** bolt.level;
      const main = bolt.parent < 0;
      const fades = main ? settings.fadeMainBolt : settings.fadeChildBolts;
      const w = bolt.halfWidth;
      point(bolt.points, 0, a);
      for (let k = 0; k < segments && written + 2 <= capacity; k++) {
        point(bolt.points, k + 1, b);
        const from = boltAlpha(main, fades, k, segments) * opacity;
        const to = boltAlpha(main, fades, k + 1, segments) * opacity;
        // One ribbon across X (u 0 at −X), one across Z (u 0 at +Z).
        for (const side of [
          [ax[0] ?? 0, ax[1] ?? 0, ax[2] ?? 0],
          [-(az[0] ?? 0), -(az[1] ?? 0), -(az[2] ?? 0)],
        ]) {
          const base = offset + written * PARTICLE_FLOATS;
          out[base] = a[0] ?? 0;
          out[base + 1] = a[1] ?? 0;
          out[base + 2] = a[2] ?? 0;
          out[base + 3] = from;
          out[base + 4] = 1;
          out[base + 5] = 1;
          out[base + 6] = 1;
          out[base + 7] = to;
          out[base + 8] = k / segments;
          out[base + 9] = (k + 1) / segments;
          out[base + 10] = (side[0] ?? 0) * w;
          out[base + 11] = (side[1] ?? 0) * w;
          out[base + 12] = (b[0] ?? 0) - (a[0] ?? 0);
          out[base + 13] = (b[1] ?? 0) - (a[1] ?? 0);
          out[base + 14] = (b[2] ?? 0) - (a[2] ?? 0);
          out[base + 15] = (side[2] ?? 0) * w;
          written++;
        }
        a[0] = b[0] ?? 0;
        a[1] = b[1] ?? 0;
        a[2] = b[2] ?? 0;
      }
    }
    return written;
  }

  /** The tracks' values now (free ones on the model's clock, managed ones on their sequence's). */
  #sample(context: ParticleContext): void {
    const values = this.#values;
    values.clear();
    const apply = (track: ParticleTrack, seconds: number): void => {
      if (track.param === 'birthRate') return;
      const time = controllerTime(track.timing, seconds);
      const value =
        track.kind === 'float'
          ? sampleFloat(track.source, time)
          : sampleBool(track.source, time)
            ? 1
            : 0;
      values.set(track.param as LightningParam, value);
    };
    for (const track of this.data.tracks) apply(track, context.seconds);
    for (const playing of context.sequences ?? []) {
      for (const track of this.data.sequenceTracks.get(playing.sequence) ?? []) {
        apply(track, context.seconds - playing.start);
      }
    }
  }

  #shape(arc: number): Shape {
    const values = this.#values;
    const settings = this.#settings;
    return {
      length: values.get('length') ?? settings.length,
      lengthVariation: values.get('lengthVariation') ?? settings.lengthVariation,
      width: values.get('width') ?? settings.width,
      childWidthMultiplier: settings.childWidthMultiplier,
      arcOffset: arc,
    };
  }

  /** The shape's world matrix (its node's, as animated, stretched along Y) and the bounds. */
  #place(context: ParticleContext): void {
    const block = this.data.block;
    const model = context.animated?.get(block) ?? this.data.objects.get(block) ?? identity();
    multiply(context.instanceWorld, model, this.#world);
    const stretch = this.#options.stretch?.() ?? 1;
    const m = this.#world;
    for (let i = 4; i < 7; i++) m[i] = (m[i] ?? 0) * stretch;
    // Bounds: the main bolts' ends and their reach to the side.
    const bolts = this.#bolts ?? [];
    let reach = 0;
    let longest = 0;
    for (const bolt of bolts) {
      const last = bolt.points.length - 2;
      longest = Math.max(longest, Math.abs(bolt.points[last] ?? 0));
      reach = Math.max(reach, bolt.halfWidth + Math.abs(this.#arc));
    }
    const half = longest / 2;
    this.center[0] = (m[4] ?? 0) * half + (m[12] ?? 0);
    this.center[1] = (m[5] ?? 0) * half + (m[13] ?? 0);
    this.center[2] = (m[6] ?? 0) * half + (m[14] ?? 0);
    const scale = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
    this.radius = Math.hypot(half * Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0), reach * scale);
  }
}
