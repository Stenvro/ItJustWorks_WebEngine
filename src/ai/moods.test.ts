import { describe, expect, it } from 'vitest';
import { FACE_EXPRESSIONS } from '../animation/face.ts';
import {
  AiMood,
  faceExpression,
  MOOD_STRENGTH,
  overrideAccepted,
  overrideStrength,
} from './moods.ts';

const calm = { shouting: false, inCombat: false, mood: AiMood.neutral };
const name = (state: Parameters<typeof faceExpression>[0]): string | undefined =>
  FACE_EXPRESSIONS[faceExpression(state).expression];

describe('faceExpression', () => {
  it("shows the AI's mood as its Mood expression", () => {
    expect(name(calm)).toBe('MoodNeutral');
    expect(name({ ...calm, mood: AiMood.anger })).toBe('MoodAnger');
    expect(name({ ...calm, mood: AiMood.disgusted })).toBe('MoodDisgusted');
    expect(faceExpression(calm).strength).toBe(MOOD_STRENGTH);
    // An unknown mood is neutral.
    expect(name({ ...calm, mood: 12 })).toBe('MoodNeutral');
  });

  it('is angry in combat and shouts with the CombatShout expression', () => {
    expect(name({ ...calm, inCombat: true, mood: AiMood.happy })).toBe('CombatAnger');
    expect(name({ ...calm, inCombat: true, shouting: true })).toBe('CombatShout');
  });

  it("keeps a script's override over everything (SetExpressionOverride's mfg index, 0..100)", () => {
    const override = { expression: 2, strength: 80 };
    const shown = faceExpression({ ...calm, inCombat: true, override });
    expect(FACE_EXPRESSIONS[shown.expression]).toBe('DialogueHappy');
    expect(shown.strength).toBeCloseTo(0.8);
    // Out of range: not an override.
    expect(name({ ...calm, override: { expression: 40, strength: 50 } })).toBe('MoodNeutral');
  });

  it('shows the mood at iMoodFaceValue / 100 (original: the engine’s 50)', () => {
    expect(MOOD_STRENGTH).toBe(0.5);
    expect(faceExpression({ ...calm, moodFaceValue: 80 }).strength).toBeCloseTo(0.8);
  });

  it('SetExpressionOverride takes mfg 1..16, its strength unsigned and held to 100 (original)', () => {
    expect(overrideAccepted(0)).toBe(false);
    expect(overrideAccepted(1)).toBe(true);
    expect(overrideAccepted(16)).toBe(true);
    expect(overrideAccepted(17)).toBe(false);
    expect(overrideStrength(40)).toBe(40);
    expect(overrideStrength(250)).toBe(100);
    expect(overrideStrength(-5)).toBe(100);
  });
});
