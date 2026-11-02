import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { identity } from '../render/math.ts';
import {
  DECAL_FADE_SECONDS,
  decalAlpha,
  decalGoneAt,
  DecalFlag,
  decalTooNear,
  squareDecal,
  ENVIRONMENT_BLOOD,
  environmentBloodWay,
  expireDecals,
  landSpaceOrigin,
  parseTextureSet,
  placeDecal,
  placedSize,
  savedDecalBox,
  struckNodeKey,
  subtextureRect,
} from './decal.ts';

describe('saved decals (the temp effects of an original save)', () => {
  it('build the box from the point, the rotation and the size: −Z the projection', () => {
    // A burn on Helgen's rubble as a save keeps it: the rotation takes Z to the saved direction.
    const box = savedDecalBox(
      [-153.74, -237.76, 45.46],
      [0.83745, 0.3398, 0.40968, -0.12401],
      [224.33, 224.33, 32],
    );
    const direction = [0.6019, -0.67074, 0.43339];
    for (let k = 0; k < 3; k++) {
      expect(-(box[4 + k] ?? 0) / 64).toBeCloseTo(direction[k] ?? 0, 3);
    }
    expect(Math.hypot(box[0] ?? 0, box[1] ?? 0, box[2] ?? 0)).toBeCloseTo(224.33, 2);
    expect(Math.hypot(box[8] ?? 0, box[9] ?? 0, box[10] ?? 0)).toBeCloseTo(224.33, 2);
    expect([box[12], box[13], box[14]].map((v) => Math.round((v ?? 0) * 100) / 100)).toEqual([
      -153.74, -237.76, 45.46,
    ]);
    // The width, height and projection are square to each other.
    const dot = (a: number, b: number): number =>
      (box[a] ?? 0) * (box[b] ?? 0) +
      (box[a + 1] ?? 0) * (box[b + 1] ?? 0) +
      (box[a + 2] ?? 0) * (box[b + 2] ?? 0);
    expect(dot(0, 4)).toBeCloseTo(0, 2);
    expect(dot(0, 8)).toBeCloseTo(0, 2);
    expect(dot(4, 8)).toBeCloseTo(0, 2);
  });

  it('show the quarter their subtexture names, or the whole texture', () => {
    expect(subtextureRect(3, 0)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(subtextureRect(1, 0)).toEqual([0.5, 0, 0.5, 0.5]);
    expect(subtextureRect(255, 0)).toEqual([0, 0, 1, 1]);
    expect(subtextureRect(2, DecalFlag.noSubtextures)).toEqual([0, 0, 1, 1]);
  });

  it("lie in a cell land's space: its centre, at the middle of its heights", () => {
    const heights = new Float32Array(33 * 33).fill(8224);
    heights[5] = 9440;
    heights[7] = 8088;
    expect(landSpaceOrigin(heights, 4, -20)).toEqual([18432, -79872, 8764]);
  });
});

describe('decalTooNear', () => {
  it('skips a decal within (its larger side + the old width) / 4 of one on its node', () => {
    const old = [{ point: [0, 0, 0] as const, width: 8 }];
    // A 16 × 24 decal: (24 + 8) / 4 = 8 units.
    const size = { width: 16, height: 24 };
    expect(decalTooNear([8, 0, 0], size, old)).toBe(true);
    expect(decalTooNear([0, 8.1, 0], size, old)).toBe(false);
    expect(decalTooNear([8, 0, 0], size, [])).toBe(false);
    // No spacing: never.
    expect(decalTooNear([0, 0, 0], size, old, 0)).toBe(false);
  });

  it("looks for an actor hit's blood along the blow lowered by half", () => {
    const way = environmentBloodWay([1, 0, 0]);
    expect(way[0]).toBeCloseTo(1 / Math.hypot(1, 0.5));
    expect(way[2]).toBeCloseTo(-0.5 / Math.hypot(1, 0.5));
    expect(ENVIRONMENT_BLOOD.reach).toBe(512);
  });

  it('keys a decal by the node holding the struck collision, the land by its cell', () => {
    const object = { reference: 0x1234, kind: 'object' };
    expect(struckNodeKey(object, 'Door01', [0, 0, 0])).toBe(
      struckNodeKey(object, 'door01', [9e3, 0, 0]),
    );
    expect(struckNodeKey(object, 'Frame', [0, 0, 0])).not.toBe(
      struckNodeKey(object, 'Door01', [0, 0, 0]),
    );
    const land = { reference: 0, kind: 'landscape' };
    expect(struckNodeKey(land, undefined, [100, 100, 0])).toBe('land:0,0');
    expect(struckNodeKey(land, undefined, [-1, 5000, 0])).toBe('land:-1,1');
  });

  it("reads a placed decal's width and height from its box", () => {
    const decal = {
      minWidth: 10,
      maxWidth: 10,
      minHeight: 20,
      maxHeight: 20,
      depth: 4,
      shininess: 0,
      parallaxScale: 0,
      parallaxPasses: 0,
      flags: 0,
      color: [1, 1, 1] as const,
    };
    expect(placedSize(placeDecal(decal, 1, identity()))).toEqual({ width: 10, height: 20 });
  });
});

describe('decal fade', () => {
  it('shows a decal whole for its lifetime, then fades it over one second', () => {
    const gone = decalGoneAt(10, 30);
    expect(gone).toBe(40 + DECAL_FADE_SECONDS);
    expect(decalAlpha(gone, 10)).toBe(1);
    expect(decalAlpha(gone, 40)).toBe(1);
    expect(decalAlpha(gone, 40.25)).toBeCloseTo(0.75);
    expect(decalAlpha(gone, 41)).toBe(0);
  });
});

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

  it('makes the environment blood square: its height drawn as its width', () => {
    const size = placedSize(placeDecal(squareDecal(decal), 0x77, identity()));
    expect(size.height).toBeCloseTo(size.width);
    expect(size.width).toBeGreaterThanOrEqual(100);
    expect(size.width).toBeLessThanOrEqual(200);
  });

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
