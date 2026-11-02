// What distance does to a placed sound besides its volume. Observed in the original: a sound
// whose output model uses HRTF and attenuates with distance is placed by X3DAudio, with the
// model's maximum distance as the curve distance scaler and X3DAudio's default curves for the
// rest. Over the normalized distance (distance / maximum, 0–1):
//
// - the direct path's low-pass coefficient falls from 1 to 0.75 (X3DAudio's default), which
//   becomes the voice's low-pass filter towards its output: XAudio2's state-variable filter at
//   a radian frequency of 2·sin(π/6 · coefficient) with 1/Q = 1 (a coefficient of 1 is
//   transparent: XAudio2's documented bypass);
// - the reverb level falls from 1 to 0 (X3DAudio's default), scaling the model's reverb send;
//   the reverb send does not follow the volume curve, which X3DAudio puts in the direct path
//   only.
//
// Web Audio has no such filter: a lowpass biquad is fitted to its response (within about a
// decibel over the audible band). Platform-independent.

import type { SoundAttenuation } from '../world/sound-records.ts';

/** The distance as X3DAudio's curves read it: over the maximum distance, 0–1. */
export function curveDistance(attenuation: SoundAttenuation, distance: number): number {
  if (!(attenuation.maxDistance > 0)) return 0;
  return Math.min(1, Math.max(0, distance / attenuation.maxDistance));
}

/** X3DAudio's default direct-path low-pass curve: [0, 1], [1, 0.75]. */
export function directLowPass(normalized: number): number {
  return 1 - 0.25 * normalized;
}

/** X3DAudio's default reverb send curve: [0, 1], [1, 0]. */
export function reverbLevel(normalized: number): number {
  return 1 - normalized;
}

/** XAudio2's filter radian frequency for an X3DAudio low-pass coefficient. */
export function filterFrequency(coefficient: number): number {
  return 2 * Math.sin((Math.PI / 6) * Math.min(1, Math.max(0, coefficient)));
}

/** Magnitude of a second-order section at an angular frequency. */
function magnitude(b: readonly number[], a: readonly number[], w: number): number {
  const part = (c: readonly number[], f: (x: number) => number): number =>
    (c[0] ?? 0) * f(0) + (c[1] ?? 0) * f(w) + (c[2] ?? 0) * f(2 * w);
  const re = (c: readonly number[]): number => part(c, Math.cos);
  const im = (c: readonly number[]): number => -part(c, Math.sin);
  return Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a));
}

/**
 * The low-pass output's gain of XAudio2's state-variable filter (radian frequency `f`,
 * 1/Q = 1) at `frequency` Hz: low(n) = low(n−1) + f·band(n−1), high = x − low − band(n−1),
 * band(n) = f·high + band(n−1).
 */
export function xaudio2LowPassGain(f: number, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate;
  return magnitude([0, f * f, 0], [1, -(2 - f - f * f), 1 - f], w);
}

/** The gain of Web Audio's lowpass BiquadFilterNode (Q in dB, as the node takes it). */
export function biquadLowPassGain(
  cutoff: number,
  qDb: number,
  frequency: number,
  sampleRate: number,
): number {
  if (cutoff >= sampleRate / 2) return 1;
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const c = Math.cos(w0);
  const b = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  return magnitude(b, [1 + alpha, -2 * c, 1 - alpha], (2 * Math.PI * frequency) / sampleRate);
}

/** A lowpass BiquadFilterNode's settings. */
export interface LowPass {
  readonly frequency: number;
  readonly q: number;
}

/** Fitted filters by sample rate, for coefficients in hundredths. */
const fitted = new Map<number, Map<number, LowPass>>();

/**
 * The biquad that stands for XAudio2's filter at an X3DAudio coefficient (hundredths), or
 * undefined at 1 (XAudio2's bypass).
 */
export function lowPassFor(coefficient: number, sampleRate: number): LowPass | undefined {
  const step = Math.round(Math.min(1, Math.max(0, coefficient)) * 100);
  if (step >= 100) return undefined;
  let table = fitted.get(sampleRate);
  if (!table) {
    table = new Map();
    fitted.set(sampleRate, table);
  }
  let filter = table.get(step);
  if (!filter) {
    filter = fit(filterFrequency(step / 100), sampleRate);
    table.set(step, filter);
  }
  return filter;
}

/**
 * Least squares in decibels over the audible band: cutoff and Q in turn, golden sections. The
 * sum runs about 150,000 times a fit (a frame's worth on first use of a coefficient as sounds
 * stream in): each frequency's sines and cosines are taken once, and the biquad's coefficients
 * once per trial (biquadLowPassGain's arithmetic, inlined).
 */
function fit(f: number, sampleRate: number): LowPass {
  const nyquist = sampleRate / 2;
  const frequencies: number[] = [];
  for (let frequency = 50; frequency <= Math.min(16000, nyquist * 0.9); frequency *= 1.08) {
    frequencies.push(frequency);
  }
  const count = frequencies.length;
  const target = new Float64Array(count);
  const cos1 = new Float64Array(count);
  const cos2 = new Float64Array(count);
  const sin1 = new Float64Array(count);
  const sin2 = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const frequency = frequencies[i] ?? 0;
    target[i] = dB(xaudio2LowPassGain(f, frequency, sampleRate));
    const w = (2 * Math.PI * frequency) / sampleRate;
    cos1[i] = Math.cos(w);
    cos2[i] = Math.cos(2 * w);
    sin1[i] = Math.sin(w);
    sin2[i] = Math.sin(2 * w);
  }
  const error = (cutoff: number, qDb: number): number => {
    if (cutoff >= nyquist) {
      let sum = 0;
      for (let i = 0; i < count; i++) sum += (dB(1) - (target[i] ?? 0)) ** 2;
      return sum;
    }
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
    const c = Math.cos(w0);
    const b0 = (1 - c) / 2;
    const b1 = 1 - c;
    const a0 = 1 + alpha;
    const a1 = -2 * c;
    const a2 = 1 - alpha;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const c1 = cos1[i] ?? 0;
      const c2 = cos2[i] ?? 0;
      const s1 = sin1[i] ?? 0;
      const s2 = sin2[i] ?? 0;
      const reB = b0 + b1 * c1 + b0 * c2;
      const imB = -(b1 * s1 + b0 * s2);
      const reA = a0 + a1 * c1 + a2 * c2;
      const imA = -(a1 * s1 + a2 * s2);
      const gain = Math.sqrt((reB * reB + imB * imB) / (reA * reA + imA * imA));
      sum += (dB(gain) - (target[i] ?? 0)) ** 2;
    }
    return sum;
  };
  let cutoff = nyquist * 0.6;
  let q = -3;
  for (let round = 0; round < 6; round++) {
    cutoff = golden((c) => error(c, q), 200, nyquist * 0.999);
    q = golden((value) => error(cutoff, value), -12, 12);
  }
  return { frequency: cutoff, q };
}

function dB(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

/** The minimum of a function on [low, high] (unimodal there). */
function golden(f: (x: number) => number, low: number, high: number): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = low;
  let b = high;
  for (let i = 0; i < 40; i++) {
    const c = b - ratio * (b - a);
    const d = a + ratio * (b - a);
    if (f(c) < f(d)) b = d;
    else a = c;
  }
  return (a + b) / 2;
}
