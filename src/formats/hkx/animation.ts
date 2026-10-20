// Havok animations of a packfile's hkaAnimationContainer: skeletons, spline-compressed
// animations (the form every vanilla clip has) with their annotations and extracted root
// motion, and the bindings of animations to skeletons. Layout and decompression:
// docs/formats/hkx.md ("Animations"). Platform-independent.

import { FormatError } from '../binary-reader.ts';
import type { HkxObject, Packfile } from './packfile.ts';

/** Floats per track of a pose: translation xyz, rotation xyzw (quaternion), scale xyz. */
export const TRANSFORM_FLOATS = 10;

export interface HkxBone {
  readonly name: string;
  /** The bone keeps its reference translation (animations only turn it). */
  readonly lockTranslation: boolean;
}

export interface HkxSkeleton {
  readonly name: string;
  readonly bones: readonly HkxBone[];
  /** Parent index per bone (−1 for roots). */
  readonly parents: Int16Array;
  /** The reference pose, local to each parent: TRANSFORM_FLOATS per bone. */
  readonly referencePose: Float32Array;
  /** Float slots (visibility and fade of attached objects) and their reference values. */
  readonly floatSlots: readonly string[];
  readonly referenceFloats: Float32Array;
}

/** A text event at a time of an animation ("FootLeft", "SoundPlay.NPCHumanFootstep", ...). */
export interface AnimationAnnotation {
  readonly time: number;
  readonly text: string;
}

/** Root motion taken out of an animation: samples of translation (xyz) and turn (w, radians). */
export interface ExtractedMotion {
  readonly up: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly duration: number;
  /** Four floats per sample, evenly spread over the duration. */
  readonly samples: Float32Array;
}

export interface HkxAnimation {
  readonly duration: number;
  readonly trackCount: number;
  readonly floatTrackCount: number;
  /** Every annotation of every track, by time. */
  readonly annotations: readonly AnimationAnnotation[];
  /**
   * The bone each transform track animates, by name (hkaAnnotationTrack trackName), where the
   * file names them: the paired animations' tracks (PairedRoot, the first actor's bones, the
   * second's prefixed "2_") are known only by these names (src/animation/paired-clips.ts).
   */
  readonly trackNames?: readonly string[];
  readonly motion: ExtractedMotion | undefined;
  /**
   * The tracks' transforms at a time (seconds), TRANSFORM_FLOATS per track, into `out`, and the
   * float tracks' values into `floats` when given. A track whose data is unusable (some vanilla
   * clips carry NaN for an unused bone) is not written: callers fill `out` with the reference
   * pose first, so such a bone keeps it.
   */
  sample(time: number, out: Float32Array, floats?: Float32Array): void;
}

export interface AnimationBinding {
  /** The skeleton the animation was made for (its root bone's name). */
  readonly skeletonName: string;
  readonly animation: HkxAnimation;
  /** Bone of each transform track; undefined: track i animates bone i. */
  readonly trackToBone: Int16Array | undefined;
  /** Float slot of each float track. */
  readonly floatTrackToSlot: Int16Array | undefined;
  /** Additive animations add to the pose below them. */
  readonly additive: boolean;
}

export interface AnimationContainer {
  readonly skeletons: readonly HkxSkeleton[];
  readonly bindings: readonly AnimationBinding[];
}

// --- Member offsets (Havok 2010.2, 64-bit) -------------------------------------------------

