import { describe, expect, it } from 'vitest';
import { regionMusic, regionsInEffect, type RegionAudio } from './sound-records.ts';

const region = (priority: number, override: boolean, music?: number): RegionAudio => ({
  priority,
  override,
  sounds: [{ sound: priority, flags: 0xf, chance: 1 }],
  music,
});

describe('regions in effect', () => {
  it('adds regions from the highest priority down, up to the first that overrides', () => {
    const low = region(40, false, 0x1);
    const high = region(60, false);
    const overriding = region(50, true, 0x2);
    expect(regionsInEffect([low, high, overriding])).toEqual([high, overriding]);
    expect(regionsInEffect([low, high])).toEqual([high, low]);
  });

  it('takes the music of the highest-priority region in effect that names one', () => {
    expect(regionMusic([region(40, false, 0x1), region(60, false)])).toBe(0x1);
    expect(regionMusic([region(40, false, 0x1), region(50, true)])).toBeUndefined();
    expect(regionMusic([])).toBeUndefined();
  });
});
