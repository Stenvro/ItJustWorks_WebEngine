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
import { PLAYER_REF } from '../../../src/scripting/runtime/forms.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { parseMagicItem, type MagicItemRecord } from '../../../src/world/magic-records.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { magicCensus, type MagicCensus } from '../../../tools/magic-census.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

/** The Bannered Mare (Whiterun's inn), and the Sneak skill's actor value. */
const BANNERED_MARE = 0x1605e;
const SNEAK = 15;
/** The Destruction and Restoration skills' actor values. */
const DESTRUCTION = 20;
const RESTORATION = 22;

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

describe.skipIf(!hasGamedata())('sneaking trains Sneak (sim)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('by fSkillUsageSneakPerSecond (0.625) a second near actors unaware of the player', async () => {
    const runtime = sim.runtime;
    const experience = (): number => runtime.state.skillExperience.get(SNEAK) ?? 0;
    // With detection off (the console's tdetect) every actor is unaware of the player.
    runtime.debug.detection = false;
    try {
      await sim.step(1);
      const standing = experience();
      await sim.step(3);
      expect(experience()).toBe(standing);
      sim.world.player.sneaking = true;
      await sim.step(4.2);
      // Sneak's AVSK use mult 11.25, offset 0: 4 seconds × 0.625 uses × 11.25.
      expect(experience() - standing).toBeCloseTo(4 * 0.625 * 11.25, 1);
    } finally {
      sim.world.player.sneaking = false;
      runtime.debug.detection = true;
    }
  }, 120_000);
});

