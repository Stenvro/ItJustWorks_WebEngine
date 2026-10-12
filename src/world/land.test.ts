import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { decodeHeights, LAND_GRID, parseLand, QUADRANT_GRID, type LandRecord } from './land.ts';

const POINTS = LAND_GRID * LAND_GRID;

function vhgt(offset: number, deltas: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(4 + POINTS + 3);
  const view = new DataView(data.buffer);
  view.setFloat32(0, offset, true);
  for (let y = 0; y < LAND_GRID; y++) {
    for (let x = 0; x < LAND_GRID; x++) view.setInt8(4 + y * LAND_GRID + x, deltas(x, y));
  }
  return data;
}

function record(fields: [string, Uint8Array][]): LandRecord {
  return {
    fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
    formIdAt: (data, offset) =>
      new DataView(data.buffer, data.byteOffset).getUint32(offset ?? 0, true),
  };
}

function textureField(formId: number, quadrant: number, layer?: number): Uint8Array {
  const data = new Uint8Array(8); // BTXT and ATXT are both 8 bytes
  const view = new DataView(data.buffer);
  view.setUint32(0, formId, true);
  data[4] = quadrant;
  if (layer !== undefined) view.setUint16(6, layer, true);
  return data;
}

function vtxt(entries: [position: number, opacity: number][]): Uint8Array {
  const data = new Uint8Array(entries.length * 8);
  const view = new DataView(data.buffer);
  entries.forEach(([position, opacity], i) => {
    view.setUint16(i * 8, position, true);
    view.setFloat32(i * 8 + 4, opacity, true);
  });
  return data;
}

describe('decodeHeights', () => {
  it('scales the offset by 8', () => {
    const heights = decodeHeights(vhgt(10, () => 0));
    expect(heights[0]).toBe(80);
    expect(heights[POINTS - 1]).toBe(80);
  });

  it('accumulates along each row', () => {
    const heights = decodeHeights(vhgt(0, (x) => (x > 0 ? 1 : 0)));
    expect(heights[1]).toBe(8);
    expect(heights[LAND_GRID - 1]).toBe((LAND_GRID - 1) * 8);
    // A new row starts from the first point of the previous row, not its last.
    expect(heights[LAND_GRID]).toBe(0);
    expect(heights[LAND_GRID + 2]).toBe(16);
  });

  it('accumulates down the first column', () => {
    const heights = decodeHeights(vhgt(0, (x) => (x === 0 ? -1 : 0)));
    expect(heights[0]).toBe(-8);
    expect(heights[LAND_GRID]).toBe(-16);
    expect(heights[LAND_GRID + 5]).toBe(-16);
    expect(heights[(LAND_GRID - 1) * LAND_GRID]).toBe(-8 * LAND_GRID);
  });

  it('returns a flat grid for a truncated field', () => {
    expect(decodeHeights(new Uint8Array(10)).every((h) => h === 0)).toBe(true);
  });
});

describe('parseLand', () => {
  it('reads base textures and layers per quadrant, layers sorted by their index', () => {
    const land = parseLand(
      record([
        ['VHGT', vhgt(0, () => 0)],
        ['BTXT', textureField(0x100, 1)],
        ['ATXT', textureField(0x201, 1, 1)],
        ['VTXT', vtxt([[QUADRANT_GRID + 2, 0.5]])],
        ['ATXT', textureField(0x200, 1, 0)],
        ['VTXT', vtxt([[0, 1]])],
        ['BTXT', textureField(0, 3)],
      ]),
    );
    expect(land.quadrants[0]).toEqual({ base: undefined, layers: [] });
    const quadrant = land.quadrants[1];
    expect(quadrant?.base).toBe(0x100);
    expect(quadrant?.layers.map((l) => l.texture)).toEqual([0x200, 0x201]);
    expect(quadrant?.layers[0]?.alpha[0]).toBe(1);
    expect(quadrant?.layers[1]?.alpha[QUADRANT_GRID + 2]).toBe(0.5);
    // BTXT with LTEX 0: the engine's default texture.
    expect(land.quadrants[3]?.base).toBeUndefined();
  });

  it('normalizes signed byte normals and keeps vertex colours', () => {
    const vnml = new Uint8Array(POINTS * 3);
    vnml.set([0, 0, 127]);
    vnml.set([0x81, 0, 0], 3); // −127
    const vclr = new Uint8Array(POINTS * 3).fill(200);
    const land = parseLand(
      record([
        ['VNML', vnml],
        ['VCLR', vclr],
      ]),
    );
    expect(Array.from(land.normals?.subarray(0, 6) ?? [])).toEqual([0, 0, 1, -1, 0, 0]);
    expect(land.colors?.[0]).toBe(200);
    expect(land.heights.every((h) => h === 0)).toBe(true);
  });

  it('ignores opacity entries outside the quadrant', () => {
    const land = parseLand(
      record([
        ['ATXT', textureField(0x200, 0, 0)],
        ['VTXT', vtxt([[QUADRANT_GRID * QUADRANT_GRID, 1]])],
      ]),
    );
    expect(land.quadrants[0]?.layers[0]?.alpha.every((a) => a === 0)).toBe(true);
  });
});
