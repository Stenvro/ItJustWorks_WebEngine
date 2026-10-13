import { describe, expect, it } from 'vitest';
import type { Reverb } from '../world/sound-records.ts';
import { reverbImpulse } from './reverb.ts';

const reverb = (overrides: Partial<Reverb>): Reverb => ({
  formId: 1,
  editorId: 'Test',
  decayTime: 1000,
  hfReference: 5000,
  room: -3,
  roomHf: -4,
  reflections: -5,
  reverb: 0,
  decayHfRatio: 1,
  reflectionsDelay: 20,
  reverbDelay: 30,
  diffusion: 100,
  density: 100,
  ...overrides,
});

let seed = 1;
const random = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const rms = (channel: Float32Array, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (channel[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};

describe('reverb impulse', () => {
  it('is silent for the default reverb', () => {
    expect(
      reverbImpulse(
        reverb({ room: -100, roomHf: -100, reflections: -100, reverb: -100 }),
        48000,
        random,
      ),
    ).toBeUndefined();
  });

  it('starts after the delays and falls 60 dB over the decay time', () => {
    const rate = 8000;
    const impulse = reverbImpulse(reverb({}), rate, random);
    if (!impulse) throw new Error('no impulse');
    const [left] = impulse;
    // Nothing before the reflections (20 ms).
    expect(rms(left, 0, Math.floor(0.019 * rate))).toBe(0);
    // The late part starts at 50 ms; a second later it is about 60 dB down.
    const start = rms(left, Math.floor(0.05 * rate), Math.floor(0.1 * rate));
    const end = rms(left, Math.floor(1.0 * rate), Math.floor(1.05 * rate));
    expect(start).toBeGreaterThan(0);
    expect(20 * Math.log10(end / start)).toBeLessThan(-45);
    expect(20 * Math.log10(end / start)).toBeGreaterThan(-75);
  });
});
