// The lighting shader's own distance fades, by the original's rule. Every geometry keeps a fade
// value: its distance from the camera divided by its fade kind's multiplier (the settings Actor,
// Item and Object Fade, object-fade.ts; a multiplier of 0 or less takes a fifth of the distance),
// over 7200. As that value grows, specular fades out from
// fSpecularLODFadeStart to fSpecularLODFadeEnd, the environment map from fEnvmapLODFadeStart to
// ...End, decals (Decal and Dynamic_Decal shapes) from fDecalLODFadeStart to ...End, and
// refraction from fRefractionLODFadeStart to ...End (all INI [LightingShader]; Skyrim_Default.ini
// moves the decals' to 0.45 and 0.5). SLSF2 No_Fade spares decals and refraction their fades; it
// does not stop the object fade. The shaders compute the value per draw (common.wgsl
// lodFadeValue) from the scales and ranges written here into the frame. Platform-independent.

import { fadeMultiplier, type FadeKind, type FadeSettings } from './object-fade.ts';

/** The camera distance a fade value of 1 stands for, at a multiplier of 1. */
export const LOD_FADE_DISTANCE = 7200;

/** Where each feature fades out, in fade values (INI [LightingShader]). */
export interface ShaderFadeSettings {
  readonly specularStart: number;
  readonly specularEnd: number;
  readonly envmapStart: number;
  readonly envmapEnd: number;
  readonly decalStart: number;
  readonly decalEnd: number;
  readonly refractionStart: number;
  readonly refractionEnd: number;
}

/** The executable's defaults (before Skyrim_Default.ini). */
export const DEFAULT_SHADER_FADES: ShaderFadeSettings = {
  specularStart: 0.09,
  specularEnd: 0.1,
  envmapStart: 0.09,
  envmapEnd: 0.1,
  decalStart: 0.05,
  decalEnd: 0.06,
  refractionStart: 0.025,
  refractionEnd: 0.03,
};

/** A fade kind's index in the frame's scales (common.wgsl lodFadeValue: flags.w bits 5-6). */
export function fadeKindIndex(kind: FadeKind | undefined): number {
  return kind === 'actor' ? 1 : kind === 'item' ? 2 : kind === 'skyCell' ? 3 : 0;
}

/** The scale from camera distance to fade value at a multiplier (0 or less: a fifth). */
function fadeScale(multiplier: number): number {
  return (multiplier > 0 ? 1 / multiplier : 0.2) / LOD_FADE_DISTANCE;
}

/** A geometry's fade value at a camera distance. */
export function lodFadeValue(distance: number, kind: FadeKind, settings: FadeSettings): number {
  return distance * fadeScale(fadeMultiplier(kind, settings));
}

/** How much of a feature is left at a fade value: 1 up to `start`, 0 from `end`. */
export function featureFade(value: number, start: number, end: number): number {
  if (value <= start) return 1;
  if (value >= end) return 0;
  return 1 - (value - start) / (end - start);
}

/**
 * The frame's twelve floats (frame.wgsl lodFadeScale, specularFades, decalFades): the scale
 * from distance to fade value per kind (object, actor, item, sky cell), then the four features' start
 * and end.
 */
export function shaderFadeFrame(objectFade: FadeSettings, fades: ShaderFadeSettings): number[] {
  return [
    fadeScale(objectFade.objects),
    fadeScale(objectFade.actors),
    fadeScale(objectFade.items),
    fadeScale(objectFade.skyCell ?? 1),
    fades.specularStart,
    fades.specularEnd,
    fades.envmapStart,
    fades.envmapEnd,
    fades.decalStart,
    fades.decalEnd,
    fades.refractionStart,
    fades.refractionEnd,
  ];
}
