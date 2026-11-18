// Conformance: combat music (engine map: Combat > Combat music). When the combat music plays.
//
// Sources: the engine's defaults: fCombatMusicUpdateTime (1 s), fCombatMusicStopTime (5 s),
// fCombatMusicNearCombatInnerRadius / OuterRadius (2500, 3500), fCombatMusicPlayerTargetedThreat
// Ratio (2), fCombatMusicGroupThreatRatioTimer (1), …GroupThreatRatioMin / Max (0.5, 2),
// fCombatMusicPlayerNearStrengthMult (1), fCombatMusicPlayerCombatStrengthCap (35000); the music
// types (MUSC: MUSCombat, MUSCombatBoss; the Default Object CombatMusic). Observed in the
// original: the combat groups are weighed, each against the player alone by its members the
// player detects; the even groups near the player add up; a group searching, without targets,
// all fleeing or that lost the player is passed over; the radii are strict.

import { describe, expect, it } from 'vitest';
import {
  COMBAT_MUSIC_DEFAULTS as S,
  CombatMusic,
  combatMusicWanted,
  evenFight,
  type CombatMusicGroup,
  type CombatMusicMember,
} from '../../../src/audio/combat-music.ts';

const member = (over: Partial<CombatMusicMember> = {}): CombatMusicMember => ({
  distance: 500,
  strength: 100,
  detected: true,
  boss: false,
  fleeing: false,
  ...over,
});
const group = (
  members: CombatMusicMember[],
  over: Partial<CombatMusicGroup> = {},
): CombatMusicGroup => ({
  id: 1,
  members,
  targetsPlayer: true,
  playerLost: false,
  searching: false,
  targets: 1,
  targetStrength: 100,
  ...over,
});

describe('combat music', () => {
  it('plays when the player is targeted and the threat ratio reaches 2  [settings]', () => {
    expect(S.playerTargetedThreatRatio).toBe(2);
    const groups = [group([member()])];
    expect(combatMusicWanted({ groups, player: 199 }, S, false)).toBe('combat');
    // A mudcrab does not start it for a player much stronger.
    expect(combatMusicWanted({ groups, player: 200 }, S, false)).toBe('none');
    // Once it plays the odds are not weighed again.
    expect(combatMusicWanted({ groups, player: 200 }, S, true)).toBe('combat');
  });

  it('the group threat ratio between 0.5 and 2, weighed once after 1 s  [settings]', () => {
    expect(S.groupThreatRatioTimer).toBe(1);
    expect(evenFight(50, 100, S)).toBe(false);
    expect(evenFight(51, 100, S)).toBe(true);
    expect(evenFight(199, 100, S)).toBe(true);
    expect(evenFight(200, 100, S)).toBe(false);
  });

  it('near combat: fights within 2500 .. 3500 of the player, strictly  [original]', () => {
    const at = (distance: number) => ({
      groups: [group([member({ distance, strength: 200 })], { targetsPlayer: false })],
      player: 100,
    });
    expect(combatMusicWanted(at(2499), S, false)).toBe('combat');
    expect(combatMusicWanted(at(2500), S, false)).toBe('none');
    // Playing, it keeps to the outer radius.
    expect(combatMusicWanted(at(2600), S, true)).toBe('combat');
    expect(combatMusicWanted(at(3500), S, true)).toBe('none');
    // An uneven fight near counts for neither.
    expect(combatMusicWanted(at(2499), S, false, () => false)).toBe('none');
  });

  it('two near fights add up; two groups against the player do not  [original]', () => {
    const half = (id: number, targetsPlayer: boolean) =>
      group([member({ strength: 60 })], { id, targetsPlayer });
    expect(
      combatMusicWanted({ groups: [half(1, false), half(2, false)], player: 100 }, S, false),
    ).toBe('combat');
    // Against the player: 100 / 60 each, 1.67 < 2 starts it alone too; at 49 each it does not.
    const weak = (id: number) => group([member({ strength: 49 })], { id });
    expect(combatMusicWanted({ groups: [weak(1), weak(2)], player: 100 }, S, false)).toBe('none');
  });

  it('weighed every fCombatMusicUpdateTime (1 s); stops 5 s after the fight  [settings]', () => {
    const music = new CombatMusic();
    let asked = 0;
    const input = (groups: CombatMusicGroup[]) => () => {
      asked++;
      return { groups, player: 1 };
    };
    const fight = [group([member()])];
    expect(music.update(0.1, input(fight))).toBe('combat');
    expect(asked).toBe(1);
    music.update(0.5, input(fight));
    expect(asked).toBe(1);
    music.update(0.5, input(fight));
    expect(asked).toBe(2);
    // The fight over, it plays on its stop time.
    music.update(1, input([]));
    expect(music.update(4.5, () => ({ groups: [], player: 1 }))).toBe('combat');
    expect(music.update(1, () => ({ groups: [], player: 1 }))).toBe('none');
  });

  it('the player’s strength has no cap: the setting is never read  [original]', () => {
    const strong = [group([member({ strength: 20000 })])];
    // 35000 would make the ratio 1.75 and start it; the player's whole strength does not.
    expect(combatMusicWanted({ groups: strong, player: 50000 }, S, false)).toBe('none');
  });

  it('the boss music for a location’s boss (MUSCombatBoss)  [xEdit MUSC]', () => {
    const boss = [group([member(), member({ boss: true })])];
    expect(combatMusicWanted({ groups: boss, player: 1 }, S, false)).toBe('boss');
    expect(combatMusicWanted({ groups: [group([member()])], player: 1 }, S, false)).toBe('combat');
  });
});
