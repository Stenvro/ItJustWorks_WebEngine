// The crafting menu (interface\craftingmenu.swf): what a workbench opens (FURN WBDT: its bench
// type picks the movie's frame, its skill the bar at the bottom; its keywords the recipes, COBJ
// BNAM). The movie has no InitExtensions: the engine goes to the subtype's frame, calls
// `_root.Menu.Initialize()`, `_root.SetPlatform(0, false)`, sets the menu's name and
// description, sends the categories (SetCategoriesList), fills `Menu.ItemList.entryList`
// (InvalidateListData), the button labels (ButtonText, UpdateButtonText) and the skill
// (BottomBarInfo.UpdateCraftingInfo). The movie tells the highlighted entry (SetSelectedItem:
// the engine sets the card, `Menu.ItemInfo.itemInfo`, and the line under it, UpdateIngredients),
// asks for its 3D (ShowItem3D) and chooses it (ChooseItem: E, Enter, a click); R crafts what
// is selected (CraftButtonPress), F the aux action, Esc and Tab close (unless the card's slider
// or name field is open: the movie takes Tab then).
//
// - Constructible (forges, smelters, tanning racks, cooking pots, HearthFire's tables): the
//   recipes whose conditions hold for the player, in material categories; choosing one with
//   its components makes it.
// - Smithing (grindstone: weapons, armor workbench: armor): the player's items with a tempering
//   recipe at the bench, with their quality; choosing one improves it as far as the skill goes.
// - Enchanting: disenchanting an enchanted item learns its enchantment; items, enchantments
//   and soul gems are chosen (TODO(M11): making the enchanted item, its charge slider).
// - Alchemy: up to three ingredients are chosen; crafting learns the effects they share
//   (TODO(M11): the potion or poison made).
//
// Sources: the movie's ActionScript, CommonLibSSE-NG (CraftingSubMenus), SkyUI 5, UESP.
// Notes: docs/ui.md ("Crafting").

import {
  alchemyCategories,
  alchemyCategoryList,
  canImprove,
  categoriesListArgs,
  constructibleCategories,
  constructibleCategory,
  constructibleEntry,
  constructibleSkillUse,
  craftingMenuOf,
  enchantingCategories,
  enchantingFilterFlag,
  enchantmentsAllowed,
  ingredientFilterFlag,
  ingredientLines,
  materialFilterIndices,
  sharedEffects,
  temperedArmorRating,
  temperedWeaponDamage,
  temperHealth,
  temperingCandidates,
  temperingEffectiveSkill,
  temperingQualityLevel,
  temperingSkillUse,
  temperLevelOfHealth,
  temperQualityName,
  type CraftingMenuType,
  type EnchantingEntryKind,
  type MenuCategory,
} from '../gameplay/crafting.ts';
import { CardType, SOUL_LEVEL_SETTINGS } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { actorValueIndex, actorValueName } from '../world/actor-values.ts';
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
import type { StoryEventData } from '../scripting/runtime/story-manager.ts';
import type { GameSession } from './game-session.ts';
import { effectsText, itemCard } from './inventory-menu.ts';
import { Item3D } from './item-3d.ts';
import type { Terminal } from './terminal.ts';

/** Over the HUD and the world, as the item menus. */
const CRAFTING_DEPTH = 6;
const MENU = '_root.Menu';
const LIST = `${MENU}.ItemList`;
/** The Smithing skill (actor value). */
const SMITHING = actorValueIndex('Smithing') ?? 10;
/** Biped slot 32 (body): chest armor improves twice as much (UESP Smithing). */
const BODY_SLOT = 0x4;

