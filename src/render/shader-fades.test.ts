import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADER_FADES,
  fadeKindIndex,
  featureFade,
  lodFadeValue,
  shaderFadeFrame,
} from './shader-fades.ts';

const FADE = { actors: 6, items: 3, objects: 5 };

describe('shader distance fades', () => {
  it('divides the distance by the kind multiplier over 7200', () => {
    expect(lodFadeValue(3600, 'object', FADE)).toBeCloseTo(0.1);
    expect(lodFadeValue(4320, 'actor', FADE)).toBeCloseTo(0.1);
    expect(lodFadeValue(2160, 'item', FADE)).toBeCloseTo(0.1);
    // A multiplier of 0 or less: a fifth of the distance.
    expect(lodFadeValue(3600, 'object', { ...FADE, objects: 0 })).toBeCloseTo(0.1);
  });

  it('fades specular out between 0.09 and 0.1 (objects: 3240 to 3600 units)', () => {
    const { specularStart: start, specularEnd: end } = DEFAULT_SHADER_FADES;
    expect(featureFade(lodFadeValue(3000, 'object', FADE), start, end)).toBe(1);
    expect(featureFade(lodFadeValue(3420, 'object', FADE), start, end)).toBeCloseTo(0.5);
    expect(featureFade(lodFadeValue(3700, 'object', FADE), start, end)).toBe(0);
  });

  it('writes the scales and ranges the shaders read', () => {
    const frame = shaderFadeFrame({ ...FADE, items: 0 }, DEFAULT_SHADER_FADES);
    expect(frame).toHaveLength(12);
    expect(frame[0]).toBeCloseTo(1 / 36000);
    expect(frame[1]).toBeCloseTo(1 / 43200);
    expect(frame[2]).toBeCloseTo(1 / 36000);
    expect(frame.slice(8)).toEqual([0.05, 0.06, 0.025, 0.03]);
    expect([fadeKindIndex('object'), fadeKindIndex('actor'), fadeKindIndex('item')]).toEqual([
      0, 1, 2,
    ]);
  });
});
