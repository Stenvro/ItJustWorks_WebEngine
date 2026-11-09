// Conformance: the Papyrus VM (engine map: Scripting > Papyrus VM). Its threads, locks, latent
// natives, frame budget and the engine's handling of script events.
//
// Sources:
// - The Creation Kit wiki's "Threading Notes (Papyrus)": events run on threads of their own, and
//   the engine does not wait for a script's handler to return; a call that must sync with the
//   game takes a frame.
// - The game data: WIDeadBodyCleanupScript (on placed town actors, the Bannered Mare's patrons
//   among them) loops Utility.WaitGameTime(DaysBeforeCleanUp × 24) in OnDeath until the body is
//   cleaned up, so its OnDeath returns only after half a game day or more.
// - The [Papyrus] INI settings' defaults (fUpdateBudgetMS 1.2, fExtraTaskletBudgetMS 1.2) and
//   the frame's rule, observed in the original (docs/scripting.md "Threads"): each frame the
//   VM's update runs the calls scripts handed to the main thread, in the order they came, while
//   0.9 of fUpdateBudgetMS lasts (always at least one); the scripts' tasklets then run for
//   fExtraTaskletBudgetMS more, so a busy thread gets 0.9 × fUpdateBudgetMS +
//   fExtraTaskletBudgetMS a frame and goes on in the next. A thread waits for the update for
//   each handed call, so it runs one a frame (src/scripting/native-timing.ts lists the natives
//   that run on the thread at once).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parsePex } from '../../../src/formats/pex/pex.ts';
import { parseIni } from '../../../src/formats/ini/ini.ts';
import { PapyrusVm, type NativeFunction, type VmHost } from '../../../src/scripting/papyrus-vm.ts';
import { PapyrusScheduler } from '../../../src/scripting/scheduler.ts';
import { ScriptLibrary } from '../../../src/scripting/script-library.ts';
import { EventHub } from '../../../src/scripting/runtime/event-hub.ts';
import {
  relayScriptEvents,
  type ScriptEventHost,
} from '../../../src/scripting/runtime/script-events.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import { IniSettings } from '../../../src/world/ini-settings.ts';
import { buildPex, float, id, int, type BuildScript } from '../../helpers/pex-builder.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

