// The rules of magic effects on actors, as the records and the documented engine give them
// (Creation Kit: "Magic Effect", "Spell"; UESP: "Skyrim:Magic Overview", "Skyrim:Resistances",
// "Skyrim:Dual Casting", "Skyrim:Soul Gems"; CommonLibSSE: the ActiveEffect classes of each
// archetype). How strong an effect item is once cast (dual casting's power on its magnitude
// and duration), how it changes its actor value (a temporary modifier undone as it ends, damage
// or a restore at once, or each second), how much a target resists it, which archetypes a
// target's level caps, the AI's target values of Calm, Frenzy, Fear and Rally, a soul's size.
// Platform-independent: src/scripting/runtime/magic-engine.ts runs them on the game.
// Notes: docs/gameplay.md ("Magic effects").

import { ActorValue } from '../../world/actor-values.ts';
import type { ItemEffect } from '../../world/item-records.ts';
import { EffectArchetype, EffectFlag, type MagicEffectRecord } from '../../world/magic-effects.ts';
import type { MagicItemKind } from '../../world/magic-records.ts';

type Effect = Pick<MagicEffectRecord, 'flags' | 'archetype'>;

/** Actor values the archetypes use (UESP "Skyrim Mod:Actor Value Indices"). */
export const MagicValue = {
  confidence: ActorValue.confidence,
  aggression: ActorValue.aggression,
  poisonResist: 40,
  fireResist: 41,
  electricResist: 42,
  frostResist: 43,
  magicResist: 44,
  diseaseResist: 45,
  paralysis: 53,
  invisibility: 54,
  nightEye: 55,
  detectLifeRange: 56,
  wardPower: 63,
  absorbChance: 83,
} as const;

/** The resistance cap of the player, a percentage: fPlayerMaxResistance (the engine's 85). */
export const PLAYER_MAX_RESISTANCE = 85;

/** fMagicDualCastingEffectivenessBase: a dual-cast spell's power (2.2 in Skyrim.esm). */
export const DUAL_CASTING_POWER = 2.2;

/**
 * Archetypes whose effects change their actor value as Value Modifier does (CommonLibSSE: the
 * classes deriving ValueModifierEffect: Absorb, Dual Value Modifier, Enhance Weapon, Peak Value
 * Modifier, Accumulate Magnitude, Value and Parts, Invisibility, Night Eye, Darkness,
 * Paralysis, Grab Actor).
 */
const VALUE_ARCHETYPES: ReadonlySet<number> = new Set([
  EffectArchetype.valueModifier,
  EffectArchetype.absorb,
  EffectArchetype.dualValueModifier,
  EffectArchetype.enhanceWeapon,
  EffectArchetype.peakValueModifier,
  EffectArchetype.accumulateMagnitude,
  EffectArchetype.valueAndParts,
  EffectArchetype.invisibility,
  EffectArchetype.nightEye,
  EffectArchetype.darkness,
  EffectArchetype.paralysis,
  EffectArchetype.grabActor,
]);

/**
 * Archetypes that move an AI value to a target (CommonLibSSE TargetValueModifierEffect: Calm,
 * Frenzy, Demoralize, Rally; Turn Undead and Banish derive Demoralize), by the value they set:
 * Calm: Aggression 0 (unaggressive), Frenzy: 3 (frenzied); Demoralize: Confidence 0 (cowardly),
 * Rally: 4 (foolhardy), the AI data's scales (UESP "Skyrim:AI Data"). TODO(M13): the target
 * values are inferred from the class and the archetypes' actor values (Aggression, Confidence).
 */
export const TARGET_VALUES: ReadonlyMap<number, number> = new Map([
  [EffectArchetype.calm, 0],
  [EffectArchetype.frenzy, 3],
  [EffectArchetype.demoralize, 0],
  [EffectArchetype.turnUndead, 0],
  [EffectArchetype.banish, 0],
  [EffectArchetype.rally, 4],
]);

/**
 * Archetypes whose magnitude is the highest level of actor they work on ("up to level <mag>":
 * UESP "Skyrim:Illusion", "Skyrim:Conjuration": Calm, Fear, Frenzy, Rally, Turn Undead,
 * Banish, Reanimate, Command; "Skyrim:Disarm": Zun disarms enemies up to level 12).
 */
