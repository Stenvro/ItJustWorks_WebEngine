// Conformance: falling and swimming (engine map: Physics > Falling, swimming). Falls take health
// by the engine's formula, from the player and every other actor; under water an actor's breath
// runs down and the player drowns. Skipped without game data where it needs it.
//
// Sources:
// - The engine's rule, observed in the original (src/gameplay/falling.ts, src/gameplay/breath.ts;
//   docs/gameplay.md, "Breath and drowning"):
//   - a landing after a fall higher than fJumpFallHeightMin takes ((height − min) ×
//     fJumpFallHeightMult)^fJumpFallHeightExponent, the player by those settings and every other
//     actor by the ones ending in "NPC"; one getting up from a ragdoll measures against a quarter
//     of the minimum; water takes nothing;
//   - breath lasts fActorSwimBreathBase + fActorSwimBreathMult × 50 s (the engine passes 50);
//     under water (submersion 0.875, the engine's constant) it runs down, out of it (or with
//     Water Breathing) it is whole at once; gone, the player loses fActorSwimBreathDamage of their
//     base health a second (through fDiffMultHPToPC), with the NPCHumanDrowning sound; other
//     actors never drown; coming up after fActorLeaveWaterBreathTimer (4 s) under water says
//     Leave Water Breath (LWBS, subtype 102).
// - The settings' built-in values (the engine's defaults) and Skyrim.esm's (node tools/gmst-info.ts
//   --prefix fJumpFall, --prefix fActorSwim): fJumpFallHeightMin 600, Mult 0.1, Exponent 1.65
//   (Skyrim.esm 1.45); MinNPC 300 (Skyrim.esm 450), MultNPC 0.1, ExponentNPC 1.65;
//   fActorSwimBreathBase 10, Mult 0.5 (Skyrim.esm 0.2), Damage 0.2 (Skyrim.esm 0.08);
//   fActorLeaveWaterBreathTimer 4.
// - UESP "Skyrim:Damage" (falling) for the formula's shape.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Breath,
  BREATH_DEFAULTS,
  drowningDamage,
  maxBreath,
  UNDERWATER_SUBMERSION,
} from '../../../src/gameplay/breath.ts';
import {
  fallDamage,
  NPC_FALL,
  PLAYER_FALL,
  RAGDOLL_FALL_SHARE,
} from '../../../src/gameplay/falling.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

/** Skyrim.esm's settings (GMST). */
const ESM_PLAYER_FALL = { ...PLAYER_FALL, exponent: 1.45 };
const ESM_NPC_FALL = { ...NPC_FALL, min: 450 };
const ESM_BREATH = { ...BREATH_DEFAULTS, mult: 0.2, damage: 0.08 };

describe('falling damage (the engine’s formula)', () => {
  it('takes nothing up to fJumpFallHeightMin (600 for the player, 450 for NPCs)', () => {
    expect(fallDamage(600, ESM_PLAYER_FALL)).toBe(0);
    expect(fallDamage(450, ESM_NPC_FALL)).toBe(0);
  });

  it('takes ((1000 − 600) × 0.1)^1.45 ≈ 210.4 from the player falling 1000 units', () => {
    expect(fallDamage(1000, ESM_PLAYER_FALL)).toBeCloseTo(Math.pow(40, 1.45), 6);
    expect(fallDamage(1000, ESM_PLAYER_FALL)).toBeCloseTo(210.4, 1);
  });

  it('takes ((1000 − 450) × 0.1)^1.65 ≈ 744 from an NPC falling 1000 units', () => {
    expect(fallDamage(1000, ESM_NPC_FALL)).toBeCloseTo(Math.pow(55, 1.65), 6);
    expect(fallDamage(1000, ESM_NPC_FALL)).toBeCloseTo(744.0, 0);
  });

  it('measures one getting up from a ragdoll against a quarter of the minimum', () => {
    expect(fallDamage(300, ESM_PLAYER_FALL, RAGDOLL_FALL_SHARE)).toBeCloseTo(Math.pow(15, 1.45), 6);
    expect(RAGDOLL_FALL_SHARE).toBe(0.25);
  });

  it.todo(
    'breaks a leg on a hard landing: fFallLegDamageMult (0.5), iFallLegDamageChance (50)  ' +
      '[settings; original: unread]',
  );
  it.todo('takes nothing from a fall into water deep enough to swim  [original] (sim)');
});

