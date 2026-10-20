// How actors other than the player get their level and their stats, as the game computes them:
//
// - An encounter zone's level (ECZN; Creation Kit "Encounter Zone"): the player's level when
//   the player first meets it, within its minimum and maximum (0: none); with "Match PC Below
//   Minimum Level" a player below the minimum sets it to the player's own. It keeps that level
//   until the zone resets (never, with "Never Resets").
// - The level a leveled actor's lists are picked at: its encounter's level (the zone's, else
//   the player's) times its reference's level modifier (ACHR XLCM: easy fLeveledActorMultEasy,
//   medium ...Medium, hard ...Hard, very hard ...VeryHard; UESP "Leveled Lists": a very hard
//   actor is at least the next entry up).
// - An actor whose level follows the player's (ACBS "PC Level Mult"): its multiplier times the
//   level it follows, within its calc min and max (0: none).
// - An auto-calculated NPC (ACBS "Auto calc stats"; UESP "Mod File Format/CLAS"): each level
//   past the first brings iAVDhmsLevelUp (10) attribute points and iAVDSkillsLevelUp (8) skill
//   points, shared out by its class's weights: whole rounds of the weights first, then what is
//   left one point at a time in turn (higher weights first; skills by actor value, attributes
//   stamina, magicka, health), none past its weight; health also gains fNPCHealthLevelBonus (5)
//   a level. Skills start at 15 plus the race's bonus, attributes at the race's starting value
//   plus the NPC's offset; skills stop at 100. This reproduces the stats the Creation Kit
//   stored in the NPC_ records (tools/progression-info.ts --audit).
//
// Platform-independent. Notes: docs/gameplay.md ("Skills, levels and actor values").

import { SKILL_COUNT } from '../world/actor-values.ts';
import {
  EncounterZoneFlag,
  LevelModifier,
  type ClassStats,
  type EncounterZone,
} from '../world/leveling-records.ts';

/** Where every skill starts (UESP "Skills": 15, plus the race's bonus). */
export const SKILL_START = 15;
/** Skills go no higher by use or levels (UESP "Leveling"). */
export const SKILL_CAP = 100;

/** The game settings actors' levels and stats read (GMSTs; vanilla values by default). */
export interface LevelingSettings {
  /** iAVDhmsLevelUp: attribute points a level. */
  readonly attributePoints: number;
  /** iAVDSkillsLevelUp: skill points a level (auto-calculated NPCs). */
  readonly skillPoints: number;
  /** fNPCHealthLevelBonus: an NPC's health a level besides its class's share. */
  readonly npcHealthPerLevel: number;
  /** fLeveledActorMultEasy, ...Medium, ...Hard, ...VeryHard (XLCM 0..3). */
  readonly levelModifierMults: readonly number[];
}

export const LEVELING_DEFAULTS: LevelingSettings = {
  attributePoints: 10,
  skillPoints: 8,
  npcHealthPerLevel: 5,
  levelModifierMults: [0.33, 0.67, 1, 1.25],
};

export function levelingSettings(
  number: (editorId: string) => number | undefined,
): LevelingSettings {
  const d = LEVELING_DEFAULTS;
  return {
    attributePoints: number('iAVDhmsLevelUp') ?? d.attributePoints,
    skillPoints: number('iAVDSkillsLevelUp') ?? d.skillPoints,
    npcHealthPerLevel: number('fNPCHealthLevelBonus') ?? d.npcHealthPerLevel,
    levelModifierMults: ['Easy', 'Medium', 'Hard', 'VeryHard'].map(
      (name, i) => number(`fLeveledActorMult${name}`) ?? d.levelModifierMults[i] ?? 1,
    ),
  };
}

// --- Levels ---------------------------------------------------------------------------------

/**
 * An encounter zone's level for a player of `playerLevel` meeting it: within its minimum and
 * maximum, below the minimum only with Match PC Below Minimum Level.
 */
export function zoneLevel(
  zone: Pick<EncounterZone, 'minLevel' | 'maxLevel' | 'flags'>,
  playerLevel: number,
): number {
  const matchBelow = (zone.flags & EncounterZoneFlag.matchPcBelowMinimum) !== 0;
  let level = matchBelow ? playerLevel : Math.max(zone.minLevel, playerLevel);
  if (zone.maxLevel > 0) level = Math.min(zone.maxLevel, level);
  return Math.max(1, level);
}

/**
 * The level a leveled actor's lists are picked at: its encounter's level times its level
 * modifier (none: as it is). TODO(M13): rounding (the engine's is undocumented; to nearest).
 */
export function leveledPickLevel(
  encounterLevel: number,
  modifier: number | undefined,
  settings: LevelingSettings = LEVELING_DEFAULTS,
): number {
  if (modifier === undefined) return Math.max(1, encounterLevel);
  const mult = settings.levelModifierMults[modifier] ?? 1;
  return Math.max(1, Math.round(encounterLevel * mult));
}

/** Whether a level modifier picks at least the next entry up (UESP: very hard). */
export const picksNextEntry = (modifier: number | undefined): boolean =>
  modifier === LevelModifier.veryHard;

/** The NPC_ fields its level comes from (ACBS). */
export interface LevelRecord {
  /** Its level, or with `followsPlayer` its multiplier × 1000. */
  readonly level: number;
  readonly followsPlayer: boolean;
  readonly calcMinLevel: number;
  /** 0: no maximum. */
  readonly calcMaxLevel: number;
}

