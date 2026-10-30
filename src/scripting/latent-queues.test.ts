import { describe, expect, it } from 'vitest';
import { LatentQueues, QUEUED_NATIVES } from './latent-queues.ts';
import { PapyrusScheduler } from './scheduler.ts';

/** Queues on a clock the test moves (milliseconds), with frames. */
function framed(): { queues: LatentQueues; clock: { now: number } } {
  const clock = { now: 0 };
  return {
    queues: new LatentQueues(
      () => true,
      () => clock.now,
    ),
    clock,
  };
}

describe('the latent natives’ queues', () => {
  it('names the queue of each native the original queues work for', () => {
    expect(QUEUED_NATIVES.get('spell.cast')).toEqual({ queue: 'renderSafe', latent: true });
    expect(QUEUED_NATIVES.get('objectreference.tethertohorse')?.queue).toBe('renderSafe');
    expect(QUEUED_NATIVES.get('objectreference.moveto')).toEqual({
      queue: 'postRender',
      latent: true,
    });
    expect(QUEUED_NATIVES.get('objectreference.disablenowait')).toEqual({
      queue: 'postRender',
      latent: false,
    });
    expect(QUEUED_NATIVES.size).toBe(31);
  });

  it('runs the work queued before a run, first come first served, and returns its result', async () => {
    const { queues } = framed();
    const done: string[] = [];
    const a = queues.queue('postRender', () => {
      done.push('a');
      return 1;
    });
    const b = queues.queue('postRender', () => {
      done.push('b');
      return 2;
    });
    expect(done).toEqual([]);
    queues.run('postRender', 100);
    expect(done).toEqual(['a', 'b']);
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(queues.waiting.postRender).toBe(0);
  });

  it('keeps the queues apart', () => {
    const { queues } = framed();
    const done: string[] = [];
    void queues.queue('renderSafe', () => done.push('cast'));
    void queues.queue('postRender', () => done.push('move'));
    queues.run('postRender', 100);
    expect(done).toEqual(['move']);
    queues.run('renderSafe', 100);
    expect(done).toEqual(['move', 'cast']);
  });

  it('runs at least one each run; what the budget leaves waits for the run after next', () => {
    const { queues, clock } = framed();
    const done: string[] = [];
    // Each piece of work takes 1 ms; the default budget is 0.05 of fUpdateBudgetMS (0.06 ms).
    const slow = (name: string) => () => {
      clock.now += 1;
      done.push(name);
    };
    void queues.queue('postRender', slow('a'));
    void queues.queue('postRender', slow('b'));
    queues.run('postRender');
    expect(done).toEqual(['a']);
    void queues.queue('postRender', slow('c'));
    // The next run takes what was queued since the last (c); b waits in the other list.
    queues.run('postRender');
    expect(done).toEqual(['a', 'c']);
    void queues.queue('postRender', slow('d'));
    queues.run('postRender');
    expect(done).toEqual(['a', 'c', 'b']);
    // d was left over in its turn: the run after next.
    queues.run('postRender');
    expect(done).toEqual(['a', 'c', 'b']);
    queues.run('postRender');
    expect(done).toEqual(['a', 'c', 'b', 'd']);
  });

  it('spends the budget given: 0.05 of fUpdateBudgetMS', () => {
    const { queues, clock } = framed();
    queues.configure(40);
    const done: number[] = [];
    for (let i = 0; i < 6; i++)
      void queues.queue('postRender', () => {
        clock.now += 0.5;
        done.push(i);
      });
    // 2 ms: the check follows each piece of 0.5 ms; the fifth ends past the budget.
    queues.run('postRender');
    expect(done).toEqual([0, 1, 2, 3, 4]);
  });

  it('does the work in the call without frames', async () => {
    const queues = new LatentQueues(
      () => false,
      () => 0,
    );
    expect(queues.waits).toBe(false);
    expect(await queues.queue('postRender', () => 'now')).toBe('now');
  });

  it('runs both queues as the scheduler’s frame begins', async () => {
    const scheduler = new PapyrusScheduler();
    scheduler.framed = true;
    const done: string[] = [];
    const moved = scheduler.latent.queue('postRender', () => done.push('moved'));
    const cast = scheduler.latent.queue('renderSafe', () => done.push('cast'));
    expect(scheduler.waiting.frame).toBe(2);
    scheduler.advance(1 / 60, 0);
    await Promise.all([moved, cast]);
    expect(done).toEqual(['moved', 'cast']);
  });
});
