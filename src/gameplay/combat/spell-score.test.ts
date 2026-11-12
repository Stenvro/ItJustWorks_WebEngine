import { describe, expect, it } from 'vitest';
import { EffectArchetype, EffectFlag } from '../../world/magic-effects.ts';
import {
  combatSpellScore,
  scriptCasterDelay,
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

// Alduin's Firestorm (DragonVoiceStormCall), a self spell: its hostile 600-unit Stagger area,
// the storm's hazard on the shouter, the script effect for the AI's use of Storm Call (AI
// score 50, AI delay 60 s, magnitude 9, 30 s, base cost 0).
const firestormEffects = [
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
  effect({ flags: hideInUi, magnitude: 9, duration: 30, aiScore: 50, aiDelay: 60 }),
];

describe('a Script effect in the combat inventory’s score', () => {
  const firestorm = firestormEffects;

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

  it('one without an AI score adds nothing, yet gives the Script caster: Clear Skies', () => {
    // VoiceClearSkiesSelf1: one script effect (magnitude 10, 25 s), AI score 0. The item is made
    // (it has a caster) and scores nothing, so it is never weighed.
    const clearSkies = [
      effect({
        flags: recover | dispelWithKeywords | noArea | hideInUi,
        magnitude: 10,
        duration: 25,
        cost: 5,
      }),
    ];
    const scored = combatSpellScore({ self: true, concentration: false, effects: clearSkies });
    expect(scored).toEqual({ score: 0, caster: 'script' });
    expect(shoutOffered(scored)).toBe(false);
  });

  it('an aimed, hostile one without an AI score likewise: the dragons’ Unrelenting Force', () => {
    // DragonVoiceUnrelentingForce: one aimed Script effect (hostile, magnitude 1), AI score 0.
    const force = [effect({ flags: hostile, magnitude: 1, cost: 4 })];
    const scored = combatSpellScore({ self: false, concentration: false, effects: force });
    expect(scored).toEqual({ score: 0, caster: 'script' });
    expect(shoutOffered(scored)).toBe(false);
  });

  it('the caster is the strongest effect’s, the first of equals', () => {
    // A Script effect without an AI score before a Health damage: the damage's caster.
    const damage = effect({
      archetype: EffectArchetype.valueModifier,
      actorValue: 24,
      flags: hostile,
      magnitude: 20,
    });
    const plain = effect({ flags: hostile });
    for (const effects of [
      [plain, damage],
      [damage, plain],
    ]) {
      expect(combatSpellScore({ self: false, concentration: false, effects })).toEqual({
        score: 20,
        caster: 'offensive',
      });
    }
    // A Script effect's AI score above it: the Script caster, the score their sum (the Drain
    // Vitality shouts' DLC1ScriptAIEffect, AI score 1,000,000).
    const ai = effect({ flags: hostile, aiScore: 1_000_000, aiDelay: 45 });
    expect(combatSpellScore({ self: false, concentration: false, effects: [damage, ai] })).toEqual({
      score: 1_000_020,
      caster: 'script',
    });
  });

  it('an aimed script effect counts only when hostile, a self spell’s only when not', () => {
    const aimed = [effect({ aiScore: 50 })];
    expect(combatSpellScore({ self: false, concentration: false, effects: aimed })).toEqual({
      score: 0,
      caster: undefined,
    });
    const onSelf = [effect({ flags: hostile, aiScore: 50 })];
    expect(combatSpellScore({ self: true, concentration: false, effects: onSelf })).toEqual({
      score: 0,
      caster: undefined,
    });
  });

  it('a hostile effect is of no kind in a spell cast on its caster', () => {
    // A Health value modifier flagged hostile in a self spell is no restoring.
    const harm = effect({
      archetype: EffectArchetype.valueModifier,
      actorValue: 24,
      flags: hostile,
      magnitude: 20,
    });
    expect(combatSpellScore({ self: true, concentration: false, effects: [harm] })).toEqual({
      score: 0,
      caster: undefined,
    });
    const heal = { ...harm, flags: 0 };
    expect(combatSpellScore({ self: true, concentration: false, effects: [heal] })).toEqual({
      score: 20,
      caster: 'restore',
    });
  });
});

describe('the combat AI shouts', () => {
  it('a word whose spell scores by a caster sent against the target, or the Script caster', () => {
    expect(shoutOffered({ score: 8, caster: 'stagger' })).toBe(true);
    expect(shoutOffered({ score: 20, caster: 'offensive' })).toBe(true);
    expect(shoutOffered({ score: 50, caster: 'script' })).toBe(true);
  });

  it('not a word whose spell has no caster, another caster or scores nothing', () => {
    expect(shoutOffered({ score: 0, caster: undefined })).toBe(false);
    expect(shoutOffered({ score: 30, caster: 'restore' })).toBe(false);
    expect(shoutOffered({ score: 0, caster: 'script' })).toBe(false);
  });

  it('the Script caster’s delay is that of the effect that gave the spell its caster', () => {
    // Storm Call: the script effect for the AI, AI delay 60 s.
    expect(scriptCasterDelay({ self: true, concentration: false, effects: firestormEffects })).toBe(
      60,
    );
    // Of two script effects the one with the higher AI score.
    const two = [
      effect({ aiScore: 10, aiDelay: 5 }),
      effect({ aiScore: 100, aiDelay: 30 }),
      effect({ aiScore: 100, aiDelay: 90 }),
    ];
    expect(scriptCasterDelay({ self: true, concentration: false, effects: two })).toBe(30);
    // One without an AI score or delay: none to wait.
    expect(
      scriptCasterDelay({
        self: false,
        concentration: false,
        effects: [effect({ flags: hostile })],
      }),
    ).toBe(0);
    // Not a spell of another caster.
    const stagger = [effect({ archetype: EffectArchetype.stagger, flags: hostile, magnitude: 1 })];
    expect(scriptCasterDelay({ self: false, concentration: false, effects: stagger })).toBe(
      undefined,
    );
  });

  it('the Script caster waits out the delay noted with its last cast', () => {
    // Storm Call's script effect: AI delay 60 s.
    expect(scriptCasterReady({ sinceCast: undefined, delay: 0, carried: false })).toBe(true);
    expect(scriptCasterReady({ sinceCast: 30, delay: 60, carried: false })).toBe(false);
    expect(scriptCasterReady({ sinceCast: 60, delay: 60, carried: false })).toBe(false);
    expect(scriptCasterReady({ sinceCast: 60.5, delay: 60, carried: false })).toBe(true);
  });

  it('the Script caster does not cast what the one it lands on carries already', () => {
    expect(scriptCasterReady({ sinceCast: undefined, delay: 0, carried: true })).toBe(false);
    expect(scriptCasterReady({ sinceCast: 500, delay: 60, carried: true })).toBe(false);
  });
});
