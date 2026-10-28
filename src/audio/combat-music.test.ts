import { describe, expect, it } from 'vitest';
import { actorStrength, strengthDamage } from '../ai/combat-ai.ts';
import {
  CombatMusic,
  combatMusicWanted,
  readCombatMusicSettings,
  type CombatMusicThreat,
} from './combat-music.ts';

// Skyrim.esm sets fCombatMusicPlayerTargetedThreatRatio to 1 (the engine's own is 2).
const settings = readCombatMusicSettings((name) =>
  name === 'fCombatMusicPlayerTargetedThreatRatio' ? 1 : undefined,
);

const threat = (overrides: Partial<CombatMusicThreat>): CombatMusicThreat => ({
  targetsPlayer: true,
  distance: 500,
  strength: 100,
  detected: true,
  boss: false,
  ...overrides,
});

describe('combat music', () => {
  it('starts only for a fight worth it (fCombatMusicPlayerTargetedThreatRatio)', () => {
    const player = 1000;
    // A mudcrab against a strong player: no music.
    expect(
      combatMusicWanted({ threats: [threat({ strength: 50 })], player }, settings, false),
    ).toBe('none');
    // Stronger than them: music.
    expect(
      combatMusicWanted({ threats: [threat({ strength: 1001 })], player }, settings, false),
    ).toBe('combat');
    // One the player does not detect does not count.
    expect(
      combatMusicWanted(
        { threats: [threat({ strength: 5000, detected: false })], player },
        settings,
        false,
      ),
    ).toBe('none');
    // Once it plays, the odds turning does not end it.
    expect(combatMusicWanted({ threats: [threat({ strength: 50 })], player }, settings, true)).toBe(
      'combat',
    );
    // A fight not against the player starts it within the inner radius, keeps it to the outer.
    const at = (distance: number) => threat({ targetsPlayer: false, distance, strength: 1001 });
    const inner = settings.nearCombatInnerRadius;
    const outer = settings.nearCombatOuterRadius;
    expect(combatMusicWanted({ threats: [at(inner - 1)], player }, settings, false)).toBe('combat');
    expect(combatMusicWanted({ threats: [at(inner + 1)], player }, settings, false)).toBe('none');
    expect(combatMusicWanted({ threats: [at(outer - 1)], player }, settings, true)).toBe('combat');
    expect(combatMusicWanted({ threats: [at(outer + 1)], player }, settings, true)).toBe('none');
  });

  it('weighs a lone wolf against the player by the engine’s strength', () => {
    // A wolf: 40 health, its bite (5 unarmed × its strongest attack's 1.5), no armour.
    const wolf = actorStrength(40, strengthDamage(5, false, [{ damageMult: 1.5, bash: false }]));
    // A new player: 100 health, an iron sword's 7, its armour taking a third: no music.
    const player = actorStrength(100, 7, 1 / 3);
    expect(player).toBeCloseTo(1050);
    expect(
      combatMusicWanted({ threats: [threat({ strength: wolf })], player }, settings, false),
    ).toBe('none');
    // A pack of four is a fight.
    const pack = [1, 2, 3, 4].map(() => threat({ strength: wolf }));
    expect(combatMusicWanted({ threats: pack, player }, settings, false)).toBe('combat');
  });

  it('plays the boss music against a boss', () => {
    const threats = [threat({}), threat({ boss: true })];
    expect(combatMusicWanted({ threats, player: 100 }, settings, false)).toBe('boss');
  });

  it('weighs the fights every update time and plays on for the stop time once they end', () => {
    const music = new CombatMusic(settings);
    const fight = { threats: [threat({})], player: 50 };
    const over = { threats: [], player: 50 };
    expect(music.update(0.1, fight)).toBe('combat');
    // Not weighed again before the update time.
    expect(music.update(settings.updateTime / 2, over)).toBe('combat');
    expect(music.update(settings.updateTime / 2, over)).toBe('combat');
    expect(music.update(settings.stopTime / 2, over)).toBe('combat');
    // A fight within the stop time keeps it, and the stop time starts again.
    expect(music.update(settings.updateTime, fight)).toBe('combat');
    expect(music.update(settings.updateTime, over)).toBe('combat');
    expect(music.update(settings.stopTime - 0.01, over)).toBe('combat');
    expect(music.update(0.02, over)).toBe('none');
  });
});
