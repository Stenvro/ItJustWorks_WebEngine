// The reverb of an acoustic space (REVB: I3DL2 parameters, which the original hands to
// XAudio2's reverb) as an impulse response for a convolver, built to the I3DL2 definitions:
//
// - Room and Room HF: the level of all reflected sound (early and late) at low frequencies and
//   its further cut at the HF reference.
// - Reflections and Reflections Delay: the early reflections' energy relative to Room and the
//   delay of the first one after the direct sound.
// - Reverb and Reverb Delay: the late reverberation's energy relative to Room, starting that
//   long after the first reflection.
// - Decay Time and Decay HF Ratio: the late part falls 60 dB over the decay time at low
//   frequencies, over the decay time × the ratio at the HF reference.
// - Diffusion: the echo density of the late part (100 %: dense noise from its start, lower
//   values a sparser, grainier sequence of echoes).
// - Density: its modal density (100 %: smooth; lower values colour it with resonant modes).
//
// Levels are energies (I3DL2): a part's sum of squared samples is its level relative to the
// direct sound, however long its decay. Frequency-dependent parts (the HF decay, the room HF
// cut, the modes) are shaped frame by frame on the spectrum; the low-frequency decay is applied
// sample by sample. Between low frequencies and the HF reference the HF effects grow with the
// square of the frequency (I3DL2 defines only the two points) and hold above it. XAudio2's own
// network is not documented: TODO(M13): its exact echo and modal density. Platform-independent.

import type { Reverb } from '../world/sound-records.ts';

/** Levels at or below this (dB) mean "no reverb" (DefaultReverb has −100 everywhere). */
const SILENT_DB = -90;
/** Early reflections: taps spread over this many milliseconds after the first one. */
const REFLECTION_SPREAD_MS = 20;
const REFLECTION_TAPS = 8;
/** Longest response, seconds. */
const MAX_SECONDS = 8;
/** −60 dB as a natural-log amplitude ratio: ln(1000). */
const LN_1000 = Math.log(1000);
/** Spectral frames: size and hop (half overlapping Hann windows sum to one). */
const FRAME = 2048;
const HOP = FRAME / 2;
/** Echoes a second of the late part at 0 % diffusion (100 %: one each sample). */
const SPARSEST_ECHOES = 1000;
/** Spacing (Hz) of the modes that colour the late part at low density. */
const MODE_SPACING = 100;

/** I3DL2's frequency shape between low frequencies (0) and the HF reference (1). */
export function hfShape(frequency: number, hfReference: number): number {
  return Math.min(1, (frequency / Math.max(20, hfReference)) ** 2);
}

/** Seconds the late part takes to fall 60 dB at a frequency (I3DL2's decay and HF ratio). */
export function decayTimeAt(reverb: Reverb, frequency: number): number {
  const low = Math.max(0.1, reverb.decayTime / 1000);
  const high = Math.max(0.01, low * reverb.decayHfRatio);
  const rate = 1 / low + (1 / high - 1 / low) * hfShape(frequency, reverb.hfReference);
  return 1 / Math.max(rate, 1e-3);
}

/**
 * The impulse response of a reverb (stereo), or undefined when it is silent. `random` gives
 * values in [0, 1) (seeded by the caller for a stable response).
 */
