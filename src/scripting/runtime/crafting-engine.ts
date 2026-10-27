// Crafting in the running game (the workbenches' menus call it: src/shell/crafting-menu.ts; the
// formulas: src/gameplay/crafting.ts): items improved at the smithing benches keep their quality
// on themselves (GameState.itemStacks: the game's ExtraHealth on an inventory entry's extra data
// list, with its count; moved with the item, worn by its wearer), enchanting makes an enchantment
// and an enchanted copy of the item (forms the game made: GameState.createdForms), disenchanting
// learns an item's base enchantment, a soul gem recharges a weapon (its charge: spent by its
// hits and a staff's casts, kept on the item itself as the game's ExtraCharge), and alchemy makes a potion or poison (a created form too, made again it is the same
// one) and learns the ingredients' effects. Each craft gives its skill its use and counts in
// the player's stats. Perks change crafting through hooks (CraftingPerks: the perk entry
// points; the perk system fills them), Fortify Smithing and Alchemy through them too (the skill
// boost perks; without the perk system, through their actor values), Fortify Enchanting
// through its actor values. Platform-independent. Notes: docs/gameplay.md ("Crafting").

import {
  alchemyPower,
  alchemySkillUse,
  apparelEnchantmentMagnitude,
  brewPotion,
  chargePercent,
  craftingSettings,
  disenchantSkillUse,
  enchantedItemName,
  ENCHANTING_SKILL_USE,
  enchantingCostSettings,
  enchantmentsAllowed,
  enchantmentUses,
  failedAlchemySkillUse,
  potionName,
  rechargedCharge,
  rechargeSkillUse,
  scaledValueOf,
  SOUL_CAPACITY,
  temperHealth,
  temperingEffectiveSkill,
  temperingQualityLevel,
  temperingSkillUse,
  temperLevelOfHealth,
  weaponChargePerUse,
  weaponEffectAt,
  weaponEnchantmentMaxMagnitude,
  enchantEffect,
  ALCHEMY_SETTINGS,
  type AlchemySettings,
  type BrewedPotion,
  type CraftingSettings,
  type EnchantingCostSettings,
  type EnchantingInputs,
} from '../../gameplay/crafting.ts';
import { actorValueIndex } from '../../world/actor-values.ts';
import {
  copyField,
  copyFields,
  createdField,
  effectConditionFields,
  effectFields,
  sameCreatedForm,
  type CreatedEffect,
  type CreatedField,
  type CreatedForm,
} from '../../world/created-forms.ts';
import { DefaultObjects } from '../../world/default-objects.ts';
import { PotionFlag, WeaponType, type ItemRecord } from '../../world/item-records.ts';
import type { MagicEffectRecord } from '../../world/magic-effects.ts';
import {
  Delivery,
  EnchantmentFlag,
  EnchantType,
  type MagicItemRecord,
} from '../../world/magic-records.ts';
import { CastType } from '../../world/spell-records.ts';
import { PLAYER_REF } from './forms.ts';
import type { ItemStack } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const SMITHING = actorValueIndex('Smithing') ?? 10;
const ALCHEMY = actorValueIndex('Alchemy') ?? 16;
const ENCHANTING = actorValueIndex('Enchanting') ?? 23;
/** Fortify Smithing / Enchanting / Alchemy: worn enchantments (Mod) and potions (PowerMod), percent. */
const FORTIFY = {
  smithing: [actorValueIndex('SmithingMod'), actorValueIndex('SmithingPowerMod')],
  enchanting: [actorValueIndex('EnchantingMod'), actorValueIndex('EnchantingPowerMod')],
  alchemy: [actorValueIndex('AlchemyMod'), actorValueIndex('AlchemyPowerMod')],
} as const;

/** Default objects: the made potion's and poison's templates, a soul gem kept when used. */
const DEFAULT_POTION = 'BAPO';
const DEFAULT_POISON = 'BAPS';
const REUSABLE_SOUL_GEM = 'RUSG';
/** MagicDisallowEnchanting: items that cannot be enchanted or disenchanted. */
const DISALLOW_ENCHANTING = 'DIEN';

/**
 * How perks change crafting: the perk entry points, filled by the perk system (perk-hooks.ts;
 * each default changes nothing).
 */
export interface CraftingPerks {
  /**
   * Fortify Smithing and Fortify Alchemy (the skills' Mod and PowerMod actor values) reach
   * smithing and alchemy through `temperingHealth` and `alchemyEffectiveness` (the skill boost
   * perks' Multiply 1 + Actor Value Mult entries), not as factors of their own.
   */
  readonly skillBoostsInPerks?: boolean;
  /**
   * Perk entry point Mod Tempering Health (the material perks, Steel Smithing .. Dragon Armor,
   * double the improvement): the factor of the skill's share (1: none).
   */
  temperingHealth(actor: number, item: ItemRecord): Promise<number>;
  /**
   * Perk entry point Mod Enchantment Power (Enchanter, Fire / Frost / Storm, Insightful and
   * Corpus Enchanter; Seeker of Sorcery): the power's factor for an enchantment put on an item
   * (1: none).
   */
  enchantmentPower(actor: number, enchantment: MagicItemRecord, item: ItemRecord): Promise<number>;
  /** Perk entry point Mod Soul Gem Enchanting: a soul's charge as enchanting reads it. */
  soulGemEnchanting(actor: number, charge: number): Promise<number>;
  /** Perk entry point Mod Soul Gem Recharge (Soul Squeezer): a soul's charge recharging. */
  soulGemRecharge(actor: number, charge: number): Promise<number>;
  /** Perk entry point # Of Applied Enchantments Allowed (Extra Effect: 2). */
  enchantmentsAllowed(actor: number): Promise<number>;
  /**
   * Perk entry point Mod Alchemy Effectiveness (Alchemist, Physician, Benefactor, Poisoner;
   * Seeker of Shadows): the power's factor for an effect of a potion or a poison (1: none).
   */
  alchemyEffectiveness(actor: number, effect: MagicEffectRecord, poison: boolean): Promise<number>;
  /** Perk entry point Purify Alchemy Ingredients (Purity). */
  purifyAlchemy(actor: number): Promise<boolean>;
  /** Perk entry point Mod Potions Created: how many a brew makes (1). */
  potionsCreated(actor: number, potion?: number): Promise<number>;
  /**
   * Perk entry point Mod Initial Ingredient Effects Learned (Experimenter): the effects eating
   * an ingredient finds out (1: its first).
   */
  ingredientEffectsLearned(actor: number, ingredient?: number): Promise<number>;
}

