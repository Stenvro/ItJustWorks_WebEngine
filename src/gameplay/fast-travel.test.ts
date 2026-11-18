import { describe, expect, it } from 'vitest';
import { fastTravelDistance, fastTravelHours, noFastTravelReason } from './fast-travel.ts';

const free = { enabled: true, placeForbids: false, inAir: false, carried: 10, carryWeight: 300 };

describe('fast travel', () => {
  it('says why the player may not go', () => {
    expect(noFastTravelReason(free)).toBeUndefined();
    expect(noFastTravelReason({ ...free, enabled: false })).toBe('sNoFastTravelScriptBlock');
    expect(noFastTravelReason({ ...free, placeForbids: true })).toBe('sNoFastTravelCell');
    expect(noFastTravelReason({ ...free, inAir: true })).toBe('sNoFastTravelInAir');
    expect(noFastTravelReason({ ...free, carried: 301 })).toBe('sNoFastTravelOverencumbered');
    expect(noFastTravelReason({ ...free, inCombat: true })).toBe('sNoFastTravelCombat');
    expect(noFastTravelReason({ ...free, hostilesNear: true })).toBe(
      'sNoFastTravelHostileActorsNear',
    );
    expect(noFastTravelReason({ ...free, takingHealthDamage: true })).toBe(
      'sFastTravelNoTravelHealthDamage',
    );
    expect(noFastTravelReason({ ...free, pursued: true })).toBe('sNoFastTravelAlarm');
  });

  it('takes the time walking there takes, at the timescale', () => {
    // 72000 units at 80 a second: 900 s, twenty times faster on the game's clock: 5 hours.
    expect(fastTravelHours(72000, 80, 1, 20)).toBeCloseTo(5, 6);
    expect(fastTravelHours(72000, 80, 2, 20)).toBeCloseTo(2.5, 6);
    expect(fastTravelHours(0, 80, 1, 20)).toBe(0);
    expect(fastTravelHours(1000, 0, 1, 20)).toBe(0);
  });

  it("measures the way from a city's own worldspace across its parent's map", () => {
    // WhiterunWorld (0x1a26f) shows Tamriel's (0x3c) map; Sovngarde (0x2ee41) its own.
    const mapWorldOf = (world: number): number => (world === 0x1a26f ? 0x3c : world);
    const city = { world: 0x1a26f, position: [19855, -7423, -3583] };
    const cairn = { world: 0x3c, position: [-17455, 17676, -6320] };
    expect(fastTravelDistance(city, cairn, mapWorldOf)).toBeCloseTo(
      Math.hypot(19855 + 17455, -7423 - 17676),
      6,
    );
    expect(fastTravelDistance(cairn, city, mapWorldOf)).toBeGreaterThan(40000);
    expect(fastTravelDistance(city, { world: 0x2ee41, position: [0, 0] }, mapWorldOf)).toBe(0);
    expect(fastTravelDistance({ world: undefined, position: [0, 0] }, cairn, mapWorldOf)).toBe(0);
  });
});
