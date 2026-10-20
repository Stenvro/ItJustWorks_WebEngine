import { describe, expect, it } from 'vitest';
import {
  shoutMeterPercent,
  shoutRecovery,
  wordsAvailable,
  wordsByHold,
  wordToUnlock,
} from './shouts.ts';

// Unrelenting Force's words (Fus, Ro, Dah) and recovery times (SHOU SNAM: 15, 20, 45 seconds).
const FUS = [
  { word: 0x13e22, spell: 0x13e09, recovery: 15 },
  { word: 0x13e23, spell: 0x13f39, recovery: 20 },
  { word: 0x13e24, spell: 0x13f3a, recovery: 45 },
];

describe('shout words', () => {
  it('are known in a row from the first', () => {
    expect(wordsAvailable(FUS, () => true)).toBe(3);
    expect(wordsAvailable(FUS, (word) => word === 0x13e22)).toBe(1);
    // The second without the first is not shouted.
    expect(wordsAvailable(FUS, (word) => word === 0x13e23)).toBe(0);
  });

  it('come by the time the voice key is held (fShoutTime1, fShoutTime2)', () => {
    expect(wordsByHold(0.05, 3)).toBe(1);
    expect(wordsByHold(0.2, 3)).toBe(2);
    expect(wordsByHold(0.5, 3)).toBe(2);
    expect(wordsByHold(0.9, 3)).toBe(3);
    expect(wordsByHold(5, 2)).toBe(2);
    expect(wordsByHold(5, 0)).toBe(0);
    expect(wordsByHold(0.3, 3, { time1: 0.4, time2: 1 })).toBe(1);
  });

  it("let the voice recover by the last word's time less ShoutRecoveryMult", () => {
    expect(shoutRecovery(FUS, 1, 0)).toBe(15);
    expect(shoutRecovery(FUS, 3, 0)).toBe(45);
    // The Blessing of Talos: 20 % less.
    expect(shoutRecovery(FUS, 2, 0.2)).toBeCloseTo(16, 9);
    expect(shoutRecovery(FUS, 0, 0)).toBe(0);
  });

  it("fill the HUD's shout meter as the voice recovers", () => {
    expect(shoutMeterPercent(0, 0)).toBe(100);
    expect(shoutMeterPercent(45, 45)).toBe(0);
    expect(shoutMeterPercent(15, 20)).toBe(25);
    expect(shoutMeterPercent(0, 20)).toBe(100);
  });

  it('are unlocked by a dragon soul: the first learned and locked', () => {
    const learned = new Map<number, boolean>([
      [0x13e22, true],
      [0x13e23, false],
    ]);
    const state = (word: number): boolean | 'locked' => {
      const value = learned.get(word);
      return value === undefined ? false : value ? true : 'locked';
    };
    expect(wordToUnlock(FUS, state)).toBe(0x13e23);
    learned.set(0x13e23, true);
    expect(wordToUnlock(FUS, state)).toBeUndefined();
  });
});
