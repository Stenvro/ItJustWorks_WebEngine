// The behavior projects' animation data: meshes\animationdatasinglefile.txt (the same blocks
// also lie one project per file in meshes\animationdata\<project>.txt, and the motion of the
// character projects in meshes\animationdata\boundanims\anims_<project>.txt).
// Per project: its Havok files and, per clip generator (hkbClipGenerator, by name), the clip
// id, playback speed, crop and events; per clip id the root motion, the translation and
// rotation the clip moves the actor by: vanilla clips carry no extracted motion of their own.
// Notes: docs/formats/hkx.md ("Animation data").

import { FormatError } from '../binary-reader.ts';
import { LineReader } from './line-reader.ts';

/** A clip event: the annotation or trigger the clip generator raises at a local time. */
export interface ClipEvent {
  readonly name: string;
  readonly time: number;
}

/** What the animation data says of a clip generator. */
export interface ClipData {
  /** The hkbClipGenerator's name (several generators may share a clip). */
  readonly name: string;
  /** The clip: the key of its motion data. */
  readonly clipId: number;
  readonly playbackSpeed: number;
  /** cropStartAmountLocalTime and cropEndAmountLocalTime of the generator, seconds. */
  readonly cropStart: number;
  readonly cropEnd: number;
  readonly events: readonly ClipEvent[];
}

export type Vec3 = readonly [number, number, number];
/** Quaternion x y z w. */
export type Quat = readonly [number, number, number, number];

/**
 * The root motion of a clip: keys from its start, in the actor's space (x right, y forward,
 * z up, game units); at time 0 the actor is at zero, unrotated (no key is written for it).
 */
export interface ClipMotion {
  readonly clipId: number;
  readonly duration: number;
  readonly translations: readonly { readonly time: number; readonly value: Vec3 }[];
  readonly rotations: readonly { readonly time: number; readonly value: Quat }[];
}

export interface AnimationDataProject {
  /** As listed, without `.txt`: the behavior project's file name ("DefaultMale"). */
  readonly name: string;
  /** The project's Havok files, relative to its folder: behaviors, character, skeleton. */
  readonly files: readonly string[];
  /** Whether clip data and motion data follow (object projects without clips: false). */
  readonly hasClipData: boolean;
  readonly clips: readonly ClipData[];
  readonly motions: readonly ClipMotion[];
}

export interface AnimationDataFailure {
  readonly project: string;
  readonly message: string;
}

export interface AnimationData {
  readonly projects: readonly AnimationDataProject[];
  /** Blocks that could not be read: skipped by their line counts, the project kept without. */
  readonly failures: readonly AnimationDataFailure[];
}

/** Reads one clip data block: name, clip id, speed, crop start and end, events. */
function readClip(reader: LineReader): ClipData {
  const name = reader.next('a clip generator name');
  const clipId = reader.count('a clip id');
  const playbackSpeed = reader.number('a playback speed');
  const cropStart = reader.number('a crop start');
  const cropEnd = reader.number('a crop end');
  const eventCount = reader.count('an event count');
  const events: ClipEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    const line = reader.next('an event');
    const colon = line.lastIndexOf(':');
    const time = line.slice(colon + 1).trim();
    if (colon < 0 || time === '' || !Number.isFinite(Number(time))) {
      throw reader.error(`expected an event "name:time", found "${line}"`);
    }
    events.push({ name: line.slice(0, colon), time: Number(time) });
  }
  return { name, clipId, playbackSpeed, cropStart, cropEnd, events };
}

/** Reads one motion block: clip id, duration, translation keys, rotation keys. */
function readMotion(reader: LineReader): ClipMotion {
  const clipId = reader.count('a clip id');
  const duration = reader.number('a duration');
  const translationCount = reader.count('a translation count');
  const translations = Array.from({ length: translationCount }, () => {
    const [time = 0, x = 0, y = 0, z = 0] = reader.numbers('a translation key', 4);
    return { time, value: [x, y, z] as const };
  });
  const rotationCount = reader.count('a rotation count');
  const rotations = Array.from({ length: rotationCount }, () => {
    const [time = 0, x = 0, y = 0, z = 0, w = 1] = reader.numbers('a rotation key', 5);
    return { time, value: [x, y, z, w] as const };
  });
  return { clipId, duration, translations, rotations };
}

