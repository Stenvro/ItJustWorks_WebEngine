// The view below a water surface: when the camera is under the water it stands in, the scene's
// fog becomes the water type's underwater fog (WATR DNAM: underwater fog amount, near and far
// plane), coloured by the water's shallow colour near the camera and its deep colour far away,
// lit by the scene's light (dark water at night). Platform-independent.
//
// TODO(M13): the engine's exact underwater colour (how it lights the water's colours, and the
// image space it adds below the surface) is not read from the executable yet.

import type { SceneFog, SceneLighting } from '../render/scene-lighting.ts';
import { NEUTRAL_IMAGE_SPACE, type ImageSpace } from './image-space.ts';
import type { Vec3 } from '../render/math.ts';
import type { WaterType } from './water.ts';

/** Whether a camera at height `z` is below the surface of water at `waterHeight`. */
export function isUnderwater(z: number, waterHeight: number | undefined): boolean {
  return waterHeight !== undefined && z < waterHeight;
}

const luminance = (color: Vec3): number =>
  0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];

/** How lit the water is: the sun and the mean ambient, from a dim floor up to full light. */
export function underwaterLight(lighting: Pick<SceneLighting, 'sunColor' | 'ambient'>): number {
  const ambient = lighting.ambient.reduce((sum, color) => sum + luminance(color), 0) / 6;
  return Math.min(1, Math.max(0.1, luminance(lighting.sunColor) + ambient));
}

/**
 * A viewer's underwater fog: the water types it looks up (by form id, kept once loaded) and
 * the fog when the camera is under the water it stands in.
 */
export class UnderwaterView {
  readonly #types = new Map<number, WaterType | undefined>();
  readonly #lookup: (formId: number) => Promise<WaterType | undefined> | undefined;

  constructor(lookup: (formId: number) => Promise<WaterType | undefined> | undefined) {
    this.#lookup = lookup;
  }

  /** The fog below the surface; undefined above it (or while its water type loads). */
  fog(
    cameraZ: number,
    water: { readonly height: number; readonly type: number } | undefined,
    lighting: Pick<SceneLighting, 'sunColor' | 'ambient'>,
  ): SceneFog | undefined {
    if (!water || !isUnderwater(cameraZ, water.height)) return undefined;
    if (!this.#types.has(water.type)) {
      this.#types.set(water.type, undefined);
      void this.#lookup(water.type)?.then((type) => {
        if (type) this.#types.set(water.type, type);
      });
    }
    const type = this.#types.get(water.type);
    return type && underwaterFog(type, lighting);
  }
}

/**
 * How much of the water's colour lies over the whole image below the surface, at the water's full
 * fog amount. The fog colours only the geometry; the tint gives the sky, the grass and the water's
 * surface seen from below the water's colour too. TODO(M13): the engine's underwater image space
 * is not read from the executable; half of the fog's amount looks like the game.
 */
export const UNDERWATER_TINT = 0.5;

/** The full-screen tint of the underwater fog (its near colour); none above the surface. */
export function underwaterTint(
  fog: SceneFog | undefined,
): { readonly color: Vec3; readonly amount: number } | undefined {
  if (!fog) return undefined;
  return { color: fog.nearColor, amount: UNDERWATER_TINT * Math.min(1, Math.max(0, fog.max)) };
}

/** An imagespace with the underwater tint (the neutral one where there is none). */
export function withUnderwaterTint(
  space: ImageSpace | undefined,
  fog: SceneFog | undefined,
): ImageSpace | undefined {
  const underwater = underwaterTint(fog);
  if (!underwater) return space;
  return { ...(space ?? NEUTRAL_IMAGE_SPACE), underwater };
}

/** The fog seen from under the water of a type, in the scene's light. */
export function underwaterFog(
  type: Pick<
    WaterType,
    'underwaterFogAmount' | 'underwaterFogNear' | 'underwaterFogFar' | 'shallowColor' | 'deepColor'
  >,
  lighting: Pick<SceneLighting, 'sunColor' | 'ambient'>,
): SceneFog {
  const light = underwaterLight(lighting);
  const lit = (color: readonly number[]): Vec3 => [
    (color[0] ?? 0) * light,
    (color[1] ?? 0) * light,
    (color[2] ?? 0) * light,
  ];
  return {
    nearColor: lit(type.shallowColor),
    farColor: lit(type.deepColor),
    near: type.underwaterFogNear,
    // A far plane before the near one (HelgenWater) fogs fully just past the near plane.
    far: Math.max(type.underwaterFogFar, type.underwaterFogNear + 1),
    power: 1,
    // Amount 0 would mean "no limit" to the fog shader: keep a sliver of water fog.
    max: Math.max(type.underwaterFogAmount, 0.01),
  };
}
