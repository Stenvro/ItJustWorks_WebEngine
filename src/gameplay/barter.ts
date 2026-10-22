// Bartering's rules: the price factors of the player's Speech skill (UESP, "Speech") with the
// perks' (the perk entry points Mod Buy Prices and Mod Sell Prices: Haggling, Allure, Fortify
// Barter through the skill boost perks), and what a vendor buys (its faction's list of
// keywords, VEND, unless the player bypasses it: the Merchant perk's BypassVendorKeywordCheck;
// stolen items only fences buy, or any vendor with the Fence perk's BypassVendorStolenCheck:
// src/shell/barter-menu.ts). Platform-independent.

import type { FactionVendor } from '../world/actor-stats-records.ts';
import type { ItemRecord } from '../world/item-records.ts';

/** UESP's limits on the price factors: buying at least this × value, selling at most value. */
const BUY_AT_LEAST = 1.05;
const SELL_AT_MOST = 1;

/**
 * The barter multipliers for a Speech skill and the settings fBarterMin / fBarterMax, times
 * what the player's perks make of them (`perks`: the entry points' factors, every vanilla
 * entry a Multiply Value), within UESP's limits.
 */
export function barterMultipliers(
  speech: number,
  min: number,
  max: number,
  perks: { readonly buy: number; readonly sell: number } = { buy: 1, sell: 1 },
): { readonly buy: number; readonly sell: number } {
  const factor = max - ((max - min) * Math.min(Math.max(speech, 0), 100)) / 100;
  return {
    buy: Math.max(BUY_AT_LEAST, factor * perks.buy),
    sell: Math.min(SELL_AT_MOST, (1 / factor) * perks.sell),
  };
}

/**
 * Whether a vendor buys an item: one of its keywords is in the vendor's list (or none is), or
 * the player bypasses the list (`bypass`: the Merchant perk).
 */
export function vendorBuys(
  item: Pick<ItemRecord, 'keywords'>,
  vendor: Pick<FactionVendor, 'notInList'>,
  list: ReadonlySet<number>,
  bypass = false,
): boolean {
  if (bypass) return true;
  const listed = item.keywords.some((keyword) => list.has(keyword));
  return vendor.notInList ? !listed : listed;
}

/** A merchant's chest restocks this many game hours after it last did (UESP "Merchants"). */
export const RESTOCK_HOURS = 48;

/**
 * Whether a merchant's chest restocks now: RESTOCK_HOURS (in game days, as GameDaysPassed counts
 * them) after it was last stocked. TODO(M13): the 48 hours are UESP's; the executable's setting
 * for them is not in the plugins.
 */
export function restockDue(lastDays: number, nowDays: number): boolean {
  return nowDays - lastDays >= RESTOCK_HOURS / 24;
}
