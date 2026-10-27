import { describe, expect, it } from 'vitest';
import {
  FADE_MIN_RADIUS,
  FADE_RADIUS_SCALE,
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

  it('fades each kind by its own multiplier times the bound radius', () => {
    const radius = 50;
    expect(fadeRange('actor', radius, SETTINGS).end).toBe(radius * 9 * FADE_RADIUS_SCALE);
    expect(fadeRange('item', radius, SETTINGS).end).toBe(radius * 6 * FADE_RADIUS_SCALE);
    expect(fadeRange('object', radius, SETTINGS).end).toBe(radius * 9 * FADE_RADIUS_SCALE);
    // A larger bound stays longer; a higher setting too.
    expect(fadeRange('object', 400, SETTINGS).end).toBeGreaterThan(
      fadeRange('object', 40, SETTINGS).end,
    );
    expect(fadeRange('object', 40, { ...SETTINGS, objects: 30 }).end).toBeGreaterThan(
      fadeRange('object', 40, SETTINGS).end,
    );
    // Tiny items fade as if they had the floor radius.
    expect(fadeRange('item', 2, SETTINGS).end).toBe(FADE_MIN_RADIUS * 6 * FADE_RADIUS_SCALE);
  });

  it('dithers away over the last part of the distance instead of popping', () => {
    const { start, end } = fadeRange('object', 40, SETTINGS);
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
