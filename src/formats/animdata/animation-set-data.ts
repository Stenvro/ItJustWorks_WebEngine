// The behavior projects' animation sets: meshes\animationsetdatasinglefile.txt (also one
// project per folder in meshes\animationsetdata\<project>data\: the set list in
// <project>.txt, each set in its own file, the folders listed in dirlist.txt).
// A set is an equip state of the character (by graph variables such as iLeftHandType and
// iRightHandType): the events that switch to it, its attacks (attack event → the clip
// generators it may play) and the clips to have loaded, by the CRC-32 of their paths.
// Notes: docs/formats/hkx.md ("Animation data").

import { bsCrc32 } from '../crc32.ts';
import { folderOf, fileNameOf, normalizePath } from '../paths.ts';
import { LineReader } from './line-reader.ts';

/** A graph variable the set requires within a range (both ends included). */
export interface AnimationSetCondition {
  readonly variable: string;
  readonly min: number;
  readonly max: number;
}

/** An attack the set offers: the event that starts it and the clip generators it plays. */
export interface AnimationSetAttack {
  /** The attack event ("attackStart", "attackPowerStartForward", "bashStart"). */
  readonly event: string;
  /** 0 or 1 (meaning unknown; see docs/formats/hkx.md). */
  readonly flag: number;
  readonly clips: readonly string[];
}

/** A clip the set uses, by path hashes (animationClipKey). */
export interface AnimationSetClip {
  /** BSCRC32 of the lower-case folder, e.g. "meshes\actors\character\animations". */
  readonly folder: number;
  /** BSCRC32 of the lower-case file name without its extension. */
  readonly file: number;
  /** The extension's characters as a little-endian u32 ("hkx": 7891816). */
  readonly extension: number;
}

export interface AnimationSet {
  /** The set's file name without `.txt` ("1HMShield"). */
  readonly name: string;
  /** "V3" in every vanilla set. */
  readonly version: string;
  /** Events that switch to the set (weapEquip, ...). */
  readonly triggers: readonly string[];
  readonly conditions: readonly AnimationSetCondition[];
  readonly attacks: readonly AnimationSetAttack[];
  readonly clips: readonly AnimationSetClip[];
}

export interface AnimationSetDataProject {
  /** The behavior project's file name ("DefaultMale"), from "DefaultMaleData\DefaultMale.txt". */
  readonly name: string;
  /** As listed. */
  readonly path: string;
  readonly sets: readonly AnimationSet[];
}

function readSet(reader: LineReader, name: string): AnimationSet {
  const version = reader.next('a set version');
  if (!/^V\d+$/.test(version))
    throw reader.error(`expected a set version (V3), found "${version}"`);
  const triggers = Array.from({ length: reader.count('a trigger count') }, () =>
    reader.next('a trigger event'),
  );
  const conditions = Array.from({ length: reader.count('a condition count') }, () => ({
    variable: reader.next('a condition variable'),
    min: reader.number('a condition minimum'),
    max: reader.number('a condition maximum'),
  }));
  const attacks = Array.from({ length: reader.count('an attack count') }, () => {
    const event = reader.next('an attack event');
    const flag = reader.count('an attack flag');
    const clips = Array.from({ length: reader.count('an attack clip count') }, () =>
      reader.next('an attack clip generator'),
    );
    return { event, flag, clips };
  });
  const clips = Array.from({ length: reader.count('a clip count') }, () => ({
    folder: reader.count('a folder CRC'),
    file: reader.count('a file CRC'),
    extension: reader.count('an extension'),
  }));
  return { name, version, triggers, conditions, attacks, clips };
}

/** A set list: the number of sets, their file names, then the sets in that order. */
function readSets(reader: LineReader): AnimationSet[] {
  const names = Array.from({ length: reader.count('a set count') }, () =>
    reader.next('a set file name').replace(/\.txt$/i, ''),
  );
  return names.map((name) => readSet(reader, name));
}

/** Reads meshes\animationsetdatasinglefile.txt: the project count, their paths, their sets. */
export function parseAnimationSetData(
  text: string,
  name = 'animationsetdatasinglefile.txt',
): AnimationSetDataProject[] {
  const reader = new LineReader(text, name);
  const paths = Array.from({ length: reader.count('the project count') }, () =>
    reader.next('a project path'),
  );
  return paths.map((path) => ({ name: projectName(path), path, sets: readSets(reader) }));
}

/** Reads one set file of meshes\animationsetdata\<project>data\ ("1hmshield.txt"). */
export function parseAnimationSet(text: string, name: string): AnimationSet {
  return readSet(new LineReader(text, name), name.replace(/^.*\\|\.txt$/gi, ''));
}

/** "DefaultMaleData\DefaultMale.txt" (or ".spd") → "DefaultMale". */
export function projectName(path: string): string {
  return path.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}

/** The hashes the animation sets name a clip file by. */
export function animationClipKey(path: string): AnimationSetClip {
  const normalized = normalizePath(path);
  const file = fileNameOf(normalized);
  const dot = file.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.slice(dot + 1);
  let packed = 0;
  for (let i = 0; i < Math.min(4, extension.length); i++) {
    packed |= (extension.charCodeAt(i) & 0xff) << (8 * i);
  }
  return {
    folder: bsCrc32(folderOf(normalized)),
    file: bsCrc32(dot < 0 ? file : file.slice(0, dot)),
    extension: packed >>> 0,
  };
}

/** Whether a set's conditions hold for the graph variables' values. */
export function animationSetApplies(
  set: AnimationSet,
  variable: (name: string) => number | undefined,
): boolean {
  return set.conditions.every((condition) => {
    const value = variable(condition.variable);
    return value !== undefined && value >= condition.min && value <= condition.max;
  });
}