/** hkaAnimationContainer: skeletons, animations, bindings (arrays of pointers). */
const CONTAINER = { skeletons: 16, bindings: 48 } as const;
/** hkaSkeleton. */
const SKELETON = {
  name: 16,
  parents: 24,
  bones: 40,
  referencePose: 56,
  referenceFloats: 72,
  floatSlots: 88,
} as const;
const BONE_SIZE = 16;
const QS_TRANSFORM_SIZE = 48;
/** hkaAnimation (base) and hkaSplineCompressedAnimation. */
const ANIMATION = {
  type: 16,
  duration: 20,
  transformTracks: 24,
  floatTracks: 28,
  extractedMotion: 32,
  annotationTracks: 40,
  numFrames: 56,
  numBlocks: 60,
  maxFramesPerBlock: 64,
  maskAndQuantizationSize: 68,
  blockDuration: 72,
  blockInverseDuration: 76,
  frameDuration: 80,
  blockOffsets: 88,
  floatBlockOffsets: 104,
  data: 152,
} as const;
/** hkaAnnotationTrack: trackName (8), annotations (hkArray of time f32 @0, text @8). */
const ANNOTATION_TRACK_SIZE = 24;
const ANNOTATION_SIZE = 16;
/** hkaDefaultAnimatedReferenceFrame. */
const REFERENCE_FRAME = { up: 16, forward: 32, duration: 48, samples: 56 } as const;
/** hkaAnimationBinding. */
const BINDING = {
  skeletonName: 16,
  animation: 24,
  trackToBone: 32,
  floatTrackToSlot: 48,
  blendHint: 64,
} as const;
/** hkaAnimationType of spline-compressed animations. */
const SPLINE_COMPRESSED = 5;

// --- Reading -------------------------------------------------------------------------------

export function readAnimationContainer(pack: Packfile): AnimationContainer {
  const container = pack.objectsOf('hkaAnimationContainer')[0];
  if (!container) return { skeletons: [], bindings: [] };
  const skeletons = pack
    .objectArray(container.offset + CONTAINER.skeletons)
    .filter((object): object is HkxObject => object !== undefined)
    .map((object) => readSkeleton(pack, object));
  const bindings: AnimationBinding[] = [];
  for (const object of pack.objectArray(container.offset + CONTAINER.bindings)) {
    if (object) bindings.push(readBinding(pack, object));
  }
  return { skeletons, bindings };
}

function int16Array(pack: Packfile, offset: number): Int16Array | undefined {
  const { data, size } = pack.array(offset);
  if (size === 0) return undefined;
  return Int16Array.from({ length: size }, (_, i) => pack.i16(data + i * 2));
}

export function readSkeleton(pack: Packfile, object: HkxObject): HkxSkeleton {
  const at = object.offset;
  const bones = pack.array(at + SKELETON.bones);
  const pose = pack.array(at + SKELETON.referencePose);
  if (pose.size !== bones.size) {
    throw new FormatError(
      `hkaSkeleton: ${String(pose.size)} poses for ${String(bones.size)} bones`,
      at,
    );
  }
  const referencePose = new Float32Array(bones.size * TRANSFORM_FLOATS);
  for (let i = 0; i < bones.size; i++) {
    const p = pose.data + i * QS_TRANSFORM_SIZE;
    const o = i * TRANSFORM_FLOATS;
    for (let k = 0; k < 3; k++) referencePose[o + k] = pack.f32(p + k * 4);
    for (let k = 0; k < 4; k++) referencePose[o + 3 + k] = pack.f32(p + 16 + k * 4);
    for (let k = 0; k < 3; k++) referencePose[o + 7 + k] = pack.f32(p + 32 + k * 4);
  }
  const floats = pack.array(at + SKELETON.referenceFloats);
  return {
    name: pack.string(at + SKELETON.name) ?? '',
    bones: Array.from({ length: bones.size }, (_, i) => ({
      name: pack.string(bones.data + i * BONE_SIZE) ?? '',
      lockTranslation: pack.bool(bones.data + i * BONE_SIZE + 8),
    })),
    parents: int16Array(pack, at + SKELETON.parents) ?? new Int16Array(bones.size).fill(-1),
    referencePose,
    floatSlots: pack.stringArray(at + SKELETON.floatSlots),
    referenceFloats: Float32Array.from({ length: floats.size }, (_, i) =>
      pack.f32(floats.data + i * 4),
    ),
  };
}

function readBinding(pack: Packfile, object: HkxObject): AnimationBinding {
  const at = object.offset;
  const animation = pack.object(at + BINDING.animation);
  if (!animation) throw new FormatError('hkaAnimationBinding without an animation', at);
  return {
    skeletonName: pack.string(at + BINDING.skeletonName) ?? '',
    animation: readAnimation(pack, animation),
    trackToBone: int16Array(pack, at + BINDING.trackToBone),
    floatTrackToSlot: int16Array(pack, at + BINDING.floatTrackToSlot),
    additive: pack.i8(at + BINDING.blendHint) === 1,
  };
}

