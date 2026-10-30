import { describe, expect, it } from 'vitest';
import type { WaterType } from '../world/water.ts';
import { depthControl, waterColor, waterDeepness, waterFog, waterFresnel } from './water-color.ts';

// DefaultWater's values (Skyrim.esm), the water of Riverwood's river and the sea at Solitude.
const still = { startingSize: 0, force: 0, velocity: 0, falloff: 0, dampener: 0 };
const water: WaterType = {
  formId: 0x18,
  editorId: 'DefaultWater',
  opacity: 0.5,
  flags: 0,
  noiseTextures: [],
  shallowColor: [38 / 255, 39 / 255, 24 / 255],
  deepColor: [5 / 255, 14 / 255, 18 / 255],
  reflectionColor: [119 / 255, 140 / 255, 157 / 255],
  sunSpecularPower: 1021,
  reflectivity: 0.8,
  fresnel: 0.1,
  fogNear: -10,
  fogFar: 150,
  fogAmount: 0.7,
  underwaterFogNear: -500,
  underwaterFogFar: 1600,
  underwaterFogAmount: 0.9,
  noiseFalloff: 0,
  windDirection: [0, 0, 0],
  windSpeed: [0, 0, 0],
  uvScale: [1, 1, 1],
  amplitude: [0, 0, 0],
  refractionMagnitude: 40,
  specularPower: 0,
  specularRadius: 0,
  specularBrightness: 0,
  reflectionMagnitude: 0.42,
  sunSparkleMagnitude: 2.89,
  sunSpecularMagnitude: 4.65,
  sunSparklePower: 3521,
  depthReflections: 0.3,
  depthRefraction: 0.95,
  depthNormals: 0.1,
  depthSpecular: 0.9,
  flowmapScale: 1,
  displacement: { ...still, dampener: 0.98 },
  rain: still,
};

describe('the water colour', () => {
  it('fogs the scene below as 1 - ((far - depth) / (far - near))^amount', () => {
    expect(waterFog(-10, water)).toBe(0);
    // DefaultWater: far 150, near -10, amount 0.7.
    expect(waterFog(70, water)).toBeCloseTo(1 - 0.5 ** 0.7);
    expect(waterFog(150, water)).toBe(1);
    expect(waterFog(5000, water)).toBe(1);
  });

  it('counts depth as a share of the fog far distance', () => {
    expect(waterDeepness(0, water)).toBe(0);
    expect(waterDeepness(75, water)).toBeCloseTo(0.5);
    expect(waterDeepness(300, water)).toBe(1);
  });

  it('keeps all of each effect deep down and loses the depth share at the shore', () => {
    expect(depthControl(water, 1)).toEqual([1, 1, 1, 1]);
    const shore = depthControl(water, 0);
    expect(shore[0]).toBeCloseTo(0.7);
    expect(shore[1]).toBeCloseTo(0.05);
    expect(shore[2]).toBeCloseTo(0.9);
    expect(shore[3]).toBeCloseTo(0.1);
  });

  it('reflects more at grazing angles, from the fresnel amount straight down', () => {
    expect(waterFresnel(0.1, 1)).toBeCloseTo(0.1);
    expect(waterFresnel(0.1, 0)).toBe(1);
  });

  it('shows the scene behind in the shallows and the deep colour in deep water', () => {
    const input = {
      below: [1, 0, 0] as [number, number, number],
      facing: 1,
      reflected: [0, 0, 1] as [number, number, number],
      multiplier: [1, 1, 1] as [number, number, number],
    };
    const shallow = waterColor(water, { ...input, thickness: -10 });
    expect(shallow[0]).toBeGreaterThan(0.85);
    const deep = waterColor(water, { ...input, thickness: 10000 });
    expect(deep[0]).toBeLessThan(0.4);
    // The weather's water multiplier darkens the water's body (night).
    const night = waterColor(water, { ...input, thickness: 10000, multiplier: [0.2, 0.2, 0.2] });
    expect(night[1]).toBeLessThan(deep[1]);
  });

  it('takes the reflection colour over by the reflected scene by the reflection magnitude', () => {
    const input = {
      below: [0, 0, 0] as [number, number, number],
      thickness: 10000,
      // Grazing: the reflection is all there is.
      facing: 0,
      reflected: [1, 1, 1] as [number, number, number],
      multiplier: [1, 1, 1] as [number, number, number],
    };
    const color = waterColor(water, input);
    // 0.58 of the reflection colour, 0.42 of the scene.
    expect(color[2]).toBeCloseTo((157 / 255) * 0.58 + 0.42);
  });
});
