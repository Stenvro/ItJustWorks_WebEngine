import { describe, expect, it } from 'vitest';
import { Fields } from '../../formats/esm/fields.ts';
import type { Condition } from '../conditions.ts';
import type { ScriptRuntime } from './runtime.ts';
import { ObjectHandle } from '../values.ts';
import { actorDialogueEvent, StoryManager, type StoryEventData } from './story-manager.ts';

/** A condition function the stub runtime treats as failing. */
const FAILS = 999;

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const f32 = (value: number): Uint8Array => new Uint8Array(Float32Array.of(value).buffer);
const failing = (): Uint8Array => {
  const data = new Uint8Array(32);
  new DataView(data.buffer).setUint16(8, FAILS, true);
  return data;
};
const formIdAt = (data: Uint8Array, offset = 0): number =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
const record = (type: string, formId: number, fields: [string, Uint8Array][]) => ({
  formId,
  type,
  editorId: `Form${formId.toString(16)}`,
  deleted: false,
  fields: new Fields(fields.map(([field, data]) => ({ type: field, data }))),
  formIdAt,
});
const event = (type = 'SCPT'): StoryEventData => ({
  type,
  forms: new Map(),
  values: new Map(),
  args: [],
});
const questNode = (
  formId: number,
  previous: number,
  flags: number,
  quests: [number, number][],
  extra: [string, Uint8Array][] = [],
) =>
  record('SMQN', formId, [
    ['PNAM', u32s(0x1)],
    ['SNAM', u32s(previous)],
    ['DNAM', u32s(flags)],
    ...extra,
    ...quests.flatMap(([quest, hours]): [string, Uint8Array][] => [
      ['NNAM', u32s(quest)],
      ['RNAM', f32(hours * 24)],
    ]),
  ]);

/** A runtime with just what the story manager uses: records, conditions, quests, the clock. */
function stubRuntime(nodes: ReturnType<typeof record>[], questEvents = new Map<number, string>()) {
  const records = new Map(nodes.map((node) => [node.formId, node]));
  records.set(0x1, record('SMEN', 0x1, [['ENAM', new TextEncoder().encode('SCPT')]]));
  const running = new Set<number>();
  const started: number[] = [];
  const state = { gameDaysPassed: 0 };
  const runtime = {
    state,
    forms: {
      db: {
        formIdsOfType: (type: string) =>
          [...records.values()].filter((r) => r.type === type).map((r) => r.formId),
      },
      record: (formId: number) => Promise.resolve(records.get(formId)),
      quest: (formId: number) =>
        Promise.resolve({
          formId,
          editorId: `Q${formId.toString(16)}`,
          event: questEvents.get(formId),
          eventConditions: [],
        }),
    },
    conditionsHold: (conditions: readonly Condition[]) =>
      Promise.resolve(conditions.every((condition) => condition.function !== FAILS)),
    referenceHandle: () => null,
    quests: {
      isRunning: (quest: number) => running.has(quest),
      start: (quest: number) => {
        running.add(quest);
        started.push(quest);
        return Promise.resolve(true);
      },
    },
    vm: { sendEvent: () => Promise.resolve() },
    warn: () => undefined,
    detach: (work: Promise<unknown>) => {
      work.catch(() => undefined);
    },
  };
  return { runtime: runtime as unknown as ScriptRuntime, running, started, state };
}

