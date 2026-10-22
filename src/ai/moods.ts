// The expression an actor's face holds (docs/animation.md, "Faces"): a script's override
// (Actor.SetExpressionOverride, until ClearExpressionOverride), else what it does (shouting: the
// CombatShout expression; in combat: CombatAnger), else its AI's mood (the Mood actor value: AIDT
// mood, UESP "Skyrim:AI Data": neutral, anger, fear, happy, sad, surprised, puzzled, disgusted)
// as the Mood* expression. A response's emotion shows over it while it is said (FaceAnimation's
// showEmotion). Platform-independent.

/** The Mood actor value's moods (AIDT mood, xEdit's order). */
export const AiMood = {
  neutral: 0,
  anger: 1,
  fear: 2,
  happy: 3,
  sad: 4,
  surprised: 5,
  puzzled: 6,
  disgusted: 7,
} as const;

/** Expressions by their mfg index (src/animation/face.ts FACE_EXPRESSIONS). */
const MOOD_NEUTRAL = 7;
const COMBAT_ANGER = 15;
const COMBAT_SHOUT = 16;
const EXPRESSIONS = 17;

/**
 * How strongly the AI's mood and combat show. TODO(M13): the engine's strengths are not
 * documented; SetExpressionOverride's default strength (50) is taken for the mood, combat's in
 * full.
 */
export const MOOD_STRENGTH = 0.5;
export const COMBAT_STRENGTH = 1;

/** What decides an actor's expression now. */
export interface MoodState {
  /** A script's override: an expression (mfg index 0..16) and its strength 0..100. */
  readonly override?: { readonly expression: number; readonly strength: number } | undefined;
  readonly shouting: boolean;
  readonly inCombat: boolean;
  /** Its Mood actor value (AiMood). */
  readonly mood: number;
}

/** The expression (mfg index, FACE_EXPRESSIONS) and its strength (0..1) an actor's face holds. */
export function faceExpression(state: MoodState): {
  readonly expression: number;
  readonly strength: number;
} {
  const override = state.override;
  if (override && override.expression >= 0 && override.expression < EXPRESSIONS) {
    return {
      expression: override.expression,
      strength: Math.min(1, Math.max(0, override.strength / 100)),
    };
  }
  if (state.shouting) return { expression: COMBAT_SHOUT, strength: COMBAT_STRENGTH };
  if (state.inCombat) return { expression: COMBAT_ANGER, strength: COMBAT_STRENGTH };
  const mood = Number.isInteger(state.mood) && state.mood >= 0 && state.mood <= 7 ? state.mood : 0;
  return { expression: MOOD_NEUTRAL + mood, strength: MOOD_STRENGTH };
}
