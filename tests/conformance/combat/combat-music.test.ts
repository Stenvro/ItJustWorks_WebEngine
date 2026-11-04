// Conformance: combat music (engine map: Combat > Combat music). When the combat music plays.
//
// Sources: the engine's defaults: fCombatMusicUpdateTime (1 s), fCombatMusicStopTime (5 s),
// fCombatMusicNearCombatInnerRadius / OuterRadius (2500, 3500), fCombatMusicPlayerTargetedThreat
// Ratio (2), fCombatMusicGroupThreatRatioTimer (1), …GroupThreatRatioMin / Max (0.5, 2),
// fCombatMusicPlayerNearStrengthMult (1), fCombatMusicPlayerCombatStrengthCap (35000); the music
// types (MUSC: MUSCombat, MUSCombatBoss; the Default Object CombatMusic).

import { describe, expect, it } from 'vitest';
import {
  COMBAT_MUSIC_DEFAULTS as S,
  CombatMusic,
  combatMusicWanted,
  evenFight,
  type CombatMusicThreat,
} from '../../../src/audio/combat-music.ts';

const threat = (over: Partial<CombatMusicThreat> = {}): CombatMusicThreat => ({
  targetsPlayer: true,
  distance: 500,
  strength: 100,
  detected: true,
  boss: false,
  ...over,
});

describe('combat music', () => {
  it('plays when the player is targeted and the threat ratio reaches 2  [settings]', () => {
    expect(S.playerTargetedThreatRatio).toBe(2);
    const fight = { threats: [threat()] };
    expect(combatMusicWanted({ ...fight, player: 199 }, S, false)).toBe('combat');
    // A mudcrab does not start it for a player much stronger.
    expect(combatMusicWanted({ ...fight, player: 200 }, S, false)).toBe('none');
    // Once it plays the odds are not weighed again.
    expect(combatMusicWanted({ ...fight, player: 200 }, S, true)).toBe('combat');
  });

  it('the group threat ratio between 0.5 and 2, weighed once after 1 s  [settings]', () => {
    expect(S.groupThreatRatioTimer).toBe(1);
    expect(evenFight(100, 50, S)).toBe(false);
    expect(evenFight(100, 51, S)).toBe(true);
    expect(evenFight(100, 199, S)).toBe(true);
    expect(evenFight(100, 200, S)).toBe(false);
  });

  it('near combat: fights within 2500 .. 3500 of the player  [settings]', () => {
    const near = threat({ targetsPlayer: false, distance: 2500, strength: 200 });
    const input = { threats: [near], player: 100 };
    expect(combatMusicWanted(input, S, false)).toBe('combat');
    const beyond = { threats: [{ ...near, distance: 2501 }], player: 100 };
    expect(combatMusicWanted(beyond, S, false)).toBe('none');
    // Playing, it keeps to the outer radius.
    expect(combatMusicWanted(beyond, S, true)).toBe('combat');
    const out = { threats: [{ ...near, distance: 3501 }], player: 100 };
    expect(combatMusicWanted(out, S, true)).toBe('none');
    // An uneven fight near counts for neither.
    expect(combatMusicWanted(input, S, false, false)).toBe('none');
  });

  it('weighed every fCombatMusicUpdateTime (1 s); stops 5 s after the fight  [settings]', () => {
    const music = new CombatMusic();
    let asked = 0;
    const input = (threats: CombatMusicThreat[]) => () => {
      asked++;
      return { threats, player: 1 };
    };
    expect(music.update(0.1, input([threat()]))).toBe('combat');
    expect(asked).toBe(1);
    music.update(0.5, input([threat()]));
    expect(asked).toBe(1);
    music.update(0.5, input([threat()]));
    expect(asked).toBe(2);
    // The fight over, it plays on its stop time.
    music.update(1, input([]));
    expect(music.update(4.5, () => ({ threats: [], player: 1 }))).toBe('combat');
    expect(music.update(1, () => ({ threats: [], player: 1 }))).toBe('none');
  });

  it('the player’s strength has no cap: the setting is never read  [original]', () => {
    const strong = threat({ strength: 20000 });
    // 35000 would make the ratio 1.75 and start it; the player's whole strength does not.
    expect(combatMusicWanted({ threats: [strong], player: 50000 }, S, false)).toBe('none');
  });

  it('the boss music for a location’s boss (MUSCombatBoss)  [xEdit MUSC]', () => {
    const input = { threats: [threat(), threat({ boss: true })], player: 1 };
    expect(combatMusicWanted(input, S, false)).toBe('boss');
    expect(combatMusicWanted({ threats: [threat()], player: 1 }, S, false)).toBe('combat');
  });
});
