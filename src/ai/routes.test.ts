import { describe, expect, it } from 'vitest';
import type { Space } from './package-start.ts';
import { findRoute, RouteMap, type RouteDoor, type RouteNavmesh } from './routes.ts';

const HOUSE: Space = { kind: 'interior', cell: 1 };
const SHOP: Space = { kind: 'interior', cell: 2 };
const CELLAR: Space = { kind: 'interior', cell: 3 };
const TOWN: Space = { kind: 'world', world: 60 };

const navmesh = (space: Space, location: [number, number, number], neighbours: number[] = []) =>
  ({ space, location, neighbours }) satisfies RouteNavmesh;

const door = (
  reference: number,
  from: { space: Space; at: [number, number, number]; navmesh: number },
  to: { space: Space; at: [number, number, number]; navmesh: number; door: number },
): RouteDoor => ({
  door: reference,
  space: from.space,
  position: from.at,
  navmeshes: [from.navmesh],
  destination: to.door,
  arrivalSpace: to.space,
  arrival: to.at,
  arrivalHeading: 0,
  arrivalNavmeshes: [to.navmesh],
});

/** A house and a shop on a town's street of two navmeshes; a cellar under the house. */
function town(): RouteMap {
  const navmeshes = new Map<number, RouteNavmesh>([
    [10, navmesh(HOUSE, [0, 0, 0])],
    [20, navmesh(TOWN, [0, 0, 0], [21])],
    [21, navmesh(TOWN, [2000, 0, 0], [20])],
    [30, navmesh(SHOP, [0, 0, 0])],
    [40, navmesh(CELLAR, [0, 0, -300])],
  ]);
  const doors = [
    // House <-> street.
    door(
      100,
      { space: HOUSE, at: [0, 200, 0], navmesh: 10 },
      { space: TOWN, at: [0, 100, 0], navmesh: 20, door: 101 },
    ),
    door(
      101,
      { space: TOWN, at: [0, 50, 0], navmesh: 20 },
      { space: HOUSE, at: [0, 150, 0], navmesh: 10, door: 100 },
    ),
    // Shop <-> street, at the street's other end.
    door(
      102,
      { space: SHOP, at: [0, -200, 0], navmesh: 30 },
      { space: TOWN, at: [2000, 100, 0], navmesh: 21, door: 103 },
    ),
    door(
      103,
      { space: TOWN, at: [2000, 50, 0], navmesh: 21 },
      { space: SHOP, at: [0, -150, 0], navmesh: 30, door: 102 },
    ),
    // House <-> cellar.
    door(
      104,
      { space: HOUSE, at: [100, 0, 0], navmesh: 10 },
      { space: CELLAR, at: [0, 0, -300], navmesh: 40, door: 105 },
    ),
    door(
      105,
      { space: CELLAR, at: [0, 50, -300], navmesh: 40 },
      { space: HOUSE, at: [100, 50, 0], navmesh: 10, door: 104 },
    ),
  ];
  return new RouteMap(navmeshes, doors);
}

describe('routes', () => {
  it('walk within an area without doors', () => {
    const route = findRoute(
      town(),
      { space: TOWN, position: [0, 0, 0], navmesh: 20 },
      { space: TOWN, position: [2000, 0, 0], navmesh: 21 },
    );
    expect(route?.doors).toEqual([]);
    expect(route?.length).toBe(2000);
  });

  it('take the load doors from one interior to another, over the street', () => {
    const route = findRoute(
      town(),
      { space: HOUSE, position: [0, 0, 0], navmesh: 10 },
      { space: SHOP, position: [0, 0, 0], navmesh: 30 },
    );
    expect(route?.doors.map((step) => step.door)).toEqual([100, 103]);
    // 200 to the house door, from its arrival 100 → 2000 along the street to the shop door
    // (about 2000), 150 inside the shop.
    expect(route?.length).toBeGreaterThan(2300);
    expect(route?.length).toBeLessThan(2400);
  });

  it('find none where no doors join two areas', () => {
    const map = new RouteMap(
      new Map([
        [10, navmesh(HOUSE, [0, 0, 0])],
        [30, navmesh(SHOP, [0, 0, 0])],
      ]),
      [],
    );
    expect(
      findRoute(
        map,
        { space: HOUSE, position: [0, 0, 0], navmesh: 10 },
        { space: SHOP, position: [0, 0, 0], navmesh: 30 },
      ),
    ).toBeUndefined();
    expect(town().nearestNavmesh(TOWN, [1900, 0, 0])).toBe(21);
  });

  it('follow a road where it is not far round', () => {
    const navmeshes = new Map<number, RouteNavmesh>([
      [50, navmesh(TOWN, [0, 0, 0])],
      [51, navmesh(TOWN, [5000, 5000, 0])],
      [52, navmesh(TOWN, [10000, 0, 0])],
    ]);
    const roads = { markers: [50, 52], path: () => [50, 51, 52] };
    const map = new RouteMap(navmeshes, [], roads);
    expect(map.roadPoints(TOWN, [0, 100, 0], [10000, 100, 0])).toEqual([
      [0, 100, 0],
      [0, 0, 0],
      [5000, 5000, 0],
      [10000, 0, 0],
      [10000, 100, 0],
    ]);
    // Inside, and where the road goes far round, none.
    expect(map.roadPoints(HOUSE, [0, 0, 0], [10, 0, 0])).toBeUndefined();
    const winding = new RouteMap(navmeshes, [], {
      markers: [50, 52],
      path: () => [50, 51, 50, 51, 52],
    });
    expect(winding.roadPoints(TOWN, [0, 100, 0], [10000, 100, 0])).toBeUndefined();
  });
});
