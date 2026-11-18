import { describe, expect, it } from 'vitest';
import { EffectArchetype, EffectFlag } from '../../world/magic-effects.ts';
import {
  ADDICTION_USAGE_MONITOR_THRESHOLD,
  addictionChance,
  addictionTaken,
  USAGE_MONITOR_EFFECT,
  usageMonitorEffect,
} from './addiction.ts';

describe('a potion’s addiction', () => {
  it('asks nothing at a chance of 0, the potion’s chance as it is without a usage monitor', () => {
    expect(addictionChance(0, undefined)).toBeUndefined();
    expect(addictionChance(0, 100)).toBeUndefined();
    expect(addictionChance(0.3, undefined)).toBe(0.3);
  });

  it('takes a monitored potion’s chance from the monitors past fAddictionUsageMonitorThreshold', () => {
    expect(ADDICTION_USAGE_MONITOR_THRESHOLD).toBe(25);
    expect(addictionChance(0.3, 0)).toBeUndefined();
    expect(addictionChance(0.3, 25)).toBeUndefined();
    expect(addictionChance(0.3, 30)).toBeCloseTo(0.05);
    expect(addictionChance(0.3, 30, 10)).toBeCloseTo(0.2);
  });

  it('is taken where the chance in percent is above the roll of 0-99', () => {
    expect(addictionTaken(0.05, 4)).toBe(true);
    expect(addictionTaken(0.05, 5)).toBe(false);
    expect(addictionTaken(1, 99)).toBe(true);
    expect(addictionTaken(0, 0)).toBe(false);
  });

  it('knows the engine’s Usage Monitor Effect: a script effect flagged Recover on self', () => {
    const effect = usageMonitorEffect();
    expect(effect.formId).toBe(USAGE_MONITOR_EFFECT);
    expect(effect.archetype).toBe(EffectArchetype.script);
    expect(effect.flags).toBe(EffectFlag.recover);
    expect([effect.castingType, effect.delivery, effect.skill, effect.actorValue]).toEqual([
      1, 0, -1, -1,
    ]);
  });
});
