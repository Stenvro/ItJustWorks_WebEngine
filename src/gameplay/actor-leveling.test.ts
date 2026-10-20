import { describe, expect, it } from 'vitest';
import {
  actorLevel,
  autoCalcStats,
  leveledPickLevel,
  sharePoints,
  zoneLevel,
} from './actor-leveling.ts';
import { EncounterZoneFlag } from '../world/leveling-records.ts';

/** CombatWarrior1H's weights (CLAS DATA) and the Nord race's start (RACE DATA). */
const WARRIOR = {
  skillWeights: [3, 1, 2, 2, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  healthWeight: 4,
  magickaWeight: 0,
  staminaWeight: 2,
};
const NORD = {
  skillBoosts: [
    { actorValue: 7, bonus: 10 },
    { actorValue: 6, bonus: 5 },
    { actorValue: 9, bonus: 5 },
    { actorValue: 10, bonus: 5 },
    { actorValue: 17, bonus: 5 },
    { actorValue: 12, bonus: 5 },
  ],
  startingHealth: 50,
  startingMagicka: 50,
  startingStamina: 50,
};
const LYDIA = { level: 1000, followsPlayer: true, calcMinLevel: 6, calcMaxLevel: 50 };

describe('auto-calculated stats', () => {
  it("reproduce Lydia's stored stats at her calc min (level 6)", () => {
    const stats = autoCalcStats({
      level: actorLevel(LYDIA, 1),
      weights: WARRIOR,
      race: NORD,
      healthOffset: 50,
      magickaOffset: 0,
      staminaOffset: 0,
    });
    expect([stats.health, stats.magicka, stats.stamina]).toEqual([158, 50, 67]);
    expect(stats.skills.slice(0, 7)).toEqual([31, 29, 22, 27, 20, 26, 20]);
  });

  it('follow the player: Lydia at level 20', () => {
    const stats = autoCalcStats({
      level: actorLevel(LYDIA, 20),
      weights: WARRIOR,
      race: NORD,
      healthOffset: 50,
      magickaOffset: 0,
      staminaOffset: 0,
    });
    expect([stats.health, stats.magicka, stats.stamina]).toEqual([321, 50, 114]);
    expect(stats.skills[0]).toBe(61);
  });

  it('give level 0 five health less (the records of a 0.75 multiplier)', () => {
    const level = actorLevel(
      { level: 750, followsPlayer: true, calcMinLevel: 0, calcMaxLevel: 0 },
      1,
    );
    expect(level).toBe(0);
    const stats = autoCalcStats({
      level,
      weights: WARRIOR,
      race: NORD,
      healthOffset: -25,
      magickaOffset: 0,
      staminaOffset: -25,
    });
    expect([stats.health, stats.stamina]).toEqual([20, 25]);
  });

  it('stop skills at 100', () => {
    const stats = autoCalcStats({
      level: 81,
      weights: WARRIOR,
      race: NORD,
      healthOffset: 0,
      magickaOffset: 0,
      staminaOffset: 0,
    });
    expect(Math.max(...stats.skills)).toBe(100);
  });
});

describe('sharing points', () => {
  it('gives whole rounds, then one point each in turn, none past its weight', () => {
    expect(sharePoints(7, [3, 2], [0, 1])).toEqual([4, 3]);
    expect(sharePoints(4, [1, 0, 2], [2, 0, 1])).toEqual([1, 0, 3]);
    expect(sharePoints(5, [0, 0], [0, 1])).toEqual([0, 0]);
  });
});

describe('levels', () => {
  it('keep an actor within its calc min and max', () => {
    expect(actorLevel(LYDIA, 3)).toBe(6);
    expect(actorLevel(LYDIA, 70)).toBe(50);
    expect(actorLevel({ ...LYDIA, followsPlayer: false, level: 12 }, 70)).toBe(12);
    expect(
      actorLevel({ level: 250, followsPlayer: true, calcMinLevel: 1, calcMaxLevel: 50 }, 40),
    ).toBe(10);
  });

  it("set an encounter zone's level within its range", () => {
    const zone = { minLevel: 6, maxLevel: 30, flags: 0 };
    expect(zoneLevel(zone, 2)).toBe(6);
    expect(zoneLevel(zone, 12)).toBe(12);
    expect(zoneLevel(zone, 45)).toBe(30);
    expect(zoneLevel({ ...zone, flags: EncounterZoneFlag.matchPcBelowMinimum }, 2)).toBe(2);
    expect(zoneLevel({ minLevel: 0, maxLevel: 0, flags: 0 }, 17)).toBe(17);
  });

  it("pick leveled lists at the encounter's level by the level modifier", () => {
    expect(leveledPickLevel(30, undefined)).toBe(30);
    expect(leveledPickLevel(30, 0)).toBe(10);
    expect(leveledPickLevel(30, 1)).toBe(20);
    expect(leveledPickLevel(30, 2)).toBe(30);
    expect(leveledPickLevel(30, 3)).toBe(38);
    expect(leveledPickLevel(1, 0)).toBe(1);
  });
});
