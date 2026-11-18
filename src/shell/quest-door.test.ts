import { describe, expect, it } from 'vitest';
import type { Space } from '../ai/package-start.ts';
import { RouteMap, type RouteNavmesh } from '../ai/routes.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';
import { questTargetDoor } from './quest-door.ts';

const HOUSE: Space = { kind: 'interior', cell: 1 };
const TOWN: Space = { kind: 'world', world: 60 };
const OTHER_TOWN: Space = { kind: 'world', world: 61 };

const placement = (at: { cell?: number; world?: number }, x = 0): Placement => ({
  position: [x, 0, 0],
  rotation: [0, 0, 0],
  cell: at.cell,
  world: at.world,
  scale: 1,
});

/** A house (cell 1) whose door 100 opens onto a town's street (world 60). */
function town(): RouteMap {
  const navmeshes = new Map<number, RouteNavmesh>([
    [10, { space: HOUSE, location: [0, 0, 0], neighbours: [] }],
    [20, { space: TOWN, location: [0, 0, 0], neighbours: [] }],
    [30, { space: OTHER_TOWN, location: [0, 0, 0], neighbours: [] }],
  ]);
  return new RouteMap(navmeshes, [
    {
      door: 100,
      space: HOUSE,
      position: [0, 200, 0],
      navmeshes: [10],
      destination: 101,
      arrivalSpace: TOWN,
      arrival: [0, 100, 0],
      arrivalHeading: 0,
      arrivalNavmeshes: [20],
    },
  ]);
}

describe("sqt's load door toward a quest target", () => {
  const places = new Map<number, Placement>([
    [PLAYER_REF, placement({ cell: 1 })],
    [0x200, placement({ cell: 1 }, 50)],
    [0x201, placement({ world: 60 }, 300)],
    [0x202, placement({ world: 61 })],
  ]);
  const placementOf = (reference: number) => Promise.resolve(places.get(reference));
  const routes = () => Promise.resolve(town());

  it("says a target in the player's cell is in the same space", async () => {
    expect(await questTargetDoor(placementOf, routes, { reference: 0x200 })).toBe('same');
  });

  it('names the first load door of the way to a target in another space', async () => {
    expect(await questTargetDoor(placementOf, routes, { reference: 0x201 })).toBe(100);
  });

  it('says a target no way leads to, or with no place, is unreachable', async () => {
    expect(await questTargetDoor(placementOf, routes, { reference: 0x202 })).toBe('unreachable');
    expect(await questTargetDoor(placementOf, routes, { reference: 0x203 })).toBe('unreachable');
  });

  it("takes the target's own placement before looking it up, and outside compares worldspaces", async () => {
    const outside = new Map(places);
    outside.set(PLAYER_REF, placement({ world: 60, cell: 7 }));
    const at = (reference: number) => Promise.resolve(outside.get(reference));
    // Another cell of the same worldspace: the same space outside.
    expect(
      await questTargetDoor(at, routes, {
        reference: 0x202,
        placement: placement({ world: 60, cell: 8 }),
      }),
    ).toBe('same');
    expect(await questTargetDoor(at, routes, { reference: 0x200 })).toBe('unreachable');
  });
});
