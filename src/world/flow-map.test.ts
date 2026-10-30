import { describe, expect, it } from 'vitest';
import { FLOW_TEXELS_PER_CELL, flowCompositeAt, flowTaps } from './flow-map.ts';

describe('the rivers flow normals taps', () => {
  it('weighs the four staggered taps by tents that sum to one', () => {
    for (const [u, v] of [
      [0.1234, 0.987],
      [0.5, 0.25],
      [0.0001, 0.999],
    ] as const) {
      const taps = flowTaps(u, v);
      expect(taps.length).toBe(4);
      expect(taps.reduce((sum, tap) => sum + tap.weight, 0)).toBeCloseTo(1, 6);
    }
  });

  it('reads the unstaggered tap alone at a texel centre and the staggered one at its edge', () => {
    const centre = (0.5 + 10) / FLOW_TEXELS_PER_CELL;
    const [at] = flowTaps(centre, centre);
    expect(at?.weight).toBeCloseTo(1, 6);
    const edge = 10 / FLOW_TEXELS_PER_CELL;
    const taps = flowTaps(edge, edge);
    expect(taps[3]?.weight).toBeCloseTo(1, 6);
    expect(taps[3]?.u).toBeCloseTo(edge + 0.5 / FLOW_TEXELS_PER_CELL, 9);
    // The rates and offsets the flow normals move by.
    expect(taps.map((tap) => [tap.rate, tap.offset])).toEqual([
      [8, 0],
      [8.48, 0.62],
      [10.64, 0.27],
      [9.92, 0],
    ]);
  });

  it('places a cell in the composite of the loaded grid by its column and its row from the south', () => {
    // uGridsToLoad 5: the south-west cell's north-west corner, the north-east cell's south-east.
    expect(flowCompositeAt(0, 0, 0, 0, 5)).toEqual([0, 0.8]);
    expect(flowCompositeAt(1, 1, 4, 4, 5)).toEqual([1, 0.2]);
    // Neighbours meet: the east edge of one column is the west edge of the next.
    expect(flowCompositeAt(1, 0.5, 1, 2, 5)[0]).toBeCloseTo(flowCompositeAt(0, 0.5, 2, 2, 5)[0], 9);
  });
});
