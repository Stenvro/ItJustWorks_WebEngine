import { describe, expect, it } from 'vitest';
import { EffectArchetype, EffectFlag } from '../../world/magic-effects.ts';
import {
  combatSpellScore,
  scriptCasterReady,
  shoutOffered,
  type ScoredEffect,
} from './spell-score.ts';

const { hostile, recover, noArea, fxPersist, hideInUi, dispelWithKeywords } = EffectFlag;

const effect = (over: Partial<ScoredEffect>): ScoredEffect => ({
  archetype: EffectArchetype.script,
  actorValue: -1,
  secondActorValue: -1,
  secondValueWeight: 0,
  flags: 0,
  taperDuration: 0,
  taperWeight: 0,
  magnitude: 0,
  duration: 0,
  cost: 0,
  kept: 1,
  ...over,
});

describe('a Script effect in the combat inventory’s score', () => {
  // Alduin's Firestorm (DragonVoiceStormCall), a self spell: its hostile 600-unit Stagger area,
  // the storm's hazard on the shouter, the script effect for the AI's use of Storm Call (AI
  // score 50, magnitude 9, 30 s, base cost 0).
  const firestorm = [
    effect({
      archetype: EffectArchetype.stagger,
      flags: hostile | recover | fxPersist,
      magnitude: 100,
      duration: 30,
    }),
    effect({
      archetype: EffectArchetype.spawnHazard,
      flags: recover | dispelWithKeywords | noArea | fxPersist,
      magnitude: 10,
      duration: 30,
    }),
    effect({ flags: hideInUi, magnitude: 9, duration: 30, aiScore: 50 }),
  ];

  it('adds its AI score as it stands: not its magnitude, seconds or cost', () => {
    expect(combatSpellScore({ self: true, concentration: false, effects: firestorm })).toEqual({
      score: 50,
      caster: 'script',
    });
    // Whatever it costs or how long it lasts.
    const costly = [effect({ magnitude: 9, duration: 600, cost: 400, aiScore: 50 })];
    expect(combatSpellScore({ self: true, concentration: false, effects: costly }).score).toBe(50);
    // Nor by the share a target keeps of it.
    const resisted = [effect({ flags: hostile, aiScore: 50, kept: 0.25 })];
    expect(combatSpellScore({ self: false, concentration: false, effects: resisted })).toEqual({
      score: 50,
      caster: 'script',
    });
  });

  it('a self spell’s hostile Stagger and its hazard are of no kind: without the script effect, no caster', () => {
    const bare = firestorm.slice(0, 2);
    expect(combatSpellScore({ self: true, concentration: false, effects: bare })).toEqual({
      score: 0,
      caster: undefined,
    });
  });

  it('one without an AI score adds nothing and gives no caster: Clear Skies', () => {
    // VoiceClearSkiesSelf1: one script effect (magnitude 10, 25 s), AI score 0.
    const clearSkies = [
      effect({
        flags: recover | dispelWithKeywords | noArea | hideInUi,
        magnitude: 10,
        duration: 25,
        cost: 5,
      }),
    ];
    expect(combatSpellScore({ self: true, concentration: false, effects: clearSkies })).toEqual({
      score: 0,
      caster: undefined,
    });
  });

  it('an aimed script effect counts only when hostile', () => {
    const aimed = [effect({ aiScore: 50 })];
    expect(combatSpellScore({ self: false, concentration: false, effects: aimed }).caster).toBe(
      undefined,
    );
  });
});

describe('the combat AI shouts', () => {
  it('a word whose spell has a caster sent against the target, or the Script caster', () => {
    expect(shoutOffered('stagger')).toBe(true);
    expect(shoutOffered('offensive')).toBe(true);
    expect(shoutOffered('script')).toBe(true);
  });

  it('not a word whose spell has no caster', () => {
    expect(shoutOffered(undefined)).toBe(false);
  });

  it('the Script caster waits out its effect’s AI delay since the last cast', () => {
    // Storm Call's script effect: AI delay 60 s.
    expect(scriptCasterReady({ sinceCast: undefined, aiDelay: 60, carried: false })).toBe(true);
    expect(scriptCasterReady({ sinceCast: 30, aiDelay: 60, carried: false })).toBe(false);
    expect(scriptCasterReady({ sinceCast: 60, aiDelay: 60, carried: false })).toBe(false);
    expect(scriptCasterReady({ sinceCast: 60.5, aiDelay: 60, carried: false })).toBe(true);
  });

  it('the Script caster does not cast what the one it lands on carries already', () => {
    expect(scriptCasterReady({ sinceCast: undefined, aiDelay: 0, carried: true })).toBe(false);
    expect(scriptCasterReady({ sinceCast: 500, aiDelay: 60, carried: true })).toBe(false);
  });
});
