import { describe, expect, it } from 'vitest';
import { noWaitReason } from './sleep-wait-menu.ts';

describe('why the player may not wait', () => {
  const free = { waitingDisabled: false, inAir: false };

  it('lets them wait when nothing stops it', () => {
    expect(noWaitReason(false, free)).toBeUndefined();
  });

  it('names the wait and the sleep versions of each reason', () => {
    expect(noWaitReason(false, { ...free, enemiesNear: true })).toBe('sNoWaitHostileActorsNear');
    expect(noWaitReason(true, { ...free, enemiesNear: true })).toBe('sNoSleepHostileActorsNear');
    expect(noWaitReason(false, { ...free, takingHealthDamage: true })).toBe(
      'sNoWaitTakingHealthDamage',
    );
    expect(noWaitReason(true, { ...free, pursued: true })).toBe('sNoSleepWhileAlarm');
    expect(noWaitReason(false, { ...free, trespassing: true })).toBe('sNoWaitTrespass');
  });

  it('gives scripts and the air first', () => {
    expect(noWaitReason(false, { waitingDisabled: true, inAir: true, enemiesNear: true })).toBe(
      'sNoWaitDefault',
    );
    expect(noWaitReason(false, { ...free, inAir: true, enemiesNear: true })).toBe('sNoWaitInAir');
  });
});
