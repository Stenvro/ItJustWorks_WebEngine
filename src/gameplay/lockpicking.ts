// Picking a lock, as UESP ("Skyrim:Lockpicking") derives it and the game settings hold it: a
// lock's level (REFR XLOC: Novice 1, Apprentice 25, Adept 50, Expert 75, Master 100, 255 a key
// only) is a difficulty 1..5; the pick sweeps a half circle (0..180°) and the lock turns as far
// as the pick lies near its sweet spot: all the way (90°, open) in the sweet spot, part of the way
// in the partial zones beside it, not at all beyond them. While the lock is held against a pick
// that cannot turn it further the pick takes strain, and breaks after the level's time.
//
//   sweet spot (°)   = 60 × 2^−difficulty × (0.82 + fLockpickSkillSweetSpotMult × skill) × perk
//   perk             = 1.75 + 0.25 × difficulty with the level's perk (Novice Locks, ...), else 1
//   partial zone (°) = fPartialPick<level> × (fLockpickSkillPartialPickBase
//                      + fLockpickSkillPartialPickMult × skill), on each side
//   break time (s)   = (2, 1, 0.75, 0.5, 0.25 by difficulty) × (1 + 0.5 × skill / 100)
//
// Opening a lock is fSkillUsageLockPick<level> uses of Lockpicking, a broken pick
// fSkillUsageLockPickBroken. Platform-independent.

/** The Lockpick (MISC) and the Skeleton Key (TG08SkeletonKey), which never breaks. */
export const LOCKPICK = 0xa;
export const SKELETON_KEY = 0x3a070;

/** XLOC lock levels the Creation Kit names, by difficulty. */
export const LOCK_LEVELS = [1, 25, 50, 75, 100] as const;
/** XLOC level of a lock only its key opens. */
export const KEY_ONLY_LEVEL = 255;
/** The lock is open once it has turned this far (degrees). */
export const LOCK_OPEN_ANGLE = 90;
/** The pick's sweep (degrees). */
export const PICK_RANGE = 180;

/** Per difficulty (1..5): the game settings' names. */
const LEVEL_NAMES = ['VeryEasy', 'Easy', 'Average', 'Hard', 'VeryHard'] as const;
/** Seconds a pick lasts under strain at skill 0 (UESP). */
const BREAK_SECONDS = [2, 1, 0.75, 0.5, 0.25] as const;
/** The sweet spot's base and the skill's share of it (UESP; the share is a game setting). */
const SWEET_SPOT_DEGREES = 60;
const SWEET_SPOT_BASE = 0.82;

/** A lock's difficulty 1 (Novice) .. 5 (Master), or undefined when only its key opens it. */
export function lockDifficulty(level: number): number | undefined {
  if (level >= KEY_ONLY_LEVEL) return undefined;
  const index = LOCK_LEVELS.findIndex((max) => level <= max);
  return index < 0 ? LOCK_LEVELS.length : index + 1;
}

/** The game setting that names a difficulty: sLockLevelName<VeryEasy..VeryHard>. */
export function lockLevelSetting(difficulty: number | undefined): string {
  if (difficulty === undefined) return 'sLockLevelNameImpossible';
  return `sLockLevelName${LEVEL_NAMES[clampDifficulty(difficulty) - 1] ?? 'VeryEasy'}`;
}

/** The settings the sizes come from (GMSTs). */
export interface LockpickSettings {
  /** fLockpickSkillSweetSpotMult (0.006). */
  readonly sweetSpotMult: number;
  /** fLockpickSkillPartialPickBase (0.775), fLockpickSkillPartialPickMult (0.015). */
  readonly partialBase: number;
  readonly partialMult: number;
  /** fPartialPickVeryEasy .. fPartialPickVeryHard (22, 18, 14, 10, 6). */
  readonly partial: readonly number[];
}

export const LOCKPICK_DEFAULTS: LockpickSettings = {
  sweetSpotMult: 0.006,
  partialBase: 0.775,
  partialMult: 0.015,
  partial: [22, 18, 14, 10, 6],
};

/** The partial pick settings' names, by difficulty. */
export function partialPickSetting(difficulty: number): string {
  return `fPartialPick${LEVEL_NAMES[clampDifficulty(difficulty) - 1] ?? 'VeryEasy'}`;
}

/**
 * The Lockpicking skill uses of opening a lock (fSkillUsageLockPickVeryEasy .. VeryHard: 2, 3,
 * 5, 8, 13) and of a pick breaking (fSkillUsageLockPickBroken: 0.25); UESP "Lockpicking".
 */
export const LOCKPICK_SKILL_USES = [2, 3, 5, 8, 13] as const;
export const BROKEN_PICK_SKILL_USE = 0.25;

/** The skill use setting of opening a lock of a difficulty: fSkillUsageLockPick<level>. */
export function lockpickSkillUseSetting(difficulty: number): string {
  return `fSkillUsageLockPick${LEVEL_NAMES[clampDifficulty(difficulty) - 1] ?? 'VeryEasy'}`;
}

/** The lock being picked: where its sweet spot is and how wide it and the zones beside it are. */
export interface LockShape {
  /** The sweet spot's middle (degrees of the pick's sweep). */
  readonly center: number;
  /** The sweet spot's whole width and each partial zone's (degrees). */
  readonly sweetSpot: number;
  readonly partial: number;
  /** Seconds a pick lasts held under strain. */
  readonly breakSeconds: number;
}

/**
 * A lock's shape for a picker of a skill (0..100+), with the level's perk or not; its sweet
 * spot's place `random` (0..1) in the sweep, whole inside it.
 */
export function lockShape(
  difficulty: number,
  skill: number,
  options: {
    readonly perk?: boolean;
    readonly random: number;
    readonly settings?: LockpickSettings;
  },
): LockShape {
  const d = clampDifficulty(difficulty);
  const settings = options.settings ?? LOCKPICK_DEFAULTS;
  const perk = options.perk === true ? 1.75 + 0.25 * d : 1;
  const sweetSpot = Math.min(
    PICK_RANGE,
    SWEET_SPOT_DEGREES * 2 ** -d * (SWEET_SPOT_BASE + settings.sweetSpotMult * skill) * perk,
  );
  const partial =
    (settings.partial[d - 1] ?? 0) * (settings.partialBase + settings.partialMult * skill);
  const half = sweetSpot / 2;
  const center = half + Math.max(0, Math.min(1, options.random)) * (PICK_RANGE - sweetSpot);
  return {
    center,
    sweetSpot,
    partial,
    breakSeconds: (BREAK_SECONDS[d - 1] ?? 0.25) * (1 + (0.5 * skill) / 100),
  };
}

/**
 * How far the lock turns with the pick at an angle (degrees): all the way in the sweet spot,
 * less the farther into a partial zone, none beyond.
 */
export function lockTurnLimit(shape: LockShape, pickAngle: number): number {
  const off = Math.abs(pickAngle - shape.center) - shape.sweetSpot / 2;
  if (off <= 0) return LOCK_OPEN_ANGLE;
  if (shape.partial <= 0 || off >= shape.partial) return 0;
  return LOCK_OPEN_ANGLE * (1 - off / shape.partial);
}

function clampDifficulty(difficulty: number): number {
  return Math.max(1, Math.min(LEVEL_NAMES.length, Math.round(difficulty)));
}