export function readAnimation(pack: Packfile, object: HkxObject): HkxAnimation {
  const at = object.offset;
  if (object.className !== 'hkaSplineCompressedAnimation') {
    throw new FormatError(`Animations of class ${object.className} are not read`, at);
  }
  const type = pack.i32(at + ANIMATION.type);
  if (type !== SPLINE_COMPRESSED) {
    throw new FormatError(`hkaSplineCompressedAnimation of type ${String(type)}`, at);
  }
  const blockOffsets = pack.array(at + ANIMATION.blockOffsets);
  const floatBlockOffsets = pack.array(at + ANIMATION.floatBlockOffsets);
  const data = pack.array(at + ANIMATION.data);
  const header: SplineHeader = {
    duration: pack.f32(at + ANIMATION.duration),
    trackCount: pack.i32(at + ANIMATION.transformTracks),
    floatTrackCount: pack.i32(at + ANIMATION.floatTracks),
    numFrames: pack.i32(at + ANIMATION.numFrames),
    numBlocks: pack.i32(at + ANIMATION.numBlocks),
    maxFramesPerBlock: pack.i32(at + ANIMATION.maxFramesPerBlock),
    blockDuration: pack.f32(at + ANIMATION.blockDuration),
    blockInverseDuration: pack.f32(at + ANIMATION.blockInverseDuration),
    frameDuration: pack.f32(at + ANIMATION.frameDuration),
    blockOffsets: Uint32Array.from({ length: blockOffsets.size }, (_, i) =>
      pack.u32(blockOffsets.data + i * 4),
    ),
    floatBlockOffsets: Uint32Array.from({ length: floatBlockOffsets.size }, (_, i) =>
      pack.u32(floatBlockOffsets.data + i * 4),
    ),
  };
  if (header.blockOffsets.length !== header.numBlocks || header.numBlocks < 1) {
    throw new FormatError(
      `hkaSplineCompressedAnimation: ${String(header.blockOffsets.length)} block offsets for ${String(header.numBlocks)} blocks`,
      at,
    );
  }
  const motionObject = pack.object(at + ANIMATION.extractedMotion);
  return new SplineAnimation(
    header,
    pack.bytes(data.data, data.size),
    readAnnotations(pack, at + ANIMATION.annotationTracks),
    motionObject?.className === 'hkaDefaultAnimatedReferenceFrame'
      ? readMotion(pack, motionObject)
      : undefined,
    readTrackNames(pack, at + ANIMATION.annotationTracks, header.trackCount),
  );
}

/**
 * The annotation tracks' names (hkaAnnotationTrack: trackName at 0), one per transform track
 * where the file has as many; undefined otherwise.
 */
function readTrackNames(
  pack: Packfile,
  offset: number,
  trackCount: number,
): readonly string[] | undefined {
  const tracks = pack.array(offset);
  if (tracks.size !== trackCount || trackCount === 0) return undefined;
  return Array.from(
    { length: tracks.size },
    (_, t) => pack.string(tracks.data + t * ANNOTATION_TRACK_SIZE) ?? '',
  );
}

function readAnnotations(pack: Packfile, offset: number): AnimationAnnotation[] {
  const tracks = pack.array(offset);
  const annotations: AnimationAnnotation[] = [];
  for (let t = 0; t < tracks.size; t++) {
    const list = pack.array(tracks.data + t * ANNOTATION_TRACK_SIZE + 8);
    for (let i = 0; i < list.size; i++) {
      const a = list.data + i * ANNOTATION_SIZE;
      annotations.push({ time: pack.f32(a), text: pack.string(a + 8) ?? '' });
    }
  }
  return annotations.sort((a, b) => a.time - b.time);
}

function readMotion(pack: Packfile, object: HkxObject): ExtractedMotion {
  const at = object.offset;
  const vec3 = (o: number): [number, number, number] => [
    pack.f32(at + o),
    pack.f32(at + o + 4),
    pack.f32(at + o + 8),
  ];
  const samples = pack.array(at + REFERENCE_FRAME.samples);
  return {
    up: vec3(REFERENCE_FRAME.up),
    forward: vec3(REFERENCE_FRAME.forward),
    duration: pack.f32(at + REFERENCE_FRAME.duration),
    samples: Float32Array.from({ length: samples.size * 4 }, (_, i) =>
      pack.f32(samples.data + i * 4),
    ),
  };
}

