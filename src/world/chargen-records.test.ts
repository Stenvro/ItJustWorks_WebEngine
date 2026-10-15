import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { HeadPartFlag, parseHeadPart } from './actor-records.ts';
import {
  MorphGroup,
  TintMaskType,
  availableMorphTypes,
  parseNpcFace,
  parseRaceChargen,
} from './chargen-records.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const u16 = (value: number): Uint8Array => new Uint8Array(Uint16Array.of(value).buffer);
const i16 = (value: number): Uint8Array => new Uint8Array(Int16Array.of(value).buffer);
const i32s = (...values: number[]): Uint8Array => new Uint8Array(Int32Array.from(values).buffer);
const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const empty = new Uint8Array(0);

const record = (type: string, fields: [string, Uint8Array][], formId = 0x100) => {
  const list = new Fields(fields.map(([field, data]) => ({ type: field, data })));
  return {
    formId,
    type,
    editorId: 'Test',
    fields: list,
    formIdAt: (data: Uint8Array, offset = 0) =>
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
    text: (field: string) => {
      const data = list.first(field);
      return data && new TextDecoder().decode(data).replace(/\0.*$/, '');
    },
  };
};

describe('race head data', () => {
  const data = new Uint8Array(128);
  new DataView(data.buffer).setUint32(32, 0x1, true); // playable
  const race = parseRaceChargen(
    record('RACE', [
      ['FULL', text('Nord')],
      ['DESC', text('Citizens of Skyrim.')],
      ['DATA', data],
      ['NAM8', u32s(0x200)],
      ['HCLF', u32s(0x30, 0x31)],
      ['NAM1', empty], // body data: its MNAM / FNAM are not head data
      ['MNAM', empty],
      ['FNAM', empty],
      ['NAM0', empty],
      ['MNAM', empty],
      ['INDX', u32s(0)],
      ['HEAD', u32s(0x40)],
      ['MPAI', u32s(MorphGroup.nose)],
      ['MPAV', u32s(0x001fff3e, ...new Array<number>(7).fill(0xffffffff))],
      ['MPAI', u32s(MorphGroup.eyes)],
      ['MPAV', u32s(0x6, 0xffffff81, 0, 0, 0, 0, 0, 0)],
      ['RPRM', u32s(0x50)],
      ['RPRM', u32s(0x51)],
      ['AHCM', u32s(0x60)],
      ['FTSM', u32s(0x70)],
      ['FTSM', u32s(0x71)],
      ['DFTM', u32s(0x70)],
      ['TINI', u16(1)],
      ['TINT', text('Actors\\Character\\Character Assets\\TintMasks\\SkinTone.dds')],
      ['TINP', u16(TintMaskType.skinTone)],
      ['TIND', u32s(0x80)],
      ['TINC', u32s(0x81)],
      ['TINV', f32s(1)],
      ['TIRS', u16(75)],
      ['TINC', u32s(0x80)],
      ['TINV', f32s(0.5)],
      ['TIRS', u16(76)],
      ['TINI', u16(17)],
      ['TINT', text('Actors\\Character\\Character Assets\\TintMasks\\Freckles.dds')],
      ['NAM0', empty],
      ['FNAM', empty],
      ['HEAD', u32s(0x41)],
      ['RPRF', u32s(0x52)],
      ['AHCF', u32s(0x61)],
      ['FTSF', u32s(0x72)],
      ['DFTF', u32s(0x72)],
      ['TINI', u16(2)],
      ['TINP', u16(TintMaskType.dirt)],
    ]),
  );

  it('reads the race, its description and both sexes', () => {
    expect(race).toMatchObject({
      name: 'Nord',
      description: 'Citizens of Skyrim.',
      playable: true,
      morphRace: 0x200,
      defaultHairColor: [0x30, 0x31],
    });
    expect(race.sexes[0]).toMatchObject({
      headParts: [0x40],
      presets: [0x50, 0x51],
      hairColors: [0x60],
      faceDetails: [0x70, 0x71],
      defaultFaceTexture: 0x70,
    });
    expect(race.sexes[1]).toMatchObject({
      headParts: [0x41],
      presets: [0x52],
      hairColors: [0x61],
      faceDetails: [0x72],
      defaultFaceTexture: 0x72,
    });
  });

  it('reads the tint layers of each sex with their presets', () => {
    expect(race.sexes[0].tintLayers).toEqual([
      {
        index: 1,
        mask: 'Actors\\Character\\Character Assets\\TintMasks\\SkinTone.dds',
        type: TintMaskType.skinTone,
        defaultColor: 0x80,
        presets: [
          { color: 0x81, value: 1, id: 75 },
          { color: 0x80, value: 0.5, id: 76 },
        ],
      },
      {
        index: 17,
        mask: 'Actors\\Character\\Character Assets\\TintMasks\\Freckles.dds',
        type: TintMaskType.none,
        defaultColor: undefined,
        presets: [],
      },
    ]);
    expect(race.sexes[1].tintLayers).toEqual([
      { index: 2, mask: undefined, type: TintMaskType.dirt, defaultColor: undefined, presets: [] },
    ]);
  });

  it('offers the face part types whose MPAV bit is set, below the type count', () => {
    expect(availableMorphTypes(race.sexes[0].morphTypes[MorphGroup.nose], 31)).toEqual([
      1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    // Eye types run on into the second word: bit 0 there is type 32; bits past 38 are unused.
    expect(availableMorphTypes(race.sexes[0].morphTypes[MorphGroup.eyes], 38)).toEqual([1, 2, 32]);
    expect(availableMorphTypes(undefined, 31)).toEqual([]);
  });
});

describe('NPC face', () => {
  it('reads NAM9, NAMA and the tint layers', () => {
    const acbs = new Uint8Array(24);
    acbs[0] = 0x1; // female
    const morphs = Array.from({ length: 18 }, (_, i) => (i - 9) / 10);
    const face = parseNpcFace(
      record('NPC_', [
        ['ACBS', acbs],
        ['RNAM', u32s(0x13746)],
        ['PNAM', u32s(0x40)],
        ['HCLF', u32s(0x60)],
        ['FTST', u32s(0x70)],
        ['QNAM', f32s(0.5, 0.25, 1)],
        ['NAM7', f32s(35)],
        ['NAM9', new Uint8Array([...f32s(...morphs), 0, 0, 0, 0])],
        ['NAMA', i32s(9, -1, 17, 11)],
        ['TINI', u16(1)],
        ['TINC', Uint8Array.of(0xb7, 0x9c, 0x91, 0)],
        ['TINV', i32s(100)],
        ['TIAS', i16(75)],
        ['TINI', u16(5)],
        ['TINC', Uint8Array.of(10, 20, 30, 0)],
        ['TINV', i32s(42)],
        ['TIAS', i16(-1)],
      ]),
    );
    expect(face).toMatchObject({
      female: true,
      race: 0x13746,
      headParts: [0x40],
      hairColor: 0x60,
      faceTexture: 0x70,
      skinTone: [0.5, 0.25, 1],
      weight: 35,
      faceParts: [9, -1, 17, 11],
      tints: [
        { index: 1, color: [0xb7, 0x9c, 0x91], value: 1, preset: 75 },
        { index: 5, color: [10, 20, 30], value: 0.42, preset: -1 },
      ],
    });
    face.morphs.forEach((value, i) => {
      expect(value).toBeCloseTo(morphs[i] ?? 0, 6);
    });
  });

  it('starts from a neutral face without face data', () => {
    const face = parseNpcFace(record('NPC_', []));
    expect(face.morphs).toEqual(new Array<number>(18).fill(0));
    expect(face.faceParts).toEqual([0, -1, 0, 0]);
    expect(face.tints).toEqual([]);
  });
});

describe('head part flags', () => {
  it('reads DATA and the valid races list', () => {
    const part = parseHeadPart(
      record('HDPT', [
        ['DATA', Uint8Array.of(HeadPartFlag.playable | HeadPartFlag.male)],
        ['PNAM', u32s(3)],
        ['RNAM', u32s(0x90)],
      ]),
    );
    expect(part).toMatchObject({ type: 3, flags: 0x3, validRaces: 0x90 });
  });
});
