import { describe, expect, it } from 'vitest';
import { ImpactPlacements } from './impact-placement.ts';

// MAGDragonFireImpact01's: 0.7 s, 200 units.
const DRAGON_FIRE = { formId: 1, placementRadius: 200, duration: 0.7 };

describe('ImpactPlacements', () => {
  it('keeps an impact off within its placement radius of one still showing', () => {
    const placements = new ImpactPlacements();
    expect(placements.place(DRAGON_FIRE, [0, 0, 0], 0)).toBe(true);
    // A breath's next spray, 0.1 s later and 60 units on: only its sound.
    expect(placements.place(DRAGON_FIRE, [60, 0, 0], 0.1)).toBe(false);
    // Beyond the radius, or once the first is gone, it is placed.
    expect(placements.place(DRAGON_FIRE, [250, 0, 0], 0.2)).toBe(true);
    expect(placements.place(DRAGON_FIRE, [10, 0, 0], 0.8)).toBe(true);
  });

  it('lets other impacts lie anywhere', () => {
    const placements = new ImpactPlacements();
    placements.place(DRAGON_FIRE, [0, 0, 0], 0);
    expect(placements.place({ ...DRAGON_FIRE, formId: 2 }, [0, 0, 0], 0)).toBe(true);
  });
});
