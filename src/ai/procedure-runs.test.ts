import { describe, expect, it } from 'vitest';
import { ObjectType } from './object-types.ts';
import {
  LocationType,
  TargetType,
  type PackageInput,
  type PackageRecord,
  type ProcedureBranch,
} from './package-records.ts';
import type { FlightRequest } from './flight.ts';
import type {
  MagicCast,
  PackageBody,
  PackageMind,
  ProcedureRun,
  SayOptions,
  ShoutResult,
  WeaponBarrage,
} from './package-runtime.ts';
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
function harness(
  found = new Map<number, readonly number[]>(),
  waits?: number,
  travel: (to: readonly number[]) => Promise<boolean> = () => Promise.resolve(true),
  /** What its barrages answer, one each (then true): false, one that could not be made. */
  barrages: boolean[] = [],
  /** What its shouts answer, one each (then 'shouted'). */
  shouts: ShoutResult[] = [],
) {
  const done: string[] = [];
  let stopped = false;
  let waited = 0;
  const body = {
    reference: 1,
    position: () => [0, 0, 0],
    heading: () => 0,
    travel: (to: readonly number[]) => travel(to),
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
    say: (topic: number | string, options?: SayOptions) => {
      const to = options?.target === undefined ? '' : ` to ${options.target.toString(16)}`;
      done.push(`say ${String(topic)}${to}${options?.forceSubtitle === true ? ' subtitled' : ''}`);
    },
    converse: (target: number) => {
      done.push(`converse ${target.toString(16)}`);
      return Promise.resolve(true);
    },
    standing: () => true,
    activate: () => Promise.resolve(true),
    take: () => Promise.resolve(true),
    useItem: (item: number, consume: boolean) => {
      done.push(`eat ${item.toString(16)}${consume ? ' carried' : ''}`);
      return Promise.resolve(true);
    },
    greet: () => true,
    flies: () => true,
    fly: (request: FlightRequest | undefined) => {
      done.push(`fly ${request ? JSON.stringify(request) : 'nothing'}`);
    },
    hover: (
      at: readonly [number, number, number],
      face: readonly [number, number, number],
      radius: number,
    ) => {
      done.push(`hover ${JSON.stringify({ at, face, radius })}`);
      return Promise.resolve(true);
    },
    flightGrab: (target: number) => {
      done.push(`grab ${target.toString(16)}`);
      return Promise.resolve(true);
    },
    useWeapon: (target: number, barrage: WeaponBarrage) => {
      done.push(
        `weapon at ${target.toString(16)} x${String(barrage.attacks)}${barrage.doNoDamage ? ' no damage' : ''}${barrage.aimOnly ? ' aim only' : ''}`,
      );
      return Promise.resolve(barrages.shift() ?? true);
    },
    useMagic: (target: number | undefined, cast: MagicCast) => {
      done.push(
        `magic ${String(cast.spell?.value.toString(16))} at ${String(target?.toString(16))} for ${String(cast.castTime)}${cast.dual ? ' dual' : ''}`,
      );
      return Promise.resolve(true);
    },
    shout: (target: number | undefined, _shout: unknown, turn: boolean) => {
      done.push(`shout at ${String(target?.toString(16))}${turn ? '' : ' headtrack'}`);
      return Promise.resolve(shouts.shift() ?? ('shouted' as const));
    },
    holster: () => {
      done.push('holster');
    },
    attack: (target: number) => {
      done.push(`attack ${target.toString(16)}`);
    },
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

describe('flying procedures', () => {
  const float = (id: number, value: number): PackageInput => ({
    id,
    type: 'Float',
    value: { kind: 'float', value },
  });

  it('hover flies to its place, Height above it, facing its heading; done once it hovers there', async () => {
    const { run, done } = harness(undefined, 1);
    expect(await run('Hover', [0, 1], [NEAR_HOME, float(1, 512)])).toBe('success');
    expect(done).toEqual(['hover {"at":[100,0,512],"face":[100,1024,512],"radius":600}']);
  });

  it('orbit circles its place at a radius between its radii, Height above it', async () => {
    const { run, done } = harness(undefined, 1);
    expect(
      await run('Orbit', [0, 1, 2, 3], [NEAR_HOME, float(1, 1000), float(2, 3000), float(3, 2000)]),
    ).toBe('failure');
    expect(done[0]).toBe(
      // The harness's random is 0: the nearer radius.
      'fly {"kind":"orbit","center":[100,0,0],"radius":1000,"height":2000}',
    );
    expect(done.at(-1)).toBe('fly nothing');
  });

  it('flight grab grabs its target', async () => {
    const { run, done } = harness();
    const victim: PackageInput = {
      id: 0,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x900, count: 0 },
      },
    };
    expect(await run('FlightGrab', [0], [victim], { target: () => Promise.resolve(0x900) })).toBe(
      'success',
    );
    expect(done).toEqual(['grab 900']);
  });
});

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

  it('waits at a patrol point its idle time; reaches a marker within its radius', async () => {
    const reached: number[] = [];
    const { run, done } = harness(undefined, 10, (to) => {
      reached.push(to[0] ?? 0);
      return Promise.resolve(true);
    });
    const start: PackageInput = {
      id: 0,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x800, count: 0 },
      },
    };
    const overrides: Partial<PackageMind> = {
      target: () => Promise.resolve(0x800),
      linked: () => Promise.resolve(undefined),
      placement: () =>
        Promise.resolve({ position: [40, 0, 0] as const, heading: 0, space: undefined }),
      destinationKind: () => Promise.resolve('marker'),
      patrolPoint: () => Promise.resolve({ idleTime: 3, furniture: false }),
    };
    expect(await run('Patrol', [0], [start], overrides)).toBe('success');
    // Within fAIMarkerDestinationRadius (25) it is not there yet at 40: it goes; then it waits
    // the point's idle time (XPRD).
    expect(reached).toEqual([40]);
    expect(done).toEqual(['wait 1', 'wait 1', 'wait 1']);
  });

  it('stays in furniture on its patrol', async () => {
    const { run, done } = harness();
    const start: PackageInput = {
      id: 0,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x900, count: 0 },
      },
    };
    const overrides: Partial<PackageMind> = {
      target: () => Promise.resolve(0x900),
      linked: () => Promise.resolve(undefined),
      patrolPoint: () => Promise.resolve({ idleTime: 0, furniture: true }),
    };
    await run('Patrol', [0], [start], overrides);
    expect(done).toEqual(['use 900']);
  });

  it('wanders, pausing up to (fAIMaxWanderTime − Energy) / 2 between its walks', async () => {
    const { run, done } = harness(undefined, 2);
    const overrides: Partial<PackageMind> = { energy: () => Promise.resolve(50) };
    expect(await run('Wander', [0], [NEAR_HOME], overrides)).toBe('failure');
    // The harness's random is 0: no pause, but each waits for the next update.
    expect(done).toEqual(['wait 0', 'wait 0']);
  });

  it('tries a patrol point it was blocked from again before it goes on', async () => {
    // The last point is blocked twice, then reached (MQ101's second cart at Helgen's gate).
    let blocked = 2;
    const { run, done } = harness(undefined, undefined, (to) => {
      const last = to[0] === 600;
      done.push(`travel ${String(to[0])}${last && blocked > 0 ? ' blocked' : ''}`);
      return Promise.resolve(!(last && blocked-- > 0));
    });
    const start: PackageInput = {
      id: 0,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x800, count: 0 },
      },
    };
    const overrides: Partial<PackageMind> = {
      target: () => Promise.resolve(0x800),
      linked: (reference) => Promise.resolve(reference === 0x800 ? 0x801 : undefined),
      placement: (reference) =>
        Promise.resolve({
          position: [reference === 0x800 ? 300 : 600, 0, 0] as const,
          heading: 0,
          space: { kind: 'interior', cell: 1 },
        }),
    };
    expect(await run('Patrol', [0], [start], overrides)).toBe('success');
    expect(done).toEqual(['travel 300', 'travel 600 blocked', 'travel 600 blocked', 'travel 600']);
  });

  it('locks and unlocks the doors of its place', async () => {
    const { run, done } = harness();
    expect(await run('LockDoors', [0], [NEAR_HOME])).toBe('success');
    expect(await run('UnlockDoors', [0], [NEAR_HOME])).toBe('success');
    expect(done).toEqual(['doors locked', 'doors unlocked']);
  });

  it('warns the player inside before it locks (Warn Before Locking: TimeToGo)', async () => {
    const { run, done } = harness();
    const warn: PackageInput = { id: 1, type: 'Bool', value: { kind: 'bool', value: true } };
    expect(await run('LockDoors', [0, 1], [NEAR_HOME, warn])).toBe('success');
    expect(done).toEqual(['say TITG to 14', 'doors locked']);
  });

  it('says its topic to its target, its subtitle forced', async () => {
    const { run, done } = harness();
    const topic: PackageInput = { id: 0, type: 'Topic', value: { kind: 'topic', topic: 0x123 } };
    const target: PackageInput = {
      id: 1,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x900, count: 0 },
      },
    };
    const no: PackageInput = { id: 3, type: 'Bool', value: { kind: 'bool', value: false } };
    const forced: PackageInput = { id: 4, type: 'Bool', value: { kind: 'bool', value: true } };
    expect(
      await run('Say', [0, 1, 3, 3, 4], [topic, target, no, forced], {
        target: () => Promise.resolve(0x900),
      }),
    ).toBe('success');
    expect(done).toEqual(['say 291 to 900 subtitled']);
  });

  it('talks with another actor (DialogueActivate between actors)', async () => {
    const { run, done } = harness();
    const target: PackageInput = {
      id: 0,
      type: 'SingleRef',
      value: {
        kind: 'singleRef',
        target: { type: TargetType.specificReference, value: 0x900, count: 0 },
      },
    };
    const no: PackageInput = { id: 2, type: 'Bool', value: { kind: 'bool', value: false } };
    expect(
      await run('DialogueActivate', [0, 255, 2], [target, no], {
        target: () => Promise.resolve(0x900),
      }),
    ).toBe('success');
    expect(done).toEqual(['converse 900']);
  });
});

