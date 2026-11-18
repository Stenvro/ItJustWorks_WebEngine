import { describe, expect, it } from 'vitest';
import { actorStrength, COMBAT_AI_DEFAULTS, strengthDamage } from '../ai/combat-ai.ts';
import {
  CombatMusic,
  combatMusicWanted,
  evenFight,
  readCombatMusicSettings,
  type CombatMusicGroup,
  type CombatMusicMember,
} from './combat-music.ts';

// Skyrim.esm sets fCombatMusicPlayerTargetedThreatRatio to 1 (the engine's own is 2).
const settings = readCombatMusicSettings((name) =>
  name === 'fCombatMusicPlayerTargetedThreatRatio' ? 1 : undefined,
);

const member = (overrides: Partial<CombatMusicMember> = {}): CombatMusicMember => ({
  distance: 500,
  strength: 100,
  detected: true,
  boss: false,
  fleeing: false,
  ...overrides,
});

let ids = 0;
/** A group against the player (one target: the player). */
const enemies = (
  members: CombatMusicMember[],
  overrides: Partial<CombatMusicGroup> = {},
): CombatMusicGroup => ({
  id: ++ids,
  members,
  targetsPlayer: true,
  playerLost: false,
  searching: false,
  targets: 1,
  targetStrength: 0,
  ...overrides,
});
/** A group fighting near the player, not against them. */
const near = (members: CombatMusicMember[], targetStrength: number, id = ++ids): CombatMusicGroup =>
  enemies(members, { id, targetsPlayer: false, targetStrength });

