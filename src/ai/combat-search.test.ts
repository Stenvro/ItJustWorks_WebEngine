import { describe, expect, it } from 'vitest';
import { CombatSearch, SEARCH_RADIUS, type SearchBody } from './combat-search.ts';

type Vec3 = readonly [number, number, number];

const settings = {
  searchInvestigateDistance: 256,
  searchInvestigateTime: 2.5,
  stateExpireTime: 30,
};

/** A body that arrives where it is sent at once (after a microtask), and keeps what it did. */
function body(): SearchBody & {
  at: Vec3;
  trips: { to: Vec3; run: boolean }[];
  faced: number[];
  stopped: number;
} {
  const self = {
    at: [0, 0, 0] as Vec3,
    trips: [] as { to: Vec3; run: boolean }[],
    faced: [] as number[],
    stopped: 0,
    position: (): Vec3 => self.at,
    travel: (to: Vec3, _arrive: number, run: boolean): Promise<boolean> => {
      self.trips.push({ to, run });
      self.at = to;
      return Promise.resolve(true);
    },
    face: (heading: number): void => {
      self.faced.push(heading);
    },
    stop: (): void => {
      self.stopped++;
    },
  };
  return self;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('combat search', () => {
  it('runs to the last known place, looks round, searches round it, and gives up', async () => {
    const searcher = body();
    const lastKnown: Vec3 = [1000, 0, 0];
    const search = new CombatSearch(lastKnown, searcher, settings, () => 0.5);
    expect(search.update(0.1)).toBe('searching');
    expect(searcher.trips).toEqual([{ to: lastKnown, run: true }]);
    await settle();
    // There: it looks round three times, fCombatSearchInvestigateTime each.
    expect(search.update(0.1)).toBe('searching');
    expect(searcher.faced).toHaveLength(1);
    for (let i = 0; i < 2; i++) search.update(settings.searchInvestigateTime);
    expect(searcher.faced).toHaveLength(3);
    // Then it walks to a point round the place.
    search.update(settings.searchInvestigateTime);
    search.update(0.1);
    expect(searcher.trips).toHaveLength(2);
    const wander = searcher.trips[1];
    expect(wander?.run).toBe(false);
    const [x, y] = wander?.to ?? [0, 0, 0];
    expect(Math.hypot(x - lastKnown[0], y - lastKnown[1])).toBeLessThanOrEqual(SEARCH_RADIUS);
    // fDetectionStateExpireTime in all: it gives up and stands.
    let state = search.update(0);
    for (let t = 0; t < 40 && state === 'searching'; t++) {
      await settle();
      state = search.update(1);
    }
    expect(state).toBe('gave-up');
    expect(search.elapsed).toBeGreaterThanOrEqual(settings.stateExpireTime);
    expect(searcher.stopped).toBeGreaterThan(0);
    expect(search.update(1)).toBe('gave-up');
  });

  it('moves to news of the target, running again', async () => {
    const searcher = body();
    const search = new CombatSearch([500, 0, 0], searcher, settings, () => 0.25);
    search.update(0.1);
    await settle();
    search.update(0.1);
    search.moveTo([0, 800, 0]);
    expect(search.at).toEqual([0, 800, 0]);
    search.update(0.1);
    expect(searcher.trips.at(-1)).toEqual({ to: [0, 800, 0], run: true });
    search.cancel();
    expect(search.update(1)).toBe('gave-up');
  });
});
