// What a container or an actor holds as it resets with its cell (ScriptRuntime.resetHeld, from
// cell-reset.ts) or restocks: the item references in it leave the game the one way every
// deletion goes (removeFromGame: a created one is told deleted, its unique id goes), except one a
// quest's alias holds (inferred, TODO(M13)).

import { describe, expect, it } from 'vitest';
import type { RecordDatabase } from '../../world/record-db.ts';
import { ScriptLibrary } from '../script-library.ts';
import { ScriptRuntime } from './runtime.ts';

const BARREL = 0x100;
const DAGGER = 0x200;
const AMULET = 0x201;
const QUEST = 0x300;

/** A runtime without plugins. */
function runtime(): ScriptRuntime {
  const db = {
    plugins: [],
    get: () => Promise.resolve(undefined),
    worldOfCell: () => undefined,
    cellOfReference: () => undefined,
    formIdsOfType: () => [],
  } as unknown as RecordDatabase;
  return new ScriptRuntime(db, new ScriptLibrary(() => Promise.resolve(undefined)));
}

/** A created item put into `holder`, as the player puts it there (with its unique id). */
function putIn(scripts: ScriptRuntime, holder: number, base: number): number {
  const reference = scripts.state.create(base);
  const entry = scripts.state.reference(reference);
  entry.container = { holder, base, count: 1 };
  entry.uniqueId = { holder, id: reference };
  const items = scripts.state.inventories.get(holder) ?? new Map<number, number>();
  items.set(base, (items.get(base) ?? 0) + 1);
  scripts.state.inventories.set(holder, items);
  return reference;
}

describe('what a holder held as it resets', () => {
  it('a cell reset removes the created items in a respawning container: told deleted, ids gone', () => {
    const scripts = runtime();
    const deleted: number[] = [];
    scripts.events.on('formDelete', (event) => deleted.push(event.form));
    const dagger = putIn(scripts, BARREL, DAGGER);
    scripts.resetHeld(BARREL);
    expect(deleted).toEqual([dagger]);
    const entry = scripts.state.references.get(dagger);
    expect(entry?.deleted).toBe(true);
    expect(entry?.container).toBeUndefined();
    expect(entry?.uniqueId).toBeUndefined();
    expect(scripts.state.inventories.has(BARREL)).toBe(false);
  });

  it("ObjectReference.Reset removes the created items it held as a cell reset's do", async () => {
    const scripts = runtime();
    const deleted: number[] = [];
    scripts.events.on('formDelete', (event) => deleted.push(event.form));
    const dagger = putIn(scripts, BARREL, DAGGER);
    await scripts.resetReference(BARREL, undefined);
    expect(deleted).toEqual([dagger]);
    expect(scripts.state.references.get(dagger)?.deleted).toBe(true);
    expect(scripts.state.references.get(dagger)?.container).toBeUndefined();
  });

  it('keeps an item a quest alias holds in it, with its count (inferred)', () => {
    const scripts = runtime();
    const deleted: number[] = [];
    scripts.events.on('formDelete', (event) => deleted.push(event.form));
    const dagger = putIn(scripts, BARREL, DAGGER);
    const amulet = putIn(scripts, BARREL, AMULET);
    scripts.aliasFilled(QUEST, 0, amulet);
    scripts.restock(BARREL);
    expect(deleted).toEqual([dagger]);
    expect(scripts.state.references.get(amulet)?.deleted).toBeUndefined();
    expect(scripts.state.references.get(amulet)?.container).toEqual({
      holder: BARREL,
      base: AMULET,
      count: 1,
    });
    expect([...(scripts.state.inventories.get(BARREL) ?? [])]).toEqual([[AMULET, 1]]);
  });
});
