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
 * Banish, Reanimate, Command). TODO(M13): Disarm's magnitude read as a level too.
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
