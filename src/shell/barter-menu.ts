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
// Stolen items are offered only to fences (a vendor faction that buys stolen items: VENV, the
// Thieves Guild's fences; UESP "Skyrim:Fences"); sold, they are no longer stolen (what the
// vendor sells again is its own).
//
// Prices (UESP, "Speech"): the factor fBarterMax − (fBarterMax − fBarterMin) × min(Speech,
// 100) / 100; buying costs value × factor, selling gets value / factor, at least 1.05 × value
// and at most the value. A trade is the item's value in Speech uses (the progression engine).
// TODO(M11): the Haggling and Allure perks, Fortify Barter, the Merchant and Investor perks, the
// chest's restock every 48 hours.

import { barterMultipliers, vendorBuys } from '../gameplay/barter.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { actorValueIndex } from '../world/actor-values.ts';
import { parseItem, type ItemRecord } from '../world/item-records.ts';
import { GOLD } from './inventory-menu.ts';
import type { GameSession } from './game-session.ts';
import type { ItemMenuModel } from './item-menu.ts';
import { ItemShelf, otherSideEntry, sideCategories } from './container-menu.ts';
import { itemEntry } from './inventory-menu.ts';
import type { Terminal } from './terminal.ts';

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
  /**
   * Speech's experience of a trade: the item's value as uses, once a trade however many go
   * (UESP "Speech": "based on the actual value of the item", several at once count as one).
   */
  const speechUse = async (item: number): Promise<void> => {
    const record = await game.forms.record(item);
    const value = record ? (parseItem(record)?.value ?? 0) : 0;
    await game.progression.useSkill(PLAYER_REF, speech, value);
  };
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
      // What the vendor buys; a vendor that is no fence not the stolen ones.
      const offered = mine.flatMap((row) => {
        if (!sellable(row.item)) return [];
        if (vendor?.onlyStolen === true) return [row];
        const count = row.count - game.crime.stolenCount(PLAYER_REF, row.formId);
        return count > 0 ? [{ ...row, count }] : [];
      });
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
        await speechUse(entry.formId);
        return;
      }
      // The vendor pays what it has: from the chest, then its own gold.
      let owed = Math.min(total, await vendorGold());
      const fromChest = Math.min(owed, await game.itemCount(chest, GOLD));
      if (fromChest > 0) await shelf.move(GOLD, fromChest, chest, PLAYER_REF, false);
      owed -= fromChest;
      if (owed > 0) await shelf.move(GOLD, owed, vendorActor, PLAYER_REF, false);
      await shelf.move(entry.formId, amount, PLAYER_REF, chest);
      game.crime.clearStolen(chest, entry.formId);
      await speechUse(entry.formId);
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
