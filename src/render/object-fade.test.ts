import { describe, expect, it } from 'vitest';
import {
  FADE_MIN_NEAR_DISTANCE,
  FADE_START_PERCENT,
  HAS_DISTANT_LOD,
  IS_FULL_LOD,
  fadeKind,
  fadeRange,
  fadeValue,
  neverFades,
  settledFadeReach,
  stepFade,
  type FadeState,
} from './object-fade.ts';

const SETTINGS = { actors: 9, items: 6, objects: 9 };

describe('object fade', () => {
  it('sorts references by their base into actor, item and object fade', () => {
    expect(fadeKind('NPC_')).toBe('actor');
    for (const type of ['WEAP', 'ARMO', 'MISC', 'BOOK', 'INGR', 'ALCH', 'AMMO', 'KEYM', 'SLGM']) {
      expect(fadeKind(type)).toBe('item');
    }
    expect(fadeKind('LIGH', true)).toBe('item');
    expect(fadeKind('LIGH')).toBe('object');
    for (const type of ['STAT', 'MSTT', 'FURN', 'CONT', 'ACTI', 'TREE', 'FLOR', 'DOOR']) {
      expect(fadeKind(type)).toBe('object');
    }
  });

  it('fades at ten bound radii, stretched by the multiplier of each kind', () => {
    // Radius 100: 1000 units, from 600; Object Fade 9 stretches that ninefold.
    expect(fadeRange('object', 100, SETTINGS)).toEqual({ start: 600 * 9, end: 1000 * 9 });
    expect(fadeRange('item', 100, SETTINGS)).toEqual({ start: 600 * 6, end: 1000 * 6 });
    expect(fadeRange('actor', 100, SETTINGS).end).toBe(1000 * 9);
    // Small bounds: never nearer than 500 units (and 1000 before they are gone).
    expect(fadeRange('item', 2, SETTINGS)).toEqual({
      start: FADE_MIN_NEAR_DISTANCE * 6,
      end: 2 * FADE_MIN_NEAR_DISTANCE * 6,
    });
    // Large bounds: no farther than the loaded grid's edge less the radius and half a cell
    // (5 cells: 10240 - (900 + 2048) = 7292).
    expect(fadeRange('object', 900, SETTINGS).end).toBeCloseTo(7292 * 9);
    expect(fadeRange('object', 900, SETTINGS, 3).end).toBeCloseTo((6144 - 2948) * 9);
    // A multiplier of 0: the kind never fades.
    expect(fadeRange('object', 100, { ...SETTINGS, objects: 0 }).end).toBe(Infinity);
  });

  it('gives a fade value of 1 at the start of the range and 0 at its end', () => {
    const { start, end } = fadeRange('object', 200, SETTINGS);
    expect(start).toBeCloseTo(end * FADE_START_PERCENT);
    expect(fadeValue(start, start, end)).toBeCloseTo(1);
    expect(fadeValue((start + end) / 2, start, end)).toBeCloseTo(0.5);
    expect(fadeValue(end * 2, start, end)).toBeLessThan(0);
    expect(fadeValue(1e9, Infinity, Infinity)).toBe(1);
  });

  it('fades in over 1.2 s past 0.7 and out over 2 s below 0.3, with hysteresis', () => {
    const state: FadeState = { alpha: 0, shown: false };
    // Not in view the frame before: it is shown at once.
    stepFade(state, 0.8, 0.016, false);
    expect(state).toEqual({ alpha: 1, shown: true });
    // Between the thresholds a shown reference stays.
    stepFade(state, 0.5, 0.5, true);
    expect(state.alpha).toBe(1);
    // Below 0.3 it fades out by dt / 2 a frame, at most 0.1 a frame.
    stepFade(state, 0.2, 0.1, true);
    expect(state.alpha).toBeCloseTo(0.95);
    stepFade(state, 0.2, 1, true);
    expect(state.alpha).toBeCloseTo(0.85);
    // Back above 0.3 while fading: it fades in again by dt / 1.2.
    stepFade(state, 0.5, 0.06, true);
    expect(state.alpha).toBeCloseTo(0.9);
    expect(state.shown).toBe(true);
    // Far away and out of view: hidden at once; it waits for 0.7 to come back.
    stepFade(state, -1, 0.016, false);
    expect(state).toEqual({ alpha: 0, shown: false });
    stepFade(state, 0.5, 0.1, true);
    expect(state.alpha).toBe(0);
    stepFade(state, 0.75, 0.06, true);
    expect(state.alpha).toBeCloseTo(0.05);
  });

  it('never fades references with distant LOD; full LOD ones fade far as the sky cell', () => {
    expect(neverFades('STAT', HAS_DISTANT_LOD, 0)).toBe(true);
    expect(neverFades('TREE', HAS_DISTANT_LOD, 0)).toBe(true);
    expect(neverFades('STAT', 0, 0)).toBe(false);
    expect(neverFades('MISC', 0, IS_FULL_LOD)).toBe(false);
    expect(neverFades('STAT', HAS_DISTANT_LOD, IS_FULL_LOD)).toBe(false);
    expect(fadeKind('STAT', false, IS_FULL_LOD)).toBe('skyCell');
    // fSkyCellRefFadeDistance whatever its size, by fLODFadeOutMultSkyCell.
    const settings = { actors: 6, items: 3, objects: 5, skyCell: 2 };
    expect(fadeRange('skyCell', 10, settings)).toEqual({ start: 180000, end: 300000 });
    // 0x8000 means something else on items: they still fade.
    expect(neverFades('MISC', HAS_DISTANT_LOD, 0)).toBe(false);
  });
});

