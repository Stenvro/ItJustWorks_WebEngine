// Trading with a merchant (interface\bartermenu.swf, Actor.ShowBarterMenu from a dialogue's
// script), as a model of the item menus (item-menu.ts). The vendor's side lists the goods in
// its faction's merchant chest (FACT VENC), the player's side what the vendor buys (its list,
// VEND: items with one of its keywords, or without when the faction buys what is not in it);
// both sides as the container menu has them (a divider between). The engine sends the price
// multipliers (SetBarterMultipliers: the menu shows a vendor's item at value × buy, the
// player's at value × sell) and the gold (UpdatePlayerInfo: the player's, the vendor's, its
// name, the player's info). ItemSelect(fromVendor, price, amount) buys or sells: gold moves
// one way (into the chest, out of the chest and then the vendor), the items the other (bought
// from the chest, sold into it); a purchase the player cannot pay shows sItemTooExpensive.
// Selling for more than the vendor has asks first (GetRawDealWarningString(price): the setting
// sNotEnoughVendorGold) and the vendor pays what it has.
//
// Prices (UESP, "Speech"): the factor fBarterMax − (fBarterMax − fBarterMin) × min(Speech,
// 100) / 100; buying costs value × factor, selling gets value / factor, at least 1.05 × value
// and at most the value. TODO(M11): the Haggling and Allure perks, Fortify Barter, stolen
// goods (fences), the Merchant and Investor perks, the chest's restock every 48 hours.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { actorValueIndex } from '../world/actor-values.ts';
import type { FactionVendor } from '../world/actor-stats-records.ts';
import type { ItemRecord } from '../world/item-records.ts';
import { GOLD } from './inventory-menu.ts';
import type { GameSession } from './game-session.ts';
import type { ItemMenuModel } from './item-menu.ts';
import { ItemShelf, otherSideEntry, sideCategories } from './container-menu.ts';
import { itemEntry } from './inventory-menu.ts';
import type { Terminal } from './terminal.ts';

/** UESP's limits on the price factors: buying at least this × value, selling at most value. */
const BUY_AT_LEAST = 1.05;
const SELL_AT_MOST = 1;

/** The barter multipliers for a Speech skill and the settings fBarterMin / fBarterMax. */
export function barterMultipliers(
  speech: number,
  min: number,
  max: number,
): { readonly buy: number; readonly sell: number } {
  const factor = max - ((max - min) * Math.min(Math.max(speech, 0), 100)) / 100;
  return { buy: Math.max(BUY_AT_LEAST, factor), sell: Math.min(SELL_AT_MOST, 1 / factor) };
}

/** Whether a vendor buys an item: one of its keywords is in the vendor's list (or none is). */
export function vendorBuys(
  item: Pick<ItemRecord, 'keywords'>,
  vendor: Pick<FactionVendor, 'notInList'>,
  list: ReadonlySet<number>,
): boolean {
  const listed = item.keywords.some((keyword) => list.has(keyword));
  return vendor.notInList ? !listed : listed;
}

export async function barterModel(
  session: GameSession,
  terminal: Terminal,
  vendorActor: number,
): Promise<ItemMenuModel> {
  const shelf = new ItemShelf(session);
  const game = shelf.runtime;
  const trade =
    (await game.actors.vendorFaction(vendorActor)) ??
    (await game.actors.vendorFaction(vendorActor, false));
  const vendor = trade?.vendor;
  if (!vendor) terminal.log('ui', `${vendorActor.toString(16)} is in no vendor faction`, 'warn');
  // Without a merchant chest the vendor trades from its own items.
  const chest = vendor?.chest ?? vendorActor;
  const list = new Set(vendor?.list === undefined ? [] : await game.formList(vendor.list));
  const settings = await session.settings();
  const speech = actorValueIndex('Speechcraft') ?? 17;
  const multipliers = barterMultipliers(
    (await game.actors.value(PLAYER_REF, speech)).current,
    settings.number('fBarterMin') ?? 2,
    settings.number('fBarterMax') ?? 3.3,
  );
  const name = (await game.forms.record((await game.baseOf(vendorActor)) ?? 0))?.text('FULL') ?? '';
  const vendorGold = async (): Promise<number> =>
    (await game.itemCount(chest, GOLD)) +
    (chest === vendorActor ? 0 : await game.itemCount(vendorActor, GOLD));
  /** The vendor's gold as last shown (the warning is answered at once, during the call). */
  let shownGold = await vendorGold();
  const sellable = (rowItem: ItemRecord): boolean =>
    vendor !== undefined && vendorBuys(rowItem, vendor, list);
  return {
    movie: 'bartermenu.swf',
    depth: 6,
    keepsIndices: false,
    categories: () => Promise.resolve(sideCategories(settings)),
    start: (menu) => {
      menu.call('SetBarterMultipliers', multipliers.buy, multipliers.sell);
    },
    view: async () => {
      const goods = (await shelf.rows(chest)).filter((row) => row.formId !== GOLD);
      const mine = await shelf.rows(PLAYER_REF);
      const offered = mine.filter((row) => sellable(row.item));
      return {
        entries: [...goods.map(otherSideEntry), ...offered.map(itemEntry)],
        cards: await shelf.cards([...goods, ...offered]),
        player: [
          await game.itemCount(PLAYER_REF, GOLD),
          (shownGold = await vendorGold()),
          name,
          await shelf.playerInfo(mine),
        ],
      };
    },
    // ItemSelect(fromVendor, price each, amount).
    trade: async (entry, args) => {
      const price = typeof args[1] === 'number' ? args[1] : 0;
      const amount = typeof args[2] === 'number' ? args[2] : 1;
      const total = Math.round(price * amount);
      if (entry.container) {
        if ((await game.itemCount(PLAYER_REF, GOLD)) < total) {
          session.hud.notification(settings.string('sItemTooExpensive') ?? '');
          return;
        }
        await shelf.move(GOLD, total, PLAYER_REF, chest, false);
        await shelf.move(entry.formId, amount, chest, PLAYER_REF);
        return;
      }
      // The vendor pays what it has: from the chest, then its own gold.
      let owed = Math.min(total, await vendorGold());
      const fromChest = Math.min(owed, await game.itemCount(chest, GOLD));
      if (fromChest > 0) await shelf.move(GOLD, fromChest, chest, PLAYER_REF, false);
      owed -= fromChest;
      if (owed > 0) await shelf.move(GOLD, owed, vendorActor, PLAYER_REF, false);
      await shelf.move(entry.formId, amount, PLAYER_REF, chest);
    },
    handlers: {
      // (price): sNotEnoughVendorGold, "Transaction value: %d gold. Vendor only has %d gold."
      GetRawDealWarningString: (menu, request, args) => {
        const text = (settings.string('sNotEnoughVendorGold') ?? '')
          .replace('%d', String(Math.round(typeof args[0] === 'number' ? args[0] : 0)))
          .replace('%d', String(shownGold));
        menu.respond(request, text);
      },
    },
    select: () => Promise.resolve(),
    favorite: () => undefined,
  };
}
