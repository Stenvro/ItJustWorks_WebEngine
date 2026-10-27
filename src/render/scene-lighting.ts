// The light a scene is drawn with: the directional light, the directional ambient, the fog and
// the point lights. Plain data: the simulation reads it too (the light on actors for detection).

import type { LightCone } from '../world/cell-records.ts';
import type { Vec3 } from './math.ts';

export interface PointLight {
  readonly position: Vec3;
  readonly radius: number;
  /** Already multiplied by the light's fade. */
  readonly color: Vec3;
  /** A spot light: it lights only within its cone (undefined: every way). */
  readonly spot?: LightCone;
  /**
   * A portal-strict light: the room it alone lights (an id the scene's draws carry:
   * ModelInstance.room); undefined lights every room.
   */
  readonly room?: number;
  /** A shadow-casting light (LIGH shadow flags): how it casts (light-shadows.ts). */
  readonly shadow?: LightShadow;
}

/** How a shadow light casts: LIGH Shadow Spotlight, Shadow Hemisphere, Shadow Omnidirectional. */
export const ShadowKind = { spot: 1, hemisphere: 2, omni: 3 } as const;

export interface LightShadow {
  /** One of ShadowKind. */
  readonly kind: number;
  /** The light's identity across frames (its reference): its slot and fade follow it. */
  readonly id: number;
  /** A hemisphere light's axis (a spot light's is its cone's). */
  readonly axis?: Vec3;
}

export interface SceneFog {
  readonly nearColor: Vec3;
  readonly farColor: Vec3;
  readonly near: number;
  readonly far: number;
  readonly power: number;
  readonly max: number;
}

export interface SceneLighting {
  /** Direction towards the directional light. */
  readonly sunDirection: Vec3;
  readonly sunColor: Vec3;
  /** Ambient light from +X, −X, +Y, −Y, +Z, −Z (Skyrim's "directional ambient"). */
  readonly ambient: readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
  readonly fog: SceneFog | undefined;
  readonly lights: readonly PointLight[];
  /** Wind strength 0..1 (weather), for swaying grass. */
  readonly wind?: number;
  /** Where the wind blows towards: radians clockwise from north (+Y). */
  readonly windDirection?: number;
  /**
   * Ambient specular (DALC's specular colour and fresnel power: the weather's, an interior's
   * XCLL or lighting template's): a sheen at grazing angles on specular surfaces. None: none.
   */
  readonly ambientSpecular?: { readonly color: Vec3; readonly fresnelPower: number };
}

/**
 * The character light ([Display] INI, the game's defaults: bCharacterLighting 1,
 * fCharacterLightPrimaryLightIntensity 0.75, ...SecondaryLightIntensity 0.3, ...LumScale 2,
 * ...LumMax 0.75): a light from the camera and one from below-front on actors' skin.
 */
export const CHARACTER_LIGHT: {
  readonly enabled: boolean;
  readonly primary: number;
  readonly secondary: number;
  readonly lumScale: number;
  readonly lumMax: number;
} = {
  enabled: true,
  primary: 0.75,
  secondary: 0.3,
  lumScale: 2,
  lumMax: 0.75,
};

/** Uniform ambient from every direction. */
export function flatAmbient(color: Vec3): SceneLighting['ambient'] {
  return [color, color, color, color, color, color];
}
