import { describe, expect, it } from 'vitest';
import { FACE_EXPRESSIONS } from '../animation/face.ts';
import { AiMood, faceExpression, MOOD_STRENGTH } from './moods.ts';

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
});