export const LEVEL_CAPPED: ReadonlySet<number> = new Set([
  EffectArchetype.calm,
  EffectArchetype.demoralize,
  EffectArchetype.frenzy,
  EffectArchetype.rally,
  EffectArchetype.turnUndead,
  EffectArchetype.banish,
  EffectArchetype.reanimate,
  EffectArchetype.commandSummoned,
  EffectArchetype.disarm,
]);

/** Whether an effect changes its actor value as a value modifier does. */
export function isValueEffect(effect: Effect): boolean {
  return VALUE_ARCHETYPES.has(effect.archetype) || TARGET_VALUES.has(effect.archetype);
}

/**
 * How a value effect changes its actor value (Creation Kit "Magic Effect": Recover undoes the
 * change as the effect ends; an effect with a duration that does not recover gives its
 * magnitude each second):
 * - 'temporary': a temporary modifier while it lasts (Recover; Peak Value Modifier always, its
 *   class undoing it as it is removed: CommonLibSSE PeakValueModifierEffect::OnRemove, 320 of
 *   the 332 vanilla ones recover; the AI target values);
 * - 'once': damage or a restore at once (no duration, No Duration, or a constant effect);
 * - 'perSecond': damage or a restore of its magnitude each second of its duration.
 */
export function valueMode(
  effect: Effect,
  duration: number,
  constant: boolean,
): 'temporary' | 'once' | 'perSecond' {
  if (
    (effect.flags & EffectFlag.recover) !== 0 ||
    effect.archetype === EffectArchetype.peakValueModifier ||
    effect.archetype === EffectArchetype.accumulateMagnitude ||
    TARGET_VALUES.has(effect.archetype)
  ) {
    return 'temporary';
  }
  if (constant || duration <= 0 || (effect.flags & EffectFlag.noDuration) !== 0) return 'once';
  return 'perSecond';
}

/**
 * Whether an effect without a duration acts at once (damage or a restore: a concentration spell's
 * Flames, Healing), not by lasting (wards, Recover effects, Calm, Telekinesis, ...).
 */
export function actsAtOnce(effect: Effect): boolean {
  return isValueEffect(effect) && valueMode(effect, 0, false) === 'once';
}

/** The sign of a value effect's change: detrimental effects take the magnitude away. */
export function valueSign(effect: Pick<MagicEffectRecord, 'flags'>): number {
  return (effect.flags & EffectFlag.detrimental) !== 0 ? -1 : 1;
}

/**
 * An effect item's magnitude and duration as cast with a power (dual casting): the power scales
 * the magnitude (Power Affects Magnitude) and the duration (Power Affects Duration); No
 * Magnitude / No Duration effects have none (Creation Kit "Magic Effect"; UESP "Skyrim:Dual
 * Casting").
 */
export function castStrength(
  item: Pick<ItemEffect, 'magnitude' | 'duration'>,
  effect: Pick<MagicEffectRecord, 'flags'>,
  power = 1,
): { magnitude: number; duration: number } {
  const flags = effect.flags;
  return {
    magnitude:
      (flags & EffectFlag.noMagnitude) !== 0
        ? 0
        : item.magnitude * ((flags & EffectFlag.powerAffectsMagnitude) !== 0 ? power : 1),
    duration:
      (flags & EffectFlag.noDuration) !== 0
        ? 0
        : item.duration * ((flags & EffectFlag.powerAffectsDuration) !== 0 ? power : 1),
  };
}

/**
 * The amount a value effect puts on its actor value: its magnitude; an effect without one
 * (No Magnitude: Paralysis, Invisibility) sets its value as a flag, 1.
 */
export function valueAmount(effect: Pick<MagicEffectRecord, 'flags'>, magnitude: number): number {
  return (effect.flags & EffectFlag.noMagnitude) !== 0 || magnitude === 0 ? 1 : magnitude;
}

/**
 * What a resistance leaves of an effect: 1 − resistance / 100, the player's resistance capped
 * at fPlayerMaxResistance; a negative resistance (a weakness) makes it stronger, 100 or more
 * resists it all (UESP "Skyrim:Resistances").
 */
export function resistanceMultiplier(resistance: number, cap: number | undefined): number {
  const capped = cap === undefined ? resistance : Math.min(resistance, cap);
  return Math.max(0, 1 - capped / 100);
}