export function reverbImpulse(
  reverb: Reverb,
  sampleRate: number,
  random: () => number,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] | undefined {
  if (reverb.room <= SILENT_DB || (reverb.reverb <= SILENT_DB && reverb.reflections <= SILENT_DB)) {
    return undefined;
  }
  const low = Math.max(0.1, reverb.decayTime / 1000);
  const longest = Math.max(low, decayTimeAt(reverb, reverb.hfReference));
  const reflectionsDelay = reverb.reflectionsDelay / 1000;
  const lateStart = reflectionsDelay + reverb.reverbDelay / 1000;
  const length = Math.max(
    FRAME,
    Math.ceil(Math.min(MAX_SECONDS, lateStart + longest) * sampleRate),
  );
  const earlyEnergy =
    reverb.reflections <= SILENT_DB ? 0 : 10 ** ((reverb.room + reverb.reflections) / 10);
  const lateEnergy = reverb.reverb <= SILENT_DB ? 0 : 10 ** ((reverb.room + reverb.reverb) / 10);
  const roomHf = (frequency: number): number =>
    10 ** ((reverb.roomHf * hfShape(frequency, reverb.hfReference)) / 20);
  // Late part: the HF decay beyond the low one's, the room HF cut and the modes.
  const lowRate = LN_1000 / low;
  const depth = 0.9 * (1 - Math.min(100, Math.max(0, reverb.density)) / 100);
  const lateGain = (frequency: number, time: number): number => {
    const extra = LN_1000 / decayTimeAt(reverb, frequency) - lowRate;
    const modes = Math.sqrt(1 + depth * Math.cos((2 * Math.PI * frequency) / MODE_SPACING));
    return roomHf(frequency) * modes * Math.exp(-extra * Math.max(0, time - lateStart));
  };
  // The late part's echoes: each sample one with this chance (energy kept per echo).
  const echoes = Math.min(1, Math.max(0, reverb.diffusion) / 100);
  const chance = Math.min(
    1,
    (SPARSEST_ECHOES / sampleRate) * (sampleRate / SPARSEST_ECHOES) ** echoes,
  );
  // Its low-frequency energy is the Reverb level: the decaying envelope's squared sum.
  const start = Math.min(length, Math.round(lateStart * sampleRate));
  const step = Math.exp((-2 * lowRate) / sampleRate);
  const envelopeEnergy = (1 - step ** (length - start)) / (1 - step);
  const lateScale = Math.sqrt(lateEnergy / envelopeEnergy);
  const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  for (const channel of channels) {
    if (lateEnergy > 0) {
      const late = new Float32Array(length);
      let amplitude = lateScale;
      const fall = Math.sqrt(step);
      for (let i = start; i < length; i++) {
        if (random() < chance) late[i] = (gaussian(random) * amplitude) / Math.sqrt(chance);
        amplitude *= fall;
      }
      shapeSpectrum(late, channel, sampleRate, start, length, lateGain);
    }
    if (earlyEnergy > 0) {
      // The first reflection at the reflections delay, the rest spread after it; their
      // energies add up to the Reflections level.
      const early = new Float32Array(length);
      const tap = Math.sqrt(earlyEnergy / REFLECTION_TAPS);
      for (let i = 0; i < REFLECTION_TAPS; i++) {
        const at = reflectionsDelay + (i === 0 ? 0 : (random() * REFLECTION_SPREAD_MS) / 1000);
        const index = Math.min(length - 1, Math.round(at * sampleRate));
        early[index] = (early[index] ?? 0) + tap * (random() < 0.5 ? -1 : 1);
      }
      const first = Math.round(reflectionsDelay * sampleRate);
      const last = Math.min(
        length,
        first + Math.ceil((REFLECTION_SPREAD_MS / 1000) * sampleRate) + 1,
      );
      shapeSpectrum(early, channel, sampleRate, first, last, roomHf);
    }
  }
  return channels;
}

/** A normally distributed value (mean 0, variance 1) from uniform ones. */
function gaussian(random: () => number): number {
  const u = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * Adds `input` (non-zero in [from, to)) to `output` with each frame's spectrum scaled by
 * `gain(frequency, time)`: Hann frames half overlapping, which sum back to the input where
 * the gain is one. The frames' filtering spreads at most a frame around the part.
 */
function shapeSpectrum(
  input: Float32Array,
  output: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  gain: (frequency: number, time: number) => number,
): void {
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const gains = new Float64Array(FRAME / 2 + 1);
  const firstFrame = Math.max(-HOP, Math.floor((from - FRAME) / HOP) * HOP);
  for (let frame = firstFrame; frame < to; frame += HOP) {
    let any = false;
    for (let i = 0; i < FRAME; i++) {
      const sample = input[frame + i] ?? 0;
      re[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
      im[i] = 0;
      if (sample !== 0) any = true;
    }
    if (!any) continue;
    fft(re, im, false);
    const time = (frame + FRAME / 2) / sampleRate;
    for (let bin = 0; bin <= FRAME / 2; bin++) gains[bin] = gain((bin * sampleRate) / FRAME, time);
    for (let bin = 0; bin < FRAME; bin++) {
      const g = gains[Math.min(bin, FRAME - bin)] ?? 0;
      re[bin] = (re[bin] ?? 0) * g;
      im[bin] = (im[bin] ?? 0) * g;
    }
    fft(re, im, true);
    for (let i = 0; i < FRAME; i++) {
      const at = frame + i;
      if (at >= 0 && at < output.length) output[at] = (output[at] ?? 0) + (re[i] ?? 0);
    }
  }
}

/** In-place radix-2 FFT (`inverse`: scaled by 1/n). The length is a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = r;
      const m = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = m;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] ?? 0) / n;
      im[i] = (im[i] ?? 0) / n;
    }
  }
}
