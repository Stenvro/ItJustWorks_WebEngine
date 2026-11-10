import { describe, expect, it } from 'vitest';
import { BodyPartFlag } from '../../world/body-part-data.ts';
import {
  decapitationLaunch,
  faceKeepsPartition,
  cripplesLimb,
  HEAD_LIMB,
  limbDamage,
  limbGone,
  pieceShowsPartition,
  redressing,
  rollLimb,
  SWING_SECONDS,
  SwingTrail,
  WeaponHitBehavior,
} from './dismemberment.ts';

describe('dismemberment', () => {
  it('knows the limbs gone', () => {
    expect(limbGone(undefined, HEAD_LIMB)).toBe(false);
    expect(limbGone([{ limb: HEAD_LIMB, worn: [] }], HEAD_LIMB)).toBe(true);
    expect(limbGone([{ limb: 0, worn: [] }], HEAD_LIMB)).toBe(false);
  });

  it('dresses a reloaded corpse again as its cut limb recorded it', () => {
    const limbs = [{ limb: HEAD_LIMB, worn: [0x10, 0x20, 0xdecab] }];
    // Its outfit came back without the decapitation armor and with a helmet.
    expect(redressing(limbs, [0x10, 0x20, 0x30])).toEqual({ equip: [0xdecab], unequip: [0x30] });
    expect(redressing(limbs, [0x20, 0xdecab, 0x10])).toBeUndefined();
    expect(redressing(undefined, [0x10])).toBeUndefined();
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

  it('reads how a weapon came into the blow from where it was, not from one frame', () => {
    const trail = new SwingTrail();
    expect(trail.before(1)).toBeUndefined();
    // Coming down at 300 a second, stopped dead at 1 s and creeping sideways.
    for (let frame = 0; frame <= 66; frame++) {
      const time = frame / 60;
      const at: [number, number, number] =
        frame <= 60 ? [0, 0, 300 - 300 * time] : [(frame - 60) * 1, 0, 0];
      trail.record(time, at);
    }
    const before = trail.before(1 - SWING_SECONDS);
    expect(before?.time).toBeCloseTo(0.9, 1);
    expect(before?.at[2]).toBeCloseTo(30, -1);
    // The time asked falls between two: the one before it.
    expect(trail.before(1 + 0.5 / 60)?.time).toBeCloseTo(1);
    // Older than it keeps: as far back as is known.
    expect(trail.before(-5)?.time).toBeCloseTo(66 / 60 - 63 / 60);
  });

  it('reads where a weapon was at a moment between two frames, at any frame rate', () => {
    // The same fall at 15 frames a second: a moment between two frames is read between them.
    const trail = new SwingTrail();
    expect(trail.at(1)).toBeUndefined();
    for (let frame = 0; frame <= 15; frame++) trail.record(frame / 15, [0, 0, 300 - 20 * frame]);
    const at = trail.at(0.95);
    expect(at?.time).toBe(0.95);
    expect(at?.at[2]).toBeCloseTo(300 - 300 * 0.95);
    // Past the newest or before the oldest: the place there, at its own time.
    expect(trail.at(2)).toEqual({ at: [0, 0, 0], time: 1 });
    expect(trail.at(-1)).toEqual({ at: [0, 0, 300], time: 0 });
  });

  it('reads a swing over the animation, not the clock, where long frames were cut', () => {
    // Found in review 2026-11-10: in the browser at 4 frames a second each graph update was cut to
    // 0.1 s; read over 0.1 s of the clock, Helgen's headsman's axe came into the blow at 12 units
    // a second, bent aside by where it stopped. Here: down at 390 a second until 1 s into its
    // animation, then aside at 60; frames of 0.24 s that run the animation 0.1 s each.
    const axe = (animation: number): [number, number, number] =>
      animation <= 1 ? [0, 0, 390 * (1 - animation)] : [60 * (animation - 1), 0, 0];
    const aside = (byAnimation: boolean): number => {
      const trail = new SwingTrail();
      for (let frame = 0; frame <= 14; frame++) {
        const clock = frame * 0.24;
        trail.record(byAnimation ? frame * 0.1 : clock, axe(frame * 0.1), clock);
      }
      // The blow 1.03 s into the animation: 0.3 of the frame that ran from 1 to 1.1.
      const time = trail.timeAt(10.3 * 0.24);
      if (time === undefined) throw new Error('no time');
      const to = trail.at(time);
      const from = trail.at(time - SWING_SECONDS);
      if (!to || !from) throw new Error('no places');
      const [x, , z] = [0, 1, 2].map((i) => (to.at[i] ?? 0) - (from.at[i] ?? 0));
      return (Math.atan2(Math.abs(x ?? 0), Math.abs(z ?? 0)) * 180) / Math.PI;
    };
    expect(aside(true)).toBeLessThan(5);
    expect(aside(false)).toBeGreaterThan(15);
    // Kept by the clock alone (recorded with no clock of its own): the clock is its time.
    const trail = new SwingTrail();
    for (let frame = 0; frame <= 4; frame++) trail.record(frame * 0.1, [frame, 0, 0]);
    expect(trail.timeAt(0.25)).toBeCloseTo(0.25);
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

  it('takes a share of the limb by the damage and cripples only an explodable limb', () => {
    // 20 damage on 100 health at a part of half the health: 40 percent of the limb.
    expect(limbDamage(20, 100, { healthPercent: 50 }, false)).toBeCloseTo(40);
    // The player takes fCombatPlayerLimbDamageMult (0.5) of it.
    expect(limbDamage(20, 100, { healthPercent: 50 }, true)).toBeCloseTo(20);
    expect(limbDamage(20, 100, { healthPercent: 0 }, false)).toBe(0);
    expect(limbDamage(20, 0, { healthPercent: 50 }, false)).toBe(20);
    expect(
      limbDamage(20, 100, { healthPercent: 50 }, true, {
        dismemberPartChance: 25,
        explodePartChance: 5,
        playerLimbDamageMult: 1,
      }),
    ).toBeCloseTo(40);
    expect(cripplesLimb({ flags: BodyPartFlag.explodable }, 30, 40)).toBe(true);
    expect(cripplesLimb({ flags: BodyPartFlag.explodable }, 50, 40)).toBe(false);
    expect(cripplesLimb({ flags: BodyPartFlag.explodable }, 0, 40)).toBe(false);
    expect(cripplesLimb({ flags: BodyPartFlag.severable }, 30, 40)).toBe(false);
  });
});