const NO_PERKS: CraftingPerks = {
  temperingHealth: () => Promise.resolve(1),
  enchantmentPower: () => Promise.resolve(1),
  soulGemEnchanting: (_actor, charge) => Promise.resolve(charge),
  soulGemRecharge: (_actor, charge) => Promise.resolve(charge),
  enchantmentsAllowed: () => Promise.resolve(enchantmentsAllowed(false)),
  alchemyEffectiveness: () => Promise.resolve(1),
  purifyAlchemy: () => Promise.resolve(false),
  potionsCreated: () => Promise.resolve(1),
  ingredientEffectsLearned: () => Promise.resolve(1),
};

/** An item of a container as the menus list it: its plain ones, or one of its stacks. */
export interface ItemInstance {
  /** The stack (an index into the base's stacks); undefined: the plain ones. */
  readonly stack: number | undefined;
  readonly count: number;
  /** ExtraHealth (1: plain). */
  readonly health: number;
  /** ExtraCharge: the charge left (undefined: full). */
  readonly charge?: number;
}

/**
 * Which of an actor's items of a base: the one it wields ('worn': the stack marked, else a
 * plain one), or a menu's row (a stack, undefined: the plain ones).
 */
export type ItemChoice = 'worn' | { readonly stack: number | undefined };

/** A weapon's charge now: what is left, its full charge, and what a hit uses. */
export interface ItemCharge {
  readonly current: number;
  readonly max: number;
  readonly cost: number;
}

/** A filled soul gem a container has. */
export interface SoulGemInfo {
  readonly formId: number;
  readonly name: string;
  readonly count: number;
  /** 1 Petty .. 5 Grand. */
  readonly soul: number;
  /** Its soul's charge (SOUL_CAPACITY). */
  readonly charge: number;
}

/** An enchantment chosen for an item: a learned (base) enchantment, at a slider's value. */
export interface ChosenEnchantment {
  readonly formId: number;
  /** A weapon enchantment's slider value (its first effect's magnitude or duration); none: the largest. */
  readonly value?: number;
}

/** What an enchantment would make: its effects, and for a weapon its slider and charges. */
export interface EnchantmentPlan {
  readonly weapon: boolean;
  /** The created enchantment's effects. */
  readonly effects: readonly CreatedEffect[];
  /** Weapon: the slider's range and value (the first enchantment's first effect). */
  readonly maxValue: number;
  readonly value: number;
  /** Weapon: the full charge (the soul's), a hit's charge and the hits it gives. */
  readonly charge: number;
  readonly chargePerUse: number;
  readonly uses: number;
  /** The enchantment's cost (ENIT): a weapon's charge per hit; apparel's effects' cost. */
  readonly cost: number;
}

export type TemperResult =
  | { readonly kind: 'improved'; readonly level: number; readonly previous: number }
  | { readonly kind: 'skill' };

export type DisenchantResult =
  | { readonly kind: 'learned'; readonly enchantment: number; readonly name: string }
  | { readonly kind: 'known' }
  | { readonly kind: 'none' };

export interface BrewResult {
  /** The potion or poison made (a created ALCH); undefined: they share no effect. */
  readonly made: number | undefined;
  readonly potion: BrewedPotion | undefined;
  readonly count: number;
}