describe('combat procedures', () => {
  const bool = (id: number, value: boolean): PackageInput => ({
    id,
    type: 'Bool',
    value: { kind: 'bool', value },
  });
  const int = (id: number, value: number): PackageInput => ({
    id,
    type: 'Int',
    value: { kind: 'int', value },
  });
  const float = (id: number, value: number): PackageInput => ({
    id,
    type: 'Float',
    value: { kind: 'float', value },
  });
  const target: PackageInput = {
    id: 2,
    type: 'SingleRef',
    value: {
      kind: 'singleRef',
      target: { type: TargetType.specificReference, value: 0x900, count: 0 },
    },
  };
  const selector = (value: number): PackageInput => ({
    id: 1,
    type: 'TargetSelector',
    value: { kind: 'targetSelector', target: { type: TargetType.objectId, value, count: 0 } },
  });
  const at = { target: () => Promise.resolve(0x900) };

  it('UseWeapon shoots its barrages at its target, then puts the weapon away', async () => {
    const { run, done } = harness();
    // Slots: location, weapon, target, always hit, never end, pause, crouch, no damage, hold,
    // min pause, max pause, end after, min attacks, max attacks, combat start, aim only,
    // power attack, headtrack.
    const inputs = [
      selector(0x111),
      target,
      bool(3, false),
      bool(4, false),
      bool(5, true),
      bool(7, true),
      float(9, 1),
      float(10, 2),
      int(11, 2),
      int(12, 3),
      int(13, 3),
      bool(15, false),
    ];
    const slots = [255, 1, 2, 3, 4, 5, 255, 7, 255, 9, 10, 11, 12, 13, 255, 15, 255, 255];
    expect(await run('UseWeapon', slots, inputs, at)).toBe('success');
    expect(done).toEqual(['weapon at 900 x3 no damage', 'weapon at 900 x3 no damage', 'holster']);
  });

  it('UseWeapon that never ends tries a barrage it could not make again', async () => {
    // Stopped after its fourth wait.
    const { run, done } = harness(new Map(), 4, undefined, [false, false]);
    const inputs = [
      selector(0x111),
      target,
      bool(3, true),
      bool(4, true),
      bool(5, true),
      int(12, 1),
      int(13, 1),
    ];
    const slots = [255, 1, 2, 3, 4, 5, 255, 255, 255, 255, 255, 255, 12, 13];
    expect(await run('UseWeapon', slots, inputs, at)).toBe('failure');
    expect(done).toEqual([
      'weapon at 900 x1',
      'wait 1',
      'weapon at 900 x1',
      'wait 1',
      'weapon at 900 x1',
      'wait 0.5',
      'weapon at 900 x1',
      'wait 0.5',
      'holster',
    ]);
  });

  it('UseWeapon with a number of barrages fails on one it could not make', async () => {
    const { run, done } = harness(new Map(), undefined, undefined, [false]);
    const inputs = [selector(0x111), target, bool(4, false), int(11, 2), int(12, 1), int(13, 1)];
    const slots = [255, 1, 2, 255, 4, 255, 255, 255, 255, 255, 255, 11, 12, 13];
    expect(await run('UseWeapon', slots, inputs, at)).toBe('failure');
    expect(done).toEqual(['weapon at 900 x1', 'holster']);
  });

  it('UseMagic casts its spell its number of times, held its cast time', async () => {
    const { run, done } = harness();
    const inputs = [
      selector(0x222),
      target,
      float(4, 2),
      float(5, 2),
      float(6, 1),
      float(7, 1),
      int(8, 2),
      int(9, 2),
      bool(10, true),
    ];
    const slots = [255, 1, 2, 255, 4, 5, 6, 7, 8, 9, 10];
    expect(await run('UseMagic', slots, inputs, at)).toBe('success');
    expect(done).toEqual(['magic 222 at 900 for 2 dual', 'magic 222 at 900 for 2 dual', 'holster']);
  });

  it('Shout shouts at its target once its voice lets it, then succeeds; Just Headtrack keeps its body', async () => {
    const { run, done } = harness(new Map(), undefined, undefined, [], ['waiting']);
    const inputs = [selector(0x333), target, bool(4, true)];
    expect(await run('Shout', [255, 1, 2, 255, 4], inputs, at)).toBe('success');
    expect(done).toEqual(['shout at 900 headtrack', 'shout at 900 headtrack']);
  });

  it('Shout without a shout fails', async () => {
    const { run } = harness(new Map(), undefined, undefined, [], ['none']);
    expect(await run('Shout', [255, 1, 2], [selector(0x333), target], at)).toBe('failure');
  });

  it('Acquire with Allow Killing fights the one who holds what it wants', async () => {
    const found = new Map<number, readonly number[]>([[0, [0x601]]]);
    const { run, done } = harness(found);
    const list: PackageInput = {
      id: 0,
      type: 'ObjectList',
      value: { kind: 'objectList', value: 0 },
    };
    const holder = { holder: () => Promise.resolve(0x777) };
    expect(await run('Acquire', [0, 255, 255, 255, 4], [list, bool(4, true)], holder)).toBe(
      'failure',
    );
    expect(done).toEqual(['attack 777']);
    done.length = 0;
    expect(await run('Acquire', [0, 255, 255, 255, 4], [list, bool(4, false)], holder)).toBe(
      'failure',
    );
    expect(done).toEqual([]);
  });
});
