import { describe, expect, it } from 'vitest';
import {
  raceAdvancedAvoidance,
  raceAvoidsRoads,
  raceImmobile,
  raceOpensDoors,
  racePushable,
} from './race-ai-flags.ts';
import { RaceAiFlag, RaceFlag2 } from './race-combat-records.ts';

describe('the race DATA flags of movement and pathing', () => {
  it('reads each flag from its bit (xEdit, CommonLibSSE RACE_DATA)', () => {
    // A wolf: Can't Open Doors; a person: none of them.
    expect(raceOpensDoors(RaceAiFlag.cantOpenDoors)).toBe(false);
    expect(raceOpensDoors(0)).toBe(true);
    expect(racePushable(RaceAiFlag.notPushable)).toBe(false);
    expect(racePushable(RaceAiFlag.cantOpenDoors)).toBe(true);
    expect(raceImmobile(RaceAiFlag.immobile)).toBe(true);
    expect(raceImmobile(0)).toBe(false);
    // Avoids Roads is the top bit (0x80000000): read unsigned or signed alike.
    expect(raceAvoidsRoads(RaceAiFlag.avoidsRoads | 0)).toBe(true);
    expect(raceAvoidsRoads(RaceAiFlag.avoidsRoads)).toBe(true);
    expect(raceAvoidsRoads(RaceAiFlag.cantOpenDoors)).toBe(false);
    expect(raceAdvancedAvoidance(RaceFlag2.useAdvancedAvoidance)).toBe(true);
    expect(raceAdvancedAvoidance(RaceFlag2.nonHostile)).toBe(false);
  });
});
