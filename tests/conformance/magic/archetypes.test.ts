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
import { invisibilityVeil } from '../../../src/gameplay/magic/invisibility.ts';
import { sticksAsLight } from '../../../src/gameplay/magic/projectile-flight.ts';
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
import { parseMagicItem, type MagicItemRecord } from '../../../src/world/magic-records.ts';
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

  it('sticks a Light effect’s projectile where it strikes a surface (Magelight), not on an actor', () => {
    expect(sticksAsLight(EffectArchetype.light, 'surface')).toBe(true);
    expect(sticksAsLight(EffectArchetype.light, 'actor')).toBe(false);
    expect(sticksAsLight(EffectArchetype.valueModifier, 'surface')).toBe(false);
  });

  it('veils an invisible actor all but its least refraction, the player all but 0.1', () => {
    expect(invisibilityVeil(false, true)).toBe(0);
    expect(invisibilityVeil(true, false)).toBeCloseTo(0.99, 9);
    // fMagicPlayerMinimumInvisibility: the player stays drawn at 0.1 at least.
    expect(invisibilityVeil(true, true)).toBeCloseTo(0.9, 9);
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

// A summon at its commander's side: the conjured familiar (EncSummonFamiliar, a wolf by its
// template: unaggressive with an aggro radius of 0 / 2000 / 500) takes the player's side, so the
// Bannered Mare's people, neutral to the player, are no one it fights (src/ai/combat-profile.ts);
// out of combat it follows the player into fSummonedCreatureMinFollowDist (250) ..
// fSummonedCreatureMaxFollowDist (400) (src/ai/engine-packages.ts: Follow Commander).

const BANNERED_MARE = 0x1605e;

describe.skipIf(!hasGamedata())('a summon at its commander’s side (sim)', () => {
  let sim: Sim;
  let familiar = 0;
  /** Whom each actor of the inn fought, at any step since the cast. */
  const fought = new Map<number, Set<number>>();
  const watch = (): boolean => {
    for (const actor of sim.actors()) {
      const target = sim.world.stage.combat.targetOf(actor.reference);
      if (target === undefined) continue;
      let targets = fought.get(actor.reference);
      if (!targets) fought.set(actor.reference, (targets = new Set()));
      targets.add(target);
    }
    return false;
  };

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    await sim.cast(await sim.formId('SPEL', 'ConjureFamiliar'));
    familiar =
      sim.actors().find((actor) => sim.runtime.magic.commander(actor.reference) === PLAYER_REF)
        ?.reference ?? 0;
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('picks no fight with its summoner’s neutrals: no one in the Bannered Mare fights', async () => {
    expect(familiar).not.toBe(0);
    expect(sim.actors().length).toBeGreaterThan(3);
    await sim.until(watch, 10);
    expect([...fought.keys()].map((actor) => actor.toString(16))).toEqual([]);
  }, 120_000);

  it('follows the player who walks off into the follow band, out of combat', async () => {
    const setting = async (name: string): Promise<number> => {
      const value = await sim.runtime.gameSetting(name);
      return typeof value === 'number' ? value : Number.NaN;
    };
    const min = await setting('fSummonedCreatureMinFollowDist');
    const max = await setting('fSummonedCreatureMaxFollowDist');
    expect([min, max]).toEqual([250, 400]);
    const start = await sim.position(familiar);
    const gap = (await sim.distance(familiar, PLAYER_REF)) ?? Infinity;
    expect(gap).toBeLessThanOrEqual(max);
    // From the front door across the hall to the far side of the hearth, about 1,000 units.
    const goal: [number, number, number] = [150, -100, 68];
    const [x0, y0] = sim.world.player.feet;
    expect(Math.hypot(goal[0] - x0, goal[1] - y0)).toBeGreaterThan(1000);
    expect(await sim.walkPath(goal, 30)).toBe(true);
    const [x1, y1] = sim.world.player.feet;
    const walked = Math.hypot(x1 - x0, y1 - y0);
    let away = Infinity;
    for (let second = 0; second < 15 && away > max; second++) {
      await sim.until(watch, 1);
      away = (await sim.distance(familiar, PLAYER_REF)) ?? Infinity;
    }
    const end = await sim.position(familiar);
    expect(start && end).toBeTruthy();
    if (!start || !end) return;
    // It came along: what the player walked, less the band it may keep and where it stood.
    expect(Math.hypot(end[0] - start[0], end[1] - start[1])).toBeGreaterThan(walked - max - gap);
    expect(away).toBeLessThanOrEqual(max);
    expect(away).toBeGreaterThan(min / 2);
    expect(fought.has(familiar)).toBe(false);
  }, 120_000);
});

describe.skipIf(!hasGamedata())('Dispel and Light on actors (sim)', () => {
  let sim: Sim;
  /** A magic effect with no record (no vanilla effect dispels): answered for the magic system. */
  const invented = 0x7f000001;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  const magicItem = async (type: string, editorId: string): Promise<MagicItemRecord> => {
    const record = await sim.db.get(await sim.formId(type, editorId));
    const item = record ? parseMagicItem(record) : undefined;
    if (!item) throw new Error(`No ${editorId}`);
    return item;
  };

  it('Dispel ends the spells at or below magnitude × 5, each whole, and only spells', async () => {
    const { magic, casting } = sim.runtime;
    const oak = await magicItem('SPEL', 'Oakflesh');
    const potion = await magicItem('ALCH', 'FortifyHealth01');
    const firstEffect = oak.effects[0];
    const base = firstEffect && (await magic.effect(firstEffect.effect));
    expect(base).toBeTruthy();
    if (!firstEffect || !base) return;
    // The strength of Oakflesh by the player's Alteration, as its cost says.
    const strength = (await casting.cost(PLAYER_REF, { item: oak, via: 'spell' })).magicka;
    expect(strength).toBeGreaterThan(0);
    const reader = magic.effect.bind(magic);
    magic.effect = (formId) =>
      formId === invented
        ? Promise.resolve({
            ...base,
            formId: invented,
            archetype: EffectArchetype.dispel,
            flags: 0,
            counterEffects: [],
          })
        : reader(formId);
    const dispel = (magnitude: number): MagicItemRecord => ({
      ...oak,
      formId: 0x7f000002,
      effects: [{ ...firstEffect, effect: invented, magnitude, duration: 0 }],
    });
    const on = (item: number): number =>
      magic.effectsOn(PLAYER_REF).filter(([, entry]) => entry.item === item).length;
    try {
      await magic.apply(oak, PLAYER_REF, { caster: PLAYER_REF });
      await magic.apply(potion, PLAYER_REF, { caster: PLAYER_REF });
      expect(on(oak.formId)).toBeGreaterThan(0);
      const potionEffects = on(potion.formId);
      expect(potionEffects).toBeGreaterThan(0);
      // Just too weak for it: it stays; magnitude 1 over a fifth of its cost: it goes.
      await magic.apply(dispel(strength / 5 - 1), PLAYER_REF, { caster: PLAYER_REF });
      expect(on(oak.formId)).toBeGreaterThan(0);
      await magic.apply(dispel(strength / 5 + 1), PLAYER_REF, { caster: PLAYER_REF });
      expect(on(oak.formId)).toBe(0);
      // A potion is no spell: however strong the Dispel, it stays.
      await magic.apply(dispel(10_000), PLAYER_REF, { caster: PLAYER_REF });
      expect(on(potion.formId)).toBe(potionEffects);
    } finally {
      magic.effect = reader;
    }
  }, 120_000);

  it('Open, Lock, Cure Paralysis and Cure Addiction do what they say, though vanilla uses none', async () => {
    const { magic } = sim.runtime;
    const oak = await magicItem('SPEL', 'Oakflesh');
    const firstEffect = oak.effects[0];
    const base = firstEffect && (await magic.effect(firstEffect.effect));
    expect(base).toBeTruthy();
    if (!firstEffect || !base) return;
    const reader = magic.effect.bind(magic);
    magic.effect = (formId) =>
      formId >= invented && formId < invented + 64
        ? Promise.resolve({
            ...base,
            formId,
            archetype: formId - invented,
            flags: 0,
            counterEffects: [],
            actorValue: -1,
          })
        : reader(formId);
    const of = (archetype: number, magnitude: number, duration = 0): MagicItemRecord => ({
      ...oak,
      formId: 0x7f000100 + archetype,
      effects: [{ ...firstEffect, effect: invented + archetype, magnitude, duration }],
    });
    const on = (item: number): number =>
      magic.effectsOn(PLAYER_REF).filter(([, entry]) => entry.item === item).length;
    try {
      // A door of the inn: Lock locks it, Open of a lower level leaves it, of its level opens it.
      const door = sim.world.placedObjects().find((placed) => placed.object.baseType === 'DOOR');
      expect(door).toBeDefined();
      if (!door) return;
      const reference = door.object.reference;
      await magic.apply(of(EffectArchetype.lock, 0), reference, { caster: PLAYER_REF });
      expect((await sim.runtime.lock(reference)).locked).toBe(true);
      const level = (await sim.runtime.lock(reference)).level;
      if (level > 0) {
        await magic.apply(of(EffectArchetype.open, level - 1), reference, { caster: PLAYER_REF });
        expect((await sim.runtime.lock(reference)).locked).toBe(true);
      }
      await magic.apply(of(EffectArchetype.open, level), reference, { caster: PLAYER_REF });
      expect((await sim.runtime.lock(reference)).locked).toBe(false);
      // Cure Paralysis ends a paralysis on the target.
      const stiff = await magicItem('SPEL', 'Paralyze');
      const victim = sim.actors().at(-1)?.reference ?? 0;
      const stiffOn = (): number =>
        magic.effectsOn(victim).filter(([, entry]) => entry.item === stiff.formId).length;
      await magic.apply(stiff, victim, { caster: PLAYER_REF });
      expect(stiffOn()).toBeGreaterThan(0);
      await magic.apply(of(EffectArchetype.cureParalysis, 0), victim, { caster: PLAYER_REF });
      expect(stiffOn()).toBe(0);
      // Cure Addiction ends an addiction, not a spell.
      const addiction: MagicItemRecord = {
        ...of(EffectArchetype.valueModifier, 1, 600),
        formId: 0x7f000200,
        kind: 'addiction',
      };
      const spell = of(EffectArchetype.valueModifier, 1, 600);
      const items = magic.item.bind(magic);
      magic.item = (formId) =>
        formId === addiction.formId ? Promise.resolve(addiction) : items(formId);
      await magic.apply(addiction, PLAYER_REF, { caster: PLAYER_REF });
      await magic.apply(spell, PLAYER_REF, { caster: PLAYER_REF });
      expect(on(addiction.formId)).toBe(1);
      await magic.apply(of(EffectArchetype.cureAddiction, 0), PLAYER_REF, { caster: PLAYER_REF });
      expect(on(addiction.formId)).toBe(0);
      expect(on(spell.formId)).toBe(1);
    } finally {
      magic.effect = reader;
    }
  }, 120_000);

  it('a caster’s Magelight stays on one living target: the next ends it (UESP)', async () => {
    const { magic } = sim.runtime;
    const light = await magicItem('SPEL', 'Magelight');
    const [first, second] = sim.actors();
    expect(first && second).toBeTruthy();
    if (!first || !second) return;
    const lit = (reference: number): number =>
      magic.effectsOn(reference).filter(([, entry]) => entry.item === light.formId).length;
    await magic.apply(light, first.reference, { caster: PLAYER_REF });
    expect(lit(first.reference)).toBeGreaterThan(0);
    await magic.apply(light, second.reference, { caster: PLAYER_REF });
    expect(lit(second.reference)).toBeGreaterThan(0);
    expect(lit(first.reference)).toBe(0);
  }, 120_000);
});

describe('what the original’s archetypes do that ours do not yet', () => {
  it.todo('Light (Magelight): on a moving object it struck');
  it.todo('Invisibility: the refraction shimmer through the actor (ours dithers it away)');
  // Summon Creature's search when its way is blocked: src/ai/pathfinding.test.ts (summonPlace).
  it.todo('Darkness, Night Eye: the image space and fMagicNightEyeAmbient (0.75)');
  it.todo('Disguise, Concussion: unused by vanilla, as the engine does them (no document says)');
});
