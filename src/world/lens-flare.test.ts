import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { LensFlareSpriteFlag, parseLensFlare, placeLensFlare } from './lens-flare.ts';
import {
  blendVolumetricLighting,
  godRays,
  parseVolumetricLighting,
} from './volumetric-lighting.ts';

/** Synthetic records (no game data). */
const floats = (...values: number[]): Uint8Array => {
  const data = new Uint8Array(values.length * 4);
  const d = new DataView(data.buffer);
  values.forEach((v, i) => {
    d.setFloat32(i * 4, v, true);
  });
  return data;
};
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const u32 = (value: number): Uint8Array => new Uint8Array(new Uint32Array([value]).buffer);
const lfsd = (values: number[], flags: number): Uint8Array => {
  const data = new Uint8Array(36);
  data.set(floats(...values), 0);
  new DataView(data.buffer).setUint32(32, flags, true);
  return data;
};

describe('LENS', () => {
  const lens = parseLensFlare({
    formId: 0x800,
    editorId: 'TestFlare',
    fields: new Fields([
      { type: 'EDID', data: text('TestFlare') },
      { type: 'CNAM', data: floats(0.5) },
      { type: 'DNAM', data: floats(2) },
      { type: 'LFSP', data: u32(2) },
      { type: 'DNAM', data: text('Glow') },
      { type: 'FNAM', data: text('Effects\\LensFlare\\Glow.dds') },
      { type: 'LFSD', data: lfsd([1, 0.5, 0.25, 0.4, 0.4, 0, 0, 1], 0) },
      { type: 'DNAM', data: text('Ring') },
      { type: 'FNAM', data: text('textures\\effects\\ring.dds') },
      {
        type: 'LFSD',
        data: lfsd(
          [1, 1, 1, 0.2, 0.1, 1.5, 30, 0.5],
          LensFlareSpriteFlag.rotates | LensFlareSpriteFlag.shrinksWhenOccluded,
        ),
      },
    ]),
  });

  it('reads the header and each sprite in order', () => {
    expect(lens.colorInfluence).toBeCloseTo(0.5);
    expect(lens.fadeDistanceRadiusScale).toBeCloseTo(2);
    expect(lens.sprites.map((sprite) => [sprite.id, sprite.texture])).toEqual([
      ['Glow', 'textures\\Effects\\LensFlare\\Glow.dds'],
      ['Ring', 'textures\\effects\\ring.dds'],
    ]);
    expect(lens.sprites[1]?.position).toBeCloseTo(1.5);
    expect(lens.sprites[1]?.angularFade).toBeCloseTo(30);
  });

  it('lays the sprites along the line through the screen centre, faded as covered', () => {
    const light = { screen: [0.2, 0.3] as const, angle: 15, color: [1, 0, 0] as const, aspect: 1 };
    const placed = placeLensFlare(lens, { ...light, visibility: 0.5 });
    expect(placed).toHaveLength(2);
    const [glow, ring] = placed;
    expect(glow?.center).toEqual([0.2, 0.3]);
    // Tint mixed half with the light's red.
    expect(glow?.color[0]).toBeCloseTo(1);
    expect(glow?.color[1]).toBeCloseTo(0.25);
    expect(glow?.opacity).toBeCloseTo(0.5);
    expect(ring?.center[0]).toBeCloseTo(0.2 + 0.3 * 1.5);
    expect(ring?.center[1]).toBeCloseTo(0.3 + 0.2 * 1.5);
    // Half the angular fade gone, half visible, half opacity; shrunk by the cover.
    expect(ring?.opacity).toBeCloseTo(0.5 * 0.5 * 0.5);
    expect(ring?.halfSize[0]).toBeCloseTo(0.05);
    expect(ring?.rotation).not.toBe(0);
    expect(placeLensFlare(lens, { ...light, visibility: 0 })).toEqual([]);
  });
});

describe('VOLI', () => {
  const record = (intensity: number) => ({
    fields: new Fields(
      [
        'CNAM',
        'DNAM',
        'ENAM',
        'FNAM',
        'GNAM',
        'HNAM',
        'INAM',
        'JNAM',
        'KNAM',
        'LNAM',
        'MNAM',
        'NNAM',
      ].map((type, i) => ({
        type,
        data: floats([intensity, 0.5, 1, 0.5, 0, 0.3, 10, 15, 0.3, 0.85, 0.85, 40][i] ?? 0),
      })),
    ),
  });

  it('reads its twelve floats', () => {
    const voli = parseVolumetricLighting(record(4));
    expect(voli.intensity).toBe(4);
    expect(voli.customColorContribution).toBe(0.5);
    expect(voli.color).toEqual([1, 0.5, 0]);
    expect(voli.densitySize).toBe(10);
    expect(voli.phaseContribution).toBeCloseTo(0.85);
    expect(voli.rangeFactor).toBe(40);
  });

  it('blends by the time of day and scales by the settings', () => {
    const blended = blendVolumetricLighting([
      { lighting: parseVolumetricLighting(record(4)), weight: 0.25 },
      { lighting: parseVolumetricLighting(record(2)), weight: 0.75 },
    ]);
    expect(blended.intensity).toBeCloseTo(2.5);
    const rays = godRays(blended, { enabled: true, intensity: 2 }, [1, 1, 1], 0.5);
    expect(rays.strength).toBeCloseTo(2.5 * 2 * 0.85);
    expect(rays.color).toEqual([1, 0.75, 0.5]);
    expect(godRays(blended, { enabled: false, intensity: 2 }, [1, 1, 1], 0.5).strength).toBe(0);
    expect(godRays(blended, { enabled: true, intensity: 2 }, [1, 1, 1], -0.5).strength).toBe(0);
  });
});
