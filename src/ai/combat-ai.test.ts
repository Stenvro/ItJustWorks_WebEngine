import { describe, expect, it } from 'vitest';
import {
  acceptsYield,
  actorStrength,
  aggroResponse,
  Aggression,
  Assistance,
  assists,
  attacksOnSight,
  COMBAT_AI_DEFAULTS,
  Confidence,
  confidenceModifier,
  daresHelp,
  fleeHealth,
  readCombatAiSettings,
  selectTarget,
  shouldFlee,
  threatRatio,
  turnsOnAttacker,
  yields,
  type TargetCandidate,
} from './combat-ai.ts';
import { FightReaction } from './combat-reactions.ts';

const settings = COMBAT_AI_DEFAULTS;

const candidate = (reference: number, more: Partial<TargetCandidate> = {}): TargetCandidate => ({
  reference,
  distance: 512,
  detected: true,
  attacking: false,
  threat: 100,
  ...more,
});

describe('combat AI: entering combat', () => {
  it('attacks on sight by aggression and reaction', () => {
    const { enemy, neutral, ally, friend } = FightReaction;
    expect(
      [enemy, neutral, ally, friend].map((r) => attacksOnSight(Aggression.unaggressive, r)),
    ).toEqual([false, false, false, false]);
    expect(
      [enemy, neutral, ally, friend].map((r) => attacksOnSight(Aggression.aggressive, r)),
    ).toEqual([true, false, false, false]);
    expect(
      [enemy, neutral, ally, friend].map((r) => attacksOnSight(Aggression.veryAggressive, r)),
    ).toEqual([true, true, false, false]);
    expect(
      [enemy, neutral, ally, friend].map((r) => attacksOnSight(Aggression.frenzied, r)),
    ).toEqual([true, true, true, true]);
  });

  it('helps allies, or friends and allies, by assistance', () => {
    const { enemy, neutral, ally, friend } = FightReaction;
    const helps = (assistance: number): boolean[] =>
      [enemy, neutral, ally, friend].map((r) => assists(assistance, r));
    expect(helps(Assistance.helpsNobody)).toEqual([false, false, false, false]);
    expect(helps(Assistance.helpsAllies)).toEqual([false, false, true, false]);
    expect(helps(Assistance.helpsFriendsAndAllies)).toEqual([false, false, true, true]);
  });

  it('turns on an attacker at once, on a friend or ally after the blows it lets pass', () => {
    expect(turnsOnAttacker(FightReaction.neutral, 1, false, settings)).toBe(true);
    expect(turnsOnAttacker(FightReaction.enemy, 1, true, settings)).toBe(true);
    // A friend: iFriendHitCombatAllowed 4 in combat (the fifth blow), none out of it.
    expect(turnsOnAttacker(FightReaction.friend, 4, true, settings)).toBe(false);
    expect(turnsOnAttacker(FightReaction.friend, 5, true, settings)).toBe(true);
    expect(turnsOnAttacker(FightReaction.friend, 1, false, settings)).toBe(true);
    // An ally: any number in combat (iAllyHitCombatAllowed 1000), three out of it.
    expect(turnsOnAttacker(FightReaction.ally, 50, true, settings)).toBe(false);
    expect(turnsOnAttacker(FightReaction.ally, 3, false, settings)).toBe(false);
    expect(turnsOnAttacker(FightReaction.ally, 4, false, settings)).toBe(true);
  });

  it('warns within its aggro radius before it attacks', () => {
    const radii = [1000, 600, 200] as const;
    expect(aggroResponse(1200, radii, 0)).toBe('ignore');
    expect(aggroResponse(800, radii, 5)).toBe('warn');
    expect(aggroResponse(500, radii, 0)).toBe('warn');
    expect(aggroResponse(500, radii, 2)).toBe('attack');
    expect(aggroResponse(150, radii, 0)).toBe('attack');
  });

  it('reads the load order settings by name, the engine values otherwise', () => {
    const read = readCombatAiSettings((name) =>
      name === 'fConfidenceAverage' ? 0.2 : name === 'iFriendHitCombatAllowed' ? 2 : undefined,
    );
    expect(read.fleeHealthAverage).toBe(0.2);
    expect(read.friendHitCombatAllowed).toBe(2);
    expect(read.fleeHealthCautious).toBe(0.375);
    expect(read.fleeDistanceExterior).toBe(5000);
  });
});

