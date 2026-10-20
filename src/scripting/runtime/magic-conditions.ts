// Condition functions (CTDA) of magic, on the running game: the effects on an actor
// (HasMagicEffect, HasMagicEffectKeyword, IsSpellTarget), what it is and wears that effects'
// conditions ask (IsUndead, WornHasKeyword, WornApparelHasKeywordCount), and, in an effect's
// own conditions, the effect (EffectWasDualCast, ScriptEffectElapsedSeconds). Indices: UESP
// "Skyrim Mod:Function Indices". condition-values.ts asks here for the functions it does not
// value itself. Platform-independent.

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
    default:
      return undefined;
  }
}
