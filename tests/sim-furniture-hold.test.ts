// A script's idle held for an actor in furniture until its graphs take it (holdIdle, src/shell/
// actor-furniture.ts: the ActorFurniture's #backIn; docs/ai.md, "Furniture and idle markers").

import { describe, expect, it } from 'vitest';
import { holdIdle } from '../src/shell/actor-furniture.ts';

/** A hold whose waits pass at once, counted (each one HOLD_POLL_SECONDS: 0.1 s). */
function counted(): { waits: number; readonly wait: () => Promise<void> } {
  const counter = {
    waits: 0,
    wait: (): Promise<void> => {
      counter.waits++;
      return Promise.resolve();
    },
  };
  return counter;
}

describe('a script idle held in furniture', () => {
  it('goes as soon as the graphs would take it', async () => {
    const clock = counted();
    let asked = 0;
    const held = await holdIdle({
      takes: () => ++asked > 3,
      using: () => true,
      latest: () => true,
      seconds: 4,
      wait: clock.wait,
    });
    expect(held).toBe('taken');
    expect(clock.waits).toBe(3);
  });

  it('gives up after its seconds when the graphs never take it', async () => {
    // Found in review 2026-11-09: a held idle waited for its graph with no end but the 4 s, and
    // nothing said how it ended; never taken, it is let go after them (and sent: the graphs
    // decide), not held on.
    const clock = counted();
    const held = await holdIdle({
      takes: () => false,
      using: () => true,
      latest: () => true,
      seconds: 4,
      wait: clock.wait,
    });
    expect(held).toBe('timeout');
    expect(clock.waits).toBe(40);
  });

  it('gives way to a later idle for the actor, which it must not follow', async () => {
    // Found in review 2026-11-09: a held idle was sent whenever its graph took it, after a later
    // PlayIdle had played: the two played out of order, the earlier one seconds late.
    const clock = counted();
    let later = false;
    const held = await holdIdle({
      takes: () => clock.waits >= 10,
      using: () => true,
      latest: () => !later,
      seconds: 4,
      wait: () => {
        if (clock.waits === 5) later = true;
        return clock.wait();
      },
    });
    expect(held).toBe('superseded');
    expect(clock.waits).toBe(6);
  });

  it('ends with the actor’s use of its furniture', async () => {
    const clock = counted();
    const held = await holdIdle({
      takes: () => false,
      using: () => clock.waits < 2,
      latest: () => true,
      seconds: 4,
      wait: clock.wait,
    });
    expect(held).toBe('ended');
    expect(clock.waits).toBe(2);
  });
});
