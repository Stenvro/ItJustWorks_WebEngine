import { describe, expect, it } from 'vitest';
import {
  FLASH_SECONDS,
  THUNDER_CHECK_SECONDS,
  fadeShare,
  flashIntensity,
  thunderChance,
} from './lightning.ts';

describe('lightning', () => {
  it('thunders with one chance in the frequency × the thunder sounds at each 30 ms check', () => {
    expect(thunderChance(246, 1)).toBeCloseTo(1 / 246, 12);
    expect(thunderChance(15, 2)).toBeCloseTo(1 / 30, 12);
    // A storm's single thunder: about every 7.4 s.
    expect(THUNDER_CHECK_SECONDS / thunderChance(246, 1)).toBeCloseTo(7.38, 2);
  });

  it('strikes, strikes again and fades', () => {
    expect(flashIntensity(0)).toBe(1);
    expect(flashIntensity(0.2)).toBeLessThan(flashIntensity(0.28));
    expect(flashIntensity(FLASH_SECONDS + 0.01)).toBe(0);
    expect(flashIntensity(-0.1)).toBe(0);
  });

  it('shares a fading effect between the arriving and the leaving weather', () => {
    expect(fadeShare(0.5, 1, false, undefined)).toBe(1);
    expect(fadeShare(0.5, 1, false, 0.25)).toBe(0);
    expect(fadeShare(0.5, 1, false, 0.75)).toBeCloseTo(0.5, 6);
    expect(fadeShare(0, 0.5, true, 0.25)).toBeCloseTo(1 - 0.25 / 0.501, 6);
    expect(fadeShare(0, 0.5, true, 0.6)).toBe(0);
    expect(fadeShare(0, 0, true, undefined)).toBe(0);
  });
});
