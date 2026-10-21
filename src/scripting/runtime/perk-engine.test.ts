import { describe, expect, it } from 'vitest';
import { EntryFunction, EntryPoint } from '../../gameplay/perk-entry-points.ts';
import type { EntryPointEntry, PerkRecord } from '../../world/perk-records.ts';
import type { Condition } from '../conditions.ts';
import { ObjectHandle } from '../values.ts';
import { GameState } from './game-state.ts';
import { PerkEngine } from './perk-engine.ts';
import type { ScriptRuntime } from './runtime.ts';

const ACTOR = 0x14;
const TARGET = 0x5000;
const SWORD = 0x100;
const AXE = 0x101;
/** A condition the fake runtime values: GetIsID(form) on the tab's subject. */
const GET_IS_ID = 72;

const isId = (form: number, or = false): Condition => ({
  function: GET_IS_ID,
  operator: 0,
  or,
  comparand: 1,
  form,
  param2: 0,
  raw1: form,
  form2: 0,
  strings: [],
  runOn: 0,
  reference: 0,
  param3: -1,
  eventMember: '',
});

function entry(fn: number, value: number, options: Partial<EntryPointEntry> = {}): EntryPointEntry {
  return {
    kind: 'entryPoint',
    rank: 0,
    priority: 0,
    entryPoint: EntryPoint.modAttackDamage,
    function: fn,
    tabCount: 3,
    conditions: [],
    data: { type: 'float', value },
    ...options,
  };
}

const perk = (formId: number, entries: PerkRecord['entries']): PerkRecord => ({
  formId,
  editorId: '',
  name: '',
  description: '',
  conditions: [],
  trait: false,
  level: 0,
  ranks: 1,
  playable: true,
  hidden: false,
  next: undefined,
  entries,
});

/** A perk engine over a fake runtime: the actor's base perks, its values, GetIsID. */
function world(records: PerkRecord[], base: number[] = [], ranks = new Map<number, number>()) {
  const state = new GameState();
  const runtime = {
    state,
    actors: {
      info: () => Promise.resolve({ spells: { perks: base, perkRanks: ranks } }),
      hasPerk: (actor: number, formId: number) =>
        Promise.resolve(state.actors.get(actor)?.perks.get(formId) ?? base.includes(formId)),
      setPerk: (actor: number, formId: number, has: boolean) => {
        state.actor(actor).perks.set(formId, has);
      },
      value: () => Promise.resolve({ base: 30, max: 30, current: 30 }),
    },
    magic: {
      effectsOn: () => [],
      effect: () => Promise.resolve(undefined),
      syncLasting: () => Promise.resolve(),
    },
    quests: { setStage: () => Promise.resolve(true) },
    referenceHandle: (formId: number) => new ObjectHandle(formId, 'objectreference'),
    formHandle: (formId: number) => new ObjectHandle(formId, 'form'),
    conditionsHold: (conditions: readonly Condition[], subject: ObjectHandle) =>
      Promise.resolve(
        conditions.every((c) => c.function !== GET_IS_ID || c.form === subject.formId),
      ),
  } as unknown as ScriptRuntime;
  const engine = new PerkEngine(runtime);
  const byId = new Map(records.map((record) => [record.formId, record]));
  engine.record = (formId) => Promise.resolve(byId.get(formId));
  return engine;
}

describe('the perk engine', () => {
  it("applies an actor's entries of an entry point in priority order", async () => {
    const engine = world(
      [
        perk(1, [entry(EntryFunction.multiplyValue, 2, { priority: 5 })]),
        perk(2, [entry(EntryFunction.setValue, 3, { priority: 1 })]),
        perk(3, [entry(EntryFunction.addValue, 1, { priority: 1 })]),
        // Another entry point: not this one.
        perk(4, [entry(EntryFunction.setValue, 100, { entryPoint: EntryPoint.modSpellCost })]),
      ],
      [1, 2, 3, 4],
    );
    // Set 3, add 1 (equal priority: in order), then × 2.
    expect(await engine.applyEntryPoint(EntryPoint.modAttackDamage, ACTOR, 10)).toBe(8);
    expect(await engine.applyEntryPoint(EntryPoint.modSpellCost, ACTOR, 10)).toBe(100);
    expect(await engine.applyEntryPoint(EntryPoint.modBuyPrices, ACTOR, 10)).toBe(10);
  });

  it("runs each tab's conditions on its subject; a missing subject fails them", async () => {
    const swords = entry(EntryFunction.multiplyValue, 1.2, {
      conditions: [[], [isId(SWORD, true), isId(AXE)]],
    });
    const againstTarget = entry(EntryFunction.multiplyValue, 2, {
      conditions: [[], [], [isId(TARGET)]],
    });
    const engine = world([perk(1, [swords, againstTarget])], [1]);
    const apply = (...targets: (number | undefined)[]) =>
      engine.applyEntryPoint(EntryPoint.modAttackDamage, ACTOR, 10, ...targets);
    expect(await apply(SWORD)).toBeCloseTo(12);
    expect(await apply(AXE, TARGET)).toBeCloseTo(24);
    expect(await apply(0x999, TARGET)).toBeCloseTo(20);
    expect(await apply(undefined, undefined)).toBe(10);
  });

  it('holds perks from the base, as added and removed; entries wait for their rank', async () => {
    const engine = world(
      [
        perk(1, [entry(EntryFunction.addValue, 1)]),
        perk(2, [
          entry(EntryFunction.addValue, 10),
          entry(EntryFunction.addValue, 100, { rank: 1 }),
        ]),
      ],
      [1],
    );
    const value = () => engine.applyEntryPoint(EntryPoint.modAttackDamage, ACTOR, 0);
    expect(await value()).toBe(1);
    await engine.add(ACTOR, 2);
    expect(await engine.has(ACTOR, 2)).toBe(true);
    // Rank 1 (the first): its rank-1 entry (PRKE rank 1, the second rank) does not act.
    expect(await value()).toBe(11);
    await engine.remove(ACTOR, 1);
    expect(await value()).toBe(10);
    const ranked = world(
      [perk(2, [entry(EntryFunction.addValue, 100, { rank: 1 })])],
      [2],
      new Map([[2, 2]]),
    );
    expect(await ranked.applyEntryPoint(EntryPoint.modAttackDamage, ACTOR, 0)).toBe(100);
  });

  it('picks the last spell or text whose conditions hold', async () => {
    const spell = (id: number, priority: number): EntryPointEntry =>
      entry(EntryFunction.selectSpell, 0, {
        entryPoint: EntryPoint.applyCombatHitSpell,
        priority,
        data: { type: 'spell', spell: id },
      });
    const engine = world([perk(1, [spell(0x300, 5), spell(0x301, 0)])], [1]);
    expect(await engine.selectSpell(EntryPoint.applyCombatHitSpell, ACTOR)).toBe(0x300);
    expect(await engine.selectSpell(EntryPoint.applyBashingSpell, ACTOR)).toBeUndefined();
  });

  it("gives the actor value functions the owner's value (Fortify through the skill boosts)", async () => {
    const boost = entry(EntryFunction.multiplyOnePlusActorValueMult, 0, {
      data: { type: 'actorValue', actorValue: 135, factor: 0.01 },
    });
    const engine = world([perk(1, [boost])], [1]);
    // The fake runtime's values are all 30: × 1.3.
    expect(await engine.applyEntryPoint(EntryPoint.modAttackDamage, ACTOR, 10)).toBeCloseTo(13);
  });
});
