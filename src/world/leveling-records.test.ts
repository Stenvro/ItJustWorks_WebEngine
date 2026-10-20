import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { levelModifier, parseClassStats, parseEncounterZone } from './leveling-records.ts';

const record = (fields: [string, Uint8Array][], formId = 0x100) => ({
  formId,
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('leveling records', () => {
  it("read a class's skill and attribute weights (CLAS DATA)", () => {
    const data = new Uint8Array(36);
    data.set([3, 1, 2, 2], 6);
    new DataView(data.buffer).setFloat32(24, 0.1, true);
    new DataView(data.buffer).setUint32(28, 100, true);
    data.set([4, 0, 2], 32);
    const clas = parseClassStats(record([['DATA', data]]));
    expect(clas.skillWeights.slice(0, 5)).toEqual([3, 1, 2, 2, 0]);
    expect(clas.skillWeights).toHaveLength(18);
    expect([clas.healthWeight, clas.magickaWeight, clas.staminaWeight]).toEqual([4, 0, 2]);
    expect(clas.bleedout).toBeCloseTo(0.1);
    expect(clas.voicePoints).toBe(100);
  });

  it('read an encounter zone (ECZN DATA), the short one without levels', () => {
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(4, 0x2bceb, true);
    data.set([0, 6, 3, 30], 8);
    expect(parseEncounterZone(record([['DATA', data]]))).toMatchObject({
      owner: undefined,
      location: 0x2bceb,
      minLevel: 6,
      flags: 3,
      maxLevel: 30,
    });
    expect(parseEncounterZone(record([['DATA', new Uint8Array(8)]]))).toMatchObject({
      location: undefined,
      minLevel: 0,
      maxLevel: 0,
    });
  });

  it("read a reference's level modifier (XLCM)", () => {
    expect(levelModifier(record([['XLCM', Uint8Array.from([3, 0, 0, 0])]]))).toBe(3);
    expect(levelModifier(record([]))).toBeUndefined();
  });
});
