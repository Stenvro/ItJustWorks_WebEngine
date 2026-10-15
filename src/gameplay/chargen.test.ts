import { describe, expect, it } from 'vitest';
import { HeadPartType } from '../world/actor-records.ts';
import { TintMaskType, type NpcFace } from '../world/chargen-records.ts';
import {
  CHARGEN_CATEGORIES,
  MORPH_PAIRS,
  SLIDER_DEFINITIONS,
  SliderCallback,
  appearanceFromNpc,
  applyPreset,
  applySlider,
  buildSliders,
  chargenMorphWeights,
  composeFaceTint,
  currentHeadPart,
  defaultAppearance,
  faceTintLayers,
  skinnyMorphWeight,
  sliderArguments,
  type ChargenRaceData,
  type ChargenTintLayer,
  type PlayerAppearance,
} from './chargen.ts';

const preset = (color: number, rgb: [number, number, number], value: number, id: number) => ({
  color,
  rgb,
  value,
  id,
});
const layer = (
  index: number,
  type: number,
  presets: ChargenTintLayer['presets'],
  defaultColor?: number,
): ChargenTintLayer => ({
  index,
  mask: `Actors\\Character\\Character Assets\\TintMasks\\Mask${String(index)}.dds`,
  type,
  defaultColor,
  defaultRgb: presets.find((p) => p.color === defaultColor)?.rgb,
  presets,
});

const face = (overrides: Partial<NpcFace>): NpcFace => ({
  formId: 0x900,
  editorId: 'Preset',
  female: false,
  race: 0x13746,
  headParts: [],
  hairColor: undefined,
  faceTexture: undefined,
  skinTone: undefined,
  weight: 50,
  morphs: new Array<number>(18).fill(0),
  faceParts: [0, -1, 0, 0],
  tints: [],
  ...overrides,
});

const NORD_PRESET = face({
  editorId: 'NordMalePreset01',
  headParts: [0x12],
  hairColor: 0x61,
  faceTexture: 0x71,
  skinTone: [1, 0.5, 0],
  morphs: [0.5, ...new Array<number>(17).fill(0)],
  faceParts: [3, -1, 9, 2],
  tints: [{ index: 5, color: [1, 2, 3], value: 0.5, preset: 11 }],
});

// Head parts: 0x10.. hair, 0x20.. eyes, 0x30 the face.
const data: ChargenRaceData = {
  race: 0x13746,
  editorId: 'NordRace',
  name: 'Nord',
  description: '',
  sex: 0,
  morphRace: 'NordRace',
  defaultHeadParts: [0x10, 0x20, 0x30],
  headPartLists: new Map([
    [HeadPartType.hair, [0x10, 0x11, 0x12]],
    [HeadPartType.eyes, [0x20, 0x21]],
  ]),
  headPartTypes: new Map([
    [0x10, HeadPartType.hair],
    [0x11, HeadPartType.hair],
    [0x12, HeadPartType.hair],
    [0x20, HeadPartType.eyes],
    [0x21, HeadPartType.eyes],
    [0x30, HeadPartType.face],
  ]),
  presets: [NORD_PRESET],
  hairColors: [
    { formId: 0x60, rgb: [10, 10, 10] },
    { formId: 0x61, rgb: [20, 20, 20] },
  ],
  defaultHairColor: 0x60,
  faceDetails: [0x70, 0x71],
  defaultFaceTexture: 0x70,
  morphTypes: [[1, 3, 5], [], [9, 10], [2, 4]],
  tintLayers: [
    layer(
      1,
      TintMaskType.skinTone,
      [preset(0x80, [255, 0, 0], 1, 1), preset(0x81, [0, 255, 0], 1, 2)],
      0x81,
    ),
    layer(5, TintMaskType.lipColor, [preset(0x82, [1, 2, 3], 0.5, 11)]),
    layer(21, TintMaskType.paint, [
      preset(0x83, [0, 0, 0], 0, 20),
      preset(0x84, [9, 9, 9], 0.8, 21),
    ]),
    layer(22, TintMaskType.paint, [
      preset(0x83, [0, 0, 0], 0, 30),
      preset(0x84, [9, 9, 9], 0.8, 31),
    ]),
  ],
};

const sliderOf = (appearance: PlayerAppearance, id: number) =>
  buildSliders(data, appearance).find((s) => s.id === id);

