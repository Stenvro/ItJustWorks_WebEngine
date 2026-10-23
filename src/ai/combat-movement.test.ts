import { describe, expect, it } from 'vitest';
import {
  abortsRun,
  aimUpdateTime,
  backoffGoal,
  bearing,
  chooseCloseMovement,
  circleAngle,
  circleGoals,
  COMBAT_MOVEMENT_DEFAULTS,
  combatTurning,
  fallbackGoal,
  locationWidth,
  readCombatMovementSettings,
  strafeGoal,
  surroundGoal,
  TargetLocations,
  type MovementRun,
  type MovementTarget,
} from './combat-movement.ts';

const settings = COMBAT_MOVEMENT_DEFAULTS;
const degrees = (value: number): number => (value * Math.PI) / 180;
const flat = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

/** A target at the origin facing north (towards a fighter standing north of it). */
const TARGET: MovementTarget = {
  feet: [0, 0, 0],
  heading: 0,
  anticipated: [0, 0, 0],
  isPlayer: false,
};
/** A fighter 100 units north of it, facing it. */
const SELF = { feet: [0, 100, 0] as const, heading: Math.PI, radius: 20 };

describe('combat movement settings', () => {
  it("keeps the engine's defaults and takes the load order's", () => {
    expect(settings.targetLocationCount).toBe(24);
    expect(settings.backoffChance).toBe(0.25);
    expect(
      readCombatMovementSettings((name) => (name === 'fCombatBackoffChance' ? 0.5 : undefined))
        .backoffChance,
    ).toBe(0.5);
  });

  it('turns 1.25 times its running rate at twice its acceleration, within 1°', () => {
    const turning = combatTurning(settings);
    expect(turning.rateMult).toBeCloseTo(1.25);
    expect(turning.accelerationMult).toBe(2);
    expect(turning.tolerance).toBeCloseTo(degrees(1));
    expect(turning.raceTolerance).toBe(true);
  });

  it('takes its aim point again every 0.25 s, 0.1 s against the player within its reach', () => {
    expect(aimUpdateTime(false, false, true, settings)).toBe(0.25);
    expect(aimUpdateTime(false, true, true, settings)).toBe(0.1);
    expect(aimUpdateTime(false, true, false, settings)).toBe(0.25);
    expect(aimUpdateTime(true, true, true, settings)).toBe(0.25);
  });
});

describe('target locations', () => {
  const open = (_from: readonly number[], to: readonly number[]): number => flat(_from, to);

  it('takes the free place nearest to the attacker, at its distance', () => {
    const places = new TargetLocations();
    const chosen = places.choose(1, [0, 300, 0], 9, [0, 0, 0], 100, 20, open, settings);
    expect(chosen?.point[0]).toBeCloseTo(0);
    expect(chosen?.point[1]).toBeCloseTo(100);
    expect(chosen?.reservation.angle).toBeCloseTo(0);
  });

  it('leaves a place another attacker holds: the next one round', () => {
    const places = new TargetLocations();
    const first = places.choose(1, [0, 300, 0], 9, [0, 0, 0], 100, 20, open, settings);
    if (!first) throw new Error('no place');
    places.reserve(1, first.reservation);
    const second = places.choose(2, [0, 300, 0], 9, [0, 0, 0], 100, 20, open, settings);
    if (!second) throw new Error('no place');
    // Not the same place: at least the two widths' half sums apart.
    const apart = Math.abs(second.reservation.angle - first.reservation.angle);
    expect(apart).toBeGreaterThanOrEqual(
      (first.reservation.width + second.reservation.width) / 2 - 1e-9,
    );
    // A place of the second target is not the first's.
    expect(
      places.choose(2, [0, 300, 0], 8, [0, 0, 0], 100, 20, open, settings)?.reservation.angle,
    ).toBeCloseTo(0);
  });

  it('cuts a place short where the navmesh stops, and drops it below the least distance', () => {
    const places = new TargetLocations();
    // Northwards only 40 of 100 units: less than 0.67 of the distance, so not there.
    const walled = (from: readonly number[], to: readonly number[]): number =>
      to[1] !== undefined && to[1] > 50 ? 40 : flat(from, to);
    const chosen = places.choose(1, [0, 300, 0], 9, [0, 0, 0], 100, 20, walled, settings);
    expect(chosen).toBeDefined();
    expect(chosen?.point[1] ?? 0).toBeLessThan(50);
  });

  it('is out of position once its bearing leaves its place', () => {
    const places = new TargetLocations();
    const width = locationWidth(20, 100, settings);
    places.reserve(1, { target: 9, angle: 0, width });
    expect(places.outOfPosition(1, 9, [0, 100, 0], [0, 0, 0], settings)).toBe(false);
    expect(places.outOfPosition(1, 9, [100, 0, 0], [0, 0, 0], settings)).toBe(true);
  });

  it('is as wide as its size over its distance, within the settings', () => {
    expect(locationWidth(20, 100, settings)).toBeCloseTo(0.5);
    expect(locationWidth(20, 100000, settings)).toBeCloseTo(degrees(10));
    expect(locationWidth(200, 10, settings)).toBeCloseTo(degrees(180));
  });
});

