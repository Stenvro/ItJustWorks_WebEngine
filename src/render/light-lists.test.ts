import { describe, expect, it } from 'vitest';
import {
  LIGHT_KEY_FLOATS,
  LIGHT_LIST_WORDS,
  MAX_EFFECT_LIGHTS,
  MAX_OBJECT_LIGHTS,
  packLightKey,
  selectObjectLights,
  unpackObjectLights,
  type LightKeySource,
} from './light-lists.ts';

function keysOf(lights: readonly (LightKeySource & { shadowed?: boolean })[]): Float32Array {
  const keys = new Float32Array(lights.length * LIGHT_KEY_FLOATS);
  lights.forEach((light, i) => {
    packLightKey(keys, i, light, light.shadowed ?? false);
  });
  return keys;
}

function select(
  lights: readonly (LightKeySource & { shadowed?: boolean })[],
  center: [number, number, number],
  radius: number,
  room = 0,
): number[] {
  const out = new Uint32Array(LIGHT_LIST_WORDS);
  selectObjectLights(keysOf(lights), lights.length, center, radius, room, out, 0);
  return unpackObjectLights(out);
}

const candle = (x: number, brightness = 1): LightKeySource => ({
  position: [x, 0, 0],
  radius: 200,
  color: [brightness, brightness, brightness],
});

describe('selectObjectLights', () => {
  it('takes only the lights whose sphere touches the bound', () => {
    expect(select([candle(0), candle(500), candle(260)], [0, 0, 0], 50)).toEqual([0]);
    expect(select([candle(0), candle(500), candle(240)], [0, 0, 0], 50)).toEqual([0, 2]);
  });

  it('keeps the first seven lights in the order they joined the scene, whatever their strength', () => {
    // Twelve candles in a row; the object sits at x = 0 with a 10-unit bound.
    const lights = Array.from({ length: 12 }, (_, i) => candle(i * 10));
    const chosen = select(lights, [0, 0, 0], 10);
    expect(chosen).toHaveLength(MAX_OBJECT_LIGHTS);
    expect(chosen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // A bright light that joined later does not push out an earlier dim one.
    const bright = [...lights.slice(0, 8), candle(150, 20)];
    expect(select(bright, [0, 0, 0], 10)).not.toContain(8);
    // The frame's order (by distance) is not the scene's: the order key decides.
    const joined = [
      { ...candle(0), order: 5 },
      { ...candle(5), order: 1 },
      { ...candle(9), order: 3 },
    ];
    expect(select(joined, [0, 0, 0], 10)).toEqual([1, 2, 0]);
  });

  it('gives an effect at most four lights, none of them shadow lights', () => {
    const lights = [
      { ...candle(0), shadowed: true },
      ...Array.from({ length: 6 }, (_, i) => candle(i * 10)),
    ];
    const out = new Uint32Array(LIGHT_LIST_WORDS);
    const keys = keysOf(lights);
    expect(selectObjectLights(keys, lights.length, [0, 0, 0], 10, 0, out, 0, 'effect')).toBe(
      MAX_EFFECT_LIGHTS,
    );
    expect(unpackObjectLights(out)).toEqual([1, 2, 3, 4]);
  });

  it('puts shadow lights first, at most four', () => {
    const lights = [
      candle(0),
      { ...candle(50), shadowed: true },
      candle(5),
      { ...candle(60), shadowed: true },
    ];
    expect(select(lights, [0, 0, 0], 10)).toEqual([1, 3, 0, 2]);
    const many = Array.from({ length: 6 }, (_, i) => ({ ...candle(i), shadowed: true }));
    expect(select([...many, candle(0)], [0, 0, 0], 10)).toEqual([0, 1, 2, 3, 6]);
  });

  it("names the frame's light indices of keys packed from a subset", () => {
    const keys = new Float32Array(2 * LIGHT_KEY_FLOATS);
    packLightKey(keys, 0, candle(0), false, 40);
    packLightKey(keys, 1, candle(5), false, 7);
    const out = new Uint32Array(LIGHT_LIST_WORDS);
    selectObjectLights(keys, 2, [0, 0, 0], 10, 0, out, 0);
    expect(unpackObjectLights(out)).toEqual([40, 7]);
  });

  it('leaves out portal-strict lights of another room', () => {
    const lights = [{ ...candle(0), room: 2 }, { ...candle(0), room: 3 }, candle(0)];
    expect(select(lights, [0, 0, 0], 10, 3)).toEqual([1, 2]);
    // An object in no room keeps every light.
    expect(select(lights, [0, 0, 0], 10, 0)).toHaveLength(3);
  });

  it("keeps a land quadrant's own list of seven, without the lights that leave land unlit", () => {
    const unlit = { ...candle(0), lightsLand: false };
    const lights = [
      unlit,
      { ...unlit, shadowed: true },
      { ...candle(0), shadowed: true },
      ...Array.from({ length: 8 }, (_, i) => candle(i)),
    ];
    const out = new Uint32Array(LIGHT_LIST_WORDS);
    selectObjectLights(keysOf(lights), lights.length, [0, 0, 0], 10, 0, out, 0, 'land');
    // The shadow light that lights land first, then the list's first six that do.
    expect(unpackObjectLights(out)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // Objects keep the lights that leave land unlit.
    expect(select(lights, [0, 0, 0], 10).slice(0, 3)).toEqual([1, 2, 0]);
  });
});
