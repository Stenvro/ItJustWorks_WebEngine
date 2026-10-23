import { describe, expect, it } from 'vitest';
import {
  BARTER_DEFAULTS,
  barterMultipliers,
  barterSettings,
  restockDue,
  vendorBuys,
} from './barter.ts';

/** The load order's fBarterMin and fBarterMax with the engine's limits. */
const vanilla = { ...BARTER_DEFAULTS, min: 2, max: 3.3 };

describe('barterMultipliers', () => {
  it('follows the settings: 3.3 without Speech, 2 at 100, no better beyond', () => {
    expect(barterMultipliers(0, vanilla).buy).toBeCloseTo(3.3);
    expect(barterMultipliers(0, vanilla).sell).toBeCloseTo(1 / 3.3);
    expect(barterMultipliers(20, vanilla).buy).toBeCloseTo(3.04);
    expect(barterMultipliers(100, vanilla)).toEqual({ buy: 2, sell: 0.5 });
    expect(barterMultipliers(150, vanilla)).toEqual({ buy: 2, sell: 0.5 });
  });

  it('never buys below fBarterBuyMin × value or sells above fBarterSellMax × value', () => {
    expect(barterMultipliers(100, { ...vanilla, min: 0.5, max: 0.8 })).toEqual({
      buy: 1.05,
      sell: 0.95,
    });
  });

  it("takes the perks' factors (Haggling 20: buying × 0.91, selling × 1.1)", () => {
    const plain = barterMultipliers(50, vanilla);
    const haggling = barterMultipliers(50, vanilla, { buy: 0.91, sell: 1.1 });
    expect(haggling.buy).toBeCloseTo(plain.buy * 0.91);
    expect(haggling.sell).toBeCloseTo(plain.sell * 1.1);
    expect(barterMultipliers(100, vanilla, { buy: 0.1, sell: 10 })).toEqual({
      buy: 1.05,
      sell: 0.95,
    });
  });

  it('reads the settings by name, the engine defaults where the load order has none', () => {
    const named: Record<string, number> = { fBarterMin: 2, fBarterMax: 3.3 };
    expect(barterSettings((name) => named[name])).toEqual(vanilla);
  });
});

describe('vendorBuys', () => {
  const list = new Set([0x100, 0x200]);
  it('buys what has a listed keyword, or what has none when it buys the unlisted', () => {
    expect(vendorBuys({ keywords: [0x100] }, { notInList: false }, list)).toBe(true);
    expect(vendorBuys({ keywords: [0x300] }, { notInList: false }, list)).toBe(false);
    expect(vendorBuys({ keywords: [0x300] }, { notInList: true }, list)).toBe(true);
    expect(vendorBuys({ keywords: [0x200] }, { notInList: true }, list)).toBe(false);
    // The Merchant perk: any vendor buys anything.
    expect(vendorBuys({ keywords: [0x300] }, { notInList: false }, list, true)).toBe(true);
  });
});

describe('restockDue', () => {
  it('restocks a merchant chest once a new day has come iDaysToRespawnVendor days on', () => {
    expect(restockDue(10.2, 10.9)).toBe(false);
    expect(restockDue(10.9, 11.05)).toBe(true);
    expect(restockDue(10.5, 11.25, 2)).toBe(false);
    expect(restockDue(10.5, 12.25, 2)).toBe(true);
  });
});
