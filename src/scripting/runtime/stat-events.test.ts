import { describe, expect, it } from 'vitest';
import { EventHub } from './event-hub.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';
import {
  consumedStat,
  countDaysPassed,
  questTypeStats,
  relayStatEvents,
  sleptHours,
} from './stat-events.ts';

/** A runtime with what the relay reads: the hub, the stats, the forms' types and the gold. */
function fakeRuntime(types: Record<number, string>, gold: { count: number }) {
  const stats = new Map<string, number>();
  const runtime = {
    events: new EventHub(),
    stats,
    state: { gameDaysPassed: 3 },
    incrementStat: (name: string, by = 1) => {
      stats.set(name.toLowerCase(), (stats.get(name.toLowerCase()) ?? 0) + by);
    },
    setStat: (name: string, value: number) => {
      stats.set(name.toLowerCase(), value);
    },
    forms: {
      record: (formId: number) =>
        Promise.resolve(types[formId] ? { type: types[formId] } : undefined),
    },
    itemCount: () => Promise.resolve(gold.count),
  };
  return runtime;
}

describe('stat events', () => {
  it('tells food, potions and ingredients apart', () => {
    expect(consumedStat({ type: 'ALCH', potionFlags: 0x2 })).toBe('Food Eaten');
    expect(consumedStat({ type: 'ALCH', potionFlags: 0 })).toBe('Potions Used');
    expect(consumedStat({ type: 'ALCH', potionFlags: 0x20000 })).toBeUndefined();
    expect(consumedStat({ type: 'INGR' })).toBe('Ingredients Eaten');
    expect(consumedStat({ type: 'WEAP' })).toBeUndefined();
    expect(sleptHours(2, 2 + 8 / 24)).toBe(8);
  });

  it('counts the player’s books, shouts, words, sleep and gold', async () => {
    const gold = { count: 120 };
    const runtime = fakeRuntime({ 0x13e07: 'SHOU', 0x12fcd: 'SPEL' }, gold);
    const stop = relayStatEvents(runtime as unknown as ScriptRuntime);
    const { events } = runtime;
    await events.emitted('bookRead', { book: 0x1, reader: PLAYER_REF, reference: undefined });
    await events.emitted('bookRead', { book: 0x1, reader: 0x1234, reference: undefined });
    await events.emitted('spellCast', { caster: PLAYER_REF, spell: 0x13e07 });
    await events.emitted('spellCast', { caster: PLAYER_REF, spell: 0x12fcd });
    await events.emitted('wordLearned', { word: 0x602a3 });
    await events.emitted('sleep', { started: true, interrupted: false, start: 2.75, end: 3 });
    await events.emitted('sleep', { started: false, interrupted: false });
    await events.emitted('containerChanged', {
      from: 0x5,
      to: PLAYER_REF,
      item: 0xf,
      count: 20,
      reference: undefined,
    });
    gold.count = 50;
    await events.emitted('containerChanged', {
      from: 0x5,
      to: PLAYER_REF,
      item: 0xf,
      count: 1,
      reference: undefined,
    });
    stop();
    expect(runtime.stats.get('books read')).toBe(1);
    expect(runtime.stats.get('times shouted')).toBe(1);
    expect(runtime.stats.get('words of power learned')).toBe(1);
    expect(runtime.stats.get('hours slept')).toBe(6);
    expect(runtime.stats.get('most gold carried')).toBe(120);
    expect(runtime.stats.get('gold found')).toBe(21);
  });

  it('counts quests by type, waits, bunnies, mauls and the beast forms’ days', async () => {
    expect(questTypeStats(1)).toEqual(['Quests Completed', 'Main Quests Completed']);
    expect(questTypeStats(8)).toEqual(['Quests Completed']);
    expect(questTypeStats(6)).toEqual([]);
    const defaults: Record<string, number> = { AWWW: 0xa3087, RIWR: 0xcdd84, PIWV: 0xed06c };
    const runtime = {
      ...fakeRuntime({}, { count: 0 }),
      magic: { defaultObject: (use: string) => Promise.resolve(defaults[use]) },
      raceKeywords: () => Promise.resolve([]),
      actors: {
        factionRank: (actor: number) => Promise.resolve(actor === 0x50 ? 0 : -2),
        raceOf: () => Promise.resolve(0xcdd84),
      },
      clockGlobal: () => undefined,
      pluginGlobal: () => Promise.resolve(undefined),
    };
    const state = { gameDaysPassed: 3, globals: new Map([[0xed06c, 1]]) };
    const live = { ...runtime, state } as unknown as ScriptRuntime;
    const stop = relayStatEvents(live);
    const { events, stats } = runtime;
    await events.emitted('death', { actor: 0x50, killer: PLAYER_REF, dead: true });
    await events.emitted('wait', { started: true, interrupted: false });
    state.gameDaysPassed += 5 / 24;
    await events.emitted('wait', { started: false, interrupted: false });
    await countDaysPassed(live, 2);
    stop();
    expect(stats.get('bunnies slaughtered')).toBe(1);
    expect(stats.get('mauls')).toBe(1);
    expect(stats.get('creatures killed')).toBe(1);
    expect(stats.get('hours waiting')).toBe(5);
    expect(stats.get('days as a werewolf')).toBe(2);
    expect(stats.get('days as a vampire')).toBeUndefined();
  });
});
