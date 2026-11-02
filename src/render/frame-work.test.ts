import { describe, expect, it } from 'vitest';
import {
  FRAME_WORK_BUDGET_MS,
  frameTurn,
  frameWorkFrameEnded,
  frameWorkWaiting,
  setFrameWorkRush,
} from './frame-work.ts';

/** Holds the thread for `ms` (a step of streaming work). */
function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Spinning.
  }
}

const tasks = (count: number): Promise<void> =>
  new Promise((resolve) => {
    let left = count;
    const next = (): void => {
      if (--left <= 0) resolve();
      else setTimeout(next, 0);
    };
    setTimeout(next, 0);
  });

describe('frameTurn', () => {
  it('gives turns at once without a render loop', async () => {
    let given = false;
    await frameTurn().then(() => {
      given = true;
    });
    expect(given).toBe(true);
  });

  it("gives a frame's share and holds the rest for the next frame", async () => {
    frameWorkFrameEnded();
    const done: number[] = [];
    const steps = [0, 1, 2, 3].map(async (i) => {
      await frameTurn();
      busy(FRAME_WORK_BUDGET_MS * 0.6);
      done.push(i);
    });
    await tasks(20);
    // Two steps spend the share (the second goes over it); the others wait.
    expect(done).toEqual([0, 1]);
    expect(frameWorkWaiting()).toBe(2);
    frameWorkFrameEnded();
    await tasks(20);
    expect(done).toEqual([0, 1, 2, 3]);
    await Promise.all(steps);
  });

  it('does not hold work back behind a loading screen', async () => {
    frameWorkFrameEnded();
    setFrameWorkRush(true);
    const done: number[] = [];
    const steps = [0, 1, 2, 3].map(async (i) => {
      await frameTurn();
      busy(FRAME_WORK_BUDGET_MS * 0.6);
      done.push(i);
    });
    await Promise.all(steps);
    expect(done).toEqual([0, 1, 2, 3]);
    setFrameWorkRush(false);
  });
});