describe.skipIf(!hasGamedata())('what a cast trains (sim)', () => {
  let sim: Sim;
  const experience = (skill: number): number => sim.runtime.state.skillExperience.get(skill) ?? 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  const spell = async (editorId: string): Promise<MagicItemRecord> => {
    const record = await sim.db.get(await sim.formId('SPEL', editorId));
    const item = record ? parseMagicItem(record) : undefined;
    if (!item) throw new Error(`No ${editorId}`);
    return item;
  };

  it('trains a heal over time by what its first frame did: none on the whole of its health', async () => {
    const { magic, actors } = sim.runtime;
    const healing = await spell('FastHealing');
    const first = healing.effects[0];
    expect(first).toBeTruthy();
    if (!first) return;
    const overTime: MagicItemRecord = {
      ...healing,
      effects: [{ ...first, duration: 5 }],
    };
    const run = async (): Promise<number> => {
      const before = experience(RESTORATION);
      await magic.apply(overTime, PLAYER_REF, { caster: PLAYER_REF, effects: [0], trains: true });
      await sim.world.settle();
      for (let frame = 0; frame < 3; frame++) {
        sim.runtime.update(0.05, 0);
        await sim.world.settle();
      }
      return experience(RESTORATION) - before;
    };
    actors.restore(PLAYER_REF, ActorValue.health, 100_000);
    expect(await run()).toBe(0);
    // Hurt, its first frame heals what it gives: the effect's whole cost as uses.
    await actors.damage(PLAYER_REF, ActorValue.health, 60);
    expect(await run()).toBeGreaterThan(0);
  }, 120_000);

  it('trains a heal over time that takes hold on the hurt by its first frame, not as it takes hold', async () => {
    // FastHealing's effect is No Duration (it heals at once: the test above trains by what that
    // did). The Guardian Circle's heal (HazardGuardianCircleSpell's second effect, Restoration:
    // 20 a second for 2 s) heals each second, and trains by its first frame. Taken hold while
    // the player is hurt, whole again before that frame: the frame heals nothing, so it trains
    // nothing (a training as it takes hold would see the hurt and train).
    const { magic, actors } = sim.runtime;
    const circle = await spell('HazardGuardianCircleSpell');
    expect(circle.effects[1]?.duration).toBe(2);
    const frames = async (): Promise<void> => {
      for (let frame = 0; frame < 3; frame++) {
        sim.runtime.update(0.05, 0);
        await sim.world.settle();
      }
    };
    const health = async (): Promise<number> =>
      (await actors.value(PLAYER_REF, ActorValue.health)).current;
    const ending = async (): Promise<void> => {
      for (const [key, entry] of magic.effectsOn(PLAYER_REF))
        if (entry.item === circle.formId) await magic.end(key);
    };
    try {
      actors.restore(PLAYER_REF, ActorValue.health, 100_000);
      await actors.damage(PLAYER_REF, ActorValue.health, 60);
      const hurt = await health();
      let before = experience(RESTORATION);
      await magic.apply(circle, PLAYER_REF, { caster: PLAYER_REF, effects: [1], trains: true });
      await sim.world.settle();
      // It heals over time: nothing yet, nor any training.
      expect(await health()).toBe(hurt);
      expect(experience(RESTORATION)).toBe(before);
      actors.restore(PLAYER_REF, ActorValue.health, 100_000);
      await frames();
      expect(experience(RESTORATION)).toBe(before);
      // The same, left hurt: its first frame heals, and it trains.
      await ending();
      await actors.damage(PLAYER_REF, ActorValue.health, 60);
      before = experience(RESTORATION);
      await magic.apply(circle, PLAYER_REF, { caster: PLAYER_REF, effects: [1], trains: true });
      await sim.world.settle();
      await frames();
      expect(await health()).toBeGreaterThan(hurt);
      expect(experience(RESTORATION)).toBeGreaterThan(before);
    } finally {
      await ending();
      actors.restore(PLAYER_REF, ActorValue.health, 100_000);
    }
  }, 120_000);

  it('trains nothing from a staff, however it is used (UESP "Skyrim:Staves")', async () => {
    const { casting, magic, equipment } = sim.runtime;
    const staff = await sim.formId('WEAP', 'StaffFirebolt');
    const enchantment = (await sim.db.get(staff))?.formIdField('EITM');
    const item = enchantment === undefined ? undefined : await magic.item(enchantment);
    expect(item?.kind).toBe('staffEnchantment');
    if (!item) return;
    const castable = { item, via: 'staff', object: staff } as const;
    expect((await casting.cost(PLAYER_REF, castable)).school).toBeUndefined();
    const target = sim.actors()[0]?.reference;
    expect(target).toBeDefined();
    if (target === undefined) return;
    await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(staff), 1, true);
    await equipment.equip(PLAYER_REF, staff, { hand: 'right' });
    const before = experience(DESTRUCTION);
    const delivered = {
      item,
      via: 'staff',
      object: staff,
      caster: PLAYER_REF,
      dual: false,
      cost: await casting.cost(PLAYER_REF, castable),
    } as const;
    expect(await casting.deliver(delivered, target)).toBeGreaterThan(0);
    await sim.world.settle();
    expect(experience(DESTRUCTION)).toBe(before);
  }, 120_000);

  it('scales a use by Mod Skill Use (Rested’s 1.05) and the skill’s AVSK mult and offset', async () => {
    const { progression, perks } = sim.runtime;
    const curve = await progression.curve(DESTRUCTION);
    expect(curve).toBeTruthy();
    if (!curve) return;
    const gained = async (): Promise<number> => {
      const before = experience(DESTRUCTION);
      await progression.useSkill(PLAYER_REF, DESTRUCTION, 10);
      return experience(DESTRUCTION) - before;
    };
    // Destruction's AVSK: its use mult × the uses + its offset.
    expect(await gained()).toBeCloseTo(10 * curve.useMult + curve.useOffset, 3);
    const rested = await sim.formId('PERK', 'RestedPerk');
    await perks.add(PLAYER_REF, rested);
    try {
      expect(await gained()).toBeCloseTo(10 * 1.05 * curve.useMult + curve.useOffset, 3);
    } finally {
      await perks.remove(PLAYER_REF, rested);
    }
  }, 120_000);
});
