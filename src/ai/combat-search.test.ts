import { describe, expect, it } from 'vitest';
import {
  CombatSearch,
  SEARCH_RADIUS,
  SearchArea,
  type SearchBody,
  type SearchPoint,
} from './combat-search.ts';

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
  it('goes on from its step and its time searched after a save', async () => {
    const searcher = body();
    const search = new CombatSearch(
      [1000, 0, 0],
      searcher,
      { ...settings, searchRadius: 400 },
      () => 0.5,
    );
    search.update(0.1);
    await settle();
    search.update(0.1);
    search.update(1);
    // It looks round at the place, part-way through its first look.
    const saved = search.save();
    expect(saved).toMatchObject({
      phase: 'look',
      looks: 1,
      first: false,
      atPlace: true,
      radius: 400,
    });
    expect(saved.left).toBeCloseTo(settings.searchInvestigateTime - 1);
    expect(saved.elapsed).toBeCloseTo(1.2);
    const loaded = body();
    loaded.at = [1000, 0, 0];
    const again = CombatSearch.restore(saved, loaded, settings, () => 0.5);
    expect(again.at).toEqual([1000, 0, 0]);
    expect(again.elapsed).toBeCloseTo(1.2);
    // The rest of its look, then its two more: no run to the place again.
    again.update(settings.searchInvestigateTime - 1);
    expect(loaded.trips).toHaveLength(0);
    expect(loaded.faced).toHaveLength(1);
    again.update(settings.searchInvestigateTime);
    again.update(settings.searchInvestigateTime);
    again.update(0.1);
    // Then a walk to a point within the radius it drew (400, not the default).
    expect(loaded.trips).toHaveLength(1);
    expect(loaded.trips[0]?.run).toBe(false);
    const [x, y] = loaded.trips[0]?.to ?? [0, 0, 0];
    expect(Math.hypot(x - 1000, y)).toBeLessThanOrEqual(400);
    // Saved mid-walk, it walks there again from where it stands.
    const walking = again.save();
    expect(walking.phase).toBe('wander');
    const third = body();
    const resumed = CombatSearch.restore(walking, third, settings, () => 0.5);
    resumed.update(0.1);
    expect(third.trips).toEqual([{ to: walking.target, run: false }]);
    // Its time in all carries on: it gives up at fDetectionStateExpireTime counted from the start.
    expect(resumed.update(settings.stateExpireTime - walking.elapsed)).toBe('gave-up');
  });

  describe('the priority points and doors (Search, Investigating Door)', () => {
    const areaSettings = { ignoreLocationRadius: 384, sightRadius: 1536, doorFailureMax: 3 };
    const searchSettings = { ...settings, searchLookTime: 1 };

    /** A searcher that records its walks and their arrive distances; `reach` says what it reaches. */
    function walker(
      reach: (to: Vec3) => boolean = () => true,
      sees: (at: Vec3) => boolean = () => false,
    ) {
      const self = {
        at: [0, 0, 0] as Vec3,
        trips: [] as { to: Vec3; arrive: number }[],
        faced: [] as number[],
        position: (): Vec3 => self.at,
        travel: (to: Vec3, arrive: number): Promise<boolean> => {
          self.trips.push({ to, arrive });
          if (!reach(to)) return Promise.resolve(false);
          self.at = to;
          return Promise.resolve(true);
        },
        face: (heading: number): void => {
          self.faced.push(heading);
        },
        stop: (): void => undefined,
        sees,
      };
      return self;
    }

    /** Runs a search until it has made `trips` walks (or 200 steps). */
    async function until(
      search: CombatSearch,
      searcher: { trips: unknown[] },
      trips: number,
    ): Promise<void> {
      for (let i = 0; i < 200 && searcher.trips.length < trips; i++) {
        search.update(0.5);
        await settle();
      }
    }

    it('checks the last seen point, then its group’s likely points and doors, nearest first', async () => {
      const center: Vec3 = [0, 0, 0];
      const corner: SearchPoint = { at: [600, 0, 0] };
      const door: SearchPoint = { at: [900, 0, 0], door: 0xd00 };
      const far: SearchPoint = { at: [1200, 400, 0] };
      const area = new SearchArea(center, [far, door, corner], areaSettings);
      const searcher = walker();
      searcher.at = [-800, 0, 0];
      const share = { area, member: 1, doorDistance: 384 };
      const search = new CombatSearch(center, searcher, searchSettings, () => 0.5, share);
      await until(search, searcher, 4);
      // The last seen point (run to), then the corner, the door from fCombatSearchDoorDistance,
      // then the farthest; only then would it wander.
      expect(searcher.trips.map((trip) => trip.to)).toEqual([center, corner.at, door.at, far.at]);
      expect(searcher.trips[1]?.arrive).toBe(settings.searchInvestigateDistance);
      expect(searcher.trips[2]?.arrive).toBe(384);
      // The corner and the door are searched; the farthest is under way.
      expect(area.left).toBe(1);
      await until(search, searcher, 5);
      const wander = searcher.trips[4]?.to ?? center;
      expect([corner.at, door.at, far.at]).not.toContainEqual(wander);
    });

    it('shares the points among the group’s searchers; a seen one needs no walk', () => {
      const a: SearchPoint = { at: [600, 0, 0] };
      const b: SearchPoint = { at: [0, 700, 0] };
      const c: SearchPoint = { at: [-900, 0, 0] };
      const area = new SearchArea([0, 0, 0], [a, b, c], areaSettings);
      // The first takes the nearest; the second, at the same moment, the next.
      expect(area.take(1, [0, 0, 0])).toBe(a);
      expect(area.take(2, [0, 0, 0])).toBe(b);
      // One it sees from where it stands within fCombatSearchSightRadius counts as searched.
      expect(area.take(3, [0, 0, 0], (at) => at[0] === -900)).toBeUndefined();
      expect(area.left).toBe(2);
      // A searcher that stops frees its point; passing near one searches it.
      area.release(2);
      area.pass([0, 650, 0]);
      expect(area.left).toBe(1);
      expect(area.take(3, [0, 0, 0])).toBeUndefined();
    });

    it('gives doors up after iCombatSearchDoorFailureMax it could not reach', async () => {
      const doors = [1, 2, 3, 4].map((n): SearchPoint => ({
        at: [500 * n, 1000, 0],
        door: 0xd00 + n,
      }));
      const corner: SearchPoint = { at: [0, 3000, 0] };
      const area = new SearchArea([0, 0, 0], [...doors, corner], areaSettings);
      const searcher = walker((to) => to[1] !== 1000);
      const share = { area, member: 1, doorDistance: 384 };
      const search = new CombatSearch([0, 0, 0], searcher, searchSettings, () => 0.5, share);
      await until(search, searcher, 5);
      // Three doors tried and failed, the fourth never: on to the corner.
      expect(searcher.trips.map((trip) => trip.to)).toEqual([
        [0, 0, 0],
        doors[0]?.at,
        doors[1]?.at,
        doors[2]?.at,
        corner.at,
      ]);
    });
  });
});
