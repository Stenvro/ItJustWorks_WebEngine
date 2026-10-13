// How loud and at what pitch a sound plays: the output model's distance curve, the
// descriptor's static attenuation and random variations. Platform-independent.
// Notes: docs/audio.md.

import type { SoundAttenuation, SoundDescriptor } from '../world/sound-records.ts';

/** Linear gain of a level in dB (−6 dB ≈ half the amplitude). */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/**
 * The output model's volume at a distance: the curve's five points (percent) spread evenly
 * from the minimum to the maximum distance and joined by straight lines; inside the minimum
 * the first point, beyond the maximum silence (TODO(M13): the engine's own spacing).
 */
export function distanceGain(attenuation: SoundAttenuation | undefined, distance: number): number {
  if (!attenuation) return 1;
  const { minDistance, maxDistance, curve } = attenuation;
  if (distance > maxDistance) return 0;
  if (distance <= minDistance || maxDistance <= minDistance) return (curve[0] ?? 100) / 100;
  const t = ((distance - minDistance) / (maxDistance - minDistance)) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(t));
  const f = t - i;
  return ((curve[i] ?? 0) * (1 - f) + (curve[i + 1] ?? 0) * f) / 100;
}

/**
 * A playing instance's own volume: the static attenuation and a random cut of up to the
 * dB variance (`random` in [0, 1)).
 */
export function instanceGain(descriptor: SoundDescriptor, random: number): number {
  return dbToGain(-descriptor.staticAttenuation - random * descriptor.dbVariance);
}

/**
 * A playing instance's pitch (playback rate): the frequency shift plus a random variation of
 * up to ± the variance, both in percent (`random` in [0, 1)).
 */
export function instancePitch(descriptor: SoundDescriptor, random: number): number {
  const variation = (random * 2 - 1) * descriptor.frequencyVariance;
  return Math.max(0.01, 1 + (descriptor.frequencyShift + variation) / 100);
}
