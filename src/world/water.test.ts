import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { cellWater, parseWater, WaterFlag } from './water.ts';

function dnam(values: Record<number, number | [number, number, number]>, size = 232): Uint8Array {
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  for (const [index, value] of Object.entries(values)) {
    const offset = Number(index) * 4;
    if (Array.isArray(value)) data.set([...value, 0], offset);
    else view.setFloat32(offset, value, true);
  }
  return data;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);

describe('parseWater', () => {
  it('reads colours, fog, noise layers and the SSE flow map scale', () => {
    const type = parseWater({
      formId: 0x18,
      editorId: 'DefaultWater',
      fields: new Fields([
        { type: 'ANAM', data: Uint8Array.of(50) },
        { type: 'FNAM', data: Uint8Array.of(WaterFlag.flowmap) },
        {
          type: 'DNAM',
          data: dnam({
            4: 1021,
            5: 0.8,
            6: 0.1,
            8: -10,
            9: 150,
            10: [38, 39, 24],
            11: [5, 14, 18],
            12: [119, 140, 157],
            25: 270,
            28: 0.019,
            43: 1920,
            46: 0.696,
            38: 40,
            57: 1,
          }),
        },
        { type: 'NAM2', data: text('Data\\Textures\\Water\\DefaultWater.dds') },
      ]),
    });
    expect(type.opacity).toBe(0.5);
    expect(type.flags & WaterFlag.flowmap).toBe(WaterFlag.flowmap);
    expect(type.sunSpecularPower).toBe(1021);
    expect(type.reflectivity).toBeCloseTo(0.8, 5);
    expect(type.fogNear).toBe(-10);
    expect(type.fogFar).toBe(150);
    expect(type.shallowColor).toEqual([38 / 255, 39 / 255, 24 / 255]);
    expect(type.reflectionColor[2]).toBeCloseTo(157 / 255, 5);
    expect(type.windDirection[0]).toBe(270);
    expect(type.windSpeed[0]).toBeCloseTo(0.019, 5);
    expect(type.uvScale[0]).toBe(1920);
    expect(type.amplitude[0]).toBeCloseTo(0.696, 5);
    expect(type.refractionMagnitude).toBe(40);
    expect(type.flowmapScale).toBe(1);
    expect(type.noiseTextures[0]).toBe('textures\\water\\defaultwater.dds');
  });
});

describe('cellWater', () => {
  const world = { height: -14000, type: 0x18 };

  it('has no water without the cell flag', () => {
    expect(cellWater({ hasWater: false, waterHeight: 0, waterType: undefined }, world)).toBe(
      undefined,
    );
  });

  it('uses XCLW, or the world default for FLT_MAX', () => {
    expect(cellWater({ hasWater: true, waterHeight: -4700, waterType: 0x99 }, world)).toEqual({
      height: -4700,
      type: 0x99,
    });
    expect(
      cellWater(
        { hasWater: true, waterHeight: 3.4028234663852886e38, waterType: undefined },
        world,
      ),
    ).toEqual({ height: -14000, type: 0x18 });
  });

  it('treats absurd heights as no water', () => {
    expect(
      cellWater({ hasWater: true, waterHeight: -2147483648, waterType: undefined }, world),
    ).toBeUndefined();
    expect(
      cellWater({ hasWater: true, waterHeight: 4294953216, waterType: undefined }, world),
    ).toBeUndefined();
  });
});
