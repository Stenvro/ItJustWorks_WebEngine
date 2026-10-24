import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelSequences, Playback } from '../render/animation.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { tellSwing } from './open-close.ts';

/** A runtime that records the open states and the openClose events it is told. */
function fakeRuntime(): {
  runtime: ScriptRuntime;
  states: number[];
  events: { opened: boolean; actor: number | undefined }[];
} {
  const states: number[] = [];
  const events: { opened: boolean; actor: number | undefined }[] = [];
  const runtime = {
    swung: (_reference: number, state: number) => states.push(state),
    events: {
      emit: (_name: string, event: { opened: boolean; actor: number | undefined }) =>
        events.push(event),
    },
  } as unknown as ScriptRuntime;
  return { runtime, states, events };
}

const sequences = {
  byName: new Map([
    ['open', { duration: 2 }],
    ['close', { duration: 1 }],
  ]),
} as unknown as ModelSequences;

describe('tellSwing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the open state with the swing: opening, then open, then told', () => {
    const { runtime, states, events } = fakeRuntime();
    const playback: Playback = { sequence: 'open', start: 10 };
    tellSwing(runtime, 0x1234, playback, sequences, 0x14);
    expect(states).toEqual([2]);
    vi.advanceTimersByTime(2000);
    expect(states).toEqual([2, 1]);
    expect(events).toEqual([{ reference: 0x1234, actor: 0x14, opened: true }]);
  });

  it('a swing turned back tells only the last one', () => {
    const { runtime, states, events } = fakeRuntime();
    const playback: Playback = { sequence: 'open', start: 10 };
    tellSwing(runtime, 0x1234, playback, sequences, undefined);
    playback.sequence = 'close';
    playback.start = 11;
    tellSwing(runtime, 0x1234, playback, sequences, undefined);
    vi.advanceTimersByTime(3000);
    expect(states).toEqual([2, 4, 3]);
    expect(events).toEqual([{ reference: 0x1234, actor: undefined, opened: false }]);
  });
});