describe('the Papyrus VM', () => {
  // Found 2026-10-24 (the Bannered Mare's patrons): Actor.Kill waited for every death handler to
  // return, so the murder, the crime report and the story manager's Kill Actor event waited half
  // a game day for WIDeadBodyCleanupScript's OnDeath.
  it(
    'a death does not wait for its script handlers: OnDying and OnDeath are both sent at once, ' +
      'and the crime and story manager events follow without waiting for them  [CK threading notes]',
    async () => {
      const events = new EventHub();
      const sent: string[] = [];
      const handle = (): ObjectHandle => ({}) as ObjectHandle;
      const host = {
        events,
        // Handlers that never return (an OnDeath that waits a game day).
        sendEvent: (_target: number, event: string) => {
          sent.push(event);
          return new Promise<void>(() => undefined);
        },
        registeredEvent: () => Promise.resolve(),
        referenceHandle: handle,
        actorHandle: handle,
        formHandle: handle,
        livingActor: () => Promise.resolve(true),
        itemScripted: () => Promise.resolve(false),
        deleted: () => false,
      } satisfies ScriptEventHost;
      const stop = relayScriptEvents(host);
      // What actor-engine.ts kill does before it goes on to crime.killed.
      await events.emitted('death', { actor: 0x10, killer: 0x14, dead: false });
      await events.emitted('death', { actor: 0x10, killer: 0x14, dead: true });
      expect(sent).toEqual(['OnDying', 'OnDeath']);
      stop();
    },
  );

  it(
    'threads run on the [Papyrus] fUpdateBudgetMS budget per frame, with fExtraTaskletBudgetMS ' +
      'for the scripts’ tasklets after the update, by the engine’s rule  [original; settings]',
    async () => {
      // The defaults: 0.9 × 1.2 + 1.2 = 2.28 ms a frame.
      const defaults = await busyFrames(new IniSettings(undefined));
      expect(defaults.budget).toBeCloseTo(2.28);
      // A changed INI: 0.9 × 4.8 + 0.6 = 4.92 ms a frame.
      const changed = await busyFrames(
        new IniSettings(parseIni('[Papyrus]\nfUpdateBudgetMS=4.8\nfExtraTaskletBudgetMS=0.6\n')),
      );
      expect(changed.budget).toBeCloseTo(4.92);
      for (const { budget, spent } of [defaults, changed]) {
        // Every frame but the last runs the thread until the budget is spent (checked every
        // 256 instructions: 64 calls of 0.005 ms here), then it goes on in the next frame.
        expect(spent.length).toBeGreaterThan(2);
        for (const ms of spent.slice(0, -1)) {
          expect(ms).toBeGreaterThan(budget);
          expect(ms).toBeLessThanOrEqual(budget + CHECK_MS + 1e-6);
        }
        expect(spent.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(BUSY_CALLS * ABS_MS);
      }
      // A larger budget, fewer frames.
      expect(changed.spent.length).toBeLessThan(defaults.spent.length);
    },
  );

  it(
    'the natives handed to the main thread run in the next frame’s VM update, in the order ' +
      'they came, as many a frame as 0.9 × fUpdateBudgetMS takes, and one a frame per thread  ' +
      '[original]',
    async () => {
      const { vm, scheduler, frames, setClock } = setUp(new IniSettings(undefined));
      // Six objects' threads each call a handed native three times (0.3 ms each).
      const workers = [0, 1, 2, 3, 4, 5].map((i) => new ObjectHandle(0x100 + i, 'Worker'));
      const done = Promise.all(workers.map((worker) => vm.sendEvent(worker, 'OnLoop')));
      const progress = { finished: false };
      void done.then(() => (progress.finished = true));
      await flush();
      // None runs before the frame's update.
      expect(frames.calls).toEqual([]);
      const perFrame: number[][] = [];
      for (let frame = 1; frame <= 20 && !progress.finished; frame++) {
        frames.current = frame;
        setClock(frame * 100);
        scheduler.advance(1 / 60, 0);
        await flush();
        perFrame.push(frames.calls.filter((call) => call.frame === frame).map((call) => call.who));
      }
      expect(progress.finished).toBe(true);
      // The update's share is 1.08 ms: four calls of 0.3 ms (the fourth passes it).
      expect(perFrame[0]).toEqual([0x100, 0x101, 0x102, 0x103]);
      for (const calls of perFrame) {
        expect(calls.length).toBeLessThanOrEqual(4);
        // One a frame per thread.
        expect(new Set(calls).size).toBe(calls.length);
      }
      expect(perFrame.flat()).toHaveLength(18);
      for (const worker of workers) {
        expect(perFrame.flat().filter((who) => who === worker.formId)).toHaveLength(3);
      }
      // 18 calls, four an update.
      expect(perFrame).toHaveLength(5);
    },
  );
});

/** What a Math.abs call costs on the test's clock, and a handed GetPositionX (ms). */
const ABS_MS = 0.005;
const HANDED_MS = 0.3;
/** The busy loop's calls, and the clock between two budget checks (64 calls of 4 instructions). */
const BUSY_CALLS = 3000;
const CHECK_MS = 64 * ABS_MS;

const SCRIPTS: BuildScript[] = [
  { name: 'Form' },
  {
    name: 'ObjectReference',
    parent: 'Form',
    functions: [{ name: 'GetPositionX', native: true, returnType: 'Float' }],
  },
  {
    name: 'Math',
    functions: [{ name: 'abs', native: true, returnType: 'Float', params: [['afValue', 'Float']] }],
  },
  {
    name: 'Worker',
    parent: 'ObjectReference',
    functions: [
      // A long loop of natives that run on the thread at once (Math.abs).
      {
        name: 'OnBusy',
        locals: [
          ['i', 'Int'],
          ['go', 'Bool'],
          ['f', 'Float'],
        ],
        code: [
          ['callstatic', id('Math'), id('abs'), id('f'), float(-1)],
          ['iadd', id('i'), id('i'), int(1)],
          ['cmp_lt', id('go'), id('i'), int(BUSY_CALLS)],
          ['jmpt', id('go'), int(-3)],
        ],
      },
      // Three calls of a native the game hands to its main thread.
      {
        name: 'OnLoop',
        locals: [
          ['i', 'Int'],
          ['go', 'Bool'],
          ['f', 'Float'],
        ],
        code: [
          ['callmethod', id('GetPositionX'), id('self'), id('f')],
          ['iadd', id('i'), id('i'), int(1)],
          ['cmp_lt', id('go'), id('i'), int(3)],
          ['jmpt', id('go'), int(-3)],
        ],
      },
    ],
  },
];

/** A VM on a test clock that only the natives move, its budgets from an INI's [Papyrus]. */
function setUp(ini: IniSettings) {
  let clock = 0;
  const frames = { current: 0, calls: [] as { frame: number; who: number }[] };
  const scheduler = new PapyrusScheduler(undefined, () => clock);
  scheduler.configure(
    ini.number('Papyrus', 'fUpdateBudgetMS'),
    ini.number('Papyrus', 'fExtraTaskletBudgetMS'),
  );
  scheduler.framed = true;
  const byName = new Map(SCRIPTS.map((s) => [s.name.toLowerCase(), parsePex(buildPex(s))]));
  const natives: Record<string, NativeFunction> = {
    'math.abs': ({ args }) => {
      clock += ABS_MS;
      return Math.abs(typeof args[0] === 'number' ? args[0] : 0);
    },
    'objectreference.getpositionx': ({ self }) => {
      clock += HANDED_MS;
      frames.calls.push({ frame: frames.current, who: self?.formId ?? 0 });
      return 0;
    },
  };
  const host: VmHost = {
    formType: () => Promise.resolve('objectreference'),
    attachedScripts: () => Promise.resolve([{ name: 'Worker', properties: new Map() }]),
    native: (script, fn) => natives[`${script}.${fn}`],
    warn: (message) => {
      throw new Error(message);
    },
  };
  const vm = new PapyrusVm(
    new ScriptLibrary((name) => Promise.resolve(byName.get(name))),
    host,
    scheduler,
  );
  return {
    vm,
    scheduler,
    frames,
    clock: () => clock,
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

/** Runs every promise callback due (a macrotask turn). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A busy thread over frames: the budget and the milliseconds it ran in each frame. */
async function busyFrames(ini: IniSettings): Promise<{ budget: number; spent: number[] }> {
  const { vm, scheduler, clock } = setUp(ini);
  const spent: number[] = [];
  const progress = { finished: false };
  void vm
    .sendEvent(new ObjectHandle(0x100, 'Worker'), 'OnBusy')
    .then(() => (progress.finished = true));
  let from = clock();
  await flush();
  spent.push(clock() - from);
  for (let frame = 0; frame < 100 && !progress.finished; frame++) {
    from = clock();
    scheduler.advance(1 / 60, 0);
    await flush();
    spent.push(clock() - from);
  }
  expect(progress.finished).toBe(true);
  return { budget: scheduler.budgetMs, spent };
}

// Every placed actor of a sample of cells killed: each OnDeath its scripts (and its aliases' and
// effects') run returns within a few seconds, or waits on a clock its script names
// (Utility.WaitGameTime, Wait). The Bannered Mare's patrons carry WIDeadBodyCleanupScript, whose
// OnDeath waits game hours until the body is cleaned up.
const SAMPLE_CELLS: readonly { readonly name: string; readonly cell: number }[] = [
  { name: 'the Bannered Mare', cell: 0x1605e },
  { name: 'the Sleeping Giant Inn', cell: 0x133c6 },
  { name: 'Blind Cliff Cave', cell: 0x152b7 },
];
/** Seconds a handler that waits for no clock may take (frames of 1/60 s: 180). */
const RETURN_WITHIN = 3;

describe.skipIf(!hasGamedata())('the Papyrus VM: death handlers (headless simulation)', () => {
  let sim: Sim;
  const results: {
    name: string;
    killed: number;
    deaths: number;
    clockWaits: string[];
    stuck: string[];
  }[] = [];

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    for (const { name, cell } of SAMPLE_CELLS) {
      await sim.openInterior(cell);
      await sim.step(1);
      const since = sim.time;
      const actors = sim
        .actors()
        .map((staged) => staged.reference)
        .filter((actor) => actor !== PLAYER_REF);
      for (const actor of actors) await sim.kill(actor);
      await sim.step(RETURN_WITHIN);
      const deaths = sim
        .scriptEvents({ event: 'OnDeath', since })
        .filter((event) => actors.includes(event.target)).length;
      const { threads, unsaved } = sim.runtime.vm.saveThreads();
      const onDeath = threads.filter(
        (thread) =>
          thread.origin.kind === 'event' && thread.origin.name.toLowerCase() === 'ondeath',
      );
      results.push({
        name,
        killed: actors.length,
        deaths,
        clockWaits: onDeath.filter((thread) => thread.wait.kind === 'clock').map((t) => t.where),
        stuck: [
          ...onDeath.filter((thread) => thread.wait.kind !== 'clock').map((t) => t.where),
          ...unsaved.filter((thread) => /\.ondeath\b/i.test(thread.where)).map((t) => t.where),
        ],
      });
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it(
    'every vanilla OnDeath handler of a placed actor in a sample of cells returns within N ' +
      'frames, or waits on a clock its script names (WaitGameTime)  [data: the scripts]',
    () => {
      console.log(
        results
          .map(
            (result) =>
              `${result.name}: ${String(result.killed)} killed, ${String(result.deaths)} OnDeath, ` +
              `${String(result.clockWaits.length)} OnDeath threads waiting on a clock (so far)` +
              (result.stuck.length ? `, stuck: ${result.stuck.join('; ')}` : ''),
          )
          .join('\n'),
      );
      for (const result of results) {
        expect(result.killed, result.name).toBeGreaterThan(0);
        expect(result.deaths, result.name).toBeGreaterThan(0);
        expect(result.stuck, result.name).toEqual([]);
      }
      // The patrons' WIDeadBodyCleanupScript waits game hours.
      const mare = results.find((result) => result.name === 'the Bannered Mare');
      expect(mare?.clockWaits.some((where) => /WIDeadBodyCleanupScript/i.test(where))).toBe(true);
    },
  );
});
