// A container's items beside the player's (interface\containermenu.swf), as a model of the
// item menus (item-menu.ts): a chest, a barrel, a corpse searched. Its categories list the
// container's first, then a divider (a category with no bits), then the player's: the movie
// is "viewing the container" while a category above the divider is selected, and only tests
// the bits, so the container's are the inventory's moved up by CONTAINER_SHIFT. Taking (E) and
// storing (R on the player's side) move items (ItemTransfer: the amount, from the container);
// R on the container's side takes everything (TakeAllItems); equipping a container's item
// takes it first. The items' pick-up and put-down sounds play as they move. The barter and
// gift menus list the same way (sideCategories, ItemShelf). An owned container's items are
// stolen as they are taken (its entries red: isStealing; crime-engine.ts steal). In pickpocket
// mode (an actor's pockets, sneaking) each card shows the chance to take or place it
// (pickpocketChance: "TO STEAL", "TO PLACE"); each move is an attempt, and one that fails
// closes the menu (crime-engine.ts pickpocket); what it wears or holds shows only with the
// perks that let it be taken (Can Pickpocket Equipped Item). TODO(M11): quest items that cannot
// be stored.
// Notes: docs/ui.md ("The item menus").

import { INVENTORY_CATEGORIES, ItemCategory, itemSound } from '../gameplay/inventory.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
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

/** An entry's stack of improved items (ItemEntry.stack), if it is one. */
export function entryStack(entry: ItemEntry): number | undefined {
  return typeof entry.stack === 'number' ? entry.stack : undefined;
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
   * Moves items from one inventory to another (what one no longer has enough of comes off, an
   * NPC takes up what suits it: the equip system); the item's sound plays (picked up as the
   * player gets it, else put down).
   */
  async move(
    formId: number,
    amount: number,
    from: number,
    to: number,
    audible = true,
    /** Which of the item's stacks (an improved one: an entry's `stack`) moves. */
    stack?: number,
  ) {
    const game = this.runtime;
    await game.removeItem(from, game.formHandle(formId), amount, true, to, stack);
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
  /** An actor's pockets picked (sneaking): every move an attempt by its chance. */
  pickpocket = false,
): ItemMenuModel {
  const shelf = new ItemShelf(session);
  let close: (() => void) | undefined;
  /** Taking from it is stealing: an owned container (not an actor's: a corpse, a follower). */
  let owned: Promise<boolean> | undefined;
  const stealing = (): Promise<boolean> => {
    owned ??= (async () => {
      if (npcMode || pickpocket) return false;
      const game = shelf.runtime;
      if (await game.actors.isActor(container)) return false;
      return !(await game.crime.mayTake(PLAYER_REF, container));
    })();
    return owned;
  };
  const move = async (
    formId: number,
    amount: number,
    fromContainer: boolean,
    audible = true,
    /** The entry's stack (an improved item), if it is one. */
    stack?: number,
  ): Promise<void> => {
    const crime = shelf.runtime.crime;
    if (pickpocket) {
      const done = await crime.pickpocket(PLAYER_REF, container, formId, amount, !fromContainer);
      if (!done) close?.();
      return;
    }
    if (!fromContainer) {
      await shelf.move(formId, amount, PLAYER_REF, container, audible, stack);
      return;
    }
    await shelf.move(formId, amount, container, PLAYER_REF, audible, stack);
    if (await stealing()) await crime.steal(PLAYER_REF, formId, amount, container);
  };
  /** A card with its pickpocket chance (to take one, or to place one). */
  const withChance = async (
    card: Record<string, unknown>,
    formId: number,
  ): Promise<Record<string, unknown>> =>
    pickpocket
      ? {
          ...card,
          pickpocketChance: await shelf.runtime.crime.pickpocketChance(
            PLAYER_REF,
            container,
            formId,
            1,
          ),
        }
      : card;
  return {
    movie: 'containermenu.swf',
    depth: 6,
    keepsIndices: false,
    ...(npcMode && { menuProperties: { bNPCMode: true } }),
    categories: async () => sideCategories(await session.settings()),
    bindClose: (closeMenu) => {
      close = closeMenu;
    },
    view: async () => {
      const [all, mine] = await Promise.all([shelf.rows(container), shelf.rows(PLAYER_REF)]);
      // Pockets: what it wears or holds only with the perks (Can Pickpocket Equipped Item:
      // Misdirection its weapons, Perfect Touch anything but an essential's).
      const theirs: typeof all = [];
      for (const row of all) {
        const equipped =
          pickpocket &&
          row.worn &&
          (await shelf.runtime.perks.apply(EntryPoint.canPickpocketEquippedItem, PLAYER_REF, 0, [
            container,
            row.formId,
          ])) === 0;
        if (!equipped) theirs.push(row);
      }
      const red = pickpocket || (await stealing());
      const rows = [...theirs, ...mine];
      const cards = await shelf.cards(rows);
      return {
        entries: [
          ...theirs.map((row) => ({ ...otherSideEntry(row), ...(red && { isStealing: true }) })),
          ...mine.map(itemEntry),
        ],
        cards: await Promise.all(
          cards.map((card, index) => withChance(card, rows[index]?.formId ?? 0)),
        ),
        player: [await shelf.playerInfo(mine)],
      };
    },
    select: async (entry, slot) => {
      if (entry.container) {
        await move(entry.formId, 1, true, true, entryStack(entry));
        return;
      }
      await inventory.select(entry, slot);
    },
    favorite: (entry) => {
      if (!entry.container) inventory.favorite(entry);
    },
    transfer: (entry, amount, fromContainer) =>
      move(entry.formId, amount, fromContainer, true, entryStack(entry)),
    // One sound for all of them: the first item's.
    takeAll: async () => {
      if (npcMode || pickpocket) return;
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
