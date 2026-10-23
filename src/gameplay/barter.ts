// Bartering's rules: the price factors of the player's Speech skill (UESP, "Speech") with the
// perks' (the perk entry points Mod Buy Prices and Mod Sell Prices: Haggling, Allure, Fortify
// Barter through the skill boost perks), and what a vendor buys (its faction's list of
// keywords, VEND, unless the player bypasses it: the Merchant perk's BypassVendorKeywordCheck;
// stolen items only fences buy, or any vendor with the Fence perk's BypassVendorStolenCheck:
// src/shell/barter-menu.ts). Platform-independent.

import type { FactionVendor } from '../world/actor-stats-records.ts';
import type { ItemRecord } from '../world/item-records.ts';

/** The settings the price factors come from (GMSTs; the load order's, else the engine's). */
export interface BarterSettings {
  /** fBarterMin, fBarterMax: the buying factor at Speech 100 and at 0 (load order 2, 3.3). */
  readonly min: number;
  readonly max: number;
  /** fBarterBuyMin (1.05), fBarterSellMax (0.95): buying at least, selling at most × value. */
  readonly buyMin: number;
  readonly sellMax: number;
}

export const BARTER_DEFAULTS: BarterSettings = { min: 1.4, max: 2.4, buyMin: 1.05, sellMax: 0.95 };

/** The barter settings by name (`number`: a game setting, the load order's if it has it). */
export function barterSettings(number: (name: string) => number | undefined): BarterSettings {
  const setting = (name: string, fallback: number): number => number(name) ?? fallback;
  return {
    min: setting('fBarterMin', 1.4),
    max: setting('fBarterMax', 2.4),
    buyMin: setting('fBarterBuyMin', 1.05),
    sellMax: setting('fBarterSellMax', 0.95),
  };
}

/**
 * The barter multipliers for a Speech skill, observed in the original: buying at
 * fBarterMax less (fBarterMax − fBarterMin) × Speech / 100, at least fBarterBuyMin; selling at
 * its inverse, at most fBarterSellMax. Then what the player's perks make of them (`perks`: the
 * entry points' factors, every vanilla entry a Multiply Value), within the same limits.
 * TODO(M13): where the engine applies the perks' factors (here: on the multipliers).
 */
export function barterMultipliers(
  speech: number,
  settings: BarterSettings,
  perks: { readonly buy: number; readonly sell: number } = { buy: 1, sell: 1 },
): { readonly buy: number; readonly sell: number } {
  const { min, max, buyMin, sellMax } = settings;
  const factor = max - ((max - min) * Math.min(Math.max(speech, 0), 100)) / 100;
  const buy = Math.max(buyMin, factor);
  const sell = Math.min(sellMax, 1 / buy);
  return {
    buy: Math.max(buyMin, buy * perks.buy),
    sell: Math.min(sellMax, sell * perks.sell),
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

/**
 * Whether a merchant's chest restocks now, observed in the original: it keeps the day
 * (whole days passed) it was last stocked, and restocks once the day is iDaysToRespawnVendor
 * (1) days later. `lastDays`, `nowDays`: GameDaysPassed then and now.
 */
export function restockDue(lastDays: number, nowDays: number, daysToRespawn = 1): boolean {
  return Math.floor(nowDays) - Math.floor(lastDays) >= daysToRespawn;
}
