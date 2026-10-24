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

import { describe, expect, it } from 'vitest';
import {
  decapitationLaunch,
  faceKeepsPartition,
  LIMB_ROLL_DEFAULTS,
  limbGone,
  pieceShowsPartition,
  rollLimb,
  WeaponHitBehavior,
} from '../../../src/gameplay/combat/dismemberment.ts';
import { BodyPartFlag } from '../../../src/world/body-part-data.ts';

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
    expect(LIMB_ROLL_DEFAULTS).toEqual({ dismemberPartChance: 25, explodePartChance: 5 });
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

describe('dismemberment (todo)', () => {
  it.todo('a reloaded corpse is re-dressed from its recorded worn objects  [original, M12]');
  it.todo('iDismemberBloodDecalCount (10): the blood decals of a cut  [settings]');
  it.todo('a killmove victim’s 2_Decapitate cuts its head in the paired clip (sim)  [data]');
});
