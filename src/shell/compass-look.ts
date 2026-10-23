// How a compass marker looks with its distance (src/shell/compass.ts), observed in the
// original: its alpha and size ease from the player out to iMapMarkerFadeStartDistance, a
// quest's markers by their own settings; the HUD holds 48 markers at once.

/** The markers the HUD's compass holds at once (the engine's own count). */
export const MAX_COMPASS_MARKERS = 48;

/** The game settings a compass marker's look comes from (GMSTs). */
export interface MarkerLookSettings {
  /** iMapMarkerFadeStartDistance. */
  readonly fadeStart: number;
  /** fMapMarkerMinFadeAlpha, fMapMarkerMinPercentSize, fMapMarkerMaxPercentSize. */
  readonly minAlpha: number;
  readonly minSize: number;
  readonly maxSize: number;
  /** fMapQuestMarkerMinFadeAlpha, ...MinPercentSize, ...MaxPercentSize: a quest's markers. */
  readonly questMinAlpha: number;
  readonly questMinSize: number;
  readonly questMaxSize: number;
}

/** The engine's defaults (the load order sets iMapMarkerFadeStartDistance 10000). */
export const MARKER_LOOK_DEFAULTS: MarkerLookSettings = {
  fadeStart: 7500,
  minAlpha: 40,
  minSize: 90,
  maxSize: 130,
  questMinAlpha: 90,
  questMinSize: 100,
  questMaxSize: 150,
};

/** The marker look settings by name (`number`: a game setting, the load order's if any). */
export function markerLookSettings(
  number: (name: string) => number | undefined,
): MarkerLookSettings {
  const setting = (name: string, fallback: number): number => number(name) ?? fallback;
  return {
    fadeStart: setting('iMapMarkerFadeStartDistance', 7500),
    minAlpha: setting('fMapMarkerMinFadeAlpha', 40),
    minSize: setting('fMapMarkerMinPercentSize', 90),
    maxSize: setting('fMapMarkerMaxPercentSize', 130),
    questMinAlpha: setting('fMapQuestMarkerMinFadeAlpha', 90),
    questMinSize: setting('fMapQuestMarkerMinPercentSize', 100),
    questMaxSize: setting('fMapQuestMarkerMaxPercentSize', 150),
  };
}

/**
 * A compass marker's alpha (0..100) and size (percent) by its distance: full alpha and the
 * largest size at the player, easing (by the squared distance) to the least alpha and size at
 * iMapMarkerFadeStartDistance and beyond; a quest's markers (its targets, the doors toward
 * them) by their own settings.
 */
export function markerLook(
  distance: number,
  quest: boolean,
  settings: MarkerLookSettings = MARKER_LOOK_DEFAULTS,
): { readonly alpha: number; readonly size: number } {
  const fade = Math.max(1, settings.fadeStart) ** 2;
  // -1 at the player .. 0 from the fade's start.
  const t = (Math.min(distance * distance, fade) - fade) / fade;
  const minAlpha = quest ? settings.questMinAlpha : settings.minAlpha;
  const min = quest ? settings.questMinSize : settings.minSize;
  const max = quest ? settings.questMaxSize : settings.maxSize;
  return { alpha: (minAlpha - 100) * t + minAlpha, size: min - (max - min) * t };
}
