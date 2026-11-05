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
 * The gait a follower closes the distance at, `middle` the middle of its radii, observed in the
 * original: after the running player it sprints while they sprint or once farther behind than
 * fFollowStartSprintDistance; within its walk zone (fFollowWalkZoneMult times the middle) it walks;
 * beyond it, it runs with a running leader or once beyond the middle by more than
 * fFollowMatchSpeedZoneWidth, and goes at its package's gait else.
 */
export function followGait(
  distance: number,
  middle: number,
  packageGait: Gait,
  leader: FollowLeader,
  settings: Pick<
    AiSettings,
    'followStartSprintDistance' | 'followWalkZoneMult' | 'followMatchSpeedZoneWidth'
  >,
): Gait {
  if (
    leader.player &&
    leader.running &&
    (leader.sprinting || distance > settings.followStartSprintDistance)
  ) {
    return 'sprint';
  }
  if (distance < settings.followWalkZoneMult * middle) return 'walk';
  if (
    leader.running ||
    leader.sprinting ||
    distance > middle + settings.followMatchSpeedZoneWidth
  ) {
    return packageGait === 'sprint' ? 'sprint' : 'run';
  }
  return packageGait;
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
 * The spacing of actors that come out of one load door's arrival point while those before them
 * still stand there (units): a human's width and a stride between them.
 */
export const DOOR_ARRIVAL_SPACING = FOLLOWER_WIDTH + 24;
/** How many spots on from the arrival point an actor coming out of a door may be put. */
const DOOR_ARRIVAL_SPOTS = 6;

/**
 * Where an actor coming out of a load door stands: the door's arrival point, or, where actors
 * that came out before it still stand (`taken`: their spots), the first spot on along the
 * arrival's facing (out of the door, the way its arrival leads), `spacing` apart, that none of
 * them holds; all held, the last. Actors are never set into one another at one point: several
 * through one door at once (the Greybeards out to High Hrothgar's courtyard) stood on one spot,
 * and their controllers could not part. TODO(M13): the original's own spots for actors coming
 * through a door after one another (observed: one behind another; the rule is not documented).
 */
export function doorArrivalSpot(
  arrival: FollowPlace,
  taken: readonly Vec3[],
  spacing = DOOR_ARRIVAL_SPACING,
): [number, number, number] {
  const forward = [Math.sin(arrival.heading), Math.cos(arrival.heading)] as const;
  let spot: [number, number, number] = [...arrival.position];
  for (let k = 0; k < DOOR_ARRIVAL_SPOTS; k++) {
    spot = [
      arrival.position[0] + forward[0] * spacing * k,
      arrival.position[1] + forward[1] * spacing * k,
      arrival.position[2],
    ];
    const [x, y] = spot;
    if (taken.every((at) => Math.hypot(at[0] - x, at[1] - y) >= spacing / 2)) return spot;
  }
  return spot;
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

/** A follower of a leader, as their places are shared out. */
export interface FollowerPlace {
  readonly reference: number;
  readonly position: Vec3;
  /** The distance its own package wants from the leader. */
  readonly wanted: number;
  /** Its bound radius. */
  readonly radius: number;
}

/**
 * How much farther than it wants a follower keeps from its leader, observed in the original: the
 * followers in order of distance from the leader, the nearest at what it wants; each next at least
 * what it wants and at least the one before's place, both their radii and
 * fFollowSpaceBetweenFollowers beyond it.
 */
export function followOffset(
  leader: Vec3,
  followers: readonly FollowerPlace[],
  self: number,
  spacing: number,
): number {
  const away = (follower: FollowerPlace): number =>
    Math.hypot(
      follower.position[0] - leader[0],
      follower.position[1] - leader[1],
      follower.position[2] - leader[2],
    );
  const sorted = [...followers].sort(
    (first, second) => away(first) - away(second) || first.reference - second.reference,
  );
  let place = 0;
  let before: FollowerPlace | undefined;
  for (const follower of sorted) {
    const least = before ? place + before.radius + follower.radius + spacing : 0;
    place = Math.max(follower.wanted, least);
    if (follower.reference === self) return place - follower.wanted;
    before = follower;
  }
  return 0;
}
