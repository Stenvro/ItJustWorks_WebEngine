import { describe, expect, it } from 'vitest';
import {
  CombatMusic,
  combatMusicWanted,
  readCombatMusicSettings,
  type CombatMusicThreat,
} from './combat-music.ts';

const settings = readCombatMusicSettings((name) =>
  name === 'fCombatMusicPlayerTargetedThreatRatio' ? 1 : undefined,
);

const threat = (overrides: Partial<CombatMusicThreat>): CombatMusicThreat => ({
  targetsPlayer: true,
  distance: 500,
  strength: 100,
  boss: false,
  ...overrides,
});

describe('combat music', () => {
  it('starts only for a fight worth it (fCombatMusicPlayerTargetedThreatRatio)', () => {
    const player = [1000];
    // A mudcrab against a strong player: no music.
    expect(
      combatMusicWanted({ threats: [threat({ strength: 50 })], side: player }, settings, false),
    ).toBe('none');
    // A match for them: music.
    expect(
      combatMusicWanted({ threats: [threat({ strength: 1000 })], side: player }, settings, false),
    ).toBe('combat');
    // Once it plays, the odds turning does not end it.
    expect(
      combatMusicWanted({ threats: [threat({ strength: 50 })], side: player }, settings, true),
    ).toBe('combat');
    // A fight not against the player counts within the near-combat radius only.
    const near = threat({
      targetsPlayer: false,
      distance: settings.nearCombatRadius - 1,
      strength: 1000,
    });
    const far = threat({
      targetsPlayer: false,
      distance: settings.nearCombatRadius + 1,
      strength: 1000,
    });
    expect(combatMusicWanted({ threats: [near], side: player }, settings, false)).toBe('combat');
    expect(combatMusicWanted({ threats: [far], side: player }, settings, false)).toBe('none');
  });

  it('plays the boss music against a boss', () => {
    const threats = [threat({}), threat({ boss: true })];
    expect(combatMusicWanted({ threats, side: [100] }, settings, false)).toBe('boss');
  });

  it('plays on for the stop delay once the fight ends', () => {
    const music = new CombatMusic(settings);
    const fight = { threats: [threat({})], side: [100] };
    const over = { threats: [], side: [100] };
    expect(music.update(0.1, fight)).toBe('combat');
    expect(music.update(settings.stopDelay / 2, over)).toBe('combat');
    // A fight within the delay keeps it, and the delay starts again.
    expect(music.update(0.1, fight)).toBe('combat');
    expect(music.update(settings.stopDelay - 0.01, over)).toBe('combat');
    expect(music.update(0.02, over)).toBe('none');
  });
});
