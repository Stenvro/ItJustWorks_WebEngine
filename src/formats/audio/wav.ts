// WAV sound effects (RIFF "WAVE"): all of the vanilla ones are 16-bit PCM, mono or stereo, at
// 11025 to 44100 Hz. Looping sounds carry their loop in a sampler chunk ("smpl"); Bethesda's
// tools leave "LIST" (INFO) and "CDif" chunks, which the engine does not need. A RIFF "XWMA"
// file may have a .wav name as well (see xwma.ts). Notes: docs/formats/audio.md.

import { FormatError } from '../binary-reader.ts';
import {
  chunk,
  parseRiff,
  parseWaveFormat,
  requireChunk,
  WAVE_FORMAT,
  type WaveFormat,
} from './riff.ts';

/** A sound decoded to floats: one array per channel, −1 to 1. */
export interface PcmAudio {
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
  /** The sampler chunk's first loop, in frames (end exclusive). */
  readonly loop?: { readonly start: number; readonly end: number };
}

export interface WavFile {
  readonly format: WaveFormat;
  /** The sample data (a view on the file). */
  readonly data: Uint8Array;
  /** Number of sample frames. */
  readonly frames: number;
  readonly loop: { readonly start: number; readonly end: number } | undefined;
}

/** SMPL: 36 bytes of sampler data, then 24 bytes per loop (cue id, type, start, end, ...). */
const SMPL_HEADER = 36;

export function parseWav(bytes: Uint8Array): WavFile {
  const riff = parseRiff(bytes);
  if (riff.form !== 'WAVE') throw new FormatError(`RIFF ${riff.form} is not a WAVE file`, 8);
  const format = parseWaveFormat(requireChunk(riff, 'fmt '));
  const data = requireChunk(riff, 'data').data;
  if (format.blockAlign <= 0) throw new FormatError('WAV with a block align of 0', 0);
  const frames = Math.floor(data.byteLength / format.blockAlign);
  let loop: WavFile['loop'];
  const smpl = chunk(riff, 'smpl');
  if (smpl && smpl.data.byteLength >= SMPL_HEADER + 24) {
    const view = new DataView(smpl.data.buffer, smpl.data.byteOffset, smpl.data.byteLength);
    if (view.getUint32(28, true) > 0) {
      const start = view.getUint32(SMPL_HEADER + 8, true);
      // The end is the last frame of the loop.
      const end = Math.min(frames, view.getUint32(SMPL_HEADER + 12, true) + 1);
      if (end > start) loop = { start, end };
    }
  }
  return { format, data, frames, loop };
}

/** Converts a WAV's integer or float samples to floats per channel. */
export function decodeWav(wav: WavFile): PcmAudio {
  const { format, data, frames } = wav;
  const kind = format.subFormat;
  const bytes = format.bitsPerSample / 8;
  if (
    !(kind === WAVE_FORMAT.pcm && [1, 2, 3, 4].includes(bytes)) &&
    !(kind === WAVE_FORMAT.float && bytes === 4)
  ) {
    throw new FormatError(
      `Unsupported WAV format ${String(kind)} with ${String(format.bitsPerSample)} bits`,
      0,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    const base = frame * format.blockAlign;
    for (let c = 0; c < format.channels; c++) {
      const at = base + c * bytes;
      let value: number;
      if (kind === WAVE_FORMAT.float) value = view.getFloat32(at, true);
      else if (bytes === 2) value = view.getInt16(at, true) / 32768;
      else if (bytes === 1) value = (view.getUint8(at) - 128) / 128;
      else if (bytes === 3) {
        const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        value = raw / 8388608;
      } else value = view.getInt32(at, true) / 2147483648;
      const target = channels[c];
      if (target) target[frame] = value;
    }
  }
  return {
    sampleRate: format.sampleRate,
    channels,
    ...(wav.loop && { loop: wav.loop }),
  };
}
