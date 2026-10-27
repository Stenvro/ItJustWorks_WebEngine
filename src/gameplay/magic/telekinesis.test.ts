import { describe, expect, it } from 'vitest';
import {
  beginTelekinesis,
  stepTelekinesis,
  TELEKINESIS_DEFAULTS,
  telekinesisDamage,
  telekinesisDamageMult,
  telekinesisReach,
  telekinesisThrowSpeed,
} from './telekinesis.ts';

describe('telekinesis', () => {
  it('reaches its base distance in feet × fMagicUnitsPerFoot', () => {
    expect(telekinesisReach(2100)).toBe(2100 * 22);
    expect(telekinesisReach(10, { unitsPerFoot: 21 })).toBe(210);
  });

  it('pulls the object in, faster and faster, to fMagicTelekinesisDistanceMin', () => {
    const hold = beginTelekinesis(1000);
    stepTelekinesis(hold, 0.5, 46200);
    // Its speed: 50 + 400 × 0.5 = 250, so 125 units nearer.
    expect(hold.speed).toBe(250);
    expect(hold.distance).toBe(875);
    expect(hold.phase).toBe('pulling');
    for (let i = 0; i < 20; i++) stepTelekinesis(hold, 0.5, 46200);
    expect(hold.speed).toBe(0);
    expect(hold.phase).toBe('held');
    expect(hold.distance).toBe(TELEKINESIS_DEFAULTS.distanceMin);
  });

  it('holds it no farther than its reach', () => {
    const hold = beginTelekinesis(5000);
    stepTelekinesis(hold, 0.1, 1000);
    expect(hold.distance).toBe(1000);
  });

  it('throws it held (its throw gathered), drops it while it is pulled in', () => {
    const hold = beginTelekinesis(70);
    stepTelekinesis(hold, 0.1, 46200);
    expect(hold.phase).toBe('held');
    expect(telekinesisThrowSpeed(hold, false)).toBeUndefined();
    stepTelekinesis(hold, 1, 46200);
    expect(telekinesisThrowSpeed(hold, false)).toBe(1010);
    expect(telekinesisThrowSpeed(hold, true)).toBe(2020);
    for (let i = 0; i < 10; i++) stepTelekinesis(hold, 1, 46200);
    expect(telekinesisThrowSpeed(hold, false)).toBe(1030);
    expect(telekinesisThrowSpeed(beginTelekinesis(500), false)).toBeUndefined();
  });
});

describe('a thrown object’s damage', () => {
  it('deals its collision’s damage plus fMagicTelekinesisDamageBase (5), × the throw’s multiplier', () => {
    expect(telekinesisDamage(0, telekinesisDamageMult(false))).toBe(5);
    expect(telekinesisDamage(3, telekinesisDamageMult(true))).toBe(16);
  });
});
