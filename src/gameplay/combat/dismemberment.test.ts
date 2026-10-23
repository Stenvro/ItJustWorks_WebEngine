import { describe, expect, it } from 'vitest';
import { BodyPartFlag } from '../../world/body-part-data.ts';
import {
  decapitationLaunch,
  faceKeepsPartition,
  HEAD_LIMB,
  limbGone,
  pieceShowsPartition,
  rollLimb,
  WeaponHitBehavior,
} from './dismemberment.ts';

describe('dismemberment', () => {
  it('knows the limbs gone', () => {
    expect(limbGone(undefined, HEAD_LIMB)).toBe(false);
    expect(limbGone([{ limb: HEAD_LIMB, worn: [] }], HEAD_LIMB)).toBe(true);
    expect(limbGone([{ limb: 0, worn: [] }], HEAD_LIMB)).toBe(false);
  });

  it("shows the 100s on the cut piece; the head's own shapes lose their neck and biped slots", () => {
    // A helmet's 130 and 131, the decapitation armor's head cut (150): on the piece.
    expect([130, 131, 150].every(pieceShowsPartition)).toBe(true);
    // The biped slots stay on the body; the neck under the head (230) nowhere; 100 is neither.
    expect([30, 51, 100, 230].some(pieceShowsPartition)).toBe(false);
    // The FaceGen head keeps its head (130) and ears (143), not its neck (230).
    expect([130, 143].every(faceKeepsPartition)).toBe(true);
    expect([30, 230].some(faceKeepsPartition)).toBe(false);
  });

  it('flies the head off from the neck, bent by the swing, at the speed asked', () => {
    // Straight up from the neck without a swing.
    expect(decapitationLaunch([0, 0, 110], [0, 0, 100], undefined, 250)).toEqual([0, 0, 250]);
    // A swing along +x bends it 45 degrees.
    const bent = decapitationLaunch([0, 0, 110], [0, 0, 100], [900, 0, 0], 250);
    expect(bent?.[0]).toBeCloseTo(250 / Math.SQRT2);
    expect(bent?.[2]).toBeCloseTo(250 / Math.SQRT2);
    expect(decapitationLaunch([1, 1, 1], [1, 1, 1], undefined, 250)).toBeUndefined();
  });

  it('rolls a killing blow on an explodable part as the engine does', () => {
    const explodable = { flags: BodyPartFlag.explodable, explosionChance: 100 };
    // 5% × 100 explodes under 5, dismembers under 25.
    expect(rollLimb(explodable, WeaponHitBehavior.normal, 3)).toEqual({
      dismember: false,
      explode: true,
    });
    expect(rollLimb(explodable, WeaponHitBehavior.normal, 10)).toEqual({
      dismember: true,
      explode: false,
    });
    expect(rollLimb(explodable, WeaponHitBehavior.normal, 60)).toEqual({
      dismember: false,
      explode: false,
    });
    // The weapon's hit behavior keeps one, or neither.
    expect(rollLimb(explodable, WeaponHitBehavior.explodeOnly, 10).explode).toBe(true);
    expect(rollLimb(explodable, WeaponHitBehavior.dismemberOnly, 3).dismember).toBe(true);
    expect(rollLimb(explodable, WeaponHitBehavior.noDismemberOrExplode, 3)).toEqual({
      dismember: false,
      explode: false,
    });
    // An absolute chance of 100 always explodes; below it is the chance itself.
    const absolute = BodyPartFlag.explodable | BodyPartFlag.toHitChanceAbsolute;
    expect(rollLimb({ flags: absolute, explosionChance: 100 }, 0, 99).explode).toBe(true);
    expect(rollLimb({ flags: absolute, explosionChance: 50 }, 0, 40).explode).toBe(true);
    // Parts not flagged explodable never roll (no vanilla part is).
    expect(rollLimb({ flags: BodyPartFlag.severable, explosionChance: 100 }, 0, 0)).toEqual({
      dismember: false,
      explode: false,
    });
  });
});