// --- Spline decompression ------------------------------------------------------------------

interface SplineHeader {
  readonly duration: number;
  readonly trackCount: number;
  readonly floatTrackCount: number;
  readonly numFrames: number;
  readonly numBlocks: number;
  readonly maxFramesPerBlock: number;
  readonly blockDuration: number;
  readonly blockInverseDuration: number;
  readonly frameDuration: number;
  readonly blockOffsets: Uint32Array;
  readonly floatBlockOffsets: Uint32Array;
}

/** A B-spline curve: its degree, knots (frames in the block) and control points. */
interface Spline {
  readonly degree: number;
  readonly knots: Float32Array;
  /** Floats per control point: 3 for a position or scale, 4 for a quaternion. */
  readonly size: number;
  readonly points: Float32Array;
}

/** A track's component: a curve, or a value that does not change in the block. */
type Channel = { readonly constant: Float32Array } | { readonly spline: Spline };

interface TrackBlock {
  readonly translation: Channel;
  readonly rotation: Channel;
  readonly scale: Channel;
}

/** One block decoded: its transform tracks and float tracks (undefined: data unusable). */
interface DecodedBlock {
  readonly tracks: readonly (TrackBlock | undefined)[];
  readonly floats: readonly (Channel | undefined)[];
}

/** Rotation quantizations (TransformMask bits 2–5). */
const Rotation = {
  polar32: 0,
  threeComp40: 1,
  threeComp48: 2,
  threeComp24: 3,
  straight16: 4,
  uncompressed: 5,
} as const;
const ROTATION_ALIGN = [4, 1, 2, 1, 2, 4];

/** Component flags of position and scale (TransformMask bytes 1 and 3). */
const STATIC_X = 0x01;
const SPLINE_X = 0x10;
const STATIC_ROTATION = 0x0f;
const SPLINE_ROTATION = 0xf0;
/**
 * Float track mask (one byte per float track after the TransformMasks): static (one f32) or a
 * curve; 0x02 is set on every vanilla float track and every vanilla float curve has 16-bit
 * control points, so 0x02 is read as the 16-bit quantization (8-bit without it).
 */
const FLOAT_STATIC = 0x01;
const FLOAT_16_BITS = 0x02;
const FLOAT_SPLINE = 0x10;
/** Larger than any reach of a worldspace: a value beyond it is corrupt data. */
const VALUE_LIMIT = 1e7;

/** Reads a spline-compressed block's bytes. */
class BlockReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  offset: number;

  constructor(bytes: Uint8Array, offset: number) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  #take(size: number): number {
    const at = this.offset;
    if (at + size > this.#bytes.byteLength) {
      throw new FormatError('Spline-compressed animation data ends early', at);
    }
    this.offset += size;
    return at;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true);
  }

  f32(): number {
    return this.#view.getFloat32(this.#take(4), true);
  }

  /** The next `size` bytes as a little-endian unsigned integer (up to 6 bytes). */
  bits(size: number): number {
    const at = this.#take(size);
    let value = 0;
    for (let i = size - 1; i >= 0; i--) value = value * 256 + (this.#bytes[at + i] ?? 0);
    return value;
  }

  align(to: number): void {
    const rest = this.offset % to;
    if (rest !== 0) this.#take(to - rest);
  }
}

/** Scratch for one channel's value while sampling. */
const channelValue = new Float32Array(4);

class SplineAnimation implements HkxAnimation {
  readonly duration: number;
  readonly trackCount: number;
  readonly floatTrackCount: number;
  readonly annotations: readonly AnimationAnnotation[];
  readonly trackNames: readonly string[] | undefined;
  readonly motion: ExtractedMotion | undefined;
  readonly #header: SplineHeader;
  readonly #data: Uint8Array;
  readonly #blocks: (DecodedBlock | undefined)[];

  constructor(
    header: SplineHeader,
    data: Uint8Array,
    annotations: readonly AnimationAnnotation[],
    motion: ExtractedMotion | undefined,
    trackNames?: readonly string[],
  ) {
    this.#header = header;
    this.#data = data;
    this.duration = header.duration;
    this.trackCount = header.trackCount;
    this.floatTrackCount = header.floatTrackCount;
    this.annotations = annotations;
    this.trackNames = trackNames;
    this.motion = motion;
    this.#blocks = Array.from({ length: header.numBlocks }, () => undefined);
  }

