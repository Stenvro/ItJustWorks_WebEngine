import { describe, expect, it } from 'vitest';
import {
  CombatGroups,
  readCombatGroupSettings,
  type CombatGroupWorld,
  type DetectionReport,
} from './combat-groups.ts';

/** The combat-group settings Skyrim.esm stores (`node tools/gmst-info.ts --prefix fCombatStealth`). */
const SKYRIM_ESM: Readonly<Record<string, number>> = {
  fCombatStealthPointDrainMult: 3,
  fCombatStealthPointRegenAttackedWaitTime: 15,
  fCombatStealthPointRegenDetectedEventWaitTime: 10,
  fCombatStealthPointRegenMin: 5,
  fCombatStealthPointRegenMult: 0.2,
};

const BANDIT = 0x1001;
const ARCHER = 0x1002;
const PLAYER = 0x14;

type Vec3 = readonly [number, number, number];

/** A small fight: positions, combat targets, who sneaks. */
function fight(): {
  groups: CombatGroups;
  world: CombatGroupWorld;
  at: Map<number, Vec3>;
  targets: Map<number, number>;
  sneaking: Set<number>;
} {
  const groups = new CombatGroups();
  groups.settings = readCombatGroupSettings((name) => SKYRIM_ESM[name]);
  const at = new Map<number, Vec3>([
    [BANDIT, [0, 0, 0]],
    [ARCHER, [300, 0, 0]],
    [PLAYER, [500, 0, 0]],
  ]);
  const targets = new Map<number, number>([
    [BANDIT, PLAYER],
    [ARCHER, PLAYER],
  ]);
  const sneaking = new Set<number>();
  const world: CombatGroupWorld = {
    combatTarget: (member) => targets.get(member),
    fleeing: () => false,
    position: (actor) => at.get(actor),
    present: (actor) => at.has(actor),
    detects: () => true,
    sneaking: (target) => sneaking.has(target),
    invisible: () => false,
    sees: () => false,
  };
  return { groups, world, at, targets, sneaking };
}

const seen = (level: number, at: Vec3 = [500, 0, 0]): DetectionReport => ({
  level,
  lineOfSight: true,
  at,
});
const unseen = (level: number, at: Vec3 = [500, 0, 0]): DetectionReport => ({
  level,
  lineOfSight: false,
  at,
});

