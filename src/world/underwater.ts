// The view below a water surface, as observed in the original. Platform-independent.
//
// Each frame the camera's near plane is measured against the water at the camera: its four
// corners' heights against the surface's give the state (nearPlaneWater). All above: the view
// is above water. All below: the underwater view covers the whole image. Across: the engine
// draws the part of the screen under the surface into its underwater mask (a quad from the
// line where the water's plane cuts the near plane, turned by the camera's roll, down to the
// screen's lower edge) and the underwater view applies there alone. On the near plane a
// point's height is linear in its screen position, so that line is a half-plane of the screen.
//
// The underwater view is an image pass, not the scene's fog: the depth of field's fogged
// shaders turn the image toward the fog colour by the view depth, from none at the water
// type's underwater fog near plane to all of it at its far plane (WATR DNAM), only inside the
// mask where the view crosses the surface. The fog colour is the water's shallow colour times
// the weather's water multiplier (sky colour 14; white indoors): the weather lights it, dark
// at night. The water type's underwater fog amount reaches the shader but is not read by it.
// Inside the mask the depth of field is the water's imagespace's (WATR INAM), outside it the
// scene's; wholly under, the water's imagespace takes the scene's place.
//
// TODO(M13): where the engine swaps in the water's imagespace's colour terms (tint,
// saturation, brightness) is unread; ours takes them over the whole image once the near plane
// is wholly under, as its depth of field does.

import { NEUTRAL_IMAGE_SPACE, parseImageSpace, type ImageSpace } from './image-space.ts';
import type { GameRecord } from './record-db.ts';
import type { Vec3 } from '../render/math.ts';
import type { WaterType } from './water.ts';

/** A record as the underwater view reads an imagespace from it. */
type ImageSpaceSource = Pick<GameRecord, 'type' | 'fields'>;

/** Which side of the water the camera's near plane is on. */
export type NearPlaneState = 'above' | 'across' | 'under';

/** The camera's near plane against water (nearPlaneWater). */
export interface NearPlaneWater {
  readonly state: NearPlaneState;
  /** The submerged share of the near plane's height range (0..1). */
  readonly share: number;
  /**
   * The underwater mask as a half-plane of the screen: the near plane's height over the water
   * at normalized device coordinates (x, y) is x * mask[0] + y * mask[1] + mask[2]; the screen
   * is under the surface where that is below 0.
   */
  readonly mask: readonly [number, number, number];
}

/**
 * How the camera's near plane lies against water at `waterHeight` (observed in the original):
 * its four corners' heights give the submerged share of its height range; `above` (no corner
 * under), `under` (every corner under) or `across` (the underwater mask splits the screen). A
 * level near plane (looking straight up or down) takes the camera's own side.
 */
export function underwaterCrossing(
  corners: readonly (readonly [number, number, number])[],
  waterHeight: number,
  cameraZ: number,
): { readonly state: NearPlaneState; readonly share: number } {
  const heights = corners.map((corner) => corner[2]);
  const low = Math.min(...heights);
  const high = Math.max(...heights);
  if (!(high > low)) {
    const under = cameraZ < waterHeight;
    return { state: under ? 'under' : 'above', share: under ? 1 : 0 };
  }
  const share = Math.min(1, Math.max(0, (waterHeight - low) / (high - low)));
  return { state: share <= 0 ? 'above' : share >= 1 ? 'under' : 'across', share };
}

/**
 * The near plane of a camera against water at `waterHeight`, from the inverse of the camera's
 * view-projection (column-major, reversed Z: the near plane at depth 1): the state, and the
 * mask's half-plane on the screen.
 */
export function nearPlaneWater(
  inverseViewProjection: ArrayLike<number>,
  waterHeight: number,
  cameraZ: number,
): NearPlaneWater {
  const m = (i: number): number => inverseViewProjection[i] ?? 0;
  const at = (x: number, y: number): [number, number, number] => {
    const w = m(3) * x + m(7) * y + m(11) + m(15);
    const scale = w === 0 ? 1 : 1 / w;
    return [
      (m(0) * x + m(4) * y + m(8) + m(12)) * scale,
      (m(1) * x + m(5) * y + m(9) + m(13)) * scale,
      (m(2) * x + m(6) * y + m(10) + m(14)) * scale,
    ];
  };
  const corners = [at(-1, -1), at(1, -1), at(-1, 1), at(1, 1)];
  const centre = at(0, 0)[2];
  const right = at(1, 0)[2];
  const top = at(0, 1)[2];
  return {
    ...underwaterCrossing(corners, waterHeight, cameraZ),
    mask: [right - centre, top - centre, centre - waterHeight],
  };
}

/** Whether the screen point at normalized device coordinates (x, y) is in the mask. */
export function inUnderwaterMask(
  mask: readonly [number, number, number],
  x: number,
  y: number,
): boolean {
  return x * mask[0] + y * mask[1] + mask[2] < 0;
}

/** Whether a camera at height `z` is below the surface of water at `waterHeight`. */
export function isUnderwater(z: number, waterHeight: number | undefined): boolean {
  return waterHeight !== undefined && z < waterHeight;
}

