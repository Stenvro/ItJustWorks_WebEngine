// The crafting menu's engine side (craftingmenu.swf shows it: crafting-menu.ts; the headless
// simulation runs it without a movie): what a workbench lists and what choosing and crafting do
// there, by its menu's subtype (FURN WBDT: src/gameplay/crafting.ts craftingMenuOf).
//
// - Constructible (forges, smelters, tanning racks, cooking pots, HearthFire's tables): the
//   recipes whose conditions hold for the player, in material categories; choosing one with
//   its components makes it.
// - Smithing (grindstone: weapons, armor workbench: armor): the player's items with a tempering
//   recipe at the bench (each improved instance its own entry), with their quality; choosing one
//   improves it as far as the skill goes.
// - Enchanting: disenchanting an enchanted item learns its enchantment; an item, enchantments
//   and a soul gem are chosen (a weapon enchantment's magnitude on the card's slider: its
//   charges), the aux action names the item, crafting makes it.
// - Alchemy: up to three ingredients are chosen; crafting brews them: the effects they share
//   are learned and the potion or poison made.
// Each item made tells the story manager's Craft Item. What crafting does to the game's state
// is the crafting engine's (src/scripting/runtime/crafting-engine.ts).
// Notes: docs/ui.md ("Crafting").

import {
  alchemyCategories,
  alchemyCategoryList,
  canImprove,
  constructibleCategories,
  constructibleCategory,
  constructibleEntry,
  constructibleSkillUse,
  craftingMenuOf,
  enchantingCategories,
  enchantingFilterFlag,
  enchantmentsAllowed,
  hasComponents,
  ingredientFilterFlag,
  ingredientLines,
  materialFilterIndices,
  temperedArmorRating,
  temperedWeaponDamage,
  temperingCandidates,
  temperLevelOfHealth,
  type CraftingMenuType,
  type EnchantingEntryKind,
  type MenuCategory,
} from '../gameplay/crafting.ts';
import { CardType, SOUL_LEVEL_SETTINGS } from '../gameplay/inventory.ts';
import type { ChosenEnchantment } from '../scripting/runtime/crafting-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import {
  craftedItemInfo,
  parseWorkbench,
  recipeIndex,
  type Recipe,
  type Workbench,
} from '../world/crafting-records.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { parseEffects, parseItem, type ItemRecord } from '../world/item-records.ts';
import { parseMagicEffect } from '../world/magic-effects.ts';
import { CastType } from '../world/spell-records.ts';
import type { GameSession } from './game-session.ts';
import { effectsText, itemCard, temperedName } from './inventory-menu.ts';

/** Biped slot 32 (body): chest armor improves twice as much (UESP Smithing). */
const BODY_SLOT = 0x4;

/** An entry of the item list: the movie's fields and the engine's own. */
export interface Entry {
  readonly text: string;
  readonly filterFlag: number;
  readonly enabled?: boolean;
  readonly count?: number;
  readonly equipState?: number;
  /** The item shown (its 3D and its card). */
  readonly formId: number;
  readonly [field: string]: unknown;
}

/** What a subtype lists and what choosing and crafting do. */
export interface CraftingModel {
  /** `_root.Menu.MenuName`: the header over the categories. */
  readonly name: string;
  readonly categories: readonly MenuCategory[];
  /** The alchemy menu's filter: a category matches any of an entry's four bytes. */
  readonly partitioned?: boolean;
  /** Select, Exit, Aux, Craft (a label "" hides the button). */
  buttons(): readonly [string, string, string, string];
  entries(): Promise<Entry[]>;
  card(entry: Entry): Promise<Record<string, unknown>>;
  /** The line under the card (UpdateIngredients), if any. */
  ingredients?(entry: Entry): IngredientsLine | undefined;
  /** ChooseItem; resolves once the menu should show the change. */
  choose(entry: Entry, view: CraftingView): Promise<void>;
  /** Whether R crafts now (bCanCraft). */
  canCraft(): boolean;
  craft?(): Promise<void>;
  /** F (AuxButtonPress); true if it opened the card's name field. */
  aux?(view: CraftingView): boolean;
  /** EndItemRename. */
  rename?(name: string | undefined): void;
  /** Leaving with something chosen asks first (sQuitEnchanting, sQuitAlchemy). */
  quitQuestion?(): string | undefined;
  /** The categories changed (alchemy: effects learned). */
  categoriesChanged?(): readonly MenuCategory[] | undefined;
  /** The card's slider moved (CalculateCharge): the card it shows now. */
  sliderChanged?(value: number): Promise<Record<string, unknown> | undefined>;
  /** The slider closed (SliderClose): its value kept, or not. */
  sliderClosed?(value: number, accepted: boolean): void;
}

