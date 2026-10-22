// Survival Mode's warmth (UESP "Skyrim:Cold", "Warmth"): what armor, clothing and a torch keep
// out the cold. A piece's warmth is that of the body part it covers, as Update.esm's keywords
// make it warm (Survival_ArmorWarm) or cold (Survival_ArmorCold), else normal; a piece with
// Survival_BodyAndHead (a hooded robe) is warm or cold for both its body and its hood. Shields,
// jewelry and circlets keep none. The actor's rating (Actor.GetWarmthRating, the condition
// GetActorWarmth) is what it wears, the torch in its hand (Light.GetWarmthRating: a carried
// light) and its Fortify Warmth effects (Peak Value Modifiers on actor value 76, Variable09 in the
// SSE list: the racial abilities, the hot soups). Survival_NeedCold clamps it to
// Survival_ColdResistMaxValue (206). TODO(M13): the values are UESP's (the executable's own
// settings are not in the plugins). Platform-independent.

import { BipedSlot, slotBit as bit } from '../world/actor-records.ts';

/** A body part's warmth by how warm the piece is. */
export interface SlotWarmth {
  readonly cold: number;
  readonly normal: number;
  readonly warm: number;
}

/** UESP "Skyrim:Cold" (Warmth): head, body, hands, feet. */
export const SLOT_WARMTH: Readonly<Record<'head' | 'body' | 'hands' | 'feet', SlotWarmth>> = {
  head: { cold: 8, normal: 18, warm: 29 },
  body: { cold: 17, normal: 27, warm: 54 },
  hands: { cold: 7, normal: 13, warm: 24 },
  feet: { cold: 7, normal: 13, warm: 24 },
};

/** A torch in the hand (UESP: "+50"; the ability Survival_abWarmthTorch only shows it). */
export const TORCH_WARMTH = 50;

/** The actor value Fortify Warmth effects raise (Survival_FortifyWarmthConstant: index 76). */
export const WARMTH_BONUS_VALUE = 76;

/** Update.esm's keywords (KYWD object ids in Update.esm). */
export const WarmthKeywordId = {
  armorCold: 0x2ed8,
  armorWarm: 0x2ed9,
  bodyAndHead: 0x2edb,
} as const;

/** The keywords' form ids in the load order (undefined: Update.esm missing). */
export interface WarmthKeywords {
  readonly warm: number | undefined;
  readonly cold: number | undefined;
  readonly bodyAndHead: number | undefined;
}

/**
 * A piece's warmth: the body part it covers (the body before the head, then the hands, then the
 * feet) by its keywords; none for what covers none of them.
 */
export function armorWarmth(
  slots: number,
  keywords: readonly number[],
  ids: WarmthKeywords,
): number {
  const has = (keyword: number | undefined): boolean =>
    keyword !== undefined && keywords.includes(keyword);
  const kind: keyof SlotWarmth = has(ids.warm) ? 'warm' : has(ids.cold) ? 'cold' : 'normal';
  if (slots & bit(BipedSlot.body)) {
    const body = SLOT_WARMTH.body[kind];
    return has(ids.bodyAndHead) ? body + SLOT_WARMTH.head[kind] : body;
  }
  if (slots & (bit(BipedSlot.head) | bit(BipedSlot.hair))) return SLOT_WARMTH.head[kind];
  if (slots & bit(BipedSlot.hands)) return SLOT_WARMTH.hands[kind];
  if (slots & bit(BipedSlot.feet)) return SLOT_WARMTH.feet[kind];
  return 0;
}

/** A light's warmth: a light the player can carry (a torch) warms, others do not. */
export function lightWarmth(carried: boolean): number {
  return carried ? TORCH_WARMTH : 0;
}
