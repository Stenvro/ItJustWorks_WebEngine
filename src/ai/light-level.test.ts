import { describe, expect, it } from 'vitest';
import { lightLevel, luminance, type LightProbe } from './light-level.ts';

const settings = { lightLevelExteriorMod: 0, lightLevelInteriorMod: 25, lightLevelMax: 300 };
const grey = (value: number): [number, number, number] => [value, value, value];
const dark: LightProbe = {
  ambient: [grey(0), grey(0), grey(0), grey(0), grey(0), grey(0)],
  sunColor: grey(0),
  sunDirection: [0, 0, 1],
  lights: [],
  interior: true,
};

describe('light level', () => {
  it('weighs colours by their luminance', () => {
    expect(luminance([1, 1, 1])).toBeCloseTo(1, 9);
    expect(luminance([0, 1, 0])).toBeCloseTo(0.7152, 9);
  });

  it('is the interior offset in the dark inside, 0 outside', () => {
    expect(lightLevel(dark, [0, 0, 0], true, settings)).toBe(25);
    expect(lightLevel({ ...dark, interior: false }, [0, 0, 0], true, settings)).toBe(0);
  });

  it('adds the ambient (the six directions on average) and the sun where it reaches', () => {
    const day: LightProbe = {
      ...dark,
      interior: false,
      ambient: [grey(0.4), grey(0.4), grey(0.4), grey(0.4), grey(0.6), grey(0.2)],
      sunColor: grey(1),
    };
    expect(lightLevel(day, [0, 0, 0], true, settings)).toBeCloseTo(140, 9);
    // In the shade only the ambient.
    expect(lightLevel(day, [0, 0, 0], false, settings)).toBeCloseTo(40, 9);
  });

  it('adds the point lights within their radius, fading as the renderer fades them', () => {
    const torch: LightProbe = {
      ...dark,
      lights: [{ position: [0, 0, 100], radius: 400, color: [1, 0.6, 0.3] }],
    };
    const at = (distance: number): number =>
      lightLevel(torch, [0, 0, 100 - distance], true, settings);
    const bright = luminance([1, 0.6, 0.3]) * 100;
    expect(at(0)).toBeCloseTo(25 + bright, 9);
    expect(at(200)).toBeCloseTo(25 + bright * 0.75, 9);
    expect(at(400)).toBe(25);
    expect(at(600)).toBe(25);
  });

  it('stops at iLightLevelMax', () => {
    const glare: LightProbe = { ...dark, sunColor: grey(10) };
    expect(lightLevel(glare, [0, 0, 0], true, settings)).toBe(300);
  });
});