export interface IngredientsLine {
  readonly title: string;
  readonly lines: readonly { Name: string; RequiredCount: number; PlayerCount: number }[];
  readonly showCount: boolean;
}

/** What crafting needs from the rest of the game's menus (a question, a notification). */
export interface CraftingHost {
  confirm(text: string, buttons: readonly string[]): Promise<number>;
  notify(text: string): void;
}

/** The movie's parts a choice opens (the card's slider, the item's name field). */
export interface CraftingView {
  /** The card's slider: its largest and smallest value, where it stands, its step. */
  slider(max: number, min: number, value: number, step: number): void;
  /** The item's name field, with the name so far and its longest. */
  rename(name: string, maxLength: number): void;
}

/** The workbench (FURN) of a base object and its menu's subtype, if it is one. */
export async function workbenchOf(
  runtime: ScriptRuntime,
  base: number,
): Promise<{ bench: Workbench; type: CraftingMenuType } | undefined> {
  const record = await runtime.forms.record(base);
  const bench = record?.type === 'FURN' ? parseWorkbench(record) : undefined;
  const type = bench && craftingMenuOf(bench.type);
  return bench && type ? { bench, type } : undefined;
}

export interface ModelContext {
  readonly log: (message: string) => void;
  readonly session: GameSession;
  readonly runtime: ScriptRuntime;
  readonly settings: GameSettings;
  readonly text: (label: string) => string;
  readonly game: CraftingHost;
  readonly bench: Workbench;
  /** The workbench reference (the story manager's craft event). */
  readonly reference: number;
}

export async function craftingModel(
  type: CraftingMenuType,
  context: ModelContext,
): Promise<CraftingModel> {
  switch (type.kind) {
    case 'constructible':
      return constructibleModel(context);
    case 'smithing':
      return smithingModel(context, type.improves ?? 'WEAP');
    case 'enchanting':
      return enchantingModel(context);
    case 'alchemy':
      return alchemyModel(context);
  }
}

/** Item records, read once per menu. */
function itemReader(runtime: ScriptRuntime): (formId: number) => Promise<ItemRecord | undefined> {
  const items = new Map<number, Promise<ItemRecord | undefined>>();
  return (formId) => {
    let item = items.get(formId);
    if (!item) {
      item = runtime.forms
        .record(formId)
        .then((record) => (record ? parseItem(record) : undefined));
      items.set(formId, item);
    }
    return item;
  };
}

/** A UI sound by editor id, at no place (none where nothing is heard: the headless simulation). */
function uiSound(session: GameSession, name: string): void {
  session.sounds().then(
    (sounds) => sounds.playNamed(name, undefined),
    () => undefined,
  );
}

/** The workbench's skill used (its experience: the progression engine). */
function skillUse(runtime: ScriptRuntime, bench: Workbench, use: number): void {
  if (bench.skill !== undefined && use > 0)
    runtime.detach(runtime.progression.useSkill(PLAYER_REF, bench.skill, use));
}

// --- Constructible ----------------------------------------------------------------------------

