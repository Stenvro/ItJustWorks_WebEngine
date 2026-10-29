// The water's colour, as the water shader makes it (shaders/water.wgsl fs_water), for tests and
// tools: the scene below sinks into the water type's fog, from its shallow towards its deep
// colour, the weather's water multiplier tints it, and the reflection takes over by the fresnel
// term and the reflectivity; the depth properties take reflections, refraction, normals and the
// sun's specular back where the water is shallow. Platform-independent.
//
// The fog's distance is the way the view ray travels through the water to what lies below; at
// fog near nothing is fogged, at fog far the fog amount is reached (WATR DNAM, xEdit's TES5
// definition: Fog Properties). TODO(M13): the original's shader is not readable; this is our
// model of its terms (the fresnel is Schlick's, its base the Fresnel Amount).

import type { WaterType } from '../world/water.ts';
import type { Rgb } from '../world/weather.ts';

/** How deep water is by its fog's distance: 0 at fog near .. 1 at fog far and beyond. */
export function waterDeepness(
  thickness: number,
  type: Pick<WaterType, 'fogNear' | 'fogFar'>,
): number {
  const range = Math.max(type.fogFar - type.fogNear, 1);
  return Math.max(0, Math.min(1, (thickness - type.fogNear) / range));
}

/** The water fog over a distance through the water (0 .. the fog amount). */
export function waterFog(
  thickness: number,
  type: Pick<WaterType, 'fogNear' | 'fogFar' | 'fogAmount'>,
): number {
  return waterDeepness(thickness, type) * type.fogAmount;
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
  /** The sky the surface reflects (the scene, where it reflects that, replaces the result). */
  readonly reflected: Rgb;
  /** The weather's water multiplier. */
  readonly multiplier: Rgb;
}

/** The water's colour at a point, before the sun's specular and the air's fog. */
export function waterColor(type: WaterType, input: WaterColorInput): Rgb {
  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const times = (a: Rgb, b: Rgb): Rgb => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  const fog = waterFog(input.thickness, type);
  const body = times(mix(type.shallowColor, type.deepColor, fog), input.multiplier);
  const underwater = mix(input.below, body, fog);
  const reflection = mix(
    input.reflected,
    times(type.reflectionColor, input.multiplier),
    type.reflectionMagnitude,
  );
  const [reflections] = depthControl(type, waterDeepness(input.thickness, type));
  const share = waterFresnel(type.fresnel, input.facing) * type.reflectivity * reflections;
  return mix(underwater, reflection, Math.max(0, Math.min(1, share)));
}
