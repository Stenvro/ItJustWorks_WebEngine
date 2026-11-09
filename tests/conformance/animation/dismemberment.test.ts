// Conformance: dismemberment (engine map: Animation and bodies > Dismemberment): the head cut
// off by the Decapitate graph event, the piece that flies, the limb roll of a killing blow.
//
// Sources:
// - The engine, observed in the original (src/gameplay/combat/dismemberment.ts, docs/animation.md
//   "Dismemberment"): the head flies from the neck through the head, bent towards the killer's
//   swing, at fDecapInitialSpeed; the cut piece shows the 100s partitions; a killing blow rolls
//   a limb only for an explodable part, by iCombatExplodePartChance and
//   iCombatDismemberPartChance, then the weapon's hit behavior (WEAP DNAM).
// - The settings: the engine's defaults (iCombatDismemberPartChance 25, iCombatExplodePartChance 5,
//   fDecapInitialSpeed 250, fDecapitateBloodTime 5).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decapitationLaunch,
  faceKeepsPartition,
  HEAD_LIMB,
  LIMB_ROLL_DEFAULTS,
  limbGone,
  pieceShowsPartition,
  rollLimb,
  WeaponHitBehavior,
} from '../../../src/gameplay/combat/dismemberment.ts';
import { BodyPartFlag } from '../../../src/world/body-part-data.ts';
import {
  hasGamedata,
  loadSim,
  openSim,
  PLAYER_REF,
  SIM_STEP,
  type Sim,
} from '../../helpers/sim.ts';

describe('the head’s flight (original)', () => {
  it('from the neck through the head at fDecapInitialSpeed (250)', () => {
    const launch = decapitationLaunch([0, 0, 10], [0, 0, 0], undefined, 250);
    expect(launch).toEqual([0, 0, 250]);
  });
  it('bent towards the killer’s swing', () => {
    const launch = decapitationLaunch([0, 0, 10], [0, 0, 0], [1, 0, 0], 250);
    expect(launch?.[0]).toBeCloseTo(250 / Math.SQRT2, 3);
    expect(launch?.[2]).toBeCloseTo(250 / Math.SQRT2, 3);
  });
});

describe('the cut piece’s partitions (original)', () => {
  it('the piece shows the 100s (a helmet’s 130, the decapitation armor’s 150)', () => {
    expect(pieceShowsPartition(130)).toBe(true);
    expect(pieceShowsPartition(150)).toBe(true);
    expect(pieceShowsPartition(32)).toBe(false);
    expect(pieceShowsPartition(230)).toBe(false);
  });
  it('the head’s own shapes keep the 100s', () => {
    expect(faceKeepsPartition(130)).toBe(true);
    expect(faceKeepsPartition(230)).toBe(false);
  });
  it('IsLimbGone reads the limbs cut', () => {
    expect(limbGone([{ limb: 1 } as never], 1)).toBe(true);
    expect(limbGone(undefined, 1)).toBe(false);
  });
});

describe('the limb roll of a killing blow (original, settings)', () => {
  it('the settings: iCombatDismemberPartChance 25, iCombatExplodePartChance 5', () => {
    expect(LIMB_ROLL_DEFAULTS).toEqual({
      dismemberPartChance: 25,
      explodePartChance: 5,
      playerLimbDamageMult: 0.5,
    });
  });
  it('only an explodable part rolls', () => {
    const part = { flags: 0, explosionChance: 100 };
    expect(rollLimb(part, WeaponHitBehavior.normal, 0)).toEqual({
      dismember: false,
      explode: false,
    });
  });
  it('an explodable part dismembers under iCombatDismemberPartChance', () => {
    const part = { flags: BodyPartFlag.explodable, explosionChance: 0 };
    expect(rollLimb(part, WeaponHitBehavior.normal, 24).dismember).toBe(true);
    expect(rollLimb(part, WeaponHitBehavior.normal, 25).dismember).toBe(false);
  });
  it('the weapon’s hit behavior keeps only one or neither', () => {
    const part = { flags: BodyPartFlag.explodable, explosionChance: 0 };
    expect(rollLimb(part, WeaponHitBehavior.noDismemberOrExplode, 0)).toEqual({
      dismember: false,
      explode: false,
    });
    expect(rollLimb(part, WeaponHitBehavior.explodeOnly, 0)).toEqual({
      dismember: false,
      explode: true,
    });
  });
});

// A bandit placed in the Bannered Mare (its patrons dead, out of the way), its sword drawn against
// the player, taken into the one-handed decapitation killmove as its victim (the player leading:
// ActorCombat.pairIdle). Its graph plays its side, KillMove1HMDecap (Paired_1HMKillMoveDecapSlash:
// 2_Decapitate at 0.76 s, 2_KillActor at 1.69 s).
const BANNERED_MARE = 0x1605e;
const VICTIM_SIDE = 'KillMove1HMDecap';