describe('a settled fade', () => {
  const start = 4000;
  const end = 6000;
  const settled = (shown: boolean): FadeState => ({ alpha: shown ? 1 : 0, shown });

  it('stays as it is while the camera moves less than its reach', () => {
    for (const shown of [true, false]) {
      for (let distance = 0; distance <= 9000; distance += 37) {
        const reach = settledFadeReach(settled(shown), distance, start, end);
        if (!(reach > 0)) continue;
        for (const step of [-0.999, -0.5, 0, 0.5, 0.999]) {
          const state = settled(shown);
          stepFade(state, fadeValue(distance + step * reach, start, end), 1 / 60, true);
          expect(state).toEqual(settled(shown));
        }
      }
    }
  });

  it('reaches as far as its threshold: shown to 30 % out, hidden from 70 % in', () => {
    // Shown: the out threshold (0.3) lies 70 % into the range, at 5400.
    expect(settledFadeReach(settled(true), 1000, start, end)).toBeCloseTo(4400, 2);
    expect(settledFadeReach(settled(true), 5500, start, end)).toBe(0);
    // Hidden: the in threshold (0.7) lies 30 % into the range, at 4600.
    expect(settledFadeReach(settled(false), 8000, start, end)).toBeCloseTo(3400, 2);
    expect(settledFadeReach(settled(false), 4500, start, end)).toBe(0);
    // Past its threshold the next step starts it: no reach.
    const hidden = settled(false);
    stepFade(hidden, fadeValue(4500, start, end), 1 / 60, true);
    expect(hidden.alpha).toBeGreaterThan(0);
  });

  it('has none while it fades, and no end for a fade that never changes', () => {
    expect(settledFadeReach({ alpha: 0.5, shown: false }, 1000, start, end)).toBe(0);
    expect(settledFadeReach({ alpha: 0.5, shown: true }, 9000, start, end)).toBe(0);
    expect(settledFadeReach(settled(true), 1e9, start, end, false)).toBe(Infinity);
    expect(settledFadeReach(settled(true), 1e9, Infinity, Infinity)).toBe(Infinity);
    // Hidden with a value of 1 for good: it fades in.
    expect(settledFadeReach(settled(false), 0, start, end, false)).toBe(0);
  });
});
