import { describe, expect, it } from 'vitest';
import { PapyrusScheduler } from './scheduler.ts';

describe('PapyrusScheduler', () => {
  it('lets Wait wait out menus and WaitMenuMode count them', async () => {
    const scheduler = new PapyrusScheduler();
    const done: string[] = [];
    void scheduler.waitReal(1).then(() => done.push('wait'));
    void scheduler.waitWall(1).then(() => done.push('waitMenuMode'));
    // A second in a menu: only the wall clock moves.
    scheduler.advance(0, 0, 1);
    await Promise.resolve();
    expect(done).toEqual(['waitMenuMode']);
    expect(scheduler.realTime).toBe(0);
    expect(scheduler.wallTime).toBe(1);
    scheduler.advance(1, 0);
    await Promise.resolve();
    expect(done).toEqual(['waitMenuMode', 'wait']);
    expect(scheduler.wallTime).toBe(2);
  });

  it('lets long engine work give way once its slice is spent', async () => {
    let now = 0;
    const scheduler = new PapyrusScheduler(1.2, () => now);
    let yields = 0;
    scheduler.yieldTask = () => {
      yields++;
      return Promise.resolve();
    };
    // Within the slice: no yield, the same start.
    now = 3;
    expect(await scheduler.giveWay(0, 4)).toBe(0);
    expect(yields).toBe(0);
    // Past it: one yield, and a new slice from the time it goes on.
    now = 5;
    expect(await scheduler.giveWay(0, 4)).toBe(5);
    expect(yields).toBe(1);
  });
});
