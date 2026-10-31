import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { invert } from '../render/frustum.ts';
import { lookAt, multiply, perspectiveReversedZ, type Vec3 } from '../render/math.ts';
import {
  inUnderwaterMask,
  isUnderwater,
  nearPlaneWater,
  underwaterCrossing,
  underwaterFogColor,
  underwaterFogShare,
  underwaterImageSpace,
  UnderwaterView,
  type NearPlaneWater,
} from './underwater.ts';
import { NEUTRAL_IMAGE_SPACE, type ImageSpace } from './image-space.ts';

describe('underwaterImageSpace', () => {
  it("takes only the water imagespace's depth of field, the scene's colour terms kept", () => {
    const scene: ImageSpace = { ...NEUTRAL_IMAGE_SPACE, saturation: 1.2, tintAmount: 0.3 };
    const water: ImageSpace = {
      ...NEUTRAL_IMAGE_SPACE,
      saturation: 0.8,
      tintAmount: 0.1,
      depthOfField: { strength: 1, distance: -50, range: 500, blurRadius: 2, sky: true },
    };
    const under = underwaterImageSpace(scene, water);
    expect(under?.saturation).toBe(1.2);
    expect(under?.tintAmount).toBe(0.3);
    expect(under?.depthOfField).toEqual(water.depthOfField);
    // No scene imagespace: a neutral one with the water's depth of field.
    expect(underwaterImageSpace(undefined, water)?.saturation).toBe(1);
    // No water imagespace: the scene's.
    expect(underwaterImageSpace(scene, undefined)).toBe(scene);
  });
});
import { parseWater } from './water.ts';

const NEAR = 15;
const FOV_Y = Math.PI / 2;
/** Half the near plane's height: near × tan(fov / 2). */
const HALF = NEAR * Math.tan(FOV_Y / 2);

/** A camera at `eye` looking along `forward`, with `up`, as the renderer's inverse matrix. */
function inverseCamera(eye: Vec3, forward: Vec3, up: Vec3 = [0, 0, 1]): Float32Array {
  const target: Vec3 = [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]];
  const viewProjection = multiply(perspectiveReversedZ(FOV_Y, 1, NEAR), lookAt(eye, target, up));
  const inverse = invert(viewProjection);
  if (!inverse) throw new Error('singular camera');
  return inverse;
}

const level = (z: number, waterHeight: number): NearPlaneWater =>
  nearPlaneWater(inverseCamera([0, 0, z], [1, 0, 0]), waterHeight, z);

