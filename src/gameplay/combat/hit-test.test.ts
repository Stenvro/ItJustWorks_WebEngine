import { describe, expect, it } from 'vitest';
import {
  blockCovers,
  hitDirection,
  meleeReach,
  strikeContact,
  strikeTargets,
  type Strike,
  type StrikeTarget,
} from './hit-test.ts';

const reachSettings = { combatDistance: 141, combatBashReach: 141 };

/** An attacker at the origin facing north (+Y), a sword's reach. */
const strike: Strike = {
  origin: [0, 0, 0],
  heading: 0,
  height: 128,
  reach: 141,
  attackAngle: 0,
  strikeAngle: 50,
};

const target = (reference: number, x: number, y: number, z = 0): StrikeTarget => ({
  reference,
  feet: [x, y, z],
  radius: 20,
  height: 128,
});

describe('reach', () => {
  it('is fCombatDistance × the weapon reach, fCombatBashReach for bashes, the race for fists', () => {
    expect(
      meleeReach({ weaponReach: 1, bash: false, unarmedReach: 96, scale: 1 }, reachSettings),
    ).toBe(141);
    expect(
      meleeReach({ weaponReach: 1.3, bash: false, unarmedReach: 96, scale: 1 }, reachSettings),
    ).toBeCloseTo(183.3);
    expect(
      meleeReach({ weaponReach: 0.7, bash: true, unarmedReach: 96, scale: 1 }, reachSettings),
    ).toBe(141);
    expect(
      meleeReach(
        { weaponReach: undefined, bash: false, unarmedReach: 96, scale: 1.1 },
        reachSettings,
      ),
    ).toBeCloseTo(105.6);
  });
});

describe('strikes', () => {
  it('hit a target within reach (to its shape) and inside the strike angle', () => {
    expect(strikeContact(strike, target(1, 0, 150))?.distance).toBeCloseTo(130);
    // Beyond the reach plus its radius.
    expect(strikeContact(strike, target(1, 0, 170))).toBeUndefined();
    // 45° off the facing: inside 50°; 80° off: outside (its width only widens it a little).
    expect(strikeContact(strike, target(1, 70, 70))).toBeDefined();
    expect(strikeContact(strike, target(1, 120, 21))).toBeUndefined();
    // Behind the attacker.
    expect(strikeContact(strike, target(1, 0, -100))).toBeUndefined();
  });

  it('turn the cone by the attack angle (mounted side swings)', () => {
    const right: Strike = { ...strike, attackAngle: 90, strikeAngle: 85 };
    expect(strikeContact(right, target(1, 120, 0))).toBeDefined();
    expect(strikeContact(right, target(1, -120, 0))).toBeUndefined();
  });

  it('need the heights to overlap', () => {
    expect(strikeContact(strike, target(1, 0, 100, 400))).toBeUndefined();
    expect(strikeContact(strike, target(1, 0, 100, 40))).toBeDefined();
  });

  it('hit the nearest, or all of them with Sweep', () => {
    const targets = [target(1, 0, 140), target(2, 10, 80), target(3, 0, 400)];
    expect(strikeTargets(strike, targets).map((contact) => contact.target.reference)).toEqual([2]);
    expect(strikeTargets(strike, targets, true).map((contact) => contact.target.reference)).toEqual(
      [2, 1],
    );
  });
});

describe('blocks and hit directions', () => {
  it('cover hits from within the cone in front', () => {
    expect(blockCovers([0, 0, 0], 0, [10, 100, 0], 35)).toBe(true);
    expect(blockCovers([0, 0, 0], 0, [100, 10, 0], 35)).toBe(false);
    expect(blockCovers([0, 0, 0], Math.PI / 2, [100, 10, 0], 35)).toBe(true);
  });

  it('give where the blow came from in turns, clockwise from the facing', () => {
    expect(hitDirection([0, 0, 0], 0, [0, 100, 0])).toBeCloseTo(0);
    expect(hitDirection([0, 0, 0], 0, [100, 0, 0])).toBeCloseTo(0.25);
    expect(hitDirection([0, 0, 0], 0, [0, -100, 0])).toBeCloseTo(0.5);
    expect(hitDirection([0, 0, 0], 0, [-100, 0, 0])).toBeCloseTo(0.75);
  });
});
