// Lightning in thunderstorms (WTHR DATA thunder frequency, fade points and lightning colour):
// when thunder comes (src/audio/ambience.ts starts it, and the flash with it) and how a flash
// looks over time. Platform-independent.
// Notes: docs/formats/esm.md ("Climate and weather").

/** Seconds between the checks for thunder (observed in the original: 30 ms). */
export const THUNDER_CHECK_SECONDS = 0.03;

/**
 * Observed in the original: at each check, every thunder sound (WTHR SNAM type 3) of the
 * current or the leaving weather that is not playing starts with a chance of one in its
 * weather's thunder frequency × the thunder sounds of both weathers, and the lightning flash
 * comes with it: a weather without thunder sounds never flashes.
 * Vanilla storms (246 in rain, 203 in snow) thunder about every 7 s, Storm Call (15) about
 * twice a second.
 */
export function thunderChance(frequency: number, thunderSounds: number): number {
  return 1 / Math.max(1, frequency * thunderSounds);
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
 * A weather's share of a fading effect during a change of weather (thunder: its Thunder Begin
 * Fade In and End Fade Out; precipitation: its own), observed in the original: the arriving
 * weather's from its begin point of the change, the leaving one's until its end point;
 * without a change, all.
 */
export function fadeShare(
  begin: number,
  end: number,
  leaving: boolean,
  transition: number | undefined,
): number {
  if (transition === undefined) return leaving ? 0 : 1;
  if (leaving) {
    const until = end + 0.001;
    return transition >= until ? 0 : 1 - transition / until;
  }
  if (transition < begin || begin >= 1) return 0;
  return (transition - begin) / (1 - begin);
}