  sample(time: number, out: Float32Array, floats?: Float32Array): void {
    const header = this.#header;
    const t = Math.min(Math.max(time, 0), header.duration);
    const index = Math.min(Math.floor(t * header.blockInverseDuration), header.numBlocks - 1);
    const frame = Math.max(0, t - index * header.blockDuration) / header.frameDuration;
    const block = this.#block(index);
    const value = channelValue;
    for (let i = 0; i < block.tracks.length; i++) {
      const track = block.tracks[i];
      if (!track) continue;
      const o = i * TRANSFORM_FLOATS;
      evaluate(track.translation, frame, value);
      out[o] = value[0] ?? 0;
      out[o + 1] = value[1] ?? 0;
      out[o + 2] = value[2] ?? 0;
      evaluate(track.rotation, frame, value);
      // The curve blends unit quaternions: back to unit length.
      const length = Math.hypot(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0) || 1;
      for (let k = 0; k < 4; k++) out[o + 3 + k] = (value[k] ?? 0) / length;
      evaluate(track.scale, frame, value);
      out[o + 7] = value[0] ?? 1;
      out[o + 8] = value[1] ?? 1;
      out[o + 9] = value[2] ?? 1;
    }
    if (!floats) return;
    for (let i = 0; i < block.floats.length; i++) {
      const channel = block.floats[i];
      if (!channel) continue;
      evaluate(channel, frame, value);
      floats[i] = value[0] ?? 0;
    }
  }

  #block(index: number): DecodedBlock {
    let block = this.#blocks[index];
    if (!block) {
      block = decodeBlock(this.#data, this.#header, index);
      this.#blocks[index] = block;
    }
    return block;
  }
}

/** Decodes one block: every transform track's and float track's channels. */
function decodeBlock(data: Uint8Array, header: SplineHeader, block: number): DecodedBlock {
  const start = header.blockOffsets[block] ?? 0;
  const reader = new BlockReader(data, start);
  // TransformMask per transform track (quantizations, position, rotation, scale flags), one
  // byte per float track, aligned to 4.
  const masks: [number, number, number, number][] = [];
  for (let i = 0; i < header.trackCount; i++) {
    masks.push([reader.u8(), reader.u8(), reader.u8(), reader.u8()]);
  }
  const floatMasks: number[] = [];
  for (let i = 0; i < header.floatTrackCount; i++) floatMasks.push(reader.u8());
  reader.align(4);
  const tracks: (TrackBlock | undefined)[] = [];
  for (const [quantization, positionTypes, rotationTypes, scaleTypes] of masks) {
    const translation = readVector(reader, positionTypes, quantization & 3, 0);
    const rotation = readRotation(reader, rotationTypes, (quantization >> 2) & 0xf);
    reader.align(4);
    const scale = readVector(reader, scaleTypes, (quantization >> 6) & 3, 1);
    const usable = [translation, rotation, scale].every(isUsable);
    tracks.push(usable ? { translation, rotation, scale } : undefined);
  }
  // The float tracks' data starts at the block's float offset.
  reader.offset = start + (header.floatBlockOffsets[block] ?? reader.offset - start);
  const floats = floatMasks.map((mask) => {
    const channel = readFloat(reader, mask);
    return channel && isUsable(channel) ? channel : undefined;
  });
  return { tracks, floats };
}

/** Every value of the channel finite and within reach (not corrupt). */
function isUsable(channel: Channel): boolean {
  const values = 'constant' in channel ? channel.constant : channel.spline.points;
  for (const value of values) {
    if (!(Math.abs(value) < VALUE_LIMIT)) return false;
  }
  return true;
}