describe.skipIf(!hasGamedata())('a killmove’s decapitation (headless simulation)', () => {
  let sim: Sim;
  let bandit = 0;
  let took = false;
  let cutAt: number | undefined;
  let deadAt: number | undefined;
  let clipAtCut: string | undefined;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    for (const actor of sim.actors()) {
      if (actor.reference !== PLAYER_REF) await sim.kill(actor.reference);
    }
    const feet = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
    await sim.moveTo([feet[0] + 80, feet[1], feet[2]]);
    bandit = await sim.place(await sim.formId('NPC_', 'EncBandit01Melee1HNordM'), PLAYER_REF);
    await sim.moveTo(feet);
    const combat = sim.world.stage.combat;
    combat.startCombat(bandit, PLAYER_REF);
    // Its sword out, its graph in the drawn-weapon states that take a killmove's victim side.
    took = await sim.until(
      () => sim.actor(bandit)?.placed.behavior?.wouldHandle(VICTIM_SIDE) === true,
      20,
    );
    combat.pairIdle(PLAYER_REF, bandit, 'pa_' + VICTIM_SIDE);
    const state = sim.runtime.state;
    for (let t = 0; t < 4; t += SIM_STEP) {
      await sim.step(SIM_STEP);
      if (cutAt === undefined && limbGone(state.actors.get(bandit)?.dismembered, HEAD_LIMB)) {
        cutAt = t;
        clipAtCut = sim.actor(bandit)?.placed.behavior?.synchronizedClip()?.animation;
      }
      if (deadAt === undefined && sim.actor(bandit)?.dead === true) deadAt = t;
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('a killmove victim’s 2_Decapitate cuts its head in the paired clip (sim)  [data]', () => {
    expect(took).toBe(true);
    // Its own 2_Decapitate (0.76 s into its side), while it still plays the paired clip.
    expect(cutAt).toBeGreaterThan(0.6);
    expect(cutAt).toBeLessThan(1);
    expect(clipAtCut?.toLowerCase()).toContain('paired_1hmkillmovedecapslash');
    // Then its 2_KillActor (1.69 s): it dies by its killer.
    expect(deadAt).toBeGreaterThan(1.5);
    expect(deadAt).toBeLessThan(2.2);
    expect(sim.deaths().find((death) => death.actor === bandit)?.killer).toBe(PLAYER_REF);
  });
});

// Hulda (the Bannered Mare's innkeeper) beheaded (the Decapitate handler) and killed, her
// decapitation armor then taken off her (as an outfit put back whole would leave her), saved and
// loaded again: as her body is made the limb's record dresses her again.
const HULDA = 0x1a66e;

describe.skipIf(!hasGamedata())('a dismembered corpse loaded again (headless simulation)', () => {
  let added: number[] = [];
  let wornAfter: number[] = [];
  let headGone = false;

  beforeAll(async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    let bytes: Uint8Array;
    try {
      await sim.step(1);
      const before = await sim.runtime.equipment.worn(HULDA);
      await sim.world.stage.dismemberment.decapitate(HULDA);
      await sim.kill(HULDA, PLAYER_REF);
      await sim.step(3);
      added = (await sim.runtime.equipment.worn(HULDA)).filter((form) => !before.includes(form));
      for (const form of added) await sim.runtime.equipment.unequip(HULDA, form);
      await sim.step(0.5);
      bytes = await sim.save();
    } finally {
      await sim.close();
    }
    const after = await loadSim(bytes);
    try {
      await after.step(3);
      wornAfter = await after.runtime.equipment.worn(HULDA);
      headGone = limbGone(after.runtime.state.actors.get(HULDA)?.dismembered, HEAD_LIMB);
    } finally {
      await after.close();
    }
  }, 900_000);

  it('a reloaded corpse is re-dressed from its recorded worn objects  [original, M12]', () => {
    // The cut put her race's decapitation armor on her.
    expect(added.length).toBeGreaterThan(0);
    expect(headGone).toBe(true);
    for (const form of added) expect(wornAfter).toContain(form);
  });
});

describe('dismemberment (todo)', () => {
  // TODO(M13): the original registers the setting but no Skyrim code path is known to read it
  // (docs/animation.md, "Dismemberment"); what decals a cut leaves (the body part data's
  // severable impact data set and decal count) is not read.
  it.todo('iDismemberBloodDecalCount (10): the blood decals of a cut  [settings]');
});
