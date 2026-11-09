import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  addonLook,
  EffectShaderFlag,
  fillColor,
  holesShare,
  holesValue,
  parseEffectShader,
  timelineAlpha,
} from './effect-shader-records.ts';

const zstring = (text: string): Uint8Array => new TextEncoder().encode(`${text}\0`);

/** FireFXShader's DATA in part: blends, timelines, colours, particles, flags. */
function fireShader() {
  const data = new DataView(new ArrayBuffer(400));
  data.setUint32(4, 5, true);
  data.setUint32(12, 3, true);
  data.setFloat32(20, 0.2, true);
  data.setFloat32(24, 0.05, true);
  data.setFloat32(28, 1.5, true);
  data.setFloat32(32, 0.2, true);
  data.setFloat32(48, 0.4, true);
  data.setUint8(56, 0x92);
  data.setUint8(57, 0x41);
  data.setUint8(58, 0x05);
  data.setFloat32(84, 0.25, true);
  data.setUint32(92, 2, true);
  data.setUint32(104, 4, true);
  data.setFloat32(124, 90, true);
  data.setFloat32(132, 0.4, true);
  data.setFloat32(156, 122, true);
  data.setFloat32(172, 12, true);
  data.setFloat32(176, 26, true);
  data.setUint32(276, 4, true);
  data.setUint32(280, 2, true);
  data.setFloat32(344, 1.5, true);
  data.setUint32(384, EffectShaderFlag.particleGreyscaleColor, true);
  const fields = new Fields([
    { type: 'ICON', data: zstring('Effects\\VaporTile01.dds') },
    { type: 'ICO2', data: zstring('Effects\\FXFireAtlas02.dds') },
    { type: 'DATA', data: new Uint8Array(data.buffer) },
  ]);
  return parseEffectShader({
    formId: 0x1b212,
    editorId: 'FireFXShader',
    fields,
    formIdAt: (bytes, offset) =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset ?? 0, true),
  });
}

describe('EFSH', () => {
  it('reads the membrane, its edge and the particle shader (xEdit layout)', () => {
    const shader = fireShader();
    expect(shader.fillTexture).toBe('effects\\vaportile01.dds');
    expect(shader.particleTexture).toBe('effects\\fxfireatlas02.dds');
    expect(shader.membrane.sourceBlend).toBe(5);
    expect(shader.membrane.destBlend).toBe(2);
    expect(shader.membrane.zTest).toBe(3);
    expect(shader.membrane.fill.fadeIn).toBeCloseTo(0.2, 6);
    expect(shader.membrane.fill.fullRatio).toBeCloseTo(0.25, 6);
    expect(shader.membrane.scroll[1]).toBeCloseTo(0.4, 6);
    expect(shader.membrane.edgeColor.map((c) => Math.round(c * 255))).toEqual([0x92, 0x41, 0x05]);
    expect(shader.particles.zTest).toBe(4);
    expect(shader.particles.fullBirthRatio).toBe(90);
    expect(shader.particles.velocity).toEqual([0, 0, 122]);
    expect(shader.particles.scaleKeys).toEqual([12, 26]);
    expect([shader.particles.textureCountU, shader.particles.textureCountV]).toEqual([4, 2]);
    expect(shader.colorScale).toBe(1.5);
    expect(shader.flags).toBe(EffectShaderFlag.particleGreyscaleColor);
  });

  it('fades in, holds, fades out to its persistent share, and out as it stops', () => {
    const timeline = {
      fadeIn: 1,
      full: 1,
      fadeOut: 2,
      persistent: 0.5,
      pulseAmplitude: 0,
      pulseFrequency: 1,
      fullRatio: 1,
    };
    expect(timelineAlpha(timeline, 0.5)).toBeCloseTo(0.5, 6);
    expect(timelineAlpha(timeline, 1.5)).toBe(1);
    expect(timelineAlpha(timeline, 3)).toBeCloseTo(0.75, 6);
    expect(timelineAlpha(timeline, 10)).toBeCloseTo(0.5, 6);
    // Told to stop 1 s ago: half its fade out gone.
    expect(timelineAlpha(timeline, 10, 1)).toBeCloseTo(0.5, 6);
    expect(timelineAlpha(timeline, 10, 2)).toBe(0);
  });

  it('colours the fill between its keys', () => {
    const shader = fireShader();
    const keyed = {
      ...shader,
      membrane: {
        ...shader.membrane,
        colors: [
          { color: [1, 0, 0] as const, scale: 1, time: 0 },
          { color: [0, 0, 1] as const, scale: 2, time: 1 },
          { color: [0, 0, 0] as const, scale: 1, time: 0 },
        ],
      },
    };
    expect(fillColor(keyed, 0)).toEqual([1, 0, 0]);
    expect(fillColor(keyed, 0.5)).toEqual([0.5, 0, 1]);
    expect(fillColor(keyed, 5)).toEqual([0, 0, 2]);
  });
});

