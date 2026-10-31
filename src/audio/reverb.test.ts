import { describe, expect, it } from 'vitest';
import type { Reverb } from '../world/sound-records.ts';
import { decayTimeAt, fft, reverbImpulse } from './reverb.ts';

const reverb = (overrides: Partial<Reverb>): Reverb => ({
  formId: 1,
  editorId: 'Test',
  decayTime: 1000,
  hfReference: 2000,
  room: -3,
  roomHf: 0,
  reflections: -5,
  reverb: 0,
  decayHfRatio: 1,
  reflectionsDelay: 20,
  reverbDelay: 30,
  diffusion: 100,
  density: 100,
  ...overrides,
});

const seeded = (): (() => number) => {
  let seed = 1;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
};

const RATE = 16000;

const build = (overrides: Partial<Reverb>): [Float32Array, Float32Array] => {
  const impulse = reverbImpulse(reverb(overrides), RATE, seeded());
  if (!impulse) throw new Error('no impulse');
  return impulse;
};

const energy = (channel: Float32Array, from = 0, to = channel.length): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (channel[i] ?? 0) ** 2;
  return sum;
};

/** Mean power (dB) of the bins between two frequencies in a window starting at `at` seconds. */
const bandDb = (channel: Float32Array, at: number, low: number, high: number): number => {
  const size = 2048;
  const start = Math.round(at * RATE);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = channel[start + i] ?? 0;
  fft(re, im, false);
  let sum = 0;
  let bins = 0;
  for (let bin = Math.ceil((low * size) / RATE); bin <= (high * size) / RATE; bin++) {
    sum += (re[bin] ?? 0) ** 2 + (im[bin] ?? 0) ** 2;
    bins++;
  }
  return 10 * Math.log10(sum / bins);
};

describe('reverb impulse (I3DL2)', () => {
  it('is silent for the default reverb', () => {
    expect(
      reverbImpulse(
        reverb({ room: -100, roomHf: -100, reflections: -100, reverb: -100 }),
        48000,
        seeded(),
      ),
    ).toBeUndefined();
  });

  it('starts with the first reflection at the reflections delay, the late part after the reverb delay', () => {
    const [left] = build({ reverb: -100 });
    const peak = Math.max(...left.map(Math.abs));
    const first = left.findIndex((sample) => Math.abs(sample) > peak * 1e-3);
    expect(first).toBe(Math.round(0.02 * RATE));
    const [late] = build({ reflections: -100 });
    const lateStart = Math.round(0.05 * RATE);
    // The spectral shaping leaves only rounding before it.
    expect(energy(late, 0, lateStart)).toBeLessThan(1e-9 * energy(late));
    expect(energy(late, lateStart, lateStart + 160)).toBeGreaterThan(0);
  });

  it('falls 60 dB over the decay time at low frequencies and over decay × HF ratio at the HF reference', () => {
    const tail = { decayTime: 1500, decayHfRatio: 0.5, reflections: -100 };
    const channels = build(tail);
    const slope = (low: number, high: number): number => {
      let drop = 0;
      for (const channel of channels) {
        drop += bandDb(channel, 0.15, low, high) - bandDb(channel, 0.55, low, high);
      }
      // dB a second, both channels' mean.
      return drop / 2 / 0.4;
    };
    // 60 dB over 1.5 s at low frequencies (40 dB a second).
    expect(slope(150, 350)).toBeCloseTo(60 / decayTimeAt(reverb(tail), 250), -1);
    expect(Math.abs(slope(150, 350) - 40)).toBeLessThan(4);
    // 60 dB over 0.75 s at the HF reference (80 dB a second) and above.
    expect(Math.abs(slope(2000, 3000) - 80)).toBeLessThan(8);
  });

  it('cuts the reflected sound by Room HF at the HF reference', () => {
    const channels = build({ roomHf: -6, reflections: -100 });
    let cut = 0;
    for (const channel of channels) {
      cut += bandDb(channel, 0.1, 2000, 4000) - bandDb(channel, 0.1, 100, 300);
    }
    expect(Math.abs(cut / 2 + 6)).toBeLessThan(1.5);
  });

  it('gives the tail and the reflections the energy their levels name, however long', () => {
    for (const decayTime of [500, 2877, 6000]) {
      // Room −3 dB, reverb 0 dB: the tail's energy is 10^(−3/10), about 0.5.
      const [left, right] = build({ decayTime, reflections: -100 });
      const level = 10 * Math.log10((energy(left) + energy(right)) / 2);
      expect(Math.abs(level + 3)).toBeLessThan(0.5);
    }
    // Only reflections (−7 dB under room −3 dB): 10 dB under the direct sound.
    const [, right] = build({ reverb: -100, reflections: -7 });
    expect(10 * Math.log10(energy(right))).toBeCloseTo(-10, 1);
  });

  it('thins the late part into separate echoes at low diffusion', () => {
    // Sparse echoes stand out of their surroundings: a higher peak over the mean level.
    const crest = (channel: Float32Array): number => {
      const from = Math.round(0.05 * RATE);
      const to = Math.round(0.25 * RATE);
      let peak = 0;
      for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
      return peak / Math.sqrt(energy(channel, from, to) / (to - from));
    };
    const dense = build({ reflections: -100, diffusion: 100 });
    const sparse = build({ reflections: -100, diffusion: 0 });
    expect(crest(sparse[0])).toBeGreaterThan(2 * crest(dense[0]));
  });
});