describe('close movement', () => {
  const input = {
    distance: 100,
    range: 120,
    outer: 256,
    outOfPosition: false,
    fallbackChance: 0,
    circleChance: 0,
    circleDistantChance: 0,
  };

  it('advances, else surrounds, out of range', () => {
    expect(chooseCloseMovement({ ...input, distance: 300 }, () => 0, settings)).toEqual([
      'advance',
      'surround',
      'idle',
    ]);
  });

  it('repositions out of position', () => {
    expect(chooseCloseMovement({ ...input, outOfPosition: true }, () => 0, settings)[0]).toBe(
      'reposition',
    );
  });

  it('in range: falls back or circles by its chances, backs off by its chance', () => {
    expect(chooseCloseMovement({ ...input, fallbackChance: 1 }, () => 0.5, settings)).toEqual([
      'fallback',
      'idle',
    ]);
    expect(chooseCloseMovement({ ...input, circleChance: 1 }, () => 0.5, settings)).toEqual([
      'circle',
      'idle',
    ]);
    expect(chooseCloseMovement(input, () => 0.1, settings)).toEqual(['backoff', 'idle']);
    expect(chooseCloseMovement(input, () => 0.5, settings)).toEqual(['idle']);
  });

  it('backs off to its range when closer than 0.75 of it, unless its target moves away', () => {
    expect(backoffGoal(SELF, TARGET, 120, settings)).toBeUndefined();
    const leaving = { ...TARGET, anticipated: [0, -50, 0] as const };
    expect(backoffGoal({ ...SELF, feet: [0, 50, 0] }, leaving, 120, settings)).toBeUndefined();
    const goal = backoffGoal({ ...SELF, feet: [0, 50, 0] }, TARGET, 120, settings);
    expect(goal?.[1]).toBeCloseTo(120);
  });

  it('falls back straight away by 96 .. 256 units', () => {
    const goal = fallbackGoal(SELF, TARGET, () => 0.5, settings);
    expect(goal?.[0]).toBeCloseTo(0);
    expect(goal?.[1]).toBeCloseTo(100 + 176);
    // Not with its back to its target.
    expect(fallbackGoal({ ...SELF, heading: 0 }, TARGET, () => 0.5, settings)).toBeUndefined();
  });

  it('circles round its target by its angle, the first side first, in its sight', () => {
    const goals = circleGoals(SELF, TARGET, 100, 45, 1, settings);
    expect(goals).toHaveLength(2);
    const first = goals[0] ?? [0, 0, 0];
    expect(flat(first, TARGET.feet)).toBeCloseTo(100);
    expect(bearing(TARGET.feet, first)).toBeCloseTo(degrees(45));
    // Behind a target that looks away it does not go.
    expect(circleGoals(SELF, { ...TARGET, heading: Math.PI }, 100, 45, 1, settings)).toHaveLength(
      0,
    );
  });

  it('circles by an angle from its style and the target', () => {
    expect(circleAngle(1, false, 20, 100, () => 1, settings)).toBeCloseTo(90);
    expect(circleAngle(1, true, 20, 100, () => 1, settings)).toBeCloseTo(67.5);
    expect(circleAngle(0, false, 20, 100, () => 1, settings)).toBeCloseTo(34.38, 1);
  });

  it('keeps in its band round a crowded target', () => {
    expect(surroundGoal({ ...SELF, feet: [0, 400, 0] }, TARGET, 120, settings)).toBeUndefined();
    const goal = surroundGoal(SELF, TARGET, 120, settings);
    expect(goal?.[1]).toBeCloseTo(120 + 256);
  });

  it('strafes aside of the line to its target', () => {
    const goal = strafeGoal(SELF, TARGET, 1, () => 0, settings);
    expect(goal[0]).toBeCloseTo(-96);
    expect(goal[1]).toBeCloseTo(100);
  });

  it('gives a circle up when its target comes near its goal', () => {
    const run: MovementRun = {
      behaviour: 'circle',
      goal: [70, 70, 0],
      pace: 1.33,
      sprint: false,
      until: 10,
      wait: 0,
      waitTime: 0,
      check: 0,
    };
    expect(abortsRun(run, SELF, TARGET, 100, settings)).toBe(false);
    expect(abortsRun(run, SELF, { ...TARGET, feet: [60, 60, 0] }, 100, settings)).toBe(true);
  });
});
