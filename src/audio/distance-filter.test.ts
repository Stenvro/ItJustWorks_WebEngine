import { describe, expect, it } from 'vitest';
import {
  biquadLowPassGain,
  curveDistance,
  directLowPass,
  filterFrequency,
  lowPassFor,
  reverbLevel,
  xaudio2LowPassGain,
} from './distance-filter.ts';

const model = { minDistance: 100, maxDistance: 2000, curve: [100, 60, 30, 10, 0] };

describe('distance low-pass and reverb send', () => {
  it("reads X3DAudio's default curves over the output model's maximum distance", () => {
    expect(curveDistance(model, 0)).toBe(0);
    expect(curveDistance(model, 1000)).toBe(0.5);
    expect(curveDistance(model, 5000)).toBe(1);
    expect(directLowPass(0)).toBe(1);
    expect(directLowPass(curveDistance(model, 1000))).toBe(0.875);
    expect(directLowPass(1)).toBe(0.75);
    expect(reverbLevel(curveDistance(model, 500))).toBe(0.75);
    expect(reverbLevel(1)).toBe(0);
  });

  it("is XAudio2's state-variable filter: transparent at 1, a low-pass below", () => {
    expect(filterFrequency(1)).toBeCloseTo(1, 9);
    for (const frequency of [100, 5000, 20000]) {
      expect(xaudio2LowPassGain(filterFrequency(1), frequency, 48000)).toBeCloseTo(1, 9);
    }
    const far = filterFrequency(0.75);
    expect(xaudio2LowPassGain(far, 200, 48000)).toBeCloseTo(1, 2);
    // About −4.7 dB at 12 kHz for a sound at its maximum distance.
    const cut = 20 * Math.log10(xaudio2LowPassGain(far, 12000, 48000));
    expect(cut).toBeCloseTo(-4.7, 1);
    expect(lowPassFor(1, 48000)).toBeUndefined();
  });

  it('fits a biquad within about a decibel over the audible band', () => {
    for (const rate of [44100, 48000]) {
      for (const coefficient of [0.75, 0.85, 0.95]) {
        const filter = lowPassFor(coefficient, rate);
        if (!filter) throw new Error('no filter');
        for (let frequency = 50; frequency <= 16000; frequency *= 1.2) {
          const want =
            20 * Math.log10(xaudio2LowPassGain(filterFrequency(coefficient), frequency, rate));
          const got =
            20 * Math.log10(biquadLowPassGain(filter.frequency, filter.q, frequency, rate));
          expect(Math.abs(got - want)).toBeLessThan(1.2);
        }
      }
    }
  });
});
