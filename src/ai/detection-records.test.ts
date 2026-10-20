import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { SoundLevel } from './detection.ts';
import { aliasOverrideLists, castingSoundLevel, weaponSoundLevel } from './detection-records.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const record = (fields: [string, Uint8Array][]) => ({
  fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('detection records', () => {
  it("read a weapon's detection sound level (VNAM), normal without one", () => {
    expect(weaponSoundLevel(record([['VNAM', u32s(SoundLevel.silent)]]))).toBe(SoundLevel.silent);
    expect(weaponSoundLevel(record([['VNAM', u32s(SoundLevel.loud)]]))).toBe(SoundLevel.loud);
    expect(weaponSoundLevel(record([]))).toBe(SoundLevel.normal);
  });

  it("read a magic effect's casting sound level (MGEF DATA at 140)", () => {
    const data = new Uint8Array(152);
    new DataView(data.buffer).setUint32(140, SoundLevel.veryLoud, true);
    expect(castingSoundLevel(record([['DATA', data]]))).toBe(SoundLevel.veryLoud);
    expect(castingSoundLevel(record([['DATA', new Uint8Array(40)]]))).toBe(SoundLevel.normal);
  });

  it("read each reference alias's override package lists", () => {
    const quest = record([
      ['ALST', u32s(0)],
      ['ALFR', u32s(0x1234)],
      ['SPOR', u32s(0x5000)],
      ['OCOR', u32s(0x5001)],
      ['ALED', new Uint8Array(0)],
      ['ALLS', u32s(1)],
      ['ALED', new Uint8Array(0)],
      ['ALST', u32s(2)],
      ['ECOR', u32s(0x5002)],
      ['GWOR', u32s(0)],
      ['ALED', new Uint8Array(0)],
      ['ALST', u32s(3)],
      ['ALED', new Uint8Array(0)],
    ]);
    const lists = aliasOverrideLists(quest);
    expect([...lists.keys()]).toEqual([0, 2]);
    expect(lists.get(0)).toEqual({
      spectator: 0x5000,
      observeCorpse: 0x5001,
      guardWarn: undefined,
      combat: undefined,
    });
    expect(lists.get(2)).toEqual({
      spectator: undefined,
      observeCorpse: undefined,
      guardWarn: undefined,
      combat: 0x5002,
    });
  });
});