export class CraftingEngine {
  readonly #runtime: ScriptRuntime;
  /** How perks change crafting (the perk system sets them; none until then). */
  perks: CraftingPerks = NO_PERKS;
  #settings:
    | Promise<{
        crafting: CraftingSettings;
        cost: EnchantingCostSettings;
        alchemy: AlchemySettings;
        of: string;
        potionPrefix: string;
        poisonPrefix: string;
      }>
    | undefined;
  #defaults: Promise<DefaultObjects> | undefined;
  /** The first plugin potion (or poison) of each first effect: a made one looks like it. */
  #potionLooks: Promise<Map<string, number>> | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  async settings(): Promise<{
    crafting: CraftingSettings;
    cost: EnchantingCostSettings;
    alchemy: AlchemySettings;
    of: string;
    potionPrefix: string;
    poisonPrefix: string;
  }> {
    this.#settings ??= (async () => {
      const runtime = this.#runtime;
      const names = [
        'fConstructibleSkillUseMult',
        'fConstructibleSkilluseExp',
        'fConstructibleSkillUseConst',
        'fTemperingSkillUseMult',
        'fTemperingSkillUseItemValMult',
        'fTemperingSkillUseItemValExp',
        'fTemperingSkillUseItemValConst',
        'fDisenchantSkillUse',
        'fSkillUsageRechargeMult',
        'fWortFailSkillUseMagnitude',
        'fEnchantingCostExponent',
        'fEnchantingSkillCostBase',
        'fEnchantingSkillCostMult',
        'fEnchantingSkillCostScale',
        'fAlchemyIngredientInitMult',
        'fAlchemySkillFactor',
      ];
      const numbers = new Map<string, number>();
      for (const name of names) {
        const value = await runtime.gameSetting(name);
        if (typeof value === 'number') numbers.set(name, value);
      }
      const number = (name: string): number | undefined => numbers.get(name);
      const text = async (name: string, fallback: string): Promise<string> => {
        const value = await runtime.gameSetting(name);
        return typeof value === 'string' ? value : fallback;
      };
      return {
        crafting: craftingSettings(number),
        cost: enchantingCostSettings(number),
        alchemy: {
          ingredientInitMult:
            number('fAlchemyIngredientInitMult') ?? ALCHEMY_SETTINGS.ingredientInitMult,
          skillFactor: number('fAlchemySkillFactor') ?? ALCHEMY_SETTINGS.skillFactor,
        },
        of: await text('sOf', ' of '),
        potionPrefix: await text('sCreatedPotionNamePrefix', 'Potion of '),
        poisonPrefix: await text('sCreatedPoisonNamePrefix', 'Poison of '),
      };
    })();
    return this.#settings;
  }

  #defaultObjects(): Promise<DefaultObjects> {
    this.#defaults ??= DefaultObjects.read(this.#runtime.forms.db);
    return this.#defaults;
  }

  // --- Items with data of their own -----------------------------------------------------------

  #count(container: number, base: number): number {
    return this.#runtime.state.inventories.get(container)?.get(base) ?? 0;
  }

  #list(container: number, base: number, create = false): ItemStack[] | undefined {
    const stacks = this.#runtime.state.itemStacks;
    let byBase = stacks.get(container);
    if (!byBase) {
      if (!create) return undefined;
      byBase = new Map();
      stacks.set(container, byBase);
    }
    let list = byBase.get(base);
    if (!list && create) {
      list = [];
      byBase.set(base, list);
    }
    return list;
  }

  #prune(container: number, base: number): void {
    const byBase = this.#runtime.state.itemStacks.get(container);
    const list = byBase?.get(base);
    if (!byBase || !list) return;
    for (let i = list.length - 1; i >= 0; i--) if ((list[i]?.count ?? 0) <= 0) list.splice(i, 1);
    if (list.length === 0) byBase.delete(base);
    if (byBase.size === 0) this.#runtime.state.itemStacks.delete(container);
  }

  /**
   * A container's stacks of a base (improved items), never more than it has: items taken
   * without the engine knowing which (a script's count set) leave from the least improved.
   */
  stacks(container: number, base: number): readonly ItemStack[] {
    const list = this.#list(container, base);
    if (!list) return [];
    let excess = list.reduce((sum, stack) => sum + stack.count, 0) - this.#count(container, base);
    if (excess > 0) {
      for (const stack of [...list].sort((a, b) => a.health - b.health)) {
        const taken = Math.min(stack.count, excess);
        stack.count -= taken;
        excess -= taken;
        if (excess <= 0) break;
      }
      this.#prune(container, base);
    }
    return this.#list(container, base) ?? [];
  }

  /** A container's plain items of a base (those without data of their own). */
  plainCount(container: number, base: number): number {
    const stacked = this.stacks(container, base).reduce((sum, stack) => sum + stack.count, 0);
    return Math.max(0, this.#count(container, base) - stacked);
  }

  /** A base's items as the menus list them: the plain ones, then each stack. */
  instances(container: number, base: number): ItemInstance[] {
    const instances: ItemInstance[] = [];
    const plain = this.plainCount(container, base);
    if (plain > 0) instances.push({ stack: undefined, count: plain, health: 1 });
    this.stacks(container, base).forEach((stack, i) => {
      if (stack.count > 0) {
        instances.push({
          stack: i,
          count: stack.count,
          health: stack.health,
          ...(stack.charge !== undefined && { charge: stack.charge }),
        });
      }
    });
    return instances;
  }

  /**
   * Items of a container get data of their own (they are counted in its inventory already): a
   * health (improved) and the charge left (used); those alike in both stack.
   */
  addStack(
    container: number,
    base: number,
    health: number,
    count = 1,
    worn = false,
    charge?: number,
  ): void {
    if (count <= 0 || (health === 1 && charge === undefined)) return;
    const list = this.#list(container, base, true) ?? [];
    const same = list.find((stack) => stack.health === health && stack.charge === charge);
    if (same) {
      same.count += count;
      if (worn) same.worn = true;
    } else {
      list.push({
        count,
        health,
        ...(charge !== undefined && { charge }),
        ...(worn && { worn }),
      });
      list.sort((a, b) => b.health - a.health);
    }
  }

  /**
   * Items left a container (ScriptRuntime.removeItem; `had` of the base before): the stack
   * asked for first (a menu's row), then the plain ones, then the least improved; the stacks
   * that leave join `to`'s.
   */
  itemsMoved(
    from: number,
    to: number | undefined,
    base: number,
    moved: number,
    had: number,
    stack?: number,
  ): void {
    const list = this.#list(from, base);
    if (!list || moved <= 0) return;
    const stacked = list.reduce((sum, entry) => sum + entry.count, 0);
    let left = moved;
    const take = (entry: ItemStack, count: number): void => {
      if (count <= 0) return;
      entry.count -= count;
      left -= count;
      if (to !== undefined) this.addStack(to, base, entry.health, count, false, entry.charge);
    };
    const chosen = stack === undefined ? undefined : list[stack];
    if (chosen) take(chosen, Math.min(chosen.count, left));
    left -= Math.min(left, Math.max(0, had - stacked));
    for (const entry of [...list].sort((a, b) => a.health - b.health)) {
      if (left <= 0) break;
      take(entry, Math.min(entry.count, left));
    }
    this.#prune(from, base);
  }

  /** A container's items are gone (its inventory reset). */
  clear(container: number): void {
    this.#runtime.state.itemStacks.delete(container);
  }

  /**
   * The stack of a base an actor wears or wields (the one marked, else, without plain ones,
   * the most improved); undefined: a plain one.
   */
  wornStack(actor: number, base: number): ItemStack | undefined {
    const list = this.stacks(actor, base);
    const marked = list.find((stack) => stack.worn === true);
    if (marked) return marked;
    return this.plainCount(actor, base) > 0 ? undefined : list[0];
  }

  /** Which of a base's instances an actor wears (a stack, or undefined: a plain one). */
  wear(actor: number, base: number, stack: number | undefined): void {
    const list = this.stacks(actor, base);
    list.forEach((entry, i) => {
      if (i === stack) entry.worn = true;
      else delete entry.worn;
    });
  }

  /** Whether an instance of a base is the one the actor wears (if it wears the base). */
  isWornInstance(actor: number, base: number, stack: number | undefined): boolean {
    const worn = this.wornStack(actor, base);
    const list = this.stacks(actor, base);
    return stack === undefined ? worn === undefined : list[stack] === worn;
  }

  /** How far the instance of a base an actor wears is improved (0 none .. 6 Legendary). */
  temperLevel(actor: number, base: number): number {
    return temperLevelOfHealth(this.wornStack(actor, base)?.health ?? 1);
  }

  // --- Forms the game makes ---------------------------------------------------------------------

  /**
   * A form made (its form id): a potion or an enchantment made as one before is that one
   * (the game's created objects are shared: the potions stack).
   */
  create(form: CreatedForm): number {
    const state = this.#runtime.state;
    if (form.type === 'ALCH' || form.type === 'ENCH') {
      for (const [formId, made] of state.createdForms)
        if (sameCreatedForm(made, form)) return formId;
    }
    return state.createForm(form);
  }

  // --- Charge ---------------------------------------------------------------------------------

  /** The stack of an actor's items of a base `which` names (undefined: a plain one). */
  #chosen(actor: number, base: number, which: ItemChoice): ItemStack | undefined {
    if (which === 'worn') return this.wornStack(actor, base);
    return which.stack === undefined ? undefined : this.stacks(actor, base)[which.stack];
  }

  /**
   * The charge left on one of an actor's items of a base (ExtraCharge: undefined, full), kept on
   * that item: the one it wields, or a menu's row.
   */
  keptCharge(actor: number, base: number, which: ItemChoice = 'worn'): number | undefined {
    return this.#chosen(actor, base, which)?.charge;
  }

  /**
   * Sets the charge left on one of an actor's items of a base (`max` or more: full again). An
   * item of a stack gets a stack of its own (health kept, still the one wielded if it was).
   * TODO(M13): two of a base in both hands share the one marked wielded (the game's
   * ExtraWornLeft).
   */
  setCharge(
    actor: number,
    base: number,
    charge: number,
    max: number,
    which: ItemChoice = 'worn',
  ): void {
    if (this.#count(actor, base) <= 0) return;
    const value = charge >= max - 1e-6 ? undefined : Math.max(0, charge);
    const from = this.#chosen(actor, base, which);
    if (from?.charge === value) return;
    if (from && from.count <= 1) {
      // Its own stack already: it keeps its health, its charge changes.
      if (value === undefined) delete from.charge;
      else from.charge = value;
      if (from.health === 1 && from.charge === undefined) {
        from.count = 0;
        this.#prune(actor, base);
      }
      return;
    }
    if (which !== 'worn' && which.stack === undefined && this.plainCount(actor, base) <= 0) return;
    const worn =
      which === 'worn' ||
      from?.worn === true ||
      (from === undefined && this.isWornInstance(actor, base, undefined));
    if (from) {
      from.count--;
      if (worn) delete from.worn;
    }
    this.addStack(actor, base, from?.health ?? 1, 1, worn, value);
    this.#prune(actor, base);
  }

  /**
   * An enchanted weapon's or a staff's charge (of the item `which` names: the one wielded, or a
   * menu's row), or undefined: what is left, its full charge (WEAP EAMT, else its
   * enchantment's), what a use costs.
   */
  async charge(
    actor: number,
    weapon: number,
    which: ItemChoice = 'worn',
  ): Promise<ItemCharge | undefined> {
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(weapon);
    if (!item?.weapon || item.enchantment === undefined) return undefined;
    const enchantment = await runtime.magic.item(item.enchantment);
    if (enchantment?.kind !== 'enchantment' || enchantment.castType === CastType.constantEffect)
      return undefined;
    const max = item.charge > 0 ? item.charge : (enchantment.enchantment?.amount ?? 0);
    const kept = this.keptCharge(actor, weapon, which);
    return { current: Math.min(max, kept ?? max), max, cost: Math.max(0, enchantment.cost) };
  }

  /**
   * A hit of an enchanted weapon uses its enchantment's cost (ENIT) of its charge; false when
   * too little is left (its enchantment does nothing). NPCs' weapons never run out (UESP
   * "Skyrim:Enchanting").
   */
  async useCharge(actor: number, weapon: number): Promise<boolean> {
    const charge = await this.charge(actor, weapon);
    if (!charge || actor !== PLAYER_REF || charge.max <= 0 || charge.cost <= 0) return true;
    if (charge.current + 1e-6 < charge.cost) return false;
    this.setCharge(actor, weapon, charge.current - charge.cost, charge.max);
    return true;
  }

  /** A weapon's charge as its item card's meter shows it (percent), or undefined. */
  async chargePercent(
    actor: number,
    weapon: number,
    which: ItemChoice = 'worn',
  ): Promise<number | undefined> {
    const charge = await this.charge(actor, weapon, which);
    return charge && charge.max > 0 ? chargePercent(charge.current, charge.max) : undefined;
  }

  /**
   * Partial souls (the game's ExtraSoul on an empty gem's inventory entry): a soul smaller than
   * the gem can hold stays in the empty gem (a grand gem with a petty soul), not its filled form.
   */
  addSoul(container: number, gem: number, soul: number): void {
    const list = this.#list(container, gem, true) ?? [];
    const stack = list.find((entry) => entry.soul === soul && !entry.worn);
    if (stack) stack.count++;
    else list.push({ count: 1, health: 1, soul });
  }

  /** The greatest partial soul in a container's empty gems of a base (0: none). */
  partialSoul(container: number, gem: number): number {
    let best = 0;
    for (const stack of this.stacks(container, gem))
      if (stack.count > 0) best = Math.max(best, stack.soul ?? 0);
    return best;
  }

  /** How many of a container's gems of a base hold a partial soul. */
  partialSouls(container: number, gem: number): number {
    return this.stacks(container, gem).reduce(
      (sum, stack) => sum + ((stack.soul ?? 0) > 0 ? stack.count : 0),
      0,
    );
  }

  /** A gem's soul as used (its own, else its greatest partial one), and whether it is partial. */
  async #gemSoul(container: number, gem: number): Promise<{ soul: number; partial: boolean }> {
    const item = await this.#runtime.equipment.item(gem);
    const own = item?.type === 'SLGM' ? (item.soul?.current ?? 0) : 0;
    if (own > 0 || item?.type !== 'SLGM') return { soul: own, partial: false };
    return { soul: this.partialSoul(container, gem), partial: true };
  }

  /** The filled soul gems a container has, the smallest first. */
  async soulGems(container: number): Promise<SoulGemInfo[]> {
    const runtime = this.#runtime;
    const gems: SoulGemInfo[] = [];
    for (const [formId, count] of await runtime.inventory(container)) {
      if (count <= 0) continue;
      const item = await runtime.equipment.item(formId);
      const soul = item?.type === 'SLGM' ? (item.soul?.current ?? 0) : 0;
      if (item?.type === 'SLGM' && soul <= 0) {
        // Empty gems holding partial souls: their greatest. TODO(M13): each partial soul
        // level of a base listed as an entry of its own, as the game's menus list them.
        const partial = this.partialSoul(container, formId);
        const holding = this.stacks(container, formId).reduce(
          (sum, stack) => sum + (stack.soul === partial ? stack.count : 0),
          0,
        );
        if (partial > 0)
          gems.push({
            formId,
            name: item.name,
            count: holding,
            soul: partial,
            charge: SOUL_CAPACITY[partial] ?? 0,
          });
        continue;
      }
      if (!item || soul <= 0) continue;
      gems.push({ formId, name: item.name, count, soul, charge: SOUL_CAPACITY[soul] ?? 0 });
    }
    return gems.sort((a, b) => a.soul - b.soul || a.formId - b.formId);
  }

  /** What a soul gem's soul adds to a weapon's charge recharging it (percent of its full). */
  async rechargePercent(
    actor: number,
    gem: SoulGemInfo,
    weapon: number,
    which: ItemChoice = 'worn',
  ): Promise<number> {
    const charge = await this.charge(actor, weapon, which);
    if (!charge || charge.max <= 0) return 0;
    const added = await this.perks.soulGemRecharge(actor, gem.charge);
    return (
      chargePercent(rechargedCharge(charge.current, added, charge.max), charge.max) -
      chargePercent(charge.current, charge.max)
    );
  }

  /**
   * Recharges a weapon with a soul gem (the inventory's Charge): the soul's charge is added up
   * to its full, the gem used up; Enchanting's use (fSkillUsageRechargeMult a point of
   * charge). False if it needs none or there is no such gem.
   */
  async recharge(
    actor: number,
    weapon: number,
    gem: number,
    which: ItemChoice = 'worn',
  ): Promise<boolean> {
    const runtime = this.#runtime;
    const charge = await this.charge(actor, weapon, which);
    if (!charge || charge.current >= charge.max) return false;
    const { soul } = await this.#gemSoul(actor, gem);
    if (soul <= 0 || (await runtime.itemCount(actor, gem)) <= 0) return false;
    const added = await this.perks.soulGemRecharge(actor, SOUL_CAPACITY[soul] ?? 0);
    this.setCharge(
      actor,
      weapon,
      rechargedCharge(charge.current, added, charge.max),
      charge.max,
      which,
    );
    await this.#useSoulGem(actor, gem);
    const { crafting } = await this.settings();
    await runtime.progression.useSkill(actor, ENCHANTING, rechargeSkillUse(added, crafting));
    return true;
  }

  /** A soul gem used up: it goes (a reusable one, Azura's Star, is kept empty: SLGM NAM0). */
  async #useSoulGem(actor: number, gem: number): Promise<void> {
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(gem);
    const reusable = (await this.#defaultObjects()).get(REUSABLE_SOUL_GEM);
    const { soul, partial } = await this.#gemSoul(actor, gem);
    if (partial) {
      // An empty gem's partial soul is used: the soul goes, the gem with it unless reusable.
      const stack = this.stacks(actor, gem).find((entry) => entry.soul === soul && entry.count > 0);
      if (stack) stack.count--;
      this.#prune(actor, gem);
      if (reusable === undefined || !item?.keywords.includes(reusable))
        await runtime.removeItem(actor, runtime.formHandle(gem), 1, true, undefined);
      this.#stat('soul gems used');
      return;
    }
    await runtime.removeItem(actor, runtime.formHandle(gem), 1, true, undefined);
    const record = await runtime.forms.record(gem);
    const empty = record?.formIdField('NAM0');
    if (reusable !== undefined && item?.keywords.includes(reusable) && empty)
      await runtime.addItem(actor, runtime.formHandle(empty), 1, true);
    this.#stat('soul gems used');
  }

  #stat(name: string, by = 1): void {
    this.#runtime.incrementStat(name, by);
  }

  /** A skill and Fortify <skill> (worn enchantments' and potions' percent) of an actor. */
  async #skill(
    actor: number,
    skill: number,
    fortify: readonly (number | undefined)[],
  ): Promise<{ skill: number; enchantments: number; potion: number }> {
    const runtime = this.#runtime;
    const value = async (index: number | undefined): Promise<number> =>
      index === undefined ? 0 : (await runtime.actors.value(actor, index)).current;
    // Smithing's and alchemy's come through the perks' entry points (CraftingPerks).
    if (this.perks.skillBoostsInPerks === true && skill !== ENCHANTING)
      return { skill: await value(skill), enchantments: 0, potion: 0 };
    return {
      skill: await value(skill),
      enchantments: (await value(fortify[0])) / 100,
      potion: (await value(fortify[1])) / 100,
    };
  }

  // --- Smithing -------------------------------------------------------------------------------

  /**
   * The quality an actor improves an item to (UESP "Skyrim:Smithing": its Smithing, the
   * material perk, Fortify Smithing).
   */
  async temperQuality(actor: number, item: ItemRecord): Promise<number> {
    const { skill, enchantments, potion } = await this.#skill(actor, SMITHING, FORTIFY.smithing);
    const perk = await this.perks.temperingHealth(actor, item);
    return temperingQualityLevel(temperingEffectiveSkill({ skill, perk, enchantments, potion }));
  }

  /**
   * Improves an instance of an actor's item (a stack, or a plain one) as far as its skill
   * reaches: it gets the quality's health (ExtraHealth), worn still if it was; Smithing's use
   * (fTemperingSkillUse*). The recipe's components are the caller's (the bench's menu).
   */
  async temper(actor: number, base: number, stack: number | undefined): Promise<TemperResult> {
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(base);
    if (!item) return { kind: 'skill' };
    const list = this.stacks(actor, base);
    const from = stack === undefined ? undefined : list[stack];
    const previous = temperLevelOfHealth(from?.health ?? 1);
    const level = await this.temperQuality(actor, item);
    if (level <= previous) return { kind: 'skill' };
    const equipped = await runtime.equipment.isEquipped(actor, base);
    const wasWorn = equipped && this.wornStack(actor, base) === from;
    if (from) {
      from.count--;
      this.#prune(actor, base);
    } else if (this.plainCount(actor, base) <= 0) {
      return { kind: 'skill' };
    }
    if (wasWorn) this.wear(actor, base, undefined);
    this.addStack(actor, base, temperHealth(level), 1, wasWorn, from?.charge);
    const { crafting } = await this.settings();
    await runtime.progression.useSkill(actor, SMITHING, temperingSkillUse(item.value, crafting));
    this.#stat(item.type === 'WEAP' ? 'weapons improved' : 'armor improved');
    return { kind: 'improved', level, previous };
  }

  // --- Enchanting -----------------------------------------------------------------------------

  /** The enchantment learned from an item (its base enchantment: ENIT), its record. */
  async learnedFrom(item: ItemRecord): Promise<MagicItemRecord | undefined> {
    const magic = this.#runtime.magic;
    if (item.enchantment === undefined) return undefined;
    const enchantment = await magic.item(item.enchantment);
    if (enchantment?.type !== 'ENCH') return undefined;
    const base = enchantment.enchantment?.baseEnchantment;
    return (base === undefined ? undefined : await magic.item(base)) ?? enchantment;
  }

  /**
   * Disenchants an actor's item (an instance of it): its base enchantment is learned, the item
   * destroyed; Enchanting's use (fDisenchantSkillUse a point of the enchantment's cost).
   */
  async disenchant(actor: number, base: number, stack?: number): Promise<DisenchantResult> {
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(base);
    const learned = item && (await this.learnedFrom(item));
    const enchantment =
      item?.enchantment === undefined ? undefined : await runtime.magic.item(item.enchantment);
    if (!item || !learned || !enchantment) return { kind: 'none' };
    // MagicDisallowEnchanting on the item or its enchantment: it cannot be learned.
    const disallowed = (await this.#defaultObjects()).get(DISALLOW_ENCHANTING);
    if (
      disallowed !== undefined &&
      (item.keywords.includes(disallowed) || learned.keywords.includes(disallowed))
    )
      return { kind: 'none' };
    const known = runtime.state.knownEnchantments;
    if (known.has(learned.formId)) return { kind: 'known' };
    known.add(learned.formId);
    await runtime.removeItem(actor, runtime.formHandle(base), 1, true, undefined, stack);
    const { crafting } = await this.settings();
    await runtime.progression.useSkill(
      actor,
      ENCHANTING,
      disenchantSkillUse(enchantment.cost, crafting),
    );
    return { kind: 'learned', enchantment: learned.formId, name: learned.name };
  }

  /** An enchantment fits an item: weapons' on weapons, apparel's on armor, its restrictions'. */
  async fits(enchantment: MagicItemRecord, item: ItemRecord): Promise<boolean> {
    const weapon = enchantment.castType !== CastType.constantEffect;
    if (weapon !== (item.type === 'WEAP')) return false;
    if (!weapon && item.type !== 'ARMO') return false;
    const restrictions = enchantment.enchantment?.wornRestrictions;
    if (restrictions === undefined) return true;
    const keywords = await this.#runtime.formList(restrictions);
    return keywords.length === 0 || keywords.some((keyword) => item.keywords.includes(keyword));
  }

  /** Whether an item can be enchanted at a table (unenchanted weapons but staffs, armor). */
  enchantable(item: ItemRecord, disallowed: number | undefined): boolean {
    if (item.enchantment !== undefined || item.nonPlayable || item.name === '') return false;
    if (disallowed !== undefined && item.keywords.includes(disallowed)) return false;
    if (item.type === 'ARMO') return true;
    return item.type === 'WEAP' && item.weapon?.weaponType !== WeaponType.staff;
  }

  /**
   * What enchantments would make on an item with a soul (UESP "Skyrim:Enchanting"): apparel's
   * magnitudes by the soul's share, the skill and the perks; a weapon's largest by the skill
   * and the perks, at the slider's value, its charge the soul's and a hit's cost by the
   * share of its largest and the skill.
   */
  async plan(
    actor: number,
    base: number,
    chosen: readonly ChosenEnchantment[],
    soul: number,
  ): Promise<EnchantmentPlan | undefined> {
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(base);
    if (!item || chosen.length === 0) return undefined;
    const { skill, enchantments, potion } = await this.#skill(
      actor,
      ENCHANTING,
      FORTIFY.enchanting,
    );
    const { cost: costSettings } = await this.settings();
    const weapon = item.type === 'WEAP';
    const effects: CreatedEffect[] = [];
    let maxValue = 0;
    let value = 0;
    let cost = 0;
    for (const [n, entry] of chosen.entries()) {
      const enchantment = await runtime.magic.item(entry.formId);
      const record = await runtime.forms.record(entry.formId);
      if (enchantment?.type !== 'ENCH' || !record) continue;
      const power = await this.perks.enchantmentPower(actor, enchantment, item);
      const inputs: EnchantingInputs = {
        skill,
        potion: enchantments + potion,
        enchanter: power - 1,
      };
      const conditions = effectConditionFields(record);
      const info = await Promise.all(
        enchantment.effects.map((e) => runtime.magic.effect(e.effect)),
      );
      if (weapon) {
        const first = enchantment.effects[0];
        const firstInfo = info[0];
        if (!first || !firstInfo) continue;
        const firstBase =
          scaledValueOf({ ...first, flags: firstInfo.flags }) === 'duration'
            ? first.duration
            : first.magnitude;
        const max = Math.max(1, weaponEnchantmentMaxMagnitude(firstBase, inputs));
        const at = Math.max(1, Math.min(max, Math.round(entry.value ?? max)));
        const share = at / max;
        if (n === 0) {
          maxValue = max;
          value = at;
        }
        for (const [i, effect] of enchantment.effects.entries()) {
          const flags = info[i]?.flags ?? 0;
          const strength = weaponEffectAt(
            { ...effect, flags },
            (b) => weaponEnchantmentMaxMagnitude(b, inputs),
            share,
          );
          effects.push({ ...effect, ...strength, conditions: conditions[i] ?? [] });
        }
        cost += weaponChargePerUse(enchantment.cost, at, max, skill, costSettings);
      } else {
        for (const [i, effect] of enchantment.effects.entries()) {
          const flags = info[i]?.flags ?? 0;
          const strength = enchantEffect({ ...effect, flags }, (b) =>
            apparelEnchantmentMagnitude(b, soul, inputs),
          );
          effects.push({ ...effect, ...strength, conditions: conditions[i] ?? [] });
        }
        cost += enchantment.cost;
      }
    }
    if (effects.length === 0) return undefined;
    const charge = weapon ? await this.perks.soulGemEnchanting(actor, SOUL_CAPACITY[soul] ?? 0) : 0;
    const chargePerUse = weapon ? Math.max(1, Math.round(cost)) : 0;
    return {
      weapon,
      effects,
      maxValue,
      value,
      charge,
      chargePerUse,
      uses: weapon ? enchantmentUses(charge, chargePerUse) : 0,
      cost: Math.max(0, Math.round(cost)),
    };
  }

  /**
   * Enchants an actor's item (an instance of it) with learned enchantments and a soul gem: an
   * enchantment is made (its effects as planned, the base enchantment's conditions) and the
   * item's enchanted copy (its fields, the enchantment, its charge, its name: the player's or
   * "<item> of <enchantment>", its template the plain item), which replaces the item (its
   * improvement kept); the gem is used up; Enchanting's use. The made item's form id, or
   * undefined if nothing fits.
   */
  async enchant(
    actor: number,
    base: number,
    stack: number | undefined,
    chosen: readonly ChosenEnchantment[],
    gem: number,
    name?: string,
  ): Promise<number | undefined> {
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(base);
    const record = await runtime.forms.record(base);
    const { soul } = await this.#gemSoul(actor, gem);
    if (!item || !record || soul <= 0) return undefined;
    if ((await runtime.itemCount(actor, base)) <= 0 || (await runtime.itemCount(actor, gem)) <= 0)
      return undefined;
    const allowed = await this.perks.enchantmentsAllowed(actor);
    // As many as the perks allow, each one that goes on the item.
    const used: ChosenEnchantment[] = [];
    for (const entry of chosen.slice(0, enchantmentsAllowed(allowed))) {
      const enchantment = await runtime.magic.item(entry.formId);
      if (enchantment && (await this.fits(enchantment, item))) used.push(entry);
    }
    const disallowed = (await this.#defaultObjects()).get(DISALLOW_ENCHANTING);
    const wanted = Math.min(chosen.length, enchantmentsAllowed(allowed));
    if (!this.enchantable(item, disallowed) || used.length !== wanted) return undefined;
    const plan = await this.plan(actor, base, used, soul);
    const first = used[0] && (await runtime.magic.item(used[0].formId));
    if (!plan || !first) return undefined;
    // The enchantment (ENCH ENIT: cost, flags, cast type, charge, delivery, type, charge time,
    // base enchantment, worn restrictions).
    const enit = new Uint8Array(36);
    const data = new DataView(enit.buffer);
    data.setInt32(0, plan.cost, true);
    data.setUint32(4, EnchantmentFlag.noAutoCalc, true);
    data.setUint32(8, plan.weapon ? CastType.fireAndForget : CastType.constantEffect, true);
    data.setInt32(12, plan.charge, true);
    data.setUint32(16, plan.weapon ? Delivery.touch : Delivery.self, true);
    data.setUint32(20, EnchantType.enchantment, true);
    data.setFloat32(24, first.chargeTime, true);
    data.setUint32(28, first.formId, true);
    data.setUint32(32, first.enchantment?.wornRestrictions ?? 0, true);
    const enchantment = this.create({
      type: 'ENCH',
      fields: [
        createdField.zstring('FULL', first.name),
        createdField.bytes('ENIT', enit),
        ...effectFields(plan.effects),
      ],
    });
    // The enchanted item: the plain item's fields, enchanted and named.
    const settings = await this.settings();
    const template = record.type === 'WEAP' ? 'CNAM' : 'TNAM';
    const own = new Set(['EDID', 'FULL', 'EITM', 'EAMT', template]);
    const fields: CreatedField[] = copyFields(record, (type) => !own.has(type));
    const typed = name?.trim() ?? '';
    const title = typed !== '' ? typed : enchantedItemName(item.name, first.name, settings.of);
    fields.splice(1, 0, createdField.zstring('FULL', title));
    fields.push(createdField.formId('EITM', enchantment));
    if (plan.weapon) fields.push(createdField.u16('EAMT', Math.min(0xffff, plan.charge)));
    fields.push(createdField.formId(template, record.formIdField(template) ?? base));
    const made = this.create({ type: record.type, fields });
    // It takes the item's place (an improved one stays improved).
    const health = stack === undefined ? 1 : (this.stacks(actor, base)[stack]?.health ?? 1);
    await runtime.removeItem(actor, runtime.formHandle(base), 1, true, undefined, stack);
    await runtime.addItem(actor, runtime.formHandle(made), 1, true);
    this.addStack(actor, made, health);
    await this.#useSoulGem(actor, gem);
    await runtime.progression.useSkill(actor, ENCHANTING, ENCHANTING_SKILL_USE);
    this.#stat('magic items made');
    return made;
  }

  // --- Alchemy --------------------------------------------------------------------------------

  /**
   * An ingredient eaten: the player finds out its first effect (more with the Experimenter
   * perks: CraftingPerks.ingredientEffectsLearned).
   */
  async ingredientEaten(actor: number, ingredient: number): Promise<void> {
    if (actor !== PLAYER_REF) return;
    const runtime = this.#runtime;
    const item = await runtime.equipment.item(ingredient);
    if (item?.type !== 'INGR') return;
    const count = Math.max(1, await this.perks.ingredientEffectsLearned(actor, ingredient));
    const known = new Set(runtime.state.ingredientEffects.get(ingredient) ?? []);
    for (let slot = 0; slot < Math.min(count, Math.max(1, item.effects.length)); slot++)
      known.add(slot);
    runtime.state.ingredientEffects.set(ingredient, known);
    this.#stat('ingredients eaten');
  }

  /**
   * The potion ingredients would make for an actor (UESP "Skyrim:Alchemy": the power of its
   * Alchemy, Fortify Alchemy and the perks), or undefined.
   */
  async potion(actor: number, ingredients: readonly number[]): Promise<BrewedPotion | undefined> {
    const runtime = this.#runtime;
    const items = await Promise.all(ingredients.map((formId) => runtime.equipment.item(formId)));
    const lists = items.map((item) => (item?.type === 'INGR' ? item.effects : []));
    const effects = new Map<number, MagicEffectRecord>();
    for (const list of lists) {
      for (const entry of list) {
        if (effects.has(entry.effect)) continue;
        const effect = await runtime.magic.effect(entry.effect);
        if (effect) effects.set(entry.effect, effect);
      }
    }
    const { skill, enchantments, potion } = await this.#skill(actor, ALCHEMY, FORTIFY.alchemy);
    const { alchemy } = await this.settings();
    const rank = alchemyPower({ skill, fortify: enchantments + potion }, alchemy);
    const info = (effect: number) => effects.get(effect);
    // Whether it is a poison (its strongest effect at the power before the perks) decides
    // which perks apply.
    const first = brewPotion(lists, info, () => rank, rank);
    if (!first) return undefined;
    const factors = new Map<number, number>();
    for (const [formId, effect] of effects)
      factors.set(formId, await this.perks.alchemyEffectiveness(actor, effect, first.poison));
    const purify = await this.perks.purifyAlchemy(actor);
    return brewPotion(lists, info, (effect) => rank * (factors.get(effect) ?? 1), rank, purify);
  }

  /**
   * Brews with ingredients (one of each used up): the effects they share are found out on
   * each, and the potion or poison made joins the actor's items (its form: made from the
   * default potion's or poison's, DOBJ BAPO / BAPS, named after its strongest effect,
   * sCreatedPotionNamePrefix / sCreatedPoisonNamePrefix, looking like the plugins' first
   * potion of that effect); Alchemy's use (its value; fWortFailSkillUseMagnitude for none).
   */
  async brew(actor: number, ingredients: readonly number[]): Promise<BrewResult> {
    const runtime = this.#runtime;
    const potion = await this.potion(actor, ingredients);
    const items = await Promise.all(ingredients.map((formId) => runtime.equipment.item(formId)));
    for (const formId of ingredients)
      await runtime.removeItem(actor, runtime.formHandle(formId), 1, true, undefined);
    const { crafting } = await this.settings();
    if (!potion) {
      await runtime.progression.useSkill(actor, ALCHEMY, failedAlchemySkillUse(crafting));
      return { made: undefined, potion: undefined, count: 0 };
    }
    // What they share is found out on each of them.
    if (actor === PLAYER_REF) {
      const made = new Set(potion.effects.map((effect) => effect.effect));
      const shared = new Set<number>();
      const seen = new Map<number, number>();
      for (const item of items)
        for (const effect of new Set(item?.effects.map((e) => e.effect) ?? []))
          seen.set(effect, (seen.get(effect) ?? 0) + 1);
      for (const [effect, count] of seen) if (count >= 2) shared.add(effect);
      for (const [i, formId] of ingredients.entries()) {
        const known = new Set(runtime.state.ingredientEffects.get(formId) ?? []);
        for (const [slot, effect] of (items[i]?.effects ?? []).entries())
          if (shared.has(effect.effect) || made.has(effect.effect)) known.add(slot);
        runtime.state.ingredientEffects.set(formId, known);
      }
    }
    const made = await this.#potionForm(potion);
    if (made === undefined) return { made: undefined, potion, count: 0 };
    const count = Math.max(1, Math.round(await this.perks.potionsCreated(actor, made)));
    await runtime.addItem(actor, runtime.formHandle(made), count, true);
    await runtime.progression.useSkill(actor, ALCHEMY, alchemySkillUse(potion.value));
    this.#stat(potion.poison ? 'poisons mixed' : 'potions mixed', count);
    return { made, potion, count };
  }

  /** The created ALCH of a brewed potion. */
  async #potionForm(potion: BrewedPotion): Promise<number | undefined> {
    const runtime = this.#runtime;
    const defaults = await this.#defaultObjects();
    const templateId = defaults.get(potion.poison ? DEFAULT_POISON : DEFAULT_POTION);
    const template = templateId === undefined ? undefined : await runtime.forms.record(templateId);
    const strongest = potion.effects[0];
    if (!template || !strongest) return undefined;
    const effect = await runtime.magic.effect(strongest.effect);
    const settings = await this.settings();
    const name = potionName(
      potion.poison ? settings.poisonPrefix : settings.potionPrefix,
      effect?.name ?? '',
    );
    // Its look: the plugins' first potion (poison) of its strongest effect, else the template's.
    const lookId = (await this.#looks()).get(
      `${String(strongest.effect)}:${String(potion.poison)}`,
    );
    const look = lookId === undefined ? undefined : await runtime.forms.record(lookId);
    const models = new Set(['MODL', 'MODT', 'MODS']);
    const own = new Set(['EDID', 'FULL', 'ENIT', 'EFID', 'EFIT', 'CTDA', 'CIS1', 'CIS2']);
    const fields: CreatedField[] = copyFields(
      template,
      (type) => !own.has(type) && !(look && models.has(type)),
    );
    if (look) {
      for (const { type, data } of look.fields.list)
        if (models.has(type)) fields.push(copyField(look, type, data));
    }
    // ENIT: value, flags, addiction, addiction chance, the sound of using it (the template's).
    const enit = new Uint8Array(20);
    const data = new DataView(enit.buffer);
    const templateEnit = template.fields.first('ENIT');
    data.setInt32(0, Math.round(potion.value), true);
    data.setUint32(4, PotionFlag.noAutoCalc | (potion.poison ? PotionFlag.poison : 0), true);
    data.setUint32(
      16,
      templateEnit && templateEnit.length >= 20 ? template.formIdAt(templateEnit, 16) : 0,
      true,
    );
    fields.splice(0, 0, createdField.zstring('FULL', name));
    fields.push(createdField.bytes('ENIT', enit));
    fields.push(...effectFields(potion.effects));
    return this.create({ type: 'ALCH', fields });
  }

  /** The plugins' first potion (and poison) of each first effect ("effect:poison"). */
  #looks(): Promise<Map<string, number>> {
    this.#potionLooks ??= (async () => {
      const runtime = this.#runtime;
      const looks = new Map<string, number>();
      for (const formId of runtime.forms.db.formIdsOfType('ALCH')) {
        const item = await runtime.equipment.item(formId);
        const first = item?.effects[0];
        if (!item || !first || item.name === '' || item.model === undefined) continue;
        const flags = item.potionFlags ?? 0;
        if ((flags & PotionFlag.food) !== 0) continue;
        const key = `${String(first.effect)}:${String((flags & PotionFlag.poison) !== 0)}`;
        if (!looks.has(key)) looks.set(key, formId);
      }
      return looks;
    })();
    return this.#potionLooks;
  }
}