/**
 * Whether Magic Resistance applies to an effect of an item, besides the effect's own resist
 * value: the hostile and detrimental effects of spells, shouts, scrolls and enchantments cast
 * or struck (not potions, poisons, food, ingredients, abilities, diseases), unless the spell
 * ignores resistance (UESP "Skyrim:Magic Resistance"). TODO(M13): the engine's exact list.
 */
export function magicResistanceApplies(
  kind: MagicItemKind,
  effect: Pick<MagicEffectRecord, 'flags' | 'resistValue'>,
  ignoresResistance: boolean,
): boolean {
  if (ignoresResistance || effect.resistValue === MagicValue.magicResist) return false;
  if ((effect.flags & (EffectFlag.hostile | EffectFlag.detrimental)) === 0) return false;
  return (
    kind === 'spell' ||
    kind === 'power' ||
    kind === 'lesserPower' ||
    kind === 'voice' ||
    kind === 'scroll' ||
    kind === 'enchantment' ||
    kind === 'staffEnchantment'
  );
}

/** Kinds of magic whose effects last as long as one has them (spells' SPIT types). */
export function isLastingKind(kind: MagicItemKind): boolean {
  return kind === 'ability' || kind === 'disease' || kind === 'addiction';
}

/**
 * A creature's soul size by its level (UESP "Skyrim:Soul Gems"; the game settings
 * iLesserSoulActorLevel 4, iCommonSoulActorLevel 16, iGreaterSoulActorLevel 28,
 * iGrandSoulActorLevel 38): 1 petty .. 5 grand; an NPC's is a black soul, grand in size.
 */
export function soulSize(
  level: number,
  npc: boolean,
  levels: { lesser: number; common: number; greater: number; grand: number } = {
    lesser: 4,
    common: 16,
    greater: 28,
    grand: 38,
  },
): number {
  if (npc) return 5;
  if (level >= levels.grand) return 5;
  if (level >= levels.greater) return 4;
  if (level >= levels.common) return 3;
  if (level >= levels.lesser) return 2;
  return 1;
}

/**
 * The soul gem a soul goes into: the smallest empty one that holds it; an NPC's soul only into
 * one that holds NPC souls (Black Soul Gems), which a creature's goes into last (UESP: "the soul
 * will be stored in the smallest gem that can hold it").
 */
export function soulGemFor<T extends { capacity: number; soul: number; holdsNpcSouls: boolean }>(
  gems: readonly T[],
  size: number,
  npc: boolean,
): T | undefined {
  return gems
    .filter((gem) => gem.soul === 0 && gem.capacity >= size && (!npc || gem.holdsNpcSouls))
    .sort(
      (a, b) => a.capacity - b.capacity || Number(a.holdsNpcSouls) - Number(b.holdsNpcSouls),
    )[0];
}

/** Feet in units (the effects' areas are in feet; one foot is 21.33 units: UESP "Units"). */
export const UNITS_PER_FOOT = 64 / 3;

/** The text of a time remaining as the magic menu's cards count it (whole seconds, ...). */
export function remainingSeconds(duration: number, elapsed: number): number {
  return duration > 0 ? Math.max(0, duration - elapsed) : 0;
}

/**
 * The settings the effects' archetypes read (GMSTs), each with its fallback where the load order
 * has none: Skyrim.esm's value for those it sets, else the engine's built-in default.
 */
const EFFECT_SETTING_TABLE = {
  /** A ward grows by (Mult × skill + Base) × its magnitude a second. */
  wardPowerMaxBase: ['fMagicWardPowerMaxBase', 1.3],
  wardPowerMaxMult: ['fMagicWardPowerMaxMult', 0],
  /** Other Accumulate Magnitude effects grow by this a second. */
  accumulatingRate: ['fMagicDefaultAccumulatingModifierEffectRate', 1],
  /** Seconds a ward lowered by a hit stops growing. */
  accumulatingHold: ['fMagicAccumulatingModifierEffectHoldDuration', 0.5],
  /** A summon's placement: how far ahead it is looked for; when a landing point is too near. */
  summonSearchRadius: ['fSummonedCreatureSearchRadius', 512],
  summonDistanceCheck: ['fSummonDistanceCheckThreshold', 750],
} as const satisfies Readonly<Record<string, readonly [string, number]>>;

export type EffectSettings = {
  readonly [K in keyof typeof EFFECT_SETTING_TABLE]: number;
};

export const EFFECT_DEFAULTS = Object.fromEntries(
  Object.entries(EFFECT_SETTING_TABLE).map(([key, [, fallback]]) => [key, fallback]),
) as EffectSettings;

