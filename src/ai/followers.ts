// Followers (docs/ai.md, "Followers, mounts and vehicles"): actors whose package follows a
// leader (Follow, FollowTo: the player's followers run DialogueFollower's FollowerPackageTemplate,
// which follows while their WaitingForPlayer actor value is 0 and waits while it is 1), and the
// player's teammates (Actor.SetPlayerTeammate). They keep their distance from their leader, one
// behind another; they come with the player through load doors and on fast travel, sneak while
// the player sneaks (teammates), and one left far behind out of the player's sight catches up.
// Platform-independent.

import type { AiSettings } from './ai-settings.ts';
import type { Gait } from './locomotion.ts';

type Vec3 = readonly [number, number, number];

/** Where something is and which way it faces (compass radians). */
export interface FollowPlace {
  readonly position: Vec3;
  readonly heading: number;
}

/** A follower running beyond its maximum radius goes this many times as fast (the engine's). */
const RUN_BEYOND_MULT = 1.25;

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
export function followDistance(min: number, rank: number, spacing: number): number {
  return min + Math.max(0, rank) * spacing;
}

/**
 * Follow's radii (observed in the original): its Min and Max Radius, without them
 * fFollowSlowdownZoneWidth and fFollowMatchSpeedZoneWidth; the smaller is the minimum.
 */
export function followRadii(
  settings: Pick<AiSettings, 'followSlowdownZoneWidth' | 'followMatchSpeedZoneWidth'>,
  min: number | undefined,
  max: number | undefined,
): { readonly min: number; readonly max: number } {
  const inner = min ?? settings.followSlowdownZoneWidth;
  const outer = max ?? settings.followMatchSpeedZoneWidth;
  return { min: Math.min(inner, outer), max: Math.max(inner, outer) };
}

/** The leader as a follower's gait sees it. */
export interface FollowLeader {
  readonly running: boolean;
  readonly sprinting: boolean;
  /** The leader is the player (a follower sprints only after the player). */
  readonly player: boolean;
}

/**
 * The gait a follower closes the distance at. After the running player it sprints while they
 * sprint or once farther behind than fFollowStartSprintDistance (observed in the original);
 * beyond its walk zone (fFollowWalkZoneMult times its maximum radius) it runs, as with a running
 * leader; within it, its package's.
 */
export function followGait(
  distance: number,
  max: number,
  packageGait: Gait,
  leader: FollowLeader,
  sprintDistance: number,
  walkZoneMult: number,
): Gait {
  if (leader.player && leader.running && (leader.sprinting || distance > sprintDistance)) {
    return 'sprint';
  }
  if (leader.running || leader.sprinting || distance > max * walkZoneMult) {
    return packageGait === 'sprint' ? 'sprint' : 'run';
  }
  return packageGait;
}

/**
 * How far off straight behind its leader a follower keeps (radians), on the side it is on.
 * TODO(M13): the engine's follow offset is not read; a quarter turn's third keeps it in the
 * leader's wake without walking in front of them.
 */
export const FOLLOW_SIDE_ANGLE = Math.PI / 6;

/**
 * Where a follower goes when it has fallen behind (Follow): its follow distance behind its leader,
 * FOLLOW_SIDE_ANGLE off straight behind on the side of the leader's way it is on (left or right;
 * straight behind it keeps to the right), so it trails the leader and does not cross in front.
 */
export function followGoal(
  leader: FollowPlace,
  follower: Vec3,
  distance: number,
): [number, number, number] {
  const dx = follower[0] - leader.position[0];
  const dy = follower[1] - leader.position[1];
  // Right of the leader's way (compass: forward (sin, cos), right (cos, −sin)).
  const right = dx * Math.cos(leader.heading) - dy * Math.sin(leader.heading);
  const side = right < 0 ? -1 : 1;
  // Behind it, turned towards its side.
  const angle = leader.heading + Math.PI - side * FOLLOW_SIDE_ANGLE;
  return [
    leader.position[0] + Math.sin(angle) * distance,
    leader.position[1] + Math.cos(angle) * distance,
    leader.position[2],
  ];
}

/** What a follower's speed is matched by. */
export interface FollowSpeedInput {
  /** Between it and its leader (units). */
  readonly distance: number;
  /** Its radii: it slows within the middle of them, speeds up beyond it. */
  readonly inner: number;
  readonly outer: number;
  /** It runs (or sprints). */
  readonly running: boolean;
  /** Its leader's speed against its own gait's (0: the leader stands). */
  readonly leaderRatio: number;
}

/**
 * A follower's speed, as a share of its gait's (observed in the original): it goes at
 * least as fast as its leader; beyond the middle of its radii up to fFollowExtraCatchUpSpeedMult
 * faster at the outer one (running beyond it, 1.25 times); nearer than the middle slower, down
 * to nothing at the inner one; always between fFollow{Walk,Run}MinSlowdownMultiplier and
 * …MaxSpeedupMultiplier times that speed. TODO(M13): which of its zones (fFollowSlowdownZoneWidth,
 * fFollowMatchSpeedZoneWidth round its radii) the engine passes as inner and outer is inferred:
 * here its minimum and maximum radius.
 */
export function followSpeed(
  settings: Pick<
    AiSettings,
    | 'followExtraCatchUpSpeedMult'
    | 'followWalkMaxSpeedup'
    | 'followWalkMinSlowdown'
    | 'followRunMaxSpeedup'
    | 'followRunMinSlowdown'
  >,
  input: FollowSpeedInput,
): number {
  const { distance, inner, outer, running } = input;
  const base = Math.max(1, input.leaderRatio);
  const most = base * (running ? settings.followRunMaxSpeedup : settings.followWalkMaxSpeedup);
  const least = base * (running ? settings.followRunMinSlowdown : settings.followWalkMinSlowdown);
  const middle = (inner + outer) / 2;
  let speed: number;
  if (distance >= middle) {
    if (distance >= outer && running) speed = base * RUN_BEYOND_MULT;
    else if (outer - middle <= 0) speed = base;
    else
      speed =
        base *
        (1 + ((distance - middle) / (outer - middle)) * settings.followExtraCatchUpSpeedMult);
  } else if (middle - inner <= 0) {
    speed = least;
  } else {
    speed = (Math.max(0, distance - inner) / (middle - inner)) * Math.min(1, base);
  }
  return Math.min(most, Math.max(least, speed));
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
 * catching up): beside and behind where the leader stands, `spacing` apart (through a door
 * doorSpacing, else fFollowSpaceBetweenFollowers), on alternating sides, the next row a spacing
 * further back; facing the leader's way. TODO(M13): where the engine puts them (observed in the original:
 * through a door, one behind another along the way back from the arrival; here kept off the
 * arrival point the player stands on).
 */
export function placesBeside(leader: FollowPlace, count: number, spacing: number): FollowPlace[] {
  const sin = Math.sin(leader.heading);
  const cos = Math.cos(leader.heading);
  const places: FollowPlace[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const side = (i % 2 === 0 ? -1 : 1) * spacing * 0.5;
    const back = -row * spacing;
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

/** An actor's width taken for followers' spacing at doors (units; a human's radius × 2). */
const FOLLOWER_WIDTH = 40;

/**
 * The spacing of followers coming through a door after their leader (observed in the
 * original): fFollowerSpacingAtDoors between one and the next, besides their widths. TODO(M13): each
 * follower's own width (here a human's).
 */
export function doorSpacing(settings: Pick<AiSettings, 'followerSpacingAtDoors'>): number {
  return settings.followerSpacingAtDoors + FOLLOWER_WIDTH;
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
