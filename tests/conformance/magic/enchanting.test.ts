// Conformance: enchanting (engine map: Magic, effects, perks > Enchanting): what an enchanted
// item is worth, what an enchantment holds and costs.
//
// Sources:
// - The engine's rule, observed in the original: an enchanted item's value is its base value (one between
//   0 and 1 counted as 1), with a constant effect enchantment that plus the enchantment's cost
//   rounded, with another base + fEnchantmentPointsMult × its charge +
//   fEnchantmentEffectPointsMult × the enchantment's cost (nothing added to a base of 0);
//   an enchantment's charge is its own with ENIT 0x1, else fMagicEnchantmentChargeMult (1) × its
//   cost + fMagicEnchantmentChargeBase (0).
// - The settings: Skyrim.esm fEnchantmentPointsMult 0.12, fEnchantmentEffectPointsMult 8 (the
//   engine's defaults 0.4 and 0.4).
// - The enchantments of the load order: `node tools/magic-census.ts`.
// - UESP "Skyrim:Enchanting" (the magnitudes and charges the menu makes: crafting.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apparelEnchantmentMagnitude,
  ENCHANTED_VALUE_SETTINGS,
  enchantedItemValue,
  enchantingSkillMultiplier,
  enchantmentUses,
} from '../../../src/gameplay/crafting.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { hasGamedata } from '../../helpers/sim.ts';

describe('an enchanted item’s value', () => {
  it('reads Skyrim.esm’s points settings', () => {
    expect(ENCHANTED_VALUE_SETTINGS).toEqual({ pointsMult: 0.12, effectPointsMult: 8 });
  });

  it('adds a weapon’s charge × 0.12 and its enchantment’s cost × 8', () => {
    expect(enchantedItemValue(25, { constant: false, cost: 10, charge: 500 })).toBe(165);
  });

  it('adds apparel’s enchantment cost, rounded', () => {
    expect(enchantedItemValue(30, { constant: true, cost: 12.4, charge: 0 })).toBe(42);
    expect(enchantedItemValue(0.5, { constant: true, cost: 12.6, charge: 0 })).toBe(14);
  });

  it('adds nothing to an item worth nothing', () => {
    expect(enchantedItemValue(0, { constant: false, cost: 10, charge: 500 })).toBe(0);
  });
});

describe('the enchanting menu’s numbers (UESP)', () => {
  it('scales by the skill: 1.25 at 100', () => {
    expect(enchantingSkillMultiplier(100)).toBeCloseTo(1.253, 3);
    expect(apparelEnchantmentMagnitude(40, 5, { skill: 100 })).toBe(50);
    expect(enchantmentUses(3000, 133)).toBe(22);
  });
});

describe.skipIf(!hasGamedata())('the enchantments across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: MagicCensus;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await magicCensus(db);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the 757 enchantments by kind and cast type', () => {
    expect(Object.fromEntries(census.enchantmentKinds)).toEqual({
      enchantment: 686,
      staffEnchantment: 71,
    });
    expect(Object.fromEntries(census.enchantmentCastTypes)).toEqual({ 0: 452, 1: 289, 2: 16 });
    expect(census.enchantmentsManual).toBe(57);
    expect(census.scrolls).toBe(104);
  });
});

describe('what the original does that we do not yet', () => {
  it.todo(
    'an enchanted item glows with its enchantment’s enchant shader and art (MGEF enchant shader, ' +
      'enchant art), in the world, in the hand and on the body',
  );
  it.todo('an enchantment’s charge without EAMT: fMagicEnchantmentChargeMult × its cost');
  it.todo(
    'a staff’s or a weapon’s enchantment used by an NPC never runs out (original: the engine’s rule)',
  );
});
