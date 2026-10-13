// Lip-sync files (.lip, also inside .fuz voice files): the face animation of a spoken line,
// as the Creation Kit generates it (FaceFX). A 12-byte header, then a byte-run-compressed
// block: a frame count, the frame the audio starts at (frames before it lead in), the
// number of phoneme curves, then per frame (30 per second) one value per curve. Humanoid
// lines have 33 curves: the 16 FaceGen phonemes, the 14 modifiers (blinks, brows, looks,
// squints) and the head's pitch, roll and yaw; creature lines (dragons, rieklings) 8.
// Worked out from the vanilla files (every file decodes to exactly the size its header
// states); notes in docs/formats/audio.md ("LIP"). Platform-independent.

import { FormatError } from '../binary-reader.ts';

/** Curves per second. */
export const LIP_RATE = 30;

/** The phonemes of a humanoid line, in curve order (FaceGen's phoneme morph names). */
export const LIP_PHONEMES = [
  'Aah',
  'BigAah',
  'BMP',
  'ChJSh',
  'DST',
  'Eee',
  'Eh',
  'FV',
  'I',
  'K',
  'N',
  'Oh',
  'OohQ',
  'R',
  'Th',
  'W',
] as const;

/** The modifiers after the phonemes, in curve order (FaceGen's modifier morph names). */
export const LIP_MODIFIERS = [
  'BlinkLeft',
  'BlinkRight',
  'BrowDownLeft',
  'BrowDownRight',
  'BrowInLeft',
  'BrowInRight',
  'BrowUpLeft',
  'BrowUpRight',
  'LookDown',
  'LookLeft',
  'LookRight',
  'LookUp',
  'SquintLeft',
  'SquintRight',
] as const;

export interface LipFile {
  /** Frames (LIP_RATE per second). */
  readonly frames: number;
  /** The frame the audio starts at (≤ 0: frames before it lead in). */
  readonly first: number;
  /** Phoneme curves (16 humanoid, 8 creature). */
  readonly phonemes: number;
  /** Curves per frame (33 humanoid: phonemes, modifiers, head pitch/roll/yaw; 8 creature). */
  readonly curves: number;
  /** frames × curves values, frame by frame. */
  readonly values: Float32Array;
}

const HEADER = 12;
const BLOCK_HEADER = 12;
/** The header's size field counts 16 bytes more than the block holds. */
const SIZE_BIAS = 16;
/** A broken file's sizes: no vanilla line is longer than a few minutes. */
const MAX_BLOCK = 1 << 26;

/**
 * Expands the block: a zero byte starts a run of zero bytes (u16 count), any other byte is
 * itself.
 */
function expand(data: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = HEADER; i < data.length;) {
    const byte = data[i] ?? 0;
    if (byte === 0) {
      if (i + 2 >= data.length) throw new FormatError('LIP zero run cut off', i);
      at += (data[i + 1] ?? 0) | ((data[i + 2] ?? 0) << 8);
      i += 3;
    } else {
      if (at < size) out[at] = byte;
      at++;
      i++;
    }
    if (at > size) throw new FormatError(`LIP block longer than ${String(size)} bytes`, i);
  }
  if (at !== size)
    throw new FormatError(`LIP block of ${String(at)} bytes, expected ${String(size)}`, 0);
  return out;
}

export function parseLip(data: Uint8Array): LipFile {
  if (data.length < HEADER) throw new FormatError('LIP file shorter than its header', 0);
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = header.getUint32(0, true);
  if (version !== 1) throw new FormatError(`LIP version ${String(version)}`, 0);
  const size = header.getUint32(4, true) - SIZE_BIAS;
  if (size < BLOCK_HEADER || size > MAX_BLOCK) {
    throw new FormatError(`LIP block of ${String(size)} bytes`, 4);
  }
  const block = expand(data, size);
  const view = new DataView(block.buffer);
  const frames = view.getInt32(0, true);
  const first = view.getInt32(4, true);
  const phonemes = view.getInt32(8, true);
  const count = (size - BLOCK_HEADER) / 4;
  const curves = frames > 0 ? count / frames : 0;
  if (frames < 0 || !Number.isInteger(curves) || phonemes < 0 || phonemes > curves) {
    throw new FormatError(
      `LIP block of ${String(count)} values for ${String(frames)} frames, ${String(phonemes)} phonemes`,
      HEADER,
    );
  }
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) values[i] = view.getFloat32(BLOCK_HEADER + i * 4, true);
  return { frames, first, phonemes, curves, values };
}

/** The lip file's length in seconds from the start of the audio. */
export function lipDuration(lip: LipFile): number {
  return (lip.frames + lip.first) / LIP_RATE;
}

/**
 * The curves at `time` seconds into the audio, interpolated between frames (zero before the
 * first frame and after the last): `out` gets lip.curves values.
 */
export function sampleLip(lip: LipFile, time: number, out: Float32Array): void {
  out.fill(0);
  const position = time * LIP_RATE - lip.first;
  if (lip.frames === 0 || position < 0 || position > lip.frames - 1) return;
  const frame = Math.floor(position);
  const next = Math.min(lip.frames - 1, frame + 1);
  const t = position - frame;
  const curves = lip.curves;
  for (let c = 0; c < curves && c < out.length; c++) {
    const a = lip.values[frame * curves + c] ?? 0;
    const b = lip.values[next * curves + c] ?? 0;
    out[c] = a + (b - a) * t;
  }
}
