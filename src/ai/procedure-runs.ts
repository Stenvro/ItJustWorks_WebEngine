// The package procedures an actor runs (docs/ai.md, "Packages"), each reading its parameters by
// slot (src/ai/procedures.ts). How the engine runs them is not documented beyond the Creation
// Kit's names and its parameters; what they do here follows the names and parameters, and
// where the engine's own rule is not known it is marked TODO(M13). Platform-independent.

import { AI_DEFAULTS, type AiSettings } from './ai-settings.ts';
import { followGait, followRadii, followSpeed } from './followers.ts';
import { IdleCollectionFlag } from './idle-records.ts';
import { sameSpace } from './package-start.ts';
import { TargetType } from './package-records.ts';
import { ObjectType } from './object-types.ts';
import type {
  PackagePlace,
  ProcedureResult,
  ProcedureRun,
  ProcedureRunner,
  SandboxSpot,
  TravelOptions,
} from './package-runtime.ts';

type Vec3 = readonly [number, number, number];

/** The AI's game settings of a run. */
const settingsOf = (run: ProcedureRun): AiSettings => run.settings ?? AI_DEFAULTS;
/**
 * An actor is at a place within its radius, at least fAIDistanceRadiusMinLocation (observed in the
 * original: a place at a marker is reached within fAIMarkerDestinationRadius, at furniture
 * within fAIFurnitureDestinationRadius).
 */
const atPlace = (run: ProcedureRun): number => settingsOf(run).distanceRadiusMinLocation;
/** Keep Eye On and Escort go this near their target (units; ours). */
const NEAR_TARGET = 128;
/** Standing actors look round for something to do this often (seconds). */
const IDLE_SECONDS = 1;
/** A travel whose way failed searches again after this (seconds; ours). */
const TRAVEL_AGAIN = 1;
/** The player's reference. */
const PLAYER = 0x14;
/** An actor reaches what it picks up, activates or talks to from this far. */
const REACH = 96;
const GREET_DISTANCE = 128;
/** A meal and a line said take this long (seconds). TODO(M13): the idle's and line's own. */
const EAT_SECONDS = 6;
/** Food, as a package target names it (object type Food). */
const FOOD = { type: TargetType.objectType, value: ObjectType.food, count: 0 } as const;
const SAY_SECONDS = 3;
/** LockDoors' warning: the TimeToGo subtype, then the game's fAITrespassWarningTimer (s). */
const TIME_TO_GO = 'TITG';
/** At an idle marker, an idle at least this long apart (its timer when longer; seconds). */
const MARKER_PAUSE = 4;
/**
 * A patrol point not reached (blocked) is tried again this many times before the patrol goes on
 * to the next. TODO(M13): the engine's own (not documented); one given up at once left MQ101's
 * second cart 2000 units short of the gate when its last point was blocked a moment.
 */
const PATROL_TRIES = 4;
/**
 * A sandboxing actor stays at what it does about this long (seconds), longer the lower its
 * energy (seconds per point below 100). TODO(M13): the engine's timing.
 */
const SANDBOX_STAY_MIN = 15;
const SANDBOX_STAY_PER_ENERGY = 0.6;
/** Furniture markers' animation types (FurnitureMarkerType): sit, sleep, lean. */
const SIT = 0x1;
const SLEEP = 0x2;
const LEAN = 0x4;

const horizontal = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Waits until the package is left (a procedure that runs for as long as its package). */
async function hold(run: ProcedureRun): Promise<ProcedureResult> {
  while (!run.stopped()) await run.wait(IDLE_SECONDS);
  return 'failure';
}

/** The place in a slot: a location input, or a reference a target input names. */
async function placeIn(run: ProcedureRun, slot: number): Promise<PackagePlace | undefined> {
  const location = run.inputs.location(slot);
  if (location) return run.mind.place(location, run.actor, run.context);
  const target = run.inputs.target(slot);
  const reference = target && (await run.mind.target(target, run.actor, run.context));
  if (reference === undefined) return undefined;
  const at = await run.mind.placement(reference);
  return (
    at && { position: at.position, radius: 0, reference, heading: at.heading, space: at.space }
  );
}

/** The references a slot names: its object list's (what a Find found), else its one target. */
async function targetsIn(run: ProcedureRun, slot: number): Promise<number[]> {
  const found = run.found(slot);
  if (found.length > 0) return [...found];
  const target = run.inputs.target(slot);
  const reference = target && (await run.mind.target(target, run.actor, run.context));
  return reference === undefined ? [] : [reference];
}

/** Goes to a reference (within reach); whether it got there. */
async function goToReference(
  run: ProcedureRun,
  reference: number,
  reach: number,
): Promise<boolean> {
  const at = await run.mind.placement(reference);
  return (
    at !== undefined &&
    (await goTo(run, { position: at.position, radius: 0, space: at.space }, reach))
  );
}

/** Turns to a reference for a moment. */
async function faceReference(run: ProcedureRun, reference: number): Promise<void> {
  const at = await run.mind.placement(reference);
  const here = run.body.position();
  if (!at || !here) return;
  run.body.face(Math.atan2(at.position[0] - here[0], at.position[1] - here[1]));
  await run.wait(0.5);
  run.body.face(undefined);
}

/** Goes to a place (within its radius); whether it got there. */
async function goTo(
  run: ProcedureRun,
  place: PackagePlace,
  arrive?: number,
  options?: TravelOptions,
): Promise<boolean> {
  const here = run.body.position();
  const reach = arrive ?? (await destinationRadius(run, place.reference, place.radius));
  if (here && horizontal(here, place.position) <= reach) return true;
  return run.body.travel(place.position, run.gait, reach, place.space, options);
}

/**
 * The radius a place is reached within (observed in the original): its own, at least
 * fAIMarkerDestinationRadius at a marker, fAIFurnitureDestinationRadius at furniture, else
 * fAIDistanceRadiusMinLocation.
 */
async function destinationRadius(
  run: ProcedureRun,
  reference: number | undefined,
  radius: number,
): Promise<number> {
  const settings = settingsOf(run);
  const kind = reference === undefined ? 'other' : await run.mind.destinationKind?.(reference);
  const least =
    kind === 'marker'
      ? settings.markerDestinationRadius
      : kind === 'furniture'
        ? settings.furnitureDestinationRadius
        : settings.distanceRadiusMinLocation;
  return Math.max(radius, least);
}

/**
 * Travel: to the place (within its radius); succeeds there. A place in another cell or
 * worldspace: its way leads through the load doors (src/shell/actor-ai.ts), and away from the
 * loaded area it goes on as actors away do (src/shell/actors-away.ts).
 */