describe('combat AI: target selection', () => {
  it('takes the nearest of equal threats', () => {
    expect(
      selectTarget([candidate(1, { distance: 900 }), candidate(2, { distance: 300 })], undefined),
    ).toBe(2);
  });

  it('weighs threat against distance', () => {
    const strong = candidate(1, { distance: 800, threat: 1000 });
    const weak = candidate(2, { distance: 300, threat: 100 });
    expect(selectTarget([strong, weak], undefined)).toBe(1);
  });

  it('keeps its current target for a little, and turns to one attacking it', () => {
    const current = candidate(1, { distance: 600 });
    const nearer = candidate(2, { distance: 500 });
    expect(selectTarget([current, nearer], 1)).toBe(1);
    expect(selectTarget([current, nearer], undefined)).toBe(2);
    // Much nearer: it switches.
    expect(selectTarget([current, candidate(2, { distance: 20 })], 1)).toBe(2);
    // One attacking it counts more.
    expect(selectTarget([candidate(1), candidate(2, { attacking: true })], undefined)).toBe(2);
  });

  it('counts a target it lost less than one it sees', () => {
    const lost = candidate(1, { distance: 100, detected: false });
    const seen = candidate(2, { distance: 700 });
    expect(selectTarget([lost, seen], undefined)).toBe(2);
    expect(selectTarget([], undefined)).toBeUndefined();
  });

  it('weighs the odds into a confidence modifier', () => {
    expect(threatRatio([], [100])).toBe(0);
    expect(threatRatio([100, 100], [100])).toBe(2);
    expect(confidenceModifier(0, settings)).toBe(1);
    expect(confidenceModifier(1, settings)).toBe(0);
    expect(confidenceModifier(3, settings)).toBe(-0.25);
    expect(actorStrength(50, 10)).toBe(500);
  });
});

describe('combat AI: fleeing and yielding', () => {
  it('flees below its confidence share of health', () => {
    expect(fleeHealth(Confidence.cowardly, settings)).toBe(1);
    expect(fleeHealth(Confidence.cautious, settings)).toBe(0.375);
    expect(fleeHealth(Confidence.average, settings)).toBe(0.15);
    expect(fleeHealth(Confidence.brave, settings)).toBe(0.0375);
    expect(fleeHealth(Confidence.foolhardy, settings)).toBe(0);
  });

  it('flees by confidence, health, odds, fear and rally', () => {
    const base = { health: 0.3, modifier: 0, afraid: false, rallied: false };
    const flees = (confidence: number, more: Partial<typeof base> = {}): boolean =>
      shouldFlee({ ...base, confidence, ...more }, settings);
    expect(flees(Confidence.cowardly, { health: 1 })).toBe(true);
    expect(flees(Confidence.cautious)).toBe(true);
    expect(flees(Confidence.average)).toBe(false);
    expect(flees(Confidence.average, { health: 0.1 })).toBe(true);
    expect(flees(Confidence.brave, { health: 0.1 })).toBe(false);
    expect(flees(Confidence.foolhardy, { health: 0.01 })).toBe(false);
    // Outnumbered (modifier −0.25) it flees sooner; winning (0.5), later.
    expect(flees(Confidence.average, { health: 0.17, modifier: -0.25 })).toBe(true);
    expect(flees(Confidence.average, { health: 0.1, modifier: 0.5 })).toBe(false);
    // Fear makes even the foolhardy flee; rally keeps the cowardly.
    expect(flees(Confidence.foolhardy, { afraid: true })).toBe(true);
    expect(flees(Confidence.cowardly, { rallied: true })).toBe(false);
  });

  it('yields to the player in a fight that is not theirs to hate, once in a while', () => {
    const input = {
      fightsPlayer: true,
      playerEnemy: false,
      wouldFlee: true,
      sinceLastYield: Infinity,
      settings,
    };
    expect(yields(input)).toBe(true);
    expect(yields({ ...input, playerEnemy: true })).toBe(false);
    expect(yields({ ...input, wouldFlee: false })).toBe(false);
    expect(yields({ ...input, sinceLastYield: 5 })).toBe(false);
    expect(acceptsYield({ fightsPlayer: true, playerEnemy: false, heldOff: 4, settings })).toBe(
      true,
    );
    expect(acceptsYield({ fightsPlayer: true, playerEnemy: false, heldOff: 1, settings })).toBe(
      false,
    );
    expect(acceptsYield({ fightsPlayer: true, playerEnemy: true, heldOff: 9, settings })).toBe(
      false,
    );
  });
});

describe('taking up a fight', () => {
  it('lets confidence decide who helps against a criminal (UESP "Confidence")', () => {
    const weak = { level: 1, strength: 100 };
    const townsman = { level: 6, strength: 400 };
    const veteran = { level: 20, strength: 3000 };
    // A level-1 player who struck a townsman: all but the cowardly take them on.
    expect(daresHelp(Confidence.cowardly, townsman, weak)).toBe(false);
    expect(daresHelp(Confidence.cautious, townsman, weak)).toBe(true);
    expect(daresHelp(Confidence.brave, townsman, weak)).toBe(true);
    // A veteran: the cautious and the average keep away, the brave are outmatched.
    expect(daresHelp(Confidence.cautious, townsman, veteran)).toBe(false);
    expect(daresHelp(Confidence.average, townsman, veteran)).toBe(false);
    expect(daresHelp(Confidence.brave, townsman, veteran)).toBe(false);
    expect(daresHelp(Confidence.foolhardy, townsman, veteran)).toBe(true);
    // Average: one of its own level, not higher.
    expect(daresHelp(Confidence.average, townsman, townsman)).toBe(true);
  });
});
