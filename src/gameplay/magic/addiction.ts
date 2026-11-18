// A potion's addiction (ALCH ENIT: the addiction spell and its chance), observed in the original:
// asked as a potion-type item is applied to an actor, after its effects took hold. A potion with
// no addiction or a chance of 0 gives none and asks nothing. A potion that carries the engine's
// Usage Monitor Effect (form 0x14B, made by the engine where no plugin defines that form) takes
// its chance from how much of it the drinker carries: the magnitudes of that potion's usage
// monitor effects still running on the drinker are summed; at or below
// fAddictionUsageMonitorThreshold (the engine's 25, Skyrim.esm 70) there is no addiction, above it the chance is the excess
// as a percentage. Either chance then goes through the drinker's perks (Mod Addiction Chance)
// and is rolled against 0-99. No vanilla potion has an addiction, nor any plugin the usage
// monitor: both are an earlier game's, kept for mods.
// Platform-independent.

import { EffectArchetype, EffectFlag, type MagicEffectRecord } from '../../world/magic-effects.ts';

/** The form of the engine's Usage Monitor Effect. */
export const USAGE_MONITOR_EFFECT = 0x14b;

/** fAddictionUsageMonitorThreshold's built-in default (Skyrim.esm sets 70). */
export const ADDICTION_USAGE_MONITOR_THRESHOLD = 25;

/**
 * The Usage Monitor Effect as the engine makes it where no plugin defines form 0x14B: a script
 * effect that does nothing, flagged Recover, fire and forget on self, no skill, no actor value,
 * no cost and no taper.
 */
export function usageMonitorEffect(): MagicEffectRecord {
  return {
    formId: USAGE_MONITOR_EFFECT,
    editorId: '',
    name: 'Usage Monitor Effect',
    description: '',
    flags: EffectFlag.recover,
    baseCost: 0,
    associatedItem: undefined,
    skill: -1,
    resistValue: -1,
    light: undefined,
    taperWeight: 0,
    hitShader: undefined,
    enchantShader: undefined,
    minimumSkill: 0,
    taperCurve: 0,
    taperDuration: 0,
    secondValueWeight: 0,
    archetype: EffectArchetype.script,
    actorValue: -1,
    secondActorValue: -1,
    projectile: undefined,
    explosion: undefined,
    castingType: 1,
    delivery: 0,
    castingArt: undefined,
    hitEffectArt: undefined,
    enchantArt: undefined,
    impactData: undefined,
    skillUsageMult: 0,
    dualCastArt: undefined,
    dualCastScale: 0,
    hitVisuals: undefined,
    enchantVisuals: undefined,
    equipAbility: undefined,
    imageSpaceModifier: undefined,
    perk: undefined,
    castingSoundLevel: 0,
    aiScore: 0,
    aiDelay: 0,
    keywords: [],
    counterEffects: [],
    sounds: [],
    conditions: [],
    scripted: false,
  };
}

/**
 * A potion's addiction chance before the perks (a share, 0..1), or undefined where it gives no
 * addiction and nothing more is asked. `chance`: its ENIT chance; `monitored`: the summed
 * magnitudes of its usage monitor effects running on the drinker (undefined: it carries none).
 */
export function addictionChance(
  chance: number,
  monitored: number | undefined,
  threshold = ADDICTION_USAGE_MONITOR_THRESHOLD,
): number | undefined {
  if (chance === 0) return undefined;
  if (monitored === undefined) return chance;
  return monitored <= threshold ? undefined : (monitored - threshold) * 0.01;
}

/** Whether the roll (0..99) gives the addiction at this chance (a share, after the perks). */
export function addictionTaken(chance: number, roll: number): boolean {
  return chance * 100 > roll;
}