const travel: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (!place) return hold(run);
  // A way that fails is searched for again (a moment later), not given up: the procedure does
  // not fail its package (a scene's package action would be done with the actor short of its
  // place: MQ101's Torolf on Helgen's porch, his way to the door cut by its frame). The movers
  // warp an actor whose ways keep failing near one spot (bWarpOnConsecutiveFailures, observed
  // in the original), so it gets there in the end.
  for (;;) {
    if (await goTo(run, place, undefined, movingTo(run, place.reference))) return 'success';
    if (run.stopped()) return 'failure';
    await run.wait(TRAVEL_AGAIN);
    if (run.stopped()) return 'failure';
  }
};

/**
 * A travel to a reference that may move: its path is searched again once the reference moved
 * fAIMoveDistanceToRecalcTravelPath from where it led, an actor fAIMoveDistanceToRecalcTravelToActor
 * (observed in the original).
 */
function movingTo(run: ProcedureRun, reference: number | undefined): TravelOptions | undefined {
  if (reference === undefined || !run.mind.livePosition) return undefined;
  const settings = settingsOf(run);
  const actor = run.mind.motion?.(reference) !== undefined;
  return {
    moving: {
      position: () => run.mind.livePosition?.(reference),
      recalc: actor ? settings.recalcTravelToActor : settings.recalcTravelPath,
    },
  };
}

/** HoldPosition: to its place, then stays there while the package runs. */
const holdPosition: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (place) await goTo(run, place);
  if (place?.heading !== undefined) run.body.face(place.heading);
  return hold(run);
};

/** Wait: stands for its seconds (0: as long as the package runs); succeeds then. */
const wait: ProcedureRunner = async (run) => {
  const seconds = run.inputs.number(0);
  run.body.stop();
  if (seconds <= 0) return hold(run);
  await run.wait(seconds);
  return 'success';
};

/**
 * Guard: to its place, facing the way its marker faces, and stays. What it notices meanwhile it
 * reacts to as any actor does (detection's search, the guard's warning: src/ai/reactions.ts).
 * TODO(M13): whether the Guard procedure itself watches those it is suspicious of (undocumented).
 */
const guard: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (place) await goTo(run, place);
  if (place?.heading !== undefined) run.body.face(place.heading);
  return hold(run);
};

/**
 * Patrol: from its start along the references each links to (XLKR without a keyword), going to
 * each within the point radius; with "repeatable" it goes round again from its start, else it
 * succeeds at the end. "Start at nearest": it begins at the point of the patrol nearest it. Each
 * point is reached within the point radius, at least the radius of what the point is
 * (destinationRadius). At an idle marker on the way it stays for the marker's timer, playing its
 * idles; at a point with an idle time (XPRD) it waits that long, in furniture at least
 * fAIPatrolMinSecondsAtNormalFurniture (observed in the original). TODO(M13): the engine's
 * own stay at a patrol's idle marker (its timer once, or each idle's length).
 */
const patrol: ProcedureRunner = async (run) => {
  const target = run.inputs.target(0);
  const start = target && (await run.mind.target(target, run.actor, run.context));
  if (start === undefined) return hold(run);
  const pointRadius = run.inputs.number(1);
  const repeatable = run.inputs.bool(2);
  // Static pathing: straight from point to point (MQ101's carts follow their road so: no
  // navmesh joins some of its points).
  const options: TravelOptions = { direct: run.inputs.bool(5) };
  // The patrol's points: the start, then each one's link, until it ends or comes round.
  const points: number[] = [start];
  for (let next = await run.mind.linked(start, 0); next !== undefined;) {
    if (points.includes(next) || points.length > 256) break;
    points.push(next);
    next = await run.mind.linked(next, 0);
  }
  let index = 0;
  if (run.inputs.bool(3)) {
    const here = run.body.position();
    let nearest = Infinity;
    for (let i = 0; i < points.length && here; i++) {
      const point = points[i];
      const at = point === undefined ? undefined : await run.mind.placement(point);
      const away = at ? horizontal(here, at.position) : Infinity;
      if (away < nearest) {
        nearest = away;
        index = i;
      }
    }
  }
  for (;;) {
    // Whether the round took its time (it walked, idled or waited somewhere): one that did not
    // (each point within reach where it stands, or none placed) waits before it goes round again.
    let spent = false;
    let tries = 0;
    for (; index < points.length; index++) {
      if (run.stopped()) return 'failure';
      const point = points[index];
      const at = point === undefined ? undefined : await run.mind.placement(point);
      if (!at) continue;
      const radius = await destinationRadius(run, point, pointRadius);
      const here = run.body.position();
      if (!here || horizontal(here, at.position) > radius) spent = true;
      if (!(await goTo(run, { position: at.position, radius, space: at.space }, radius, options))) {
        // Not reached (blocked): a moment, then again; given up, on to the next.
        await run.wait(IDLE_SECONDS);
        spent = true;
        if (++tries < PATROL_TRIES) index--;
        else tries = 0;
        continue;
      }
      tries = 0;
      // An idle marker on the way: it stays there for the marker's timer, playing its idles (a
      // marker taken by another: it walks on).
      if (point === undefined || run.stopped()) continue;
      const marker = await run.mind.idleMarker(point);
      if (marker) {
        if (await atIdleMarker(run, point, Math.max(marker.timer, MARKER_PAUSE))) spent = true;
        continue;
      }
      if (await stayAtPatrolPoint(run, point)) spent = true;
    }
    if (!repeatable) return 'success';
    if (!spent) await run.wait(IDLE_SECONDS);
    index = 0;
  }
};

/**
 * A patrol's stay at a point it reached: its idle time (XPRD); furniture it uses for at least
 * fAIPatrolMinSecondsAtNormalFurniture, then gets up. Whether it stayed.
 */
async function stayAtPatrolPoint(run: ProcedureRun, point: number): Promise<boolean> {
  const at = await run.mind.patrolPoint?.(point);
  if (!at) return false;
  if (!at.furniture) {
    if (at.idleTime <= 0) return false;
    await waitFor(run, at.idleTime);
    return true;
  }
  if (!(await run.body.useFurniture(point))) return false;
  await waitFor(run, Math.max(at.idleTime, settingsOf(run).patrolMinSecondsAtNormalFurniture));
  if (!run.stopped()) await run.body.leaveFurniture();
  return true;
}

