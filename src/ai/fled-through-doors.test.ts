import { describe, expect, it } from 'vitest';
import { FledThroughDoors } from './fled-through-doors.ts';

const PLAYER = 0x14;
const BANDIT = 0xbad;
const FAR_DOOR = 0xd02;

describe('flight past a load door', () => {
  it('takes the fight up on the other side once the fled actor and its enemy are both there', () => {
    const fled = new FledThroughDoors();
    fled.went(BANDIT, { enemy: PLAYER, door: FAR_DOOR, modifier: -0.5, boost: 1, keep: 30 });
    const here = new Set<number>([PLAYER]);
    const present = (reference: number) => here.has(reference);
    // The player still on this side, the bandit gone through: nothing yet.
    expect(fled.update(5, present)).toEqual([]);
    expect(fled.carries(BANDIT)).toBe(true);
    // The player follows: the bandit is placed on the far side with them, 12 s after it fled.
    here.add(BANDIT);
    const due = fled.update(7, present);
    expect(due).toEqual([
      { actor: BANDIT, enemy: PLAYER, door: FAR_DOOR, modifier: -0.5, boost: 1, ago: 12 },
    ]);
    // Handed out until taken (its actor may not be ready to fight in this frame).
    expect(fled.update(0.1, present)).toHaveLength(1);
    fled.taken(BANDIT);
    expect(fled.update(0.1, present)).toEqual([]);
    expect(fled.carries(BANDIT)).toBe(false);
  });

  it('is over once its side would have given its enemy up (fCombatDetectionFleeingLostRemoveTime)', () => {
    const fled = new FledThroughDoors();
    fled.went(BANDIT, { enemy: PLAYER, door: FAR_DOOR, modifier: undefined, boost: 0, keep: 30 });
    expect(fled.update(29, () => false)).toEqual([]);
    expect(fled.carries(BANDIT)).toBe(true);
    expect(fled.update(2, () => false)).toEqual([]);
    expect(fled.carries(BANDIT)).toBe(false);
    // Following later finds a calm actor: nothing is taken up.
    expect(fled.update(1, () => true)).toEqual([]);
  });
});
