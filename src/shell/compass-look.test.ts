import { describe, expect, it } from 'vitest';
import { markerLook, MARKER_LOOK_DEFAULTS } from './compass-look.ts';

describe('markerLook', () => {
  const settings = { ...MARKER_LOOK_DEFAULTS, fadeStart: 10000 };

  it('shows a marker whole and largest at the player, least from the fade distance on', () => {
    expect(markerLook(0, false, settings)).toEqual({ alpha: 100, size: 130 });
    expect(markerLook(10000, false, settings)).toEqual({ alpha: 40, size: 90 });
    expect(markerLook(20000, false, settings)).toEqual({ alpha: 40, size: 90 });
  });

  it('eases by the squared distance', () => {
    // Half the way: a quarter of the squared distance, t = -0.75.
    const half = markerLook(5000, false, settings);
    expect(half.alpha).toBeCloseTo(40 + 60 * 0.75);
    expect(half.size).toBeCloseTo(90 + 40 * 0.75);
  });

  it("gives a quest's markers their own settings", () => {
    expect(markerLook(0, true, settings)).toEqual({ alpha: 100, size: 150 });
    expect(markerLook(12000, true, settings)).toEqual({ alpha: 90, size: 100 });
  });
});