/**
 * Follow: keeps within its maximum radius of its target, closing to the minimum when it falls
 * behind (one fFollowSpaceBetweenFollowers farther for each of the leader's followers nearer
 * it), running when far behind or when the leader runs; stands, facing it, between. Through
 * load doors and on fast travel the player's followers come along (src/shell/actor-followers.ts);
 * its horse it rides where the package lets it (body.ride). Its radii without its own are the
 * engine's (followRadii); on its way its path follows the leader as it moves (searched again
 * once the leader moved fAIMoveDistanceToRecalcFollowPath), its speed matched to the leader's
 * (followSpeed), sprinting after the player (followGait). TODO(M13): Need LOS (it follows the
 * leader whether it sees it or not) and Accompany are not documented.
 */
const follow: ProcedureRunner = async (run) => {
  const target = run.inputs.target(0);
  const leader = target && (await run.mind.target(target, run.actor, run.context));
  if (leader === undefined) return hold(run);
  const radii = followRadii(settingsOf(run), numberIn(run, 1), numberIn(run, 2));
  try {
    while (!run.stopped()) await followStep(run, leader, radii);
  } finally {
    run.body.following?.(undefined);
  }
  return 'failure';
};

/** A number input's value (undefined: the slot has none). */
const numberIn = (run: ProcedureRun, slot: number): number | undefined => {
  const value = run.inputs.slot(slot)?.value;
  return value?.kind === 'int' || value?.kind === 'float' ? value.value : undefined;
};

/**
 * One step of following a leader within radii (Follow, FollowTo): farther than its maximum
 * (one fFollowSpaceBetweenFollowers farther for each of the leader's followers nearer it) it
 * goes after it until within its minimum; else it stands facing it a moment.
 */
async function followStep(
  run: ProcedureRun,
  leader: number,
  radii: { readonly min: number; readonly max: number },
): Promise<void> {
  const settings = settingsOf(run);
  const near = radii.min + (run.body.following?.(leader) ?? 0);
  const far = Math.max(radii.max, near);
  const at = await run.mind.placement(leader);
  const here = run.body.position();
  if (!at || !here) {
    await run.wait(IDLE_SECONDS);
    return;
  }
  const distance = horizontal(here, at.position);
  if (distance <= far) {
    run.body.face(Math.atan2(at.position[0] - here[0], at.position[1] - here[1]));
    await run.wait(IDLE_SECONDS / 2);
    return;
  }
  const moves = run.mind.motion?.(leader);
  const gait = followGait(
    distance,
    far,
    run.gait,
    {
      running: moves?.running ?? run.mind.running?.(leader) === true,
      sprinting: moves?.sprinting === true,
      player: leader === PLAYER,
    },
    settings.followStartSprintDistance,
  );
  const options: TravelOptions = {
    moving: {
      position: () => run.mind.livePosition?.(leader),
      recalc: settings.recalcFollowPath,
    },
    speedMult: (gaitSpeed) => {
      const there = run.mind.livePosition?.(leader);
      const self = run.body.position();
      if (!there || !self || gaitSpeed <= 0) return 1;
      return followSpeed(settings, {
        distance: horizontal(self, there),
        inner: near,
        outer: far,
        running: gait !== 'walk',
        leaderRatio: (run.mind.motion?.(leader)?.speed ?? 0) / gaitSpeed,
      });
    },
  };
  if (!(await run.body.travel(at.position, gait, near, at.space, options))) {
    await run.wait(IDLE_SECONDS);
  }
}

/** A random point within a place's radius (the place itself without one). */
function pointIn(run: ProcedureRun, place: PackagePlace): Vec3 {
  const angle = run.random() * Math.PI * 2;
  const reach = Math.sqrt(run.random()) * place.radius;
  return [
    place.position[0] + Math.sin(angle) * reach,
    place.position[1] + Math.cos(angle) * reach,
    place.position[2],
  ];
}

/**
 * Where a wanderer walks next (observed in the original: its Wander, and a Sandbox's
 * wandering, which runs a Wander in the sandbox's place with its Min Wander Distance). Its place
 * reaches at least fAIDistanceRadiusMinLocation; outside it, it first goes into it (to its middle).
 *
 * - **Its first walk** (`last` undefined): a random point of the navmesh within the place that it
 *   can walk to, at least its Min Wander Distance from it (the pathing's random location).
 * - **Each walk after:** from the place's middle, the way from where its last walk led towards
 *   the middle, turned at random up to 45° either side, as far as a random share of the radius:
 *   across the place from where it was, at the middle's height. A point it cannot walk to (off
 *   the navmesh, beyond a fence, on another island) is not taken: the engine's path request
 *   fails and it asks again; here a few points are tried at once.
 *
 * Undefined: no point found (it waits a moment and tries again). Before, any point within the
 * radius was taken, unchecked (inside a house, behind a fence).
 */
function wanderPoint(
  run: ProcedureRun,
  place: PackagePlace,
  least: number,
  last: Vec3 | undefined,
): Vec3 | undefined {
  const here = run.body.position();
  const radius = Math.max(place.radius, atPlace(run));
  if (!here) return pointIn(run, { ...place, radius });
  // Outside its place it first goes into it.
  if (horizontal(here, place.position) > radius) return place.position;
  const mind = run.mind;
  if (last === undefined) {
    if (!mind.randomPoint) return pointIn(run, { ...place, radius });
    return mind.randomPoint(run.actor, place.position, radius, least, () => run.random());
  }
  const [cx, cy, cz] = place.position;
  const dx = cx - last[0];
  const dy = cy - last[1];
  const length = Math.hypot(dx, dy);
  const [ux, uy] = length > 1e-6 ? [dx / length, dy / length] : [0, 1];
  for (let attempt = 0; attempt < WANDER_TRIES; attempt++) {
    const turn = (run.random() - 0.5) * (Math.PI / 2);
    const reach = run.random() * radius;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const point: Vec3 = [
      cx + (ux * cos + uy * sin) * reach,
      cy + (uy * cos - ux * sin) * reach,
      cz,
    ];
    if (!mind.walkable) return point;
    const on = mind.walkable(run.actor, point);
    if (on) return on;
  }
  return undefined;
}

/** Points a wanderer tries at once before it waits and asks again. */
const WANDER_TRIES = 8;
/** A wanderer is at its point within this (units). */
const WANDER_ARRIVE = 48;

/**
 * How long a wanderer pauses between its walks (observed in the original): up to
 * (fAIMaxWanderTime − (Energy × fAIEngergyLevelMult + fAIEnergyLevelBase)) / 2 seconds, at random.
 */
function wanderPause(run: ProcedureRun, energy: number): number {
  const settings = settingsOf(run);
  const most =
    (settings.maxWanderTime - (energy * settings.energyLevelMult + settings.energyLevelBase)) / 2;
  return Math.max(0, most) * run.random();
}

