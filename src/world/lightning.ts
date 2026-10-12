// Lightning in thunderstorms (WTHR DATA thunder frequency, fade points and lightning colour):
// when flashes come and how one looks over time. Platform-independent.
// TODO(M6): the thunder sounds that follow each flash.
// Notes: docs/formats/esm.md ("Climate and weather").

/**
 * Mean seconds between flashes, or undefined for weathers without lightning. Thunder
 * frequency 255 (all calm weathers) means none; lower values come more often: vanilla storms
 * use 246 (rain) and 203 (snow), the Storm Call shout 15. Read as a mean interval of
 * value/255 × 30 seconds (about every half minute in a storm, every 2 s for Storm Call).
 */
export function lightningInterval(frequency: number): number | undefined {
  if (frequency >= 255) return undefined;
  return Math.max(0.5, (frequency / 255) * 30);
}

/** Seconds a flash lasts. */
export const FLASH_SECONDS = 0.6;

/** A flash's brightness 0..1 at `t` seconds after it began: a bright strike and a re-strike. */
export function flashIntensity(t: number): number {
  if (t < 0 || t > FLASH_SECONDS) return 0;
  const strike = Math.max(0, 1 - t / 0.12);
  const restrike = 0.7 * Math.max(0, 1 - Math.abs(t - 0.28) / 0.08);
  const glow = 0.25 * Math.max(0, 1 - t / FLASH_SECONDS);
  return Math.min(1, strike + restrike + glow);
}

/**
 * How much of a weather's thunder is on during a change of weather (like precipitation: the
 * new weather's from its Thunder Begin Fade In, the old one's until its End Fade Out).
 */
export function thunderAmount(
  current: { readonly thunderFrequency: number; readonly thunderFadeIn: number },
  previous: { readonly thunderFrequency: number; readonly thunderFadeOut: number } | undefined,
  transition: number,
): number {
  let amount = 0;
  if (current.thunderFrequency < 255) {
    const begin = Math.min(0.999, Math.max(0, current.thunderFadeIn));
    amount = previous ? Math.max(0, Math.min(1, (transition - begin) / (1 - begin))) : 1;
  }
  if (previous && previous.thunderFrequency < 255) {
    const end = Math.max(0.001, previous.thunderFadeOut);
    amount = Math.max(amount, 1 - transition / end);
  }
  return Math.max(0, Math.min(1, amount));
}