/** An entry of the item list: the movie's fields and the engine's own. */
interface Entry {
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
interface CraftingModel {
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
  choose(entry: Entry): Promise<void>;
  /** Whether R crafts now (bCanCraft). */
  canCraft(): boolean;
  craft?(): Promise<void>;
  /** F (AuxButtonPress); true if it opened the card's name field. */
  aux?(menu: Menu): boolean;
  /** EndItemRename. */
  rename?(name: string | undefined): void;
  /** Leaving with something chosen asks first (sQuitEnchanting, sQuitAlchemy). */
  quitQuestion?(): string | undefined;
  /** The categories changed (alchemy: effects learned). */
  categoriesChanged?(): readonly MenuCategory[] | undefined;
}

interface IngredientsLine {
  readonly title: string;
  readonly lines: readonly { Name: string; RequiredCount: number; PlayerCount: number }[];
  readonly showCount: boolean;
}

/** What the crafting menu needs from the rest of the game's menus. */
export interface CraftingHost {
  confirm(text: string, buttons: readonly string[]): Promise<number>;
  notify(text: string): void;
}

export class CraftingMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #game: CraftingHost;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal, game: CraftingHost) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#game = game;
  }

  /** The workbench (FURN) of a base object, if it is one. */
  async workbench(base: number): Promise<{ bench: Workbench; type: CraftingMenuType } | undefined> {
    const runtime = this.#session.scriptsReady;
    const record = runtime && (await runtime.forms.record(base));
    const bench = record?.type === 'FURN' ? parseWorkbench(record) : undefined;
    const type = bench && craftingMenuOf(bench.type);
    return bench && type ? { bench, type } : undefined;
  }

  /**
   * Opens the menu of a workbench reference; `closed` once it has closed. Undefined if the
   * reference is no workbench (or the game does not run).
   */
  async open(
    reference: number,
    base: number,
    closed: () => void,
  ): Promise<{ readonly menu: Menu; readonly type: CraftingMenuType } | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const found = await this.workbench(base);
    if (!runtime || !found) return undefined;
    const { bench, type } = found;
    const settings = await session.settings();
    const text = (label: string): string =>
      label.startsWith('$')
        ? (this.#host.translate(label) ?? label)
        : (settings.string(label) ?? label);
    const context: ModelContext = {
      log: (message) => {
        this.#terminal.log('ui', message, 'warn');
      },
      session,
      runtime,
      settings,
      text,
      game: this.#game,
      bench,
      reference,
    };
    const model = await modelOf(type, context);
    const item3d = new Item3D(session, 'inventory');
    let entries = await model.entries();
    let selected: number | undefined;
    let categories = model.categories;
    let submenu: 'slider' | 'rename' | undefined;
    let done = false;
    const highlighted = (): Entry | undefined =>
      selected === undefined ? undefined : entries[selected];
    const log = (error: unknown): void => {
      this.#terminal.log(
        'ui',
        `the crafting menu: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    };
    const buttons = (menu: Menu): void => {
      menu.set(`${MENU}.ButtonText`, [...model.buttons()]);
      menu.invoke(`${MENU}.__set__bCanCraft`, model.canCraft());
      menu.invoke(`${MENU}.UpdateButtonText`);
    };
    /** The card and the line under it for the highlighted entry. */
    const showSelected = async (menu: Menu): Promise<void> => {
      const entry = highlighted();
      buttons(menu);
      if (!entry) return;
      const card = await model.card(entry);
      if (highlighted() !== entry) return;
      menu.invoke(`${MENU}.ItemInfo.__set__itemInfo`, card);
      const line = model.ingredients?.(entry);
      if (line) {
        menu.invoke(`${MENU}.UpdateIngredients`, line.title, line.lines, line.showCount);
      }
    };
    const fill = (menu: Menu): void => {
      menu.set(`${LIST}.entryList`, entries);
      menu.call('InvalidateListData');
    };
    const refresh = async (menu: Menu): Promise<void> => {
      entries = await model.entries();
      const changed = model.categoriesChanged?.();
      if (changed) {
        categories = changed;
        menu.invoke(`${MENU}.PreRebuildList`);
        menu.call('SetCategoriesList', ...categoriesListArgs(categories));
        fill(menu);
        menu.invoke(`${MENU}.PostRebuildList`, true);
      } else {
        fill(menu);
        menu.invoke(`${MENU}.UpdateItemList`, false);
      }
      menu.invoke(`${MENU}.UpdateItemDisplay`);
      await showSelected(menu);
    };
    const act = (menu: Menu, work: () => Promise<void>): void => {
      work()
        .then(() => refresh(menu))
        .catch(log);
    };
    const craft = (menu: Menu): void => {
      if (model.canCraft()) act(menu, () => model.craft?.() ?? Promise.resolve());
    };
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      item3d.hide();
      this.#host.close(menu);
      closed();
    };
    const leave = (menu: Menu): void => {
      const question = model.quitQuestion?.();
      if (!question) {
        close(menu);
        return;
      }
      const yes = settings.string('sYes') ?? 'Yes';
      const no = settings.string('sNo') ?? 'No';
      void this.#game.confirm(question, [yes, no]).then((answer) => {
        if (answer === 0) close(menu);
      });
    };
    const menu = await this.#host.open('craftingmenu.swf', {
      depth: CRAFTING_DEPTH,
      interactive: true,
      onKey: (opened, event) => {
        if (event.repeat || opened.typing) return false;
        if (event.code === 'Escape' || event.code === 'Tab') {
          // The card's slider and name field take Tab themselves.
          if (submenu) return false;
          leave(opened);
          return true;
        }
        if (event.code === 'KeyR') {
          craft(opened);
          return true;
        }
        if (event.code === 'KeyF') {
          if (model.aux?.(opened)) submenu = 'rename';
          return true;
        }
        return false;
      },
      handlers: {
        SetSelectedItem: (opened, args) => {
          const index = typeof args[1] === 'number' && args[1] >= 0 ? args[1] : undefined;
          selected = index !== undefined && index < entries.length ? index : undefined;
          showSelected(opened).catch(log);
        },
        SetSelectedCategory: () => undefined,
        ShowItem3D: (opened, args) => {
          void item3d.show(args[1] === true ? highlighted()?.formId : undefined, opened);
        },
        ChooseItem: (opened, args) => {
          const index = typeof args[1] === 'number' ? args[1] : selected;
          const entry = index === undefined ? undefined : entries[index];
          if (entry) act(opened, () => model.choose(entry));
        },
        // Single-panel only (no such panel in SE's movie): as ChooseItem.
        CraftSelectedItem: (opened, args) => {
          const index = typeof args[1] === 'number' ? args[1] : selected;
          const entry = index === undefined ? undefined : entries[index];
          if (entry) act(opened, () => model.choose(entry));
        },
        CraftButtonPress: (opened) => {
          craft(opened);
        },
        AuxButtonPress: (opened) => {
          if (model.aux?.(opened)) submenu = 'rename';
        },
        CanFadeItemInfo: (opened, args) => {
          opened.respond(args[0], !model.canCraft());
        },
        CalculateCharge: () => {
          submenu = 'slider';
        },
        SliderClose: () => {
          submenu = undefined;
        },
        EndItemRename: (opened, args) => {
          submenu = undefined;
          model.rename?.(args[1] === true && typeof args[2] === 'string' ? args[2] : undefined);
          showSelected(opened).catch(log);
        },
        StartMouseRotation: () => {
          item3d.startRotation();
        },
        StopMouseRotation: () => {
          item3d.stopRotation();
        },
        CloseMenu: (opened) => {
          leave(opened);
        },
      },
      setup: async (opened) => {
        await opened.waitFor(`${MENU}.Initialize`);
        opened.invoke(`${MENU}.gotoAndStop`, type.frame);
        opened.invoke(`${MENU}.Initialize`);
        opened.invoke('_root.SetPlatform', 0, false);
        opened.set(`${MENU}.MenuName.text`, model.name);
        opened.set(`${MENU}.MenuDescription.text`, settings.string(type.description) ?? '');
        // The line under the card shows nothing until an entry is highlighted (the movie's own
        // text is a placeholder).
        opened.set(`${MENU}.AdditionalDescription.text`, '');
        opened.call('SetCategoriesList', ...categoriesListArgs(categories));
        if (model.partitioned) opened.invoke(`${MENU}.SetPartitionedFilterMode`, true);
        fill(opened);
        buttons(opened);
        await skillBar(opened, runtime, bench);
      },
    });
    return { menu, type };
  }
}

/** The bottom bar's skill: the workbench's (WBDT), else none shown. */
async function skillBar(menu: Menu, runtime: ScriptRuntime, bench: Workbench): Promise<void> {
  if (bench.skill === undefined) {
    menu.invoke(`${MENU}.BottomBarInfo.HidePlayerInfo`);
    return;
  }
  const value = await runtime.actors.value(PLAYER_REF, bench.skill);
  const name = (await runtime.forms.actorValueForm(bench.skill))?.text('FULL') ?? '';
  // TODO(M11): the progress toward the skill's next level (its experience).
  menu.invoke(`${MENU}.BottomBarInfo.UpdateCraftingInfo`, name, Math.floor(value.current), 0);
}

interface ModelContext {
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

async function modelOf(type: CraftingMenuType, context: ModelContext): Promise<CraftingModel> {
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

/** A UI sound by editor id, at no place. */
function uiSound(session: GameSession, name: string): void {
  void session.sounds().then((sounds) => sounds.playNamed(name, undefined));
}

/** The skill's experience for a use (TODO(M11): the skill's experience counts). */
function skillUse(runtime: ScriptRuntime, bench: Workbench, use: number): void {
  if (bench.skill !== undefined && use > 0) runtime.advanceSkill(actorValueName(bench.skill), use);
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
      skillUse(runtime, bench, constructibleSkillUse((made?.value ?? 0) * recipe.createdCount));
      await craftEvent(context, recipe.created);
    },
    canCraft: () => false,
  };
}

/**
 * The story manager's craft event (OnStoryCraftItem(akBench, akLocation, akCreatedItem)): the
 * workbench, the created object (TODO(M13): check the members against the Creation Kit: the
 * location is left out).
 */
async function craftEvent(context: ModelContext, created: number): Promise<void> {
  const { runtime, reference } = context;
  const event: StoryEventData = {
    type: 'CRFT',
    forms: new Map([
      ['R1', reference],
      ['O1', created],
    ]),
    values: new Map(),
    args: [runtime.referenceHandle(reference), null, runtime.formHandle(created)],
  };
  await runtime.storyManager.event(event);
}

// --- Smithing -----------------------------------------------------------------------------------

async function smithingModel(
  context: ModelContext,
  improves: 'WEAP' | 'ARMO',
): Promise<CraftingModel> {
  const { session, runtime, settings, text, bench, game } = context;
  const index = await recipeIndex(await session.db);
  const benchRecipes = index.forWorkbench(bench.keywords);
  const item = itemReader(runtime);
  const player = runtime.referenceHandle(PLAYER_REF);
  const health = runtime.state.itemHealth;
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
  const levelOf = (formId: number): number => temperLevelOfHealth(health.get(formId) ?? 1);
  const named = (record: ItemRecord): string => {
    const quality = temperQualityName(levelOf(record.formId), improves);
    const prefix = quality === undefined ? undefined : settings.string(quality);
    return prefix ? `${record.name} (${prefix})` : record.name;
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
      const items: { base: number; record: ItemRecord; count: number }[] = [];
      for (const [formId, count] of inventory) {
        if (count <= 0) continue;
        const record = await item(formId);
        if (record?.type !== improves || record.nonPlayable || record.name === '') continue;
        items.push({ base: formId, record, count });
      }
      const entries: Entry[] = [];
      for (const { item: candidate, recipe } of temperingCandidates(items, benchRecipes)) {
        recipeFor.set(candidate.base, recipe);
        for (const component of recipe.components) await nameOf(component.item);
        entries.push({
          text: named(candidate.record),
          count: candidate.count,
          filterFlag: 1,
          enabled: true,
          formId: candidate.base,
        });
      }
      return entries;
    },
    card: async (entry) => {
      const record = await item(entry.formId);
      if (!record) return { type: CardType.none };
      const card = await itemCard(runtime, settings, {
        formId: entry.formId,
        item: record,
        count: entry.count ?? 1,
        worn: false,
        favorite: false,
      });
      const level = levelOf(entry.formId);
      card.name = named(record);
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
      if (!(await runtime.conditionsHold(recipe.conditions, player))) {
        game.notify(
          text(
            record.enchantment === undefined
              ? 'sLackRequiredPerksToImprove'
              : 'sLackRequiredPerkToImproveMagical',
          ),
        );
        return;
      }
      if (!recipe.components.every((component) => have(component.item) >= component.count)) {
        game.notify(text('sLackRequiredToImprove'));
        return;
      }
      const skill = await runtime.actors.value(PLAYER_REF, SMITHING);
      // TODO(M11): the smithing perks of the item's material (doubling the improvement) and
      // Fortify Smithing.
      const level = temperingQualityLevel(
        temperingEffectiveSkill({ skill: skill.current, perk: false }),
      );
      const current = levelOf(entry.formId);
      if (!canImprove(current, level)) {
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
      health.set(entry.formId, temperHealth(level));
      uiSound(session, improves === 'WEAP' ? 'UISmithingImproveWeapon' : 'UISmithingImproveArmor');
      skillUse(runtime, bench, temperingSkillUse(record.value, level - current));
    },
    canCraft: () => false,
  };
}

// --- Enchanting ---------------------------------------------------------------------------------

/**
 * ENCH ENIT (UESP; 36 bytes in SSE): cost, flags, cast type (u32 at 8: 0 constant effect, 1 fire
 * and forget, 2 concentration), amount, target type, enchant type, charge time, base enchantment
 * (form id at 28), worn restrictions.
 */
const CONSTANT_EFFECT = 0;
const ENIT_CAST_TYPE = 8;
const ENIT_BASE_ENCHANTMENT = 28;

async function enchantingModel(context: ModelContext): Promise<CraftingModel> {
  const { session, runtime, settings, text, game } = context;
  const item = itemReader(runtime);
  const defaults = await session.defaultObjects();
  /** MagicDisallowEnchanting (DOBJ DIEN): items and enchantments that cannot be learned. */
  const disallowed = defaults.get('DIEN');
  const known = runtime.state.knownEnchantments;
  const chosen: { item?: number; gem?: number; enchantments: number[] } = { enchantments: [] };
  let name: string | undefined;
  const enchantment = async (
    formId: number,
  ): Promise<{ name: string; armor: boolean; base: number; keywords: number[] } | undefined> => {
    const record = await runtime.forms.record(formId);
    if (record?.type !== 'ENCH') return undefined;
    const enit = record.fields.first('ENIT');
    const view = enit && new DataView(enit.buffer, enit.byteOffset, enit.byteLength);
    const castType =
      view && view.byteLength >= ENIT_CAST_TYPE + 4
        ? view.getUint32(ENIT_CAST_TYPE, true)
        : CONSTANT_EFFECT;
    // The base enchantment: what disenchanting learns.
    const base =
      enit && enit.length >= ENIT_BASE_ENCHANTMENT + 4
        ? record.formIdAt(enit.subarray(ENIT_BASE_ENCHANTMENT, ENIT_BASE_ENCHANTMENT + 4))
        : 0;
    return {
      name: record.text('FULL') ?? '',
      armor: castType === CONSTANT_EFFECT,
      base: base !== 0 ? base : formId,
      keywords: record.fields.all('KWDA').flatMap((data) => {
        const ids: number[] = [];
        for (let at = 0; at + 4 <= data.length; at += 4)
          ids.push(record.formIdAt(data.subarray(at, at + 4)));
        return ids;
      }),
    };
  };
  const kindOf = (entry: Entry): EnchantingEntryKind | undefined =>
    typeof entry.kind === 'string' ? (entry.kind as EnchantingEntryKind) : undefined;
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
            const learned = await enchantment(record.enchantment);
            if (!learned || (disallowed !== undefined && learned.keywords.includes(disallowed)))
              continue;
            if (disallowed !== undefined && record.keywords.includes(disallowed)) continue;
            entries.push({
              text: record.name,
              count,
              filterFlag: enchantingFilterFlag('disenchant', armor),
              enabled: true,
              formId,
              kind: 'disenchant',
            });
          } else {
            entries.push({
              text: record.name,
              count,
              filterFlag: enchantingFilterFlag('item', armor),
              enabled: true,
              equipState: chosen.item === formId ? 1 : 0,
              formId,
              kind: 'item',
            });
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
        const learned = await enchantment(formId);
        if (!learned) continue;
        entries.push({
          text: learned.name,
          filterFlag: enchantingFilterFlag('enchantment', learned.armor),
          enabled: true,
          equipState: chosen.enchantments.includes(formId) ? 1 : 0,
          formId,
          kind: 'enchantment',
        });
      }
      return entries;
    },
    card: async (entry) => {
      if (kindOf(entry) === 'enchantment') {
        const record = await runtime.forms.record(entry.formId);
        const effects = record?.type === 'ENCH' ? parseEffects(record) : [];
        return {
          type: CardType.craftEnchanting,
          name: entry.text,
          effects: await effectsText(runtime, effects),
          usedCharge: 0,
          totalCharges: 0,
        };
      }
      const record = await item(entry.formId);
      if (!record) return { type: CardType.none };
      const card = await itemCard(runtime, settings, {
        formId: entry.formId,
        item: record,
        count: entry.count ?? 1,
        worn: false,
        favorite: false,
      });
      if (kindOf(entry) === 'item' && name !== undefined && chosen.item === entry.formId) {
        card.name = name;
      }
      return card;
    },
    choose: async (entry) => {
      const kind = kindOf(entry);
      if (kind === 'disenchant') {
        const record = await item(entry.formId);
        const learned =
          record?.enchantment === undefined ? undefined : await enchantment(record.enchantment);
        if (!record || !learned) return;
        if (known.has(learned.base)) {
          game.notify(text('sEnchantmentKnown'));
          return;
        }
        const answer = await game.confirm(text('sConfirmDisenchant'), [text('sYes'), text('sNo')]);
        if (answer !== 0) return;
        known.add(learned.base);
        await runtime.removeItem(PLAYER_REF, runtime.formHandle(entry.formId), 1, true, undefined);
        uiSound(session, 'UIEnchantingItemDestroy');
        uiSound(session, 'UIEnchantingLearnEffect');
        const baseName = (await enchantment(learned.base))?.name ?? learned.name;
        game.notify(text('sEnchantmentsLearned').replace('%s', baseName));
        // TODO(M11): the skill's experience for disenchanting (disenchantSkillUse).
        return;
      }
      if (kind === 'item') {
        chosen.item = chosen.item === entry.formId ? undefined : entry.formId;
        name = undefined;
      } else if (kind === 'soulGem') {
        chosen.gem = chosen.gem === entry.formId ? undefined : entry.formId;
      } else if (kind === 'enchantment') {
        const at = chosen.enchantments.indexOf(entry.formId);
        if (at >= 0) chosen.enchantments.splice(at, 1);
        // TODO(M11): the Extra Effect perk (two enchantments).
        else if (chosen.enchantments.length < enchantmentsAllowed(false)) {
          chosen.enchantments.push(entry.formId);
        }
      }
      uiSound(session, 'UIMenuFocus');
    },
    canCraft: () =>
      chosen.item !== undefined && chosen.gem !== undefined && chosen.enchantments.length > 0,
    // TODO(M11): making the enchanted item (a form made in the game: its enchantment's
    // magnitude from the skill and the soul, the weapon's charge slider, its name), the soul
    // gem used up, the skill's experience, UIEnchantingItemCreate.
    craft: async () => {
      const answer = await game.confirm(text('sEnchantItem'), [text('sYes'), text('sNo')]);
      if (answer !== 0) return;
      context.log('making enchanted items is not built yet (M11)');
    },
    aux: (menu) => {
      if (chosen.item === undefined) return false;
      menu.invoke(`${MENU}.EditItemName`, name ?? '', MAX_ITEM_NAME);
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
      for (const [formId, count] of await runtime.inventory(PLAYER_REF)) {
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
    craft: async () => {
      const records = await Promise.all(chosen.map((formId) => item(formId)));
      const effects = records.map((record) => record?.effects.map((effect) => effect.effect) ?? []);
      const shared = new Set(sharedEffects(effects));
      if (shared.size === 0) {
        uiSound(session, 'UIAlchemyFail');
        game.notify(text('sPotionCreationFailed'));
        return;
      }
      // What they share is found out on each of them.
      for (const [i, formId] of chosen.entries()) {
        const slots = new Set(knownSlots(formId));
        for (const [slot, effect] of (effects[i] ?? []).entries()) {
          if (shared.has(effect)) slots.add(slot);
        }
        known.set(formId, slots);
      }
      uiSound(session, 'UIAlchemyLearnEffect');
      // TODO(M11): the potion or poison made (a form made in the game: named after its
      // strongest effect, sCreatedPotionNamePrefix / sCreatedPoisonNamePrefix; its strength
      // from the skill and perks), the ingredients used up, UIAlchemyCreatePotion /
      // UIAlchemyCreatePoison, the skill's experience.
      chosen.length = 0;
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