async function constructibleModel(context: ModelContext): Promise<CraftingModel> {
  const { session, runtime, settings, text, bench } = context;
  const index = await recipeIndex(await session.db);
  const defaults = await session.defaultObjects();
  const materials = materialFilterIndices((use) => defaults.get(use));
  const item = itemReader(runtime);
  const player = runtime.referenceHandle(PLAYER_REF);
  const names = new Map<number, string>();
  const nameOf = async (formId: number): Promise<string> => {
    let name = names.get(formId);
    if (name === undefined) {
      name = (await runtime.forms.record(formId))?.text('FULL') ?? '';
      names.set(formId, name);
    }
    return name;
  };
  let inventory = new Map<number, number>();
  const have = (formId: number): number => inventory.get(formId) ?? 0;
  const recipes = new Map<number, Recipe>();
  const categoryOf = new Map<number, number>();
  for (const recipe of index.forWorkbench(bench.keywords)) {
    const created = recipe.created;
    if (created === undefined) continue;
    const record = await runtime.forms.record(created);
    if (!record) continue;
    recipes.set(recipe.formId, recipe);
    categoryOf.set(recipe.formId, constructibleCategory(craftedItemInfo(record), materials));
    await nameOf(created);
    for (const component of recipe.components) await nameOf(component.item);
  }
  const recipeOf = (entry: Entry): Recipe | undefined =>
    typeof entry.recipe === 'number' ? recipes.get(entry.recipe) : undefined;
  return {
    name: bench.name !== '' ? bench.name : text('sCraft'),
    categories: constructibleCategories(text),
    buttons: () => [text('sCreate'), text('sExit'), '', ''],
    entries: async () => {
      inventory = new Map(await runtime.inventory(PLAYER_REF));
      const entries: Entry[] = [];
      for (const recipe of recipes.values()) {
        if (!(await runtime.conditionsHold(recipe.conditions, player))) continue;
        const created = recipe.created ?? 0;
        entries.push({
          ...constructibleEntry(
            recipe,
            names.get(created) ?? '',
            categoryOf.get(recipe.formId) ?? 0,
            have,
          ),
        });
      }
      return entries;
    },
    card: async (entry) => {
      const record = await item(entry.formId);
      if (!record) {
        return { type: CardType.none, name: names.get(entry.formId) ?? '' };
      }
      return itemCard(runtime, settings, {
        formId: entry.formId,
        item: record,
        count: entry.count ?? 1,
        worn: false,
        favorite: false,
      });
    },
    ingredients: (entry) => {
      const recipe = recipeOf(entry);
      return recipe
        ? {
            title: '',
            lines: ingredientLines(recipe.components, (formId) => names.get(formId) ?? '', have),
            showCount: true,
          }
        : undefined;
    },
    choose: async (entry) => {
      const recipe = recipeOf(entry);
      if (!recipe || entry.enabled === false || recipe.created === undefined) return;
      for (const component of recipe.components) {
        await runtime.removeItem(
          PLAYER_REF,
          runtime.formHandle(component.item),
          component.count,
          true,
          undefined,
        );
      }
      await runtime.addItem(
        PLAYER_REF,
        runtime.formHandle(recipe.created),
        recipe.createdCount,
        true,
      );
      uiSound(session, 'UISmithingCreateGeneric');
      const made = await item(recipe.created);
      const stat =
        made?.type === 'WEAP' ? 'Weapons Made' : made?.type === 'ARMO' ? 'Armor Made' : undefined;
      if (stat) runtime.incrementStat(stat, recipe.createdCount);
      skillUse(runtime, bench, constructibleSkillUse((made?.value ?? 0) * recipe.createdCount));
      await craftEvent(context, recipe.created);
    },
    canCraft: () => false,
  };
}

/**
 * An item made or improved at the workbench: the story manager's Craft Item (story-events.ts),
 * awaited as the menu shows the change after it.
 */
function craftEvent(context: ModelContext, created: number): Promise<boolean> {
  return context.runtime.storyEvents.craftItem(context.reference, created);
}

// --- Smithing -----------------------------------------------------------------------------------

/** An entry's stack of improved items (Entry.stack), if it is one. */
const stackOf = (entry: Entry): number | undefined =>
  typeof entry.stack === 'number' ? entry.stack : undefined;

