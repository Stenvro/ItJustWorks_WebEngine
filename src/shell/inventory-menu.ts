// The player's inventory in the game's own menu (interface\inventorymenu.swf). Before it opens,
// the engine reads the player's items (their records, counts, what is worn, favorites) and
// each item's card; the menu then asks for them during its calls (answered at once). The engine
// sends the categories (SetCategoriesList), fills the items list's entryList and calls
// InvalidateListData, sends the player's info (UpdatePlayerInfo), and acts on the menu's calls:
// ItemSelect (equip or unequip; TODO(M11): use, eat, read, equip to a hand), ItemDrop,
// SaveIndices, ShowTweenMenu / CloseTweenMenu, CloseMenu once its fade has played. The engine's
// keys in the menu: F (favorite), R (drop), T (charge), Esc as Tab, E as Enter (the control
// map's menu contexts). Notes: docs/ui.md ("The item menus").

import {
  CardType,
  EquipState,
  INVENTORY_CATEGORIES,
  ItemCategory,
  SOUL_LEVEL_SETTINGS,
  armorSkill,
  itemCardType,
  itemCategory,
} from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import {
  parseEffects,
  parseItem,
  type ItemEffect,
  type ItemRecord,
} from '../world/item-records.ts';
import { effectText, EffectFlag, parseMagicEffect } from '../world/magic-effects.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** The items list (InventoryLists_mc.ItemsList). */
const LIST = '_root.Menu_mc.InventoryLists_mc.ItemsListHolder.List_mc';
/** The menu's depth among the game's menus. */
const INVENTORY_DEPTH = 6;
/** Gold (Gold001): its count is the player's gold. */
const GOLD = 0xf;
/** The first actor value's AVIF (actor value names: AVIF 0x3E8 + index). */
const AVIF_BASE = 0x3e8;

/** An item row of the menu, with what the engine keeps of it. */
interface Row {
  readonly formId: number;
  readonly item: ItemRecord;
  readonly count: number;
  readonly worn: boolean;
  readonly favorite: boolean;
}

/** What the menu asks while it is open, read before (it asks during its calls). */
interface InventoryView {
  readonly rows: readonly Row[];
  readonly cards: ReadonlyMap<number, Record<string, unknown>>;
  readonly player: Record<string, unknown>;
}

