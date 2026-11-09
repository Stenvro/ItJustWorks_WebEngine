// The loaded grid outside (UESP "Skyrim:INI Settings", [General] uGridsToLoad): the exterior
// cells round the player's cell that are loaded and attached, uGridsToLoad on a side (5 built
// in: the player's cell and two on every side). The grid is centred on the player's cell, never
// on a camera of its own. Platform-independent.

/** [General] uGridsToLoad's built-in value. */
export const GRIDS_TO_LOAD = 5;

/**
 * The cells loaded on each side of the player's: half of uGridsToLoad, rounded down, at least
 * one (the grid is centred on the player's cell, so an even count loads as the odd one above
 * it). TODO(M13): what the original makes of an even count is inferred.
 */
export function loadedGridRadius(grids: number | undefined): number {
  const count = grids !== undefined && Number.isFinite(grids) ? grids : GRIDS_TO_LOAD;
  return Math.max(1, Math.floor(count / 2));
}
