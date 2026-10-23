// Picking a lock, as UESP ("Skyrim:Lockpicking") derives it and the game settings hold it: a
// lock's level (REFR XLOC: Novice 1, Apprentice 25, Adept 50, Expert 75, Master 100, 255 a key
// only) is a difficulty 1..5; the pick sweeps a half circle (0..180°) and the lock turns as far
// as the pick lies near its sweet spot: all the way (90°, open) in the sweet spot, part of the way
// in the partial zones beside it, not at all beyond them. While the lock is held against a pick
// that cannot turn it further the pick takes strain, and breaks after the level's time.
//
//   sweet spot (°)   = fSweetSpot<level> × (fLockpickSkillSweetSpotBase
//                      + fLockpickSkillSweetSpotMult × skill) × perk
//                      + fLockpickBrokenPicksMult × the picks broken on the lock
//   perk             = 1.75 + 0.25 × difficulty with the level's perk (Novice Locks, ...), else 1
//   partial zone (°) = fPartialPick<level> × (fLockpickSkillPartialPickBase
//                      + fLockpickSkillPartialPickMult × skill), on each side
//   break time (s)   = fLockpickBreak<Novice..Master> × (fLockpickBreakSkillBase
//                      + fLockpickBreakSkillMult × skill)
//
// The sweet spot's and the break time's rules were observed in the original (UESP's
// figures are these settings'); fSweetSpot<level> in the load order: 30, 15, 7.5, 3.75, 1.875.
// TODO(M13): the break time's further factor in the engine (1 for all we know) is not known.
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
/** Per difficulty (1..5): the break settings' names (fLockpickBreak<name>). */
const BREAK_NAMES = ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'] as const;

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

/** The settings the sizes and times come from (GMSTs; the load order's, else the engine's). */
export interface LockpickSettings {
  /** fSweetSpotVeryEasy .. fSweetSpotVeryHard (30, 15, 7.5, 3.75, 1.875). */
  readonly sweetSpot: readonly number[];
  /** fLockpickSkillSweetSpotBase (0.82), fLockpickSkillSweetSpotMult (0.006). */
  readonly sweetSpotBase: number;
  readonly sweetSpotMult: number;
  /** fLockpickBrokenPicksMult (0): degrees a broken pick adds to the lock's sweet spot. */
  readonly brokenPicksMult: number;
  /** fLockpickSkillPartialPickBase (0.775), fLockpickSkillPartialPickMult (0.015). */
  readonly partialBase: number;
  readonly partialMult: number;
  /** fPartialPickVeryEasy .. fPartialPickVeryHard (22, 18, 14, 10, 6). */
  readonly partial: readonly number[];
  /** fLockpickBreakNovice .. fLockpickBreakMaster (2, 1, 0.75, 0.5, 0.25). */
  readonly breakSeconds: readonly number[];
  /** fLockpickBreakSkillBase (1), fLockpickBreakSkillMult (0.005). */
  readonly breakSkillBase: number;
  readonly breakSkillMult: number;
}

export const LOCKPICK_DEFAULTS: LockpickSettings = {
  sweetSpot: [30, 15, 7.5, 3.75, 1.875],
  sweetSpotBase: 0.82,
  sweetSpotMult: 0.006,
  brokenPicksMult: 0,
  partialBase: 0.775,
  partialMult: 0.015,
  partial: [22, 18, 14, 10, 6],
  breakSeconds: [2, 1, 0.75, 0.5, 0.25],
  breakSkillBase: 1,
  breakSkillMult: 0.005,
};

/**
 * The lockpicking settings by name (`number`: a game setting, the load order's if it has it),
 * the engine's defaults where neither has one.
 */
export function lockpickSettings(number: (name: string) => number | undefined): LockpickSettings {
  const setting = (name: string, fallback: number): number => number(name) ?? fallback;
  const d = LOCKPICK_DEFAULTS;
  const levels = [1, 2, 3, 4, 5];
  return {
    sweetSpot: levels.map((level) => setting(sweetSpotSetting(level), d.sweetSpot[level - 1] ?? 0)),
    sweetSpotBase: setting('fLockpickSkillSweetSpotBase', 0.82),
    sweetSpotMult: setting('fLockpickSkillSweetSpotMult', 0.006),
    brokenPicksMult: setting('fLockpickBrokenPicksMult', 0),
    partialBase: setting('fLockpickSkillPartialPickBase', 0.775),
    partialMult: setting('fLockpickSkillPartialPickMult', 0.015),
    partial: levels.map((level) => setting(partialPickSetting(level), d.partial[level - 1] ?? 0)),
    breakSeconds: levels.map((level) =>
      setting(lockpickBreakSetting(level), d.breakSeconds[level - 1] ?? 0),
    ),
    breakSkillBase: setting('fLockpickBreakSkillBase', 1),
    breakSkillMult: setting('fLockpickBreakSkillMult', 0.005),
  };
}

/** The partial pick settings' names, by difficulty. */
export function partialPickSetting(difficulty: number): string {
  return `fPartialPick${LEVEL_NAMES[clampDifficulty(difficulty) - 1] ?? 'VeryEasy'}`;
}

/** The sweet spot settings' names, by difficulty: fSweetSpot<VeryEasy..VeryHard>. */
export function sweetSpotSetting(difficulty: number): string {
  return `fSweetSpot${LEVEL_NAMES[clampDifficulty(difficulty) - 1] ?? 'VeryEasy'}`;
}

/** The break time settings' names, by difficulty: fLockpickBreak<Novice..Master>. */
export function lockpickBreakSetting(difficulty: number): string {
  return `fLockpickBreak${BREAK_NAMES[clampDifficulty(difficulty) - 1] ?? 'Novice'}`;
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
    /**
     * The level's perk is known (its factor below), or the factor the perks give (the perk entry
     * point Mod Lockpick Sweet Spot: Novice Locks .. Master Locks multiply it so).
     */
    readonly perk?: boolean | number;
    readonly random: number;
    readonly settings?: LockpickSettings;
    /** Picks the player has broken on this lock. */
    readonly brokenPicks?: number;
  },
): LockShape {
  const d = clampDifficulty(difficulty);
  const settings = options.settings ?? LOCKPICK_DEFAULTS;
  const perk =
    typeof options.perk === 'number' ? options.perk : options.perk === true ? 1.75 + 0.25 * d : 1;
  const sweetSpot = Math.min(
    PICK_RANGE,
    (settings.sweetSpot[d - 1] ?? 0) *
      (settings.sweetSpotBase + settings.sweetSpotMult * skill) *
      perk +
      settings.brokenPicksMult * (options.brokenPicks ?? 0),
  );
  const partial =
    (settings.partial[d - 1] ?? 0) * (settings.partialBase + settings.partialMult * skill);
  const half = sweetSpot / 2;
  const center = half + Math.max(0, Math.min(1, options.random)) * (PICK_RANGE - sweetSpot);
  return {
    center,
    sweetSpot,
    partial,
    breakSeconds:
      (settings.breakSeconds[d - 1] ?? 0) *
      (settings.breakSkillBase + settings.breakSkillMult * skill),
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
