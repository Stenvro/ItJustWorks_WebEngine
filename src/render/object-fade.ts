// Distance fade of placed references (the engine's BSFadeNode), by the original's rule. Each
// reference has a fade distance from its bound radius: ten radii (INI [LOD] fLODBoundRadiusMult),
// but never past the loaded grid's edge less the radius and half a cell (uGridsToLoad cells of
// 4096 units round the camera's). It fades out from fLODFadeOutPercent (0.6) of that distance to
// all of it, with at least 500 units before it starts (iFadeNodeMinNearDistance) and 1000 before
// it is gone. Those distances are compared with the camera's distance divided by the reference's
// kind's multiplier, the settings Actor, Item and Object Fade (fLODFadeOutMultActors, ...Items,
// ...Objects), so the multiplier stretches them. Over that range its fade value goes from 1 to 0;
// the reference then fades out over time once the value drops below fFadeOutThreshold and in
// again once it rises past fFadeInThreshold (stepFade), dithered away while it fades. References
// that have distant LOD (the base's "Has Distant LOD" flag) never fade: the LOD takes over at the
// grid's edge. References placed as full LOD ("Is Full LOD") are the sky cell's kind (observed in
// the original: the 11th fade type): their distance is fSkyCellRefFadeDistance (150000) whatever
// their size, by fLODFadeOutMultSkyCell (1). Platform-independent.
//
// TODO(M13): the engine also scales the camera's distance by a per-camera factor (one at the
// default view, as far as read); a multiplier of 0 or less leaves the shaders' fade value
// at a fifth of the distance (shader-fades.ts); scripted fades toward a target
// alpha (the camera's fade of what stands in front of it) are not built.

/** Which of the settings a reference fades by (the sky cell's: full LOD references). */
export type FadeKind = 'actor' | 'item' | 'object' | 'skyCell';

/** The fade multipliers (INI [LOD]). */
export interface FadeSettings {
  readonly actors: number;
  readonly items: number;
  readonly objects: number;
  /** fLODFadeOutMultSkyCell (1 by default). */
  readonly skyCell?: number;
}

/** GMST fSkyCellRefFadeDistance's default: a full LOD reference's fade distance. */
export const SKY_CELL_FADE_DISTANCE = 150000;

/** A kind's multiplier among the settings. */
export function fadeMultiplier(kind: FadeKind, settings: FadeSettings): number {
  return kind === 'actor'
    ? settings.actors
    : kind === 'item'
      ? settings.items
      : kind === 'skyCell'
        ? (settings.skyCell ?? 1)
        : settings.objects;
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

/**
 * The fade kind of a placed reference's base (a carryable light is an item); a reference placed
 * as full LOD (`referenceFlags`) fades as the sky cell's.
 */
export function fadeKind(baseType: string, carryable = false, referenceFlags = 0): FadeKind {
  if ((referenceFlags & IS_FULL_LOD) !== 0) return 'skyCell';
  if (baseType === 'NPC_' || baseType === 'CREA') return 'actor';
  if (ITEM_TYPES.has(baseType) || (baseType === 'LIGH' && carryable)) return 'item';
  return 'object';
}

/** Whether a reference never fades: its base has distant LOD (a full LOD one fades far). */
export function neverFades(baseType: string, baseFlags: number, referenceFlags: number): boolean {
  if ((referenceFlags & IS_FULL_LOD) !== 0) return false;
  return DISTANT_LOD_TYPES.has(baseType) && (baseFlags & HAS_DISTANT_LOD) !== 0;
}

/** Where a reference of a kind and bound radius starts to fade, and where it is gone. */
export function fadeRange(
  kind: FadeKind,
  radius: number,
  settings: FadeSettings,
  gridsToLoad = GRIDS_TO_LOAD,
): { readonly start: number; readonly end: number } {
  const multiplier = fadeMultiplier(kind, settings);
  // A multiplier of 0 or less: the kind never fades.
  if (!(multiplier > 0)) return { start: Infinity, end: Infinity };
  let distance = SKY_CELL_FADE_DISTANCE;
  if (kind !== 'skyCell') {
    distance = gridsToLoad * CELL_SIZE * 0.5 - (radius + CELL_SIZE / 2);
    if (Math.abs(radius) > 0.0001 && LOD_BOUND_RADIUS_MULT * radius < distance) {
      distance = LOD_BOUND_RADIUS_MULT * radius;
    }
  }
  let start = FADE_START_PERCENT * distance;
  let end = distance;
  if (start < FADE_MIN_NEAR_DISTANCE) {
    start = FADE_MIN_NEAR_DISTANCE;
    end = Math.max(2 * FADE_MIN_NEAR_DISTANCE, end);
  }
  return { start: start * multiplier, end: end * multiplier };
}

/**
 * A reference's fade value at a distance: 1 at the start of its fade range, 0 at its end, past 1
 * nearer and below 0 farther (not clamped). Kinds that never fade stay at 1.
 */
export function fadeValue(distance: number, start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return 1 - (distance - start) / Math.max(end - start, 1e-6);
}

/** The time-based fade's settings (INI [LOD]). */
export interface FadeTiming {
  /** fFadeInThreshold: a hidden reference fades in once its fade value is above this. */
  readonly inThreshold: number;
  /** fFadeOutThreshold: a shown one fades out once its value is below this. */
  readonly outThreshold: number;
  /** fFadeInTime and fFadeOutTime: seconds for a whole fade. */
  readonly inTime: number;
  readonly outTime: number;
}

/** The original's defaults of the [LOD] fade timing. */
export const DEFAULT_FADE_TIMING: FadeTiming = {
  inThreshold: 0.7,
  outThreshold: 0.3,
  inTime: 1.2,
  outTime: 2,
};

/** The largest step a fade takes in one frame (a long frame does not jump it). */
const MAX_FADE_STEP = 0.1;

/** A reference's time-based fade: how much of it is drawn (0..1), and whether it counts as shown. */
export interface FadeState {
  alpha: number;
  shown: boolean;
}

/**
 * One update of a reference's fade, by the original's rule: a reference that is not shown
 * fades in once its fade value passes fFadeInThreshold, by `dt` / fFadeInTime a frame (at most
 * 0.1), and counts as shown once whole; a shown one fades out once its value falls below
 * fFadeOutThreshold, by `dt` / fFadeOutTime, and is hidden at 0. A fade under way goes on in
 * while the value stays above the out threshold. A reference that was not in view the frame
 * before (`seen` false) takes its end state at once instead of fading.
 */
export function stepFade(
  state: FadeState,
  value: number,
  dt: number,
  seen: boolean,
  timing: FadeTiming = DEFAULT_FADE_TIMING,
): void {
  const fadingIn =
    (!state.shown && value > timing.inThreshold) ||
    (state.alpha > 0 && state.alpha < 1 && value > timing.outThreshold);
  if (fadingIn) {
    state.alpha = seen ? Math.min(1, state.alpha + Math.min(dt / timing.inTime, MAX_FADE_STEP)) : 1;
    if (state.alpha >= 1) state.shown = true;
    return;
  }
  // Shown and staying: nothing to do.
  if (state.shown && value >= timing.outThreshold) return;
  state.alpha = seen ? Math.max(0, state.alpha - Math.min(dt / timing.outTime, MAX_FADE_STEP)) : 0;
  if (state.alpha <= 0) state.shown = false;
}
