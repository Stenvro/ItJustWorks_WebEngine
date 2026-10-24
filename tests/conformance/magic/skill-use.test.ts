// Conformance: skill use (engine map: Magic, effects, perks > Skill use): how much a spell
// trains its school.
//
// Sources:
// - The engine's rule, observed in the original: each effect item of a spell (not a power, lesser power or
//   shout) trains its magic effect's school (a skill) by the effect item's cost, no more than the
//   spell's own when that is not calculated, × the magic effect's skill usage multiplier; a fire
//   and forget effect once, as it takes hold; the archetypes the engine's table marks (Value
//   Modifier, Dual Value Modifier, Bound Weapon, Summon Creature, Detect Life, Telekinesis,
//   Reanimate, Accumulate Magnitude, Peak Value Modifier) by the share of their magnitude they
//   did, and as a concentration spell's effect each frame × its time (others then not at all).
//   Dual casting adds nothing.
// - The records: FireDamageFFAimed (skill usage 1), FireDamageFFAimedArea (Fireball: 0.5),
//   FireDamageConcAimed (Flames: 1); `node tools/magic-census.ts` for the class.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectItemCost } from '../../../src/gameplay/magic/casting.ts';
import { effectSkillUses, SKILL_BY_EFFECT } from '../../../src/gameplay/magic/effect-rules.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { hasGamedata } from '../../helpers/sim.ts';

const FIREBOLT = effectItemCost(1.2, { magnitude: 25, duration: 0, area: 0 }, false);

describe('the uses a spell gives', () => {
  it('trains Destruction by Firebolt’s effect cost, 41.39, dual cast or not', () => {
    expect(effectSkillUses({ effectCost: FIREBOLT, skillUsageMult: 1 })).toBeCloseTo(41.39, 2);
  });

  it('trains by the effect’s skill usage multiplier: Fireball’s 0.5', () => {
    expect(effectSkillUses({ effectCost: 100, skillUsageMult: 0.5 })).toBe(50);
    expect(effectSkillUses({ effectCost: 100, skillUsageMult: 0 })).toBe(0);
  });

  it('trains no more than a spell’s own cost when it is not calculated', () => {
    expect(effectSkillUses({ effectCost: 100, spellCost: 30, skillUsageMult: 1 })).toBe(30);
  });

  it('trains a concentration spell by the seconds held: Flames 24.6 a second', () => {
    const flames = effectItemCost(2.5, { magnitude: 8, duration: 0, area: 0 }, true);
    expect(effectSkillUses({ effectCost: flames, skillUsageMult: 1, seconds: 0.5 })).toBeCloseTo(
      12.3,
      1,
    );
  });

  it('trains by what the effect did: a heal on the whole of its target’s health gives none', () => {
    expect(effectSkillUses({ effectCost: 20, skillUsageMult: 1, share: 0 })).toBe(0);
    expect(effectSkillUses({ effectCost: 20, skillUsageMult: 1, share: 0.25 })).toBe(5);
  });

  it('marks the nine archetypes that train by what they did', () => {
    expect(SKILL_BY_EFFECT.size).toBe(9);
  });
});

describe.skipIf(!hasGamedata())('the skill usage multipliers across the load order (data)', () => {
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

  it('counts the effects that train their school otherwise than 1 × their cost', () => {
    // 1,176 of 1,731 never train (potions’, abilities’, NPCs’ effects).
    expect(census.skillUsageMults.get(0)).toBe(1176);
    expect(census.skillUsageMults.get(0.5)).toBe(62);
    expect(census.skillUsageMults.get(1.4)).toBe(38);
    expect([...census.skillUsageMults.values()].reduce((a, b) => a + b, 0)).toBe(1381);
  });
});

describe('what the original trains that we do not yet', () => {
  it.todo('a staff trains its school with the perks that let it (UESP "Skyrim:Staffs"; original)');
  it.todo('a lasting effect (a burn) trains by what its first frame did (we count it whole)');
  it.todo(
    'Mod Skill Use and the skill’s improve multiplier and offset scale the uses (the ' +
      'progression system: tests/conformance for skills)',
  );
});