/** The actor's Energy (its AI data's; 50 where it is not known). */
async function energyOf(run: ProcedureRun): Promise<number> {
  return (await run.mind.energy?.(run.actor)) ?? DEFAULT_ENERGY;
}

const DEFAULT_ENERGY = 50;

/**
 * Wander: goes from one random point of its place to another, each at least its Min Wander
 * Distance (fAIWanderDefaultMinDist without one) from the last, pausing between (wanderPause),
 * for as long as the package runs.
 */
const wander: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (!place) return hold(run);
  const least = numberIn(run, 3) ?? settingsOf(run).wanderDefaultMinDist;
  const energy = await energyOf(run);
  let last: Vec3 | undefined;
  while (!run.stopped()) {
    const point = wanderPoint(run, place, least, last);
    if (!point) {
      await run.wait(IDLE_SECONDS);
      continue;
    }
    last = point;
    await run.body.travel(point, 'walk', WANDER_ARRIVE);
    // At least until the next update (a pause of 0 is no endless loop).
    await run.wait(wanderPause(run, energy));
  }
  return 'failure';
};

/** Waits a while, less if the package is left. */
async function waitFor(run: ProcedureRun, seconds: number): Promise<void> {
  for (let waited = 0; waited < seconds && !run.stopped(); waited += IDLE_SECONDS) {
    await run.wait(Math.min(IDLE_SECONDS, seconds - waited));
  }
}

/**
 * At an idle marker: to it, facing its way, its idles played (in order, or one picked each
 * time), one each time its timer runs out, for `seconds` (or once through, if it plays them
 * once; or while the package runs). Whether it got there (the marker free).
 */
async function atIdleMarker(
  run: ProcedureRun,
  marker: number,
  seconds = Infinity,
): Promise<boolean> {
  const at = await run.mind.idleMarker(marker);
  if (!at || !run.body.takeIdleMarker(marker)) return false;
  try {
    if (
      !(await goTo(
        run,
        { position: at.position, radius: 0 },
        settingsOf(run).markerDestinationRadius,
      ))
    )
      return false;
    run.body.face(at.heading);
    await run.wait(1);
    run.body.face(undefined);
    let played = 0;
    for (let spent = 0; spent < seconds && !run.stopped(); played++) {
      const idles = at.idles;
      if (idles.length === 0) break;
      const once = (at.flags & IdleCollectionFlag.doOnce) !== 0;
      if (once && played >= idles.length) break;
      const sequence = (at.flags & IdleCollectionFlag.pickSequence) !== 0;
      const idle = sequence
        ? idles[played % idles.length]
        : idles[Math.floor(run.random() * idles.length)];
      if (idle !== undefined) await run.body.playIdle(idle);
      const pause = Math.max(at.timer, MARKER_PAUSE);
      await waitFor(run, Math.min(pause, seconds - spent));
      spent += pause;
    }
    return true;
  } finally {
    run.body.leaveIdleMarker();
  }
}

/** The kinds of markers each sandbox spot is used by. */
const SPOT_MARKERS: Readonly<Record<SandboxSpot['kind'], number>> = {
  sit: SIT | LEAN,
  sleep: SLEEP,
  special: SIT | SLEEP | LEAN,
  idle: 0,
};

/**
 * Sandbox: within its place, the actor passes the time: it sits and leans (Allow Sitting),
 * sleeps (Allow Sleeping), works at special furniture (Allow Special Furniture), stands at idle
 * markers playing their idles (Allow Idle Markers) and wanders (Allow Wandering), one thing at a
 * time, each for a while that its Energy shortens. TODO(M13): the engine's own choice and
 * timing are not documented (here: a free spot or a walk, picked at random). With Allow
 * Conversation it talks with the actors near it meanwhile (src/ai/talk.ts: the social timers
 * start them). With Allow Eating it eats now and then: food it carries (one used up), else a
 * meal made up as Eat's Create Fake Food does.
 */
const sandbox: ProcedureRunner = async (run) => {
  run.body.allowConversation?.(run.inputs.bool(3, true));
  try {
    return await sandboxing(run);
  } finally {
    run.body.allowConversation?.(false);
  }
};

const sandboxing: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (!place) return hold(run);
  await goTo(run, place);
  const allows: Readonly<Record<SandboxSpot['kind'], boolean>> = {
    sit: run.inputs.bool(5, true),
    sleep: run.inputs.bool(2, false),
    special: run.inputs.bool(9, false),
    idle: run.inputs.bool(4, true),
  };
  const eats = run.inputs.bool(1, false);
  const wanders = run.inputs.bool(6, true);
  // Its Energy, without one the actor's own (observed in the original); its walks go at
  // least its Min Wander Distance (fAIWanderDefaultMinDist without one).
  const energy = Math.min(100, Math.max(0, numberIn(run, 8) ?? (await energyOf(run))));
  const least = numberIn(run, 10) ?? settingsOf(run).wanderDefaultMinDist;
  const radius = Math.max(place.radius, atPlace(run));
  // Where its last walk led (its wandering goes on across the place from there).
  let lastWalk: Vec3 | undefined;
  while (!run.stopped()) {
    // An active actor (high energy) moves on sooner.
    const stay =
      (SANDBOX_STAY_MIN + (100 - energy) * SANDBOX_STAY_PER_ENERGY) * (0.5 + run.random());
    const spots = (await run.mind.around(place.position, radius, run.actor)).filter(
      (spot) => allows[spot.kind],
    );
    const walks = wanders && place.radius > 0 ? 1 : 0;
    const choices = spots.length + walks + (eats ? 1 : 0);
    const pick = Math.floor(run.random() * choices);
    const spot = spots[pick];
    if (run.stopped()) break;
    if (eats && pick === choices - 1) {
      // A meal: what it carries, else one made up.
      const carried = await run.mind.carried(run.actor, FOOD);
      const food = carried ?? (await run.mind.fakeFood());
      if (food !== undefined && (await run.body.useItem(food, carried !== undefined))) {
        await waitFor(run, EAT_SECONDS);
      } else {
        await run.wait(IDLE_SECONDS);
      }
    } else if (spot?.kind === 'idle') {
      if (!(await atIdleMarker(run, spot.reference, stay))) await run.wait(IDLE_SECONDS);
    } else if (spot) {
      if (await run.body.useFurniture(spot.reference, SPOT_MARKERS[spot.kind])) {
        await waitFor(run, stay);
        if (!run.stopped()) await run.body.leaveFurniture();
      } else {
        await run.wait(IDLE_SECONDS);
      }
    } else if (choices > 0) {
      const point = wanderPoint(run, place, least, lastWalk);
      if (point) {
        lastWalk = point;
        await run.body.travel(point, 'walk', WANDER_ARRIVE);
        await waitFor(run, stay / 4);
      } else {
        await run.wait(IDLE_SECONDS);
      }
    } else {
      await waitFor(run, stay / 4);
    }
  }
  return 'failure';
};

