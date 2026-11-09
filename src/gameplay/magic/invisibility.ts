// How an invisible actor is drawn (an Invisibility effect on it: MagicEngine.aiState). Observed in
// the original: an actor's drawn alpha goes as its invisibility says, the player's never
// below fMagicPlayerMinimumInvisibility (0.1: the player still sees themselves faintly); the
// engine draws the rest of an invisible actor as refraction, from fInvisibilityMinRefraction
// (0.01) to fInvisibilityMaxRefraction (the engine's 1; Skyrim.esm 0.5). We draw the share not
// seen dithered away, as a distance fade is (the renderer's InstanceFade.veil), and the
// refraction shimmer through the actor's shapes (the renderer's InstanceFade.refraction: they
// bend the scene behind them as refraction shapes do). Observed in the original: as an
// Invisibility effect starts and as it stops, its actor value's share s (value / 100, 0 to 1)
// sets the actor's refraction to fInvisibilityMinRefraction + (1 - s) x (max - min), none while
// s is 0 (invisibilityRefraction). TODO(M13): how fast the engine fades it in and out.
// Platform-independent.

export interface InvisibilitySettings {
  /** fMagicPlayerMinimumInvisibility: the least of the player that stays drawn. */
  readonly playerMinimum: number;
  /** fInvisibilityMinRefraction: the least refraction an invisible actor shows. */
  readonly minRefraction: number;
  /** fInvisibilityMaxRefraction: the most (the engine's 1; Skyrim.esm sets 0.5). */
  readonly maxRefraction: number;
}

export const INVISIBILITY_DEFAULTS: InvisibilitySettings = {
  playerMinimum: 0.1,
  minRefraction: 0.01,
  maxRefraction: 1,
};

export const INVISIBILITY_SETTING_NAMES: Readonly<Record<keyof InvisibilitySettings, string>> = {
  playerMinimum: 'fMagicPlayerMinimumInvisibility',
  minRefraction: 'fInvisibilityMinRefraction',
  maxRefraction: 'fInvisibilityMaxRefraction',
};

/**
 * How much of an actor is veiled (0 whole, 1 unseen): none while it is visible; invisible, all
 * but its least refraction, the player all but fMagicPlayerMinimumInvisibility.
 */
export function invisibilityVeil(
  invisible: boolean,
  player: boolean,
  settings: InvisibilitySettings = INVISIBILITY_DEFAULTS,
): number {
  if (!invisible) return 0;
  const shown = player ? settings.playerMinimum : settings.minRefraction;
  return 1 - Math.min(1, Math.max(0, shown));
}

/**
 * The refraction an Invisibility effect gives its actor (observed in the original), from its
 * actor value as the effect starts or stops: none at 0; else fInvisibilityMinRefraction + (1 -
 * value / 100) x (max - min), the share clamped to 0..1. Vanilla Invisibility (No Magnitude:
 * the value 1) shimmers at nearly the most; a value of 100 at the least.
 */
export function invisibilityRefraction(
  value: number,
  settings: Pick<InvisibilitySettings, 'minRefraction' | 'maxRefraction'> = INVISIBILITY_DEFAULTS,
): number {
  const share = Math.min(1, Math.max(0, value * 0.01));
  if (share <= 0) return 0;
  return settings.minRefraction + (1 - share) * (settings.maxRefraction - settings.minRefraction);
}
