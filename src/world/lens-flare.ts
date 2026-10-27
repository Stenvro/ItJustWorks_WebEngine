// Lens flares (LENS, new in Skyrim SE): sprites laid along the line from a bright light (the
// sun of a weather: WTHR GNAM; a light: LIGH LNAM) through the centre of the screen, faded as
// the light is covered. Vanilla Skyrim.esm and its DLCs have none (the engine supports them for
// plugins). Platform-independent. Layout: xEdit's TES5 definitions (LENS); docs/formats/esm.md
// ("Lens flares and volumetric lighting").

import { view, zstring } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';
import type { Rgb } from './weather.ts';

export const LensFlareSpriteFlag = {
  /** The sprite turns to lie along the flare's line. */
  rotates: 0x1,
  /** The sprite shrinks (not only fades) as the light is covered. */
  shrinksWhenOccluded: 0x2,
} as const;

export interface LensFlareSprite {
  readonly id: string;
  /** Texture path under Data (textures\...); empty: none. */
  readonly texture: string;
  readonly tint: Rgb;
  /** Size as a share of the screen's height. TODO(M13): the engine's unit is not documented. */
  readonly width: number;
  readonly height: number;
  /** Where on the line: 0 at the light, 1 at the screen's centre, 2 mirrored across it. */
  readonly position: number;
  /** Degrees off the view's centre over which the sprite fades out (0: no fade). */
  readonly angularFade: number;
  readonly opacity: number;
  readonly flags: number;
}

export interface LensFlare {
  readonly formId: number;
  readonly editorId: string;
  /** How much the light's own colour tints the sprites (0: their tint only). */
  readonly colorInfluence: number;
  /** Lights: the distance the flare fades over, as a share of the light's radius. */
  readonly fadeDistanceRadiusScale: number;
  readonly sprites: readonly LensFlareSprite[];
}

/** LFSD: tint (3 floats), width, height, position, angular fade, opacity, flags (u32). */
const LFSD_SIZE = 36;

const texturePath = (path: string): string => {
  const clean = path.replace(/\//g, '\\').replace(/^\\+/, '');
  if (clean === '') return '';
  return /^textures\\/i.test(clean) ? clean : `textures\\${clean}`;
};

export function parseLensFlare(
  record: Pick<GameRecord, 'formId' | 'editorId' | 'fields'>,
): LensFlare {
  let colorInfluence = 0;
  let fadeDistanceRadiusScale = 1;
  const sprites: LensFlareSprite[] = [];
  let current: { id: string; texture: string; data: Uint8Array | undefined } | undefined;
  let inSprites = false;
  const finish = (): void => {
    if (!current) return;
    const data = current.data;
    const d = data && data.byteLength >= LFSD_SIZE ? view(data) : undefined;
    const f = (offset: number, fallback: number): number =>
      d ? d.getFloat32(offset, true) : fallback;
    sprites.push({
      id: current.id,
      texture: current.texture,
      tint: [f(0, 1), f(4, 1), f(8, 1)],
      width: f(12, 0),
      height: f(16, 0),
      position: f(20, 0),
      angularFade: f(24, 0),
      opacity: f(28, 1),
      flags: d ? d.getUint32(32, true) : 0,
    });
    current = undefined;
  };
  for (const { type, data } of record.fields.list) {
    if (type === 'LFSP') {
      inSprites = true;
      continue;
    }
    if (!inSprites) {
      if (type === 'CNAM' && data.byteLength >= 4) colorInfluence = view(data).getFloat32(0, true);
      // Before the sprites, DNAM is the fade distance; after LFSP it starts a sprite.
      else if (type === 'DNAM' && data.byteLength >= 4) {
        fadeDistanceRadiusScale = view(data).getFloat32(0, true);
      }
      continue;
    }
    if (type === 'DNAM') {
      finish();
      current = { id: zstring(data), texture: '', data: undefined };
    } else if (type === 'FNAM') {
      current ??= { id: '', texture: '', data: undefined };
      current.texture = texturePath(zstring(data));
    } else if (type === 'LFSD') {
      current ??= { id: '', texture: '', data: undefined };
      current.data = data;
    }
  }
  finish();
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    colorInfluence,
    fadeDistanceRadiusScale,
    sprites,
  };
}

/** One sprite as drawn this frame: centre and half size in screen units (0..1, y down). */
export interface PlacedSprite {
  readonly sprite: LensFlareSprite;
  readonly center: readonly [number, number];
  /** Half width and height as shares of the screen's width and height. */
  readonly halfSize: readonly [number, number];
  /** Radians the sprite is turned by (0 unless it rotates). */
  readonly rotation: number;
  readonly color: Rgb;
  readonly opacity: number;
}

export interface FlareLight {
  /** The light's place on the screen (0..1 from the top left; may be off it). */
  readonly screen: readonly [number, number];
  /** Degrees between the view's direction and the light's. */
  readonly angle: number;
  readonly color: Rgb;
  /** How much of the light is seen (0 covered .. 1 clear). */
  readonly visibility: number;
  /** The screen's width over its height. */
  readonly aspect: number;
}

/**
 * The flare's sprites for a light seen this frame (fLensFlareGlobalIntensity scales them all);
 * none while the light is covered. TODO(M13): the engine's exact fade curves are not read.
 */
export function placeLensFlare(lens: LensFlare, light: FlareLight, intensity = 1): PlacedSprite[] {
  const visibility = Math.max(0, Math.min(1, light.visibility));
  if (visibility <= 0 || intensity <= 0) return [];
  const [sx, sy] = light.screen;
  const dx = 0.5 - sx;
  const dy = 0.5 - sy;
  const along = Math.atan2(dy, dx * light.aspect);
  const influence = Math.max(0, Math.min(1, lens.colorInfluence));
  const placed: PlacedSprite[] = [];
  for (const sprite of lens.sprites) {
    const fade =
      sprite.angularFade > 0 ? Math.max(0, 1 - Math.abs(light.angle) / sprite.angularFade) : 1;
    const opacity = sprite.opacity * fade * visibility * intensity;
    if (opacity <= 0) continue;
    const shrink = sprite.flags & LensFlareSpriteFlag.shrinksWhenOccluded ? visibility : 1;
    const tinted = (i: 0 | 1 | 2): number =>
      sprite.tint[i] * (1 - influence + influence * light.color[i]);
    const color: Rgb = [tinted(0), tinted(1), tinted(2)];
    placed.push({
      sprite,
      center: [sx + dx * sprite.position, sy + dy * sprite.position],
      halfSize: [
        (sprite.width * shrink) / 2 / Math.max(light.aspect, 1e-3),
        (sprite.height * shrink) / 2,
      ],
      rotation: sprite.flags & LensFlareSpriteFlag.rotates ? along : 0,
      color,
      opacity,
    });
  }
  return placed;
}
