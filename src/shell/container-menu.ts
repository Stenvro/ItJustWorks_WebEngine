// A container's items beside the player's (interface\containermenu.swf), as a model of the
// item menus (item-menu.ts): a chest, a barrel, a corpse searched. Its categories list the
// container's first, then a divider (a category with no bits), then the player's: the movie
// is "viewing the container" while a category above the divider is selected, and only tests
// the bits, so the container's are the inventory's moved up by CONTAINER_SHIFT. Taking (E) and
// storing (R on the player's side) move items (ItemTransfer: the amount, from the container);
// R on the container's side takes everything (TakeAllItems); equipping a container's item
// takes it first. The items' pick-up and put-down sounds play as they move. The barter and
// gift menus list the same way (sideCategories, ItemShelf). TODO(M11): stealing (owned
// containers: sStealFrom, the steal chance), quest items that cannot be stored.
// Notes: docs/ui.md ("The item menus").

import { INVENTORY_CATEGORIES, ItemCategory, itemSound } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { parseItem, type ItemRecord } from '../world/item-records.ts';
import type { GameSession } from './game-session.ts';
import { itemCard, itemEntry, itemRows, playerInfo, GOLD, type Row } from './inventory-menu.ts';
import type { ItemEntry, ItemMenuModel } from './item-menu.ts';

/** The other side's category bits (container, vendor): the inventory's, this far up. */
export const CONTAINER_SHIFT = 10;

/**
 * SetCategoriesList's arguments for two sides: the other side's categories (the inventory's
 * but Favorites, their bits moved up), a divider (no bits), then the player's.
 */
export function sideCategories(settings: GameSettings): unknown[] {
  const label = (setting: string): string => settings.string(setting) ?? setting;
  return [
    ...INVENTORY_CATEGORIES.filter((category) => category.flag !== ItemCategory.favorites).flatMap(
      (category) => [
        label(category.setting),
        category.flag << CONTAINER_SHIFT,
        category.alwaysShown,
      ],
    ),
    '',
    0,
    true,
    ...INVENTORY_CATEGORIES.flatMap((category) => [
      label(category.setting),
      category.flag,
      category.alwaysShown,
    ]),
  ];
}

/** The other side's entry for a row: its bits moved up, marked as the container's. */
export function otherSideEntry(row: Row): ItemEntry {
  const entry = itemEntry(row);
  return {
    ...entry,
    filterFlag: (entry.filterFlag as number) << CONTAINER_SHIFT,
    container: true,
  };
}

/** Reading items and moving them between inventories, as the item menus that trade do. */
export class ItemShelf {
  readonly #session: GameSession;
  readonly #items = new Map<number, ItemRecord | undefined>();

  constructor(session: GameSession) {
    this.#session = session;
  }

  get runtime(): ScriptRuntime {
    const ready = this.#session.scriptsReady;
    if (!ready) throw new Error('the game is not running');
    return ready;
  }

  async item(formId: number): Promise<ItemRecord | undefined> {
    if (!this.#items.has(formId)) {
      const record = await this.runtime.forms.record(formId);
      this.#items.set(formId, record ? parseItem(record) : undefined);
    }
    return this.#items.get(formId);
  }

  /** A container's rows (as the item menus list them). */
  async rows(container: number): Promise<Row[]> {
    const game = this.runtime;
    return itemRows(game, container, await game.inventory(container), (id) => this.item(id));
  }

  /** The cards of rows, in their order. */
  async cards(rows: readonly Row[]): Promise<Record<string, unknown>[]> {
    const settings = await this.#session.settings();
    const cards: Record<string, unknown>[] = [];
    for (const row of rows) cards.push(await itemCard(this.runtime, settings, row));
    return cards;
  }

  /** The player's info (UpdatePlayerInfo's object) with their rows. */
  async playerInfo(rows: readonly Row[]): Promise<Record<string, unknown>> {
    const game = this.runtime;
    return playerInfo(game, rows, await game.itemCount(PLAYER_REF, GOLD));
  }

  /**
   * Moves items from one inventory to another: what the player no longer has is no longer
   * worn; the item's sound plays (picked up as the player gets it, else put down).
   */
  async move(formId: number, amount: number, from: number, to: number, audible = true) {
    const game = this.runtime;
    await game.removeItem(from, game.formHandle(formId), amount, true, to);
    if (from === PLAYER_REF) {
      const actor = game.state.actor(PLAYER_REF);
      if ((await game.itemCount(PLAYER_REF, formId)) <= 0 && actor.equipped.delete(formId)) {
        game.world.equipmentChanged?.(PLAYER_REF);
        await game.sendEvent(PLAYER_REF, 'OnObjectUnequipped', [game.formHandle(formId), null]);
      }
    }
    if (!audible) return;
    const record = await this.item(formId);
    const sounds = this.#session.soundSystem;
    const sound = record && sounds && itemSound(record, to === PLAYER_REF, sounds.defaults);
    if (sound !== undefined) void sounds?.play(sound);
  }
}

export function containerModel(
  session: GameSession,
  container: number,
  /** The inventory's model: what selecting and favoring the player's entries does. */
  inventory: ItemMenuModel,
  /** An actor's inventory opened for trading (OpenInventory): give, no take all. */
  npcMode = false,
): ItemMenuModel {
  const shelf = new ItemShelf(session);
  const move = (formId: number, amount: number, fromContainer: boolean, audible = true) =>
    fromContainer
      ? shelf.move(formId, amount, container, PLAYER_REF, audible)
      : shelf.move(formId, amount, PLAYER_REF, container, audible);
  return {
    movie: 'containermenu.swf',
    depth: 6,
    keepsIndices: false,
    ...(npcMode && { menuProperties: { bNPCMode: true } }),
    categories: async () => sideCategories(await session.settings()),
    view: async () => {
      const [theirs, mine] = await Promise.all([shelf.rows(container), shelf.rows(PLAYER_REF)]);
      return {
        entries: [...theirs.map(otherSideEntry), ...mine.map(itemEntry)],
        cards: await shelf.cards([...theirs, ...mine]),
        player: [await shelf.playerInfo(mine)],
      };
    },
    select: async (entry, slot) => {
      if (entry.container) {
        await move(entry.formId, 1, true);
        return;
      }
      await inventory.select(entry, slot);
    },
    favorite: (entry) => {
      if (!entry.container) inventory.favorite(entry);
    },
    transfer: (entry, amount, fromContainer) => move(entry.formId, amount, fromContainer),
    // One sound for all of them: the first item's.
    takeAll: async () => {
      if (npcMode) return;
      let first = true;
      for (const [formId, count] of [...(await shelf.runtime.inventory(container))]) {
        const record = await shelf.item(formId);
        if (count <= 0 || !record || record.nonPlayable || record.name === '') continue;
        await move(formId, count, true, first);
        first = false;
      }
    },
  };
}