describe('combat music', () => {
  it('starts only for a fight worth it (fCombatMusicPlayerTargetedThreatRatio)', () => {
    const player = 1000;
    const want = (groups: CombatMusicGroup[], playing = false) =>
      combatMusicWanted({ groups, player }, settings, playing);
    // A mudcrab against a strong player: no music.
    expect(want([enemies([member({ strength: 50 })])])).toBe('none');
    // Stronger than them: music.
    expect(want([enemies([member({ strength: 1001 })])])).toBe('combat');
    // One the player does not detect does not count.
    expect(want([enemies([member({ strength: 5000, detected: false })])])).toBe('none');
    // Once it plays, the odds turning does not end it.
    expect(want([enemies([member({ strength: 50 })])], true)).toBe('combat');
    // An even fight not against the player starts it with a member within the inner radius
    // (strictly), keeps it to the outer.
    const at = (distance: number) => [near([member({ distance, strength: 1001 })], 1001)];
    const inner = settings.nearCombatInnerRadius;
    const outer = settings.nearCombatOuterRadius;
    expect(want(at(inner - 1))).toBe('combat');
    expect(want(at(inner))).toBe('none');
    expect(want(at(outer - 1), true)).toBe('combat');
    expect(want(at(outer), true)).toBe('none');
  });

  it('weighs each group against the player alone, by its members the player detects  [original]', () => {
    const player = 1000;
    // Two packs of 600: apart neither is worth it.
    const a = enemies([member({ strength: 600 })]);
    const b = enemies([member({ strength: 600 })]);
    expect(combatMusicWanted({ groups: [a, b], player }, settings, false)).toBe('none');
    // One pack of two 600s is.
    const pack = enemies([member({ strength: 600 }), member({ strength: 600 })]);
    expect(combatMusicWanted({ groups: [pack], player }, settings, false)).toBe('combat');
  });

  it('passes over a group searching, without targets, all fleeing or that lost the player  [original]', () => {
    const player = 1;
    const want = (group: CombatMusicGroup, playing = false) =>
      combatMusicWanted({ groups: [group], player }, settings, playing);
    expect(want(enemies([member()]))).toBe('combat');
    expect(want(enemies([member()], { searching: true }), true)).toBe('none');
    expect(want(enemies([member()], { targets: 0 }), true)).toBe('none');
    expect(want(enemies([member({ fleeing: true })]), true)).toBe('none');
    expect(want(enemies([member()], { playerLost: true }), true)).toBe('none');
    // One fleeing beside one fighting: the group counts.
    expect(want(enemies([member({ fleeing: true }), member()]))).toBe('combat');
  });

  it('counts a fight not against the player only once it is even (fCombatMusicGroupThreatRatio*)', () => {
    // Its own strength over its targets', exclusive.
    expect(evenFight(1000, 2000, settings)).toBe(false); // a dragon over two guards: 0.5
    expect(evenFight(1000, 1999, settings)).toBe(true);
    expect(evenFight(1000, 501, settings)).toBe(true);
    expect(evenFight(1000, 500, settings)).toBe(false); // guards against a mudcrab: 2
    expect(evenFight(1000, 0, settings)).toBe(false);
    const player = 1000;
    const fight = (targets: number) => ({
      groups: [near([member({ strength: 1500 })], targets, 1)],
      player,
    });
    // Undecided until the group threat ratio timer: nothing.
    const music = new CombatMusic(settings);
    expect(music.update(0.1, fight(1500))).toBe('none');
    expect(music.update(settings.groupThreatRatioTimer, fight(1500))).toBe('combat');
    // A lopsided one never counts; it is decided once.
    const lopsided = new CombatMusic(settings);
    lopsided.update(0.1, fight(100));
    expect(lopsided.update(settings.groupThreatRatioTimer, fight(100))).toBe('none');
    expect(lopsided.update(settings.updateTime, fight(1500))).toBe('none');
  });

  it('decides evenness only once the group stops searching  [original]', () => {
    const searching = {
      groups: [{ ...near([member({ strength: 1500 })], 1500, 1), searching: true }],
      player: 1000,
    };
    const fighting = { groups: [near([member({ strength: 1500 })], 1500, 1)], player: 1000 };
    const music = new CombatMusic(settings);
    music.update(0.1, searching);
    music.update(settings.groupThreatRatioTimer * 3, searching);
    // Its timer starts now: undecided at its first weighing back, decided after the timer.
    expect(music.update(settings.updateTime, fighting)).toBe('none');
    expect(music.update(settings.groupThreatRatioTimer, fighting)).toBe('combat');
  });

  it('adds up the even groups near the player; one detected member is enough  [original]', () => {
    const player = 1000;
    // Two even fights near the player, each weaker than them: together they pass its strength.
    const a = near([member({ strength: 600 })], 600, 1);
    const b = near([member({ strength: 600, detected: false })], 600, 2);
    expect(combatMusicWanted({ groups: [a, b], player }, settings, false)).toBe('combat');
    // Neither detected: nothing.
    const hidden = near([member({ strength: 600, detected: false })], 600, 1);
    expect(combatMusicWanted({ groups: [hidden, b], player }, settings, false)).toBe('none');
    // A group whose members are all beyond the inner radius adds nothing.
    const far = near([member({ strength: 600, distance: 3000 })], 600, 1);
    expect(combatMusicWanted({ groups: [far, b], player }, settings, false)).toBe('none');
    // A fleeing member's strength does not count.
    const fleeing = near(
      [member({ strength: 600, fleeing: true }), member({ strength: 1 })],
      600,
      1,
    );
    expect(combatMusicWanted({ groups: [fleeing, b], player }, settings, false)).toBe('none');
    // Each decides its own evenness by its own targets: guards against a mudcrab stay out.
    const dragon = near([member({ strength: 1500 })], 1500, 7);
    const guards = near([member({ strength: 1500 })], 50, 8);
    const music = new CombatMusic(settings);
    music.update(0.1, { groups: [guards], player });
    expect(music.update(settings.groupThreatRatioTimer, { groups: [guards], player })).toBe('none');
    expect(music.update(settings.updateTime, { groups: [guards, dragon], player })).toBe('none');
    expect(music.update(settings.groupThreatRatioTimer, { groups: [guards, dragon], player })).toBe(
      'combat',
    );
  });

  it('weighs a lone wolf against the player by the engine’s strength', () => {
    const ai = COMBAT_AI_DEFAULTS;
    // A wolf: 40 health, its bite (5 unarmed at the fists' speed), no armour.
    const wolf = actorStrength(40, strengthDamage([], 5, ai));
    // A new player: 100 health, an iron sword's 7, its armour taking a third: no music.
    const sword = { kind: 'weapon', damage: 7, speed: 1, bow: false } as const;
    const player = actorStrength(100, strengthDamage([sword], 0, ai), 1 / 3);
    expect(
      combatMusicWanted(
        { groups: [enemies([member({ strength: wolf })])], player },
        settings,
        false,
      ),
    ).toBe('none');
    // A pack of six is a fight (four: 800 against 1050 are not).
    const pack = enemies([1, 2, 3, 4, 5, 6].map(() => member({ strength: wolf })));
    expect(combatMusicWanted({ groups: [pack], player }, settings, false)).toBe('combat');
  });

  it('plays the boss music against a boss', () => {
    const groups = [enemies([member(), member({ boss: true })])];
    expect(combatMusicWanted({ groups, player: 100 }, settings, false)).toBe('boss');
  });

  it('weighs the fights every update time and plays on for the stop time once they end', () => {
    const music = new CombatMusic(settings);
    const fight = { groups: [enemies([member()])], player: 50 };
    const over = { groups: [], player: 50 };
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
