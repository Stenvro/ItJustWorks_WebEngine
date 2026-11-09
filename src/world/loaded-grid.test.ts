import { describe, expect, it } from 'vitest';
import { GRIDS_TO_LOAD, loadedGridRadius } from './loaded-grid.ts';

describe('the loaded grid (uGridsToLoad)', () => {
  it('loads two cells on each side by default (5 × 5)', () => {
    expect(GRIDS_TO_LOAD).toBe(5);
    expect(loadedGridRadius(undefined)).toBe(2);
    expect(loadedGridRadius(5)).toBe(2);
  });

  it('follows the INI: 3 loads one on each side, 7 three, 11 five', () => {
    expect(loadedGridRadius(3)).toBe(1);
    expect(loadedGridRadius(7)).toBe(3);
    expect(loadedGridRadius(11)).toBe(5);
  });

  it('centres an even count on the player’s cell as the odd one above it, at least one', () => {
    expect(loadedGridRadius(6)).toBe(3);
    expect(loadedGridRadius(4)).toBe(2);
    expect(loadedGridRadius(1)).toBe(1);
    expect(loadedGridRadius(Number.NaN)).toBe(2);
  });
});
