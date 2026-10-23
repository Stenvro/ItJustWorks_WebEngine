import { describe, expect, it } from 'vitest';
import type { Condition } from '../scripting/conditions.ts';
import { PackageFlag, type PackageRecord, type ProcedureBranch } from './package-records.ts';
import {
  ActorPackages,
  type PackageBody,
  type PackageMind,
  type ProcedureRunner,
} from './package-runtime.ts';

const procedure = (name: string, flags = 0, conditions: Condition[] = []): ProcedureBranch => ({
  type: 'Procedure',
  conditions,
  branchFlags: 0,
  procedure: name,
  flags,
  inputs: [],
  flagOverride: undefined,
  children: [],
});

const branch = (type: string, children: ProcedureBranch[], branchFlags = 0): ProcedureBranch => ({
  type,
  conditions: [],
  branchFlags,
  procedure: undefined,
  flags: 0,
  inputs: [],
  flagOverride: undefined,
  children,
});

const pack = (
  formId: number,
  tree: ProcedureBranch,
  overrides: Partial<PackageRecord> = {},
): PackageRecord => ({
  formId,
  editorId: `Pack${String(formId)}`,
  flags: 0,
  type: 18,
  interruptOverride: 0,
  preferredSpeed: 0,
  interruptFlags: 0,
  schedule: undefined,
  conditions: [],
  idles: undefined,
  combatStyle: undefined,
  ownerQuest: undefined,
  template: undefined,
  inputCount: 0,
  version: 0,
  inputs: [],
  tree,
  inputNames: [],
  onBegin: { idle: undefined, topic: undefined },
  onEnd: { idle: undefined, topic: undefined },
  onChange: { idle: undefined, topic: undefined },
  ...overrides,
});

/** A condition the fake mind holds when its form is in `truths`. */
const condition = (form: number): Condition =>
  ({ function: 0, form, runOn: 0, operator: 0, comparand: 1, or: false }) as unknown as Condition;

function setup(packages: PackageRecord[], runners: Record<string, ProcedureRunner>) {
  const truths = new Set<number>();
  const events: string[] = [];
  let hour = 10;
  let day = 0;
  const mind: PackageMind = {
    time: () => ({ hour, dayOfWeek: 0, month: 7, date: 17 }),
    day: () => day,
    package: (formId) => Promise.resolve(packages.find((entry) => entry.formId === formId)),
    packagesOf: () => Promise.resolve(packages.map((entry) => entry.formId)),
    conditionsHold: (conditions) =>
      Promise.resolve(conditions.every((entry) => truths.has(entry.form))),
    place: () => Promise.resolve(undefined),
    target: () => Promise.resolve(undefined),
    placement: () => Promise.resolve(undefined),
    linked: () => Promise.resolve(undefined),
    around: () => Promise.resolve([]),
    idleMarker: () => Promise.resolve(undefined),
    search: () => Promise.resolve([]),
    carried: () => Promise.resolve(undefined),
    fakeFood: () => Promise.resolve(undefined),
    lockDoors: () => Promise.resolve(),
    packageEvent: (_actor, event, record) => {
      events.push(`${event} ${record.editorId}`);
    },
  };
  const body: PackageBody = {
    reference: 1,
    position: () => [0, 0, 0],
    heading: () => 0,
    travel: () => Promise.resolve(true),
    stop: () => undefined,
    face: () => undefined,
    useFurniture: () => Promise.resolve(false),
    leaveFurniture: () => Promise.resolve(),
    takeIdleMarker: () => true,
    leaveIdleMarker: () => undefined,
    playIdle: () => Promise.resolve(true),
    say: () => undefined,
    activate: () => Promise.resolve(true),
    take: () => Promise.resolve(true),
    useItem: () => Promise.resolve(true),
    greet: () => true,
    standing: () => true,
  };
  const packages_ = new ActorPackages(1, mind, body, runners, () => 0);
  return {
    actor: packages_,
    truths,
    events,
    setHour: (value: number) => {
      hour = value;
    },
    setDay: (value: number) => {
      day = value;
    },
  };
}

