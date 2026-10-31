// Texture sets (TXST) and the decals placed from them: a REFR whose base is a TXST with decal
// data (DODT) projects the set's textures onto the surfaces inside a box around it (blood,
// scorch marks, puddles, giant paint, shadow marks). Platform-independent.
// Notes: docs/formats/esm.md ("Decals").

import { identity, multiply, type Mat4 } from '../render/math.ts';

/** The record fields a texture set is read from. */
interface TextureSetSource {
  readonly editorId?: string | undefined;
  readonly fields: {
    first(type: string): Uint8Array | undefined;
    zstring(type: string): string | undefined;
  };
}

/** DODT flags. */
export const DecalFlag = {
  parallax: 0x01,
  alphaBlending: 0x02,
  alphaTesting: 0x04,
  /** Without it the texture holds four variants in a 2×2 atlas. */
  noSubtextures: 0x08,
} as const;

/** TXST DNAM flags. */
export const TextureSetFlag = {
  noSpecularMap: 0x01,
  facegenTextures: 0x02,
  modelSpaceNormals: 0x04,
} as const;

export interface DecalData {
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Size of the projection box along the reference's Y axis. */
  readonly depth: number;
  readonly shininess: number;
  readonly parallaxScale: number;
  readonly parallaxPasses: number;
  /** DecalFlag bits. */
  readonly flags: number;
  /** Multiplies the texture colour (0..1). */
  readonly color: readonly [number, number, number];
}

export interface TextureSet {
  readonly editorId: string;
  /** Normalized `textures\...` paths of TX00..TX07 ('' = none): diffuse, normal, ... */
  readonly textures: readonly string[];
  /** TextureSetFlag bits. */
  readonly flags: number;
  readonly decal: DecalData | undefined;
}

const textureField = (path: string | undefined): string => {
  if (!path || path.trim() === '') return '';
  const normalized = path.replaceAll('/', '\\').replace(/^\\+/, '').toLowerCase();
  return normalized.startsWith('textures\\') ? normalized : `textures\\${normalized}`;
};

export function parseTextureSet(record: TextureSetSource): TextureSet {
  const textures = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    textureField(record.fields.zstring(`TX0${String(i)}`)),
  );
  const dnam = record.fields.first('DNAM');
  const dodt = record.fields.first('DODT');
  let decal: DecalData | undefined;
  if (dodt && dodt.length >= 36) {
    const view = new DataView(dodt.buffer, dodt.byteOffset, dodt.byteLength);
    const f = (index: number): number => view.getFloat32(index * 4, true);
    decal = {
      minWidth: f(0),
      maxWidth: f(1),
      minHeight: f(2),
      maxHeight: f(3),
      depth: f(4),
      shininess: f(5),
      parallaxScale: f(6),
      parallaxPasses: dodt[28] ?? 0,
      flags: dodt[29] ?? 0,
      color: [(dodt[32] ?? 255) / 255, (dodt[33] ?? 255) / 255, (dodt[34] ?? 255) / 255],
    };
  }
  return {
    editorId: record.editorId ?? '',
    textures,
    flags: dnam && dnam.length >= 2 ? (dnam[0] ?? 0) | ((dnam[1] ?? 0) << 8) : 0,
    decal,
  };
}

/** A small integer hash of a form id: the same "random" choice every time it loads. */
function hash(formId: number, salt: number): number {
  let h = Math.imul(formId ^ (salt * 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface PlacedDecal {
  /**
   * The projection box as a matrix of the unit cube (−0.5..0.5): X across the texture's width,
   * Y along the projection (the reference's Y axis), Z up the texture's height.
   */
  readonly box: Mat4;
  /** Atlas quarter (u, v, width, height) of the variant this placement shows. */
  readonly rect: readonly [number, number, number, number];
}

/**
 * The box and texture variant of a decal reference: its size lies between the decal's min and
 * max (chosen by the reference's form id), scaled by the reference; a texture with
 * subtextures shows one of its four quarters.
 */
export function placeDecal(decal: DecalData, formId: number, placement: Mat4): PlacedDecal {
  const t = hash(formId, 1);
  const width = decal.minWidth + (decal.maxWidth - decal.minWidth) * t;
  const height = decal.minHeight + (decal.maxHeight - decal.minHeight) * t;
  const size = identity();
  size[0] = Math.max(1, width);
  // The engine builds the decal on whole triangles touching its box, so it runs over steps
  // and uneven ground: the projection reaches at least half the decal's size.
  size[5] = Math.max(1, decal.depth, 0.5 * Math.max(width, height));
  size[10] = Math.max(1, height);
  const quarter = Math.floor(hash(formId, 2) * 4);
  const rect: readonly [number, number, number, number] =
    (decal.flags & DecalFlag.noSubtextures) !== 0
      ? [0, 0, 1, 1]
      : [(quarter % 2) * 0.5, Math.floor(quarter / 2) * 0.5, 0.5, 0.5];
  return { box: multiply(placement, size), rect };
}

/**
 * The spacing the original's impacts give a plain decal (observed in the original: every
 * caller that makes a dynamic decal sets 16).
 */
export const DECAL_SPACING = 16;

/** A plain decal on a node: where it was made (world) and its width. */
export interface DecalSpot {
  readonly point: readonly [number, number, number];
  readonly width: number;
}

/**
 * Whether a new plain decal is too near one already on the same node (observed in the
 * original): it is skipped where an existing one was made within (the larger of its width and
 * height + that one's width) / √spacing of where it would go, the existing ones' points as they
 * were made.
 */
export function decalTooNear(
  point: readonly [number, number, number],
  size: { readonly width: number; readonly height: number },
  existing: Iterable<DecalSpot>,
  spacing = DECAL_SPACING,
): boolean {
  if (!(spacing > 0)) return false;
  const reach = Math.max(size.width, size.height);
  for (const spot of existing) {
    const dx = point[0] - spot.point[0];
    const dy = point[1] - spot.point[1];
    const dz = point[2] - spot.point[2];
    const r = reach + spot.width;
    if (dx * dx + dy * dy + dz * dz <= (r * r) / spacing) return true;
  }
  return false;
}

/** A placed decal's width and height (its box's X and Z lengths). */
export function placedSize(placed: PlacedDecal): { width: number; height: number } {
  const b = placed.box;
  return {
    width: Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0),
    height: Math.hypot(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0),
  };
}

/**
 * Dynamic decals (a hit's blood) as the engine keeps them (observed in the original): each lasts [Display]
 * fDecalLifetime seconds (`until`: when it goes), at most [Decals] uMaxDecals at once. Removes
 * from `decals` (oldest first) those past their time at `now`, then the oldest beyond `max`;
 * returns those that went.
 */
export function expireDecals<T extends { readonly until: number }>(
  decals: T[],
  now: number,
  max: number,
): T[] {
  const gone: T[] = [];
  for (let index = decals.length - 1; index >= 0; index--) {
    const decal = decals[index];
    if (decal && decal.until <= now) gone.push(...decals.splice(index, 1));
  }
  while (decals.length > Math.max(0, max)) {
    const oldest = decals.shift();
    if (oldest) gone.push(oldest);
  }
  return gone;
}
