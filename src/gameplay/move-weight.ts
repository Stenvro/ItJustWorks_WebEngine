// What an actor wears slows its run, observed in the original (docs/gameplay.md, "What slows a
// run"): the weight of what it has equipped, held to fMoveWeightMax, is a share of the range
// fMoveWeightMin to fMoveWeightMax; its run speeds lose that share × fMoveEncumEffect with a
// weapon drawn, × fMoveEncumEffectNoWeapon without, and never fall below its walk. All its speeds
// then go by its Speed Mult (a percentage; 0 counts as 100, a negative as its size).
// Platform-independent.

/** The settings the rule reads (GMST), with the engine's built-in values. */
export interface MoveWeightSettings {
  readonly weightMin: number;
  readonly weightMax: number;
  readonly encumEffect: number;
  readonly encumEffectNoWeapon: number;
}

export const MOVE_WEIGHT_DEFAULTS: MoveWeightSettings = {
  weightMin: 0,
  weightMax: 150,
  encumEffect: 0.4,
  encumEffectNoWeapon: 0.3,
};

/** The factor on an actor's run speeds for what it has equipped. */
export function runWeightFactor(
  weight: number,
  weaponDrawn: boolean,
  settings: MoveWeightSettings = MOVE_WEIGHT_DEFAULTS,
): number {
  const held = Math.min(weight, settings.weightMax);
  const share = (held + settings.weightMin) / (settings.weightMax - settings.weightMin);
  return 1 - share * (weaponDrawn ? settings.encumEffect : settings.encumEffectNoWeapon);
}

/** A run speed as what it has equipped makes it: never below its walk. */
export function burdenedRun(run: number, walk: number, factor: number): number {
  return factor >= 0 ? Math.max(walk, run * factor) : run;
}

/** The factor on all an actor's speeds for its Speed Mult (the actor value, a percentage). */
export function speedMultFactor(speedMult: number): number {
  const share = Math.abs(speedMult) * 0.01;
  return share === 0 ? 1 : share;
}
