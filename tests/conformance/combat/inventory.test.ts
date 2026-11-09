// Conformance: combat inventory (engine map: Combat > Inventory). What an actor fights with, and
// how long it keeps it.
//
// Sources: the engine's defaults (fCombatInventoryMinEquipTime Weapon 5, Magic 3, Shout 3, Staff 5,
// Default 0, Block 5; fCombatInventoryMaxRangeScoreMult and MinRangeScoreMult 0.1),
// docs/ai.md (The engine's built-in game settings: it weighs its equipment continuously, keeping
// what it took up for its kind's minimum time; fCombatInventoryUpdateTimer is never read).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import { readCombatAiSettings } from '../../../src/ai/combat-ai.ts';
import {
  chooseEquipment,
  darkForTorch,
  equipmentMult,
  equipmentScore,
  leftHandSpell,
  minEquipTime,
  torchInFight,
  weighedDamage,
} from '../../../src/ai/combat-tactics.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('what it keeps', () => {
  it('each kind at least its fCombatInventoryMinEquipTime*', () => {
    expect(minEquipTime('melee', settings)).toBe(ENGINE.fCombatInventoryMinEquipTimeWeapon);
    expect(minEquipTime('ranged', settings)).toBe(ENGINE.fCombatInventoryMinEquipTimeWeapon);
    expect(minEquipTime('magic', settings)).toBe(ENGINE.fCombatInventoryMinEquipTimeMagic);
    expect(minEquipTime('shout', settings)).toBe(ENGINE.fCombatInventoryMinEquipTimeShout);
    expect(minEquipTime('staff', settings)).toBe(ENGINE.fCombatInventoryMinEquipTimeStaff);
    expect(minEquipTime(undefined, settings)).toBe(ENGINE.fCombatInventoryMinEquipTimeDefault);
  });

  it('the range score mults (0.1) beyond or within an option’s range', () => {
    expect(settings.inventoryMaxRangeScoreMult).toBeCloseTo(
      ENGINE.fCombatInventoryMaxRangeScoreMult,
    );
    expect(settings.inventoryMinRangeScoreMult).toBeCloseTo(
      ENGINE.fCombatInventoryMinRangeScoreMult,
    );
  });

  it('scores each kind by the style’s CSGD score mult', () => {
    const style = styleWith({
      equipmentScoreMult: { melee: 2, magic: 1, ranged: 0.5, shout: 1, unarmed: 0.1, staff: 1 },
    });
    expect(equipmentMult(style, 'melee')).toBe(2);
    expect(equipmentMult(style, 'ranged')).toBe(0.5);
  });

  it('fCombatInventoryMinEquipTimeBlock is registered and never read  [original]', () => {
    // No code of the original reads it: a shield is not an option of its own, it stays on.
    const read = readCombatAiSettings((name) =>
      name === 'fCombatInventoryMinEquipTimeBlock' ? 99 : undefined,
    );
    expect(read).toEqual(settings);
  });

  const style = styleWith({
    equipmentScoreMult: { melee: 1, magic: 1, ranged: 1, shout: 1, unarmed: 1, staff: 1 },
  });
  const spell = { kind: 'magic', id: 9, damage: 20, range: 500, equipped: false } as const;

  it('hand pairs: a one-handed weapon with a free hand takes a spell, not beside a shield  [original]', () => {
    const hands = { weaponType: 1, shield: false, leftWeapon: false };
    expect(leftHandSpell(hands, [spell], 100, style, settings)).toBe(9);
    expect(
      leftHandSpell({ ...hands, shield: true }, [spell], 100, style, settings),
    ).toBeUndefined();
    expect(
      leftHandSpell({ ...hands, leftWeapon: true }, [spell], 100, style, settings),
    ).toBeUndefined();
    // A two-handed weapon holds both hands.
    expect(
      leftHandSpell({ ...hands, weaponType: 5 }, [spell], 100, style, settings),
    ).toBeUndefined();
  });

  it('weighs again as the range changes, once its minimum time is over  [docs/ai.md]', () => {
    const sword = { kind: 'melee', id: 1, damage: 20, range: 150, equipped: false } as const;
    const bow = { kind: 'ranged', id: 2, damage: 20, range: 4000, equipped: false } as const;
    // The shell asks again each fCombatInventoryMinEquipTime*; the answer follows the distance.
    expect(chooseEquipment([sword, bow], 100, style, settings)?.id).toBe(1);
    expect(chooseEquipment([sword, bow], 2000, style, settings)?.id).toBe(2);
  });

  // The torch's own inventory item (CombatInventoryItemTorch), its range
  // fCombatInventoryTorchEquipRange and min equip time are the original's; their check and the
  // dark they weigh (fTorchLightLevel*) are inferred (combat-tactics.ts darkForTorch,
  // torchInFight). Ammunition for a bow is taken up with it (the combat AI's #equipAmmo;
  // tests/conformance/combat/ranged.test.ts).
  it('torches in the dark  [original settings] (inferred rule)', () => {
    expect(settings.torchEquipRange).toBe(256);
    expect(settings.minEquipTimeTorch).toBe(5);
    // The dark: inside a light level under 40; outside the sky under 0.6 in the morning, 1.2
    // in the evening (it comes out at a brighter sky than it goes away by).
    const inside = { interior: true, sky: 0, hour: 12 };
    expect(darkForTorch({ ...inside, level: 39 }, settings)).toBe(true);
    expect(darkForTorch({ ...inside, level: 40 }, settings)).toBe(false);
    const outside = { interior: false, level: 0, sky: 0.9 };
    expect(darkForTorch({ ...outside, hour: 7 }, settings)).toBe(false);
    expect(darkForTorch({ ...outside, hour: 19 }, settings)).toBe(true);
    // Taken up in the dark by a free left hand, its target beyond 256 units.
    const fight = {
      dark: true,
      carries: true,
      leftHandFree: true,
      distance: 300,
      holding: false,
      heldFor: 0,
    };
    expect(torchInFight(fight, settings)).toBe(true);
    expect(torchInFight({ ...fight, distance: 200 }, settings)).toBe(false);
    expect(torchInFight({ ...fight, leftHandFree: false }, settings)).toBe(false);
    expect(torchInFight({ ...fight, carries: false }, settings)).toBe(false);
    expect(torchInFight({ ...fight, dark: false }, settings)).toBe(false);
    // Held: kept fCombatInventoryMinEquipTimeTorch, then while it is dark.
    const held = { ...fight, holding: true, dark: false };
    expect(torchInFight({ ...held, heldFor: 4.5 }, settings)).toBe(true);
    expect(torchInFight({ ...held, heldFor: 5 }, settings)).toBe(false);
    expect(torchInFight({ ...held, heldFor: 60, dark: true, distance: 0 }, settings)).toBe(true);
  });

  it('the weapon’s score: its damage, the fists’ penalty, the bound bonus, its reach  [original]', () => {
    const sword = { kind: 'melee', id: 1, damage: 20, range: 150, equipped: false } as const;
    const fists = {
      kind: 'unarmed',
      id: undefined,
      damage: 20,
      range: 150,
      equipped: false,
    } as const;
    // fDamageUnarmedPenalty 0.2: fists of the same damage count for a fifth.
    expect(settings.damageUnarmedPenalty).toBeCloseTo(0.2);
    expect(weighedDamage(fists, settings)).toBeCloseTo(4);
    expect(weighedDamage(sword, settings)).toBe(20);
    // fCombatBoundWeaponDPSBonus: a bound weapon beats all.
    expect(weighedDamage({ ...sword, bound: true }, settings)).toBe(100020);
    expect(equipmentScore({ ...sword, bound: true }, 100, style, settings)).toBeGreaterThan(
      equipmentScore({ ...sword, damage: 500 }, 100, style, settings),
    );
    // Its reach: out of it, it scores less.
    expect(equipmentScore(sword, 1000, style, settings)).toBeLessThan(
      equipmentScore(sword, 100, style, settings),
    );
  });
});
