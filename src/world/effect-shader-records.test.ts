import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  EffectShaderFlag,
  fillColor,
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