/**
 * An actor's level: fixed, or (PC Level Mult) the level it follows times its multiplier, rounded
 * down, within its calc min and max. Without a calc min it may come to 0, as the Creation Kit
 * has it: the records' stats of a 0.75 multiplier at level 1 are a level-0 NPC's (5 health less
 * than level 1's; dunRatwayGian, MG07LabyrinthianThrall02).
 */
export function actorLevel(record: LevelRecord, follows: number): number {
  if (!record.followsPlayer) return record.level;
  const level = Math.floor(follows * (record.level / 1000) + 1e-6);
  const capped = record.calcMaxLevel > 0 ? Math.min(record.calcMaxLevel, level) : level;
  return Math.max(record.calcMinLevel, capped);
}

// --- Auto-calculated stats ------------------------------------------------------------------

/**
 * Shares `total` points by `weights`: whole rounds of the weights, then the rest one point at a
 * time over `order` (indices into `weights`) in turn, each taking at most its weight.
 */
export function sharePoints(
  total: number,
  weights: readonly number[],
  order: readonly number[],
): number[] {
  const shares = weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0 || total <= 0) return shares;
  const rounds = Math.floor(total / sum);
  for (const [i, weight] of weights.entries()) shares[i] = rounds * Math.max(0, weight);
  let left = total - rounds * sum;
  const taken = weights.map(() => 0);
  while (left > 0) {
    let gave = false;
    for (const i of order) {
      if (left <= 0) break;
      if ((taken[i] ?? 0) >= (weights[i] ?? 0)) continue;
      taken[i] = (taken[i] ?? 0) + 1;
      shares[i] = (shares[i] ?? 0) + 1;
      left--;
      gave = true;
    }
    if (!gave) break;
  }
  return shares;
}

/** The race's part of an auto-calculated NPC (RACE DATA). */
export interface RaceStart {
  /** Skill bonuses: actor value index (6..23) and bonus. */
  readonly skillBoosts: readonly { readonly actorValue: number; readonly bonus: number }[];
  readonly startingHealth: number;
  readonly startingMagicka: number;
  readonly startingStamina: number;
}

export interface AutoCalcInput {
  readonly level: number;
  readonly weights: Pick<
    ClassStats,
    'skillWeights' | 'healthWeight' | 'magickaWeight' | 'staminaWeight'
  >;
  readonly race: RaceStart;
  /** ACBS offsets. */
  readonly healthOffset: number;
  readonly magickaOffset: number;
  readonly staminaOffset: number;
}

export interface AutoCalcStats {
  /** The 18 skills (One-handed .. Enchanting), without the record's skill offsets. */
  readonly skills: readonly number[];
  readonly health: number;
  readonly magicka: number;
  readonly stamina: number;
}

/** An auto-calculated NPC's skills and attributes at its level (see the header). */
export function autoCalcStats(
  input: AutoCalcInput,
  settings: LevelingSettings = LEVELING_DEFAULTS,
): AutoCalcStats {
  // Levels past the first (−1 at level 0: no points, 5 health less).
  const levels = Math.floor(input.level) - 1;
  const skills = Array.from({ length: SKILL_COUNT }, (_, i) =>
    input.race.skillBoosts
      .filter((entry) => entry.actorValue === i + 6)
      .reduce((a, entry) => a + entry.bonus, SKILL_START),
  );
  // Skills: higher weights first, then the later actor value; what a skill would get past 100
  // goes to the others, shared out again. TODO(M13): the records' skills of NPCs whose skills
  // reach 100 (41 of 1713 auto-calculated NPC_ records; 39 of a fixed level, whose stored
  // skills are used) show only part of it going on, one point a skill in turn after the last
  // one given: the amount is not worked out.
  const weights = skills.map((_, i) => input.weights.skillWeights[i] ?? 0);
  let points = Math.max(0, levels) * settings.skillPoints;
  while (points > 0) {
    const open = weights.map((weight, i) => ((skills[i] ?? 0) < SKILL_CAP ? weight : 0));
    const order = open
      .map((weight, i) => ({ weight, i }))
      .sort((a, b) => b.weight - a.weight || b.i - a.i)
      .map((entry) => entry.i);
    const gains = sharePoints(points, open, order);
    points = 0;
    for (const [i, gain] of gains.entries()) {
      const now = (skills[i] ?? 0) + gain;
      skills[i] = Math.min(SKILL_CAP, now);
      points += Math.max(0, now - SKILL_CAP);
    }
    if (open.every((weight, i) => weight <= 0 || (skills[i] ?? 0) >= SKILL_CAP)) break;
  }
  // Attributes (health, magicka, stamina): higher weights first, then stamina, magicka, health.
  const attributeWeights = [
    input.weights.healthWeight,
    input.weights.magickaWeight,
    input.weights.staminaWeight,
  ];
  const attributeOrder = [0, 1, 2].sort(
    (a, b) => (attributeWeights[b] ?? 0) - (attributeWeights[a] ?? 0) || b - a,
  );
  const [health = 0, magicka = 0, stamina = 0] = sharePoints(
    Math.max(0, levels) * settings.attributePoints,
    attributeWeights,
    attributeOrder,
  );
  return {
    skills,
    health:
      input.race.startingHealth + input.healthOffset + levels * settings.npcHealthPerLevel + health,
    magicka: input.race.startingMagicka + input.magickaOffset + magicka,
    stamina: input.race.startingStamina + input.staminaOffset + stamina,
  };
}
