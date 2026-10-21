// The perk system answers the hooks other engines ask perks through: the equip system's
// (EquipmentModifiers: Mod Armor Rating, Mod Attack Damage, Mod Armor Weight) and crafting's
// (CraftingPerks: Mod Tempering Health, Mod Enchantment Power, Mod Soul Gem Enchanting /
// Recharge, # Of Applied Enchantments Allowed, Mod Alchemy Effectiveness, Purify Alchemy
// Ingredients, Mod Potions Created, Mod Initial Ingredient Effects Learned). The skill boost
// perks (PerkSkillBoosts, AlchemySkillBoosts: the player's) carry Fortify <skill> into these
// entry points, so the engines leave out their own Fortify factors. Platform-independent.

import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import type { CraftingPerks } from './crafting-engine.ts';
import type { EquipmentModifiers } from './equipment-engine.ts';
import type { ScriptRuntime } from './runtime.ts';

export function installPerkHooks(runtime: ScriptRuntime): void {
  const perks = runtime.perks;
  const previous = runtime.equipment.modifiers;
  const modifiers: EquipmentModifiers = {
    temperLevel: (actor, item) => previous.temperLevel(actor, item),
    skillBoostsInPerks: true,
    armorPerks: (actor, armor) => perks.apply(EntryPoint.modArmorRating, actor, 1, [armor.formId]),
    weaponPerks: (actor, weapon, target) =>
      perks.apply(EntryPoint.modAttackDamage, actor, 1, [weapon.formId, target]),
    wornWeight: (actor, item) =>
      perks.apply(EntryPoint.modArmorWeight, actor, item.weight, [item.formId]),
  };
  runtime.equipment.modifiers = modifiers;

  const crafting: CraftingPerks = {
    skillBoostsInPerks: true,
    temperingHealth: (actor, item) =>
      perks.apply(EntryPoint.modTemperingHealth, actor, 1, [item.formId], {
        temperingItem: item.formId,
      }),
    enchantmentPower: (actor, enchantment, item) =>
      perks.apply(EntryPoint.modEnchantmentPower, actor, 1, [enchantment.formId, item.formId], {
        spell: enchantment.formId,
      }),
    soulGemEnchanting: (actor, charge) =>
      perks.apply(EntryPoint.modSoulGemEnchanting, actor, charge),
    soulGemRecharge: (actor, charge) => perks.apply(EntryPoint.modSoulGemRecharge, actor, charge),
    // A result rounded to a whole count (the Creation Kit: counts are rounded as all applied).
    enchantmentsAllowed: async (actor) =>
      Math.round(await perks.apply(EntryPoint.modNumberAppliedEnchantmentsAllowed, actor, 1)),
    alchemyEffectiveness: (actor, effect, poison) =>
      perks.apply(EntryPoint.modAlchemyEffectiveness, actor, 1, [], {
        alchemyEffect: effect.formId,
        makingPoison: poison,
      }),
    purifyAlchemy: async (actor) =>
      (await perks.apply(EntryPoint.purifyAlchemyIngredients, actor, 0)) !== 0,
    potionsCreated: async (actor, potion) =>
      Math.round(await perks.apply(EntryPoint.modPotionsCreated, actor, 1, [potion])),
    ingredientEffectsLearned: async (actor, ingredient) =>
      Math.round(
        await perks.apply(EntryPoint.modInitialIngredientEffectsLearned, actor, 1, [ingredient]),
      ),
  };
  runtime.crafting.perks = crafting;
}
