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
// - The records: Fireball (FireDamageFFAimedArea, 40 points in 15 feet).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chainEffectiveness,
  EXPLOSION_DEFAULTS,
  explosionShare,
  knockdownShareEnough,
  wardFacesBurst,
} from '../../../src/gameplay/magic/explosions.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { parseMagicItem } from '../../../src/world/magic-records.ts';
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

describe.skipIf(!hasGamedata())('a ward against a fireball’s burst (sim)', () => {
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
    await runtime.casting.area(delivered, ahead);
    expect(await health()).toBe(before);
    await runtime.casting.area(delivered, behind);
    expect(before - (await health())).toBeGreaterThanOrEqual(40);
    runtime.actors.modifyTemporary(target.reference, WARD_POWER, -200);
  }, 120_000);
});

describe('what the original’s projectiles and explosions do that ours do not yet', () => {
  it.todo('a projectile’s impact pushes what it hits (PROJ impact force, fProjectileKnockMult*)');
  it.todo('a cone (Unrelenting Force, Fire Breath) sweeps out at its speed, reaching as it goes');
  it.todo('a lobber bounces as its PROJ says (Bounce Multiplier) before it bursts');
  it.todo('an area’s effects need a line of sight from the point (unless SPIT 0x80000)');
  it.todo(
    'an explosion’s own damage meets a ward that faces it (original: the explosion’s damage path)',
  );
});
