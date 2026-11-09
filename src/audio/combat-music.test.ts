import { describe, expect, it } from 'vitest';
import { actorStrength, strengthDamage } from '../ai/combat-ai.ts';
import {
  CombatMusic,
  combatMusicWanted,
  evenFight,
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

  it('counts a fight not against the player only once it is even (fCombatMusicGroupThreatRatio*)', () => {
    expect(evenFight(1000, 400, settings)).toBe(false); // guards against a mudcrab: 0.4
    expect(evenFight(1000, 600, settings)).toBe(true);
    expect(evenFight(1000, 1999, settings)).toBe(true);
    expect(evenFight(1000, 2000, settings)).toBe(false); // a dragon over two guards
    const player = 1000;
    const near = { threats: [threat({ targetsPlayer: false, strength: 1500 })], player };
    // Undecided until the group threat ratio timer: nothing.
    const music = new CombatMusic(settings);
    expect(music.update(0.1, { ...near, nearTargets: 1500 })).toBe('none');
    expect(music.update(settings.groupThreatRatioTimer, { ...near, nearTargets: 1500 })).toBe(
      'combat',
    );
    // A lopsided one never counts; it is decided once.
    const lopsided = new CombatMusic(settings);
    lopsided.update(0.1, { ...near, nearTargets: 100 });
    expect(lopsided.update(settings.groupThreatRatioTimer, { ...near, nearTargets: 100 })).toBe(
      'none',
    );
    expect(lopsided.update(settings.updateTime, { ...near, nearTargets: 1500 })).toBe('none');
  });

  it('weighs each combat group near the player apart', () => {
    const player = 1000;
    // Two fights near the player, each weaker than them: together they would pass the player's
    // strength, apart neither does.
    const a = threat({ targetsPlayer: false, strength: 600, group: 1 });
    const b = threat({ targetsPlayer: false, strength: 600, group: 2 });
    expect(combatMusicWanted({ threats: [a, b], player }, settings, false)).toBe('none');
    // One of them strong enough: it counts on its own.
    const strong = { ...b, strength: 1200 };
    expect(combatMusicWanted({ threats: [a, strong], player }, settings, false)).toBe('combat');
    // Each decides its own evenness by its own targets: guards against a mudcrab (group 2)
    // stay out while a dragon against the guards (group 1, even) counts.
    const dragon = threat({ targetsPlayer: false, strength: 1500, group: 1 });
    const guards = threat({ targetsPlayer: false, strength: 1500, group: 2 });
    const fights = {
      threats: [dragon, guards],
      player,
      groupTargets: new Map([
        [1, 1500],
        [2, 50],
      ]),
    };
    const music = new CombatMusic(settings);
    music.update(0.1, fights);
    expect(music.update(settings.groupThreatRatioTimer, fights)).toBe('combat');
    const lopsided = new CombatMusic(settings);
    const onlyGuards = { ...fights, threats: [guards] };
    lopsided.update(0.1, onlyGuards);
    expect(lopsided.update(settings.groupThreatRatioTimer, onlyGuards)).toBe('none');
    // A second group forming later is decided after its own timer, not the first's.
    const later = new CombatMusic(settings);
    const first = { ...fights, threats: [guards] };
    later.update(0.1, first);
    later.update(settings.groupThreatRatioTimer * 2, first);
    expect(later.playing).toBe('none');
    expect(later.update(settings.updateTime, fights)).toBe('none');
    expect(later.update(settings.groupThreatRatioTimer, fights)).toBe('combat');
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
