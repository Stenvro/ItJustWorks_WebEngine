// Decoding xWMA (WMA v2/Pro in RIFF "XWMA") with ffmpeg compiled to WebAssembly
// (@ffmpeg/core, the single-threaded build, served locally): the file goes into ffmpeg's
// in-memory file system and comes out as 32-bit float samples, interleaved, at the file's own
// rate. The core is loaded by the platform (a worker in the browser, tools/ffmpeg-node.ts in
// Node) and handed in. Platform-independent. Notes: docs/formats/audio.md.

import { encodeWav16, type PcmAudio } from '../formats/audio/wav.ts';
import { parseXwma } from '../formats/audio/xwma.ts';

/** The parts of an ffmpeg.wasm core (createFFmpegCore) used here. */
export interface FfmpegCore {
  readonly FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  exec(...args: string[]): number;
  readonly ret: number;
  reset(): void;
  setLogger(logger: (event: { type: string; message: string }) => void): void;
}

let sequence = 0;

/** Decodes an xWMA file to floats per channel. */
export function decodeXwma(core: FfmpegCore, bytes: Uint8Array): PcmAudio {
  const { format, frames } = parseXwma(bytes);
  const raw = runFfmpeg(core, bytes, 'f32le');
  return deinterleave(raw, format.channels, format.sampleRate, frames);
}

/**
 * How much quieter streamed music is stored (its player turns it back up): WMA decodes to
 * floats that overshoot full scale (the main theme peaks at 1.16), which 16 bits would clip;
 * half the level leaves 6 dB of headroom.
 */
export const STREAM_HEADROOM = 2;

/**
 * Decodes an xWMA file to a 16-bit PCM WAV file (music, which the browser streams) at
 * 1 / STREAM_HEADROOM of its level, cut to the file's own frame count like decodeXwma.
 */
export function decodeXwmaToWav(core: FfmpegCore, bytes: Uint8Array): Uint8Array {
  const { format, frames } = parseXwma(bytes);
  const raw = runFfmpeg(core, bytes, 'f32le');
  const channels = Math.max(1, format.channels);
  const available = Math.floor(raw.byteLength / 4 / channels);
  const length = frames > 0 ? Math.min(frames, available) : available;
  const samples = new Int16Array(length * channels);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < samples.length; i++) {
    const value = view.getFloat32(i * 4, true) / STREAM_HEADROOM;
    samples[i] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
  }
  return encodeWav16(format.sampleRate, channels, samples);
}

/** Runs ffmpeg on an xWMA file: raw interleaved samples, little-endian. */
function runFfmpeg(core: FfmpegCore, bytes: Uint8Array, sampleFormat: 'f32le'): Uint8Array {
  const id = String(sequence++);
  const input = `in${id}.xwm`;
  const output = `out${id}.raw`;
  const errors: string[] = [];
  core.setLogger((event) => {
    if (event.type === 'stderr' && /error|invalid/i.test(event.message)) errors.push(event.message);
  });
  core.FS.writeFile(input, bytes);
  try {
    core.exec(
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-f',
      sampleFormat,
      '-c:a',
      `pcm_${sampleFormat}`,
      output,
    );
    const result = core.ret;
    core.reset();
    if (result !== 0) {
      throw new Error(
        `ffmpeg could not decode the xWMA file (${String(result)}): ${errors.join('; ')}`,
      );
    }
    const raw = core.FS.readFile(output);
    core.FS.unlink(output);
    return raw;
  } finally {
    core.FS.unlink(input);
  }
}

/**
 * Interleaved little-endian floats to one array per channel. ffmpeg's WMA decoder may emit a
 * little more or less than the "dpds" count; the file's own frame count wins when it is known.
 */
function deinterleave(
  raw: Uint8Array,
  channels: number,
  sampleRate: number,
  frames: number,
): PcmAudio {
  const count = Math.max(1, channels);
  const available = Math.floor(raw.byteLength / 4 / count);
  const length = frames > 0 ? Math.min(frames, available) : available;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out = Array.from({ length: count }, () => new Float32Array(length));
  for (let frame = 0; frame < length; frame++) {
    for (let c = 0; c < count; c++) {
      const target = out[c];
      if (target) target[frame] = view.getFloat32((frame * count + c) * 4, true);
    }
  }
  return { sampleRate, channels: out };
}
