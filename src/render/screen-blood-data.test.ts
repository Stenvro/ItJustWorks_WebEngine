import { describe, expect, it } from 'vitest';
import {
  SCREEN_BLOOD_DEFAULTS as settings,
  ScreenBlood,
  screenBloodSettings,
  splatFade,
  splattersForHit,
} from './screen-blood-data.ts';

/** Dice that roll the given values in turn (then 0.5). */
const dice =
  (...values: number[]) =>
  () =>
    values.shift() ?? 0.5;

describe('screen blood', () => {
  it('reads its GMSTs, keeping the vanilla values where none is set', () => {
    const read = screenBloodSettings((name) => (name === 'fBloodSplatterDuration' ? 8 : undefined));
    expect(read.duration).toBe(8);
    expect(read.maxCount).toBe(25);
    expect(read.fadeStart).toBeCloseTo(0.4);
  });

  it('shows full until the fade start of its life, then fades to nothing', () => {
    // fBloodSplatterDuration 20, fBloodSplatterFadeStart 0.4: full for 8 s, gone at 20 s.
    expect(splatFade(0, settings)).toBe(1);
    expect(splatFade(8, settings)).toBe(1);
    expect(splatFade(14, settings)).toBeCloseTo(0.5);
    expect(splatFade(20, settings)).toBe(0);
  });

  it('splatters with the settings sizes and opacities and drops them at their end', () => {
    const blood = new ScreenBlood(settings);
    // x, y, size, rotation (opacity chance first): the second opacity range on a roll below 0.3.
    blood.splatter(1, 100, dice(0.9, 0, 0, 1, 0, 0, 0));
    blood.splatter(1, 105, dice(0.1, 0.5, 0.5, 0, 0, 0, 0));
    let shown = blood.frame(105);
    expect(shown).toHaveLength(2);
    expect(shown[0]?.size).toBeCloseTo(settings.maxSize);
    expect(shown[0]?.alpha).toBeCloseTo(settings.minOpacity);
    expect(shown[1]?.size).toBeCloseTo(settings.minSize);
    expect(shown[1]?.alpha).toBeCloseTo(settings.minOpacity2);
    expect(shown[1]?.flareAlpha).toBeCloseTo(settings.minOpacity2 * settings.flareMult);
    shown = blood.frame(120);
    expect(shown).toHaveLength(1);
    expect(blood.count).toBe(1);
    expect(blood.frame(125)).toHaveLength(0);
    expect(blood.count).toBe(0);
  });

  it('keeps at most iBloodSplatterMaxCount, the oldest going first', () => {
    const blood = new ScreenBlood({ ...settings, maxCount: 3 });
    blood.splatter(5, 0);
    expect(blood.count).toBe(3);
  });

  it('splatters once for a hit, twice for a power attack', () => {
    expect(splattersForHit(false)).toBe(1);
    expect(splattersForHit(true)).toBe(2);
  });
});
