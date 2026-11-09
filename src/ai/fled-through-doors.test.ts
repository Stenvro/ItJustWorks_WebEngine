import { describe, expect, it } from 'vitest';
import { FledFlights, FledThroughDoors } from './fled-through-doors.ts';

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

describe('fled fights across a load or New Game', () => {
  const combat = (holds: (resumes: number) => boolean) => {
    const targets = new Map<number, number>();
    const started: number[] = [];
    const resumed: number[] = [];
    return {
      started,
      resumed,
      targetOf: (actor: number) => targets.get(actor),
      startCombat: (actor: number, target: number) => {
        started.push(actor);
        targets.set(actor, target);
      },
      resumeFlight: (actor: number) => {
        resumed.push(actor);
        return holds(resumed.length);
      },
    };
  };

  it('starts the fled fight once and flees on once it took hold', () => {
    const flights = new FledFlights();
    flights.went(BANDIT, { enemy: PLAYER, door: FAR_DOOR, modifier: -0.5, boost: 1, keep: 30 });
    // The fight takes hold on the second try.
    const fights = combat((resumes) => resumes > 1);
    flights.update(1, () => true, fights);
    expect(fights.started).toEqual([BANDIT]);
    expect(fights.resumed).toEqual([BANDIT]);
    flights.update(0.1, () => true, fights);
    expect(fights.started).toEqual([BANDIT]);
    expect(fights.resumed).toEqual([BANDIT, BANDIT]);
    flights.update(0.1, () => true, fights);
    expect(fights.resumed).toHaveLength(2);
  });

  it('forces no fight carried from the game left on the game loaded', () => {
    const flights = new FledFlights();
    flights.went(BANDIT, { enemy: PLAYER, door: FAR_DOOR, modifier: -0.5, boost: 1, keep: 30 });
    // The bandit fled 5 s ago, the player still on this side; then a save made here is loaded.
    flights.update(
      5,
      () => false,
      combat(() => true),
    );
    flights.clear();
    // The loaded game's bandit and player are both here within the keep time: no fight.
    const fights = combat(() => true);
    flights.update(1, () => true, fights);
    expect(fights.started).toEqual([]);
    expect(fights.resumed).toEqual([]);
  });

  it('drops a fight started again but not yet taken hold as well', () => {
    const flights = new FledFlights();
    flights.went(BANDIT, { enemy: PLAYER, door: FAR_DOOR, modifier: undefined, boost: 0 });
    const before = combat(() => false);
    flights.update(1, () => true, before);
    expect(before.started).toEqual([BANDIT]);
    flights.clear();
    // In the loaded game the bandit flees through the door again: that fight is started anew.
    flights.went(BANDIT, { enemy: PLAYER, door: FAR_DOOR, modifier: undefined, boost: 0 });
    const after = combat(() => true);
    flights.update(1, () => true, after);
    expect(after.started).toEqual([BANDIT]);
  });
});
