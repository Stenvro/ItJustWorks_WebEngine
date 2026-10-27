// How an invisible actor is drawn (an Invisibility effect on it: MagicEngine.aiState). Observed in
// the original: an actor's drawn alpha goes as its invisibility says, the player's never
// below fMagicPlayerMinimumInvisibility (0.1: the player still sees themselves faintly); the
// engine draws the rest of an invisible actor as refraction, from fInvisibilityMinRefraction
// (0.01) to fInvisibilityMaxRefraction (1). We draw the share not seen dithered away, as a
// distance fade is (the renderer's InstanceFade.veil). TODO(M13): the refraction shimmer itself
// (the screen behind bent through the actor's shape) and how fast the engine fades it in and out.
// Platform-independent.

export interface InvisibilitySettings {
  /** fMagicPlayerMinimumInvisibility: the least of the player that stays drawn. */
  readonly playerMinimum: number;
  /** fInvisibilityMinRefraction: the least refraction an invisible actor shows. */
  readonly minRefraction: number;
}

export const INVISIBILITY_DEFAULTS: InvisibilitySettings = {
  playerMinimum: 0.1,
  minRefraction: 0.01,
};

export const INVISIBILITY_SETTING_NAMES: Readonly<Record<keyof InvisibilitySettings, string>> = {
  playerMinimum: 'fMagicPlayerMinimumInvisibility',
  minRefraction: 'fInvisibilityMinRefraction',
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