async function smithingModel(
  context: ModelContext,
  improves: 'WEAP' | 'ARMO',
): Promise<CraftingModel> {
  const { session, runtime, settings, text, bench, game } = context;
  const crafting = runtime.crafting;
  const index = await recipeIndex(await session.db);
  const benchRecipes = index.forWorkbench(bench.keywords);
  const item = itemReader(runtime);
  const player = runtime.referenceHandle(PLAYER_REF);
  let inventory = new Map<number, number>();
  const have = (formId: number): number => inventory.get(formId) ?? 0;
  const names = new Map<number, string>();
  const nameOf = async (formId: number): Promise<string> => {
    let name = names.get(formId);
    if (name === undefined) {
      name = (await runtime.forms.record(formId))?.text('FULL') ?? '';
      names.set(formId, name);
    }
    return name;
  };
  const recipeFor = new Map<number, Recipe>();
  /** An entry's instance: its quality (its stack's health). */
  const levelOf = (entry: Entry): number => {
    const stack = stackOf(entry);
    const health =
      stack === undefined ? 1 : (crafting.stacks(PLAYER_REF, entry.formId)[stack]?.health ?? 1);
    return temperLevelOfHealth(health);
  };
  return {
    name: text(improves === 'WEAP' ? 'sWeaponSmithing' : 'sArmorSmithing'),
    // One category: everything the bench improves.
    categories: [
      {
        text: text(improves === 'WEAP' ? 'sWeaponSmithing' : 'sArmorSmithing'),
        flag: 1,
        bDontHide: true,
      },
    ],
    buttons: () => [text('sCraft'), text('sExit'), '', ''],
    entries: async () => {
      inventory = new Map(await runtime.inventory(PLAYER_REF));
      const items: {
        base: number;
        template: number | undefined;
        record: ItemRecord;
        stack: number | undefined;
        count: number;
        level: number;
      }[] = [];
      for (const [formId, count] of inventory) {
        if (count <= 0) continue;
        const record = await item(formId);
        if (record?.type !== improves || record.nonPlayable || record.name === '') continue;
        // An enchanted variant is improved by its plain item's recipe (its template).
        const template = (await runtime.forms.record(formId))?.formIdField(
          improves === 'WEAP' ? 'CNAM' : 'TNAM',
        );
        for (const instance of crafting.instances(PLAYER_REF, formId)) {
          items.push({
            base: formId,
            template,
            record,
            stack: instance.stack,
            count: instance.count,
            level: temperLevelOfHealth(instance.health),
          });
        }
      }
      const entries: Entry[] = [];
      for (const { item: candidate, recipe } of temperingCandidates(items, benchRecipes)) {
        recipeFor.set(candidate.base, recipe);
        for (const component of recipe.components) await nameOf(component.item);
        entries.push({
          text: await temperedName(runtime, candidate.record, candidate.level),
          count: candidate.count,
          filterFlag: 1,
          enabled: true,
          formId: candidate.base,
          ...(candidate.stack !== undefined && { stack: candidate.stack }),
        });
      }
      return entries;
    },
    card: async (entry) => {
      const record = await item(entry.formId);
      if (!record) return { type: CardType.none };
      const level = levelOf(entry);
      const card = await itemCard(runtime, settings, {
        formId: entry.formId,
        item: record,
        count: entry.count ?? 1,
        worn: false,
        favorite: false,
        temper: level,
        name: entry.text,
      });
      // The bench shows the item's own rating or damage with its improvement.
      if (record.weapon)
        card.damage = Math.floor(temperedWeaponDamage(record.weapon.damage, level));
      if (record.armor) {
        const chest = (record.armor.slots & BODY_SLOT) !== 0;
        card.armor = Math.floor(temperedArmorRating(record.armor.rating, level, chest));
      }
      return card;
    },
    ingredients: (entry) => {
      const recipe = recipeFor.get(entry.formId);
      return recipe
        ? {
            title: '',
            lines: ingredientLines(recipe.components, (formId) => names.get(formId) ?? '', have),
            showCount: true,
          }
        : undefined;
    },
    choose: async (entry) => {
      const recipe = recipeFor.get(entry.formId);
      const record = await item(entry.formId);
      if (!recipe || !record) return;
      // The recipe's conditions ask about the item (EPTemperingItemIsEnchanted: Arcane
      // Blacksmith's).
      const tempered = { base: entry.formId, enchanted: record.enchantment !== undefined };
      if (
        !(await runtime.conditionsHold(recipe.conditions, player, undefined, { item: tempered }))
      ) {
        game.notify(
          text(
            record.enchantment === undefined
              ? 'sLackRequiredPerksToImprove'
              : 'sLackRequiredPerkToImproveMagical',
          ),
        );
        return;
      }
      if (!hasComponents(recipe, have)) {
        game.notify(text('sLackRequiredToImprove'));
        return;
      }
      // As far as the skill reaches (the material perk, Fortify Smithing: the crafting engine).
      const level = await crafting.temperQuality(PLAYER_REF, record);
      if (!canImprove(levelOf(entry), level)) {
        game.notify(text('sLackRequiredSkillToImprove'));
        return;
      }
      for (const component of recipe.components) {
        await runtime.removeItem(
          PLAYER_REF,
          runtime.formHandle(component.item),
          component.count,
          true,
          undefined,
        );
      }
      const result = await crafting.temper(PLAYER_REF, entry.formId, stackOf(entry));
      if (result.kind !== 'improved') return;
      uiSound(session, improves === 'WEAP' ? 'UISmithingImproveWeapon' : 'UISmithingImproveArmor');
      // An improvement is a craft too (the tutorials' TutorialBlacksmithingDaggerSharpen and
      // ArmorTemper start on Craft Item at the grindstone and the armor table, the improved
      // item as the created one).
      await craftEvent(context, entry.formId);
    },
    canCraft: () => false,
  };
}

