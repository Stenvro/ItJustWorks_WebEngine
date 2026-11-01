// Conformance: projectiles and explosions (engine map: Magic, effects, perks > Projectiles,
// explosions): what an explosion does by distance, whom it knocks down, a chain's falloff, and a
// ward against a burst.
//
// Sources:
// - The engine's rules, observed in the original (docs/gameplay.md, "Delivery"): an actor within an
//   explosion's radius takes 1 − (distance / radius)² of it; it knocks down only above
//   fExplosionForceKnockdownMinimum (0.15); a chain explosion loses
//   fMagicChainExplosionEffectivenessDelta (0.1) for each actor reached; a ward meets the hostile
//   effects of a burst (an explosion, an area) whose point lies within half of
//   fWardAngleForExplosions (90°) of its actor's facing.
// - The records: Fireball (FireDamageFFAimedArea, 40 points in 15 feet); the magic effect flags
//   No Area (DATA 0x800: the effect takes no area; the Creation Kit greys its area out) and No
//   Hit Event (DATA 0x10: it sends no OnHit), xEdit's TES5 MGEF; Painless (DATA 0x4000000: a
//   hostile effect's target does not cry out in pain, Creation Kit "Magic Effect"); the
//   enchantment flag Extend Duration On Recast (ENIT 0x4, Creation Kit "Enchantment").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chainEffectiveness,
  EXPLOSION_DEFAULTS,
  explosionShare,
  knockdownShareEnough,
  wardFacesBurst,
} from '../../../src/gameplay/magic/explosions.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { EffectFlag } from '../../../src/world/magic-effects.ts';
import { parseMagicItem, type MagicItemRecord } from '../../../src/world/magic-records.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const WARD_POWER = 63;
const BANNERED_MARE = 0x1605e;

describe('an explosion', () => {
  it('reaches by 1 − (distance / radius)², nothing beyond its radius', () => {
    expect(explosionShare(0, 200)).toBe(1);
    expect(explosionShare(100, 200)).toBe(0.75);
    expect(explosionShare(201, 200)).toBe(0);
  });

  it('knocks down only where its share is above fExplosionForceKnockdownMinimum (0.15)', () => {
    expect(EXPLOSION_DEFAULTS.knockdownMinimum).toBe(0.15);
    expect(knockdownShareEnough(0.15)).toBe(false);
    expect(knockdownShareEnough(0.16)).toBe(true);
  });

  it('weakens a chain by 0.1 for each actor it reached', () => {
    expect(chainEffectiveness(0)).toBe(1);
    expect(chainEffectiveness(3)).toBeCloseTo(0.7, 9);
    expect(chainEffectiveness(20)).toBe(0);
  });

  it('meets a ward when it bursts within 45° of the ward’s facing (fWardAngleForExplosions 90)', () => {
    expect(EXPLOSION_DEFAULTS.wardAngle).toBe(90);
    // Facing +Y (heading 0).
    expect(wardFacesBurst([0, 0, 0], 0, [0, 100, 0])).toBe(true);
    expect(wardFacesBurst([0, 0, 0], 0, [60, 100, 0])).toBe(true);
    expect(wardFacesBurst([0, 0, 0], 0, [100, 60, 0])).toBe(false);
    expect(wardFacesBurst([0, 0, 0], 0, [0, -100, 0])).toBe(false);
    // Facing +X (heading 90°, turning clockwise).
    expect(wardFacesBurst([0, 0, 0], Math.PI / 2, [100, 0, 0])).toBe(true);
  });
});

