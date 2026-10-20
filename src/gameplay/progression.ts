// The player's progression as UESP ("Skyrim:Leveling", "Skyrim:Skills") and the game settings
// give it:
//
//   skill experience of a use      = (use mult × use + use offset) × (1 + <skill>SkillAdvance / 100)
//   to the next skill level (n→n+1) = improve mult × n ^ fSkillUseCurve + improve offset
//   character experience of a skill level n reached = n × fXPPerSkillRank
//   to the next character level (L) = fXPLevelUpBase + fXPLevelUpMult × L
//
// Each skill's use mult, use offset, improve mult and improve offset are its AVIF record's AVSK
// (Lockpicking: 45, 10, 0.25, 300). A use is in the units the game's systems give: a lock opened
// fSkillUsageLockPick<level>, a pick broken fSkillUsageLockPickBroken, an item sold or bought its
// value, a spell its base cost, ... (docs/gameplay.md lists them). Skills rise by use only up to
// 100; one use can raise a skill more than one level. Training, books and Game.IncrementSkill
// give a skill the experience it lacks to its next level (UESP "Skill Books": "sufficient
// experience to raise the skill to the next level"). A skill at 100 can be made Legendary: back
// to fLegendarySkillResetValue (15), its experience gone, its perks returned as points; the
// character keeps its level and experience. A level-up waits until the player chooses health,
// magicka or stamina (+iAVDhmsLevelUp; stamina also carry weight +fLevelUpCarryWeightMod) and
// brings a perk point; experience past the threshold counts toward the next level, so levels
// can wait in a row. Platform-independent. Notes: docs/gameplay.md.

import { SKILL_CAP } from './actor-leveling.ts';

/** A skill's AVIF AVSK. */
export interface SkillCurve {
  readonly useMult: number;
  readonly useOffset: number;
  readonly improveMult: number;
  readonly improveOffset: number;
}

/** The settings the player's progression reads (GMSTs; vanilla values by default). */
export interface ProgressionSettings {
  /** fSkillUseCurve. */
  readonly skillUseCurve: number;
  /** fXPLevelUpBase, fXPLevelUpMult. */
  readonly levelUpBase: number;
  readonly levelUpMult: number;
  /** fXPPerSkillRank (engine default 1; not in the vanilla plugins). */
  readonly xpPerSkillRank: number;
  /** iAVDhmsLevelUp: health, magicka or stamina a level-up raises. */
  readonly attributeLevelUp: number;
  /** fLevelUpCarryWeightMod: carry weight a stamina level-up adds. */
  readonly carryWeightLevelUp: number;
  /** fLegendarySkillResetValue (engine default 15; sLegendaryResetConfirm says 15). */
  readonly legendaryResetValue: number;
}

export const PROGRESSION_DEFAULTS: ProgressionSettings = {
  skillUseCurve: 1.95,
  levelUpBase: 75,
  levelUpMult: 25,
  xpPerSkillRank: 1,
  attributeLevelUp: 10,
  carryWeightLevelUp: 5,
  legendaryResetValue: 15,
};

export function progressionSettings(
  number: (editorId: string) => number | undefined,
): ProgressionSettings {
  const d = PROGRESSION_DEFAULTS;
  return {
    skillUseCurve: number('fSkillUseCurve') ?? d.skillUseCurve,
    levelUpBase: number('fXPLevelUpBase') ?? d.levelUpBase,
    levelUpMult: number('fXPLevelUpMult') ?? d.levelUpMult,
    xpPerSkillRank: number('fXPPerSkillRank') ?? d.xpPerSkillRank,
    attributeLevelUp: number('iAVDhmsLevelUp') ?? d.attributeLevelUp,
    carryWeightLevelUp: number('fLevelUpCarryWeightMod') ?? d.carryWeightLevelUp,
    legendaryResetValue: number('fLegendarySkillResetValue') ?? d.legendaryResetValue,
  };
}

/**
 * The experience a use of a skill gives: its use mult times the use plus its use offset, more by
 * the skill's SkillAdvance actor value (%: the Warrior, Mage and Thief Stones, being rested).
 */
export function skillUseExperience(use: number, curve: SkillCurve, advancePercent = 0): number {
  if (use <= 0) return 0;
  return (curve.useMult * use + curve.useOffset) * (1 + advancePercent / 100);
}

/** The experience a skill at `level` needs for its next level. */
export function skillThreshold(
  level: number,
  curve: SkillCurve,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  return (
    curve.improveMult * Math.max(0, Math.floor(level)) ** settings.skillUseCurve +
    curve.improveOffset
  );
}

/** The experience the character needs at `level` for its next level. */
export function levelThreshold(
  level: number,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  return settings.levelUpBase + settings.levelUpMult * Math.max(1, Math.floor(level));
}

/** A skill's level and its experience toward the next. */
export interface SkillProgress {
  readonly level: number;
  readonly experience: number;
}

/**
 * A skill given experience: the levels it rises (none past 100), what is left over toward the
 * next, and the levels reached on the way (each counts toward the character's level).
 */
export function advanceSkill(
  from: SkillProgress,
  experience: number,
  curve: SkillCurve,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): SkillProgress & { readonly reached: readonly number[] } {
  let level = Math.floor(from.level);
  if (level >= SKILL_CAP) return { level, experience: 0, reached: [] };
  let pool = Math.max(0, from.experience) + Math.max(0, experience);
  const reached: number[] = [];
  for (;;) {
    const threshold = skillThreshold(level, curve, settings);
    if (pool < threshold || threshold <= 0 || level >= SKILL_CAP) break;
    pool -= threshold;
    level++;
    reached.push(level);
  }
  return { level, experience: level >= SKILL_CAP ? 0 : pool, reached };
}

/** How far a skill is toward its next level (0..1; full at 100). */
export function skillFraction(
  progress: SkillProgress,
  curve: SkillCurve,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  if (progress.level >= SKILL_CAP) return 1;
  const threshold = skillThreshold(progress.level, curve, settings);
  return threshold > 0 ? Math.max(0, Math.min(1, progress.experience / threshold)) : 0;
}

/** The character experience a skill reaching level n gives. */
export function characterExperience(
  levelReached: number,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  return levelReached * settings.xpPerSkillRank;
}

/**
 * The level-ups waiting at `level` with `experience`: thresholds the experience covers one
 * after another (each level-up taken lowers it by its level's threshold).
 */
export function levelUpsWaiting(
  level: number,
  experience: number,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  let waiting = 0;
  let pool = experience;
  for (let at = Math.max(1, level); waiting < 1000; at++) {
    const threshold = levelThreshold(at, settings);
    if (pool < threshold) break;
    pool -= threshold;
    waiting++;
  }
  return waiting;
}

/** How far the character is toward its next level (0..1; full while a level-up waits). */
export function levelFraction(
  level: number,
  experience: number,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  const threshold = levelThreshold(level, settings);
  return Math.max(0, Math.min(1, experience / threshold));
}

/** The total character experience from level 1 to `level` (UESP: 12.5 L² + 62.5 L − 75). */
export function experienceToLevel(
  level: number,
  settings: ProgressionSettings = PROGRESSION_DEFAULTS,
): number {
  let total = 0;
  for (let at = 1; at < level; at++) total += levelThreshold(at, settings);
  return total;
}
