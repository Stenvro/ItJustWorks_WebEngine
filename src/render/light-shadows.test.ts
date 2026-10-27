import { describe, expect, it } from 'vitest';
import { project } from './frustum.ts';
import {
  lightShadowKey,
  lightShadowViews,
  MAX_SHADOW_LIGHTS,
  SHADOW_FADE_SECONDS,
  ShadowLightSelector,
} from './light-shadows.ts';
import type { Vec3 } from './math.ts';
import { ShadowKind, type PointLight } from './scene-lighting.ts';
import { lightShadow } from '../world/cell-lighting.ts';
import { LightFlag } from '../world/cell-records.ts';

const light = (id: number, x: number, kind: number = ShadowKind.omni): PointLight => ({
  position: [x, 0, 0],
  radius: 500,
  color: [1, 1, 1],
  shadow: { kind, id },
});
const camera: Vec3 = [0, 0, 0];
const ids = (slots: readonly { light: PointLight }[]): number[] =>
  slots.map((slot) => slot.light.shadow?.id ?? 0).sort((a, b) => a - b);

describe('ShadowLightSelector', () => {
  it('picks the nearest shadow lights up to the limit, ignoring lights without shadows', () => {
    const selector = new ShadowLightSelector();
    const plain: PointLight = { position: [1, 0, 0], radius: 500, color: [1, 1, 1] };
    const lights = [light(1, 500), light(2, 100), light(3, 300), light(4, 900), plain];
    const slots = selector.update(lights, camera, 2, 0.016);
    expect(ids(slots)).toEqual([2, 3]);
    expect(new Set(slots.map((slot) => slot.slot)).size).toBe(2);
  });

  it('never holds more than MAX_SHADOW_LIGHTS', () => {
    const selector = new ShadowLightSelector();
    const lights = Array.from({ length: 10 }, (_, i) => light(i + 1, i * 10));
    expect(selector.update(lights, camera, 99, 0.016)).toHaveLength(MAX_SHADOW_LIGHTS);
  });

  it('fades a new light in, and one pushed out of the set out while it keeps its slot', () => {
    const selector = new ShadowLightSelector();
    const step = SHADOW_FADE_SECONDS / 4;
    let slots = selector.update([light(1, 100), light(2, 200)], camera, 1, step);
    expect(ids(slots)).toEqual([1]);
    expect(slots[0]?.fade).toBeCloseTo(0.25);
    for (let i = 0; i < 4; i++) slots = selector.update([light(1, 100)], camera, 1, step);
    expect(slots[0]?.fade).toBe(1);
    const held = slots[0]?.slot;

    // Light 2 comes nearer: light 1 fades out over SHADOW_FADE_SECONDS in its slot, and light 2
    // waits for the slot, then fades in.
    const near: Vec3 = [200, 0, 0];
    const both = [light(1, 100), light(2, 200)];
    slots = selector.update(both, near, 1, step);
    expect(ids(slots)).toEqual([1]);
    expect(slots[0]?.slot).toBe(held);
    expect(slots[0]?.fade).toBeCloseTo(0.75);
    for (let i = 0; i < 2; i++) slots = selector.update(both, near, 1, step);
    expect(ids(slots)).toEqual([1]);
    // Light 1 has faded out: light 2 takes its slot in the same frame.
    slots = selector.update(both, near, 1, step);
    expect(ids(slots)).toEqual([2]);
    expect(slots[0]?.slot).toBe(held);
    expect(slots[0]?.fade).toBeCloseTo(0.25);
  });

  it('drops a light that left the scene at once', () => {
    const selector = new ShadowLightSelector();
    selector.update([light(1, 100), light(2, 200)], camera, 2, 1);
    expect(ids(selector.update([light(2, 200)], camera, 2, 0.016))).toEqual([2]);
  });
});

describe('lightShadowViews', () => {
  it('gives an omnidirectional light six cube faces, each holding its own direction', () => {
    const views = lightShadowViews(light(1, 0));
    expect(views?.viewProj).toHaveLength(6);
    const directions: Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    directions.forEach((dir, face) => {
      const matrix = views?.viewProj[face];
      if (!matrix) throw new Error('no face');
      const p = project(matrix, [dir[0] * 100, dir[1] * 100, dir[2] * 100]);
      expect(Math.abs(p[0])).toBeLessThan(1e-4);
      expect(Math.abs(p[1])).toBeLessThan(1e-4);
      expect(p[2]).toBeGreaterThan(0);
      expect(p[2]).toBeLessThan(1);
    });
  });

  it('gives a spot light one frustum round its cone', () => {
    const spot: PointLight = {
      ...light(1, 0, ShadowKind.spot),
      spot: { direction: [0, 0, -1], cosHalfAngle: Math.cos(Math.PI / 6) },
    };
    const views = lightShadowViews(spot);
    expect(views?.viewProj).toHaveLength(1);
    const matrix = views?.viewProj[0];
    if (!matrix) throw new Error('no view');
    // Straight down is in the middle; the cone's edge (30°) inside the frustum.
    expect(project(matrix, [0, 0, -100])[0]).toBeCloseTo(0, 4);
    const edge = project(matrix, [Math.tan(Math.PI / 6) * 100, 0, -100]);
    expect(Math.abs(edge[0]) + Math.abs(edge[1])).toBeLessThan(1);
  });

  it('keys a slot by the light and where it stands to the unit', () => {
    expect(lightShadowKey(light(1, 10))).toBe(lightShadowKey(light(1, 10.3)));
    expect(lightShadowKey(light(1, 10))).not.toBe(lightShadowKey(light(1, 12)));
    expect(lightShadowKey(light(1, 10))).not.toBe(lightShadowKey(light(2, 10)));
  });
});

describe('lightShadow (LIGH flags)', () => {
  const cone = { direction: [0, 0, -1] as const, cosHalfAngle: 0.5 };
  it('maps the shadow flags to how the light casts', () => {
    const base = { reference: 7 };
    expect(lightShadow({ ...base, flags: 0 }).shadow).toBeUndefined();
    expect(lightShadow({ ...base, flags: LightFlag.shadowOmnidirectional }).shadow?.kind).toBe(
      ShadowKind.omni,
    );
    expect(
      lightShadow({ ...base, flags: LightFlag.shadowSpotlight, spot: cone }).shadow?.kind,
    ).toBe(ShadowKind.spot);
    // A spot light without a valid cone lights every way.
    expect(lightShadow({ ...base, flags: LightFlag.shadowSpotlight }).shadow?.kind).toBe(
      ShadowKind.omni,
    );
    const hemisphere = lightShadow({
      ...base,
      flags: LightFlag.shadowHemisphere,
      hemisphereAxis: [0, 0, -1],
    }).shadow;
    expect(hemisphere).toEqual({ kind: ShadowKind.hemisphere, id: 7, axis: [0, 0, -1] });
  });
});
