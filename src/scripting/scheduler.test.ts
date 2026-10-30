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
    expect(scheduler.budgetMs).toBeCloseTo(2.8);
  });

  it('begins the calls handed to the main thread in the next frame, in their order', async () => {
    const scheduler = new PapyrusScheduler();
    scheduler.framed = true;
    const begun: string[] = [];
    const calls = Promise.all(
      ['a', 'b', 'c'].map(async (name) => {
        (await scheduler.suspend())(0);
        begun.push(name);
      }),
    );
    await Promise.resolve();
    expect(begun).toEqual([]);
    expect(scheduler.waiting.frame).toBe(3);
    scheduler.advance(1 / 60, 0);
    await calls;
    expect(begun).toEqual(['a', 'b', 'c']);
  });

  it('resumes a wait with nothing left to wait for (Wait(0)) later, never at once', async () => {
    let now = 0;
    const scheduler = new PapyrusScheduler(1, () => now);
    let yields = 0;
    scheduler.yieldTask = () => {
      yields++;
      return Promise.resolve();
    };
    // Before frames come (a game loading) and while the VM runs on its own after a load: the
    // host's next task.
    await scheduler.waitUntil(scheduler.clockWait('real', 0));
    expect(yields).toBe(1);
    scheduler.framed = true;
    scheduler.postLoad(500);
    await scheduler.waitUntil(scheduler.clockWait('real', 0));
    expect(yields).toBe(2);
    // With frames: the next frame.
    now = 501;
    let waited = false;
    void scheduler.waitUntil(scheduler.clockWait('real', 0)).then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
    expect(scheduler.waiting.frame).toBe(1);
    scheduler.advance(1 / 60, 0);
    await Promise.resolve();
    expect(waited).toBe(true);
    expect(yields).toBe(2);
  });

  it('runs the VM on its own for fPostLoadUpdateTimeMS after a load', async () => {
    let now = 0;
    const scheduler = new PapyrusScheduler(1, () => now);
    scheduler.framed = true;
    scheduler.postLoad(500);
    now = 400;
    // Within the window: no budget, and frame waits and handed calls go on at once.
    expect(scheduler.overBudget).toBe(false);
    await scheduler.suspend();
    await scheduler.nextFrame();
    now = 501;
    expect(scheduler.overBudget).toBe(true);
    let waited = false;
    void scheduler.nextFrame().then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
  });

  /** Suspends threads named by numbers; resolves with the order their turns came. */
  const suspendAll = (scheduler: PapyrusScheduler, count: number, cost = 0): number[] => {
    const order: number[] = [];
    for (let i = 0; i < count; i++) {
      void scheduler.suspend().then((turn) => {
        order.push(i);
        turn(cost);
      });
    }
    return order;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 1000; i++) await Promise.resolve();
  };

  it('resumes the suspended threads in order, the overflow too while overstressed', async () => {
    const scheduler = new PapyrusScheduler();
    scheduler.framed = true;
    const order = suspendAll(scheduler, 130);
    // Over 100 suspended at the update: overstressed, so the overflow behind the fixed queue's
    // 128 goes oldest first too.
    scheduler.advance(1 / 60, 0);
    await settle();
    expect(scheduler.overstressed).toBe(true);
    expect(order).toEqual([...Array(130).keys()]);
    // The next update counts none: calm again.
    scheduler.advance(1 / 60, 0);
    expect(scheduler.overstressed).toBe(false);
    expect(scheduler.memory.ignoreLimit).toBe(false);
  });

  it("resumes them while the update's share of fUpdateBudgetMS lasts, the rest later", async () => {
    const scheduler = new PapyrusScheduler();
    scheduler.framed = true;
    scheduler.configure(1, 1);
    // Each turn takes 0.4 ms of the 0.9 ms share: three fit (the third passes it).
    const order = suspendAll(scheduler, 5, 0.4);
    scheduler.advance(1 / 60, 0);
    await settle();
    expect(order).toEqual([0, 1, 2]);
    // The ones left wait for the update after next (the queues swap at each update).
    scheduler.advance(1 / 60, 0);
    await settle();
    expect(order).toEqual([0, 1, 2]);
    scheduler.advance(1 / 60, 0);
    await settle();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('resumes all of the fixed queue regardless of the budget while overstressed', async () => {
    const scheduler = new PapyrusScheduler();
    scheduler.framed = true;
    scheduler.configure(1, 1);
    const order = suspendAll(scheduler, 101, 1);
    scheduler.advance(1 / 60, 0);
    await settle();
    expect(scheduler.overstressed).toBe(true);
    expect(scheduler.memory.ignoreLimit).toBe(true);
    expect(order).toHaveLength(101);
  });
});
