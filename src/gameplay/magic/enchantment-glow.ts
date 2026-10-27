// The glow of an enchanted item (docs/rendering.md, "Effect shaders on references"): its
// enchantment's (EITM's ENCH) deciding effect's Enchant Shader (MGEF DATA, an EFSH) and Enchant
// Art (an ARTO), shown on the item while it is equipped and while it lies in the world. The
// deciding effect is the costliest, as for a spell's school, projectile and art
// (costliestEffectIndex). TODO(M13): whether the engine takes the costliest effect's shader or
// the first effect's that has one (no vanilla enchantment tells them apart: the effects of one
// enchantment share their shader).
// Platform-independent.

import type { MagicEffectRecord } from '../../world/magic-effects.ts';
import { parseMagicEffect } from '../../world/magic-effects.ts';
import type { MagicItemRecord } from '../../world/magic-records.ts';
import { parseMagicItem } from '../../world/magic-records.ts';
import type { GameRecord } from '../../world/record-db.ts';
import { costliestEffectIndex } from './casting.ts';

/** What an enchanted item shows: an effect shader and an art object (either may be missing). */
export interface EnchantmentGlow {
  readonly enchantment: number;
  readonly shader: number | undefined;
  readonly art: number | undefined;
}

/** An enchantment's glow from its deciding effect; undefined when it shows nothing. */
export function enchantmentGlow(
  enchantment: Pick<MagicItemRecord, 'formId' | 'castType' | 'effects'>,
  effect: (formId: number) => MagicEffectRecord | undefined,
): EnchantmentGlow | undefined {
  const index = costliestEffectIndex(enchantment, (formId) => effect(formId)?.baseCost);
  const deciding = index < 0 ? undefined : enchantment.effects[index];
  const record = deciding && effect(deciding.effect);
  if (!record) return undefined;
  if (record.enchantShader === undefined && record.enchantArt === undefined) return undefined;
  return { enchantment: enchantment.formId, shader: record.enchantShader, art: record.enchantArt };
}

/** The glow of an item (a WEAP or ARMO, by its form id), read through `get`. */
export async function itemGlow(
  get: (formId: number) => Promise<GameRecord | undefined>,
  item: number,
): Promise<EnchantmentGlow | undefined> {
  const record = await get(item);
  if (record?.type !== 'WEAP' && record?.type !== 'ARMO') return undefined;
  const enchantmentId = record.formIdField('EITM');
  const enchantmentRecord = enchantmentId === undefined ? undefined : await get(enchantmentId);
  const enchantment = enchantmentRecord && parseMagicItem(enchantmentRecord);
  if (enchantment?.type !== 'ENCH') return undefined;
  const effects = new Map<number, MagicEffectRecord>();
  for (const entry of enchantment.effects) {
    if (effects.has(entry.effect)) continue;
    const effectRecord = await get(entry.effect);
    if (effectRecord?.type === 'MGEF') effects.set(entry.effect, parseMagicEffect(effectRecord));
  }
  return enchantmentGlow(enchantment, (formId) => effects.get(formId));
}
