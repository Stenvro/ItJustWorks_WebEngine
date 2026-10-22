import { describe, expect, it } from 'vitest';
import { COMBAT_DEFAULTS } from './combat-settings.ts';
import { WeaponBlood, weaponBloodCutoff } from './weapon-blood.ts';

const settings = COMBAT_DEFAULTS;

describe('weaponBloodCutoff', () => {
  it('stays fresh for fWeaponBloodLifetime, then dries over fWeaponBloodFadeDuration', () => {
    expect(weaponBloodCutoff(0, settings)).toBe(0);
    expect(weaponBloodCutoff(10, settings)).toBe(0);
    expect(weaponBloodCutoff(40, settings)).toBeCloseTo(0.5);
    expect(weaponBloodCutoff(70, settings)).toBe(1);
    expect(weaponBloodCutoff(Infinity, settings)).toBe(1);
  });

  it('shows none for blood that never was', () => {
    expect(weaponBloodCutoff(Number.NaN, settings)).toBe(1);
    expect(weaponBloodCutoff(-1, settings)).toBe(1);
  });
});

describe('WeaponBlood', () => {
  it('starts clean, bleeds at a hit and dries away', () => {
    const blood = new WeaponBlood(settings);
    expect(blood.cutoff).toBe(1);
    expect(blood.sheen).toBe(0);
    expect(blood.falloff).toBeCloseTo(0.07);
    const before = blood.version;
    blood.hit();
    expect(blood.cutoff).toBe(0);
    expect(blood.sheen).toBe(1);
    expect(blood.version).toBeGreaterThan(before);
    blood.advance(5);
    const fresh = blood.version;
    blood.advance(5);
    // Still fresh: nothing to write again.
    expect(blood.version).toBe(fresh);
    blood.advance(30);
    expect(blood.cutoff).toBeCloseTo(0.5);
    expect(blood.sheen).toBeCloseTo(0.5);
    blood.advance(100);
    expect(blood.cutoff).toBe(1);
    expect(blood.sheen).toBe(0);
  });

  it('is fresh again at another hit', () => {
    const blood = new WeaponBlood(settings);
    blood.hit();
    blood.advance(50);
    expect(blood.cutoff).toBeGreaterThan(0);
    blood.hit();
    expect(blood.cutoff).toBe(0);
  });

  it('follows the load order settings', () => {
    const blood = new WeaponBlood({
      ...settings,
      weaponBloodLifetime: 0,
      weaponBloodFalloffThreshold: 0.2,
    });
    expect(blood.falloff).toBe(0.2);
    blood.hit();
    blood.advance(30);
    expect(blood.cutoff).toBeCloseTo(0.5);
  });
});