export const EFFECT_SETTING_NAMES = Object.fromEntries(
  Object.entries(EFFECT_SETTING_TABLE).map(([key, [name]]) => [key, name]),
) as Readonly<Record<keyof EffectSettings, string>>;

/**
 * How fast an Accumulate Magnitude effect grows (a second; observed in the original): a
 * ward (WardPower) by (fMagicWardPowerMaxMult × its caster's skill + fMagicWardPowerMaxBase) ×
 * its magnitude, any other by fMagicDefaultAccumulatingModifierEffectRate.
 */
export function accumulateRate(
  actorValue: number,
  magnitude: number,
  skill: number,
  settings: EffectSettings = EFFECT_DEFAULTS,
): number {
  return actorValue === MagicValue.wardPower
    ? (settings.wardPowerMaxMult * skill + settings.wardPowerMaxBase) * magnitude
    : settings.accumulatingRate;
}

/**
 * What an Accumulate Magnitude effect adds over `seconds` (observed in the original): its
 * rate's share, no more than takes its actor value (`current`, whatever lowered it) to `cap`
 * (its magnitude; a ward's: the largest of the actor's wards).
 */
export function accumulateStep(
  rate: number,
  seconds: number,
  current: number,
  cap: number,
): number {
  const step = rate * Math.max(0, seconds);
  return current + step > cap ? cap - current : step;
}

/**
 * How far ahead of its summoner a summon is placed (observed in the original): the two
 * actors' radii and half of fSummonedCreatureSearchRadius between them.
 */
export function summonDistance(
  summonerRadius: number,
  creatureRadius: number,
  settings: Pick<EffectSettings, 'summonSearchRadius'> = EFFECT_DEFAULTS,
): number {
  return (
    Math.max(0, summonerRadius) + Math.max(0, creatureRadius) + settings.summonSearchRadius / 2
  );
}

/**
 * Whether a Target Location summon stands where its spell landed (observed in the
 * original): yes, unless the landing point lies within fSummonDistanceCheckThreshold of the summoner
 * and the place ahead of it (summonDistance) is farther away; then it stands there.
 */
export function summonAtLanding(
  landingDistance: number,
  aheadDistance: number,
  settings: Pick<EffectSettings, 'summonDistanceCheck'> = EFFECT_DEFAULTS,
): boolean {
  return landingDistance >= settings.summonDistanceCheck || aheadDistance <= landingDistance;
}

/**
 * The Guide archetype's settings (Clairvoyance's trail), each with its fallback where the load
 * order has none (Skyrim.esm's values).
 */
export const GUIDE_SETTING_TABLE = {
  waypoints: ['iMagicGuideWaypoints', 44],
  spacing: ['fMagicGuideSpacing', 46],
} as const satisfies Readonly<Record<string, readonly [string, number]>>;

/**
 * A Guide effect's waypoints along its path (observed in the original): from the path's
 * start, a point every `spacing` units along it, at most `count` of them (the engine puts the
 * effect's hazard at each).
 */
export function guideWaypoints(
  path: readonly (readonly [number, number, number])[],
  spacing: number,
  count: number,
): [number, number, number][] {
  const first = path[0];
  if (!first || count <= 0) return [];
  const points: [number, number, number][] = [[first[0], first[1], first[2]]];
  if (spacing <= 0) return points;
  let along = spacing;
  let walked = 0;
  for (let i = 1; i < path.length && points.length < count; i++) {
    const a = path[i - 1] ?? first;
    const b = path[i] ?? a;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (length > 0 && walked + length >= along && points.length < count) {
      const t = (along - walked) / length;
      points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      along += spacing;
    }
    walked += length;
  }
  return points;
}

// --- Taper -----------------------------------------------------------------------------------

type Tapered = Pick<MagicEffectRecord, 'flags' | 'taperWeight' | 'taperCurve' | 'taperDuration'>;

/**
 * The seconds an effect's taper adds to its duration (observed in the original: the
 * active effect lasts its effect item's duration plus the magic effect's taper duration); none
 * for an effect with No Magnitude or No Duration.
 */
export function taperSeconds(effect: Tapered): number {
  if ((effect.flags & (EffectFlag.noMagnitude | EffectFlag.noDuration)) !== 0) return 0;
  return Math.max(0, effect.taperDuration);
}

