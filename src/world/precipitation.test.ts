import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { parsePrecipitation, precipitationAmounts } from './precipitation.ts';

function data(values: number[]): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => {
    // Floats except the atlas size, type and box size (u32 at 28..40).
    if (i >= 7 && i <= 10) view.setUint32(i * 4, value, true);
    else view.setFloat32(i * 4, value, true);
  });
  return bytes;
}

describe('parsePrecipitation', () => {
  it('reads rain: fall speed, size, atlas, box and density', () => {
    const rain = parsePrecipitation({
      formId: 0x10e3d1,
      editorId: 'RainStormParticles',
      fields: new Fields([
        { type: 'DATA', data: data([675, 0, 0.35, 2, 0, 0, 0, 4, 2, 0, 1400, 2]) },
        { type: 'ICON', data: new TextEncoder().encode('Effects\\FXRaindrops.dds\0') },
      ]),
    });
    expect(rain).toMatchObject({
      type: 'rain',
      gravityVelocity: 675,
      subtexturesX: 4,
      subtexturesY: 2,
      boxSize: 1400,
      density: 2,
      texture: 'textures\\effects\\fxraindrops.dds',
    });
    expect(rain.sizeX).toBeCloseTo(0.35, 6);
  });

  it('reads snow and its drift', () => {
    const snow = parsePrecipitation({
      formId: 1,
      fields: new Fields([
        { type: 'DATA', data: data([100, 100, 1.15, 1.15, 50, 185, 360, 4, 4, 1, 740, 6]) },
      ]),
    });
    expect(snow).toMatchObject({
      type: 'snow',
      rotationVelocity: 100,
      centerOffsetMin: 50,
      centerOffsetMax: 185,
      initialRotationRange: 360,
      texture: '',
    });
  });
});

describe('precipitationAmounts', () => {
  const rainy = { precipitation: 7, precipitationFadeIn: 0.5, precipitationFadeOut: 0.25 };
  const clear = { precipitation: undefined, precipitationFadeIn: 0, precipitationFadeOut: 0 };

  it('falls fully without a change of weather', () => {
    expect(precipitationAmounts(rainy, undefined, 1)).toEqual([{ formId: 7, amount: 1 }]);
  });

  it('starts at the new weather’s fade-in point of the change', () => {
    expect(precipitationAmounts(rainy, clear, 0.4)).toEqual([]);
    expect(precipitationAmounts(rainy, clear, 0.75)[0]?.amount).toBeCloseTo(0.5, 6);
  });

  it('stops by the old weather’s fade-out point', () => {
    expect(precipitationAmounts(clear, rainy, 0.125)[0]?.amount).toBeCloseTo(0.5, 6);
    expect(precipitationAmounts(clear, rainy, 0.3)).toEqual([]);
  });
});