/** A float track's channel in a block; undefined when the block leaves it to its default. */
function readFloat(reader: BlockReader, mask: number): Channel | undefined {
  if ((mask & FLOAT_SPLINE) !== 0) {
    const { count, degree, knots } = readKnots(reader);
    reader.align(4);
    const low = reader.f32();
    const high = reader.f32();
    const points = new Float32Array(count + 1);
    for (let p = 0; p <= count; p++) {
      const fraction = (mask & FLOAT_16_BITS) !== 0 ? reader.u16() / 0xffff : reader.u8() / 0xff;
      points[p] = low + (high - low) * fraction;
    }
    reader.align(4);
    return { spline: { degree, knots, size: 1, points } };
  }
  if ((mask & FLOAT_STATIC) !== 0) return { constant: Float32Array.of(reader.f32()) };
  return undefined;
}

/** A position or scale channel: xyz components, each splined, static or the default. */
function readVector(
  reader: BlockReader,
  types: number,
  quantization: number,
  fallback: number,
): Channel {
  const isStatic = [0, 1, 2].map((c) => (types & (STATIC_X << c)) !== 0);
  const isSpline = [0, 1, 2].map((c) => !isStatic[c] && (types & (SPLINE_X << c)) !== 0);
  if (!isSpline.some(Boolean)) {
    const constant = new Float32Array(3).fill(fallback);
    for (let c = 0; c < 3; c++) if (isStatic[c]) constant[c] = reader.f32();
    return { constant };
  }
  const { count, degree, knots } = readKnots(reader);
  reader.align(4);
  const ranges: [number, number][] = [];
  const constant = new Float32Array(3).fill(fallback);
  for (let c = 0; c < 3; c++) {
    if (isSpline[c]) ranges[c] = [reader.f32(), reader.f32()];
    else if (isStatic[c]) constant[c] = reader.f32();
  }
  const points = new Float32Array((count + 1) * 3);
  for (let p = 0; p <= count; p++) {
    for (let c = 0; c < 3; c++) {
      const range = ranges[c];
      if (!range) {
        points[p * 3 + c] = constant[c] ?? fallback;
        continue;
      }
      const fraction = quantization === 0 ? reader.u8() / 0xff : reader.u16() / 0xffff;
      points[p * 3 + c] = range[0] + (range[1] - range[0]) * fraction;
    }
  }
  reader.align(4);
  return { spline: { degree, knots, size: 3, points } };
}

function readKnots(reader: BlockReader): { count: number; degree: number; knots: Float32Array } {
  const count = reader.u16();
  const degree = reader.u8();
  const knots = new Float32Array(count + degree + 2);
  for (let i = 0; i < knots.length; i++) knots[i] = reader.u8();
  return { count, degree, knots };
}

/** The rotation channel: a quaternion curve, one static quaternion, or the identity. */
function readRotation(reader: BlockReader, types: number, quantization: number): Channel {
  if ((types & SPLINE_ROTATION) !== 0) {
    const { count, degree, knots } = readKnots(reader);
    reader.align(ROTATION_ALIGN[quantization] ?? 4);
    const points = new Float32Array((count + 1) * 4);
    for (let p = 0; p <= count; p++) readQuaternion(reader, quantization, points, p * 4);
    return { spline: { degree, knots, size: 4, points } };
  }
  const constant = Float32Array.of(0, 0, 0, 1);
  if ((types & STATIC_ROTATION) !== 0) {
    reader.align(ROTATION_ALIGN[quantization] ?? 4);
    readQuaternion(reader, quantization, constant, 0);
  }
  return { constant };
}

/** Largest-component quaternions keep three; the fourth follows from unit length. */
function placeThree(
  out: Float32Array,
  at: number,
  stored: readonly [number, number, number],
  missing: number,
  negative: boolean,
): void {
  const [a, b, c] = stored;
  const rest = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
  let s = 0;
  for (let i = 0; i < 4; i++) {
    if (i === missing) out[at + i] = negative ? -rest : rest;
    else out[at + i] = stored[s++] ?? 0;
  }
}

const POLAR_PHI = Math.PI / 2 / 511;
/** THREECOMP40: 12-bit components around 2047, ±1/√2. */
const COMP40_SCALE = Math.SQRT1_2 / 2047;
/** THREECOMP48: 15-bit components around 16383, ±1/√2. */
const COMP48_SCALE = Math.SQRT1_2 / 16383;