describe('breath and drowning (the engine’s rule)', () => {
  it('lasts fActorSwimBreathBase + fActorSwimBreathMult × 50: 20 s with Skyrim.esm, 35 built in', () => {
    expect(maxBreath(ESM_BREATH)).toBe(20);
    expect(maxBreath(BREATH_DEFAULTS)).toBe(35);
  });

  it('runs down only under water (0.875 of the height), and is whole again on coming up', () => {
    const breath = new Breath(ESM_BREATH);
    expect(UNDERWATER_SUBMERSION).toBe(0.875);
    breath.step(5, 0.8);
    expect(breath.remaining).toBe(20);
    breath.step(5, 0.9);
    expect(breath.remaining).toBe(15);
    breath.step(0.1, 0.5);
    expect(breath.remaining).toBe(20);
  });

  it('keeps it whole with Water Breathing', () => {
    const breath = new Breath(ESM_BREATH);
    const step = breath.step(60, 1, true);
    expect(breath.remaining).toBe(20);
    expect(step.drowning).toBe(0);
  });

  it('drowns once it is gone: 8 % of base health a second with Skyrim.esm', () => {
    const breath = new Breath(ESM_BREATH);
    const steps = Array.from({ length: 25 }, () => breath.step(1, 1));
    expect(steps.slice(0, 20).every((step) => step.drowning === 0)).toBe(true);
    expect(steps.slice(20).every((step) => step.drowning === 1)).toBe(true);
    // A base health of 100: 8 a second (before the difficulty).
    expect(drowningDamage(100, 1, ESM_BREATH)).toBeCloseTo(8, 6);
    expect(drowningDamage(250, 0.5, ESM_BREATH)).toBeCloseTo(10, 6);
  });

  it('gasps on coming up after more than fActorLeaveWaterBreathTimer (4 s) under water', () => {
    const short = new Breath(ESM_BREATH);
    short.step(1, 1);
    short.step(2, 1);
    expect(short.step(0.1, 0).gasped).toBe(false);
    const long = new Breath(ESM_BREATH);
    long.step(1, 1);
    long.step(3, 1);
    long.step(1.5, 1);
    expect(long.step(0.1, 0).gasped).toBe(true);
  });

  it.todo('plays NPCHumanDrowning on the player while they drown  [original] (sim: a deep-water place)');
  it.todo(
    'says the Leave Water Breath line (LWBS) on coming up after 4 s under water  [original] (sim)',
  );
  it.todo(
    'sends an NPC running out of breath to the surface, never drowning it  [original: the action ' +
      'the engine starts is not identified] (sim)',
  );
  it.todo('shows the breath meter on the HUD while the player is under water  [UI] (sim)');
});

describe('swimming', () => {
  it.todo(
    'swims every actor whose submersion reaches 0.7 (the engine marks it swimming), not only ' +
      'the player  [original] (sim: an NPC led into a river)',
  );
  it.todo('jumps out of water by fJumpSwimmingMult (2)  [settings]');
  it.todo(
    'knocks an actor down in fast water: fWaterKnockdownVelocity (5 with Skyrim.esm) and ' +
      'fWaterKnockdownSize* by size  [settings; original: unread]',
  );
});

/** WhiterunWorld [0001A26F]: its busiest cell, outdoors (nothing over the actors' heads). */
const WHITERUN_WORLD = 0x1a26f;

describe.skipIf(!hasGamedata())('an NPC falls 1000 units (headless simulation)', () => {
  let sim: Sim;
  let actor = 0;
  let before = 0;
  let after = 0;

  beforeAll(async () => {
    sim = await openSim({ hour: 12, gridRadius: 1 });
    const cell = (await sim.world.session.worldspace(WHITERUN_WORLD)).busiestCell() ?? [0, 0];
    await sim.openExterior(WHITERUN_WORLD, cell);
    await sim.step(2);
    for (const staged of sim.actors()) {
      if (staged.reference === 0x14 || staged.dead || !staged.grounded) continue;
      if (!staged.enabled(staged.reference)) continue;
      if (((await sim.distance(staged.reference, 0x14)) ?? Infinity) > 3000) continue;
      if (await sim.runtime.actors.isEssential(staged.reference)) continue;
      actor = staged.reference;
      break;
    }
    const at = await sim.position(actor);
    before = (await sim.runtime.actors.value(actor, ActorValue.health)).current;
    if (at) sim.runtime.move(actor, [at[0], at[1], at[2] + 1000]);
    await sim.step(4);
    after = (await sim.runtime.actors.value(actor, ActorValue.health)).current;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('finds an NPC that is not essential', () => {
    expect(actor).not.toBe(0);
  });

  it('takes the NPCs’ falling damage as it lands (about 744: all its health)', () => {
    expect(before - after).toBeGreaterThanOrEqual(Math.min(before, 700));
  });
});
