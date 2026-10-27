// The engine's own packages (src/ai/engine-packages.ts): Avoid Player in front of the actor's
// package, its start's test, its spot away from the player.

import { describe, expect, it } from 'vitest';
import { pack, packageActor, procedure, tick } from '../../tests/helpers/packages.ts';
import { avoidPlayer, avoidsPlayer, awayFrom } from './engine-packages.ts';
import type { ProcedureRunner } from './package-runtime.ts';

describe('engine packages', () => {
  it('Avoid Player starts within fTriggerAvoidPlayerDistance, for one that sees them, out of combat', () => {
    expect(avoidsPlayer(300, true, false, 400)).toBe(true);
    expect(avoidsPlayer(450, true, false, 400)).toBe(false);
    expect(avoidsPlayer(300, false, false, 400)).toBe(false);
    expect(avoidsPlayer(300, true, true, 400)).toBe(false);
  });

  it('goes to the player’s far side', () => {
    const [x, y] = awayFrom([50, 0, 0], [0, 0, 0], 200);
    expect(x).toBeCloseTo(200, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('sets the package aside while the player is near, then its package runs again', async () => {
    let starts = 0;
    const lasting: ProcedureRunner = async (run) => {
      starts++;
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    const at: { here: [number, number, number] } = { here: [50, 0, 0] };
    const travels: [number, number, number][] = [];
    const { actor, events } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [0, 0, 0] },
        body: {
          position: () => at.here,
          travel: (to) => {
            travels.push([to[0], to[1], to[2]]);
            at.here = [to[0], to[1], to[2]];
            return Promise.resolve(true);
          },
        },
      },
    );
    await tick(actor, 1);
    expect(starts).toBe(1);
    expect(actor.push('avoidPlayer', avoidPlayer)).toBe(true);
    // One at a time.
    expect(actor.push('avoidPlayer', avoidPlayer)).toBe(false);
    expect(actor.engine()).toBe('avoidPlayer');
    for (let i = 0; i < 12; i++) await tick(actor, 0.25);
    expect(travels[0]?.[0]).toBeCloseTo(200, 6);
    expect(actor.engine()).toBeUndefined();
    await tick(actor, 0.25);
    expect(starts).toBe(2);
    // Its own package was set aside, not left: no package events.
    expect(events.filter((event) => !event.startsWith('begin'))).toEqual([]);
  });
});
