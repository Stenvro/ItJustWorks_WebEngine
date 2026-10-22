// Giving to an actor or taking what it gives (interface\giftmenu.swf, Actor.ShowGiftMenu), as a
// model of the item menus (item-menu.ts): one list, the giver's items (the player's when
// giving, else the actor's), only those of the script's filter list when it has one (the item
// itself or one of its keywords in it). The engine tells the menu which way it goes
// (SetMenuInfo(abGivingGifts, abUseFavorPoints): "GIVE GIFT" or "TAKE GIFT"); ItemSelect
// (amount) moves them. ShowGiftMenu is latent: it returns once the menu closes, with the favor
// points spent or gained (Creation Kit: "ShowGiftMenu - Actor"): with abUseFavorPoints a gift's
// worth to the actor, its value (TODO(M13): the engine's worth of a gift), which raises the
// actor's relationship with the player (crime-engine.ts favor; FavorDialogueScript caps the
// points at 100 for its Speech uses). Stolen items are listed only with abShowStolenItems.

import { INVENTORY_CATEGORIES } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { questItems } from '../scripting/runtime/quest-items.ts';
import { entryStack, ItemShelf } from './container-menu.ts';
import type { GameSession } from './game-session.ts';
import { itemEntry } from './inventory-menu.ts';
import type { ItemMenuModel } from './item-menu.ts';

export interface GiftOptions {
  /** The player gives to the actor (else takes what it gives). */
  readonly giving: boolean;
  /** FLST: the items, or the keywords, that may be given; undefined: all. */
  readonly filter: number | undefined;
  readonly useFavorPoints: boolean;
  /** abShowStolenItems: the player's stolen items may be given too. */
  readonly showStolen?: boolean;
}

export async function giftModel(
  session: GameSession,
  actor: number,
  options: GiftOptions,
): Promise<ItemMenuModel> {
  const shelf = new ItemShelf(session);
  const game = shelf.runtime;
  const allowed =
    options.filter === undefined ? undefined : new Set(await game.formList(options.filter));
  const [from, to] = options.giving ? [PLAYER_REF, actor] : [actor, PLAYER_REF];
  const settings = await session.settings();
  /** The favor points the gifts given so far are worth. */
  let points = 0;
  return {
    movie: 'giftmenu.swf',
    depth: 6,
    keepsIndices: false,
    categories: () =>
      Promise.resolve(
        INVENTORY_CATEGORIES.flatMap((category) => [
          settings.string(category.setting) ?? category.setting,
          category.flag,
          category.alwaysShown,
        ]),
      ),
    start: (menu) => {
      menu.call('SetMenuInfo', options.giving, options.useFavorPoints);
    },
    view: async () => {
      // The player's quest items are not given (quest-items.ts) unless the script's list
      // names them (a quest's item asked for).
      const quest =
        from === PLAYER_REF ? await questItems(game, PLAYER_REF) : new Map<number, number>();
      const rows = (await shelf.rows(from)).flatMap((row) => {
        if (
          allowed &&
          !allowed.has(row.formId) &&
          !row.item.keywords.some((keyword) => allowed.has(keyword))
        ) {
          return [];
        }
        const free = allowed?.has(row.formId)
          ? row.count
          : row.count - (quest.get(row.formId) ?? 0);
        // Without abShowStolenItems the player's stolen ones are not offered.
        if (options.showStolen || from !== PLAYER_REF)
          return free > 0 ? [{ ...row, count: free }] : [];
        const count = Math.min(free, row.count - game.crime.stolenCount(PLAYER_REF, row.formId));
        return count > 0 ? [{ ...row, count }] : [];
      });
      return {
        entries: rows.map(itemEntry),
        cards: await shelf.cards(rows),
        player: [points],
      };
    },
    // ItemSelect(amount).
    trade: async (entry, args) => {
      const amount = typeof args[0] === 'number' ? args[0] : 1;
      await shelf.move(entry.formId, amount, from, to, true, entryStack(entry));
      if (!options.giving || !options.useFavorPoints) return;
      const worth = ((await shelf.item(entry.formId))?.value ?? 0) * amount;
      points += worth;
      await game.crime.favor(actor, worth);
    },
    result: () => points,
    select: () => Promise.resolve(),
    favorite: () => undefined,
  };
}
