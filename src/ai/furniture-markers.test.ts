import { describe, expect, it } from 'vitest';
import { ENTER_GRACE, enterStep, markerRank } from './furniture-markers.ts';

describe('entering furniture: the graph says when (ChairEnterHandler, BedEnterHandler)', () => {
  it('moves by its enter while the root motion plays', () => {
    expect(enterStep(0.8)).toBe('moving');
  });

  it('waits at its marker for the graph once the root motion has played, not in yet', () => {
    expect(enterStep(0)).toBe('waiting');
    expect(enterStep(-ENTER_GRACE / 2)).toBe('waiting');
  });

  it('is in without the graph’s word only ENTER_GRACE after (inferred)', () => {
    expect(ENTER_GRACE).toBe(1.5);
    expect(enterStep(-ENTER_GRACE)).toBe('in');
  });
});

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