/**
 * Sit, Sleep, UseIdleMarker: uses the furniture it is given (its markers of the procedure's
 * kinds: sitting and leaning, sleeping, any) and stays in it while the package runs; at an idle
 * marker, plays its idles. Sit succeeds once the actor sits (`seated`; it stays seated while the
 * package is still the one chosen): MQ101's execution scene goes on when the prisoner's Sit at
 * the chopping block completes. Furniture it cannot use (taken, no way in from where it stood):
 * to it, then once more from there; else it stands there facing its way.
 * Given an object list no Find filled, it looks round itself (as far as the list's value, else
 * fAIFindBedChairsDistance) for furniture of its kinds, nearest first.
 */
const useFurniture =
  (types: number, seated: 'success' | 'hold' = 'hold'): ProcedureRunner =>
  async (run) => {
    // Its target, or the first it may use of those a Find found ("Found Bed", "Found Chair"),
    // else of those round it (an object list nothing filled).
    let candidates = await targetsIn(run, 0);
    const list = run.inputs.slot(0)?.value;
    const here = run.body.position();
    if (candidates.length === 0 && list?.kind === 'objectList' && here) {
      const radius = list.value > 0 ? list.value : settingsOf(run).findBedChairsDistance;
      candidates = (await run.mind.around(here, radius, run.actor))
        .filter((spot) => spot.kind !== 'idle' && (SPOT_MARKERS[spot.kind] & types) !== 0)
        .sort((a, b) => horizontal(here, a.position) - horizontal(here, b.position))
        .map((spot) => spot.reference);
    }
    const sit = async (): Promise<boolean> => {
      for (const reference of candidates) {
        if (run.stopped()) return false;
        if (await run.body.useFurniture(reference, types)) return true;
      }
      return false;
    };
    const inIt = async (): Promise<ProcedureResult> =>
      seated === 'success' ? 'success' : hold(run);
    if (await sit()) return inIt();
    const first = candidates[0];
    if (first !== undefined && (await run.mind.idleMarker(first))) {
      await atIdleMarker(run, first);
      return run.stopped() ? 'failure' : hold(run);
    }
    if (run.stopped()) return 'failure';
    const at = first === undefined ? undefined : await run.mind.placement(first);
    if (at) {
      await goTo(
        run,
        { position: at.position, radius: 0 },
        settingsOf(run).furnitureDestinationRadius,
      );
      if (await sit()) return inIt();
      run.body.face(at.heading);
    }
    return hold(run);
  };

/** A procedure that does not use furniture: the actor gets up first. */
const standing =
  (runner: ProcedureRunner): ProcedureRunner =>
  async (run) => {
    await run.body.leaveFurniture();
    return run.stopped() ? 'failure' : runner(run);
  };

/**
 * LockDoors, UnlockDoors: the load doors within its place are locked (a door without a lock
 * gets a novice one) or unlocked; done at once. With Warn Before Locking and the player within
 * the place, the actor first tells them to go (its TimeToGo line, to them) and locks after the
 * game's fAITrespassWarningTimer (Skyrim.esm: 5 s). A player who stays is trespassing: the home is off
 * limits to them (crime-engine.ts doorsLocked), those who see them warn them (the Trespass
 * lines, GetTrespassWarningLevel) and then report it (src/shell/actor-crime.ts).
 */
const doors =
  (locked: boolean): ProcedureRunner =>
  async (run) => {
    const place = await placeIn(run, 0);
    if (!place) return 'failure';
    if (locked && run.inputs.bool(1) && (await playerWithin(run, place))) {
      await run.body.say(TIME_TO_GO, { target: PLAYER });
      await waitFor(run, settingsOf(run).trespassWarningTimer);
      if (run.stopped()) return 'failure';
    }
    await run.mind.lockDoors(place, locked);
    return 'success';
  };

/**
 * Whether the player is within a place: in its cell or worldspace (the actor's, for a place
 * without one) and within its radius (at least fAIDistanceRadiusMinLocation).
 */
async function playerWithin(run: ProcedureRun, place: PackagePlace): Promise<boolean> {
  const [player, self] = await Promise.all([
    run.mind.placement(PLAYER),
    run.mind.placement(run.actor),
  ]);
  if (!player) return false;
  const space = place.space ?? self?.space;
  if (space && player.space && !sameSpace(space, player.space)) return false;
  return horizontal(player.position, place.position) <= Math.max(place.radius, atPlace(run));
}

/**
 * Find: the references its search criteria name within its place, nearest first, kept in its
 * object list for the procedures after it (Sit and Sleep use the first free one, Acquire picks
 * them up); succeeds if it found any. Criteria that name one reference (specific, linked, an
 * alias) find that one. Without Allow Stealing only what the actor may use. TODO(M13): Allow
 * Already Held (items others carry).
 */
const find: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  const criteria = run.inputs.target(1);
  if (!place || !criteria) return 'failure';
  let found: readonly number[];
  if (criteria.type === TargetType.objectId || criteria.type === TargetType.objectType) {
    found = await run.mind.search(criteria, place, run.actor, run.inputs.bool(4));
  } else {
    const one = await run.mind.target(criteria, run.actor, run.context);
    found = one === undefined ? [] : [one];
  }
  run.keep(2, found);
  return found.length > 0 ? 'success' : 'failure';
};

/**
 * Acquire: picks up what its object list holds, nearest first, until it has as many as it was
 * to. One a living actor holds it does not take: with Allow Pickpocketing it goes to them and
 * takes it from them, with Allow Killing it fights them for it (its body's attack: a StartCombat).
 * TODO(M13): whether those who see an actor's pickpocketing report it (the player's is crime's).
 */
const acquire: ProcedureRunner = async (run) => {
  const wanted = Math.max(1, run.inputs.number(1, 1));
  const pickpocketing = run.inputs.bool(3);
  const killing = run.inputs.bool(4);
  let taken = 0;
  for (const reference of await targetsIn(run, 0)) {
    if (run.stopped() || taken >= wanted) break;
    const holder = await run.mind.holder?.(reference);
    if (holder !== undefined && holder !== run.actor) {
      if (pickpocketing && run.body.pickpocket) {
        if (
          (await goToReference(run, holder, REACH)) &&
          (await run.body.pickpocket(holder, reference))
        )
          taken++;
      } else if (killing) run.body.attack?.(holder);
      continue;
    }
    if (!(await goToReference(run, reference, REACH))) continue;
    if (await run.body.take(reference)) taken++;
  }
  return taken > 0 ? 'success' : 'failure';
};