describe.skipIf(!hasGamedata())('a fireball’s burst and other hits on actors (sim)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('takes the burst it faces and lets one behind it through', async () => {
    const runtime = sim.runtime;
    const [target, caster] = sim.actors();
    expect(target && caster).toBeTruthy();
    if (!target || !caster) return;
    const record = await sim.db.get(await sim.formId('SPEL', 'Fireball'));
    const item = record ? parseMagicItem(record) : undefined;
    expect(item).toBeDefined();
    if (!item) return;
    const placement = runtime.world.livePlacement?.(target.reference);
    expect(placement).toBeDefined();
    if (!placement) return;
    const [x, y, z] = placement.position;
    const heading = placement.rotation?.[2] ?? 0;
    const ahead: [number, number, number] = [
      x + Math.sin(heading) * 60,
      y + Math.cos(heading) * 60,
      z + 60,
    ];
    const behind: [number, number, number] = [
      x - Math.sin(heading) * 60,
      y - Math.cos(heading) * 60,
      z + 60,
    ];
    const health = async (): Promise<number> =>
      (await runtime.actors.value(target.reference, ActorValue.health)).current;
    const delivered = {
      caster: caster.reference,
      item,
      via: 'spell' as const,
      dual: false,
      cost: await runtime.casting.cost(caster.reference, { item, via: 'spell' }),
    };
    runtime.actors.modifyTemporary(target.reference, WARD_POWER, 200);
    const before = await health();
    const applied = (): number =>
      sim.events('magicEffectApply').filter((event) => event.target === target.reference).length;
    const told = applied();
    await runtime.casting.area(delivered, ahead);
    expect(await health()).toBe(before);
    // The ward took it all: no effect took hold, none was told (OnMagicEffectApply).
    expect(applied()).toBe(told);
    await runtime.casting.area(delivered, behind);
    expect(before - (await health())).toBeGreaterThanOrEqual(40);
    expect(applied()).toBeGreaterThan(told);
    runtime.actors.modifyTemporary(target.reference, WARD_POWER, -200);
  }, 120_000);

  it('lets an explosion’s own damage meet the ward it faces (dunHighGate’s 60-point fireball)', async () => {
    const runtime = sim.runtime;
    const [target, caster] = sim.actors();
    const placement = target && runtime.world.livePlacement?.(target.reference);
    expect(placement && caster).toBeTruthy();
    if (!target || !caster || !placement) return;
    const explosion = await sim.formId('EXPL', 'dunHighGateFlamingThrallFireBallExp01');
    const [x, y, z] = placement.position;
    const heading = placement.rotation?.[2] ?? 0;
    const at = (sign: number): [number, number, number] => [
      x + sign * Math.sin(heading) * 40,
      y + sign * Math.cos(heading) * 40,
      z + 60,
    ];
    const health = async (): Promise<number> =>
      (await runtime.actors.value(target.reference, ActorValue.health)).current;
    runtime.actors.modifyTemporary(target.reference, WARD_POWER, 200);
    const before = await health();
    await runtime.casting.explode(caster.reference, explosion, at(1));
    expect(await health()).toBe(before);
    runtime.actors.modifyTemporary(target.reference, WARD_POWER, -200);
    runtime.actors.restore(target.reference, ActorValue.health, 1000);
    const whole = await health();
    await runtime.casting.explode(caster.reference, explosion, at(-1));
    expect(whole - (await health())).toBeGreaterThan(30);
    runtime.actors.restore(target.reference, ActorValue.health, 1000);
  }, 120_000);

  it('reaches only those an area’s point sees, unless the spell ignores line of sight', async () => {
    const runtime = sim.runtime;
    const [target, caster] = sim.actors();
    const record = await sim.db.get(await sim.formId('SPEL', 'Fireball'));
    const item = record ? parseMagicItem(record) : undefined;
    const placement = target && runtime.world.livePlacement?.(target.reference);
    expect(item && placement && caster).toBeTruthy();
    if (!target || !caster || !item || !placement) return;
    const point: [number, number, number] = [
      placement.position[0] + 50,
      placement.position[1],
      placement.position[2] + 60,
    ];
    const world = runtime.world;
    const sight = world.explosionReaches?.bind(world);
    world.explosionReaches = () => false;
    const delivered = (flags: number) => ({
      caster: caster.reference,
      item: { ...item, flags },
      via: 'spell' as const,
      dual: false,
      cost: { base: 0, magicka: 0, charge: 0, school: undefined, chargeTime: 0 },
    });
    try {
      expect(await runtime.casting.area(delivered(item.flags & ~0x80000), point)).not.toContain(
        target.reference,
      );
      expect(await runtime.casting.area(delivered(item.flags | 0x80000), point)).toContain(
        target.reference,
      );
    } finally {
      if (sight) world.explosionReaches = sight;
      runtime.actors.restore(target.reference, ActorValue.health, 1000);
    }
  }, 120_000);

  it('gives an effect with No Area none of its item’s area (Fireball’s 15 feet, FireDamageFFAimed75)', async () => {
    const runtime = sim.runtime;
    const [target, caster] = sim.actors();
    const record = await sim.db.get(await sim.formId('SPEL', 'Fireball'));
    const item = record ? parseMagicItem(record) : undefined;
    const placement = target && runtime.world.livePlacement?.(target.reference);
    const first = item?.effects[0];
    expect(item && placement && caster && first).toBeTruthy();
    if (!target || !caster || !item || !placement || !first) return;
    const noArea = await sim.formId('MGEF', 'FireDamageFFAimed75');
    expect(((await runtime.magic.effect(noArea))?.flags ?? 0) & EffectFlag.noArea).not.toBe(0);
    expect(((await runtime.magic.effect(first.effect))?.flags ?? 0) & EffectFlag.noArea).toBe(0);
    const point: [number, number, number] = [
      placement.position[0] + 50,
      placement.position[1],
      placement.position[2] + 60,
    ];
    // Fireball's effects in its 15 feet, every one swapped for the one with No Area.
    const delivered = (effects: MagicItemRecord['effects']) => ({
      caster: caster.reference,
      item: { ...item, effects },
      via: 'spell' as const,
      dual: false,
      cost: { base: 0, magicka: 0, charge: 0, school: undefined, chargeTime: 0 },
    });
    const swapped = item.effects.map((entry) => ({ ...entry, effect: noArea, area: 15 }));
    const world = runtime.world;
    const sight = world.explosionReaches?.bind(world);
    world.explosionReaches = () => true;
    try {
      expect(first.area).toBe(15);
      expect(await runtime.casting.area(delivered(swapped), point)).toEqual([]);
      expect(await runtime.casting.area(delivered(item.effects), point)).toContain(
        target.reference,
      );
    } finally {
      if (sight) world.explosionReaches = sight;
      runtime.actors.restore(target.reference, ActorValue.health, 1000);
    }
  }, 120_000);

  it('tells no hit (OnHit) for a spell whose every effect has No Hit Event', async () => {
    const runtime = sim.runtime;
    const [target, caster] = sim.actors();
    const record = await sim.db.get(await sim.formId('SPEL', 'Fireball'));
    const item = record ? parseMagicItem(record) : undefined;
    expect(item && target && caster).toBeTruthy();
    if (!target || !caster || !item) return;
    const delivered = {
      caster: caster.reference,
      item,
      via: 'spell' as const,
      dual: false,
      cost: { base: 0, magicka: 0, charge: 0, school: undefined, chargeTime: 0 },
    };
    const hits = (): number =>
      sim.events('hit').filter((event) => event.target === target.reference).length;
    const magic = runtime.magic;
    const effect = magic.effect.bind(magic);
    try {
      const before = hits();
      expect(await runtime.casting.deliver(delivered, target.reference)).toBeGreaterThan(0);
      expect(hits()).toBe(before + 1);
      // The same spell, its effects marked No Hit Event (MGEF DATA 0x10).
      magic.effect = async (formId) => {
        const record = await effect(formId);
        return record && { ...record, flags: record.flags | EffectFlag.noHitEvent };
      };
      expect(await runtime.casting.deliver(delivered, target.reference)).toBeGreaterThan(0);
      expect(hits()).toBe(before + 1);
    } finally {
      magic.effect = effect;
      runtime.actors.restore(target.reference, ActorValue.health, 1000);
    }
  }, 120_000);

  it('makes its target cry out unless every hostile effect is Painless', async () => {
    const magic = sim.runtime.magic;
    const record = await sim.db.get(await sim.formId('SPEL', 'Fireball'));
    const item = record ? parseMagicItem(record) : undefined;
    expect(item).toBeDefined();
    if (!item) return;
    expect(await magic.painful(item)).toBe(true);
    // Fury's effect (InfluenceAggUpFFAimed) is hostile and Painless in the record.
    const fury = await sim.formId('MGEF', 'InfluenceAggUpFFAimed');
    const furyFlags = (await magic.effect(fury))?.flags ?? 0;
    expect(furyFlags & EffectFlag.hostile).not.toBe(0);
    const effects = item.effects.slice(0, 1).map((entry) => ({ ...entry, effect: fury }));
    expect(await magic.painful({ ...item, effects })).toBe(false);
  }, 120_000);

  it('reads the weapons’ Can’t Drop and Non-hostile flags (WEAP DNAM)', async () => {
    const equipment = sim.runtime.equipment;
    expect(await equipment.cantDrop(await sim.formId('WEAP', 'BoundWeaponSwordMystic'))).toBe(true);
    expect(await equipment.cantDrop(await sim.formId('WEAP', 'IronSword'))).toBe(false);
    expect(await equipment.nonHostile(await sim.formId('WEAP', 'DA08RealEbonyBlade'))).toBe(true);
    expect(await equipment.nonHostile(await sim.formId('WEAP', 'IronSword'))).toBe(false);
  }, 120_000);

  it('adds an Extend Duration On Recast enchantment’s duration to the one on the target', async () => {
    const magic = sim.runtime.magic;
    const [target, caster] = sim.actors();
    const record = await sim.db.get(await sim.formId('ENCH', 'EnchWeaponSoulTrap01'));
    const item = record ? parseMagicItem(record) : undefined;
    expect(item && target && caster).toBeTruthy();
    if (!item || !target || !caster) return;
    const on = (): number[] =>
      magic
        .effectsOn(target.reference)
        .filter(([, entry]) => entry.item === item.formId)
        .map(([, entry]) => entry.duration);
    await magic.apply(item, target.reference, { caster: caster.reference });
    // Soul Trap 3 s on a hit (ENIT 0x4): a second hit makes it 6 s, one effect.
    expect(on()).toEqual([3]);
    await magic.apply(item, target.reference, { caster: caster.reference });
    expect(on()).toEqual([6]);
  }, 120_000);
});

describe('what the original’s projectiles and explosions do that ours do not yet', () => {
  // A projectile's impact force on what it hits: tests/conformance/physics/gameplay-impulses.test.ts.
  it.todo('a cone’s force pushes the bodies as its front passes them (all at once in ours)');
  it.todo('a lobber slides along a slope by fGrenadeFriction (ours rests where it lands)');
});
