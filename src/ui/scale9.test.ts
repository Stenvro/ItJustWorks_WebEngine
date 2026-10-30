import { describe, expect, it } from 'vitest';
import { readPlacement } from '../formats/swf/place-object.ts';
import { readSwf, swfExports, SwfTagCode, tagBody, type SwfMovie } from '../formats/swf/swf.ts';
import { concatBytes, encodeTag, writeSwf } from '../formats/swf/swf-writer.ts';
import { patchScalingGrids, scale9Axis, type Scale9Cell } from './scale9.ts';

/** A RECT of 12-bit fields: left, right, top, bottom in twips. */
function rect(values: readonly number[]): Uint8Array {
  const bits = [0, 1, 1, 0, 0];
  for (const value of values) {
    for (let i = 11; i >= 0; i--)
      bits.push(Math.floor((value < 0 ? 4096 + value : value) / 2 ** i) % 2);
  }
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    out[i] = bits.slice(i * 8, i * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0);
  }
  return out;
}

/** A shape (1) in a sprite (2) with a grid of 10..90 pixels, placed on the stage. */
function gridMovie(grid: boolean): Uint8Array {
  const placeShape = encodeTag(SwfTagCode.placeObject2, Uint8Array.of(0x02, 1, 0, 1, 0));
  const frame = encodeTag(SwfTagCode.showFrame, new Uint8Array(0));
  const end = encodeTag(SwfTagCode.end, new Uint8Array(0));
  return writeSwf([
    { code: SwfTagCode.defineShape, body: Uint8Array.of(1, 0, 0, 0, 0, 0, 0) },
    {
      code: SwfTagCode.defineSprite,
      body: concatBytes([Uint8Array.of(2, 0, 1, 0), placeShape, frame, end]),
    },
    ...(grid
      ? [{ code: 78, body: concatBytes([Uint8Array.of(2, 0), rect([200, 1800, 200, 1800])]) }]
      : []),
    { code: SwfTagCode.placeObject2, body: Uint8Array.of(0x02, 1, 0, 2, 0) },
    { code: SwfTagCode.showFrame, body: new Uint8Array(0) },
  ]);
}

function sprite(movie: SwfMovie, id: number) {
  const tag = movie.tags.find(
    (t) => t.code === SwfTagCode.defineSprite && tagBody(movie, t)[0] === id,
  );
  if (!tag?.children) throw new Error(`no sprite ${String(id)}`);
  return tag.children;
}

describe('scaling grids', () => {
  it('leaves a movie without grids alone', () => {
    expect(patchScalingGrids(gridMovie(false))).toBeUndefined();
  });

  it('wraps the shapes under a grid sprite and registers it', () => {
    const out = patchScalingGrids(gridMovie(true));
    if (!out) throw new Error('not patched');
    const movie = readSwf(out);
    expect(movie.tags.some((tag) => tag.code === 78)).toBe(false);
    // The grid sprite: its registration first, its shape placed as a wrapper.
    const children = sprite(movie, 2);
    expect(children[0]?.code).toBe(SwfTagCode.doAction);
    const placed = children.find((tag) => tag.code === SwfTagCode.placeObject2);
    const wrapper = placed && readPlacement(tagBody(movie, placed), placed.code).character;
    expect(wrapper).toBeGreaterThan(2);
    // The wrapper: its registration and the shape's clip "o".
    const inner = sprite(movie, wrapper ?? 0);
    expect(inner[0]?.code).toBe(SwfTagCode.doAction);
    const clip = inner.find((tag) => tag.code === SwfTagCode.placeObject2);
    expect(clip && readPlacement(tagBody(movie, clip), clip.code).name).toBe('o');
    // The shape's piece, exported to attach.
    expect(swfExports(movie).map((symbol) => symbol.name)).toEqual(['__itjwScale9Piece1']);
  });
});

describe("a scaling grid's axis", () => {
  /** Where a point lands: by the cell it falls in. */
  const map = (cells: readonly Scale9Cell[], x: number): number => {
    const cell = cells.find((c) => x >= c.from && x <= c.to) ?? cells[0];
    return cell ? cell.scale * x + cell.offset : Number.NaN;
  };

  it('keeps the parts before and after the grid at their size on the stage', () => {
    // 0..100 with its grid at 10..90, twice as wide on the stage.
    const cells = scale9Axis(0, 100, 10, 90, 2);
    expect(map(cells, 10) * 2).toBeCloseTo(10);
    expect((100 - map(cells, 90)) * 2).toBeCloseTo(10);
    expect(map(cells, 100)).toBeCloseTo(100);
  });

  it('shrinks the corners together, the middle to nothing, below their size', () => {
    // A quarter of its size: 25 on the stage, less than the corners' 20 + 20.
    const cells = scale9Axis(0, 100, 20, 80, 0.25);
    expect(map(cells, 20)).toBeCloseTo(map(cells, 80));
    expect(map(cells, 20) * 0.25).toBeCloseTo(12.5);
    expect(map(cells, 100)).toBeCloseTo(100);
    expect(cells[1].scale).toBe(0);
  });
});