export class InventoryMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  /** The list positions it was left at (SaveIndices), restored as it opens. */
  #indices: unknown[] | undefined;
  readonly #favorites = new Set<number>();
  readonly #items = new Map<number, ItemRecord | undefined>();
  /** The tween menu asked for as it closes (Left, or the exit area). */
  onTween: (() => void) | undefined;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Opens the inventory; `closed` once its fade has played out (CloseMenu). */
  async open(closed: () => void): Promise<Menu> {
    const runtime = this.#session.scriptsReady;
    const settings = await this.#session.settings();
    let view = runtime ? await this.#view(runtime, settings) : emptyView();
    let backToTween = false;
    let done = false;
    const refresh = async (menu: Menu): Promise<void> => {
      if (!runtime) return;
      view = await this.#view(runtime, settings);
      menu.set(`${LIST}.entryList`, entries(view.rows));
      menu.call('InvalidateListData');
      menu.call('UpdatePlayerInfo', view.player);
    };
    const selected = (menu: Menu): Row | undefined => {
      const formId = menu.get(`${LIST}.selectedEntry.formId`);
      return view.rows.find((row) => row.formId === formId);
    };
    return this.#host.open('inventorymenu.swf', {
      depth: INVENTORY_DEPTH,
      interactive: true,
      keyAs: { Escape: 'Tab', KeyE: 'Enter' },
      onKey: (menu, event) => {
        if (event.code !== 'KeyF' || event.repeat) return false;
        const row = selected(menu);
        if (!row) return false;
        if (this.#favorites.has(row.formId)) this.#favorites.delete(row.formId);
        else this.#favorites.add(row.formId);
        void refresh(menu);
        return true;
      },
      handlers: {
        RequestItemCardInfo: (menu, args) => {
          const row = selected(menu);
          menu.respond(args[0], row ? (view.cards.get(row.formId) ?? {}) : {});
        },
        ItemSelect: (menu) => {
          const row = selected(menu);
          if (!row || !runtime) return;
          void this.#select(runtime, row).then(() => refresh(menu));
        },
        ItemDrop: (menu, args) => {
          const row = selected(menu);
          const amount = typeof args[1] === 'number' ? args[1] : 1;
          if (!row || !runtime) return;
          // TODO(M11): the dropped item placed in the world at the player's feet.
          void runtime
            .removeItem(PLAYER_REF, runtime.formHandle(row.formId), amount, false, undefined)
            .then(() => refresh(menu));
        },
        SaveIndices: (_menu, args) => {
          this.#indices = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
        },
        ShowTweenMenu: () => {
          backToTween = true;
        },
        CloseTweenMenu: () => {
          backToTween = false;
        },
        CloseMenu: (menu) => {
          if (done) return;
          done = true;
          this.#host.close(menu);
          closed();
          if (backToTween) this.onTween?.();
        },
        // TODO(M9): the item's 3D model behind the card (rotated and zoomed by the mouse).
        UpdateItem3D: () => undefined,
        StartMouseRotation: () => undefined,
        StopMouseRotation: () => undefined,
        ZoomItemModel: () => undefined,
        CheckForMouseEquip: () => undefined,
        QuantitySliderOpen: () => undefined,
        // TODO(M11): recharging an enchanted weapon with a soul gem.
        ShowSoulGemList: () => undefined,
        ItemCardListCallback: () => undefined,
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        menu.call(
          'SetCategoriesList',
          ...INVENTORY_CATEGORIES.flatMap((category) => [
            settings.string(category.setting) ?? category.setting,
            category.flag,
            category.alwaysShown,
          ]),
        );
        menu.set(`${LIST}.entryList`, entries(view.rows));
        menu.call('InvalidateListData');
        menu.call('UpdatePlayerInfo', view.player);
        if (this.#indices) menu.call('RestoreIndices', ...this.#indices);
      },
    });
  }

  /** ItemSelect: armor and weapons are worn or taken off (TODO(M11): the equip system). */
  async #select(runtime: ScriptRuntime, row: Row): Promise<void> {
    if (row.item.type !== 'ARMO' && row.item.type !== 'WEAP' && row.item.type !== 'AMMO') {
      this.#terminal.log('ui', `using ${row.item.name} is not built yet`, 'warn');
      return;
    }
    const actor = runtime.state.actor(PLAYER_REF);
    const handle = runtime.formHandle(row.formId);
    if (row.worn) {
      actor.equipped.delete(row.formId);
      runtime.world.equipmentChanged?.(PLAYER_REF);
      await runtime.sendEvent(PLAYER_REF, 'OnObjectUnequipped', [handle, null]);
    } else {
      actor.equipped.add(row.formId);
      runtime.world.equipmentChanged?.(PLAYER_REF);
      await runtime.sendEvent(PLAYER_REF, 'OnObjectEquipped', [handle, null]);
    }
  }

  /** The player's items, their cards and the player's info, as the menu shows them now. */
  async #view(runtime: ScriptRuntime, settings: GameSettings): Promise<InventoryView> {
    const inventory = await runtime.inventory(PLAYER_REF);
    const worn = new Set([
      ...(await runtime.actors.worn(PLAYER_REF)),
      ...runtime.state.actor(PLAYER_REF).equipped,
    ]);
    const rows: Row[] = [];
    for (const [formId, count] of inventory) {
      if (count <= 0 || formId === GOLD) continue;
      const item = await this.#item(runtime, formId);
      if (!item || item.nonPlayable || item.name === '') continue;
      rows.push({
        formId,
        item,
        count,
        worn: worn.has(formId),
        favorite: this.#favorites.has(formId),
      });
    }
    const cards = new Map<number, Record<string, unknown>>();
    for (const row of rows) cards.set(row.formId, await this.#card(runtime, settings, row));
    return { rows, cards, player: await this.#playerInfo(runtime, rows, inventory.get(GOLD) ?? 0) };
  }

  async #item(runtime: ScriptRuntime, formId: number): Promise<ItemRecord | undefined> {
    if (!this.#items.has(formId)) {
      const record = await runtime.forms.record(formId);
      this.#items.set(formId, record ? parseItem(record) : undefined);
    }
    return this.#items.get(formId);
  }

  /** An item's card (UpdateItemCardInfo): its type's fields. */
  async #card(
    runtime: ScriptRuntime,
    settings: GameSettings,
    row: Row,
  ): Promise<Record<string, unknown>> {
    const { item } = row;
    const type = itemCardType(item);
    const card: Record<string, unknown> = {
      type,
      name: item.name,
      count: row.count,
      value: item.value,
      weight: item.weight,
      favorite: row.favorite,
      stolen: false,
    };
    const enchantment =
      item.enchantment === undefined
        ? []
        : await this.#enchantmentEffects(runtime, item.enchantment);
    switch (type) {
      case CardType.armor: {
        card.armor = Math.floor(item.armor?.rating ?? 0);
        card.effects = await this.#effectsText(runtime, enchantment);
        const skill = armorSkill(item);
        card.skillText =
          skill === undefined
            ? ''
            : ((await runtime.forms.record(AVIF_BASE + skill))?.text('FULL') ?? '');
        break;
      }
      case CardType.weapon:
        card.damage = Math.floor(item.weapon?.damage ?? item.ammoDamage ?? 0);
        card.effects = await this.#effectsText(runtime, enchantment);
        card.poisoned = false;
        break;
      case CardType.book:
        card.description = item.book?.description ?? '';
        break;
      case CardType.potion:
      case CardType.food:
        card.effects = await this.#effectsText(runtime, item.effects);
        card.skillName = '';
        break;
      case CardType.spell:
        card.effects = await this.#effectsText(runtime, item.effects);
        card.spellCost = 0;
        break;
      case CardType.ingredient:
        // TODO(M11): the effects the player has found out (by eating, by alchemy).
        card.numItemEffects = item.effects.length;
        break;
      case CardType.soulGem: {
        const soul = SOUL_LEVEL_SETTINGS[item.soul?.current ?? 0];
        card.soulLVL = soul ? (settings.string(soul) ?? '') : '';
        break;
      }
      default:
        break;
    }
    return card;
  }

  async #enchantmentEffects(runtime: ScriptRuntime, formId: number): Promise<ItemEffect[]> {
    const record = await runtime.forms.record(formId);
    return record?.type === 'ENCH' ? parseEffects(record) : [];
  }

  /** The effects' descriptions with their values, those hidden from the interface left out. */
  async #effectsText(runtime: ScriptRuntime, effects: readonly ItemEffect[]): Promise<string> {
    const texts: string[] = [];
    for (const effect of effects) {
      const record = await runtime.forms.record(effect.effect);
      if (record?.type !== 'MGEF') continue;
      const magic = parseMagicEffect(record);
      if ((magic.flags & EffectFlag.hideInUi) !== 0 || magic.description === '') continue;
      texts.push(effectText(magic, effect.magnitude, effect.duration, effect.area));
    }
    return texts.join(' ');
  }

  /** UpdatePlayerInfo: carried weight and its limit, gold, armor, damage, the meters. */
  async #playerInfo(
    runtime: ScriptRuntime,
    rows: readonly Row[],
    gold: number,
  ): Promise<Record<string, unknown>> {
    const value = (index: number) => runtime.actors.value(PLAYER_REF, index);
    const [health, magicka, stamina, carry] = await Promise.all([
      value(ActorValue.health),
      value(ActorValue.magicka),
      value(ActorValue.stamina),
      value(ActorValue.carryWeight),
    ]);
    let encumbrance = 0;
    let armor = 0;
    let damage = 0;
    for (const row of rows) {
      encumbrance += row.item.weight * row.count;
      if (row.worn && row.item.armor) armor += row.item.armor.rating;
      if (row.worn && row.item.weapon) damage = Math.max(damage, row.item.weapon.damage);
    }
    // TODO(M11): armor and damage with the player's skills and perks.
    return {
      encumbrance,
      maxEncumbrance: carry.current,
      gold,
      armor: Math.floor(armor),
      damage: Math.floor(damage),
      health: health.current,
      maxHealth: health.max,
      magicka: magicka.current,
      maxMagicka: magicka.max,
      stamina: stamina.current,
      maxStamina: stamina.max,
    };
  }
}

function emptyView(): InventoryView {
  return { rows: [], cards: new Map(), player: {} };
}

/** The list's entries: name, count, the worn icon, favorite, category bits (+ favorites). */
function entries(rows: readonly Row[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    text: row.item.name,
    count: row.count,
    equipState: row.worn ? EquipState.equipped : EquipState.none,
    favorite: row.favorite,
    filterFlag: itemCategory(row.item) | (row.favorite ? ItemCategory.favorites : 0),
    enabled: true,
    formId: row.formId,
  }));
}
