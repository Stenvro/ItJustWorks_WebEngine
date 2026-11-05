import { describe, expect, it } from 'vitest';
import { AI_DEFAULTS, readAiSettings } from './ai-settings.ts';
import {
  CATCH_UP_DISTANCE,
  CATCH_UP_SECONDS,
  catchUpPlace,
  catchUpTime,
  DOOR_ARRIVAL_SPACING,
  doorArrivalSpot,
  doorSpacing,
  followGait,
  followOffset,
  followRadii,
  followSpeed,
  outOfSight,
  placesBeside,
} from './followers.ts';

/** Skyrim.esm's values over the engine's. */
const ESM = readAiSettings(
  (name) => ({ fFollowSpaceBetweenFollowers: 192, fFollowRunMinSlowdownMultiplier: 0.75 })[name],
);

describe('followers', () => {
  it('share out their places by distance from the leader (radii and spacing between them)', () => {
    const at = (reference: number, y: number, wanted = 256, radius = 14) => ({
      reference,
      position: [0, y, 0] as const,
      wanted,
      radius,
    });
    const followers = [at(3, 700), at(1, 300), at(2, 500)];
    const spacing = ESM.followSpacing;
    // The nearest at what it wants; each next both radii and the spacing beyond the one before.
    expect(followOffset([0, 0, 0], followers, 1, spacing)).toBe(0);
    expect(followOffset([0, 0, 0], followers, 2, spacing)).toBe(14 + 14 + 192);
    expect(followOffset([0, 0, 0], followers, 3, spacing)).toBe(2 * (14 + 14 + 192));
    // One that wants more than that keeps what it wants.
    expect(followOffset([0, 0, 0], [at(1, 300), at(2, 500, 800)], 2, spacing)).toBe(0);
    // One alone keeps what it wants.
    expect(followOffset([0, 0, 0], [at(1, 300)], 1, spacing)).toBe(0);
  });

  it('take the engine radii without their own, the smaller as the minimum', () => {
    expect(followRadii(AI_DEFAULTS, undefined, undefined)).toEqual({ min: 128, max: 150 });
    expect(followRadii(AI_DEFAULTS, 300, 100)).toEqual({ min: 100, max: 300 });
    expect(followRadii(AI_DEFAULTS, 64, undefined)).toEqual({ min: 64, max: 128 });
  });

  const GAIT = {
    followStartSprintDistance: 500,
    followWalkZoneMult: 1,
    followMatchSpeedZoneWidth: 128,
  };

  it('run with a running leader and to catch up; sprint after the player', () => {
    const walking = { running: false, sprinting: false, player: true };
    const running = { running: true, sprinting: false, player: true };
    // Beyond the walk zone, by no more than fFollowMatchSpeedZoneWidth: its package's gait.
    expect(followGait(350, 300, 'walk', walking, GAIT)).toBe('walk');
    // Beyond that it runs; with a running leader beyond the walk zone it runs.
    expect(followGait(450, 300, 'walk', walking, GAIT)).toBe('run');
    expect(followGait(350, 300, 'walk', running, GAIT)).toBe('run');
    // Farther than fFollowStartSprintDistance behind the running player, or as they sprint.
    expect(followGait(600, 300, 'walk', running, GAIT)).toBe('sprint');
    expect(followGait(350, 300, 'walk', { ...running, sprinting: true }, GAIT)).toBe('sprint');
    // Not after another actor.
    expect(followGait(600, 300, 'walk', { ...running, player: false }, GAIT)).toBe('run');
  });

  it('walk within their walk zone (fFollowWalkZoneMult times the middle of their radii)', () => {
    const running = { running: true, sprinting: false, player: false };
    expect(followGait(250, 300, 'run', running, GAIT)).toBe('walk');
    expect(followGait(350, 300, 'walk', running, GAIT)).toBe('run');
    expect(followGait(350, 300, 'run', running, { ...GAIT, followWalkZoneMult: 1.5 })).toBe('walk');
  });

  it('match their speed to the leader between their radii', () => {
    const at = (distance: number, leaderRatio = 1, running = false): number =>
      followSpeed(AI_DEFAULTS, { distance, inner: 100, outer: 300, running, leaderRatio });
    // At the middle as fast as the leader; at the outer radius fFollowExtraCatchUpSpeedMult more.
    expect(at(200)).toBeCloseTo(1);
    expect(at(300)).toBeCloseTo(1.2);
    // Nearer, slower, not below the walk's fFollowWalkMinSlowdownMultiplier.
    expect(at(150)).toBeCloseTo(0.75);
    expect(at(100)).toBeCloseTo(0.75);
    // Running beyond the outer radius, 1.25 times, within fFollowRunMaxSpeedupMultiplier.
    expect(at(400, 1, true)).toBeCloseTo(1.25);
    // A faster leader is matched.
    expect(at(200, 1.4)).toBeCloseTo(1.4);
  });

  it('know what the leader cannot see', () => {
    const viewer = { position: [0, 0, 100] as const, forward: [0, 1, 0] as const };
    expect(outOfSight(viewer, [0, 1000, 100])).toBe(false);
    expect(outOfSight(viewer, [0, -1000, 100])).toBe(true);
    expect(outOfSight(viewer, [1000, 10, 100])).toBe(true);
  });

  it('catch up only when far and unseen for a while', () => {
    let since = 0;
    since = catchUpTime(since, 1, CATCH_UP_DISTANCE + 1, true);
    since = catchUpTime(since, 1, CATCH_UP_DISTANCE + 1, false);
    expect(since).toBe(0);
    for (let i = 0; i < CATCH_UP_SECONDS; i++) since = catchUpTime(since, 1, 5000, true);
    expect(since).toBeGreaterThanOrEqual(CATCH_UP_SECONDS);
    const place = catchUpPlace({ position: [0, 0, 0], forward: [0, 1, 0] }, 300);
    expect(place[1]).toBeCloseTo(-300);
  });

  it('come along beside the leader, row by row, wider through doors', () => {
    const places = placesBeside({ position: [0, 0, 0], heading: 0 }, 3, ESM.followSpacing);
    expect(places[0]?.position[0]).toBeCloseTo(-96);
    expect(places[1]?.position[0]).toBeCloseTo(96);
    expect(places[2]?.position[1]).toBeCloseTo(-192);
    expect(places.every((place) => place.heading === 0)).toBe(true);
    // fFollowerSpacingAtDoors and their widths.
    expect(doorSpacing(AI_DEFAULTS)).toBe(240);
  });
});

describe('actors coming out of one load door', () => {
  // Facing east (compass radians: 0 north, a quarter turn east).
  const arrival = { position: [100, 200, 50] as const, heading: Math.PI / 2 };

  it('stand at the arrival point when no one stands there', () => {
    expect(doorArrivalSpot(arrival, [])).toEqual([100, 200, 50]);
  });

  it('stand one on from another along the way out of the door, never on one spot', () => {
    const second = doorArrivalSpot(arrival, [[100, 200, 50]]);
    expect(second[0]).toBeCloseTo(100 + DOOR_ARRIVAL_SPACING);
    expect(second[1]).toBeCloseTo(200);
    const third = doorArrivalSpot(arrival, [[100, 200, 50], second]);
    expect(third[0]).toBeCloseTo(100 + 2 * DOOR_ARRIVAL_SPACING);
    // A spot left again is taken again.
    expect(doorArrivalSpot(arrival, [second])).toEqual([100, 200, 50]);
  });

  it('are wider apart than a human shape', () => {
    expect(DOOR_ARRIVAL_SPACING).toBeGreaterThan(40);
  });
});
