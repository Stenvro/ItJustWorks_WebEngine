// Bartering's rules: the price factors of the player's Speech skill (UESP, "Speech") and what a
// vendor buys (its faction's list of keywords, VEND; stolen items only fences buy:
// src/shell/barter-menu.ts). Platform-independent.

import type { FactionVendor } from '../world/actor-stats-records.ts';
import type { ItemRecord } from '../world/item-records.ts';

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
