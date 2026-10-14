import { describe, expect, it } from 'vitest';
import { buildPex, id, int, str, type BuildScript } from '../../tests/helpers/pex-builder.ts';
import { parsePex } from '../formats/pex/pex.ts';
import {
  PapyrusVm,
  type AttachedScriptInfo,
  type NativeFunction,
  type VmHost,
} from './papyrus-vm.ts';
import { PapyrusScheduler } from './scheduler.ts';
import { ScriptLibrary } from './script-library.ts';
import { formatValue, ObjectHandle } from './values.ts';

/** Appends a word to the script's log: strcat ::log_var ::log_var "word,". */
const log = (word: string): readonly [string, ...ReturnType<typeof id>[]] =>
  ['strcat', id('::log_var'), id('::log_var'), str(`${word},`)] as const;
const wait = (seconds: number) =>
  [
    'callstatic',
    id('Utility'),
    id('Wait'),
    id('::NoneVar'),
    { kind: 'float', value: seconds },
  ] as const;

const SCRIPTS: BuildScript[] = [
  { name: 'Form' },
  {
    name: 'Utility',
    functions: [{ name: 'Wait', native: true, params: [['afSeconds', 'Float']] }],
  },
  {
    name: 'Logger',
    parent: 'Form',
    variables: [['::log_var', 'String', str('')]],
    properties: [['Log', 'String', '::log_var']],
    functions: [
      // OnInit waits a second: events that come meanwhile wait for it to finish.
      {
        name: 'OnInit',
        locals: [['::NoneVar', 'None']],
        code: [log('init-start'), wait(1), log('init-end')],
      },
      { name: 'OnActivate', code: [log('activate')] },
      // A latent wait unlocks the script: another event gets in meanwhile.
      {
        name: 'OnSlow',
        locals: [['::NoneVar', 'None']],
        code: [log('slow-start'), wait(1), log('slow-end')],
      },
      { name: 'OnQuick', code: [log('quick')] },
      // A native on self that waits for a call back into this script (as SetStage waits for
      // the stage's fragment in the quest's own script).
      { name: 'Again', native: true },
      {
        name: 'OnReenter',
        locals: [['::NoneVar', 'None']],
        code: [
          log('re-start'),
          ['callmethod', id('Again'), id('self'), id('::NoneVar')],
          log('re-end'),
        ],
      },
      // A long loop with no external call keeps the lock, even over frames.
      {
        name: 'OnBusy',
        locals: [
          ['i', 'Int'],
          ['go', 'Bool'],
        ],
        code: [
          log('busy-start'),
          ['iadd', id('i'), id('i'), int(1)],
          ['cmp_lt', id('go'), id('i'), int(5000)],
          ['jmpt', id('go'), int(-2)],
          log('busy-end'),
        ],
      },
    ],
  },
];

class Host implements VmHost {
  readonly warnings: string[] = [];
  vm: PapyrusVm | undefined;

  formType(): Promise<string | undefined> {
    return Promise.resolve('form');
  }

  attachedScripts(): Promise<readonly AttachedScriptInfo[]> {
    return Promise.resolve([{ name: 'Logger', properties: new Map() }]);
  }

  native(script: string, fn: string): NativeFunction | undefined {
    if (script === 'logger' && fn === 'again') {
      return ({ vm, self, latent }) =>
        self ? latent(vm.call(self, 'OnQuick')).then(() => null) : null;
    }
    if (script === 'utility' && fn === 'wait') {
      return ({ vm, args, latent }) =>
        latent(vm.scheduler.waitReal(typeof args[0] === 'number' ? args[0] : 0)).then(() => null);
    }
    return undefined;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function setup(scheduler = new PapyrusScheduler()) {
  const byName = new Map(SCRIPTS.map((s) => [s.name.toLowerCase(), parsePex(buildPex(s))]));
  const library = new ScriptLibrary((name) => Promise.resolve(byName.get(name)));
  const host = new Host();
  const vm = new PapyrusVm(library, host, scheduler);
  const target = new ObjectHandle(0x100, 'Logger');
  const readLog = async (): Promise<string> => formatValue(await vm.getProperty(target, 'Log'));
  return { vm, host, target, scheduler, readLog };
}

/** Lets pending promise callbacks run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('Papyrus threads', () => {
  it('holds a script’s events until its OnInit has finished', async () => {
    const { vm, target, scheduler, readLog } = setup();
    const init = vm.initialize(target);
    await settle();
    const activate = vm.sendEvent(target, 'OnActivate');
    await settle();
    scheduler.advance(1, 0);
    await Promise.all([init, activate]);
    expect(await readLog()).toBe('init-start,init-end,activate,');
  });

  it('lets another event in while a thread waits (a latent call unlocks the script)', async () => {
    const { vm, target, scheduler, readLog } = setup();
    const slow = vm.sendEvent(target, 'OnSlow');
    await settle();
    await vm.sendEvent(target, 'OnQuick');
    expect(vm.threads.waiting).toBe(1);
    scheduler.advance(1, 0);
    await slow;
    expect(await readLog()).toBe('slow-start,quick,slow-end,');
    expect(vm.threads).toEqual({ running: 0, waiting: 0 });
  });

  it('does not deadlock when a native on self waits for a call back into the script', async () => {
    const { vm, target, readLog } = setup();
    await vm.sendEvent(target, 'OnReenter');
    expect(await readLog()).toBe('re-start,quick,re-end,');
  });

  it('runs a long thread over frames, keeping its lock: the next event waits for it', async () => {
    // A clock that moves a millisecond each time it is read: a 0 ms budget is soon spent.
    let clock = 0;
    const scheduler = new PapyrusScheduler(0, () => clock++);
    scheduler.framed = true;
    const { vm, target, readLog } = setup(scheduler);
    // Every check is over a budget of 0 ms: the loop yields every 256 instructions.
    const busy = vm.sendEvent(target, 'OnBusy');
    await settle();
    const activate = vm.sendEvent(target, 'OnActivate');
    let frames = 0;
    const progress = { done: false };
    void Promise.all([busy, activate]).then(() => {
      progress.done = true;
    });
    while (!progress.done && frames < 200) {
      scheduler.advance(1 / 60, 0);
      await settle();
      frames++;
    }
    expect(progress.done).toBe(true);
    expect(frames).toBeGreaterThan(20);
    scheduler.framed = false;
    expect(await readLog()).toBe('busy-start,busy-end,activate,');
  });
});
