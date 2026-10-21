// The rules of casting, as the records and the game settings give them (UESP "Skyrim:Magic
// Overview", "Skyrim:Magicka", "Skyrim:Dual Casting", "Skyrim:Staffs", "Skyrim:Powers",
// "Skyrim:Leveling"; the Creation Kit's "Spell"):
//
// - A spell's base cost is SPIT's own when it is not calculated (0x1), else the sum of its
//   effects' costs: base cost × (magnitude × duration / 10)^1.1, a magnitude under 1 counted as
//   1, a duration of 0 (and any for concentration spells) as 10, times 1 + fMagicAreaBaseCostMult
//   × area (0 in Skyrim.esm: areas cost nothing).
// - The magicka it costs: base × (1 − (fMagicCasterPCSkillCostBase × skill)^fMagicPCSkillCostScale)
//   for the player (0.0025, 0.65: UESP's 1 − (skill / 400)^0.65), the skill being the school's
//   (its costliest effect's) with its fortifications; for NPCs fMagicCasterSkillCostMult and
//   fMagicSkillCostScale (0.5, 0.5); times the cost modifiers (perks, Fortify <School>: the
//   perk system's Mod Spell Cost, applied by the casting engine to this cost); dual casting
//   × fMagicDualCastingCostMult (2.8). A concentration
//   spell's cost is a second's.
// - Charging: a fire and forget spell is ready after its charge time (SPIT @12; dual cast ×
//   fMagicDualCastingTimeMult, 1), released then it fires, before it is let go without effect;
//   a concentration spell casts from its charge time on, spending its cost a second while it is
//   held and magicka lasts.
// - Skill use: a spell that takes effect gives its school the spell's base cost in uses (UESP
//   "Leveling": the base magicka cost; dual cast its cost multiplied as well, TODO(M13): the
//   engine's dual-cast share); a concentration spell a second's at a time. Scrolls and staffs
//   train nothing (staffs: UESP "Staffs", their school only with perks).
// - Staffs spend their enchantment's cost from their charge, not magicka; powers are used
//   once a day (24 game hours), lesser powers whenever; shouts are the voice's (shouts.ts).
//
// Platform-independent: src/scripting/runtime/casting-engine.ts runs them on the game.
// Notes: docs/gameplay.md ("Casting and shouts").

import type { ItemEffect } from '../../world/item-records.ts';
import { CastType } from '../../world/spell-records.ts';

/** The settings casting reads (GMSTs; Skyrim.esm's values by default). */
export interface CastingSettings {
  /** fMagicCasterPCSkillCostBase, fMagicPCSkillCostScale. */
  readonly pcSkillCostBase: number;
  readonly pcSkillCostScale: number;
  /** fMagicCasterSkillCostMult, fMagicSkillCostScale (NPCs). */
  readonly npcSkillCostMult: number;
  readonly npcSkillCostScale: number;
  /** fMagicDualCastingCostMult, fMagicDualCastingTimeMult. */
  readonly dualCostMult: number;
  readonly dualTimeMult: number;
  /** fMagicAreaBaseCostMult. */
  readonly areaBaseCostMult: number;
}

export const CASTING_DEFAULTS: CastingSettings = {
  pcSkillCostBase: 0.0025,
  pcSkillCostScale: 0.65,
  npcSkillCostMult: 0.5,
  npcSkillCostScale: 0.5,
  dualCostMult: 2.8,
  dualTimeMult: 1,
  areaBaseCostMult: 0,
};

/** The settings' names, in CastingSettings' order (read from the load order). */
export const CASTING_SETTING_NAMES: Readonly<Record<keyof CastingSettings, string>> = {
  pcSkillCostBase: 'fMagicCasterPCSkillCostBase',
  pcSkillCostScale: 'fMagicPCSkillCostScale',
  npcSkillCostMult: 'fMagicCasterSkillCostMult',
  npcSkillCostScale: 'fMagicSkillCostScale',
  dualCostMult: 'fMagicDualCastingCostMult',
  dualTimeMult: 'fMagicDualCastingTimeMult',
  areaBaseCostMult: 'fMagicAreaBaseCostMult',
};

