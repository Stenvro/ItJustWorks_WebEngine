import { describe, expect, it } from 'vitest';
import {
  LIGHT_KEY_FLOATS,
  LIGHT_LIST_WORDS,
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

  it('keeps seven lights when more touch the object, the strongest at its bound', () => {
    // Twelve candles in a row; the object sits at x = 0 with a 10-unit bound.
    const lights = Array.from({ length: 12 }, (_, i) => candle(i * 10));
    const chosen = select(lights, [0, 0, 0], 10);
    expect(chosen).toHaveLength(MAX_OBJECT_LIGHTS);
    expect(chosen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // A bright light farther away beats nearer dim ones.
    const bright = [...lights.slice(0, 8), candle(150, 20)];
    expect(select(bright, [0, 0, 0], 10)).toContain(8);
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
});
