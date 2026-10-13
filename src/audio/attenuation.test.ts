import { describe, expect, it } from 'vitest';
import type { SoundDescriptor } from '../world/sound-records.ts';
import { dbToGain, distanceGain, instanceGain, instancePitch } from './attenuation.ts';

const descriptor = (overrides: Partial<SoundDescriptor>): SoundDescriptor => ({
  formId: 1,
  editorId: 'Test',
  category: undefined,
  alternateFor: undefined,
  files: [],
  outputModel: undefined,
  looping: 'none',
  frequencyShift: 0,
  frequencyVariance: 0,
  priority: 128,
  dbVariance: 0,
  staticAttenuation: 0,
  conditions: [],
  ...overrides,
});

describe('sound volume and pitch', () => {
  it('follows the output model curve between its distances', () => {
    const near = { minDistance: 150, maxDistance: 1400, curve: [100, 50, 20, 5, 0] };
    expect(distanceGain(near, 0)).toBe(1);
    expect(distanceGain(near, 150)).toBe(1);
    // A quarter of the way: the second point.
    expect(distanceGain(near, 150 + 1250 / 4)).toBeCloseTo(0.5);
    expect(distanceGain(near, 150 + 1250 * 0.375)).toBeCloseTo(0.35);
    expect(distanceGain(near, 1400)).toBe(0);
    expect(distanceGain(near, 1401)).toBe(0);
    // A distant layer: silent close by, loudest half way.
    const distant = { minDistance: 500, maxDistance: 10000, curve: [0, 50, 100, 50, 0] };
    expect(distanceGain(distant, 100)).toBe(0);
    expect(distanceGain(distant, 5250)).toBeCloseTo(1);
    expect(distanceGain(undefined, 1e9)).toBe(1);
  });

  it('applies static attenuation, dB variance and frequency variation', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    const quiet = descriptor({ staticAttenuation: 6, dbVariance: 4 });
    expect(instanceGain(quiet, 0)).toBeCloseTo(dbToGain(-6));
    expect(instanceGain(quiet, 0.5)).toBeCloseTo(dbToGain(-8));
    const pitched = descriptor({ frequencyShift: -10, frequencyVariance: 5 });
    expect(instancePitch(pitched, 0.5)).toBeCloseTo(0.9);
    expect(instancePitch(pitched, 0)).toBeCloseTo(0.85);
    expect(instancePitch(pitched, 0.999999)).toBeCloseTo(0.95);
  });
});
