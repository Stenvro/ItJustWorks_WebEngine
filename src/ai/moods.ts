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
 * How strongly the AI's mood and combat show (observed in the original): the mood at the game
 * setting iMoodFaceValue (the engine's 50; the load order sets none) / 100, combat's in full.
 */
export const MOOD_FACE_VALUE = 50;
export const MOOD_STRENGTH = MOOD_FACE_VALUE / 100;
export const COMBAT_STRENGTH = 1;

/**
 * Whether Actor.SetExpressionOverride takes an expression (observed in the original): mfg 1..16
 * only; 0 (DialogueAnger) and anything beyond are refused with an error and change nothing.
 */
export function overrideAccepted(expression: number): boolean {
  return Number.isInteger(expression) && expression >= 1 && expression <= 16;
}

/**
 * The strength SetExpressionOverride keeps (observed in the original): read unsigned and held
 * to 100 at most, so a negative strength is 100.
 */
export function overrideStrength(strength: number): number {
  return strength < 0 || strength > 100 ? 100 : strength;
}

/** What decides an actor's expression now. */
export interface MoodState {
  /** A script's override: an expression (mfg index 0..16) and its strength 0..100. */
  readonly override?: { readonly expression: number; readonly strength: number } | undefined;
  readonly shouting: boolean;
  readonly inCombat: boolean;
  /** Its Mood actor value (AiMood). */
  readonly mood: number;
  /** The game setting iMoodFaceValue (0..100; MOOD_FACE_VALUE when the load order sets none). */
  readonly moodFaceValue?: number;
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
  const value = state.moodFaceValue ?? MOOD_FACE_VALUE;
  return { expression: MOOD_NEUTRAL + mood, strength: Math.min(1, Math.max(0, value / 100)) };
}
