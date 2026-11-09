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
  drawConfidenceModifier,
  actorStrength,
  attackDps,
  Confidence,
  mayReselect,
  oddsWeighed,
  shouldFlee,
  UNWEIGHED_ODDS,
  yields,
} from '../../../src/ai/combat-ai.ts';
import { CombatSearch } from '../../../src/ai/combat-search.ts';
import { CombatGroups } from '../../../src/ai/combat-groups.ts';
import { FightReaction } from '../../../src/ai/combat-reactions.ts';
import { regenPerSecond, VITAL_DEFAULTS } from '../../../src/gameplay/vitals.ts';
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
  it('a fight draws its confidence modifier in fCombatConfidenceModifierMin .. Max  [original]', () => {
    expect(drawConfidenceModifier(() => 0, settings)).toBe(LOAD_ORDER.fCombatConfidenceModifierMin);
    expect(drawConfidenceModifier(() => 1, settings)).toBe(LOAD_ORDER.fCombatConfidenceModifierMax);
  });
  it('fCombatDialogueTauntMin .. MaxElapsedTime: Skyrim.esm’s 10 .. 30  [settings]', () => {
    // A fight draws its first taunt's time as it begins (ActorCombatAi #begin), the original's
    // controller the same, from these.
    expect(settings.tauntMin).toBe(10);
    expect(settings.tauntMax).toBe(30);
  });
  it('per-behaviour timers (fCombat*UpdateTime) gate what they weigh  [settings]', () => {
    // The tree runs each frame; its nodes weigh on their own timers: the odds every
    // fCombatThreatRatioUpdateTime, the target every fCombatSelectTargetUpdateTime.
    expect(settings.threatRatioUpdateTime).toBe(ENGINE.fCombatThreatRatioUpdateTime);
    expect(mayReselect(0.5, settings)).toBe(false);
    expect(mayReselect(1, settings)).toBe(true);
  });
  it('the odds stand at 100 for a frenzied actor or after 120 s unengaged  [original]', () => {
    expect(UNWEIGHED_ODDS).toBe(100);
    expect(oddsWeighed(119, Aggression.aggressive)).toBe(true);
    expect(oddsWeighed(120, Aggression.aggressive)).toBe(false);
    expect(oddsWeighed(1, Aggression.frenzied)).toBe(false);
    // At such odds no confidence but a coward's flees.
    expect(
      shouldFlee(
        {
          ratio: UNWEIGHED_ODDS,
          confidence: Confidence.average,
          modifier: 0,
          afraid: false,
          rallied: false,
        },
        settings,
      ),
    ).toBe(false);
  });
  it('the strength weighs damage per second, not the raw blow  [original]', () => {
    const fast = attackDps(10, 2, false, settings);
    const bow = attackDps(10, 1, true, settings);
    expect(fast).toBe(20);
    expect(bow).toBeCloseTo(10 * settings.dpsBowSpeedMult);
    expect(actorStrength(100, fast)).toBe(2000);
    // Armour counts as more health, at most 0.99 of a blow taken.
    expect(actorStrength(100, 10, 0.5)).toBe(2000);
    expect(actorStrength(100, 10, 1)).toBeCloseTo(100000);
  });
  it('the fight ends when no target is left: the search gives up, then the stand-down  [original]', () => {
    const body = {
      position: (): [number, number, number] => [0, 0, 0],
      travel: () => Promise.resolve(false),
      face: () => undefined,
      stop: () => undefined,
    };
    const search = new CombatSearch(
      [0, 0, 0],
      body,
      { searchInvestigateDistance: 256, searchInvestigateTime: 2.5, stateExpireTime: 30 },
      () => 0,
    );
    // Its state expires after fCombatStateExpireTime however it searched.
    expect(search.update(0)).toBe('searching');
    expect(search.update(31)).toBe('gave-up');
  });
  it('fCombatHealthRegenRateMult: health regenerates slower in combat  [settings]', () => {
    const base = { max: 100, rate: 1, rateMult: 100, inCombat: false };
    const out = regenPerSecond(0, base);
    expect(regenPerSecond(0, { ...base, inCombat: true })).toBeCloseTo(
      out * VITAL_DEFAULTS.combatRegenMult[0],
    );
    // A race that regenerates in combat keeps its rate; the actor value may raise it.
    expect(regenPerSecond(0, { ...base, inCombat: true, regenInCombat: true })).toBeCloseTo(out);
    expect(regenPerSecond(0, { ...base, inCombat: true, combatHealthMult: 1 })).toBeCloseTo(out);
  });
  // Stays: the original's rule lives in the player-side routine that reads fCombatYieldTime and
  // fCombatYieldRetryTime, not read to its end; the settings' test is above (yields).
  it.todo('the actor’s yield rule (ours borrows the player’s settings)  [original]');
  it('combat groups: one per side, its members sharing their fight  [CommonLibSSE CombatGroup]', () => {
    const groups = new CombatGroups();
    const first = groups.join(1, []);
    expect(groups.join(2, [1])).toBe(first);
    expect(groups.join(3, [])).not.toBe(first);
    expect(groups.size(2)).toBe(2);
    expect([...groups.allies(1)]).toEqual([2]);
  });
});

// A wolf placed in the Bannered Mare fights the five patrons: the fight runs in game time, the
// step never waits on itself (the bard's songs, each ended at once by combat, restarted from their
// end fragments within one step until the heap ran out), and the heap stays bounded. It is placed
// among them, at Saadia: placed at the player, by the inn's door, it fights the player, a fight
// the patrons stay out of (it went for a patron there only while its ray for the ground met the
// player's controller and set it on the player's head).

const BANNERED_MARE = 0x1605e;
/** Saadia [000D7505], one of the patrons. */
const SAADIA = 0xd7505;

describe.skipIf(!hasGamedata())('a fight in the Bannered Mare (headless simulation)', () => {
  let sim: Sim;
  let wolf = 0;
  let realMs = 0;
  let heapGrowth = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    wolf = await sim.place(await sim.formId('NPC_', 'EncWolf'), SAADIA);
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
