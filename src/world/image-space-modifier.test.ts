import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  channelSignatures,
  evaluateModifier,
  IMAD_CINEMATIC_CHANNELS,
  IMAD_DNAM_SIZE,
  IMAD_HDR_CHANNELS,
  modifierFinished,
  modifierKeyTime,
  parseImageSpaceModifier,
  sampleColor,
  sampleFloat,
} from './image-space-modifier.ts';

/** Synthetic IMAD records (no game data). */
function floats(values: number[]): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  const d = new DataView(data.buffer);
  values.forEach((v, i) => {
    d.setFloat32(i * 4, v, true);
  });
  return data;
}

interface DnamOptions {
  animatable?: boolean;
  duration?: number;
  radialUseTarget?: boolean;
  center?: [number, number];
  dofUseTarget?: boolean;
  dofFlags?: number;
}

function dnam(options: DnamOptions = {}): Uint8Array {
  const data = new Uint8Array(IMAD_DNAM_SIZE);
  const d = new DataView(data.buffer);
  d.setUint8(0, options.animatable ? 1 : 0);
  d.setFloat32(4, options.duration ?? 1, true);
  d.setUint32(0xc8, options.radialUseTarget ? 1 : 0, true);
  d.setFloat32(0xcc, options.center?.[0] ?? 0.5, true);
  d.setFloat32(0xd0, options.center?.[1] ?? 0.5, true);
  d.setUint8(0xe0, options.dofUseTarget ? 1 : 0);
  d.setUint8(0xe1, options.dofFlags ?? 0);
  return data;
}

/** Float keys as [time, value] pairs. */
const keys = (...pairs: [number, number][]): Uint8Array => floats(pairs.flat());
/** Colour keys as [time, r, g, b, a]. */
const colorKeys = (...entries: [number, number, number, number, number][]): Uint8Array =>
  floats(entries.flat());

function imad(
  formId: number,
  options: DnamOptions,
  fields: [string, Uint8Array][],
): { formId: number; editorId: string; fields: Fields } {
  return {
    formId,
    editorId: `Test${formId.toString(16)}`,
    fields: new Fields(
      [['DNAM', dnam(options)] as [string, Uint8Array], ...fields].map(([type, data]) => ({
        type,
        data,
      })),
    ),
  };
}

describe('parseImageSpaceModifier', () => {
  it('reads the header, the channels and every keyed value', () => {
    const brightness = channelSignatures(IMAD_CINEMATIC_CHANNELS.brightness);
    const bloom = channelSignatures(IMAD_HDR_CHANNELS.bloomScale);
    const modifier = parseImageSpaceModifier(
      imad(0x434bb, { animatable: true, duration: 3, center: [0.25, 0.75], dofFlags: 0x22 }, [
        ['EDID', new Uint8Array([0])],
        [brightness.add, keys([0, -0.15], [1, 0])],
        [bloom.mult, keys([1, 2], [0, 1])],
        ['TNAM', colorKeys([0, 1, 0, 0, 0.5])],
        ['NAM3', colorKeys([0, 0, 0, 0, 0], [1, 0, 0, 0, 1])],
        ['BNAM', keys([0, 3])],
        ['VNAM', keys([0, 0.05])],
        ['RNAM', keys([0, 0.1])],
        ['SNAM', keys([0, 0.5])],
        ['UNAM', keys([0, 0.25])],
        ['NAM1', keys([0, 0.9])],
        ['NAM2', keys([0, 3])],
        ['WNAM', keys([0, 1])],
        ['XNAM', keys([0, 300])],
        ['YNAM', keys([0, 200])],
        ['NAM4', keys([0, 0.1])],
      ]),
    );
    expect(modifier.animatable).toBe(true);
    expect(modifier.duration).toBe(3);
    expect(modifier.channels).toHaveLength(21);
    expect(modifier.channels[IMAD_CINEMATIC_CHANNELS.brightness]?.add[0]?.value).toBeCloseTo(-0.15);
    // Keys come sorted by time.
    expect(modifier.channels[IMAD_HDR_CHANNELS.bloomScale]?.mult.map((k) => k.time)).toEqual([
      0, 1,
    ]);
    expect(modifier.tint[0]?.color).toEqual([1, 0, 0, 0.5]);
    expect(modifier.fade).toHaveLength(2);
    expect(modifier.blurRadius[0]?.value).toBe(3);
    expect(modifier.radialBlur.center).toEqual([0.25, 0.75]);
    expect(modifier.radialBlur.downStart[0]?.value).toBe(3);
    expect(modifier.depthOfField.mode).toBe('back');
    expect(modifier.depthOfField.sky).toBe(true);
    expect(modifier.depthOfField.blurRadius).toBe(4);
    expect(modifier.motionBlur[0]?.value).toBeCloseTo(0.1);
  });

  it('reads the depth of field flags', () => {
    const flags = (dofFlags: number) =>
      parseImageSpaceModifier(imad(1, { dofFlags }, [])).depthOfField;
    expect(flags(0)).toMatchObject({ mode: 'frontBack', sky: true, blurRadius: 0 });
    expect(flags(1)).toMatchObject({ mode: 'front' });
    expect(flags(0x0a)).toMatchObject({ mode: 'back', blurRadius: 1 });
    expect(flags(0x3f)).toMatchObject({ mode: 'none', sky: false, blurRadius: 7 });
  });

  it('survives a missing DNAM and missing keys', () => {
    const modifier = parseImageSpaceModifier({
      formId: 2,
      editorId: undefined,
      fields: new Fields([]),
    });
    expect(modifier.animatable).toBe(false);
    expect(modifier.radialBlur.center).toEqual([0.5, 0.5]);
    const frame = evaluateModifier(modifier, 0);
    expect(frame.hdr.bloomScale).toEqual({ mult: 1, add: 0 });
    expect(frame.tint[3]).toBe(0);
    expect(frame.blurRadius).toBe(0);
  });
});

