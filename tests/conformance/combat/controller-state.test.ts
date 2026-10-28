// Conformance: the combat controller and its state (engine map: Combat > Controller, state). An
// actor's fight from its start to its end: who enters it, its timers, the per-fight confidence
// roll, yielding, and that a fight runs in bounded time.
//
// Sources:
// - Observed in the original: as a fight's controller is made it draws a random
//   confidence modifier in fCombatConfidenceModifierMin .. Max (engine −0.5 .. 0.5; Skyrim.esm
//   −0.25 .. 1) and a first taunt delay in fCombatDialogueTauntMin .. MaxElapsedTime.
// - The settings: the engine's defaults and Skyrim.esm (combat/settings.ts).
// - Entering combat by aggression and reaction: UESP "Skyrim:AI Data" (unaggressive never,
//   aggressive enemies, very aggressive enemies and neutrals, frenzied anyone).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Aggression,
  attacksOnSight,
  COMBAT_AI_DEFAULTS,
  yields,
} from '../../../src/ai/combat-ai.ts';
import { FightReaction } from '../../../src/ai/combat-reactions.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';
import { ENGINE, LOAD_ORDER } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('entering combat (formula)', () => {
  it('by aggression against the reaction (UESP AI Data)', () => {
    expect(attacksOnSight(Aggression.unaggressive, FightReaction.enemy)).toBe(false);
    expect(attacksOnSight(Aggression.aggressive, FightReaction.enemy)).toBe(true);
    expect(attacksOnSight(Aggression.aggressive, FightReaction.neutral)).toBe(false);
    expect(attacksOnSight(Aggression.veryAggressive, FightReaction.neutral)).toBe(true);
    expect(attacksOnSight(Aggression.frenzied, FightReaction.ally)).toBe(true);
  });
});

describe('the settings the controller reads', () => {
  it('fCombatConfidenceModifierMin / Max: Skyrim.esm’s −0.25 .. 1', () => {
    expect(settings.confidenceModifierMin).toBe(LOAD_ORDER.fCombatConfidenceModifierMin);
    expect(settings.confidenceModifierMax).toBe(LOAD_ORDER.fCombatConfidenceModifierMax);
  });
  it('fCombatYieldTime 10, fCombatYieldRetryTime 600, fCombatSelectTargetUpdateTime 1', () => {
    expect(settings.yieldTime).toBe(ENGINE.fCombatYieldTime);
    expect(settings.yieldRetryTime).toBe(ENGINE.fCombatYieldRetryTime);
    expect(settings.selectTargetUpdateTime).toBe(ENGINE.fCombatSelectTargetUpdateTime);
  });
});

describe('yielding (formula)', () => {
  it('not again within fCombatYieldRetryTime', () => {
    const base = { fightsPlayer: true, playerEnemy: false, wouldFlee: true, settings };
    expect(yields({ ...base, sinceLastYield: 599 })).toBe(false);
    expect(yields({ ...base, sinceLastYield: 600 })).toBe(true);
  });
});

describe('the controller (todo)', () => {
  it.todo(
    'a fight draws its confidence modifier in fCombatConfidenceModifierMin .. Max  [original]',
  );
  it.todo('the first taunt after fCombatDialogueTauntMin .. MaxElapsedTime  [original]');
  it.todo('per-behaviour timers (fCombat*UpdateTime) instead of every frame  [settings]');
  it.todo('the fight ends when no target is left: the search, then the stand-down  [original]');
  it.todo('fCombatHealthRegenRateMult (0.75): health regenerates slower in combat  [settings]');
  it.todo('the actor’s yield rule (ours borrows the player’s settings)  [original]');
  it.todo(
    'combat groups: one per side, the group’s targets and strategy  [CommonLibSSE CombatGroup]',
  );
});

// A wolf placed in the Bannered Mare fights the five patrons: the fight runs in game time, the
// step never waits on itself (the bard's songs, each ended at once by combat, restarted from their
// end fragments within one step until the heap ran out), and the heap stays bounded.

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('a fight in the Bannered Mare (headless simulation)', () => {
  let sim: Sim;
  let wolf = 0;
  let realMs = 0;
  let heapGrowth = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), PLAYER_REF);
    await sim.step(5);
    const heap = process.memoryUsage().heapUsed;
    const started = Date.now();
    await sim.step(20);
    realMs = Date.now() - started;
    heapGrowth = process.memoryUsage().heapUsed - heap;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('runs 20 game seconds of the fight in less than 3 real minutes', () => {
    expect(realMs).toBeLessThan(180_000);
  });

  it('keeps the heap within 300 MB of where the fight began', () => {
    expect(heapGrowth).toBeLessThan(300 * 1024 * 1024);
  });

  it('ends with the wolf dead at the patrons’ hands', () => {
    const death = sim.deaths().find((event) => event.actor === wolf);
    expect(death).toBeDefined();
    expect(death?.killer).not.toBe(PLAYER_REF);
  });
});