describe('the story manager', () => {
  it('starts the first quest node that applies and consumes the event', async () => {
    const { runtime, started } = stubRuntime([
      questNode(0x10, 0, 0, [[0x100, 0]], [['CTDA', failing()]]),
      questNode(0x20, 0x10, 0, [[0x200, 0]]),
      questNode(0x30, 0x20, 0, [[0x300, 0]]),
    ]);
    expect(await new StoryManager(runtime).event(event())).toBe(true);
    expect(started).toEqual([0x200]);
  });

  it('goes on past a node that shares the event', async () => {
    const { runtime, started } = stubRuntime([
      questNode(0x10, 0, 0x0002_0000, [[0x100, 0]]),
      questNode(0x20, 0x10, 0, [[0x200, 0]]),
      questNode(0x30, 0x20, 0, [[0x300, 0]]),
    ]);
    await new StoryManager(runtime).event(event());
    expect(started).toEqual([0x100, 0x200]);
  });

  it('passes over a node whose quests cannot start', async () => {
    const { runtime, started, running } = stubRuntime([
      questNode(0x10, 0, 0, [[0x100, 0]]),
      questNode(0x20, 0x10, 0, [[0x200, 0]]),
    ]);
    running.add(0x100);
    await new StoryManager(runtime).event(event());
    expect(started).toEqual([0x200]);
  });

  it('waits the hours until reset before starting a quest again', async () => {
    const { runtime, started, running, state } = stubRuntime([
      questNode(0x10, 0, 0, [[0x100, 48]]),
    ]);
    const manager = new StoryManager(runtime);
    await manager.event(event());
    running.delete(0x100);
    state.gameDaysPassed = 1; // 24 hours later
    expect(await manager.event(event())).toBe(false);
    state.gameDaysPassed = 2.5;
    expect(await manager.event(event())).toBe(true);
    expect(started).toEqual([0x100, 0x100]);
  });

  it('starts every quest once before one again with "do all before repeating"', async () => {
    const { runtime, started, running } = stubRuntime([
      questNode(0x10, 0, 0x0001_0000, [
        [0x100, 0],
        [0x200, 0],
      ]),
    ]);
    const manager = new StoryManager(runtime);
    for (let i = 0; i < 4; i++) {
      await manager.event(event());
      running.clear();
    }
    expect(started).toEqual([0x100, 0x200, 0x100, 0x200]);
  });

  it('starts up to "num quests to run", no more than "max concurrent" running', async () => {
    const quests: [number, number][] = [
      [0x100, 0],
      [0x200, 0],
      [0x300, 0],
    ];
    const several = stubRuntime([questNode(0x10, 0, 0x0004_0000, quests, [['MNAM', u32s(2)]])]);
    await new StoryManager(several.runtime).event(event());
    expect(several.started).toEqual([0x100, 0x200]);
    const limited = stubRuntime([
      questNode(0x10, 0, 0x0004_0000, quests, [
        ['MNAM', u32s(3)],
        ['XNAM', u32s(1)],
      ]),
    ]);
    await new StoryManager(limited.runtime).event(event());
    expect(limited.started).toEqual([0x100]);
  });

  it('works through its events one at a time, in the order they were raised', async () => {
    const { runtime, started } = stubRuntime([
      questNode(0x10, 0, 0, [
        [0x100, 0],
        [0x200, 0],
      ]),
    ]);
    // A quest that takes long to start (its aliases, its scripts): the next event waits.
    const quests = (
      runtime as unknown as { quests: { start: (quest: number) => Promise<boolean> } }
    ).quests;
    const start = quests.start;
    quests.start = async (quest) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return start(quest);
    };
    const manager = new StoryManager(runtime);
    const both = await Promise.all([manager.event(event()), manager.event(event())]);
    // Both raised at once: the second saw the first's quest running and started the other.
    expect(both).toEqual([true, true]);
    expect(started).toEqual([0x100, 0x200]);
  });

  it('leaves quests of another event type alone', async () => {
    const { runtime, started } = stubRuntime(
      [
        questNode(0x10, 0, 0, [
          [0x100, 0],
          [0x200, 0],
        ]),
      ],
      new Map([[0x100, 'KILL']]),
    );
    await new StoryManager(runtime).event(event());
    expect(started).toEqual([0x200]);
  });
});

describe('the Actor Dialogue event (ADIA)', () => {
  it('names the quests an event started (none: no node answered)', async () => {
    const { runtime } = stubRuntime([
      questNode(0x10, 0, 0x0002_0000, [[0x100, 0]]),
      questNode(0x20, 0x10, 0, [[0x200, 0]]),
    ]);
    const manager = new StoryManager(runtime);
    expect(await manager.quests(event())).toEqual([0x100, 0x200]);
    // Both run now: nothing more starts.
    expect(await manager.quests(event())).toEqual([]);
  });

  it("carries the asking actor's location (L1), it (R1) and the one asked (R2)", () => {
    const data = actorDialogueEvent(0x30, 0x14a, 0x14b);
    expect(data.type).toBe('ADIA');
    expect(Object.fromEntries(data.forms)).toEqual({ L1: 0x30, R1: 0x14a, R2: 0x14b });
    expect(data.args.map((arg) => (arg instanceof ObjectHandle ? arg.formId : arg))).toEqual([
      0x30, 0x14a, 0x14b,
    ]);
    // Without a location (the wilderness): no L1, None for the quest's event.
    const outside = actorDialogueEvent(undefined, 0x14a, 0x14b);
    expect(outside.forms.has('L1')).toBe(false);
    expect(outside.args[0]).toBeNull();
  });
});
