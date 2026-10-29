// Distance fade of placed references (the engine's BSFadeNode), by the original's rule. Each
// reference has a fade distance from its bound radius: ten radii (INI [LOD] fLODBoundRadiusMult),
// but never past the loaded grid's edge less the radius and half a cell (uGridsToLoad cells of
// 4096 units round the camera's). It fades out from fLODFadeOutPercent (0.6) of that distance to
// all of it, with at least 500 units before it starts (iFadeNodeMinNearDistance) and 1000 before
// it is gone. Those distances are compared with the camera's distance divided by the reference's
// kind's multiplier, the settings Actor, Item and Object Fade (fLODFadeOutMultActors, ...Items,
// ...Objects), so the multiplier stretches them. It dithers away over that range instead of
// popping. References that have distant LOD (the base's "Has Distant LOD" flag) or are placed as
// full LOD ("Is Full LOD") never fade: the LOD takes over at the grid's edge. Platform-independent.
//
// TODO(M13): the engine also scales the camera's distance by a per-camera factor (one at the
// default view, as far as read) and gives sky-cell references fLODFadeOutMultSkyCell with
// fSkyCellRefFadeDistance (150000); the time-based fade-in of references that come into range
// (fFadeInTime) is not built.

/** Which of the settings a reference fades by. */
export type FadeKind = 'actor' | 'item' | 'object';

/** The fade multipliers (INI [LOD]). */
export interface FadeSettings {
  readonly actors: number;
  readonly items: number;
  readonly objects: number;
}

/** INI [LOD] fLODBoundRadiusMult's default: the fade distance in bound radii. */
export const LOD_BOUND_RADIUS_MULT = 10;
/** INI [LOD] fLODFadeOutPercent's default: where in its distance a reference starts to fade. */
export const FADE_START_PERCENT = 0.6;
/** INI [LOD] iFadeNodeMinNearDistance's default: the nearest a fade may start (twice: end). */
export const FADE_MIN_NEAR_DISTANCE = 500;
/** INI [General] uGridsToLoad's default. */
export const GRIDS_TO_LOAD = 5;
/** Units per exterior cell. */
const CELL_SIZE = 4096;

/** Base record types the player can pick up: they fade by the Item multiplier. */
const ITEM_TYPES: ReadonlySet<string> = new Set([
  'ALCH',
  'AMMO',
  'APPA',
  'ARMO',
  'BOOK',
  'INGR',
  'KEYM',
  'MISC',
  'SCRL',
  'SLGM',
  'WEAP',
]);

/** Base record types whose record flag 0x8000 is "Has Distant LOD" (xEdit). */
const DISTANT_LOD_TYPES: ReadonlySet<string> = new Set([
  'ACTI',
  'CONT',
  'DOOR',
  'FLOR',
  'FURN',
  'MSTT',
  'STAT',
  'TREE',
]);

/** Base record flag: the object has distant LOD ("Visible When Distant"). */
export const HAS_DISTANT_LOD = 0x8000;
/** REFR record flag: the reference is drawn in full at any distance ("Is Full LOD"). */
export const IS_FULL_LOD = 0x10000;

/** The fade kind of a placed reference's base (a carryable light is an item). */
export function fadeKind(baseType: string, carryable = false): FadeKind {
  if (baseType === 'NPC_' || baseType === 'CREA') return 'actor';
  if (ITEM_TYPES.has(baseType) || (baseType === 'LIGH' && carryable)) return 'item';
  return 'object';
}

/** Whether a reference never fades (its base has distant LOD, or it is placed as full LOD). */
export function neverFades(baseType: string, baseFlags: number, referenceFlags: number): boolean {
  if ((referenceFlags & IS_FULL_LOD) !== 0) return true;
  return DISTANT_LOD_TYPES.has(baseType) && (baseFlags & HAS_DISTANT_LOD) !== 0;
}

/** Where a reference of a kind and bound radius starts to fade, and where it is gone. */
export function fadeRange(
  kind: FadeKind,
  radius: number,
  settings: FadeSettings,
  gridsToLoad = GRIDS_TO_LOAD,
): { readonly start: number; readonly end: number } {
  const multiplier =
    kind === 'actor' ? settings.actors : kind === 'item' ? settings.items : settings.objects;
  // A multiplier of 0 or less: the kind never fades.
  if (!(multiplier > 0)) return { start: Infinity, end: Infinity };
  let distance = gridsToLoad * CELL_SIZE * 0.5 - (radius + CELL_SIZE / 2);
  if (Math.abs(radius) > 0.0001 && LOD_BOUND_RADIUS_MULT * radius < distance) {
    distance = LOD_BOUND_RADIUS_MULT * radius;
  }
  let start = FADE_START_PERCENT * distance;
  let end = distance;
  if (start < FADE_MIN_NEAR_DISTANCE) {
    start = FADE_MIN_NEAR_DISTANCE;
    end = Math.max(2 * FADE_MIN_NEAR_DISTANCE, end);
  }
  return { start: start * multiplier, end: end * multiplier };
}

/** How far a reference has faded at a distance from the camera: 0 shown, 1 gone. */
export function fadeOut(distance: number, start: number, end: number): number {
  if (distance <= start) return 0;
  if (distance >= end) return 1;
  return (distance - start) / (end - start);
}
