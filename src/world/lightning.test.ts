import { describe, expect, it } from 'vitest';
import { FLASH_SECONDS, flashIntensity, lightningInterval, thunderAmount } from './lightning.ts';

describe('lightning', () => {
  it('flashes only in weathers with thunder, more often for lower frequencies', () => {
    expect(lightningInterval(255)).toBeUndefined();
    expect(lightningInterval(246)).toBeCloseTo(28.9, 1);
    expect(lightningInterval(15)).toBeCloseTo(1.76, 2);
  });

  it('strikes, strikes again and fades', () => {
    expect(flashIntensity(0)).toBe(1);
    expect(flashIntensity(0.2)).toBeLessThan(flashIntensity(0.28));
    expect(flashIntensity(FLASH_SECONDS + 0.01)).toBe(0);
    expect(flashIntensity(-0.1)).toBe(0);
  });

  it('fades thunder in and out with a change of weather', () => {
    const storm = { thunderFrequency: 246, thunderFadeIn: 0.5, thunderFadeOut: 0.5 };
    const calm = { thunderFrequency: 255, thunderFadeIn: 0, thunderFadeOut: 0 };
    expect(thunderAmount(storm, undefined, 1)).toBe(1);
    expect(thunderAmount(storm, calm, 0.25)).toBe(0);
    expect(thunderAmount(storm, calm, 0.75)).toBeCloseTo(0.5, 6);
    expect(thunderAmount(calm, storm, 0.25)).toBeCloseTo(0.5, 6);
    expect(thunderAmount(calm, undefined, 1)).toBe(0);
  });
});
