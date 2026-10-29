import { describe, expect, it } from 'vitest';
import {
  FADE_MIN_NEAR_DISTANCE,
  FADE_START_PERCENT,
  HAS_DISTANT_LOD,
  IS_FULL_LOD,
  fadeKind,
  fadeOut,
  fadeRange,
  neverFades,
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

  it('dithers away over the last part of the distance instead of popping', () => {
    const { start, end } = fadeRange('object', 200, SETTINGS);
    expect(start).toBeCloseTo(end * FADE_START_PERCENT);
    expect(fadeOut(start - 1, start, end)).toBe(0);
    expect(fadeOut((start + end) / 2, start, end)).toBeCloseTo(0.5);
    expect(fadeOut(end, start, end)).toBe(1);
    expect(fadeOut(end * 2, start, end)).toBe(1);
  });

  it('never fades references with distant LOD or placed as full LOD', () => {
    expect(neverFades('STAT', HAS_DISTANT_LOD, 0)).toBe(true);
    expect(neverFades('TREE', HAS_DISTANT_LOD, 0)).toBe(true);
    expect(neverFades('STAT', 0, 0)).toBe(false);
    expect(neverFades('MISC', 0, IS_FULL_LOD)).toBe(true);
    // 0x8000 means something else on items: they still fade.
    expect(neverFades('MISC', HAS_DISTANT_LOD, 0)).toBe(false);
  });
});
