// A Papyrus thread saved while it waits and resumed on a fresh VM (docs/formats/save.md,
// "Papyrus threads"): its frames are data, not JavaScript calls.

import { describe, expect, it } from 'vitest';
import { buildPex, float, id, int, type BuildScript } from '../../tests/helpers/pex-builder.ts';
import { parsePex } from '../formats/pex/pex.ts';
import { decodeValue, encodeValue } from '../save/save-codec.ts';
import {
  PapyrusVm,
  type AttachedScriptInfo,
  type NativeFunction,
  type SavedInstance,
  type SavedThread,
  type VmHost,
} from './papyrus-vm.ts';
import { PapyrusScheduler } from './scheduler.ts';
import { ScriptLibrary } from './script-library.ts';
import { ObjectHandle } from './values.ts';

const SCRIPTS: BuildScript[] = [
  { name: 'Form' },
  {
    name: 'Utility',
    functions: [
      { name: 'Wait', native: true, params: [['afSeconds', 'Float']] },
      // A native whose promise is in flight (a latent native waiting on the world).
      { name: 'Slow', native: true, returnType: 'Int' },
    ],
  },
  {
    name: 'Counter',
    parent: 'Form',
    variables: [['::sum_var', 'Int', int(0)]],
    functions: [
      // OnRun calls Triple, which waits halfway: two frames, the callee's result still to come.
      {
        name: 'OnRun',
        locals: [
          ['a', 'Int'],
          ['r', 'Int'],
        ],
        code: [
          ['assign', id('a'), int(7)],
          ['callmethod', id('Triple'), id('self'), id('r'), id('a')],
          ['iadd', id('::sum_var'), id('::sum_var'), id('r')],
          ['iadd', id('::sum_var'), id('::sum_var'), id('a')],
        ],
      },
      {
        name: 'OnSlow',
        locals: [['r', 'Int']],
        code: [
          ['callstatic', id('Utility'), id('Slow'), id('r')],
          ['iadd', id('::sum_var'), id('r'), int(1)],
        ],
      },
      {
        name: 'Triple',
        returnType: 'Int',
        params: [['x', 'Int']],
        locals: [
          ['::NoneVar', 'None'],
          ['t', 'Int'],
        ],
        code: [
          ['imul', id('x'), id('x'), int(3)],
          ['callstatic', id('Utility'), id('Wait'), id('::NoneVar'), float(1)],
          ['imul', id('t'), id('x'), int(2)],
          ['return', id('t')],
        ],
      },
    ],
  },
];

class Host implements VmHost {
  readonly warnings: string[] = [];
  /** What Slow answers: a value at once, or never (its promise stays in flight). */
  slow: number | undefined;

  formType(): Promise<string | undefined> {
    return Promise.resolve('form');
  }

  attachedScripts(): Promise<readonly AttachedScriptInfo[]> {
    return Promise.resolve([{ name: 'Counter', properties: new Map() }]);
  }

  native(script: string, fn: string): NativeFunction | undefined {
    if (script === 'utility' && fn === 'slow') {
      const answer = this.slow;
      return () => answer ?? new Promise<null>(() => undefined);
    }
    if (script !== 'utility' || fn !== 'wait') return undefined;
    return ({ vm, args, latent }) => {
      const wait = vm.scheduler.clockWait('real', typeof args[0] === 'number' ? args[0] : 0);
      return latent(vm.scheduler.waitUntil(wait), wait).then(() => null);
    };
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function setup() {
  const byName = new Map(SCRIPTS.map((s) => [s.name.toLowerCase(), parsePex(buildPex(s))]));
  const library = new ScriptLibrary((name) => Promise.resolve(byName.get(name)));
  const host = new Host();
  const scheduler = new PapyrusScheduler();
  const vm = new PapyrusVm(library, host, scheduler);
  return { vm, host, scheduler };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const target = new ObjectHandle(0x100, 'Counter');

describe('Papyrus threads in a save', () => {
  it('resumes a thread that waited halfway on a fresh VM, with the same result', async () => {
    // Uninterrupted: 7 tripled is 21, doubled 42, plus 7.
    const straight = setup();
    const done = straight.vm.sendEvent(target, 'OnRun');
    await settle();
    straight.scheduler.advance(1, 0);
    await done;
    expect(await straight.vm.getVariable(target, '::sum_var')).toBe(49);

    // Saved in the middle of Triple's Wait, through the save's encoding.
    const before = setup();
    void before.vm.sendEvent(target, 'OnRun');
    await settle();
    before.scheduler.advance(0.4, 0);
    await settle();
    const { threads, unsaved } = before.vm.saveThreads();
    expect(unsaved).toEqual([]);
    expect(threads.map((t) => t.frames.map((f) => `${f.name}@${String(f.pc)}`))).toEqual([
      ['OnRun@1', 'Triple@1'],
    ]);
    const data = decodeValue(
      JSON.parse(
        JSON.stringify(
          encodeValue({ instances: await before.vm.savedInstances(), threads, clock: 0.4 }),
        ),
      ),
    ) as { instances: SavedInstance[]; threads: SavedThread[]; clock: number };

    const after = setup();
    after.scheduler.realTime = data.clock;
    expect(await after.vm.restoreInstances(data.instances)).toEqual([]);
    expect(await after.vm.restoreThreads(data.threads)).toEqual([]);
    await settle();
    // Its wait goes on where it was: 0.6 s were left.
    after.scheduler.advance(0.5, 0);
    await settle();
    expect(after.vm.threads.waiting).toBe(1);
    after.scheduler.advance(0.2, 0);
    await settle();
    await after.vm.idle();
    expect(after.vm.threads).toEqual({ running: 0, waiting: 0 });
    expect(await after.vm.getVariable(target, '::sum_var')).toBe(49);
    expect(after.host.warnings).toEqual([]);
  });

  it("saves a thread inside a native's promise: the native is called again as it loads", async () => {
    const before = setup();
    void before.vm.sendEvent(target, 'OnSlow');
    await settle();
    const { threads, unsaved } = before.vm.saveThreads();
    expect(unsaved).toEqual([]);
    expect(threads.map((t) => t.frames.map((f) => `${f.name}@${String(f.pc)}`))).toEqual([
      ['OnSlow@0'],
    ]);
    const after = setup();
    after.host.slow = 41;
    expect(await after.vm.restoreInstances(await before.vm.savedInstances())).toEqual([]);
    expect(await after.vm.restoreThreads(threads)).toEqual([]);
    await settle();
    await after.vm.idle();
    expect(await after.vm.getVariable(target, '::sum_var')).toBe(42);
  });
});
