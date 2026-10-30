import { describe, expect, it } from 'vitest';
import { lowStatTutorials, statIsLow } from './low-stat-tutorials.ts';

const full = { current: 100, max: 100 };
const low = { current: 10, max: 100 };

describe('low-stat tutorials', () => {
  it('counts a stat as low below a quarter of its maximum (the settings’ default)', () => {
    expect(statIsLow({ current: 24, max: 100 })).toBe(true);
    expect(statIsLow({ current: 25, max: 100 })).toBe(false);
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

  it('takes each stat’s share from its game setting', () => {
    const third = { current: 30, max: 100 };
    const share = (stat: string): number => (stat === 'stamina' ? 0.5 : 0.25);
    expect(
      lowStatTutorials({ health: third, magicka: third, stamina: third }, new Set(), share),
    ).toEqual(['HBLS']);
  });

  it('shows the health tutorial only to the living, the others still', () => {
    const dead = { current: 0, max: 100 };
    expect(lowStatTutorials({ health: dead, magicka: low, stamina: full }, new Set())).toEqual([
      'HBLM',
    ]);
  });
});