function readQuaternion(
  reader: BlockReader,
  quantization: number,
  out: Float32Array,
  at: number,
): void {
  switch (quantization) {
    case Rotation.polar32: {
      const bits = reader.u32();
      const phiTheta = bits & 0x3ffff;
      const rRaw = (bits >>> 18) & 0x3ff;
      const r = 1 - (rRaw / 1023) ** 2;
      let phi = Math.floor(Math.sqrt(phiTheta));
      let theta = 0;
      if (phi > 0) {
        theta = ((Math.PI / 4) * (phiTheta - phi * phi)) / phi;
        phi *= POLAR_PHI;
      }
      const magnitude = Math.sqrt(Math.max(0, 1 - r * r));
      const sign = (bit: number): number => ((bits >>> bit) & 1 ? -1 : 1);
      out[at] = Math.sin(phi) * Math.cos(theta) * magnitude * sign(28);
      out[at + 1] = Math.sin(phi) * Math.sin(theta) * magnitude * sign(29);
      out[at + 2] = Math.cos(phi) * magnitude * sign(30);
      out[at + 3] = r * sign(31);
      return;
    }
    case Rotation.threeComp40: {
      const bits = reader.bits(5);
      const field = (shift: number): number => Math.floor(bits / 2 ** shift) % 4096;
      const value = (shift: number): number => (field(shift) - 2047) * COMP40_SCALE;
      const missing = Math.floor(bits / 2 ** 36) % 4;
      const negative = Math.floor(bits / 2 ** 38) % 2 === 1;
      placeThree(out, at, [value(0), value(12), value(24)], missing, negative);
      return;
    }
    case Rotation.threeComp48: {
      const x = reader.u16();
      const y = reader.u16();
      const z = reader.u16();
      const missing = ((y >> 14) & 2) | ((x >> 15) & 1);
      const value = (v: number): number => ((v & 0x7fff) - 16383) * COMP48_SCALE;
      placeThree(out, at, [value(x), value(y), value(z)], missing, z >> 15 !== 0);
      return;
    }
    case Rotation.uncompressed:
      for (let k = 0; k < 4; k++) out[at + k] = reader.f32();
      return;
    default:
      throw new FormatError(
        `Rotation quantization ${String(quantization)} is not read (no vanilla animation uses it)`,
        reader.offset,
      );
  }
}

/** A channel's value at a frame of the block (as many floats as the channel has). */
function evaluate(channel: Channel, frame: number, out: Float32Array): void {
  if ('constant' in channel) {
    out.set(channel.constant);
    return;
  }
  const { degree, knots, size, points } = channel.spline;
  const count = points.length / size;
  const span = knotSpan(knots, degree, count, frame);
  const basis = basisFunctions(knots, degree, span, frame);
  out.fill(0);
  for (let j = 0; j <= degree; j++) {
    const point = (span - degree + j) * size;
    const weight = basis[j] ?? 0;
    for (let k = 0; k < size; k++) out[k] = (out[k] ?? 0) + (points[point + k] ?? 0) * weight;
  }
}

/** The knot span a parameter lies in (The NURBS Book, A2.1). */
function knotSpan(knots: Float32Array, degree: number, count: number, u: number): number {
  const n = count - 1;
  if (u >= (knots[n + 1] ?? 0)) return n;
  if (u <= (knots[degree] ?? 0)) return degree;
  let low = degree;
  let high = n + 1;
  let mid = (low + high) >> 1;
  while (u < (knots[mid] ?? 0) || u >= (knots[mid + 1] ?? 0)) {
    if (u < (knots[mid] ?? 0)) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** The non-zero basis functions at a parameter (The NURBS Book, A2.2). */
function basisFunctions(knots: Float32Array, degree: number, span: number, u: number): number[] {
  const basis = [1];
  const left: number[] = [];
  const right: number[] = [];
  for (let j = 1; j <= degree; j++) {
    left[j] = u - (knots[span + 1 - j] ?? 0);
    right[j] = (knots[span + j] ?? 0) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denominator = (right[r + 1] ?? 0) + (left[j - r] ?? 0);
      const temp = denominator === 0 ? 0 : (basis[r] ?? 0) / denominator;
      basis[r] = saved + (right[r + 1] ?? 0) * temp;
      saved = (left[j - r] ?? 0) * temp;
    }
    basis[j] = saved;
  }
  return basis;
}
