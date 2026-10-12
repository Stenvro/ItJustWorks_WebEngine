import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  parseMaterialObject,
  parseStaticDirectional,
  projectedUVParams,
  type MaterialObject,
} from './material-object.ts';

function floats(values: readonly number[], uints: Record<number, number> = {}): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => {
    if (i in uints) view.setUint32(i * 4, uints[i] ?? 0, true);
    else view.setFloat32(i * 4, value, true);
  });
  return bytes;
}

/** A record source whose form ids are global as stored. */
const source = (fields: Fields, formId = 1, editorId = 'Test') => ({
  formId,
  editorId,
  fields,
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('parseMaterialObject', () => {
  it('reads DATA of a single-pass snow material (SnowMaterialObject1P)', () => {
    const data = floats([0.35, 0.4, 48, 170.6667, 0, 0, -1, 0.4, 0.4196, 0.4549, 0.4941, 0, 0], {
      11: 1,
      12: 0,
    });
    const material = parseMaterialObject(
      source(new Fields([{ type: 'DATA', data }]), 0x25129, 'SnowMaterialObject1P'),
    );
    expect(material).toMatchObject({
      editorId: 'SnowMaterialObject1P',
      noiseUVScale: 48,
      singlePass: true,
      snow: false,
      properties: [],
    });
    expect(material.falloffScale).toBeCloseTo(0.35, 6);
    expect(material.falloffBias).toBeCloseTo(0.4, 6);
    expect(material.projectionVector).toEqual([0, 0, -1]);
    expect(material.singlePassColor[2]).toBeCloseTo(0.4941, 4);
  });

  it('keeps the embedded NIF properties of a multi-pass material', () => {
    const data = floats([0.35, 0.4, 28, 256, 0, 0, -1, 0.75, 0, 0, 0, 0], { 11: 0 });
    const nif = new TextEncoder().encode('Gamebryo File Format, Version 20.2.0.7');
    const material = parseMaterialObject(
      source(
        new Fields([
          { type: 'DATA', data },
          { type: 'DNAM', data: nif },
        ]),
      ),
    );
    expect(material.singlePass).toBe(false);
    expect(material.materialUVScale).toBe(256);
    expect(material.normalDampener).toBeCloseTo(0.75, 6);
    expect(material.properties).toHaveLength(1);
  });
});

describe('parseStaticDirectional', () => {
  const dnam = (angle: number, material: number, flags?: number): Uint8Array => {
    const bytes = new Uint8Array(flags === undefined ? 8 : 12);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, angle, true);
    view.setUint32(4, material, true);
    if (flags !== undefined) view.setUint32(8, flags, true);
    return bytes;
  };

  it('reads the max angle, the material and the snow flag', () => {
    expect(
      parseStaticDirectional(source(new Fields([{ type: 'DNAM', data: dnam(75, 0x2871b, 1) }]))),
    ).toEqual({ maxAngle: 75, material: 0x2871b, consideredSnow: true });
  });

  it('is undefined without a material or snow flag', () => {
    expect(parseStaticDirectional(source(new Fields([{ type: 'DNAM', data: dnam(90, 0) }])))).toBe(
      undefined,
    );
    expect(parseStaticDirectional(source(new Fields([])))).toBe(undefined);
  });

  it('keeps a snow-only static (no material)', () => {
    expect(
      parseStaticDirectional(source(new Fields([{ type: 'DNAM', data: dnam(90, 0, 1) }]))),
    ).toEqual({ maxAngle: 90, material: 0, consideredSnow: true });
  });
});

describe('projectedUVParams', () => {
  const material: MaterialObject = {
    formId: 1,
    editorId: 'Snow',
    falloffScale: 0.35,
    falloffBias: 0.4,
    noiseUVScale: 48,
    materialUVScale: 170.6667,
    projectionVector: [0, 0, -1],
    normalDampener: 0.4,
    singlePassColor: [0.42, 0.45, 0.49],
    singlePass: true,
    snow: false,
    properties: [],
  };

  it('uses the material as it is at 90 degrees', () => {
    const [x, , z, w] = projectedUVParams(material, 90);
    expect(x).toBeCloseTo(0.35, 6);
    expect(z).toBeCloseTo(1 / 48, 9);
    expect(w).toBeCloseTo(0.4, 6);
  });

  it('raises the threshold for smaller angles and lowers it for larger ones', () => {
    expect(projectedUVParams(material, 45)[3]).toBeGreaterThan(0.4);
    expect(projectedUVParams(material, 120)[3]).toBeLessThan(0.4);
    // At 0 degrees nothing passes: threshold 1, no noise.
    const [x, , , w] = projectedUVParams(material, 0);
    expect(x).toBeCloseTo(0, 9);
    expect(w).toBeCloseTo(1, 9);
  });
});
