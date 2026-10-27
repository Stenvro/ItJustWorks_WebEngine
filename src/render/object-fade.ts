// Distance fade of placed references (the engine's BSFadeNode): each reference fades out by its
// kind's multiplier, the settings Actor, Item and Object Fade (INI [LOD] fLODFadeOutMultActors,
// fLODFadeOutMultItems, fLODFadeOutMultObjects), times its bound's radius. It dithers away over
// the last part of that distance instead of popping. References that have distant LOD (the
// base's "Has Distant LOD" flag) or are placed as full LOD ("Is Full LOD") never fade: the LOD
// takes over at the grid's edge. Platform-independent.
//
// TODO(M13): the exact distance rule (the executable's scale on radius × multiplier, a floor for
// tiny items, fLODFadeOutMultSkyCell in interiors that show the sky, the time-based fade-in of
// references that come into range) is not read from the engine yet; this is a reasonable version.

/** Which of the settings a reference fades by. */
export type FadeKind = 'actor' | 'item' | 'object';

/** The fade multipliers (INI [LOD]). */
export interface FadeSettings {
  readonly actors: number;
  readonly items: number;
  readonly objects: number;
}

/** World units of fade distance per unit of bound radius and of multiplier. */
export const FADE_RADIUS_SCALE = 16;
/** Bound radii below this fade as if they had it (a coin still shows across a room). */
export const FADE_MIN_RADIUS = 16;
/** The fade runs over the last tenth of the distance (Gamebryo's fLODFadeOutPercent, 0.9). */
export const FADE_START_PERCENT = 0.9;

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
): { readonly start: number; readonly end: number } {
  const multiplier =
    kind === 'actor' ? settings.actors : kind === 'item' ? settings.items : settings.objects;
  const end = Math.max(radius, FADE_MIN_RADIUS) * Math.max(0, multiplier) * FADE_RADIUS_SCALE;
  return { start: end * FADE_START_PERCENT, end };
}

/** How far a reference has faded at a distance from the camera: 0 shown, 1 gone. */
export function fadeOut(distance: number, start: number, end: number): number {
  if (distance <= start) return 0;
  if (distance >= end) return 1;
  return (distance - start) / (end - start);
}
