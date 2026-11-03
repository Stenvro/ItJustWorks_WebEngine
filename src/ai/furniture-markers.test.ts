import { describe, expect, it } from 'vitest';
import { markerRank } from './furniture-markers.ts';

describe('furniture markers', () => {
  const isExecutioner = 0x70c0a;
  const isExecutionerGuard = 0xeb60c;

  it("keeps a marker with a keyword to actors with it, who take it before the others'", () => {
    // The chopping block: the headsman's marker, the guard's, the prisoner's.
    const headsman = new Set([isExecutioner]);
    expect(markerRank(isExecutioner, headsman)).toBe(0);
    expect(markerRank(isExecutionerGuard, headsman)).toBeUndefined();
    expect(markerRank(undefined, headsman)).toBe(1);
    const prisoner = new Set<number>();
    expect(markerRank(isExecutioner, prisoner)).toBeUndefined();
    expect(markerRank(undefined, prisoner)).toBe(1);
    // No actor asked (an interaction location): every marker.
    expect(markerRank(isExecutioner, undefined)).toBe(1);
  });
});
