// Conformance: combat inventory (engine map: Combat > Inventory). What an actor fights with, and
// how long it keeps it.
//
// Sources: the engine's defaults (fCombatInventoryMinEquipTime Weapon 5, Magic 3, Shout 3, Staff 5,
// Default 0, Block 5; fCombatInventoryMaxRangeScoreMult and MinRangeScoreMult 0.1),
// docs/ai.md (The engine's built-in game settings: it weighs its equipment continuously, keeping
// what it took up for its kind's minimum time; fCombatInventoryUpdateTimer is never read).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import { equipmentMult, minEquipTime } from '../../../src/ai/combat-tactics.ts';
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

  it.todo('fCombatInventoryMinEquipTimeBlock (5): a shield or a block kept  [settings]');
  it.todo('hand pairs: a one-handed weapon and a shield, a spell, a torch  [original]');
  it.todo('continuous weighing after the minimum equip times  [docs/ai.md]');
  it.todo('torches in the dark, ammunition for the bow  [original]');
  it.todo('the weapon’s score: its damage per second and reach  [original]');
});