/**
 * Activate: goes to its target (or those its object list holds) and activates it. Furniture
 * activated is furniture used (the ActivateSpecialFurniture template: Torolf leaning on his
 * porch's rail, Haming sitting by it): the actor goes into it by its enter, from where it is,
 * and one in it already stays (it does not stand up first, nor walk to the furniture's own
 * place, which its graph could not leave while it sits).
 */
const activate: ProcedureRunner = async (run) => {
  const count = Math.max(1, run.inputs.number(1, 1));
  const targets = await targetsIn(run, 0);
  const furniture = new Set<number>();
  for (const reference of targets) {
    if ((await run.mind.destinationKind?.(reference)) === 'furniture') furniture.add(reference);
  }
  const first = targets[0];
  if (first === undefined || !furniture.has(first)) await run.body.leaveFurniture();
  let done = 0;
  for (const reference of targets) {
    if (run.stopped() || done >= count) break;
    if (furniture.has(reference)) {
      if (await run.body.useFurniture(reference)) done++;
      continue;
    }
    if (!(await goToReference(run, reference, REACH))) continue;
    await faceReference(run, reference);
    if (await run.body.activate(reference)) done++;
  }
  return done > 0 ? 'success' : 'failure';
};

/**
 * Eat: food its criteria name that it carries (one used up), else, if it may (Create Fake
 * Food), food made for the meal: its eating idle plays.
 */
const eat: ProcedureRunner = async (run) => {
  const criteria = run.inputs.target(0);
  const carried = criteria && (await run.mind.carried(run.actor, criteria));
  const food = carried ?? (run.inputs.bool(1) ? await run.mind.fakeFood() : undefined);
  if (food === undefined || run.stopped()) return 'failure';
  if (!(await run.body.useItem(food, carried !== undefined))) return 'failure';
  await waitFor(run, EAT_SECONDS);
  return 'success';
};

/**
 * Say: says its topic (or a line of a topic subtype) to its target, facing it if it should,
 * its subtitle shown whatever the setting with Force Subtitle; with Finish Speaking it waits
 * for the line (its own length; SAY_SECONDS where the body does not tell).
 */
const say: ProcedureRunner = async (run) => {
  const topic = run.inputs.topic(0);
  if (topic === undefined) return 'failure';
  const target = (await targetsIn(run, 1))[0];
  if (target !== undefined && run.inputs.bool(3, true)) await faceReference(run, target);
  const said = run.body.say(topic, { target, forceSubtitle: run.inputs.bool(4) });
  if (run.inputs.bool(2, true)) {
    if (said) await said;
    else await waitFor(run, SAY_SECONDS);
  }
  return 'success';
};

/**
 * ForceGreet: waits at its wait location until the player comes into its trigger location,
 * then goes to the player and opens the conversation with its topic.
 */
const forceGreet: ProcedureRunner = async (run) => {
  const topic = run.inputs.topic(0);
  const waitAt = await placeIn(run, 1);
  const trigger = await placeIn(run, 2);
  if (waitAt) await goTo(run, waitAt);
  while (!run.stopped()) {
    const player = await run.mind.placement(PLAYER);
    const reach = Math.max(trigger?.radius ?? 0, atPlace(run));
    const inside = player && (!trigger || horizontal(player.position, trigger.position) <= reach);
    if (player && inside) {
      const here = run.body.position();
      const near = here !== undefined && horizontal(here, player.position) <= GREET_DISTANCE;
      if (
        near ||
        (await run.body.travel(player.position, run.gait, GREET_DISTANCE, player.space))
      ) {
        if (run.body.greet(typeof topic === 'number' ? topic : undefined)) return 'success';
      }
    }
    await run.wait(IDLE_SECONDS);
  }
  return 'failure';
};

/**
 * DialogueActivate: to the player, from where it talks (else beside them) it talks to them:
 * the player gets the conversation. To another actor (observed in the original) it asks
 * the story manager for a scene with it (the Actor Dialogue event) and waits for one
 * (src/shell/actor-talk.ts, dialogueActivate): it succeeds once that scene has played and
 * fails when none came within fAISocialTimerToWaitForEvent; the scene brings the two together.
 */
const dialogueActivate: ProcedureRunner = async (run) => {
  const target = (await targetsIn(run, 0))[0];
  if (target === undefined) return hold(run);
  if (target !== PLAYER) {
    const converse = run.body.converse?.bind(run.body);
    if (!converse) return hold(run);
    return (await converse(target)) ? 'success' : 'failure';
  }
  const from = await placeIn(run, 1);
  if (from) await goTo(run, from);
  else await goToReference(run, target, GREET_DISTANCE);
  if (run.inputs.bool(2, true)) await faceReference(run, target);
  return run.body.greet(undefined) ? 'success' : hold(run);
};

/**
 * KeepAnEyeOn: watches its target while it is in the observation area, pursues it while it is
 * in the end pursuit area, and is done when it has left that.
 */
const keepAnEyeOn: ProcedureRunner = async (run) => {
  const target = (await targetsIn(run, 0))[0];
  if (target === undefined) return hold(run);
  const area = await placeIn(run, 1);
  const pursuit = await placeIn(run, 2);
  const within = (place: PackagePlace | undefined, at: Vec3): boolean =>
    !place || horizontal(place.position, at) <= Math.max(place.radius, atPlace(run));
  while (!run.stopped()) {
    const at = await run.mind.placement(target);
    if (!at) {
      await run.wait(IDLE_SECONDS);
      continue;
    }
    if (within(area, at.position)) {
      await faceReference(run, target);
    } else if (within(pursuit, at.position)) {
      if (!(await run.body.travel(at.position, run.gait, NEAR_TARGET, at.space))) {
        await run.wait(IDLE_SECONDS);
      }
    } else {
      return 'success';
    }
  }
  return 'failure';
};

/**
 * Escort: leads its target to the destination; where the target falls behind it stops and
 * waits for it, facing it (observed in the original): behind by more than the Distance To
 * Wait For Followers (without one: fAIEscortWaitDistanceInterior inside, outside
 * fAIEscortWaitDistanceExterior times the destination's radius, at least 200), going on once
 * it is that near again; under way it stops only fAIEscortHysteresisWidth farther, and it
 * starts or stops at most every fAIEscortStartStopDelayTime seconds.
 */