/**
 * Whether an effect's magnitude tapers in those last seconds (observed in the original):
 * not a Recover effect's (it lasts the taper's seconds longer at its whole magnitude), not
 * without a taper duration.
 */
export function tapers(effect: Tapered): boolean {
  return (effect.flags & EffectFlag.recover) === 0 && taperSeconds(effect) > 0.0001;
}

/**
 * An effect's magnitude with `remaining` seconds left of its duration (observed in the
 * original): whole until its last taper seconds, then magnitude × taper weight × (remaining / taper
 * duration)^taper curve. FireDamageFFAimed (Firebolt): weight 0.3, curve 2, 1 s.
 */
export function taperedMagnitude(magnitude: number, remaining: number, effect: Tapered): number {
  if (!tapers(effect)) return magnitude;
  const seconds = taperSeconds(effect);
  const left = Math.max(0, remaining);
  if (left >= seconds) return magnitude;
  return magnitude * effect.taperWeight * (left / seconds) ** effect.taperCurve;
}

/**
 * What a value effect gives over [from, to] seconds of its `total` duration (taper included): its
 * magnitude a second while whole, its tapered magnitude in its last taper seconds (the curve's
 * integral; the engine adds the frame's magnitude × the frame's time). A curve of −1 or less has
 * no integral: the middle of the span is taken.
 */
export function magnitudeOver(
  magnitude: number,
  total: number,
  effect: Tapered,
  from: number,
  to: number,
): number {
  const start = Math.max(0, from);
  const end = Math.min(total, to);
  if (end <= start) return 0;
  if (!tapers(effect)) return magnitude * (end - start);
  const seconds = Math.min(taperSeconds(effect), total);
  const whole = total - seconds;
  let sum = magnitude * Math.max(0, Math.min(end, whole) - start);
  const a = Math.max(start, whole);
  if (end > a) {
    const curve = effect.taperCurve;
    if (curve <= -1) {
      sum += taperedMagnitude(magnitude, total - (a + end) / 2, effect) * (end - a);
    } else {
      // The remaining time r runs from total − a down to total − end:
      // ∫ (r / D)^c dr = D / (c + 1) × (r / D)^(c + 1).
      const share = (r: number): number => (Math.max(0, r) / seconds) ** (curve + 1);
      sum +=
        magnitude *
        effect.taperWeight *
        (seconds / (curve + 1)) *
        (share(total - a) - share(total - end));
    }
  }
  return sum;
}

// --- Skill use -------------------------------------------------------------------------------

/**
 * Archetypes whose effects train their school as they act, by what they did (observed in the
 * original: the archetypes' table marks them): Value Modifier, Dual Value Modifier,
 * Bound Weapon, Summon Creature, Detect Life, Telekinesis, Reanimate, Accumulate Magnitude, Peak
 * Value Modifier. A fire and forget effect of another archetype trains as it takes hold; a
 * concentration one of another archetype not at all.
 */
export const SKILL_BY_EFFECT: ReadonlySet<number> = new Set([
  EffectArchetype.valueModifier,
  EffectArchetype.dualValueModifier,
  EffectArchetype.boundWeapon,
  EffectArchetype.summonCreature,
  EffectArchetype.detectLife,
  EffectArchetype.telekinesis,
  EffectArchetype.reanimate,
  EffectArchetype.accumulateMagnitude,
  EffectArchetype.peakValueModifier,
]);

/**
 * The skill uses one effect item of a spell gives its magic effect's school (observed in the
 * original): the effect item's cost (no more than the spell's own cost when that is not
 * calculated) × the magic effect's skill usage multiplier (MGEF DATA; 0 for 1,176 of the 1,731
 * vanilla effects), × the seconds a concentration spell's hit stands for, × the share of its
 * magnitude it did (a Value Modifier's: what it changed of the value; 1 for the others). Dual
 * casting adds nothing: the effect item's cost is the same.
 */
export function effectSkillUses(use: {
  readonly effectCost: number;
  readonly spellCost?: number | undefined;
  readonly skillUsageMult: number;
  readonly seconds?: number | undefined;
  readonly share?: number | undefined;
}): number {
  const cost =
    use.spellCost === undefined ? use.effectCost : Math.min(use.effectCost, use.spellCost);
  const share = Math.min(1, Math.max(0, use.share ?? 1));
  return Math.max(0, cost) * use.skillUsageMult * (use.seconds ?? 1) * share;
}
