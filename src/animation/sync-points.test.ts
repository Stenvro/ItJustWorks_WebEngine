import { describe, expect, it } from 'vitest';
import { alignPhase, syncLayout } from './sync-points.ts';

const walk = [
  { name: 'syncleft', at: 0.25 },
  { name: 'syncright', at: 0.75 },
];
const run = [
  { name: 'syncleft', at: 0.5 },
  { name: 'syncright', at: 0.9 },
];

describe('sync points', () => {
  it('lays a cycle out at the weighted places of the sync points its children share', () => {
    const layout = syncLayout([
      { points: walk, weight: 0.75 },
      { points: run, weight: 0.25 },
    ]);
    expect(layout.map((point) => point.name)).toEqual(['syncleft', 'syncright']);
    expect(layout[0]?.at).toBeCloseTo(0.3125);
    expect(layout[1]?.at).toBeCloseTo(0.7875);
    // Round the cycle: 0.95 and 0.05 meet at 0, not at a half.
    const wrapped = syncLayout([
      { points: [{ name: 'syncleft', at: 0.95 }], weight: 1 },
      { points: [{ name: 'syncleft', at: 0.05 }], weight: 1 },
    ]);
    expect(Math.min(wrapped[0]?.at ?? 1, 1 - (wrapped[0]?.at ?? 1))).toBeCloseTo(0);
    // A child without sync points leaves the layout alone.
    expect(
      syncLayout([
        { points: walk, weight: 1 },
        { points: [], weight: 1 },
      ]),
    ).toEqual(walk);
  });

  it("puts each child at its own sync point as the cycle passes the layout's", () => {
    const layout = syncLayout([{ points: walk, weight: 1 }]);
    // The walk leads: it plays at the blender's phase.
    expect(alignPhase(0.4, layout, walk)).toBeCloseTo(0.4);
    // The run's left foot is down (0.5) as the cycle passes SyncLeft (0.25) ...
    expect(alignPhase(0.25, layout, run)).toBeCloseTo(0.5);
    // ... its right foot (0.9) at SyncRight (0.75), and halfway between, halfway between.
    expect(alignPhase(0.75, layout, run)).toBeCloseTo(0.9);
    expect(alignPhase(0.5, layout, run)).toBeCloseTo(0.7);
    // From SyncRight round to SyncLeft: 0.9 to 1.5 (0.5 of the next cycle).
    expect(alignPhase(0, layout, run)).toBeCloseTo(0.9 + 0.6 * (0.25 / 0.5) - 1);
    // One shared sync point shifts; none leaves the phase.
    expect(alignPhase(0.3, [{ name: 'syncleft', at: 0.25 }], run)).toBeCloseTo(0.55);
    expect(alignPhase(0.3, layout, [{ name: 'footleft', at: 0.1 }])).toBeCloseTo(0.3);
  });
});