const escort: ProcedureRunner = async (run) => {
  const settings = settingsOf(run);
  const follower = (await targetsIn(run, 0))[0];
  const destination = await placeIn(run, 2);
  if (!destination) return hold(run);
  const reach = await destinationRadius(run, destination.reference, destination.radius);
  const own = numberIn(run, 3) ?? 0;
  const self = await run.mind.placement(run.actor);
  const space = destination.space ?? self?.space;
  const waitDistance =
    own > 0
      ? own
      : space?.kind === 'interior'
        ? settings.escortWaitDistanceInterior
        : Math.max(destination.radius || ESCORT_RADIUS, ESCORT_RADIUS_MIN) *
          settings.escortWaitDistanceExterior;
  let going: Promise<boolean> | undefined;
  // When it last started or stopped (its clock: the waits' seconds).
  let clock = 0;
  let changed = -Infinity;
  while (!run.stopped()) {
    const here = run.body.position();
    if (here && horizontal(here, destination.position) <= reach) return 'success';
    const at = follower === undefined ? undefined : await run.mind.placement(follower);
    const behind = at && here ? horizontal(at.position, here) : 0;
    const settled = clock - changed >= settings.escortStartStopDelayTime;
    if (going && settled && behind > waitDistance + settings.escortHysteresisWidth) {
      run.body.stop();
      going = undefined;
      changed = clock;
    } else if (!going && (behind > waitDistance || !settled)) {
      if (at && here) {
        run.body.face(Math.atan2(at.position[0] - here[0], at.position[1] - here[1]));
      }
    } else if (!going) {
      run.body.face(undefined);
      changed = clock;
      going = run.body
        .travel(destination.position, run.gait, reach, destination.space)
        .finally(() => {
          going = undefined;
        });
    }
    await run.wait(ESCORT_CHECK_SECONDS);
    clock += ESCORT_CHECK_SECONDS;
  }
  return 'failure';
};

/** An escort looks at its followers this often (seconds). */
const ESCORT_CHECK_SECONDS = 0.25;
/** A destination without a radius counts as this wide for the escort's waiting (the engine's). */
const ESCORT_RADIUS = 256;
const ESCORT_RADIUS_MIN = 200;

/**
 * FollowTo: follows its target (between its radii, kept apart from the leader's other
 * followers, as Follow does) until one of them reaches the destination.
 */
const followTo: ProcedureRunner = async (run) => {
  const leader = (await targetsIn(run, 0))[0];
  if (leader === undefined) return hold(run);
  const destination = await placeIn(run, 1);
  const radii = followRadii(settingsOf(run), numberIn(run, 2), numberIn(run, 3));
  const reach =
    destination && (await destinationRadius(run, destination.reference, destination.radius));
  try {
    while (!run.stopped()) {
      const at = await run.mind.placement(leader);
      const here = run.body.position();
      if (
        destination &&
        reach !== undefined &&
        ((here && horizontal(here, destination.position) <= reach) ||
          (at && horizontal(at.position, destination.position) <= reach))
      ) {
        return 'success';
      }
      await followStep(run, leader, radii);
    }
  } finally {
    run.body.following?.(undefined);
  }
  return 'failure';
};

/**
 * Flee (not in combat): runs to its flee-to place, else away from what it flees from by its
 * flee distance; with Counts As Fleeing it is fleeing meanwhile (IsFleeing). Fleeing in combat
 * is the combat AI's (src/shell/actor-combat-ai.ts).
 */
const flee: ProcedureRunner = async (run) => {
  const counts = run.inputs.bool(9);
  if (counts) run.body.fleeing?.(true);
  try {
    return await fleeAway(run);
  } finally {
    if (counts) run.body.fleeing?.(false);
  }
};

const fleeAway: ProcedureRunner = async (run) => {
  const to = await placeIn(run, 1);
  const here = run.body.position();
  let goal: Vec3 | undefined = to?.position;
  if (!goal && here) {
    const threat = (await targetsIn(run, 0))[0];
    const from = threat === undefined ? undefined : await run.mind.placement(threat);
    const distance = Math.max(run.inputs.number(5, 1024), atPlace(run));
    const dx = from ? here[0] - from.position[0] : 0;
    const dy = from ? here[1] - from.position[1] : 1;
    const length = Math.hypot(dx, dy) || 1;
    goal = [here[0] + (dx / length) * distance, here[1] + (dy / length) * distance, here[2]];
  }
  if (!goal) return 'failure';
  const arrived = await run.body.travel(
    goal,
    'run',
    Math.max(to?.radius ?? 0, atPlace(run)),
    to?.space,
  );
  return arrived ? 'success' : 'failure';
};

/** An orbit without radii circles this far from its place (units). TODO(M13): the engine's. */
const ORBIT_RADIUS = 2048;
/** A hover faces this far ahead along its place's heading (units). */
const HOVER_FACE = 1024;

/**
 * Hover: a flier flies to its place, Height above it, and hovers there facing the place's
 * heading while the package runs (src/shell/actor-flight.ts); one that cannot fly holds its
 * place.
 */
const hover: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  const body = run.body;
  if (!place || !body.fly || body.flies?.() !== true) return hold(run);
  const height = run.inputs.number(1, 0);
  const at: Vec3 = [place.position[0], place.position[1], place.position[2] + height];
  const heading = place.heading ?? body.heading();
  const face: Vec3 = [
    at[0] + Math.sin(heading) * HOVER_FACE,
    at[1] + Math.cos(heading) * HOVER_FACE,
    at[2],
  ];
  body.fly({ kind: 'hover', at, face });
  try {
    return await hold(run);
  } finally {
    body.fly(undefined);
  }
};

/**
 * Orbit: a flier circles its place between the inner and outer radius (their middle), Height
 * above it, while the package runs; one that cannot fly holds its place.
 */
const orbit: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  const body = run.body;
  if (!place || !body.fly || body.flies?.() !== true) return hold(run);
  const inner = run.inputs.number(1, 0);
  const outer = run.inputs.number(2, 0);
  const radius = inner > 0 || outer > 0 ? (inner + Math.max(inner, outer)) / 2 : ORBIT_RADIUS;
  body.fly({
    kind: 'orbit',
    center: place.position,
    radius: Math.max(radius, place.radius),
    height: run.inputs.number(3, 0),
    clockwise: run.random() < 0.5,
  });
  try {
    return await hold(run);
  } finally {
    body.fly(undefined);
  }
};

/** FlightGrab: a flier flies at its target and grabs it in its talons; succeeds once it did. */
const flightGrab: ProcedureRunner = async (run) => {
  const victim = (await targetsIn(run, 0))[0];
  if (victim === undefined || !run.body.flightGrab || run.body.flies?.() !== true) {
    return 'failure';
  }
  return (await run.body.flightGrab(victim)) ? 'success' : 'failure';
};

