// Conformance: magicka cost (engine map: Magic, effects, perks > Magicka cost): a spell's base
// cost from its effects, what the caster's skill leaves of it (the player's and the NPCs'
// settings), dual casting.
//
// Sources:
// - The engine's rule, observed in the original: the caster pays base × (1 − (Base × skill)^Scale) × Mult,
//   the skill a whole number; the player's settings fMagicCasterPCSkillCostBase,
//   fMagicPCSkillCostScale, fMagicCasterPCSkillCostMult, the NPCs' fMagicCasterSkillCostBase,
//   fMagicSkillCostScale, fMagicCasterSkillCostMult.
// - The settings: Skyrim.esm sets fMagicCasterPCSkillCostBase 0.0025, fMagicPCSkillCostScale
//   0.65, fMagicCasterSkillCostMult 0.5, fMagicSkillCostScale 0.5, fMagicDualCastingCostMult 2.8,
//   fMagicAreaBaseCostMult 0 (`node tools/gmst-info.ts --prefix fMagic`); the others keep the
//   engine's defaults (the engine's defaults: fMagicCasterSkillCostBase 0.005,
//   fMagicCasterPCSkillCostMult 1).
// - UESP "Skyrim:Magic Overview" (an effect's cost: base × (magnitude × duration / 10)^1.1,
//   concentration spells by 10 s), "Skyrim:Dual Casting".
// - The records: Firebolt (FireDamageFFAimed: base cost 1.2, 25 points), Flames
//   (FireDamageConcAimed: 2.5, 8 a second).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CASTING_DEFAULTS,
  costliestEffectIndex,
  effectItemCost,
  itemBaseCost,
  magickaCost,
  skillCostFactor,
} from '../../../src/gameplay/magic/casting.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseMagicEffect } from '../../../src/world/magic-effects.ts';
import { MagicSpellFlag, parseMagicItem } from '../../../src/world/magic-records.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata } from '../../helpers/sim.ts';

describe('the costliest effect', () => {
  it('ranks the effect items by their cost, duration and all, not base cost × magnitude', () => {
    // 10 points for 60 s at base 1 outweighs 30 points at once at base 1.5.
    const item = {
      castType: 0,
      effects: [
        { effect: 1, magnitude: 30, duration: 0, area: 0 },
        { effect: 2, magnitude: 10, duration: 60, area: 0 },
      ],
    };
    const base = (effect: number): number => (effect === 1 ? 1.5 : 1);
    expect(costliestEffectIndex(item, base)).toBe(1);
    expect(costliestEffectIndex({ ...item, effects: [] }, base)).toBe(-1);
  });
});

describe('the cost formula', () => {
  it('reads the settings the load order and the engine give', () => {
    expect(CASTING_DEFAULTS).toMatchObject({
      pcSkillCostBase: 0.0025,
      pcSkillCostScale: 0.65,
      pcSkillCostMult: 1,
      npcSkillCostBase: 0.005,
      npcSkillCostScale: 0.5,
      npcSkillCostMult: 0.5,
      dualCostMult: 2.8,
      areaBaseCostMult: 0,
    });
  });

  it('costs Firebolt 41.39 and Flames 24.6 a second before the skill', () => {
    expect(effectItemCost(1.2, { magnitude: 25, duration: 0, area: 0 }, false)).toBeCloseTo(
      41.39,
      2,
    );
    expect(effectItemCost(2.5, { magnitude: 8, duration: 0, area: 0 }, true)).toBeCloseTo(24.6, 1);
  });

  it('leaves the player 1 − (0.0025 × skill)^0.65 of it: Firebolt 36.5 at 15, 24.6 at 100', () => {
    const firebolt = effectItemCost(1.2, { magnitude: 25, duration: 0, area: 0 }, false);
    expect(magickaCost({ baseCost: firebolt, skill: 15, player: true })).toBeCloseTo(36.5, 1);
    expect(magickaCost({ baseCost: firebolt, skill: 100, player: true })).toBeCloseTo(24.6, 1);
  });

  it('leaves an NPC (1 − (0.005 × skill)^0.5) × 0.5: half at 0, a quarter at 50, none at 200', () => {
    expect(skillCostFactor(0, false)).toBeCloseTo(0.5, 9);
    expect(skillCostFactor(50, false)).toBeCloseTo(0.25, 9);
    expect(skillCostFactor(100, false)).toBeCloseTo(0.1464, 4);
    expect(skillCostFactor(200, false)).toBe(0);
    // The skill is taken as a whole number.
    expect(skillCostFactor(50.9, false)).toBe(skillCostFactor(50, false));
  });

  it('multiplies a dual cast by fMagicDualCastingCostMult (2.8)', () => {
    const single = magickaCost({ baseCost: 40, skill: 20, player: true });
    expect(magickaCost({ baseCost: 40, skill: 20, player: true, dual: true })).toBeCloseTo(
      single * 2.8,
      9,
    );
  });
});

describe.skipIf(!hasGamedata())('the spells’ costs across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('gives every spell a cost: 332 their own (SPIT 0x1), the rest from their effects', async () => {
    const baseCosts = new Map<number, number>();
    for (const formId of db.formIdsOfType('MGEF')) {
      const record = await db.get(formId);
      if (record && !record.deleted) baseCosts.set(formId, parseMagicEffect(record).baseCost);
    }
    let manual = 0;
    let firebolt: number | undefined;
    for (const formId of db.formIdsOfType('SPEL')) {
      const record = await db.get(formId);
      const item = record && !record.deleted ? parseMagicItem(record) : undefined;
      if (!item) continue;
      if ((item.flags & MagicSpellFlag.manualCost) !== 0) manual++;
      const cost = itemBaseCost(item, (effect) => baseCosts.get(effect) ?? 0);
      expect(Number.isFinite(cost) && cost >= 0, item.editorId).toBe(true);
      if (item.editorId === 'Firebolt') firebolt = cost;
    }
    expect(manual).toBe(332);
    expect(firebolt).toBeCloseTo(41.39, 2);
  });
});

describe('what the original costs that we do not yet', () => {
  it.todo(
    'an NPC casting Firebolt in the sim pays its cost by its Destruction skill (the sim: an NPC ' +
      'of a known skill casts at a target; its Magicka drops by the NPC formula)',
  );
});
