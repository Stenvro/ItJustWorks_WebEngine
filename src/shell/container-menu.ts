// A container's items beside the player's (interface\containermenu.swf), as a model of the
// item menus (item-menu.ts): a chest, a barrel, a corpse searched. Its categories list the
// container's first, then a divider (a category with no bits), then the player's: the movie
// is "viewing the container" while a category above the divider is selected, and only tests
// the bits, so the container's are the inventory's moved up by CONTAINER_SHIFT. Taking (E) and
// storing (R on the player's side) move items (ItemTransfer: the amount, from the container);
// R on the container's side takes everything (TakeAllItems); equipping a container's item
// takes it first. The items' pick-up and put-down sounds play as they move. TODO(M11):
// stealing (owned containers: sStealFrom, the steal chance), quest items that cannot be
// stored. Notes: docs/ui.md ("The item menus").

import { INVENTORY_CATEGORIES, ItemCategory, itemSound } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { parseItem, type ItemRecord } from '../world/item-records.ts';
import type { GameSession } from './game-session.ts';
import { itemCard, itemEntry, itemRows, playerInfo, GOLD } from './inventory-menu.ts';
import type { ItemEntry, ItemMenuModel } from './item-menu.ts';

/** The container's category bits: the inventory's, this far up. */
export const CONTAINER_SHIFT = 10;

export function containerModel(
  session: GameSession,
  container: number,
  /** The inventory's model: what selecting and favoring the player's entries does. */
  inventory: ItemMenuModel,
): ItemMenuModel {
  const runtime = (): ScriptRuntime => {
    const ready = session.scriptsReady;
    if (!ready) throw new Error('the game is not running');
    return ready;
  };
  const items = new Map<number, ItemRecord | undefined>();
  const item = async (formId: number): Promise<ItemRecord | undefined> => {
    if (!items.has(formId)) {
      const record = await runtime().forms.record(formId);
      items.set(formId, record ? parseItem(record) : undefined);
    }
    return items.get(formId);
  };
  /** Moves items between the container and the player, their sound playing. */
  const move = async (
    formId: number,
    amount: number,
    fromContainer: boolean,
    audible = true,
  ): Promise<void> => {
    const game = runtime();
    const [from, to] = fromContainer ? [container, PLAYER_REF] : [PLAYER_REF, container];
    await game.removeItem(from, game.formHandle(formId), amount, true, to);
    if (!fromContainer) {
      // What the player no longer has is no longer worn.
      const actor = game.state.actor(PLAYER_REF);
      if ((await game.itemCount(PLAYER_REF, formId)) <= 0 && actor.equipped.delete(formId)) {
        game.world.equipmentChanged?.(PLAYER_REF);
        await game.sendEvent(PLAYER_REF, 'OnObjectUnequipped', [game.formHandle(formId), null]);
      }
    }
    if (!audible) return;
    const record = await item(formId);
    const sounds = session.soundSystem;
    const sound = record && sounds && itemSound(record, fromContainer, sounds.defaults);
    if (sound !== undefined) void sounds?.play(sound);
  };
  return {
    movie: 'containermenu.swf',
    depth: 6,
    keepsIndices: false,
    categories: async () => {
      const settings = await session.settings();
      const label = (setting: string): string => settings.string(setting) ?? setting;
      return [
        ...INVENTORY_CATEGORIES.filter(
          (category) => category.flag !== ItemCategory.favorites,
        ).flatMap((category) => [
          label(category.setting),
          category.flag << CONTAINER_SHIFT,
          category.alwaysShown,
        ]),
        '',
        0,
        true,
        ...INVENTORY_CATEGORIES.flatMap((category) => [
          label(category.setting),
          category.flag,
          category.alwaysShown,
        ]),
      ];
    },
    view: async () => {
      const game = runtime();
      const settings = await session.settings();
      const [held, own] = await Promise.all([
        game.inventory(container),
        game.inventory(PLAYER_REF),
      ]);
      const theirs = await itemRows(game, container, held, item);
      const mine = await itemRows(game, PLAYER_REF, own, item);
      const entries: ItemEntry[] = [
        ...theirs.map((row) => {
          const entry = itemEntry(row);
          return {
            ...entry,
            filterFlag: (entry.filterFlag as number) << CONTAINER_SHIFT,
            container: true,
          };
        }),
        ...mine.map((row) => itemEntry(row)),
      ];
      const cards: Record<string, unknown>[] = [];
      for (const row of [...theirs, ...mine]) cards.push(await itemCard(game, settings, row));
      return { entries, cards, player: await playerInfo(game, mine, own.get(GOLD) ?? 0) };
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
      let first = true;
      for (const [formId, count] of [...(await runtime().inventory(container))]) {
        const record = await item(formId);
        if (count <= 0 || !record || record.nonPlayable || record.name === '') continue;
        await move(formId, count, true, first);
        first = false;
      }
    },
  };
}
