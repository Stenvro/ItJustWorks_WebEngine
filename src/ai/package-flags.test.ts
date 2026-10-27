// Package flags (PKDT) the runtime honours as it chooses and ends packages: Continue If PC Near,
// Skip Fallout Behavior, Maintain Speed At Goal (`node tools/package-census.ts --flag 200`).

import { describe, expect, it } from 'vitest';
import {
  condition,
  lasting,
  pack,
  packageActor,
  procedure,
  tick,
} from '../../tests/helpers/packages.ts';
import { PackageFlag } from './package-records.ts';
import type { ProcedureRunner } from './package-runtime.ts';

const done: ProcedureRunner = () => Promise.resolve('success');

describe('package flags', () => {
  it('Continue If PC Near keeps a package another would replace while the player is near', async () => {
    const at = { player: [100, 0, 0] as [number, number, number] };
    const { actor, truths } = packageActor(
      [
        pack(1, procedure('lasting'), { conditions: [condition(99)] }),
        pack(2, procedure('lasting'), { flags: PackageFlag.continueIfPcNear }),
      ],
      { lasting },
      { mind: { livePosition: () => at.player } },
    );
    await tick(actor);
    expect(actor.current?.id).toBe(2);
    truths.add(99);
    actor.evaluate();
    await tick(actor);
    expect(actor.current?.id).toBe(2);
    at.player = [5000, 0, 0];
    actor.evaluate();
    await tick(actor);
    expect(actor.current?.id).toBe(1);
  });

  it('a package that ended falls out to a sandbox where the actor stands, unless Skip Fallout Behavior', async () => {
    const run = async (flags: number): Promise<number[]> => {
      const radii: number[] = [];
      const sandbox: ProcedureRunner = async (procedureRun) => {
        const location = procedureRun.inputs.location(0);
        if (location) radii.push(location.radius);
        while (!procedureRun.stopped()) await procedureRun.wait(1);
        return 'failure';
      };
      const { actor } = packageActor([pack(1, procedure('done'), { flags })], { done, sandbox });
      for (let i = 0; i < 3; i++) await tick(actor, 1);
      return radii;
    };
    expect(await run(0)).toEqual([256]);
    expect(await run(PackageFlag.skipFalloutBehavior)).toEqual([]);
  });

  it('a save keeps the fallout: after the load the actor sandboxes again where it stands', async () => {
    let sandboxes = 0;
    const sandbox: ProcedureRunner = async (procedureRun) => {
      sandboxes++;
      while (!procedureRun.stopped()) await procedureRun.wait(1);
      return 'failure';
    };
    const { actor } = packageActor([pack(1, procedure('done'))], { done, sandbox });
    for (let i = 0; i < 3; i++) await tick(actor, 1);
    const saved = actor.saveState();
    expect(saved).toMatchObject({ id: 1, completed: true, ended: true, fallout: true });
    expect(sandboxes).toBe(1);
    // Loaded: the package is taken up done, its fallout running again (no begin, no new tree).
    const loaded = packageActor([pack(1, procedure('done'))], { done, sandbox });
    if (saved) loaded.actor.resume(saved);
    for (let i = 0; i < 3; i++) await tick(loaded.actor, 1);
    expect(sandboxes).toBe(2);
    expect(loaded.events.filter((event) => event.startsWith('begin'))).toEqual([]);
    expect(loaded.actor.saveState()?.fallout).toBe(true);
  });

  it('Maintain Speed At Goal does not stop the actor as its package ends', async () => {
    const stops = async (flags: number): Promise<number> => {
      let count = 0;
      const { actor } = packageActor(
        [pack(1, procedure('done'), { flags: flags | PackageFlag.skipFalloutBehavior })],
        { done },
        {
          body: {
            stop: () => {
              count++;
            },
          },
        },
      );
      await tick(actor, 1);
      const before = count;
      for (let i = 0; i < 3; i++) await tick(actor, 1);
      return count - before;
    };
    expect(await stops(0)).toBeGreaterThan(0);
    expect(await stops(PackageFlag.maintainSpeedAtGoal)).toBe(0);
  });
});
