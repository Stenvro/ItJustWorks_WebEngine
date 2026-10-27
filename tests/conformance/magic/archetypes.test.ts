// Conformance: archetypes (engine map: Magic, effects, perks > Archetypes): what each magic
// effect archetype does, over every archetype the load order uses.
//
// Sources:
// - The archetypes the magic effects use: `node tools/magic-census.ts` (2026-10-24).
// - The engine's rules, observed in the original (docs/gameplay.md, "What effects do"): a ward grows by
//   (fMagicWardPowerMaxMult × skill + fMagicWardPowerMaxBase) × its magnitude a second (0 and
//   1.3 in Skyrim.esm), other Accumulate Magnitude effects by
//   fMagicDefaultAccumulatingModifierEffectRate (1); a summon stands both radii and half of
//   fSummonedCreatureSearchRadius (512) ahead, a Target Location landing nearer than
//   fSummonDistanceCheckThreshold (750) gives way; Telekinesis reaches its magnitude in feet ×
//   fMagicUnitsPerFoot (22); cloaks reach every [General] fCloakEffectUpdateInterval (0.5 s).
// - UESP "Skyrim:Illusion", "Skyrim:Conjuration" (the level caps).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accumulateRate,
  accumulateStep,
  isValueEffect,
  LEVEL_CAPPED,
  MagicValue,
  summonAtLanding,
  summonDistance,
  TARGET_VALUES,
} from '../../../src/gameplay/magic/effect-rules.ts';
import {
  telekinesisDamage,
  telekinesisDamageMult,
  telekinesisReach,
} from '../../../src/gameplay/magic/telekinesis.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { EffectArchetype } from '../../../src/world/magic-effects.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { parseMagicItem } from '../../../src/world/magic-records.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the archetypes across the load order (data)', () => {
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

  it('counts the 37 archetypes the 1,731 magic effects use', () => {
    expect(Object.fromEntries(census.archetypes)).toEqual({
      'Value Modifier': 446,
      Script: 351,
      'Peak Value Modifier': 332,
      'Dual Value Modifier': 134,
      'Summon Creature': 81,
      Absorb: 58,
      Stagger: 52,
      Cloak: 46,
      Paralysis: 29,
      Demoralize: 27,
      Calm: 22,
      'Detect Life': 19,
      Reanimate: 14,
      Frenzy: 13,
      'Turn Undead': 13,
      Invisibility: 13,
      'Spawn Hazard': 13,
      'Bound Weapon': 9,
      Rally: 8,
      Light: 8,
      Disarm: 6,
      'Slow Time': 5,
      'Soul Trap': 4,
      Banish: 4,
      Etherealize: 4,
      'Enhance Weapon': 4,
      'Cure Disease': 3,
      'Accumulate Magnitude': 3,
      Werewolf: 2,
      'Cure Poison': 1,
      'Werewolf Feed': 1,
      Guide: 1,
      Telekinesis: 1,
      'Spawn Scripted Ref': 1,
      'Command Summoned': 1,
      'Grab Actor': 1,
      'Vampire Lord': 1,
    });
  });
});

describe('value archetypes and the AI’s', () => {
  it('changes an actor value with every class that derives Value Modifier', () => {
    for (const archetype of [
      EffectArchetype.valueModifier,
      EffectArchetype.absorb,
      EffectArchetype.dualValueModifier,
      EffectArchetype.peakValueModifier,
      EffectArchetype.accumulateMagnitude,
      EffectArchetype.invisibility,
      EffectArchetype.paralysis,
      EffectArchetype.enhanceWeapon,
    ])
      expect(isValueEffect({ archetype, flags: 0 }), String(archetype)).toBe(true);
  });

  it('caps Calm, Fear, Frenzy, Rally, Turn Undead, Banish, Reanimate, Command and Disarm by level', () => {
    expect(LEVEL_CAPPED.size).toBe(9);
    expect(TARGET_VALUES.get(EffectArchetype.calm)).toBe(0);
  });
});

describe('wards, summons, telekinesis', () => {
  it('grows a ward by 1.3 × its magnitude a second, others by 1, no further than the cap', () => {
    expect(accumulateRate(MagicValue.wardPower, 40, 50)).toBeCloseTo(52, 9);
    expect(accumulateRate(0, 40, 50)).toBe(1);
    expect(accumulateStep(52, 0.5, 30, 40)).toBe(10);
  });

  it('stands a summon its radii and 256 ahead; a landing within 750 and nearer gives way', () => {
    expect(summonDistance(30, 40)).toBe(326);
    expect(summonAtLanding(200, 326)).toBe(false);
    expect(summonAtLanding(500, 326)).toBe(true);
    expect(summonAtLanding(800, 326)).toBe(true);
  });

  it('reaches a Telekinesis target its magnitude in feet × 22 units', () => {
    expect(telekinesisReach(15)).toBe(330);
  });

  it('hurts with a thrown object by fMagicTelekinesisDamageBase (5) × the throw’s multiplier', () => {
    expect(telekinesisDamage(0, telekinesisDamageMult(false))).toBe(5);
    // Dual cast: × fMagicTelekinesisDualCastDamageMult (2).
    expect(telekinesisDamage(0, telekinesisDamageMult(true))).toBe(10);
  });
});

describe.skipIf(!hasGamedata())('a cloak’s pulse (sim)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('puts its spell on an actor near anew only once the last has ended (Flame Cloak’s 1 s burn)', async () => {
    const runtime = sim.runtime;
    const [near] = sim.actors();
    const at = near && (await sim.position(near.reference));
    const record = await sim.db.get(await sim.formId('SPEL', 'flameCloak'));
    const cloak = record ? parseMagicItem(record) : undefined;
    expect(at && cloak).toBeTruthy();
    if (!near || !at || !cloak) return;
    await sim.moveTo([at[0] + 60, at[1], at[2]]);
    const burn = await sim.formId('MGEF', 'FireDamageConcAimedCloak');
    const burns = (): number =>
      sim
        .events('magicEffectApply')
        .filter((event) => event.target === near.reference && event.effect === burn).length;
    const before = burns();
    await runtime.magic.apply(cloak, PLAYER_REF, { caster: PLAYER_REF });
    await sim.step(3);
    const reached = burns() - before;
    // Every 0.5 s it looks; a burn lasts 1 s and its taper: no more than three in 3 s.
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThanOrEqual(3);
  }, 120_000);
});

describe('what the original’s archetypes do that ours do not yet', () => {
  it.todo('Light (Magelight): the light flies as a projectile and sticks where it lands (original)');
  it.todo(
    'Invisibility: the actor is drawn with the invisibility look (fMagicPlayerMinimumInvisibility)',
  );
  it.todo('Summon Creature: the summon is placed on the navmesh clear of the summoner’s sight');
  it.todo('Dispel: the engine’s rule for what it ends (fMagicDispelMagnitudeMult 5)');
  it.todo('Darkness, Night Eye: the image space and fMagicNightEyeAmbient (0.75)');
  it.todo(
    'Disguise, Concussion, Lock, Open, Cure Paralysis, Cure Addiction: unused by vanilla, as the engine does them',
  );
});
