import { describe, expect, it } from 'vitest';
import { GameState } from '../scripting/runtime/game-state.ts';
import { gameStateData, restoreGameState } from '../scripting/runtime/runtime-save.ts';
import { ObjectHandle, PapyrusArray } from '../scripting/values.ts';
import { decodeValue, encodeValue, readSave, readSaveHeader, writeSave } from './save-codec.ts';

const header = {
  version: 1,
  name: 'Save 1',
  kind: 'save',
  number: 1,
  playerName: 'Prisoner',
  playerLevel: 3,
  location: 'Whiterun',
  gameDays: 1.5,
  realTime: 0,
  plugins: ['Skyrim.esm'],
} as const;

describe('save codec', () => {
  it('keeps Maps, Sets, typed arrays, undefined, non-finite numbers and Papyrus values', () => {
    const value = {
      map: new Map<number, unknown>([[1, new Set(['a'])]]),
      bytes: new Uint8Array([1, 2, 255]),
      floats: new Float32Array([0.5, -2]),
      none: undefined,
      list: [undefined, Number.POSITIVE_INFINITY, Number.NaN],
      handle: new ObjectHandle(0x14, 'Actor', -1),
      array: new PapyrusArray([1, 'two', null]),
      $tricky: { $m: 1 },
    };
    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
    expect(back.map.get(1)).toEqual(new Set(['a']));
    expect([...back.bytes]).toEqual([1, 2, 255]);
    expect([...back.floats]).toEqual([0.5, -2]);
    expect('none' in back).toBe(true);
    expect(back.list[0]).toBeUndefined();
    expect(back.list[1]).toBe(Number.POSITIVE_INFINITY);
    expect(back.list[2]).toBeNaN();
    expect(back.handle).toBeInstanceOf(ObjectHandle);
    expect(back.handle.key).toBe('14:-1');
    expect(back.handle.type).toBe('actor');
    expect(back.array.items).toEqual([1, 'two', null]);
    expect(back.$tricky).toEqual({ $m: 1 });
  });

  it('keeps one Papyrus array held by two variables one array', () => {
    const shared = new PapyrusArray([1, 2]);
    const value = {
      a: shared,
      b: [shared],
      c: new Map([['x', shared]]),
      other: new PapyrusArray([1, 2]),
    };
    const back = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
    expect(back.b[0]).toBe(back.a);
    expect(back.c.get('x')).toBe(back.a);
    expect(back.other).not.toBe(back.a);
    back.a.items.push(3);
    expect(back.c.get('x')?.items).toEqual([1, 2, 3]);
    // A save made before arrays had numbers reads as before.
    expect((decodeValue({ $a: [1] }) as PapyrusArray).items).toEqual([1]);
  });

  it('refuses class instances it would lose', () => {
    expect(() => encodeValue({ when: new Date(0) })).toThrow(/\$\.when is a Date/);
  });

  it('writes and reads a file with its header readable alone', async () => {
    const bytes = await writeSave({
      header,
      thumbnail: new Uint8Array([9, 9]),
      body: { hello: new Map([['a', 1]]) },
    });
    expect(readSaveHeader(bytes).header.location).toBe('Whiterun');
    const file = await readSave(bytes);
    expect([...file.thumbnail]).toEqual([9, 9]);
    expect(file.body).toEqual({ hello: new Map([['a', 1]]) });
  });

  it('puts a game state back into a fresh one, in place', () => {
    const state = new GameState();
    state.gameDaysPassed = 4.25;
    state.quest(0x100).stagesDone.add(10);
    state.reference(0x200).openState = 1;
    state.actor(0x300).dead = true;
    state.crime.offLimits.add(7);
    state.inventories.set(0x14, new Map([[0xf, 100]]));
    const data = decodeValue(JSON.parse(JSON.stringify(encodeValue(gameStateData(state)))));
    const fresh = new GameState();
    const offLimits = fresh.crime.offLimits;
    restoreGameState(fresh, data as Record<string, unknown>);
    expect(fresh.gameDaysPassed).toBe(4.25);
    expect(fresh.quests.get(0x100)?.stagesDone.has(10)).toBe(true);
    expect(fresh.references.get(0x200)?.openState).toBe(1);
    expect(fresh.actors.get(0x300)?.dead).toBe(true);
    expect(fresh.crime.offLimits).toBe(offLimits);
    expect(offLimits.has(7)).toBe(true);
    expect(fresh.inventories.get(0x14)?.get(0xf)).toBe(100);
  });
});
