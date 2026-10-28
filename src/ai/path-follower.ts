// Following a path (docs/ai.md, "Paths"): an actor on a path wants to go to its next point; a
// point is passed once the actor is near it or beyond it (along the way to the one after), and
// the path ends when the actor is within its arrival radius of the last point. An actor that
// makes no headway towards its next point for a while is stuck (the caller searches again, or
// gives up). The doors on the way are asked for as the actor comes near them, every step until
// it is through (which keeps them open): one still opening it waits before, one it cannot open
// blocks its way (the caller searches again without it). Platform-independent.

import type { Gait, MoveRequest } from './locomotion.ts';
import type { NavPath } from './pathfinding.ts';

type Vec3 = readonly [number, number, number];

export interface FollowOptions {
  readonly gait: Gait;
  /** Within this of the last point it has arrived (game units, horizontal). */
  readonly arrive: number;
  /** A door this near is asked for (opened by the caller). */
  readonly doorReach?: number;
}

export type FollowState = 'moving' | 'arrived' | 'stuck' | 'blocked';

/** A door on the way as the actor comes to it: open, opening (it waits) or shut to it (locked). */
export type DoorPassage = 'open' | 'opening' | 'shut';

/** A point is passed within this (game units, horizontal). */
const PASS_RADIUS = 24;
/** Stuck: less headway than this towards the next point ... */
const STUCK_HEADWAY = 8;
/** ... in this long (seconds). */
const STUCK_SECONDS = 1.5;
/** Doors are asked for this near by default (game units). */
const DOOR_REACH = 160;
/** Before a door still opening, or shut to it, it stops this near (game units). */
const DOOR_WAIT = 96;

export class PathFollower {
  readonly path: NavPath;
  readonly #options: FollowOptions;
  /** The point it goes to now. */
  #next = 1;
  #closest = Infinity;
  #since = 0;
  /** The doors it went through. */
  readonly #through = new Set<number>();

  constructor(path: NavPath, options: FollowOptions) {
    this.path = path;
    this.#options = options;
  }

  /** It waits a moment by choice (a door before it opening): no headway is asked meanwhile. */
  hold(): void {
    this.#since = 0;
    this.#closest = Infinity;
  }

  /** The point it goes to now (undefined: none left). */
  get target(): Vec3 | undefined {
    return this.path.points[this.#next];
  }

  /** The path's points it has still to reach, from the one it goes to now. */
  get ahead(): readonly Vec3[] {
    return this.path.points.slice(this.#next);
  }

  /** The path's points still ahead, from the one it last passed. */
  get remaining(): readonly Vec3[] {
    return this.path.points.slice(Math.max(0, this.#next - 1));
  }

  /**
   * One step for an actor at `position`: what it wants now, and whether it is on its way, has
   * arrived, is stuck or is blocked by a door shut to it (`door`). `door` is asked for each door
   * on the way while the actor is near it and not yet through.
   */
  step(
    position: Vec3,
    seconds: number,
    door?: (reference: number) => DoorPassage | undefined,
  ): {
    readonly request: MoveRequest | undefined;
    readonly state: FollowState;
    readonly door?: number;
  } {
    const points = this.path.points;
    const last = points[points.length - 1];
    if (!last) return { request: undefined, state: 'arrived' };
    if (horizontal(position, last) <= this.#options.arrive) {
      return { request: undefined, state: 'arrived' };
    }
    // Points passed: near them, or beyond them towards the one after.
    while (this.#next < points.length - 1) {
      const before = points[this.#next - 1];
      const point = points[this.#next];
      const after = points[this.#next + 1];
      if (!before || !point || !after) break;
      if (horizontal(position, point) > PASS_RADIUS && !beyond(position, before, point, after)) {
        break;
      }
      this.#next++;
      this.#closest = Infinity;
      this.#since = 0;
    }
    const target = points[this.#next] ?? last;
    const wayX = target[0] - position[0];
    const wayY = target[1] - position[1];
    // The doors on the way, as it comes near them: through one once it is behind it.
    const reach = this.#options.doorReach ?? DOOR_REACH;
    let waits = false;
    for (const entry of this.path.doors) {
      if (this.#through.has(entry.door)) continue;
      const away = horizontal(position, entry.at);
      if (away > reach) continue;
      const ahead = (entry.at[0] - position[0]) * wayX + (entry.at[1] - position[1]) * wayY > 0;
      if (!ahead && away > PASS_RADIUS) {
        this.#through.add(entry.door);
        continue;
      }
      const passage = door?.(entry.door) ?? 'open';
      if (away > DOOR_WAIT || !ahead) continue;
      if (passage === 'shut') return { request: undefined, state: 'blocked', door: entry.door };
      if (passage === 'opening') waits = true;
    }
    if (waits) {
      // Before the door while it opens, facing its way (no headway asked meanwhile).
      this.#since = 0;
      this.#closest = Infinity;
      return {
        request: { gait: this.#options.gait, face: Math.atan2(wayX, wayY) },
        state: 'moving',
      };
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

/**
 * Whether `position` is past the corner `point` of the way from `before` to `after`: over the
 * line through the corner square to the bisector of the way in and the way out (for a straight
 * way, the line square to it). Only the way out counted, a corner that turns back (the way
 * leaves its first triangle backwards, round a navmesh border) was passed where the actor
 * started, and it made for the point after straight across the border: a walker beyond the
 * high process kept to the navmesh stood there, its graph walking, until it gave up.
 */
function beyond(position: Vec3, before: Vec3, point: Vec3, after: Vec3): boolean {
  const unit = (x: number, y: number): [number, number] => {
    const length = Math.hypot(x, y);
    return length > 1e-6 ? [x / length, y / length] : [0, 0];
  };
  const [inX, inY] = unit(point[0] - before[0], point[1] - before[1]);
  const [outX, outY] = unit(after[0] - point[0], after[1] - point[1]);
  return (position[0] - point[0]) * (inX + outX) + (position[1] - point[1]) * (inY + outY) > 0;
}
