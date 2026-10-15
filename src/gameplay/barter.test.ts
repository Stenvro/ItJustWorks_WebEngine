import { describe, expect, it } from 'vitest';
import { barterMultipliers, vendorBuys } from './barter.ts';

describe('barterMultipliers', () => {
  it('follows UESP: 3.3 without Speech, 2 at 100, no better beyond', () => {
    expect(barterMultipliers(0, 2, 3.3).buy).toBeCloseTo(3.3);
    expect(barterMultipliers(0, 2, 3.3).sell).toBeCloseTo(1 / 3.3);
    expect(barterMultipliers(20, 2, 3.3).buy).toBeCloseTo(3.04);
    expect(barterMultipliers(100, 2, 3.3)).toEqual({ buy: 2, sell: 0.5 });
    expect(barterMultipliers(150, 2, 3.3)).toEqual({ buy: 2, sell: 0.5 });
  });

  it('never buys below 1.05 × value or sells above the value', () => {
    expect(barterMultipliers(100, 0.5, 0.8)).toEqual({ buy: 1.05, sell: 1 });
  });
});

describe('vendorBuys', () => {
  const list = new Set([0x100, 0x200]);
  it('buys what has a listed keyword, or what has none when it buys the unlisted', () => {
    expect(vendorBuys({ keywords: [0x100] }, { notInList: false }, list)).toBe(true);
    expect(vendorBuys({ keywords: [0x300] }, { notInList: false }, list)).toBe(false);
    expect(vendorBuys({ keywords: [0x300] }, { notInList: true }, list)).toBe(true);
    expect(vendorBuys({ keywords: [0x200] }, { notInList: true }, list)).toBe(false);
  });
});