/** Blocks up to line `end`, each followed by an empty line (or the end of the text). */
function readBlocks<T>(reader: LineReader, end: number, read: () => T): T[] {
  const blocks: T[] = [];
  while (reader.lineNumber < end && !reader.atEnd()) {
    blocks.push(read());
    if (!reader.atEnd()) reader.blank('the empty line after a block');
  }
  return blocks;
}

/** A project block's head: the lead (1), its files and whether clip data follow. */
function readHead(reader: LineReader): { files: string[]; hasClipData: boolean } {
  reader.count('the block lead (1)');
  const fileCount = reader.count('a file count');
  const files = Array.from({ length: fileCount }, () => reader.next('a project file'));
  return { files, hasClipData: reader.count('the clip data flag') !== 0 };
}

/** Runs `read` over a line-counted block; a block that fails is skipped by its count. */
function readCounted<T>(
  reader: LineReader,
  lines: number,
  fallback: T,
  read: (end: number) => T,
): { value: T; error?: string } {
  const start = reader.position;
  const end = start.line + lines;
  try {
    const value = read(end);
    // The file's last block may lack its final empty line.
    if (reader.lineNumber !== end && !(reader.atEnd() && reader.lineNumber === end - 1)) {
      throw reader.error(
        `the block used ${String(reader.lineNumber - start.line)} of ${String(lines)} lines`,
      );
    }
    return { value };
  } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    reader.seek(start);
    reader.skip(lines);
    return { value: fallback, error: error.message };
  }
}

/**
 * Reads meshes\animationdatasinglefile.txt: the project count, the project names (`<name>.txt`),
 * then per project the line count and lines of its block and, when it has clip data, the line
 * count and lines of its motion block. A block that cannot be read is skipped and listed in
 * `failures`; a project whose head cannot be read ends the reading (its motion block, if any,
 * cannot be told from the next project).
 */
export function parseAnimationData(
  text: string,
  name = 'animationdatasinglefile.txt',
): AnimationData {
  const reader = new LineReader(text, name);
  const count = reader.count('the project count');
  const names = Array.from({ length: count }, () =>
    reader.next('a project name').replace(/\.txt$/i, ''),
  );
  const projects: AnimationDataProject[] = [];
  const failures: AnimationDataFailure[] = [];
  for (const project of names) {
    let head: { files: string[]; hasClipData: boolean };
    let lines: number;
    try {
      lines = reader.count(`the line count of ${project}`);
      const start = reader.position;
      head = readHead(reader);
      reader.seek(start);
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      failures.push({ project, message: `${error.message}; the rest of the file is not read` });
      break;
    }
    const clips = readCounted(reader, lines, [], (end) => {
      readHead(reader);
      return head.hasClipData ? readBlocks(reader, end, () => readClip(reader)) : [];
    });
    if (clips.error) failures.push({ project, message: clips.error });
    let motions: ClipMotion[] = [];
    if (head.hasClipData) {
      try {
        const motionLines = reader.count(`the motion line count of ${project}`);
        const motion = readCounted(reader, motionLines, [], (end) =>
          readBlocks(reader, end, () => readMotion(reader)),
        );
        if (motion.error) failures.push({ project, message: motion.error });
        motions = motion.value;
      } catch (error) {
        if (!(error instanceof FormatError)) throw error;
        failures.push({ project, message: `${error.message}; the rest of the file is not read` });
        projects.push({ name: project, ...head, clips: clips.value, motions });
        break;
      }
    }
    projects.push({ name: project, ...head, clips: clips.value, motions });
  }
  return { projects, failures };
}

function lineCount(text: string): number {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Reads a project's own file meshes\animationdata\<project>.txt (one block, no line count). */
export function parseProjectAnimationData(
  text: string,
  name: string,
): Omit<AnimationDataProject, 'motions'> {
  const reader = new LineReader(text, name);
  const head = readHead(reader);
  const clips = head.hasClipData ? readBlocks(reader, lineCount(text), () => readClip(reader)) : [];
  return { name: name.replace(/^.*\\|\.txt$/gi, ''), ...head, clips };
}

/** Reads a project's motion file meshes\animationdata\boundanims\anims_<project>.txt. */
export function parseClipMotions(text: string, name: string): ClipMotion[] {
  const reader = new LineReader(text, name);
  return readBlocks(reader, lineCount(text), () => readMotion(reader));
}
