import { describe, expect, it } from 'vitest';
import { AI_DEFAULTS, readAiSettings } from './ai-settings.ts';
import {
  CATCH_UP_DISTANCE,
  CATCH_UP_SECONDS,
  catchUpPlace,
  catchUpTime,
  doorSpacing,
  followDistance,
  followerRanks,
  followGait,
  followGoal,
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
  it('keep one spacing apart behind their leader', () => {
    expect(followDistance(256, 0, ESM.followSpacing)).toBe(256);
    expect(followDistance(256, 2, ESM.followSpacing)).toBe(256 + 2 * 192);
    const ranks = followerRanks(
      [0, 0, 0],
      [
        { reference: 3, position: [500, 0, 0] },
        { reference: 1, position: [0, 300, 0] },
        { reference: 2, position: [-300, 0, 0] },
      ],
    );
    expect(ranks.get(1)).toBe(0);
    expect(ranks.get(2)).toBe(1);
    expect(ranks.get(3)).toBe(2);
  });

  it('take the engine radii without their own, the smaller as the minimum', () => {
    expect(followRadii(AI_DEFAULTS, undefined, undefined)).toEqual({ min: 128, max: 150 });
    expect(followRadii(AI_DEFAULTS, 300, 100)).toEqual({ min: 100, max: 300 });
    expect(followRadii(AI_DEFAULTS, 64, undefined)).toEqual({ min: 64, max: 128 });
  });

  it('run to catch up and with a running leader; sprint after the player', () => {
    const walking = { running: false, sprinting: false, player: true };
    const running = { running: true, sprinting: false, player: true };
    expect(followGait(300, 384, 'walk', walking, 500, 2)).toBe('walk');
    expect(followGait(900, 384, 'walk', walking, 500, 2)).toBe('run');
    expect(followGait(300, 384, 'walk', running, 500, 2)).toBe('run');
    // Farther than fFollowStartSprintDistance behind the running player, or as they sprint.
    expect(followGait(600, 384, 'walk', running, 500, 2)).toBe('sprint');
    expect(followGait(300, 384, 'walk', { ...running, sprinting: true }, 500, 2)).toBe('sprint');
    // Not after another actor.
    expect(followGait(600, 384, 'walk', { ...running, player: false }, 500, 2)).toBe('run');
  });

  it('walk within their walk zone (fFollowWalkZoneMult times the maximum radius)', () => {
    const walking = { running: false, sprinting: false, player: true };
    expect(followGait(600, 384, 'walk', walking, 500, 2)).toBe('walk');
    expect(followGait(600, 384, 'walk', walking, 500, 1.5)).toBe('run');
  });

  it('make for their place behind the leader, on the side they are on', () => {
    // The leader at the origin facing +Y (compass 0): behind is −Y, right is +X.
    const leader = { position: [0, 0, 0] as const, heading: 0 };
    const right = followGoal(leader, [300, 500, 0], 200);
    const left = followGoal(leader, [-300, -500, 0], 200);
    expect(Math.hypot(right[0], right[1])).toBeCloseTo(200, 6);
    expect(right[0]).toBeGreaterThan(0);
    expect(right[1]).toBeLessThan(0);
    expect(left[0]).toBeCloseTo(-right[0], 6);
    expect(left[1]).toBeCloseTo(right[1], 6);
    // 30° off straight behind.
    expect(Math.atan2(right[0], -right[1])).toBeCloseTo(Math.PI / 6, 6);
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