describe('combat groups', () => {
  it('puts allies that fight into one group, members leave, empty groups go', () => {
    const groups = new CombatGroups();
    const first = groups.join(1, []);
    expect(groups.join(2, [5, 1])).toBe(first);
    expect(groups.join(3, [])).not.toBe(first);
    expect(groups.size(2)).toBe(2);
    expect([...groups.allies(1)]).toEqual([2]);
    expect(groups.join(1, [3])).toBe(first);
    groups.addTarget(1, 9);
    expect(groups.target(2, 9)).toBeDefined();
    groups.forget(9);
    expect(groups.target(1, 9)).toBeUndefined();
    groups.leave(1);
    groups.leave(2);
    groups.leave(3);
    expect([...groups.groups()]).toHaveLength(0);
  });

  it('detects a target above the stealth threshold at once, and follows it as it moves', () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    expect(known?.stealthPoints).toBe(99);
    groups.report(BANDIT, PLAYER, seen(40), world, 0);
    expect(known?.known).toBe(true);
    expect(known?.lost).toBe(false);
    expect(known?.stealthPoints).toBe(0);
    // It keeps a copy of the place (the actor's own position moves on).
    const moving: [number, number, number] = [550, 0, 0];
    groups.report(BANDIT, PLAYER, seen(30, moving), world, 0.5);
    moving[0] = 9000;
    expect(known?.lastKnown).toEqual([550, 0, 0]);
    expect(known?.detectedAt).toEqual([550, 0, 0]);
    // Its points gone, any level above 0 detects it.
    groups.report(BANDIT, PLAYER, seen(3, [600, 0, 0]), world, 1);
    expect(known?.lastKnown).toEqual([600, 0, 0]);
    expect(known?.known).toBe(true);
  });

  it('keeps the highest level of its members, and the member that holds it', () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    groups.join(ARCHER, [BANDIT]);
    const known = groups.addTarget(BANDIT, PLAYER);
    groups.report(BANDIT, PLAYER, seen(40), world, 0);
    groups.report(ARCHER, PLAYER, unseen(-20), world, 0.5);
    expect(known?.level).toBe(40);
    groups.report(BANDIT, PLAYER, unseen(-10), world, 1);
    expect(known?.level).toBe(-10);
  });

  it('drains the stealth points of a target sensed below the threshold, then detects it', () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    if (!known) throw new Error('no target');
    // Level 10 ≤ 25: where it is is known, but it is lost (the group searches).
    groups.report(BANDIT, PLAYER, seen(10), world, 0);
    expect(known.known).toBe(false);
    expect(known.lost).toBe(true);
    groups.update(world, 0);
    expect(groups.searching(BANDIT)).toBe(true);
    // 99 points drain by 10 × fCombatStealthPointDrainMult (3) a second: gone in 3.3 s.
    for (let t = 0.2; t <= 3.5; t += 0.2) groups.update(world, t);
    expect(known.stealthPoints).toBe(0);
    groups.report(BANDIT, PLAYER, seen(10), world, 3.6);
    expect(known.known).toBe(true);
    expect(known.lost).toBe(false);
    groups.update(world, 3.7);
    expect(groups.searching(BANDIT)).toBe(false);
  });

  it('needs iCombatStealthPointSneakDetectionThreshold for a sneaking target', () => {
    const { groups, world, sneaking } = fight();
    sneaking.add(PLAYER);
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    groups.report(BANDIT, PLAYER, seen(60), world, 0);
    expect(known?.known).toBe(false);
    groups.report(BANDIT, PLAYER, seen(71), world, 1);
    expect(known?.known).toBe(true);
  });

  it('loses a target not known of for fCombatDetectionLostTimeLimit, or looked at and not seen', () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    if (!known) throw new Error('no target');
    groups.report(BANDIT, PLAYER, seen(40), world, 0);
    // Unseen behind cover: followed for a while, then lost.
    groups.report(BANDIT, PLAYER, unseen(-5), world, 5);
    expect(known.lost).toBe(false);
    groups.report(BANDIT, PLAYER, unseen(-5), world, 11);
    expect(known.known).toBe(false);
    groups.report(BANDIT, PLAYER, unseen(-5), world, 21.5);
    expect(known.lost).toBe(true);
    // Another: in the line of sight, undetected and no longer followed: lost at once.
    const other = groups.addTarget(BANDIT, ARCHER + 1);
    if (!other) throw new Error('no target');
    groups.report(BANDIT, ARCHER + 1, seen(-5), world, 0);
    expect(other.lost).toBe(true);
  });

  it('brings the stealth points back once lost, after the waits, and gives the target up', () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    if (!known) throw new Error('no target');
    groups.report(BANDIT, PLAYER, seen(40), world, 0);
    // Lost at 11 s (not known of for 10 s).
    groups.report(BANDIT, PLAYER, unseen(-10), world, 11);
    expect(known.lost).toBe(true);
    let t = 11;
    for (; t < 20.9; t += 0.1) groups.update(world, t);
    // fCombatStealthPointRegenLostWaitTime (10 s) not yet past: none back.
    expect(known.stealthPoints).toBe(0);
    for (; t < 30; t += 0.1) groups.update(world, t);
    // max(fCombatStealthPointRegenMin 5, 10 × 0.2) a second.
    expect(known.stealthPoints).toBeGreaterThan(35);
    expect(known.stealthPoints).toBeLessThan(55);
    expect(groups.searching(BANDIT)).toBe(true);
    // Full again while the group searches: given up.
    let given: { member: number; target: number }[] = [];
    for (; t < 70 && given.length === 0; t += 0.1) given = groups.update(world, t);
    expect(given).toEqual([{ member: BANDIT, target: PLAYER }]);
    expect(groups.target(BANDIT, PLAYER)).toBeUndefined();
  });

  it("caps a target's points when it attacks or makes itself heard", () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    groups.attacked(BANDIT, PLAYER, [500, 0, 0], 0);
    expect(known?.stealthPoints).toBe(50);
    expect(known?.attackedAt).toEqual([500, 0, 0]);
    const other = groups.addTarget(BANDIT, ARCHER + 1);
    groups.report(BANDIT, ARCHER + 1, { ...unseen(0), event: [100, 0, 0] }, world, 0);
    expect(other?.stealthPoints).toBe(75);
    expect(other?.eventAt).toEqual([100, 0, 0]);
  });

  it('gives a lost target nobody attacks up after fCombatDetectionLostRemoveTime', () => {
    const { groups, world, targets } = fight();
    targets.clear();
    groups.join(BANDIT, []);
    groups.addTarget(BANDIT, PLAYER);
    groups.report(BANDIT, PLAYER, unseen(-10), world, 0);
    expect(groups.target(BANDIT, PLAYER)?.lost).toBe(true);
    expect(groups.update(world, 29)).toEqual([]);
    expect(groups.update(world, 31)).toEqual([{ member: BANDIT, target: PLAYER }]);
  });

  it('detects targets fully near members out of the high process', () => {
    const { groups, world } = fight();
    groups.join(BANDIT, []);
    const known = groups.addTarget(BANDIT, PLAYER);
    groups.update({ ...world, detects: () => false }, 0);
    expect(known?.level).toBe(100);
    expect(known?.known).toBe(true);
  });
});
