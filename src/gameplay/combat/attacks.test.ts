import { describe, expect, it } from 'vitest';
import { AttackFlag, type AttackData } from '../../ai/race-combat-records.ts';
import { chooseAttackData, DEFAULT_ATTACK, type AttackChoiceContext } from './attacks.ts';

const attack = (event: string, extra: Partial<AttackData> = {}): AttackData => ({
  ...DEFAULT_ATTACK,
  event,
  ...extra,
});

const context: AttackChoiceContext = {
  targetStaggered: false,
  targetBlockingFacing: false,
  targetDead: false,
  bearing: 0,
  attackStaggeredMult: 1,
  powerAttackStaggeredMult: 1,
  powerAttackBlockingMult: 1,
  strikeAngleMult: 0.67,
  deadConeMult: 2,
  recovering: () => false,
};

/** A random sequence (each call the next value). */
const sequence =
  (...values: number[]): (() => number) =>
  () =>
    values.shift() ?? 0;

describe('chooseAttackData', () => {
  it('picks by weight and takes the pick with its weight as the chance', () => {
    const bite = attack('attackStart_Bite1', { attackChance: 0.3 });
    const chop = attack('AttackStart_LeftChop', { attackChance: 0.6 });
    // Pick 0.2 of 0.9: the bite; its roll 0.1 is under 0.3: taken.
    expect(chooseAttackData([bite, chop], context, sequence(0.2, 0.1))).toBe(bite);
    // The bite's roll fails (0.5): dropped; the chop is picked and taken.
    expect(chooseAttackData([bite, chop], context, sequence(0.2, 0.5, 0, 0.1))).toBe(chop);
    // Both rolls fail: none.
    expect(chooseAttackData([bite, chop], context, sequence(0.2, 0.9, 0, 0.9))).toBeUndefined();
  });

  it('leaves out attacks that recover and weighs by the style against a staggered target', () => {
    const plain = attack('attackStart', { attackChance: 0.5 });
    const power = attack('attackPowerStart', { attackChance: 0.5, flags: AttackFlag.powerAttack });
    const recovering = { ...context, recovering: (a: AttackData) => a === plain };
    expect(chooseAttackData([plain, power], recovering, sequence(0, 0))).toBe(power);
    // The style makes plain attacks on a staggered target worthless.
    const staggered = { ...context, targetStaggered: true, attackStaggeredMult: 0 };
    expect(chooseAttackData([plain, power], staggered, sequence(0, 0))).toBe(power);
  });

  it('takes an attack only for a target within its strike angle about its attack angle', () => {
    const ahead = attack('attackStart', { attackChance: 1, strikeAngle: 35 });
    const left = attack('attackLeft', { attackChance: 1, strikeAngle: 35, attackAngle: -90 });
    const side = { ...context, bearing: (-80 * Math.PI) / 180 };
    // 80° to the left: beyond the forward attack's 23.45°, within the left one's.
    expect(chooseAttackData([ahead, left], side, sequence(0, 0, 0, 0))).toBe(left);
    const beyond = { ...context, bearing: (30 * Math.PI) / 180 };
    expect(chooseAttackData([ahead], beyond, sequence(0, 0))).toBeUndefined();
    // A corpse's cone is twice as wide.
    expect(chooseAttackData([ahead], { ...beyond, targetDead: true }, sequence(0, 0))).toBe(ahead);
  });
});
