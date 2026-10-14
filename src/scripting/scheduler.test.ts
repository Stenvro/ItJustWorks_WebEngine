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
});
