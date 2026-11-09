import { describe, expect, it } from 'vitest';
import { EventHub } from './event-hub.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';
import { MAX_UNIQUE_ID, nextUniqueId, relayUniqueIds } from './unique-ids.ts';

const CHEST = 0x100;
const DAGGER = 0x200;

function stubRuntime(): { runtime: ScriptRuntime; state: GameState; hub: EventHub } {
  const state = new GameState();
  const hub = new EventHub();
  const runtime = { state, events: hub } as unknown as ScriptRuntime;
  relayUniqueIds(runtime);
  return { runtime, state, hub };
}

describe('items’ unique ids', () => {
  it('counts on from the highest held, 16-bit: past 0xFFFF the lowest free, none when full', () => {
    expect(nextUniqueId(new Set())).toBe(1);
    expect(nextUniqueId(new Set([1, 2, 7]))).toBe(8);
    expect(nextUniqueId(new Set([MAX_UNIQUE_ID - 1]))).toBe(MAX_UNIQUE_ID);
    expect(nextUniqueId(new Set([1, 2, 4, MAX_UNIQUE_ID]))).toBe(3);
    const full = new Set(Array.from({ length: MAX_UNIQUE_ID }, (_, i) => i + 1));
    expect(nextUniqueId(full)).toBe(0);
  });

  it('gives an id in each inventory an item goes into, and tells the change', () => {
    const { state, hub } = stubRuntime();
    const told: unknown[] = [];
    hub.on('uniqueIdChange', (event) => told.push(event));
    const a = state.create(DAGGER);
    const b = state.create(DAGGER);
    hub.emit('containerChanged', {
      from: undefined,
      to: CHEST,
      item: DAGGER,
      count: 1,
      reference: a,
    });
    hub.emit('containerChanged', {
      from: undefined,
      to: CHEST,
      item: DAGGER,
      count: 1,
      reference: b,
    });
    expect(state.references.get(b)?.uniqueId).toEqual({ holder: CHEST, id: 2 });
    expect(told).toEqual([
      { item: DAGGER, oldHolder: undefined, newHolder: CHEST, oldId: 0, newId: 1 },
      { item: DAGGER, oldHolder: undefined, newHolder: CHEST, oldId: 0, newId: 2 },
    ]);
  });

  it('counts no id of an item that left the game (a merchant chest’s restock)', () => {
    const { state, hub } = stubRuntime();
    const sold = [state.create(DAGGER), state.create(DAGGER), state.create(DAGGER)];
    for (const reference of sold)
      hub.emit('containerChanged', {
        from: undefined,
        to: CHEST,
        item: DAGGER,
        count: 1,
        reference,
      });
    // The restock removes them from the game; even with their ids left on them, none counts.
    for (const reference of sold) state.reference(reference).deleted = true;
    const next = state.create(DAGGER);
    hub.emit('containerChanged', {
      from: undefined,
      to: CHEST,
      item: DAGGER,
      count: 1,
      reference: next,
    });
    expect(state.references.get(next)?.uniqueId).toEqual({ holder: CHEST, id: 1 });
  });
});
