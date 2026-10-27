import { describe, expect, it } from 'vitest';
import { lowStatTutorials, statIsLow } from './low-stat-tutorials.ts';

const full = { current: 100, max: 100 };
const low = { current: 10, max: 100 };

describe('low-stat tutorials', () => {
  it('counts a stat as low below a fifth of its maximum', () => {
    expect(statIsLow({ current: 19, max: 100 })).toBe(true);
    expect(statIsLow({ current: 20, max: 100 })).toBe(false);
    expect(statIsLow({ current: 0, max: 0 })).toBe(false);
  });

  it("shows each low stat's help message once", () => {
    const shown = new Set<string>();
    expect(lowStatTutorials({ health: full, magicka: full, stamina: full }, shown)).toEqual([]);
    expect(lowStatTutorials({ health: low, magicka: full, stamina: low }, shown)).toEqual([
      'HBLH',
      'HBLS',
    ]);
    shown.add('HBLH').add('HBLS');
    expect(lowStatTutorials({ health: low, magicka: low, stamina: low }, shown)).toEqual(['HBLM']);
  });

  it('shows none to the dead', () => {
    const dead = { current: 0, max: 100 };
    expect(lowStatTutorials({ health: dead, magicka: low, stamina: low }, new Set())).toEqual([]);
  });
});