/**
 * TimeFadeOut01FXS's holes (NAM7 and DATA 248 .. 271: 0.1 s to 2.1 s, 255 to 0) and
 * FrostIceFormFXShader02's addon block (DATA 244 a DEBR, 284 .. 304: fade 0 / 1.55, scale 0.5 to
 * 0.25 over 0.15, back over 1.55).
 */
function holedShader() {
  const data = new DataView(new ArrayBuffer(400));
  data.setUint32(244, 0xdc20b, true);
  data.setFloat32(248, 0.1, true);
  data.setFloat32(252, 2.1, true);
  data.setFloat32(256, 255, true);
  data.setFloat32(260, 0, true);
  data.setFloat32(264, 3, true);
  data.setUint8(268, 0xff);
  data.setUint8(269, 0x80);
  data.setFloat32(284, 0, true);
  data.setFloat32(288, 1.55, true);
  data.setFloat32(292, 0.5, true);
  data.setFloat32(296, 0.25, true);
  data.setFloat32(300, 0.15, true);
  data.setFloat32(304, 1.55, true);
  const fields = new Fields([
    { type: 'NAM7', data: zstring('Effects\\FXMagicDisolveAlpha01.dds') },
    { type: 'DATA', data: new Uint8Array(data.buffer) },
  ]);
  return parseEffectShader({
    formId: 0x10f9b4,
    editorId: 'TimeFadeOut01FXS',
    fields,
    formIdAt: (bytes, offset) =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset ?? 0, true),
  });
}

describe('EFSH holes and addon models', () => {
  it('reads the holes block and the addon models’ times and scales (xEdit layout)', () => {
    const shader = holedShader();
    expect(shader.holesTexture).toBe('effects\\fxmagicdisolvealpha01.dds');
    expect(shader.holes.startTime).toBeCloseTo(0.1, 6);
    expect(shader.holes.endTime).toBeCloseTo(2.1, 6);
    expect(shader.holes.startValue).toBe(255);
    expect(shader.holes.endValue).toBe(0);
    expect(shader.holes.edgeWidth).toBe(3);
    expect(shader.holes.edgeColor.map((c) => Math.round(c * 255))).toEqual([0xff, 0x80, 0]);
    expect(shader.addonModels).toBe(0xdc20b);
    expect(shader.addon.fadeOut).toBeCloseTo(1.55, 6);
    expect(shader.addon.scaleStart).toBe(0.5);
    expect(shader.addon.scaleEnd).toBe(0.25);
    expect(shader.addon.scaleIn).toBeCloseTo(0.15, 6);
    expect(shader.addon.scaleOut).toBeCloseTo(1.55, 6);
  });

  it('moves the holes threshold from its start to its end value between their times', () => {
    const { holes } = holedShader();
    expect(holesValue(holes, 0)).toBe(255);
    expect(holesValue(holes, 1.1)).toBeCloseTo(127.5, 4);
    expect(holesValue(holes, 5)).toBe(0);
  });

  it('cuts away the share the threshold leaves, none without a holes texture', () => {
    const shader = holedShader();
    expect(holesShare(shader, 0)).toBe(0);
    expect(holesShare(shader, 1.1)).toBeCloseTo(0.5, 4);
    expect(holesShare(shader, 3)).toBe(1);
    expect(holesShare({ ...shader, holesTexture: '' }, 3)).toBe(0);
  });

  it('fades and scales the addon models in, and out as the shader stops', () => {
    const { addon } = holedShader();
    expect(addonLook(addon, 0)).toEqual({ alpha: 1, scale: 0.5, done: false });
    expect(addonLook(addon, 0.075).scale).toBeCloseTo(0.375, 6);
    expect(addonLook(addon, 1)).toEqual({ alpha: 1, scale: 0.25, done: false });
    const going = addonLook(addon, 5, 0.775);
    expect(going.alpha).toBeCloseTo(0.5, 6);
    expect(going.scale).toBeCloseTo(0.375, 6);
    expect(going.done).toBe(false);
    expect(addonLook(addon, 5, 1.6)).toMatchObject({ alpha: 0, done: true });
    // A fade-in time: they come in from nothing.
    expect(addonLook({ ...addon, fadeIn: 0.2 }, 0.1).alpha).toBeCloseTo(0.5, 6);
  });
});
