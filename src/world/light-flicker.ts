// Flickering and pulsing lights (LIGH flags): brightness and position vary over time with
// the light's period and amplitudes. Platform-independent.
// TODO(M13): the engine's exact flicker curve; this uses smooth noise with the same period.

import { LightFlag } from './cell-records.ts';

export interface FlickerParams {
  readonly flags: number;
  /** Seconds per flicker or pulse. */
  readonly period: number;
  /** Brightness change (fraction). */
  readonly intensityAmplitude: number;
  /** Position change (units). */
  readonly movementAmplitude: number;
}

export interface Flicker {
  /** Brightness factor. */
  readonly scale: number;
  readonly offset: readonly [number, number, number];
}

const STEADY: Flicker = { scale: 1, offset: [0, 0, 0] };

/** Smooth noise in −1..1: a few sines at unrelated frequencies. */
function noise(t: number, seed: number): number {
  return (
    Math.sin(t * 6.2831853 + seed) * 0.5 +
    Math.sin(t * 13.37 + seed * 1.7) * 0.3 +
    Math.sin(t * 27.91 + seed * 2.3) * 0.2
  );
}

/** Brightness and offset of a light at a moment; `seed` keeps neighbouring lights apart. */
export function lightFlicker(params: FlickerParams, seconds: number, seed: number): Flicker {
  const { flags } = params;
  const flicker = (flags & (LightFlag.flicker | LightFlag.flickerSlow)) !== 0;
  const pulse = (flags & (LightFlag.pulse | LightFlag.pulseSlow)) !== 0;
  if (!flicker && !pulse) return STEADY;
  const slow = (flags & (LightFlag.flickerSlow | LightFlag.pulseSlow)) !== 0;
  const period = Math.max(params.period, 0.05) * (slow ? 2 : 1);
  const t = seconds / period;
  const wave = pulse ? Math.sin(t * 6.2831853 + seed) : noise(t, seed);
  const scale = Math.max(0, 1 + wave * params.intensityAmplitude);
  if (!flicker || params.movementAmplitude <= 0) return { scale, offset: [0, 0, 0] };
  const m = params.movementAmplitude;
  return {
    scale,
    offset: [
      noise(t * 0.7, seed + 11) * m,
      noise(t * 0.7, seed + 23) * m,
      noise(t * 0.7, seed + 37) * m,
    ],
  };
}
