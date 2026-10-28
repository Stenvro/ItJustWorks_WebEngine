// Volumetric lighting (VOLI, new in Skyrim SE): how strongly the sun's light scatters in the
// air of a weather, per time of day (WTHR HNAM: sunrise, day, sunset, night). The engine
// scales it by its [Display] settings (fVolumetricLightingIntensity, ...). Platform-independent.
// Layout: xEdit's TES5 definitions (VOLI); docs/formats/esm.md ("Lens flares and volumetric
// lighting").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';
import type { Rgb } from './weather.ts';

export interface VolumetricLighting {
  readonly intensity: number;
  /** How much `color` replaces the sun's own colour (0: the sun's). */
  readonly customColorContribution: number;
  readonly color: Rgb;
  /** The density noise: how much it shows, its size and how it drifts. */
  readonly densityContribution: number;
  readonly densitySize: number;
  readonly densityWindSpeed: number;
  readonly densityFallingSpeed: number;
  /** The phase function: how much the light gathers towards the sun, and how tightly. */
  readonly phaseContribution: number;
  readonly phaseScattering: number;
  /** How far the samples reach (max 1 in the CK; vanilla 40: the engine clamps). */
  readonly rangeFactor: number;
}

export const NO_VOLUMETRIC_LIGHTING: VolumetricLighting = {
  intensity: 0,
  customColorContribution: 0,
  color: [1, 1, 1],
  densityContribution: 0,
  densitySize: 0,
  densityWindSpeed: 0,
  densityFallingSpeed: 0,
  phaseContribution: 0,
  phaseScattering: 0,
  rangeFactor: 0,
};

export function parseVolumetricLighting(record: Pick<GameRecord, 'fields'>): VolumetricLighting {
  const float = (type: string, fallback: number): number => {
    const data = record.fields.first(type);
    return data && data.byteLength >= 4 ? view(data).getFloat32(0, true) : fallback;
  };
  return {
    intensity: float('CNAM', 0),
    customColorContribution: float('DNAM', 0),
    color: [float('ENAM', 1), float('FNAM', 1), float('GNAM', 1)],
    densityContribution: float('HNAM', 0),
    densitySize: float('INAM', 0),
    densityWindSpeed: float('JNAM', 0),
    densityFallingSpeed: float('KNAM', 0),
    phaseContribution: float('LNAM', 0),
    phaseScattering: float('MNAM', 0),
    rangeFactor: float('NNAM', 0),
  };
}

/** The weighted mix of the time of day's (and a fading weather's) volumetric lightings. */
export function blendVolumetricLighting(
  entries: readonly { readonly lighting: VolumetricLighting; readonly weight: number }[],
): VolumetricLighting {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (!(total > 0)) return NO_VOLUMETRIC_LIGHTING;
  const mix = (pick: (lighting: VolumetricLighting) => number): number =>
    entries.reduce((sum, { lighting, weight }) => sum + pick(lighting) * Math.max(0, weight), 0) /
    total;
  return {
    intensity: mix((l) => l.intensity),
    customColorContribution: mix((l) => l.customColorContribution),
    color: [mix((l) => l.color[0]), mix((l) => l.color[1]), mix((l) => l.color[2])],
    densityContribution: mix((l) => l.densityContribution),
    densitySize: mix((l) => l.densitySize),
    densityWindSpeed: mix((l) => l.densityWindSpeed),
    densityFallingSpeed: mix((l) => l.densityFallingSpeed),
    phaseContribution: mix((l) => l.phaseContribution),
    phaseScattering: mix((l) => l.phaseScattering),
    rangeFactor: mix((l) => l.rangeFactor),
  };
}

/** The [Display] settings the engine scales the weather's volumetric lighting by. */
export interface VolumetricSettings {
  /** bVolumetricLightingEnable. */
  readonly enabled: boolean;
  /** fVolumetricLightingIntensity: the strength of all of it. */
  readonly intensity: number;
}

/**
 * The god rays' strength and colour this frame: the weather's intensity scaled by the settings,
 * the sun's colour mixed with its custom colour, faded as the sun sets below the horizon
 * (`sunHeight`: the sun direction's up component). The phase contribution is not a strength:
 * it weighs the phase function against even scattering (godRayPhase). TODO(M13): the original
 * scatters through a froxel volume lit by the shadow map; we gather the light's way through
 * the sky radially from the sun.
 */
export function godRays(
  lighting: VolumetricLighting,
  settings: VolumetricSettings,
  sunColor: Rgb,
  sunHeight: number,
): {
  readonly strength: number;
  readonly color: Rgb;
  readonly decay: number;
  /** The phase function's asymmetry g (0..0.95): godRayPhase. */
  readonly scattering: number;
  /** The phase function's share against even scattering (0..1): godRayPhase. */
  readonly phaseContribution: number;
} {
  const above = Math.max(0, Math.min(1, (sunHeight + 0.02) / 0.1));
  const strength = settings.enabled ? lighting.intensity * settings.intensity * above : 0;
  const custom = Math.max(0, Math.min(1, lighting.customColorContribution));
  const channel = (i: 0 | 1 | 2): number => sunColor[i] * (1 - custom) + lighting.color[i] * custom;
  const color: Rgb = [channel(0), channel(1), channel(2)];
  // Tighter scattering keeps the rays near the sun: the samples fade faster along the blur.
  const decay = 0.9 + 0.09 * Math.max(0, Math.min(1, lighting.phaseScattering));
  return {
    strength,
    color,
    decay,
    scattering: phaseAsymmetry(lighting.phaseScattering),
    phaseContribution: Math.max(0, Math.min(1, lighting.phaseContribution)),
  };
}

/** VOLI's phase scattering as the phase function's asymmetry g (forward only, below 1). */
export function phaseAsymmetry(scattering: number): number {
  return Math.max(0, Math.min(0.95, scattering));
}

/**
 * The phase function of the god rays (shaders/sun-effects.wgsl rayPhase), as the original's
 * volumetric lighting weighs each sample: (1 - g^2) / (4 pi (1 - g cos)) at `cosAngle` between
 * the view ray and the light, mixed with 1 (even scattering) by the phase contribution. With
 * the vanilla values (g 0.7..0.85, contribution 0.7..0.85) it stays between about 0.15 and 0.3:
 * the light is mostly an even haze, a little stronger towards the sun.
 */
export function godRayPhase(cosAngle: number, g: number, contribution: number): number {
  const denominator = 4 * Math.PI * (1 - g * Math.max(-1, Math.min(1, cosAngle)));
  const phase = (1 - g * g) / Math.max(denominator, 1e-6);
  return 1 + (phase - 1) * contribution;
}