describe('character creation model', () => {
  it('matches the callbacks of the movie developer harness by slider id', () => {
    const harness: [string, number][] = [
      ['ChangeHeadPreset', 0],
      ['ChangeTintingMask', 1],
      ['ChangeWeight', 2],
      ['ChangeFaceDetails', 3],
      ['ChangeHeadPart', 6],
      ['ChangePreset', 24],
      ['ChangeDoubleMorph', 26],
      ['ChangeDoubleMorph', 27],
      ['ChangeDoubleMorph', 31],
      ['ChangeTintingMask', 32],
      ['ChangePreset', 12],
      ['ChangeHeadPart', 13],
      ['ChangeDoubleMorph', 15],
      ['ChangeDoubleMorph', 14],
      ['ChangeDoubleMorph', 42],
      ['ChangeHeadPart', 10],
      ['ChangeHairColorPreset', 11],
      ['ChangePreset', 39],
      ['ChangeHeadPart', 20],
    ];
    const callbackOf = (id: number) => {
      const spec = SLIDER_DEFINITIONS.find((d) => d.id === id)?.spec;
      switch (spec?.kind) {
        case 'headPreset':
          return SliderCallback.headPreset;
        case 'tint':
        case 'tintMask':
        case 'tintColor':
          return SliderCallback.tint;
        case 'weight':
          return SliderCallback.weight;
        case 'complexion':
          return SliderCallback.faceDetails;
        case 'headPart':
          return SliderCallback.headPart;
        case 'hairColor':
          return SliderCallback.hairColor;
        case 'faceType':
          return SliderCallback.faceType;
        case 'morph':
          return SliderCallback.morph;
        default:
          return undefined;
      }
    };
    for (const [callback, id] of harness) expect([id, callbackOf(id)]).toEqual([id, callback]);
    const ids = SLIDER_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MORPH_PAIRS).toHaveLength(18);
    expect(CHARGEN_CATEGORIES.map((c) => c.label)[2]).toBe('sRSMHead');
  });

  it('builds a default look from the race defaults', () => {
    const look = defaultAppearance(data, 30);
    expect(look).toMatchObject({
      race: 0x13746,
      sex: 0,
      weight: 30,
      headParts: [],
      hairColor: 0x60,
      complexion: 0x70,
      faceParts: [1, -1, 9, 2],
      skinTone: [0, 1, 0],
      tints: [{ index: 1, color: [0, 255, 0], value: 1, preset: 2 }],
    });
    expect(currentHeadPart(data, look, HeadPartType.hair)).toBe(0x10);
  });

  it('lists the sliders with ranges and positions, leaving out empty lists', () => {
    const look = defaultAppearance(data);
    const sliders = buildSliders(data, look);
    expect(sliders.find((s) => s.label === 'sRSMFacialHairPresets')).toBeUndefined();
    expect(sliders.find((s) => s.label === 'sRSMDirt')).toBeUndefined();
    expect(sliderOf(look, 1)).toMatchObject({ min: 0, max: 1, position: 1, interval: 1 });
    expect(sliderOf(look, 2)).toMatchObject({ min: 0, max: 1, position: 0.5 });
    expect(sliderOf(look, 39)).toMatchObject({ callback: 'ChangePreset', max: 2, position: 0 });
    expect(sliderOf(look, 7)).toMatchObject({ max: 2, position: 0 });
    expect(sliderOf(look, 42)).toMatchObject({ min: -1, max: 1, filterFlag: 0x10 });
    expect(sliderArguments(sliders.slice(0, 1), (label) => `<${label}>`)).toEqual([
      '<sRSMSex>',
      0x4,
      'ChangeSex',
      0,
      1,
      0,
      1,
      46,
    ]);
  });

  it('applies morph, face type, head part and weight sliders', () => {
    let look = defaultAppearance(data);
    look = applySlider(data, look, 42, -0.7).appearance; // jaw height (NAM9 2)
    expect(look.faceMorphs[2]).toBeCloseTo(-0.7);
    look = applySlider(data, look, 39, 2).appearance; // the third nose type offered
    expect(look.faceParts[0]).toBe(5);
    look = applySlider(data, look, 9, 1).appearance;
    look = applySlider(data, look, 9, 2).appearance;
    expect(look.headParts).toEqual([0x12]);
    expect(sliderOf(look, 9)?.position).toBe(2);
    const weight = applySlider(data, look, 2, 0.25);
    expect(weight.appearance.weight).toBe(25);
    expect(weight.changes).toContain('shape');
    expect(applySlider(data, look, 999, 1).changes).toEqual([]);
  });

  it('steps tints through the presets; the skin tone also sets QNAM', () => {
    const look = defaultAppearance(data);
    const result = applySlider(data, look, 1, 0);
    expect(result.appearance.skinTone).toEqual([1, 0, 0]);
    expect(result.appearance.tints).toEqual([
      { index: 1, color: [255, 0, 0], value: 1, preset: 1 },
    ]);
    expect(result.changes).toEqual(['tints', 'skinTone']);
    const lips = applySlider(data, result.appearance, 30, 0).appearance;
    expect(lips.tints.map((t) => t.index)).toEqual([1, 5]);
  });

  it('picks one war paint mask and its colour', () => {
    let look = defaultAppearance(data);
    const picked = applySlider(data, look, 7, 2);
    expect(picked.resendSliders).toBe(true);
    look = picked.appearance;
    expect(look.tints.find((t) => t.index === 22)).toEqual({
      index: 22,
      color: [9, 9, 9],
      value: 0.8,
      preset: 31,
    });
    expect(sliderOf(look, 7)?.position).toBe(2);
    look = applySlider(data, look, 7, 1).appearance; // the other mask keeps the colour
    expect(look.tints.filter((t) => t.index >= 21).map((t) => [t.index, t.preset])).toEqual([
      [21, 21],
    ]);
    look = applySlider(data, look, 8, 0).appearance;
    expect(look.tints.find((t) => t.index === 21)?.value).toBe(0);
    expect(sliderOf(look, 7)?.position).toBe(1);
    look = applySlider(data, look, 7, 0).appearance; // none
    expect(look.tints.some((t) => t.index >= 21)).toBe(false);
  });

  it('copies a preset face but keeps race, sex and weight', () => {
    const look = applySlider(data, defaultAppearance(data, 80), 0, 0);
    expect(look.resendSliders).toBe(true);
    expect(look.appearance).toMatchObject({
      weight: 80,
      headParts: [0x12],
      hairColor: 0x61,
      complexion: 0x71,
      skinTone: [1, 0.5, 0],
      faceParts: [3, -1, 9, 2],
    });
    // Without a skin tone layer the preset gets one in its QNAM colour.
    expect(look.appearance.tints.map((t) => [t.index, t.color])).toEqual([
      [1, [255, 128, 0]],
      [5, [1, 2, 3]],
    ]);
    expect(sliderOf(look.appearance, 0)?.position).toBe(0);
    expect(applyPreset(data, look.appearance, NORD_PRESET)).toEqual(look.appearance);
  });

  it('takes an NPC look with its weight', () => {
    const look = appearanceFromNpc(data, face({ weight: 100, skinTone: [0, 1, 0] }));
    expect(look.weight).toBe(100);
    expect(look.tints).toEqual([{ index: 1, color: [0, 255, 0], value: 1, preset: 2 }]);
  });

  it('reports a sex change for the caller to reload the race data', () => {
    const result = applySlider(data, defaultAppearance(data), 46, 1);
    expect(result).toMatchObject({ changes: ['sex'], resendSliders: true });
    expect(result.appearance.sex).toBe(1);
  });

  it('weights the morphs: race, NAM9 pairs (two reversed), NAMA types, SkinnyMorph', () => {
    const faceMorphs = new Array<number>(18).fill(0);
    faceMorphs[0] = 0.4; // nose length → NoseLong
    faceMorphs[2] = -0.72; // jaw height: negative raises the jaw → JawUp
    faceMorphs[15] = 0.3; // chin length: positive → ChinMoveDown
    faceMorphs[17] = -0.34; // eye depth → EyesBack
    const weights = chargenMorphWeights(
      { faceMorphs, faceParts: [2, -1, 12, 20], weight: 35 },
      'NordRace',
    );
    expect(Object.fromEntries(weights)).toEqual({
      nordrace: 1,
      noselong: 0.4,
      jawup: 0.72,
      chinmovedown: 0.3,
      eyesback: 0.34,
      nosetype2: 1,
      eyestype12: 1,
      liptype20: 1,
      skinnymorph: 0.65,
    });
    expect(skinnyMorphWeight(100)).toBe(0);
    expect(skinnyMorphWeight(-5)).toBe(1);
  });

  it('names the tint masks in composite order', () => {
    const look = applySlider(data, defaultAppearance(data), 30, 0).appearance;
    expect(faceTintLayers(data, look)).toEqual([
      {
        mask: 'textures\\actors\\character\\character assets\\tintmasks\\mask1.dds',
        color: [0, 255, 0],
        value: 1,
      },
      {
        mask: 'textures\\actors\\character\\character assets\\tintmasks\\mask5.dds',
        color: [1, 2, 3],
        value: 0.5,
      },
    ]);
  });

  it('composites tint layers with the mask red channel', () => {
    // 2×1 output; the second mask is 1×1 (sampled at the nearest pixel).
    const full = { data: Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255), width: 2, height: 1 };
    const half = { data: Uint8Array.of(128, 255, 255, 0, 0, 255, 255, 255), width: 2, height: 1 };
    const small = { data: Uint8Array.of(255, 0, 0, 0), width: 1, height: 1 };
    const out = composeFaceTint(
      [
        { mask: full, color: [200, 100, 50], value: 1 },
        { mask: half, color: [0, 0, 0], value: 1 },
        { mask: small, color: [100, 100, 100], value: 0.5 },
      ],
      2,
      1,
    );
    // Pixel 0: 200→ lerp to 0 by 128/255 → 99.6, then halfway to 100.
    expect([...out]).toEqual([100, 75, 62, 255, 150, 100, 75, 255]);
  });
});
