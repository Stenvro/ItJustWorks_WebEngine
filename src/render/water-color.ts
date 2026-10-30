// The water's colour, as the water shader makes it (shaders/water.wgsl fs_water), for tests and
// tools: the scene below sinks into the water type's fog, from its shallow towards its deep
// colour, the weather's water multiplier tints it, and the reflection takes over by the fresnel
// term; the depth properties take reflections, refraction, normals and the sun's specular back
// where the water is shallow. Platform-independent.
//
// These are the original water shader's terms (observed in the original): how deep the water
// is counts as a share of the fog's far distance (WATR DNAM Fog Distance - Far Plane); the body
// goes from the shallow to the deep colour over it; the fog over the scene below is
// 1 - ((far - depth) / (far - near))^amount; the reflection is the reflection colour taken over
// by the reflected scene by the Reflection Magnitude; the fresnel is Schlick's from the Fresnel
// Amount. TODO(M13): which WATR value feeds which of the shader's constants is our reading
// (xEdit's names against the terms), the engine's material setup is unread.

import type { WaterType } from '../world/water.ts';
import type { Rgb } from '../world/weather.ts';

/** How deep water is by a depth: 0 at the surface .. 1 at the fog's far distance and beyond. */
export function waterDeepness(depth: number, type: Pick<WaterType, 'fogFar'>): number {
  return Math.max(0, Math.min(1, depth / Math.max(type.fogFar, 1e-3)));
}

/** The water fog over a distance through the water: 0 at fog near .. 1 at fog far. */
export function waterFog(
  depth: number,
  type: Pick<WaterType, 'fogNear' | 'fogFar' | 'fogAmount'>,
): number {
  const far = Math.max(type.fogFar, 1e-3);
  const range = Math.max(far - type.fogNear, 1e-3);
  const clear = Math.max(0, Math.min(1, (far - Math.min(depth, far)) / range));
  return 1 - clear ** Math.max(type.fogAmount, 1e-3);
}

/**
 * The share of the reflections, refraction, normals and sun specular (in that order) the water
 * keeps at a deepness: all of them deep down, each depth property's share less at the shore.
 */
export function depthControl(
  type: Pick<WaterType, 'depthReflections' | 'depthRefraction' | 'depthNormals' | 'depthSpecular'>,
  deepness: number,
): [number, number, number, number] {
  const d = Math.max(0, Math.min(1, deepness)) - 1;
  return [
    type.depthReflections * d + 1,
    type.depthRefraction * d + 1,
    type.depthNormals * d + 1,
    type.depthSpecular * d + 1,
  ];
}

/** Schlick's fresnel with the water's Fresnel Amount as its base; `facing`: cos(view, normal). */
export function waterFresnel(fresnel: number, facing: number): number {
  const f = Math.max(0, Math.min(1, facing));
  return fresnel + (1 - fresnel) * (1 - f) ** 5;
}

export interface WaterColorInput {
  /** The scene below the surface, and how far the view ray goes through the water to it. */
  readonly below: Rgb;
  readonly thickness: number;
  /** cos of the angle between the view and the surface's normal. */
  readonly facing: number;
  /** What the surface reflects (the reflection cube, or the scene where it finds it). */
  readonly reflected: Rgb;
  /** The weather's water multiplier. */
  readonly multiplier: Rgb;
}

/** The water's colour at a point near the camera, before the sun's specular and the air's fog. */
export function waterColor(type: WaterType, input: WaterColorInput): Rgb {
  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const times = (a: Rgb, b: Rgb): Rgb => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  const deepness = waterDeepness(input.thickness, type);
  const body = times(mix(type.shallowColor, type.deepColor, deepness), input.multiplier);
  const refracted = mix(input.below, body, waterFog(input.thickness, type));
  const reflection = mix(
    times(type.reflectionColor, input.multiplier),
    input.reflected,
    type.reflectionMagnitude,
  );
  const [reflections] = depthControl(type, deepness);
  const share = waterFresnel(type.fresnel, input.facing) * reflections;
  return mix(refracted, reflection, Math.max(0, Math.min(1, share)));
}