/** SPIT's flag: the cost is SPIT's own (not calculated). */
const MANUAL_COST = 0x1;

/** One effect item's cost: base × (magnitude × duration / 10)^1.1 × the area's factor. */
export function effectItemCost(
  baseCost: number,
  entry: Pick<ItemEffect, 'magnitude' | 'duration' | 'area'>,
  concentration: boolean,
  settings: Pick<CastingSettings, 'areaBaseCostMult'> = CASTING_DEFAULTS,
): number {
  const magnitude = Math.max(1, entry.magnitude);
  const duration = concentration || entry.duration === 0 ? 10 : entry.duration;
  // TODO(M13): the engine's use of fMagicAreaBaseCostMult (0 in Skyrim.esm) is inferred.
  const area = 1 + settings.areaBaseCostMult * Math.max(0, entry.area);
  return baseCost * ((magnitude * duration) / 10) ** 1.1 * area;
}

/**
 * A magic item's base cost before the caster's skill: its own when it is not calculated (SPIT
 * 0x1; an enchantment's "no auto calc" 0x1 with its ENIT cost), else its effects' costs summed.
 */
export function itemBaseCost(
  item: {
    readonly cost: number;
    readonly flags: number;
    readonly castType: number;
    readonly effects: readonly Pick<ItemEffect, 'effect' | 'magnitude' | 'duration' | 'area'>[];
  },
  effectBaseCost: (effect: number) => number,
  settings: Pick<CastingSettings, 'areaBaseCostMult'> = CASTING_DEFAULTS,
): number {
  if ((item.flags & MANUAL_COST) !== 0) return item.cost;
  const concentration = item.castType === CastType.concentration;
  let cost = 0;
  for (const entry of item.effects)
    cost += effectItemCost(effectBaseCost(entry.effect), entry, concentration, settings);
  return cost;
}

/**
 * What the caster's skill leaves of a cost: the player 1 − (fMagicCasterPCSkillCostBase ×
 * skill)^fMagicPCSkillCostScale, NPCs 1 − fMagicCasterSkillCostMult × (skill / 100)^
 * fMagicSkillCostScale (TODO(M13): the NPCs' formula is inferred from the settings' names and
 * values). Never below 0.
 */
export function skillCostFactor(
  skill: number,
  player: boolean,
  settings: CastingSettings = CASTING_DEFAULTS,
): number {
  const level = Math.max(0, skill);
  const factor = player
    ? 1 - (settings.pcSkillCostBase * level) ** settings.pcSkillCostScale
    : 1 - settings.npcSkillCostMult * (level / 100) ** settings.npcSkillCostScale;
  return Math.max(0, factor);
}

/** What a cast costs in magicka (a concentration spell: a second of it). */
export function magickaCost(
  cast: {
    readonly baseCost: number;
    readonly skill: number;
    readonly player: boolean;
    readonly dual?: boolean;
    /** A share left by other modifiers (1: none; the perks' is the casting engine's). */
    readonly costMultiplier?: number;
  },
  settings: CastingSettings = CASTING_DEFAULTS,
): number {
  const dual = cast.dual === true ? settings.dualCostMult : 1;
  return (
    cast.baseCost *
    skillCostFactor(cast.skill, cast.player, settings) *
    (cast.costMultiplier ?? 1) *
    dual
  );
}

/** Seconds a cast charges (dual cast × fMagicDualCastingTimeMult). */
export function chargeSeconds(
  chargeTime: number,
  dual: boolean,
  settings: Pick<CastingSettings, 'dualTimeMult'> = CASTING_DEFAULTS,
): number {
  return Math.max(0, chargeTime) * (dual ? settings.dualTimeMult : 1);
}

/** The skill uses a cast that took effect gives its school: its base cost (dual: × the cost mult). */
export function castSkillUses(
  baseCost: number,
  dual: boolean,
  settings: Pick<CastingSettings, 'dualCostMult'> = CASTING_DEFAULTS,
): number {
  return Math.max(0, baseCost) * (dual ? settings.dualCostMult : 1);
}

// --- A hand's cast ------------------------------------------------------------------------

