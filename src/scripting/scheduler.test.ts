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

  it("gives threads the update's share of fUpdateBudgetMS and fExtraTaskletBudgetMS", () => {
    const scheduler = new PapyrusScheduler();
    scheduler.configure(2, 1);
    expect(scheduler.mainThreadMs).toBeCloseTo(1.8);
    expect(scheduler.budgetMs).toBeCloseTo(2.8);
  });

  it("begins the calls handed to the main thread in order while the update's share lasts", async () => {
    let now = 0;
    const scheduler = new PapyrusScheduler(2, () => now);
    scheduler.framed = true;
    scheduler.mainThreadMs = 1;
    const begun: string[] = [];
    // Each call takes 0.6 ms to begin: two fit in a frame's 1 ms share, the third waits.
    const call = async (name: string): Promise<void> => {
      const ticket = await scheduler.mainThread();
      begun.push(name);
      now += 0.6;
      scheduler.mainThreadBegun(ticket);
    };
    const calls = Promise.all(['a', 'b', 'c'].map(call));
    await Promise.resolve();
    expect(begun).toEqual([]);
    scheduler.advance(1 / 60, 0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(begun).toEqual(['a', 'b']);
    expect(scheduler.waiting.frame).toBe(1);
    scheduler.advance(1 / 60, 0);
    await calls;
    expect(begun).toEqual(['a', 'b', 'c']);
  });

  it('runs the VM on its own for fPostLoadUpdateTimeMS after a load', async () => {
    let now = 0;
    const scheduler = new PapyrusScheduler(1, () => now);
    scheduler.framed = true;
    scheduler.postLoad(500);
    now = 400;
    // Within the window: no budget, and frame waits and handed calls go on at once.
    expect(scheduler.overBudget).toBe(false);
    expect(await scheduler.mainThread()).toBe(-1);
    await scheduler.nextFrame();
    now = 501;
    expect(scheduler.overBudget).toBe(true);
    let waited = false;
    void scheduler.nextFrame().then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
  });
});
