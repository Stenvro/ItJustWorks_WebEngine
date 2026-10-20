// Followers (docs/ai.md, "Followers, mounts and vehicles"): actors whose package follows a
// leader (Follow, FollowTo: the player's followers run DialogueFollower's FollowerPackageTemplate,
// which follows while their WaitingForPlayer actor value is 0 and waits while it is 1), and the
// player's teammates (Actor.SetPlayerTeammate). They keep their distance from their leader, one
// behind another; they come with the player through load doors and on fast travel, sneak while
// the player sneaks (teammates), and one left far behind out of the player's sight catches up.
// Platform-independent.

import type { Gait } from './locomotion.ts';

type Vec3 = readonly [number, number, number];

/** Where something is and which way it faces (compass radians). */
export interface FollowPlace {
  readonly position: Vec3;
  readonly heading: number;
}

/** The game settings followers keep their distance by. */
export interface FollowSettings {
  /** fFollowSpaceBetweenFollowers: between one follower and the next (units). */
  readonly spacing: number;
}

/** Skyrim.esm's values. */
export const FOLLOW_SETTINGS: FollowSettings = { spacing: 192 };

/**
 * A follower farther than this from its leader, out of the leader's sight for CATCH_UP_SECONDS,
 * is put behind it. TODO(M13): the engine's catch-up rule is not documented.
 */
export const CATCH_UP_DISTANCE = 2048;
export const CATCH_UP_SECONDS = 3;
/** Out of sight: beyond this half-angle of the leader's view (radians; a 90° screen and some). */
export const VIEW_HALF_ANGLE = (55 * Math.PI) / 180;

/**
 * How near a follower comes to its leader: its package's minimum radius, and one spacing
 * (fFollowSpaceBetweenFollowers) farther for each follower nearer the leader than it (its
 * rank), so several follow one behind another.
 */
export function followDistance(min: number, rank: number, settings = FOLLOW_SETTINGS): number {
  return min + Math.max(0, rank) * settings.spacing;
}

/**
 * The gait a follower closes the distance at: farther behind than twice its maximum radius it
 * runs (also to keep up with a running leader), else its package's. TODO(M13): the engine's
 * follower speeds (fFollowRunMinSlowdownMultiplier slows a follower running near its leader).
 */
export function followGait(
  distance: number,
  max: number,
  packageGait: Gait,
  leaderRunning: boolean,
): Gait {
  if (leaderRunning || distance > max * 2) return packageGait === 'sprint' ? 'sprint' : 'run';
  return packageGait;
}

/** Whether a point is out of a viewer's sight: behind it or beyond its view's half-angle. */
export function outOfSight(
  viewer: { readonly position: Vec3; readonly forward: Vec3 },
  point: Vec3,
  halfAngle = VIEW_HALF_ANGLE,
): boolean {
  const dx = point[0] - viewer.position[0];
  const dy = point[1] - viewer.position[1];
  const dz = point[2] - viewer.position[2];
  const length = Math.hypot(dx, dy, dz);
  const forward = Math.hypot(viewer.forward[0], viewer.forward[1], viewer.forward[2]);
  if (length < 1e-6 || forward < 1e-6) return false;
  const cos =
    (dx * viewer.forward[0] + dy * viewer.forward[1] + dz * viewer.forward[2]) / (length * forward);
  return cos < Math.cos(halfAngle);
}

/**
 * A follower's catch-up clock: how long it has been far behind and unseen. Returns the time
 * now; the follower is put behind its leader once it reaches CATCH_UP_SECONDS.
 */
export function catchUpTime(
  since: number,
  seconds: number,
  distance: number,
  unseen: boolean,
): number {
  return distance > CATCH_UP_DISTANCE && unseen ? since + seconds : 0;
}

/**
 * Places for followers coming along with their leader (through a load door, on fast travel,
 * catching up): beside and behind where the leader stands, one spacing apart, on alternating
 * sides, the next row a spacing further back; facing the leader's way. TODO(M13): where the
 * engine puts them (here: kept off the arrival point the player stands on).
 */
export function placesBeside(
  leader: FollowPlace,
  count: number,
  settings = FOLLOW_SETTINGS,
): FollowPlace[] {
  const sin = Math.sin(leader.heading);
  const cos = Math.cos(leader.heading);
  const places: FollowPlace[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const side = (i % 2 === 0 ? -1 : 1) * settings.spacing * 0.5;
    const back = -row * settings.spacing;
    // Right (cos, −sin), forward (sin, cos).
    places.push({
      position: [
        leader.position[0] + side * cos + back * sin,
        leader.position[1] - side * sin + back * cos,
        leader.position[2],
      ],
      heading: leader.heading,
    });
  }
  return places;
}

/**
 * Where a follower catching up is put: behind its leader (away from where it looks) at the
 * follower's distance, so it comes into sight following.
 */
export function catchUpPlace(
  leader: { readonly position: Vec3; readonly forward: Vec3 },
  distance: number,
): [number, number, number] {
  const length = Math.hypot(leader.forward[0], leader.forward[1]) || 1;
  return [
    leader.position[0] - (leader.forward[0] / length) * distance,
    leader.position[1] - (leader.forward[1] / length) * distance,
    leader.position[2],
  ];
}

/** The rank of each follower of a leader: how many of them are nearer it (0: the nearest). */
export function followerRanks(
  leader: Vec3,
  followers: readonly { readonly reference: number; readonly position: Vec3 }[],
): Map<number, number> {
  const sorted = [...followers].sort(
    (a, b) =>
      Math.hypot(a.position[0] - leader[0], a.position[1] - leader[1]) -
        Math.hypot(b.position[0] - leader[0], b.position[1] - leader[1]) ||
      a.reference - b.reference,
  );
  return new Map(sorted.map((follower, rank) => [follower.reference, rank]));
}