/**
 * Where a hand's cast is: charging, ready to fire (fire and forget), casting (concentration,
 * spending each second), or over.
 */
export type CastPhase = 'charging' | 'ready' | 'casting' | 'done';

export interface HandCast {
  /** CastType: fire and forget or concentration (constant effects are not cast). */
  readonly castType: number;
  /** Seconds it charges before it is ready (or casts). */
  readonly charge: number;
  phase: CastPhase;
  /** Seconds since it began. */
  elapsed: number;
}

/** A cast begun (a concentration spell without a charge time casts at once). */
export function beginCast(castType: number, charge: number): HandCast {
  const cast: HandCast = { castType, charge: Math.max(0, charge), phase: 'charging', elapsed: 0 };
  if (cast.charge <= 0) cast.phase = castType === CastType.concentration ? 'casting' : 'ready';
  return cast;
}

/**
 * A cast goes on for `seconds`. Returns the seconds of it that were spent casting (a
 * concentration spell's: what it costs and trains), and whether it became ready (or began
 * casting) in this time.
 */
export function advanceCast(
  cast: HandCast,
  seconds: number,
): { readonly casting: number; readonly began: boolean } {
  if (seconds <= 0 || cast.phase === 'done') return { casting: 0, began: false };
  const before = cast.elapsed;
  cast.elapsed += seconds;
  if (cast.phase === 'charging') {
    if (cast.elapsed < cast.charge) return { casting: 0, began: false };
    if (cast.castType === CastType.concentration) {
      cast.phase = 'casting';
      return { casting: cast.elapsed - Math.max(before, cast.charge), began: true };
    }
    cast.phase = 'ready';
    return { casting: 0, began: true };
  }
  return { casting: cast.phase === 'casting' ? seconds : 0, began: false };
}

/**
 * The hand lets go: a ready fire and forget spell fires, one still charging is let go without
 * effect; a concentration spell stops.
 */
export function releaseCast(cast: HandCast): 'fire' | 'cancel' | 'stop' {
  const phase = cast.phase;
  cast.phase = 'done';
  if (cast.castType === CastType.concentration) return phase === 'casting' ? 'stop' : 'cancel';
  return phase === 'ready' ? 'fire' : 'cancel';
}

// --- The graph's events ---------------------------------------------------------------------

/**
 * The behavior graph's event that starts a hand's cast, as the idle tree's ActionRightAttack /
 * ActionLeftAttack leaves pick it (0_master.hkx: CastRightFireForgetAimed MRh_SpellAimedStart
 * by GetCurrentCastingType and GetCurrentDeliveryType, CastRightWard MRh_WardStart by the
 * MagicWard keyword, CastRightTelekinesis, ...): MLh_ for the left hand, MRh_ for the right.
 */
export function castStartEvent(
  hand: 'left' | 'right',
  cast: {
    readonly castType: number;
    readonly delivery: number;
    readonly ward?: boolean;
    readonly telekinesis?: boolean;
  },
): string {
  const prefix = hand === 'left' ? 'MLh' : 'MRh';
  if (cast.castType === CastType.concentration) {
    if (cast.delivery >= 2) return `${prefix}_SpellAimedConcentrationStart`;
    if (cast.ward === true) return `${prefix}_WardStart`;
    if (cast.telekinesis === true) return `${prefix}_SpellTelekinesisStart`;
    return `${prefix}_SpellSelfConcentrationStart`;
  }
  return cast.delivery === 0 ? `${prefix}_SpellSelfStart` : `${prefix}_SpellAimedStart`;
}

// --- Staffs and powers ----------------------------------------------------------------------

/** A staff's casts left on its charge (its enchantment's cost a cast; 0: unlimited). */
export function staffCastsLeft(charge: number, costPerCast: number): number {
  return costPerCast > 0 ? Math.floor(charge / costPerCast + 1e-9) : Infinity;
}

/** A power used at `usedDay` (game days) can be used again from a game day later on. */
export function powerReady(usedDay: number | undefined, nowDay: number): boolean {
  return usedDay === undefined || nowDay - usedDay >= 1 - 1e-9;
}
