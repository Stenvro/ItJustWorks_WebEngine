// Reads Havok animations: one clip in detail, or every clip of the load order to check the
// decompression. The blocks of a clip are compressed one by one, so a decoding error shows as a
// jump where one block ends and the next begins: the check samples both sides of every seam.
// It also checks that every value is finite, and counts tracks that turn fast between frames
// (sword swings and weapon bones that snap into a hand do; that is the data, not an error).
//
//   node tools/hkx-anim.ts meshes\actors\character\animations\1hm_idle.hkx   one clip
//   node tools/hkx-anim.ts --verify [filter]                                 every clip

import {
  readAnimationContainer,
  TRANSFORM_FLOATS,
  type HkxAnimation,
} from '../src/formats/hkx/animation.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

/** Frames of 30 per second; a turn faster than this between two of them is counted as fast. */
const FRAME = 1 / 30;
const FAST_TURN = 0.6;
/** Across a seam the pose must agree up to the compression's error (curve fit and quantization). */
const SEAM_TURN = 0.1;
const SEAM_MOVE = 1;

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());

/** The angle between two unit quaternions (radians). */
function turn(a: Float32Array, b: Float32Array, at: number): number {
  let dot = 0;
  for (let k = 0; k < 4; k++) dot += (a[at + 3 + k] ?? 0) * (b[at + 3 + k] ?? 0);
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

/** A pose buffer filled with identity transforms (what unusable tracks keep). */
function identityPose(tracks: number): Float32Array {
  const pose = new Float32Array(tracks * TRANSFORM_FLOATS);
  for (let t = 0; t < tracks; t++) {
    const o = t * TRANSFORM_FLOATS;
    pose[o + 6] = 1;
    pose[o + 7] = pose[o + 8] = pose[o + 9] = 1;
  }
  return pose;
}

function assertFinite(values: Float32Array, time: number): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`not finite at ${time.toFixed(3)} s`);
  }
}

/** The largest turn of any track between consecutive frames, and where. */
function fastest(animation: HkxAnimation): { turn: number; time: number; track: number } {
  let previous = identityPose(animation.trackCount);
  let current = identityPose(animation.trackCount);
  const floats = new Float32Array(animation.floatTrackCount);
  animation.sample(0, previous, floats);
  let worst = { turn: 0, time: 0, track: 0 };
  for (let time = FRAME; time <= animation.duration + 1e-6; time += FRAME) {
    animation.sample(time, current, floats);
    assertFinite(current, time);
    assertFinite(floats, time);
    for (let t = 0; t < animation.trackCount; t++) {
      const angle = turn(previous, current, t * TRANSFORM_FLOATS);
      if (angle > worst.turn) worst = { turn: angle, time, track: t };
    }
    [previous, current] = [current, previous];
  }
  return worst;
}

/** Where the pose disagrees across a block seam (undefined: it never does). */
function seamError(animation: HkxAnimation, blockDuration: number): string | undefined {
  const before = identityPose(animation.trackCount);
  const after = identityPose(animation.trackCount);
  for (let seam = blockDuration; seam < animation.duration - 1e-4; seam += blockDuration) {
    animation.sample(seam - 1e-4, before);
    animation.sample(seam + 1e-4, after);
    for (let t = 0; t < animation.trackCount; t++) {
      const o = t * TRANSFORM_FLOATS;
      const angle = turn(before, after, o);
      const move = Math.hypot(
        (before[o] ?? 0) - (after[o] ?? 0),
        (before[o + 1] ?? 0) - (after[o + 1] ?? 0),
        (before[o + 2] ?? 0) - (after[o + 2] ?? 0),
      );
      if (angle > SEAM_TURN || move > SEAM_MOVE) {
        return `track ${String(t)} jumps ${angle.toFixed(2)} rad, ${move.toFixed(2)} units at the seam at ${seam.toFixed(2)} s`;
      }
    }
  }
  return undefined;
}

if (args.includes('--verify')) {
  const filter = (args.find((arg) => !arg.startsWith('--')) ?? '').toLowerCase();
  let clips = 0;
  let seams = 0;
  let fast = 0;
  const failures: string[] = [];
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.hkx') || !path.includes(filter)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await vfs.read(path);
    } catch {
      continue;
    }
    let pack: Packfile;
    try {
      pack = Packfile.parse(bytes);
    } catch {
      continue; // tagfiles (Creation Club), not animations
    }
    const objects = pack.objectsOf('hkaSplineCompressedAnimation');
    if (objects.length === 0) continue;
    // hkaSplineCompressedAnimation.blockDuration (docs/formats/hkx.md).
    const blockDuration = pack.f32((objects[0]?.offset ?? 0) + 72);
    try {
      for (const binding of readAnimationContainer(pack).bindings) {
        clips++;
        if (fastest(binding.animation).turn > FAST_TURN) fast++;
        if (binding.animation.duration > blockDuration) seams++;
        const seam = seamError(binding.animation, blockDuration);
        if (seam) failures.push(`${path}: ${seam}`);
      }
    } catch (error) {
      failures.push(`${path}: ${String(error)}`);
    }
  }
  console.log(
    `${String(clips)} clips decoded (${String(seams)} over several blocks), ${String(failures.length)} failed; ` +
      `${String(fast)} turn a track faster than ${String(FAST_TURN)} rad in a frame`,
  );
  for (const failure of failures.slice(0, 20)) console.log(`  failed ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
} else {
  const path = args[0] ?? '';
  const container = readAnimationContainer(Packfile.parse(await vfs.read(path)));
  for (const skeleton of container.skeletons) {
    console.log(
      `skeleton ${skeleton.name}: ${String(skeleton.bones.length)} bones, floats ${skeleton.floatSlots.join(', ')}`,
    );
  }
  for (const binding of container.bindings) {
    const animation = binding.animation;
    console.log(
      `animation for ${binding.skeletonName}: ${animation.duration.toFixed(3)} s, ` +
        `${String(animation.trackCount)} tracks, ${String(animation.floatTrackCount)} float tracks` +
        `${binding.additive ? ', additive' : ''}${binding.trackToBone ? ', mapped tracks' : ''}`,
    );
    for (const annotation of animation.annotations) {
      console.log(`  ${annotation.time.toFixed(3)} ${annotation.text}`);
    }
    if (animation.motion) {
      const { samples } = animation.motion;
      const last = samples.length - 4;
      console.log(
        `  motion: ${String(samples.length / 4)} samples, ends at ${[0, 1, 2, 3].map((k) => (samples[last + k] ?? 0).toFixed(1)).join(', ')}`,
      );
    }
    const worst = fastest(animation);
    console.log(
      `  fastest turn: track ${String(worst.track)}, ${worst.turn.toFixed(3)} rad between frames at ${worst.time.toFixed(2)} s`,
    );
    const pose = identityPose(animation.trackCount);
    const floats = new Float32Array(animation.floatTrackCount);
    for (const time of [0, animation.duration / 2]) {
      animation.sample(time, pose, floats);
      const track = (t: number): string =>
        Array.from(pose.subarray(t * TRANSFORM_FLOATS, t * TRANSFORM_FLOATS + 7), (v) =>
          v.toFixed(3),
        ).join(' ');
      console.log(
        `  at ${time.toFixed(2)} s: track 4 ${track(4)} · track 10 ${track(10)}` +
          (floats.length > 0
            ? ` · floats ${Array.from(floats, (v) => v.toFixed(2)).join(' ')}`
            : ''),
      );
    }
  }
}
await vfs.close();