/** A value between a and b, picked at random. */
function between(run: ProcedureRun, min: number, max: number): number {
  const low = Math.min(min, max);
  return low + run.random() * Math.abs(max - min);
}

/**
 * UseWeapon: to its place, then at its target (an archery butt, a training dummy, an enemy)
 * with the weapon its Weapon Type names: barrages of Min..Max Attacks Per Barrage (at least
 * one), Min..Max Pause apart (Pause Between Barrages), until End After Barrages of them (0 or
 * Never End: while the package runs); Do No Damage, Always Hit, Aim Only (it draws and aims,
 * never looses), Always Power Attack, Allow Combat Start On Hit and Headtrack Target are the
 * barrage's (the body's: src/shell/actor-practice.ts). Its weapon goes away as it ends.
 * TODO(M13): Crouch To Reload and Hold When Blocked (no vanilla package holds its fire for a
 * blocked line; crouching is the sneak pose the engine gives a crossbowman).
 */
const useWeapon: ProcedureRunner = async (run) => {
  const body = run.body;
  if (!body.useWeapon) return hold(run);
  const place = await placeIn(run, 0);
  if (place) await goTo(run, place);
  const target = (await targetsIn(run, 2))[0];
  if (target === undefined) return hold(run);
  const inputs = run.inputs;
  const neverEnd = inputs.bool(4);
  const barrages = Math.max(0, Math.round(inputs.number(11)));
  const pause = inputs.bool(5);
  try {
    for (let done = 0; !run.stopped() && (neverEnd || barrages === 0 || done < barrages); done++) {
      const attacks = Math.max(
        1,
        Math.round(between(run, inputs.number(12, 1), inputs.number(13, 1))),
      );
      const ok = await body.useWeapon(target, {
        weapon: inputs.target(1),
        attacks,
        alwaysHit: inputs.bool(3),
        doNoDamage: inputs.bool(7),
        aimOnly: inputs.bool(15),
        powerAttack: inputs.bool(16),
        combatStartOnHit: inputs.bool(14),
        headtrack: inputs.bool(17, true),
      });
      if (!ok) {
        // A barrage that could not be made (its weapon not ready, its body busy) ends a
        // counted practice; one that never ends tries again a moment later: MQ101's first
        // archer gave up on Lokir at once and stood, his package over, while the execution
        // waited for Lokir to die.
        if (!neverEnd && barrages > 0) return 'failure';
        await run.wait(IDLE_SECONDS);
        done--;
        continue;
      }
      if (pause) await run.wait(Math.max(0.5, between(run, inputs.number(9), inputs.number(10))));
    }
  } finally {
    body.holster?.();
  }
  return run.stopped() ? 'failure' : 'success';
};

/**
 * UseMagic: to its place, then casts its Spell at its target (itself without one): Number To
 * Cast Min..Max casts (0: while the package runs), each held Cast Time Min..Max seconds (a
 * concentration spell), Cooldown Time Min..Max apart, dual cast with Dual Cast. Its magic goes
 * away as it ends. TODO(M13): Hold When Blocked.
 */
const useMagic: ProcedureRunner = async (run) => {
  const body = run.body;
  if (!body.useMagic) return hold(run);
  const place = await placeIn(run, 0);
  if (place) await goTo(run, place);
  const target = (await targetsIn(run, 2))[0];
  const inputs = run.inputs;
  const count = Math.round(between(run, inputs.number(8), inputs.number(9)));
  try {
    for (let done = 0; !run.stopped() && (count <= 0 || done < count); done++) {
      const ok = await body.useMagic(target, {
        spell: inputs.target(1),
        castTime: Math.max(0, between(run, inputs.number(4), inputs.number(5))),
        dual: inputs.bool(10),
      });
      if (!ok) return 'failure';
      await run.wait(Math.max(0.5, between(run, inputs.number(6), inputs.number(7))));
    }
  } finally {
    body.holster?.();
  }
  return run.stopped() ? 'failure' : 'success';
};

/**
 * Shout: to its place, then shouts its Shout (else its voice's) at its target once, and
 * succeeds: the Greybeards' practice, a dragon's breath at a place. As the engine's procedure
 * does, it shouts whether or not its voice has recovered from its last shout (the voice's cast
 * check skipped); while it casts it waits to shout. With Just Headtrack it only turns its head to the target (not its body). One
 * shout each: vanilla templates run Shouts one after another (dunCGAlduinDTravelGateBlocker02's
 * two, dunCGAlduinShoutFromHoverMultipleTargetsRepeatTemplate's three in a repeating
 * sequence), and MQ101's attack scene waits for Alduin's shout from the tower to complete his
 * package (dunCGAlduinPerchShoutTemplate: Sit, then a Shout whose success completes it).
 * TODO(M13): Hold When Blocked.
 */
const shout: ProcedureRunner = async (run) => {
  const body = run.body;
  if (!body.shout) return hold(run);
  const place = await placeIn(run, 0);
  if (place) await goTo(run, place);
  const target = (await targetsIn(run, 2))[0];
  const turn = !run.inputs.bool(4);
  while (!run.stopped()) {
    const result = await body.shout(target, run.inputs.target(1), turn);
    if (result === 'none') return 'failure';
    if (result === 'shouted') return run.stopped() ? 'failure' : 'success';
    await run.wait(1);
  }
  return 'failure';
};

/**
 * The procedures run, by lower-case name; the others hold the actor where it is (standing up
 * from furniture first).
 */
export const PROCEDURES: Readonly<Record<string, ProcedureRunner>> = {
  travel: standing(travel),
  holdposition: standing(holdPosition),
  wait: standing(wait),
  guard: standing(guard),
  patrol: standing(patrol),
  follow: standing(follow),
  wander: standing(wander),
  sandbox: standing(sandbox),
  sit: useFurniture(SIT | LEAN, 'success'),
  sleep: useFurniture(SLEEP),
  useidlemarker: useFurniture(SIT | SLEEP | LEAN),
  unlockdoors: doors(false),
  lockdoors: doors(true),
  find,
  acquire: standing(acquire),
  activate,
  eat,
  say,
  forcegreet: standing(forceGreet),
  dialogueactivate: standing(dialogueActivate),
  keepaneyeon: standing(keepAnEyeOn),
  escort: standing(escort),
  followto: standing(followTo),
  flee: standing(flee),
  hover: standing(hover),
  orbit: standing(orbit),
  flightgrab: standing(flightGrab),
  useweapon: standing(useWeapon),
  usemagic: standing(useMagic),
  shout: standing(shout),
};
