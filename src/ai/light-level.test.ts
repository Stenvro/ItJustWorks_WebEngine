import { describe, expect, it } from 'vitest';
import { brightestAmbient, lightLevel, luminance, type LightProbe } from './light-level.ts';

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

  it('is 0 in the dark', () => {
    expect(lightLevel(dark, [0, 0, 0], true)).toBe(0);
    expect(lightLevel({ ...dark, interior: false }, [0, 0, 0], true)).toBe(0);
  });

  it('adds the ambient (the six directions on average) and the sun where it reaches', () => {
    const day: LightProbe = {
      ...dark,
      interior: false,
      ambient: [grey(0.4), grey(0.4), grey(0.4), grey(0.4), grey(0.6), grey(0.2)],
      sunColor: grey(1),
    };
    expect(lightLevel(day, [0, 0, 0], true)).toBeCloseTo(140, 9);
    // In the shade only the ambient.
    expect(lightLevel(day, [0, 0, 0], false)).toBeCloseTo(40, 9);
  });

  it('adds the point lights within their radius, fading as the renderer fades them', () => {
    const torch: LightProbe = {
      ...dark,
      lights: [{ position: [0, 0, 100], radius: 400, color: [1, 0.6, 0.3] }],
    };
    const at = (distance: number): number => lightLevel(torch, [0, 0, 100 - distance], true);
    const bright = luminance([1, 0.6, 0.3]) * 100;
    expect(at(0)).toBeCloseTo(bright, 9);
    expect(at(200)).toBeCloseTo(bright * 0.75, 9);
    expect(at(400)).toBe(0);
    expect(at(600)).toBe(0);
  });

  it('leaves out the point lights a wall keeps off it', () => {
    const lights: LightProbe = {
      ...dark,
      lights: [
        { position: [0, 0, 100], radius: 400, color: [1, 1, 1] },
        { position: [0, 200, 0], radius: 400, color: [1, 1, 1] },
      ],
    };
    const both = lightLevel(lights, [0, 0, 0], true);
    // The second (75 at 200 of 400) behind a wall: only the first (93.75 at 100) lights it.
    const one = lightLevel(lights, [0, 0, 0], true, (light) => light.position[1] === 0);
    expect(both).toBeCloseTo(93.75 + 75, 9);
    expect(one).toBeCloseTo(93.75, 9);
  });

  it("gives the ambient light's brightest channel (the interior's light mod)", () => {
    const blue: LightProbe = {
      ...dark,
      ambient: [
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.5],
      ],
    };
    expect(brightestAmbient(blue)).toBeCloseTo(0.4, 9);
    expect(brightestAmbient({ ...dark, ambient: [] })).toBe(0);
  });
});