// --- Enchanting ---------------------------------------------------------------------------------

async function enchantingModel(context: ModelContext): Promise<CraftingModel> {
  const { session, runtime, settings, text, game } = context;
  const crafting = runtime.crafting;
  const item = itemReader(runtime);
  const defaults = await session.defaultObjects();
  /** MagicDisallowEnchanting (DOBJ DIEN): items and enchantments that cannot be learned. */
  const disallowed = defaults.get('DIEN');
  const known = runtime.state.knownEnchantments;
  /** The item (an instance of it), the soul gem and the enchantments chosen. */
  const chosen: {
    item?: { formId: number; stack: number | undefined };
    gem?: number;
    enchantments: ChosenEnchantment[];
  } = { enchantments: [] };
  /** The enchantment the slider is open for, and its value before. */
  let sliding: { formId: number; before: number | undefined } | undefined;
  let name: string | undefined;
  const allowed = await crafting.perks.enchantmentsAllowed(PLAYER_REF);
  const kindOf = (entry: Entry): EnchantingEntryKind | undefined =>
    typeof entry.kind === 'string' ? (entry.kind as EnchantingEntryKind) : undefined;
  const chosenItem = async (): Promise<ItemRecord | undefined> =>
    chosen.item === undefined ? undefined : item(chosen.item.formId);
  const soulOf = async (gem: number | undefined): Promise<number> =>
    gem === undefined ? 0 : ((await item(gem))?.soul?.current ?? 0);
  /** Whether a learned enchantment goes on the chosen item (any, without one). */
  const fitsChosen = async (formId: number): Promise<boolean> => {
    const target = await chosenItem();
    const enchantment = await runtime.magic.item(formId);
    return !target || (enchantment !== undefined && (await crafting.fits(enchantment, target)));
  };
  const plan = async () =>
    chosen.item === undefined
      ? undefined
      : crafting.plan(
          PLAYER_REF,
          chosen.item.formId,
          chosen.enchantments,
          await soulOf(chosen.gem),
        );
  /** The card of a learned enchantment: as it would be made, with the slider's charges. */
  const enchantmentCard = async (formId: number, entryName: string) => {
    // Chosen, with an item and a soul (or on the slider): as it would be made; else the base
    // enchantment's.
    const made =
      (chosen.gem !== undefined || sliding?.formId === formId) &&
      chosen.enchantments.some((e) => e.formId === formId)
        ? await plan()
        : undefined;
    const record = await runtime.forms.record(formId);
    const effects = made?.effects ?? (record?.type === 'ENCH' ? parseEffects(record) : []);
    return {
      type: CardType.craftEnchanting,
      name: entryName,
      effects: await effectsText(runtime, effects),
      usedCharge: 0,
      totalCharges: made?.weapon && Number.isFinite(made.uses) ? made.uses : 0,
      ...(sliding?.formId === formId && { sliderShown: true }),
    };
  };
  return {
    name: text('sEnchanting'),
    categories: enchantingCategories(text),
    buttons: () => [
      text('sSelect'),
      text('sExit'),
      chosen.item === undefined ? '' : text('sRenameItem'),
      text('sCraft'),
    ],
    entries: async () => {
      const entries: Entry[] = [];
      for (const [formId, count] of await runtime.inventory(PLAYER_REF)) {
        if (count <= 0) continue;
        const record = await item(formId);
        if (!record || record.nonPlayable || record.name === '') continue;
        if (record.type === 'WEAP' || record.type === 'ARMO') {
          const armor = record.type === 'ARMO';
          if (record.enchantment !== undefined) {
            const learned = await crafting.learnedFrom(record);
            if (!learned || (disallowed !== undefined && learned.keywords.includes(disallowed)))
              continue;
            if (disallowed !== undefined && record.keywords.includes(disallowed)) continue;
            for (const instance of crafting.instances(PLAYER_REF, formId)) {
              entries.push({
                text: await temperedName(runtime, record, temperLevelOfHealth(instance.health)),
                count: instance.count,
                filterFlag: enchantingFilterFlag('disenchant', armor),
                enabled: true,
                formId,
                kind: 'disenchant',
                ...(instance.stack !== undefined && { stack: instance.stack }),
              });
            }
          } else if (crafting.enchantable(record, disallowed)) {
            for (const instance of crafting.instances(PLAYER_REF, formId)) {
              const mine = chosen.item?.formId === formId && chosen.item.stack === instance.stack;
              entries.push({
                text: await temperedName(runtime, record, temperLevelOfHealth(instance.health)),
                count: instance.count,
                filterFlag: enchantingFilterFlag('item', armor),
                enabled: true,
                equipState: mine ? 1 : 0,
                formId,
                kind: 'item',
                ...(instance.stack !== undefined && { stack: instance.stack }),
              });
            }
          }
        } else if (record.type === 'SLGM' && (record.soul?.current ?? 0) > 0) {
          entries.push({
            text: record.name,
            count,
            filterFlag: enchantingFilterFlag('soulGem', false),
            enabled: true,
            equipState: chosen.gem === formId ? 1 : 0,
            formId,
            kind: 'soulGem',
            soulLVL: settings.string(SOUL_LEVEL_SETTINGS[record.soul?.current ?? 0] ?? '') ?? '',
          });
        }
      }
      for (const formId of known) {
        const learned = await runtime.magic.item(formId);
        if (learned?.type !== 'ENCH') continue;
        entries.push({
          text: learned.name,
          filterFlag: enchantingFilterFlag(
            'enchantment',
            learned.castType === CastType.constantEffect,
          ),
          // Those that do not go on the chosen item are greyed.
          enabled: await fitsChosen(formId),
          equipState: chosen.enchantments.some((e) => e.formId === formId) ? 1 : 0,
          formId,
          kind: 'enchantment',
        });
      }
      return entries;
    },
    card: async (entry) => {
      if (kindOf(entry) === 'enchantment') return enchantmentCard(entry.formId, entry.text);
      const record = await item(entry.formId);
      if (!record) return { type: CardType.none };
      const stack = stackOf(entry);
      const health =
        stack === undefined ? 1 : (crafting.stacks(PLAYER_REF, entry.formId)[stack]?.health ?? 1);
      const card = await itemCard(runtime, settings, {
        formId: entry.formId,
        item: record,
        count: entry.count ?? 1,
        worn: false,
        favorite: false,
        temper: temperLevelOfHealth(health),
        name: entry.text,
      });
      if (
        kindOf(entry) === 'item' &&
        chosen.item?.formId === entry.formId &&
        chosen.item.stack === stack
      ) {
        // The item as it will be: its name, the chosen enchantments' effects.
        if (name !== undefined) card.name = name;
        const made = chosen.gem === undefined ? undefined : await plan();
        if (made) card.effects = await effectsText(runtime, made.effects);
      }
      return card;
    },
    choose: async (entry, view) => {
      const kind = kindOf(entry);
      if (kind === 'disenchant') {
        const answer = await game.confirm(text('sConfirmDisenchant'), [text('sYes'), text('sNo')]);
        if (answer !== 0) return;
        const result = await crafting.disenchant(PLAYER_REF, entry.formId, stackOf(entry));
        if (result.kind === 'known') {
          game.notify(text('sEnchantmentKnown'));
          return;
        }
        if (result.kind !== 'learned') return;
        uiSound(session, 'UIEnchantingItemDestroy');
        uiSound(session, 'UIEnchantingLearnEffect');
        game.notify(text('sEnchantmentsLearned').replace('%s', result.name));
        return;
      }
      if (kind === 'item') {
        const stack = stackOf(entry);
        const same = chosen.item?.formId === entry.formId && chosen.item.stack === stack;
        chosen.item = same ? undefined : { formId: entry.formId, stack };
        name = undefined;
        // Enchantments that do not go on it are let go.
        const fitting: ChosenEnchantment[] = [];
        for (const e of chosen.enchantments) if (await fitsChosen(e.formId)) fitting.push(e);
        chosen.enchantments = fitting;
      } else if (kind === 'soulGem') {
        chosen.gem = chosen.gem === entry.formId ? undefined : entry.formId;
      } else if (kind === 'enchantment') {
        const at = chosen.enchantments.findIndex((e) => e.formId === entry.formId);
        if (at >= 0) {
          chosen.enchantments.splice(at, 1);
        } else if (!(await fitsChosen(entry.formId))) {
          game.notify(text('sEnchantArmorIncompatible'));
          return;
        } else {
          // One, or as many as the perks allow (Extra Effect): the first one chosen goes.
          if (chosen.enchantments.length >= enchantmentsAllowed(allowed))
            chosen.enchantments.shift();
          chosen.enchantments.push({ formId: entry.formId });
          // A weapon enchantment's magnitude on the card's slider (1 .. its largest).
          const made = await plan();
          const first = chosen.enchantments[0];
          if (made?.weapon && first?.formId === entry.formId && made.maxValue > 1) {
            sliding = { formId: entry.formId, before: undefined };
            view.slider(made.maxValue, 1, made.value, 1);
          }
        }
      }
      uiSound(session, 'UIMenuFocus');
    },
    sliderChanged: async (value) => {
      if (!sliding) return undefined;
      const formId = sliding.formId;
      chosen.enchantments = chosen.enchantments.map((e) =>
        e.formId === formId ? { formId, value } : e,
      );
      const learned = await runtime.magic.item(formId);
      return enchantmentCard(formId, learned?.name ?? '');
    },
    sliderClosed: (value, accepted) => {
      const open = sliding;
      sliding = undefined;
      if (!open) return;
      const kept = accepted ? value : open.before;
      chosen.enchantments = chosen.enchantments.map((e) =>
        e.formId !== open.formId
          ? e
          : kept === undefined
            ? { formId: open.formId }
            : { formId: open.formId, value: kept },
      );
    },
    canCraft: () =>
      chosen.item !== undefined && chosen.gem !== undefined && chosen.enchantments.length > 0,
    craft: async () => {
      const target = chosen.item;
      const gem = chosen.gem;
      if (!target || gem === undefined || chosen.enchantments.length === 0) {
        game.notify(text('sEnchantMustChooseItems'));
        return;
      }
      const answer = await game.confirm(text('sEnchantItem'), [text('sYes'), text('sNo')]);
      if (answer !== 0) return;
      const made = await crafting.enchant(
        PLAYER_REF,
        target.formId,
        target.stack,
        chosen.enchantments,
        gem,
        name,
      );
      if (made === undefined) {
        game.notify(text('sEnchantArmorIncompatible'));
        return;
      }
      uiSound(session, 'UIEnchantingItemCreate');
      chosen.item = undefined;
      chosen.gem = undefined;
      chosen.enchantments = [];
      name = undefined;
      await craftEvent(context, made);
    },
    aux: (view) => {
      if (chosen.item === undefined) return false;
      view.rename(name ?? '', MAX_ITEM_NAME);
      return true;
    },
    rename: (text) => {
      if (text !== undefined && text.trim() !== '') name = text.trim();
    },
    quitQuestion: () =>
      chosen.item !== undefined || chosen.gem !== undefined || chosen.enchantments.length > 0
        ? (settings.string('sQuitEnchanting') ?? undefined)
        : undefined,
  };
}