describe('underwater view', () => {
  it('is under water only below the surface it stands in', () => {
    expect(isUnderwater(-10, 0)).toBe(true);
    expect(isUnderwater(0, 0)).toBe(false);
    expect(isUnderwater(10, 0)).toBe(false);
    expect(isUnderwater(-10, undefined)).toBe(false);
  });

  it('measures the near plane corners against the surface: above, under or across', () => {
    const plane = (low: number, high: number): [number, number, number][] => [
      [0, 0, low],
      [1, 0, low],
      [0, 1, high],
      [1, 1, high],
    ];
    expect(underwaterCrossing(plane(10, 20), 5, 15).state).toBe('above');
    expect(underwaterCrossing(plane(10, 20), 25, 15)).toEqual({ state: 'under', share: 1 });
    expect(underwaterCrossing(plane(10, 20), 12.5, 15)).toEqual({ state: 'across', share: 0.25 });
    // A level near plane (looking straight down) takes the camera's own side.
    expect(underwaterCrossing(plane(10, 10), 10.5, 10).state).toBe('under');
    expect(underwaterCrossing(plane(10, 10), 9.5, 10).state).toBe('above');
  });

  it("measures the camera's own near plane: wholly above, wholly under or across", () => {
    expect(level(100, 0).state).toBe('above');
    expect(level(-100, 0).state).toBe('under');
    const across = level(0, 0);
    expect(across.state).toBe('across');
    expect(across.share).toBeCloseTo(0.5);
    // Looking straight down the near plane is level: the camera's own side.
    expect(nearPlaneWater(inverseCamera([0, 0, 1], [0, 0, -1], [1, 0, 0]), 0, 1).state).toBe(
      'above',
    );
  });

  it('masks the screen below the line where the water cuts the near plane', () => {
    // At the surface, looking level: the lower half of the screen is under the water.
    const half = level(0, 0).mask;
    expect(inUnderwaterMask(half, 0, -0.5)).toBe(true);
    expect(inUnderwaterMask(half, 0, 0.5)).toBe(false);
    expect(inUnderwaterMask(half, 0.9, -0.01)).toBe(true);
    // A third of the near plane's half height above the water: the line a third down.
    const third = level(HALF / 3, 0).mask;
    expect(inUnderwaterMask(third, 0, -0.3)).toBe(false);
    expect(inUnderwaterMask(third, 0, -0.37)).toBe(true);
  });

  it("turns the mask's line with the camera's roll", () => {
    // Rolled so that the screen's right side dips toward the water.
    const roll = 0.3;
    const up: Vec3 = [0, Math.sin(roll), Math.cos(roll)];
    const mask = nearPlaneWater(inverseCamera([0, 0, 0], [1, 0, 0], up), 0, 0).mask;
    expect(mask[0]).not.toBeCloseTo(0);
    // The line runs through the centre, rising on one side and falling on the other.
    const leftUnder = inUnderwaterMask(mask, -1, 0.2);
    const rightUnder = inUnderwaterMask(mask, 1, 0.2);
    expect(leftUnder).not.toBe(rightUnder);
    expect(Math.abs(mask[0] / mask[1])).toBeCloseTo(Math.tan(roll));
  });

  it("colours the fog by the water's shallow colour and the weather's water multiplier", () => {
    const type = { shallowColor: [0.2, 0.4, 0.6] as const };
    expect(underwaterFogColor(type)).toEqual([0.2, 0.4, 0.6]);
    const night = underwaterFogColor(type, [0.25, 0.5, 0.5]);
    expect(night[0]).toBeCloseTo(0.05);
    expect(night[1]).toBeCloseTo(0.2);
    expect(night[2]).toBeCloseTo(0.3);
  });

  it('fogs from none at the near plane to all at the far plane', () => {
    expect(underwaterFogShare(-10, -10, 150)).toBe(0);
    expect(underwaterFogShare(70, -10, 150)).toBeCloseTo(0.5);
    expect(underwaterFogShare(500, -10, 150)).toBe(1);
    // A far plane before the near one fogs what is nearer than it fully.
    expect(underwaterFogShare(10, 400, 100)).toBe(1);
    expect(underwaterFogShare(500, 400, 100)).toBe(0);
    expect(underwaterFogShare(5, 5, 5)).toBe(1);
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
  const surface = { height: 0, type: 0x18 };
  const under = (): NearPlaneWater => ({ state: 'under', share: 1, mask: [0, 1, -20] });
  const across = (): NearPlaneWater => ({ state: 'across', share: 0.5, mask: [0, 1, 0] });
  const above = (): NearPlaneWater => ({ state: 'above', share: 0, mask: [0, 1, 20] });

  it("takes the water's own imagespace (WATR INAM) only with the near plane wholly under", async () => {
    expect(water.imageSpace).toBe(IMAGE_SPACE);
    view.frame(surface, under);
    await settle();
    view.frame(surface, under);
    expect(view.imageSpace()).toBeUndefined(); // still loading
    await settle();
    expect(view.imageSpace()).toBeDefined();
    view.frame(surface, across);
    expect(view.imageSpace()).toBeUndefined();
    view.frame(surface, above);
    expect(view.imageSpace()).toBeUndefined();
  });

  it('fogs the whole image wholly under, the masked part across, nothing above', () => {
    const whole = view.frame(surface, under, [0.5, 0.5, 0.5]);
    expect(whole?.mask).toBeUndefined();
    expect(whole?.near).toBe(water.underwaterFogNear);
    expect(whole?.far).toBe(water.underwaterFogFar);
    expect(whole?.color[0]).toBeCloseTo(water.shallowColor[0] * 0.5);
    const split = view.frame(surface, across);
    expect(split?.mask).toEqual([0, 1, 0]);
    // Inside the mask: the water's imagespace's depth of field.
    expect(split?.depthOfField).toBeDefined();
    expect(view.frame(surface, above)).toBeUndefined();
    expect(view.frame(undefined, under)).toBeUndefined();
  });
});
