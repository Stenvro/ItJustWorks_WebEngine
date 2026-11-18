// The load door the way toward a place in another space goes through (the routes over the
// navmeshes and load doors: src/ai/routes.ts): the compass's QuestDoor, Clairvoyance's trail
// and the console's sqt. Platform-independent.

import type { Space } from '../ai/package-start.ts';
import { findRoute, type RouteMap } from '../ai/routes.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement } from '../scripting/runtime/runtime.ts';

/** The space a place is in: its worldspace outside, its cell inside. */
function spaceOf(at: { readonly cell?: number; readonly world?: number }): Space {
  return at.world !== undefined
    ? { kind: 'world', world: at.world }
    : { kind: 'interior', cell: at.cell ?? 0 };
}

/**
 * The first load door on the way from a place to a place in another space (the routes over the
 * navmeshes and load doors: src/ai/routes.ts): the compass's QuestDoor, Clairvoyance's trail.
 */
export function firstDoorToward(
  routes: RouteMap,
  at: { readonly position: readonly number[]; readonly cell?: number; readonly world?: number },
  to: Placement,
): { readonly door: number; readonly position: Vec3 } | undefined {
  const here = spaceOf(at);
  const there = spaceOf(to);
  const position: Vec3 = [at.position[0] ?? 0, at.position[1] ?? 0, at.position[2] ?? 0];
  const target: Vec3 = [...to.position];
  const start = routes.nearestNavmesh(here, position);
  const end = routes.nearestNavmesh(there, target);
  if (start === undefined || end === undefined) return undefined;
  const route = findRoute(
    routes,
    { space: here, position, navmesh: start },
    { space: there, position: target, navmesh: end },
  );
  const door = route?.doors[0];
  return (
    door && { door: door.door, position: [door.position[0], door.position[1], door.position[2]] }
  );
}

/**
 * The load door toward a quest target as the console's sqt names it: 'same' when the target is
 * in the player's worldspace (outside) or cell (inside), the first load door of the way there
 * as the compass finds it, 'unreachable' when either end has no place or no way is found.
 */
export async function questTargetDoor(
  placementOf: (reference: number) => Promise<Placement | undefined>,
  routes: () => Promise<RouteMap>,
  target: { readonly reference: number; readonly placement?: Placement },
): Promise<number | 'same' | 'unreachable'> {
  const at = await placementOf(PLAYER_REF);
  const to = target.placement ?? (await placementOf(target.reference));
  if (!at || !to) return 'unreachable';
  const same =
    at.world !== undefined ? to.world === at.world : to.cell !== undefined && to.cell === at.cell;
  if (same) return 'same';
  return firstDoorToward(await routes(), at, to)?.door ?? 'unreachable';
}
