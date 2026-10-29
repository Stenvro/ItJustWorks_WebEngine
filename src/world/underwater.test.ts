import { describe, expect, it } from 'vitest';
import { flatAmbient } from '../render/scene-lighting.ts';
import { Fields } from '../formats/esm/fields.ts';
import { isUnderwater, underwaterFog, underwaterLight, UnderwaterView } from './underwater.ts';
import { parseWater } from './water.ts';

// DefaultWater (Skyrim.esm): underwater fog amount 0.9, near -500, far 1600.
const DEFAULT_WATER = {
  underwaterFogAmount: 0.9,
  underwaterFogNear: -500,
  underwaterFogFar: 1600,
  shallowColor: [37 / 255, 52 / 255, 37 / 255] as const,
  deepColor: [5 / 255, 16 / 255, 5 / 255] as const,
};
const DAY = { sunColor: [1, 1, 1] as const, ambient: flatAmbient([0.3, 0.3, 0.3]) };
const NIGHT = { sunColor: [0, 0, 0] as const, ambient: flatAmbient([0.02, 0.02, 0.03]) };

describe('underwater view', () => {
  it('is under water only below the surface it stands in', () => {
    expect(isUnderwater(-10, 0)).toBe(true);
    expect(isUnderwater(0, 0)).toBe(false);
    expect(isUnderwater(10, 0)).toBe(false);
    expect(isUnderwater(-10, undefined)).toBe(false);
  });

  it('takes the water type underwater fog planes and amount', () => {
    const fog = underwaterFog(DEFAULT_WATER, DAY);
    expect(fog.near).toBe(-500);
    expect(fog.far).toBe(1600);
    expect(fog.max).toBeCloseTo(0.9);
    expect(fog.power).toBe(1);
    // Shallow colour near the camera, deep colour far away, in full daylight.
    expect(fog.nearColor[1]).toBeCloseTo(52 / 255);
    expect(fog.farColor[1]).toBeCloseTo(16 / 255);
  });

  it('keeps a far plane past the near one and some fog where the amount is 0', () => {
    const fog = underwaterFog(
      {
        ...DEFAULT_WATER,
        underwaterFogNear: -1000,
        underwaterFogFar: -1200,
        underwaterFogAmount: 0,
      },
      DAY,
    );
    expect(fog.far).toBeGreaterThan(fog.near);
    expect(fog.max).toBeGreaterThan(0);
  });

  it('is darker at night', () => {
    expect(underwaterLight(NIGHT)).toBeLessThan(underwaterLight(DAY));
    const night = underwaterFog(DEFAULT_WATER, NIGHT);
    expect(night.nearColor[1]).toBeLessThan(underwaterFog(DEFAULT_WATER, DAY).nearColor[1]);
  });
});

describe('underwater imagespace', () => {
  const IMAGE_SPACE = 0x1234;
  const water = parseWater({
    formId: 0x18,
    editorId: 'DefaultWater',
    fields: new Fields([]),
    formIdField: (type) => (type === 'INAM' ? IMAGE_SPACE : undefined),
  });
  const view = new UnderwaterView(
    () => Promise.resolve(water),
    (formId) =>
      Promise.resolve(
        formId === IMAGE_SPACE ? { type: 'IMGS', fields: new Fields([]) } : undefined,
      ),
  );
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("takes the water's own imagespace (WATR INAM) only under its surface", async () => {
    expect(water.imageSpace).toBe(IMAGE_SPACE);
    const surface = { height: 0, type: 0x18 };
    view.fog(-10, surface, DAY);
    await settle();
    view.fog(-10, surface, DAY);
    expect(view.imageSpace()).toBeUndefined(); // still loading
    await settle();
    expect(view.imageSpace()).toBeDefined();
    view.fog(10, surface, DAY);
    expect(view.imageSpace()).toBeUndefined();
  });
});