/** The underwater fog colour: the water's shallow colour times the weather's water multiplier. */
export function underwaterFogColor(
  type: Pick<WaterType, 'shallowColor'>,
  multiplier: readonly number[] = [1, 1, 1],
): Vec3 {
  return [
    type.shallowColor[0] * (multiplier[0] ?? 1),
    type.shallowColor[1] * (multiplier[1] ?? 1),
    type.shallowColor[2] * (multiplier[2] ?? 1),
  ];
}

/**
 * How much of the fog colour a pixel at view depth `depth` takes: none at the near plane, all
 * at the far plane, as the original's shader computes it (a far plane before the near one, as
 * HelgenWater's, fogs what is nearer than it fully and leaves what is beyond the near plane).
 */
export function underwaterFogShare(depth: number, near: number, far: number): number {
  if (far === near) return depth >= near ? 1 : 0;
  return Math.min(1, Math.max(0, (depth - near) / (far - near)));
}

/**
 * The imagespace wholly under water (observed in the original): the scene's own (the weather's
 * or the cell's, with the modifiers on it) with the depth of field of the water's imagespace
 * (WATR INAM: its strength, distance, range, sides and blur radius) in place of its own. The
 * water's imagespace reaches nothing else: no HDR, cinematic or tint term of it is ever read.
 * Without a water imagespace (or above water), the scene's unchanged.
 */
export function underwaterImageSpace(
  scene: ImageSpace | undefined,
  water: ImageSpace | undefined,
): ImageSpace | undefined {
  if (!water) return scene;
  return { ...(scene ?? NEUTRAL_IMAGE_SPACE), depthOfField: water.depthOfField };
}

/** What the image passes need of the underwater view this frame (post.ts, shaders/dof.wgsl). */
export interface UnderwaterFrame {
  /** The fog colour (underwaterFogColor). */
  readonly color: Vec3;
  /** The water type's underwater fog near and far planes (view depth). */
  readonly near: number;
  readonly far: number;
  /** The underwater mask where the view crosses the surface; undefined: the whole image. */
  readonly mask?: readonly [number, number, number];
  /** Inside the mask: the depth of field of the water's imagespace (where it has one). */
  readonly depthOfField?: ImageSpace['depthOfField'];
}

/**
 * A viewer's underwater view: the water types it looks up (by form id, kept once loaded) and
 * their imagespaces, and what the image passes take from the water at the camera.
 */
export class UnderwaterView {
  readonly #types = new Map<number, WaterType | undefined>();
  readonly #lookup: (formId: number) => Promise<WaterType | undefined> | undefined;
  readonly #records:
    ((formId: number) => Promise<ImageSpaceSource | undefined> | undefined) | undefined;
  readonly #imageSpaces = new Map<number, ImageSpace | undefined>();
  /** The water type the near plane was wholly under at the last frame() call. */
  #under: WaterType | undefined;

  constructor(
    lookup: (formId: number) => Promise<WaterType | undefined> | undefined,
    records?: (formId: number) => Promise<ImageSpaceSource | undefined> | undefined,
  ) {
    this.#lookup = lookup;
    this.#records = records;
  }

  /**
   * The imagespace of the water the near plane was last found wholly under (WATR INAM), once
   * loaded; undefined otherwise or for a water type without one.
   */
  imageSpace(): ImageSpace | undefined {
    return this.#imageSpaceOf(this.#under);
  }

  /**
   * The underwater view of the water at the camera (`water`), with `nearPlane` measuring the
   * camera's near plane against a height (nearPlaneWater) and the weather's water multiplier
   * (none indoors); undefined above it (or while its water type loads).
   */
  frame(
    water: { readonly height: number; readonly type: number } | undefined,
    nearPlane: (height: number) => NearPlaneWater,
    multiplier?: readonly number[],
  ): UnderwaterFrame | undefined {
    this.#under = undefined;
    if (!water) return undefined;
    const crossing = nearPlane(water.height);
    if (crossing.state === 'above') return undefined;
    const type = this.#type(water.type);
    if (!type) return undefined;
    const fog = {
      color: underwaterFogColor(type, multiplier),
      near: type.underwaterFogNear,
      far: type.underwaterFogFar,
    };
    if (crossing.state === 'under') {
      this.#under = type;
      return fog;
    }
    const space = this.#imageSpaceOf(type);
    return { ...fog, mask: crossing.mask, ...(space && { depthOfField: space.depthOfField }) };
  }

  #type(formId: number): WaterType | undefined {
    if (!this.#types.has(formId)) {
      this.#types.set(formId, undefined);
      void this.#lookup(formId)?.then((type) => {
        if (type) this.#types.set(formId, type);
      });
    }
    return this.#types.get(formId);
  }

  #imageSpaceOf(type: WaterType | undefined): ImageSpace | undefined {
    const formId = type?.imageSpace;
    if (formId === undefined) return undefined;
    if (!this.#imageSpaces.has(formId)) {
      this.#imageSpaces.set(formId, undefined);
      void this.#records?.(formId)?.then((record) => {
        if (record?.type === 'IMGS') this.#imageSpaces.set(formId, parseImageSpace(record));
      });
    }
    return this.#imageSpaces.get(formId);
  }
}
