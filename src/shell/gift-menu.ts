// Giving to an actor or taking what it gives (interface\giftmenu.swf, Actor.ShowGiftMenu), as a
// model of the item menus (item-menu.ts): one list, the giver's items (the player's when
// giving, else the actor's), only those of the script's filter list when it has one (the item
// itself or one of its keywords in it). The engine tells the menu which way it goes
// (SetMenuInfo(abGivingGifts, abUseFavorPoints): "GIVE GIFT" or "TAKE GIFT"); ItemSelect
// (amount) moves them. ShowGiftMenu is latent: it returns once the menu closes, with the favor
// points spent or gained (Creation Kit: "ShowGiftMenu - Actor"). TODO(M11): favor points (what
// a gift is worth to the actor, UpdatePlayerInfo's points; 0 until then), stolen items
// (abShowStolenItems).

import { INVENTORY_CATEGORIES } from '../gameplay/inventory.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { ItemShelf } from './container-menu.ts';
import type { GameSession } from './game-session.ts';
import { itemEntry } from './inventory-menu.ts';
import type { ItemMenuModel } from './item-menu.ts';

export interface GiftOptions {
  /** The player gives to the actor (else takes what it gives). */
  readonly giving: boolean;
  /** FLST: the items, or the keywords, that may be given; undefined: all. */
  readonly filter: number | undefined;
  readonly useFavorPoints: boolean;
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
      const rows = (await shelf.rows(from)).filter(
        (row) =>
          !allowed ||
          allowed.has(row.formId) ||
          row.item.keywords.some((keyword) => allowed.has(keyword)),
      );
      return {
        entries: rows.map(itemEntry),
        cards: await shelf.cards(rows),
        player: [0],
      };
    },
    // ItemSelect(amount).
    trade: async (entry, args) => {
      const amount = typeof args[0] === 'number' ? args[0] : 1;
      await shelf.move(entry.formId, amount, from, to);
    },
    select: () => Promise.resolve(),
    favorite: () => undefined,
  };
}
