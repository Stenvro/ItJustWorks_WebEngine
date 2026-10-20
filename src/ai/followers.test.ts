import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_DISTANCE,
  CATCH_UP_SECONDS,
  catchUpPlace,
  catchUpTime,
  FOLLOW_SETTINGS,
  followDistance,
  followerRanks,
  followGait,
  outOfSight,
  placesBeside,
} from './followers.ts';

describe('followers', () => {
  it('keep one spacing apart behind their leader', () => {
    expect(followDistance(256, 0)).toBe(256);
    expect(followDistance(256, 2)).toBe(256 + 2 * FOLLOW_SETTINGS.spacing);
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

  it('run to catch up and with a running leader', () => {
    expect(followGait(300, 384, 'walk', false)).toBe('walk');
    expect(followGait(900, 384, 'walk', false)).toBe('run');
    expect(followGait(300, 384, 'walk', true)).toBe('run');
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

  it('come along beside the leader, row by row', () => {
    const places = placesBeside({ position: [0, 0, 0], heading: 0 }, 3);
    expect(places[0]?.position[0]).toBeCloseTo(-96);
    expect(places[1]?.position[0]).toBeCloseTo(96);
    expect(places[2]?.position[1]).toBeCloseTo(-192);
    expect(places.every((place) => place.heading === 0)).toBe(true);
  });
});