/** The longest name an enchanted item may get (the card's name field). */
const MAX_ITEM_NAME = 32;

// --- Alchemy ------------------------------------------------------------------------------------

async function alchemyModel(context: ModelContext): Promise<CraftingModel> {
  const { session, runtime, settings, text, game } = context;
  const item = itemReader(runtime);
  /** The effects found out per ingredient (by slot). */
  const known = runtime.state.ingredientEffects;
  const chosen: number[] = [];
  const names = new Map<number, string>();
  const effectNames = new Map<number, string>();
  const effectName = async (formId: number): Promise<string> => {
    let name = effectNames.get(formId);
    if (name === undefined) {
      const record = await runtime.forms.record(formId);
      name = record?.type === 'MGEF' ? parseMagicEffect(record).name : '';
      effectNames.set(formId, name);
    }
    return name;
  };
  const knownSlots = (ingredient: number): ReadonlySet<number> =>
    known.get(ingredient) ?? new Set();
  /** The categories: every effect known on any ingredient the player has, by name. */
  const categoriesNow = async (): Promise<readonly MenuCategory[]> => {
    const effects = new Map<number, string>();
    for (const [formId, count] of await runtime.inventory(PLAYER_REF)) {
      if (count <= 0) continue;
      const record = await item(formId);
      if (record?.type !== 'INGR') continue;
      const slots = knownSlots(formId);
      for (const [slot, effect] of record.effects.entries()) {
        if (slots.has(slot)) effects.set(effect.effect, await effectName(effect.effect));
      }
    }
    categoryList = alchemyCategories([...effects].map(([effect, name]) => ({ effect, name })));
    return alchemyCategoryList(categoryList, text('sIngredients'));
  };
  let categoryList = alchemyCategories([]);
  let categories = await categoriesNow();
  let changed = false;
  return {
    name: text('sAlchemy'),
    categories,
    partitioned: true,
    buttons: () => [text('sSelect'), text('sExit'), '', text('sCraft')],
    entries: async () => {
      const entries: Entry[] = [];
      const inventory = await runtime.inventory(PLAYER_REF);
      // Ingredients used up are no longer chosen.
      for (let i = chosen.length - 1; i >= 0; i--)
        if ((inventory.get(chosen[i] ?? 0) ?? 0) <= 0) chosen.splice(i, 1);
      for (const [formId, count] of inventory) {
        if (count <= 0) continue;
        const record = await item(formId);
        if (record?.type !== 'INGR' || record.name === '') continue;
        names.set(formId, record.name);
        const slots = knownSlots(formId);
        entries.push({
          text: record.name,
          count,
          filterFlag: ingredientFilterFlag(
            record.effects.map((effect) => effect.effect),
            (slot) => slots.has(slot),
            categoryList,
          ),
          enabled: true,
          equipState: chosen.includes(formId) ? 1 : 0,
          formId,
        });
      }
      return entries;
    },
    card: async (entry) => {
      const record = await item(entry.formId);
      if (!record) return { type: CardType.none };
      const card: Record<string, unknown> = {
        type: CardType.ingredient,
        name: record.name,
        count: entry.count ?? 1,
        value: record.value,
        weight: record.weight,
        numItemEffects: record.effects.length,
      };
      const slots = knownSlots(entry.formId);
      for (const [slot, effect] of record.effects.entries()) {
        card[`itemEffect${String(slot)}`] = slots.has(slot) ? await effectName(effect.effect) : '';
      }
      return card;
    },
    // The ingredients chosen, under the card.
    ingredients: () => ({
      title: '',
      lines: chosen.map((formId) => ({
        Name: names.get(formId) ?? '',
        RequiredCount: 1,
        PlayerCount: 1,
      })),
      showCount: false,
    }),
    choose: async (entry) => {
      const at = chosen.indexOf(entry.formId);
      if (at >= 0) chosen.splice(at, 1);
      else if (chosen.length < MAX_INGREDIENTS) chosen.push(entry.formId);
      uiSound(session, at >= 0 ? 'UISelectOff' : 'UISelectOn');
      await Promise.resolve();
    },
    canCraft: () => chosen.length >= 2,
    // The ingredients are used up; what they share is learned, the potion or poison made (the
    // crafting engine).
    craft: async () => {
      const result = await runtime.crafting.brew(PLAYER_REF, [...chosen]);
      chosen.length = 0;
      if (result.made === undefined || !result.potion) {
        uiSound(session, 'UIAlchemyFail');
        game.notify(text('sPotionCreationFailed'));
      } else {
        uiSound(session, 'UIAlchemyLearnEffect');
        uiSound(session, result.potion.poison ? 'UIAlchemyCreatePoison' : 'UIAlchemyCreatePotion');
        await craftEvent(context, result.made);
      }
      categories = await categoriesNow();
      changed = true;
    },
    categoriesChanged: () => {
      if (!changed) return undefined;
      changed = false;
      return categories;
    },
    quitQuestion: () =>
      chosen.length > 0 ? (settings.string('sQuitAlchemy') ?? undefined) : undefined,
  };
}

/** At most three ingredients make a potion. */
const MAX_INGREDIENTS = 3;