describe('sampling', () => {
  it('interpolates linearly and holds the ends', () => {
    const curve = [
      { time: 0.2, value: 1 },
      { time: 0.6, value: 3 },
    ];
    expect(sampleFloat(curve, 0, 9)).toBe(1);
    expect(sampleFloat(curve, 0.4, 9)).toBeCloseTo(2);
    expect(sampleFloat(curve, 1, 9)).toBe(3);
    expect(sampleFloat([], 0.5, 9)).toBe(9);
    const colors = [
      { time: 0, color: [0, 0, 0, 0] as const },
      { time: 1, color: [1, 0.5, 0, 1] as const },
    ];
    expect(sampleColor(colors, 0.5, [1, 1, 1, 0])).toEqual([0.5, 0.25, 0, 0.5]);
  });

  it('runs animated modifiers over their duration, static ones stay at their start', () => {
    const animated = { animatable: true, duration: 4 };
    expect(modifierKeyTime(animated, 1)).toBe(0.25);
    expect(modifierKeyTime(animated, 10)).toBe(1);
    expect(modifierKeyTime(animated, 5, true)).toBe(0.25);
    expect(modifierFinished(animated, 4)).toBe(true);
    const still = { animatable: false, duration: 4 };
    expect(modifierKeyTime(still, 3)).toBe(0);
    expect(modifierFinished(still, 100)).toBe(false);
    // Animatable without a duration stays up at its start.
    expect(modifierFinished({ animatable: true, duration: 0 }, 100)).toBe(false);
  });

  it('evaluates a frame of the timeline', () => {
    const saturation = channelSignatures(IMAD_CINEMATIC_CHANNELS.saturation);
    const modifier = parseImageSpaceModifier(
      imad(3, { animatable: true, duration: 2 }, [
        [saturation.mult, keys([0, 1], [1, 0])],
        ['NAM3', colorKeys([0, 0, 0, 0, 0], [1, 0, 0, 0, 1])],
        ['RNAM', keys([0, 0], [1, 2])],
      ]),
    );
    const frame = evaluateModifier(modifier, modifierKeyTime(modifier, 1));
    expect(frame.saturation.mult).toBeCloseTo(0.5);
    expect(frame.fade[3]).toBeCloseTo(0.5);
    expect(frame.radialBlur.strength).toBeCloseTo(1);
  });
});
