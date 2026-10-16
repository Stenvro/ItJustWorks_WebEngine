import { describe, expect, it } from 'vitest';
import { ObjectType } from './object-types.ts';
import {
  LocationType,
  TargetType,
  type PackageInput,
  type PackageRecord,
  type ProcedureBranch,
} from './package-records.ts';
import type { PackageBody, PackageMind, ProcedureRun } from './package-runtime.ts';
import { PROCEDURES } from './procedure-runs.ts';
import { ProcedureInputs } from './procedures.ts';

const branch = (name: string, inputs: number[]): ProcedureBranch => ({
  type: 'Procedure',
  conditions: [],
  branchFlags: 0,
  procedure: name,
  flags: 0,
  inputs,
  flagOverride: undefined,
  children: [],
});

const NEAR_HOME: PackageInput = {
  id: 0,
  type: 'Location',
  value: {
    kind: 'location',
    location: { type: LocationType.nearReference, form: 0x500, radius: 600 },
  },
};
const BEDS: PackageInput = {
  id: 1,
  type: 'TargetSelector',
  value: {
    kind: 'targetSelector',
    target: { type: TargetType.objectType, value: ObjectType.beds, count: 0 },
  },
};
const FOUND_BED: PackageInput = {
  id: 2,
  type: 'ObjectList',
  value: { kind: 'objectList', value: 0 },
};
const STEAL: PackageInput = { id: 3, type: 'Bool', value: { kind: 'bool', value: false } };

/**
 * A run of a procedure with fakes that record what it does; its object lists shared. With
 * `waits`, its waits are recorded too, and it is stopped after that many.
 */
function harness(found = new Map<number, readonly number[]>(), waits?: number) {
  const done: string[] = [];
  let stopped = false;
  let waited = 0;
  const body = {
    reference: 1,
    position: () => [0, 0, 0],
    heading: () => 0,
    travel: () => Promise.resolve(true),
    stop: () => undefined,
    face: () => undefined,
    useFurniture: (furniture: number) => {
      done.push(`use ${furniture.toString(16)}`);
      // The first bed is taken; the second is free.
      if (furniture === 0x601) return Promise.resolve(false);
      stopped = true;
      return Promise.resolve(true);
    },
    leaveFurniture: () => Promise.resolve(),
    takeIdleMarker: () => true,
    leaveIdleMarker: () => undefined,
    playIdle: () => Promise.resolve(true),
    say: (topic: number | string) => {
      done.push(`say ${String(topic)}`);
    },
    standing: () => true,
    activate: () => Promise.resolve(true),
    take: () => Promise.resolve(true),
    useItem: (item: number, consume: boolean) => {
      done.push(`eat ${item.toString(16)}${consume ? ' carried' : ''}`);
      return Promise.resolve(true);
    },
    greet: () => true,
  } satisfies PackageBody;
  const mind = {
    placement: () => Promise.resolve({ position: [0, 0, 0] as const, heading: 0 }),
    place: (location: { radius: number }) =>
      Promise.resolve({
        position: [100, 0, 0] as const,
        radius: location.radius,
        reference: 0x500,
      }),
    target: () => Promise.resolve(undefined),
    search: (
      criteria: { value: number },
      place: { radius: number },
      _actor: number,
      steal: boolean,
    ) => {
      done.push(`search ${String(criteria.value)} r${String(place.radius)} steal=${String(steal)}`);
      return Promise.resolve([0x601, 0x602]);
    },
    idleMarker: () => Promise.resolve(undefined),
    carried: () => Promise.resolve(undefined),
    fakeFood: () => Promise.resolve(0x700),
    lockDoors: (_place: unknown, locked: boolean) => {
      done.push(`doors ${locked ? 'locked' : 'unlocked'}`);
      return Promise.resolve();
    },
  } as unknown as PackageMind;
  const run = (
    name: string,
    slots: number[],
    inputs: PackageInput[],
    overrides: Partial<PackageMind> = {},
  ): Promise<string> => {
    const procedureBranch = branch(name, slots);
    const runner = PROCEDURES[name.toLowerCase()];
    if (!runner) throw new Error(name);
    const procedureRun: ProcedureRun = {
      actor: 1,
      body,
      mind: { ...mind, ...overrides },
      inputs: new ProcedureInputs(
        procedureBranch,
        new Map(inputs.map((input) => [input.id, input])),
      ),
      pack: {} as PackageRecord,
      context: {},
      gait: 'walk',
      found: (slot) => found.get(procedureBranch.inputs[slot] ?? -1) ?? [],
      keep: (slot, references) => {
        found.set(procedureBranch.inputs[slot] ?? -1, references);
      },
      stopped: () => stopped,
      wait: (seconds) => {
        if (waits !== undefined) {
          done.push(`wait ${String(seconds)}`);
          if (++waited >= waits) stopped = true;
        }
        return Promise.resolve();
      },
      random: () => 0,
    };
    return runner(procedureRun);
  };
  return { run, done, found };
}

describe('procedures', () => {
  it('find keeps what it found for the next procedure; sleep takes the first free bed', async () => {
    const { run, done } = harness();
    expect(await run('Find', [0, 1, 2, 255, 3], [NEAR_HOME, BEDS, FOUND_BED, STEAL])).toBe(
      'success',
    );
    // Sleep reads the same object list (input 2), in its own first slot.
    expect(await run('Sleep', [2], [FOUND_BED])).toBe('failure');
    expect(done).toEqual([
      `search ${String(ObjectType.beds)} r600 steal=false`,
      'use 601',
      'use 602',
    ]);
  });

  it('eat uses up food it carries, else food made for the meal', async () => {
    const { run, done } = harness();
    const food: PackageInput = {
      id: 0,
      type: 'TargetSelector',
      value: {
        kind: 'targetSelector',
        target: { type: TargetType.objectType, value: ObjectType.food, count: 0 },
      },
    };
    const fake: PackageInput = { id: 1, type: 'Bool', value: { kind: 'bool', value: true } };
    expect(await run('Eat', [0, 1], [food, fake])).toBe('success');
    expect(await run('Eat', [0, 1], [food, fake], { carried: () => Promise.resolve(0x710) })).toBe(
      'success',
    );
    expect(done).toEqual(['eat 700', 'eat 710 carried']);
  });

  it('patrols round a point it stands at: each round waits a moment', async () => {
    const { run, done } = harness(undefined, 3);
    const start: PackageInput = {
      id: 0,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x800, count: 0 },
      },
    };
    const repeatable: PackageInput = { id: 1, type: 'Bool', value: { kind: 'bool', value: true } };
    const overrides: Partial<PackageMind> = {
      target: () => Promise.resolve(0x800),
      linked: () => Promise.resolve(undefined),
    };
    // Without the wait it would go round at once without end (the page hung).
    expect(await run('Patrol', [0, 255, 1], [start, repeatable], overrides)).toBe('failure');
    expect(done).toEqual(['wait 1', 'wait 1', 'wait 1']);
  });

  it('locks and unlocks the doors of its place', async () => {
    const { run, done } = harness();
    expect(await run('LockDoors', [0], [NEAR_HOME])).toBe('success');
    expect(await run('UnlockDoors', [0], [NEAR_HOME])).toBe('success');
    expect(done).toEqual(['doors locked', 'doors unlocked']);
  });
});
