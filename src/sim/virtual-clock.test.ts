import { describe, expect, it } from 'vitest';
import { VirtualClock } from './virtual-clock.ts';

describe('VirtualClock', () => {
  it('moves the page clock, the date and the timers only as the simulation steps', () => {
    const clock = new VirtualClock(7);
    clock.install();
    try {
      const page = performance.now();
      const date = Date.now();
      const fired: string[] = [];
      setTimeout(() => fired.push('late'), 500);
      setTimeout(() => fired.push('early'), 100);
      // Real time passing (work done) moves nothing.
      for (let i = 0; i < 1e5; i++) Math.sqrt(i);
      expect(performance.now()).toBe(page);
      expect(Date.now()).toBe(date);
      clock.advance(0.25);
      expect(performance.now() - page).toBe(250);
      expect(Date.now() - date).toBe(250);
      clock.runDue();
      expect(fired).toEqual(['early']);
      clock.advance(0.25);
      clock.runDue();
      expect(fired).toEqual(['early', 'late']);
    } finally {
      clock.restore();
    }
  });

  it('rolls the same dice from the same seed', () => {
    const roll = (seed: number): number[] => {
      const clock = new VirtualClock(seed);
      clock.install();
      try {
        return [Math.random(), Math.random(), Math.random()];
      } finally {
        clock.restore();
      }
    };
    expect(roll(7)).toEqual(roll(7));
    expect(roll(7)).not.toEqual(roll(8));
  });
});
