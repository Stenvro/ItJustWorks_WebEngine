// Following a path (docs/ai.md, "Paths"): an actor on a path wants to go to its next point; a
// point is passed once the actor is near it or beyond it (along the way to the one after), and
// the path ends when the actor is within its arrival radius of the last point. An actor that
// makes no headway towards its next point for a while is stuck (the caller searches again, or
// gives up). The doors on the way are announced as the actor comes near them, once each.
// Platform-independent.

import type { Gait, MoveRequest } from './locomotion.ts';
import type { NavPath } from './pathfinding.ts';

type Vec3 = readonly [number, number, number];

export interface FollowOptions {
  readonly gait: Gait;
  /** Within this of the last point it has arrived (game units, horizontal). */
  readonly arrive: number;
  /** A door this near is announced (opened by the caller). */
  readonly doorReach?: number;
}

export type FollowState = 'moving' | 'arrived' | 'stuck';

/** A point is passed within this (game units, horizontal). */
const PASS_RADIUS = 24;
/** Stuck: less headway than this towards the next point ... */
const STUCK_HEADWAY = 8;
/** ... in this long (seconds). */
const STUCK_SECONDS = 1.5;
/** Doors are announced this near by default (game units). */
const DOOR_REACH = 160;

export class PathFollower {
  readonly path: NavPath;
  readonly #options: FollowOptions;
  /** The point it goes to now. */
  #next = 1;
  #closest = Infinity;
  #since = 0;
  readonly #announced = new Set<number>();

  constructor(path: NavPath, options: FollowOptions) {
    this.path = path;
    this.#options = options;
  }

  /** The point it goes to now (undefined: none left). */
  get target(): Vec3 | undefined {
    return this.path.points[this.#next];
  }

  /**
   * One step for an actor at `position`: what it wants now, and whether it is on its way, has
   * arrived or is stuck. `door` is told of a door on the way as it comes near.
   */
  step(
    position: Vec3,
    seconds: number,
    door?: (reference: number) => void,
  ): { readonly request: MoveRequest | undefined; readonly state: FollowState } {
    const points = this.path.points;
    const last = points[points.length - 1];
    if (!last) return { request: undefined, state: 'arrived' };
    if (horizontal(position, last) <= this.#options.arrive) {
      return { request: undefined, state: 'arrived' };
    }
    // Points passed: near them, or beyond them towards the one after.
    while (this.#next < points.length - 1) {
      const point = points[this.#next];
      const after = points[this.#next + 1];
      if (!point || !after) break;
      if (horizontal(position, point) > PASS_RADIUS && !beyond(position, point, after)) break;
      this.#next++;
      this.#closest = Infinity;
      this.#since = 0;
    }
    const target = points[this.#next] ?? last;
    // The doors on the way, as it comes near them.
    const reach = this.#options.doorReach ?? DOOR_REACH;
    for (const entry of this.path.doors) {
      if (this.#announced.has(entry.door) || entry.after > this.#next) continue;
      const at = points[entry.after + 1] ?? target;
      if (horizontal(position, at) > reach) continue;
      this.#announced.add(entry.door);
      door?.(entry.door);
    }
    // Headway towards the point it goes to.
    const away = horizontal(position, target);
    if (away < this.#closest - STUCK_HEADWAY) {
      this.#closest = away;
      this.#since = 0;
    } else {
      this.#since += seconds;
      if (this.#since > STUCK_SECONDS) return { request: undefined, state: 'stuck' };
    }
    return {
      request: {
        direction: [target[0] - position[0], target[1] - position[1]],
        gait: this.#options.gait,
      },
      state: 'moving',
    };
  }
}

const horizontal = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Whether `position` is past `point` on the way from it to `after`. */
function beyond(position: Vec3, point: Vec3, after: Vec3): boolean {
  const dx = after[0] - point[0];
  const dy = after[1] - point[1];
  return (position[0] - point[0]) * dx + (position[1] - point[1]) * dy > 0;
}
