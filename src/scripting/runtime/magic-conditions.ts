// Condition functions (CTDA) of magic, on the running game: the effects on an actor
// (HasMagicEffect, HasMagicEffectKeyword, IsSpellTarget), what it is and wears that effects'
// conditions ask (IsUndead, WornHasKeyword, WornApparelHasKeywordCount), and, in an effect's
// own conditions, the effect (EffectWasDualCast, ScriptEffectElapsedSeconds); what an actor
// casts and shouts (casting-engine.ts: IsCasting, IsDualCasting, GetCurrentCastingType,
// GetCurrentDeliveryType, IsCurrentSpell, SpellHasKeyword, IsWardState,
// GetCurrentShoutVariation, HasShout; the idle tree's ActionRightAttack picks MRh_SpellAimedStart
// and the like by them, per casting source: 0 left, 1 right, 2 voice). Indices: UESP "Skyrim
// Mod:Function Indices". condition-values.ts asks here for the functions it does not value
// itself. Platform-independent.

import type { Condition } from '../conditions.ts';
import type { ScriptRuntime } from './runtime.ts';

/** UESP's function indices of the conditions valued here. */
export const MagicFn = {
  scriptEffectElapsedSeconds: 186,
  hasMagicEffect: 214,
  isSpellTarget: 223,
  wornHasKeyword: 682,
  hasMagicEffectKeyword: 699,
  isUndead: 715,
  wornApparelHasKeywordCount: 722,
  effectWasDualCast: 724,
  hasShout: 378,
  getCurrentCastingType: 571,
  getCurrentDeliveryType: 572,
  isCurrentSpell: 595,
  spellHasKeyword: 596,
  isWardState: 602,
  isDualCasting: 627,
  isCasting: 632,
  getCurrentShoutVariation: 676,
  spellHasCastingPerk: 713,
} as const;

/**
 * A magic condition's value for a reference (undefined: not one valued here). `effectKey`: the
 * active effect whose conditions are evaluated, if any.
 */
export async function magicConditionValue(
  runtime: ScriptRuntime,
  condition: Condition,
  reference: number | undefined,
  effectKey: string | undefined,
): Promise<number | undefined> {
  const flag = (value: boolean): number => (value ? 1 : 0);
  const effect = effectKey === undefined ? undefined : runtime.magic.scriptEffect(effectKey);
  switch (condition.function) {
    case MagicFn.hasMagicEffect:
      return reference === undefined
        ? undefined
        : flag(runtime.magic.hasEffect(reference, condition.form));
    case MagicFn.hasMagicEffectKeyword:
      return reference === undefined
        ? undefined
        : flag(await runtime.magic.hasEffectKeyword(reference, condition.form));
    case MagicFn.isSpellTarget:
      return reference === undefined
        ? undefined
        : flag(runtime.magic.isSpellTarget(reference, condition.form));
    case MagicFn.isUndead:
      return reference === undefined ? undefined : flag(await runtime.magic.isUndead(reference));
    // What it wears (its outfit's armor and what is equipped, as Actor.WornHasKeyword reads it:
    // TODO(M11) the equip system); the count is of its apparel (ARMO).
    case MagicFn.wornHasKeyword:
    case MagicFn.wornApparelHasKeywordCount: {
      if (reference === undefined) return undefined;
      const apparel = condition.function === MagicFn.wornApparelHasKeywordCount;
      let count = 0;
      for (const item of await runtime.actors.worn(reference)) {
        if (apparel && (await runtime.forms.record(item))?.type !== 'ARMO') continue;
        if (await runtime.hasKeyword(item, condition.form)) count++;
      }
      return apparel ? count : flag(count > 0);
    }
    // The effect whose conditions these are.
    case MagicFn.effectWasDualCast:
      return effect === undefined ? undefined : flag(effect.dual === true);
    case MagicFn.scriptEffectElapsedSeconds:
      return effect === undefined ? undefined : effect.elapsed;
    // Casting (casting-engine.ts): the first parameter is the casting source.
    case MagicFn.hasShout:
      return reference === undefined
        ? undefined
        : flag(await runtime.actors.hasSpell(reference, condition.form));
    case MagicFn.isCasting:
      return reference === undefined ? undefined : flag(runtime.casting.isCasting(reference));
    case MagicFn.isDualCasting:
      return reference === undefined ? undefined : flag(runtime.casting.isDualCasting(reference));
    case MagicFn.getCurrentCastingType:
      return reference === undefined
        ? undefined
        : runtime.casting.castingType(reference, condition.raw1);
    case MagicFn.getCurrentDeliveryType:
      return reference === undefined
        ? undefined
        : runtime.casting.deliveryType(reference, condition.raw1);
    case MagicFn.spellHasKeyword:
      return reference === undefined
        ? undefined
        : flag(await runtime.casting.spellHasKeyword(reference, condition.raw1, condition.form2));
    case MagicFn.isCurrentSpell:
      return reference === undefined
        ? undefined
        : flag(runtime.casting.isCurrentSpell(reference, condition.form, condition.param2));
    case MagicFn.isWardState:
      return reference === undefined
        ? undefined
        : flag(runtime.casting.wardState(reference) === condition.raw1);
    case MagicFn.getCurrentShoutVariation:
      return reference === undefined ? undefined : runtime.casting.shoutVariation(reference);
    // TODO(M11): the perk system (a perk of the spell's school with the casting entry point).
    case MagicFn.spellHasCastingPerk:
      return 0;
    default:
      return undefined;
  }
}