/** Lets the async work of an update settle. */
async function tick(actor: ActorPackages, seconds = 0.1): Promise<void> {
  actor.update(seconds);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('ActorPackages', () => {
  it('runs the first package whose conditions hold', async () => {
    const ran: string[] = [];
    const runners: Record<string, ProcedureRunner> = {
      first: async (run) => {
        ran.push('first');
        while (!run.stopped()) await run.wait(1);
        return 'failure';
      },
      second: async (run) => {
        ran.push('second');
        while (!run.stopped()) await run.wait(1);
        return 'failure';
      },
    };
    const { actor, truths, events } = setup(
      [pack(1, procedure('first'), { conditions: [condition(99)] }), pack(2, procedure('second'))],
      runners,
    );
    await tick(actor);
    expect(actor.current?.id).toBe(2);
    // The first's conditions come to hold: it is chosen at the next evaluation.
    truths.add(99);
    await tick(actor, 15);
    expect(actor.current?.id).toBe(1);
    expect(ran).toEqual(['second', 'first']);
    expect(events).toEqual(['begin Pack2', 'change Pack2', 'begin Pack1']);
  });

  it('chooses again every fEvaluatePackageTimer seconds, and every frame while it has none', async () => {
    const ran: string[] = [];
    const forever =
      (name: string): ProcedureRunner =>
      async (run) => {
        ran.push(name);
        while (!run.stopped()) await run.wait(1);
        return 'failure';
      };
    const { actor, truths } = setup(
      [
        pack(1, procedure('first'), { conditions: [condition(99)] }),
        pack(2, procedure('second'), { conditions: [condition(98)] }),
      ],
      { first: forever('first'), second: forever('second') },
    );
    // None holds: asked again each frame, so one that comes to hold runs at once.
    await tick(actor);
    expect(actor.current).toBeUndefined();
    truths.add(98);
    await tick(actor);
    expect(actor.current?.id).toBe(2);
    // One running is chosen again only after the timer (15 s).
    truths.add(99);
    await tick(actor, 10);
    expect(actor.current?.id).toBe(2);
    await tick(actor, 5);
    expect(actor.current?.id).toBe(1);
    expect(ran).toEqual(['second', 'first']);
  });

  it("takes the tree again as a running branch's conditions no longer hold", async () => {
    // A follower's template: a Stacked branch follows while 7 holds (WaitingForPlayer 0), else
    // waits; the same package stays chosen.
    const ran: string[] = [];
    const forever =
      (name: string): ProcedureRunner =>
      async (run) => {
        ran.push(name);
        while (!run.stopped()) await run.wait(1);
        return 'failure';
      };
    const follow = procedure('follow', 0, [condition(7)]);
    const { actor, truths, events } = setup(
      [pack(1, branch('Stacked', [follow, procedure('wait')]))],
      { follow: forever('follow'), wait: forever('wait') },
    );
    truths.add(7);
    await tick(actor);
    expect(ran).toEqual(['follow']);
    truths.delete(7);
    actor.evaluate();
    await tick(actor);
    await tick(actor);
    expect(ran).toEqual(['follow', 'wait']);
    expect(actor.current?.procedure).toBe('wait');
    expect(events).toEqual(['begin Pack1']);
  });

  it('runs an ended package again as the branch it ended under may no longer run', async () => {
    // The follower's wait: it travels there (the tree ends, done) while 8 holds; told to
    // follow (8 no longer holds, 7 does) it follows.
    const ran: string[] = [];
    const follow = procedure('follow', 0, [condition(7)]);
    const waitThere = branch('Stacked', [procedure('travel')]);
    const { actor, truths } = setup(
      [pack(1, branch('Stacked', [follow, { ...waitThere, conditions: [condition(8)] }]))],
      {
        follow: async (run) => {
          ran.push('follow');
          while (!run.stopped()) await run.wait(1);
          return 'failure';
        },
        travel: () => {
          ran.push('travel');
          return Promise.resolve('success');
        },
      },
    );
    truths.add(8);
    await tick(actor);
    await tick(actor, 15);
    expect(ran).toEqual(['travel']);
    truths.delete(8);
    truths.add(7);
    await tick(actor, 15);
    await tick(actor);
    expect(ran).toEqual(['travel', 'follow']);
  });

  it('runs a sequence in order, skipping what may not run, and ends the package', async () => {
    const ran: string[] = [];
    const step =
      (name: string): ProcedureRunner =>
      () => {
        ran.push(name);
        return Promise.resolve('success');
      };
    const { actor, events } = setup(
      [
        pack(
          1,
          branch('Sequence', [procedure('a'), procedure('b', 0, [condition(5)]), procedure('c')]),
        ),
      ],
      { a: step('a'), b: step('b'), c: step('c') },
    );
    await tick(actor);
    expect(ran).toEqual(['a', 'c']);
    await tick(actor);
    // It ended: chosen again after one that just ended is passed over once.
    expect(events.slice(0, 2)).toEqual(['begin Pack1', 'end Pack1']);
  });

  it('completes the package with a procedure whose success completes it', async () => {
    const ran: string[] = [];
    const { actor } = setup([pack(1, branch('Sequence', [procedure('a', 0x1), procedure('b')]))], {
      a: () => {
        ran.push('a');
        return Promise.resolve('success');
      },
      b: () => {
        ran.push('b');
        return Promise.resolve('success');
      },
    });
    await tick(actor);
    expect(ran).toEqual(['a']);
  });

  it('ends a package whose procedure goes round without ever waiting', async () => {
    let ended: (turns: number) => void = () => undefined;
    const done = new Promise<number>((resolve) => {
      ended = resolve;
    });
    const { actor, events } = setup([pack(1, procedure('spin'))], {
      spin: async (run) => {
        let turns = 0;
        while (!run.stopped()) {
          turns++;
          await Promise.resolve();
        }
        ended(turns);
        return 'success';
      },
    });
    actor.update(0.1);
    // Without the guard this never ends (a hung page).
    expect(await done).toBeLessThan(200_000);
    await tick(actor);
    expect(events.slice(0, 2)).toEqual(['begin Pack1', 'end Pack1']);
  });

  it('runs the first child of a stacked branch that may run', async () => {
    const ran: string[] = [];
    const runner =
      (name: string): ProcedureRunner =>
      async (run) => {
        ran.push(name);
        while (!run.stopped()) await run.wait(1);
        return 'failure';
      };
    const { actor } = setup(
      [pack(1, branch('Stacked', [procedure('sleep', 0, [condition(7)]), procedure('sandbox')]))],
      { sleep: runner('sleep'), sandbox: runner('sandbox') },
    );
    await tick(actor);
    expect(ran).toEqual(['sandbox']);
  });

  it('runs a once-a-day package once a day', async () => {
    let runs = 0;
    const { actor, setDay } = setup(
      [pack(1, procedure('once'), { flags: PackageFlag.oncePerDay })],
      {
        once: () => {
          runs++;
          return Promise.resolve('success');
        },
      },
    );
    await tick(actor);
    await tick(actor, 3);
    await tick(actor, 3);
    expect(runs).toBe(1);
    setDay(1);
    await tick(actor, 3);
    expect(runs).toBe(2);
  });

  it('changes package as its schedule ends at the hour', async () => {
    const runner: ProcedureRunner = async (run) => {
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    const { actor, setHour } = setup(
      [
        pack(1, procedure('work'), {
          schedule: { month: -1, dayOfWeek: -1, date: 0, hour: 8, minute: 0, duration: 120 },
        }),
        pack(2, procedure('rest')),
      ],
      { work: runner, rest: runner },
    );
    setHour(9);
    await tick(actor);
    expect(actor.current?.id).toBe(1);
    setHour(10);
    await tick(actor);
    expect(actor.current?.id).toBe(2);
  });

  it('ends a simultaneous branch as its first child ends, stopping those beside it', async () => {
    const ran: string[] = [];
    const runners: Record<string, ProcedureRunner> = {
      find: () => {
        ran.push('find');
        return Promise.resolve('success');
      },
      sandbox: async (run) => {
        ran.push('sandbox');
        while (!run.stopped()) await run.wait(1);
        ran.push('sandbox stopped');
        return 'failure';
      },
      sleep: async (run) => {
        ran.push('sleep');
        while (!run.stopped()) await run.wait(1);
        return 'failure';
      },
    };
    const tree = branch('Sequence', [
      branch('Simultaneous', [procedure('find'), procedure('sandbox')]),
      procedure('sleep'),
    ]);
    const { actor } = setup([pack(1, tree)], runners);
    await tick(actor);
    await tick(actor, 1);
    expect(ran).toEqual(['find', 'sandbox', 'sleep', 'sandbox stopped']);
    expect(actor.current?.procedure).toBe('sleep');
  });
});
