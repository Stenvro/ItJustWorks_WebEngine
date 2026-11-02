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

/**
 * How an actor hit's blood finds the world behind it (observed in the original, the
 * environment blood): at fCombatEnvironmentBloodChance (0.75 built in) a ray from the hit along
 * the blow, its direction lowered by half before it is made a unit, 512 units long; the first
 * surface it meets that is not an actor or a projectile takes one, spaced by its impact's
 * Placement Radius (IPCT DATA) in place of the impacts' 16 (none when it is 0). Its decal is
 * square (one size drawn for its width and its height: squareDecal) and 48 deep either side of
 * the surface whatever its DODT depth.
 */
export const ENVIRONMENT_BLOOD = { chance: 0.75, drop: 0.5, reach: 512, depth: 48 } as const;

/** A decal whose height is drawn as its width (the environment blood's: one size for both). */
export function squareDecal(decal: DecalData): DecalData {
  return { ...decal, minHeight: decal.minWidth, maxHeight: decal.maxWidth };
}

/** The way an actor hit's environment blood looks for the world (a unit vector). */
export function environmentBloodWay(
  direction: readonly [number, number, number],
): [number, number, number] {
  const way: [number, number, number] = [
    direction[0],
    direction[1],
    direction[2] - ENVIRONMENT_BLOOD.drop,
  ];
  const length = Math.hypot(way[0], way[1], way[2]);
  return length > 1e-9 ? [way[0] / length, way[1] / length, way[2] / length] : way;
}

/**
 * The node a dynamic decal on the world is made on (observed in the original): the node that
 * holds the collision the hit struck, the decal going onto the shapes under it and spaced
 * against those already beside them; for the landscape, the land of the cell at the point.
 * A key that two decals share when they are on the same node.
 */
export function struckNodeKey(
  owner: { readonly reference: number; readonly kind: string } | undefined,
  node: string | undefined,
  point: readonly [number, number, number],
): string {
  if (!owner) return 'none';
  if (owner.kind === 'landscape') {
    return `land:${Math.floor(point[0] / 4096)},${Math.floor(point[1] / 4096)}`;
  }
  return `${owner.reference}:${(node ?? '').toLowerCase()}`;
}

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
 * How long a dynamic decal fades out once its lifetime is over (observed in the original: the
 * plain and the skinned decals alike show whole for [Display] fDecalLifetime seconds, then their
 * shapes' alpha runs down from 1 to 0 over one more second, and they go).
 */
export const DECAL_FADE_SECONDS = 1;

/** When a dynamic decal made at `made` goes: its lifetime, then its fade. */
export function decalGoneAt(made: number, lifetime: number): number {
  return made + Math.max(0, lifetime) + DECAL_FADE_SECONDS;
}

/** A dynamic decal's alpha at `now` (1 through its lifetime, then down to 0 as it fades). */
export function decalAlpha(goneAt: number, now: number): number {
  return Math.min(1, Math.max(0, (goneAt - now) / DECAL_FADE_SECONDS));
}

/**
 * Dynamic decals (a hit's blood) as the engine keeps them (observed in the original): each lasts [Display]
 * fDecalLifetime seconds and its fade (`until`: when it goes), at most [Decals] uMaxDecals at once. Removes
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

/** The atlas quarter a decal's subtexture index shows (0..3; another: the whole texture). */
export function subtextureRect(
  index: number,
  flags: number,
): readonly [number, number, number, number] {
  if ((flags & DecalFlag.noSubtextures) !== 0 || index < 0 || index > 3) return [0, 0, 1, 1];
  return [(index % 2) * 0.5, Math.floor(index / 2) * 0.5, 0.5, 0.5];
}

/**
 * A world decal's clipping box (as worldDecalBox makes it: X its width, Y the projection, made
 * `depth` deep either side, Z its height) from what the original's temp effects keep of it
 * (docs/formats/ess.md, "Temp effects"): its point, its rotation (a quaternion w, x, y, z) and
 * its width, height and depth, all in the space of what it lies on. Observed in the saves: the
 * rotation takes Z to the direction saved beside it, the way out of the surface (up on a
 * floor), so the projection runs along −Z, X across the width and Y up the height.
 */
export function savedDecalBox(
  point: readonly [number, number, number],
  rotation: readonly number[],
  size: readonly number[],
): Mat4 {
  const [w = 1, x = 0, y = 0, z = 0] = rotation;
  const length = Math.hypot(w, x, y, z) || 1;
  const [qw, qx, qy, qz] = [w / length, x / length, y / length, z / length];
  // The rotation's columns: where it takes X, Y and Z.
  const ax = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)];
  const ay = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];
  const az = [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)];
  const width = size[0] ?? 1;
  const height = size[1] ?? width;
  const depth = 2 * Math.max(0, size[2] ?? 0);
  const box = identity();
  for (let k = 0; k < 3; k++) {
    box[k] = (ax[k] ?? 0) * width;
    box[4 + k] = -(az[k] ?? 0) * depth;
    box[8 + k] = (ay[k] ?? 0) * height;
    box[12 + k] = point[k] ?? 0;
  }
  return box;
}

/**
 * Where the space of a cell's land lies (world), in which the original's temp effects keep a
 * decal on the land: observed in the saves, centred on the cell and at the middle of its
 * heights' range (every land decal of the saves read then lies on its land, within the grid's
 * sampling).
 */
export function landSpaceOrigin(
  heights: Iterable<number>,
  gridX: number,
  gridY: number,
  cellSize = 4096,
): [number, number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const height of heights) {
    if (height < low) low = height;
    if (height > high) high = height;
  }
  const middle = Number.isFinite(low) ? (low + high) / 2 : 0;
  return [(gridX + 0.5) * cellSize, (gridY + 0.5) * cellSize, middle];
}
