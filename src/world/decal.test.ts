import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { identity } from '../render/math.ts';
import { DecalFlag, expireDecals, parseTextureSet, placeDecal } from './decal.ts';

describe('expireDecals', () => {
  it('lets the decals past their lifetime go, then the oldest beyond the cap', () => {
    const decals = [
      { name: 'a', until: 10 },
      { name: 'b', until: 40 },
      { name: 'c', until: 41 },
      { name: 'd', until: 42 },
    ];
    const gone = expireDecals(decals, 30, 2);
    expect(gone.map((decal) => decal.name).sort()).toEqual(['a', 'b']);
    expect(decals.map((decal) => decal.name)).toEqual(['c', 'd']);
    expect(expireDecals(decals, 50, 1000).length).toBe(2);
    expect(decals).toEqual([]);
  });
});

const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);

function dodt(floats: number[], passes: number, flags: number, color: number[]): Uint8Array {
  const data = new Uint8Array(36);
  const view = new DataView(data.buffer);
  floats.forEach((value, i) => {
    view.setFloat32(i * 4, value, true);
  });
  data[28] = passes;
  data[29] = flags;
  data.set(color, 32);
  return data;
}

describe('parseTextureSet', () => {
  it('reads the textures, flags and decal data', () => {
    const set = parseTextureSet({
      editorId: 'DecalBloodSprayGroundSmall',
      fields: new Fields([
        { type: 'TX00', data: text('Blood\\DecalsBloodSplatterBlend01.dds') },
        { type: 'TX01', data: text('Blood/DecalsBloodSplatter01_n.dds') },
        { type: 'DODT', data: dodt([128, 256, 96, 192, 32, 400, 1], 4, 0x72, [255, 128, 0, 0]) },
        { type: 'DNAM', data: Uint8Array.of(1, 0) },
      ]),
    });
    expect(set.textures.slice(0, 3)).toEqual([
      'textures\\blood\\decalsbloodsplatterblend01.dds',
      'textures\\blood\\decalsbloodsplatter01_n.dds',
      '',
    ]);
    expect(set.flags).toBe(1);
    expect(set.decal).toMatchObject({
      minWidth: 128,
      maxWidth: 256,
      minHeight: 96,
      maxHeight: 192,
      depth: 32,
      shininess: 400,
      parallaxPasses: 4,
      flags: 0x72,
    });
    expect(set.decal?.color[0]).toBe(1);
    expect(set.decal?.color[1]).toBeCloseTo(128 / 255, 6);
  });

  it('has no decal without DODT', () => {
    expect(parseTextureSet({ fields: new Fields([]) }).decal).toBeUndefined();
  });
});

describe('placeDecal', () => {
  const decal = {
    minWidth: 100,
    maxWidth: 200,
    minHeight: 50,
    maxHeight: 100,
    depth: 16,
    shininess: 0,
    parallaxScale: 1,
    parallaxPasses: 4,
    flags: DecalFlag.alphaBlending,
    color: [1, 1, 1] as const,
  };

  it('sizes the box between min and max, the same for the same reference', () => {
    const a = placeDecal(decal, 0x1234, identity());
    const b = placeDecal(decal, 0x1234, identity());
    expect(Array.from(a.box)).toEqual(Array.from(b.box));
    const width = a.box[0] ?? 0;
    const height = a.box[10] ?? 0;
    expect(width).toBeGreaterThanOrEqual(100);
    expect(width).toBeLessThanOrEqual(200);
    // Width and height scale together.
    expect(height / width).toBeCloseTo(0.5, 6);
    // At least half the decal's size along the projection.
    expect(a.box[5]).toBeCloseTo(width / 2, 6);
  });

  it('picks one atlas quarter unless the texture has no subtextures', () => {
    const quarter = placeDecal(decal, 7, identity()).rect;
    expect(quarter[2]).toBe(0.5);
    expect(quarter[3]).toBe(0.5);
    expect(placeDecal({ ...decal, flags: DecalFlag.noSubtextures }, 7, identity()).rect).toEqual([
      0, 0, 1, 1,
    ]);
  });
});
