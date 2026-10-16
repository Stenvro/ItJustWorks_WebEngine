// The package procedures an actor runs (docs/ai.md, "Packages"), each reading its parameters by
// slot (src/ai/procedures.ts). How the engine runs them is not documented beyond the Creation
// Kit's names and its parameters; what they do here follows the names and parameters, and
// where the engine's own rule is not known it is marked TODO(M13). Platform-independent.

import { IdleCollectionFlag } from './idle-records.ts';
import { TargetType } from './package-records.ts';
import type {
  PackagePlace,
  ProcedureResult,
  ProcedureRun,
  ProcedureRunner,
  SandboxSpot,
} from './package-runtime.ts';

type Vec3 = readonly [number, number, number];

/** An actor counts as at a place within this of it when the place has no radius. */
const AT_PLACE = 64;
/** Standing actors look round for something to do this often (seconds). */
const IDLE_SECONDS = 1;
/** The player's reference. */
const PLAYER = 0x14;
/** An actor reaches what it picks up, activates or talks to from this far. */
const REACH = 96;
const GREET_DISTANCE = 128;
/** A meal and a line said take this long (seconds). TODO(M13): the idle's and line's own. */
const EAT_SECONDS = 6;
const SAY_SECONDS = 3;
/** An actor is at an idle marker within this of it. */
const ARRIVE_AT_MARKER = 24;
/** At an idle marker, an idle at least this long apart (its timer when longer; seconds). */
const MARKER_PAUSE = 4;
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
  return at && { position: at.position, radius: 0, reference, heading: at.heading };
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
  return at !== undefined && (await goTo(run, { position: at.position, radius: 0 }, reach));
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
async function goTo(run: ProcedureRun, place: PackagePlace, arrive?: number): Promise<boolean> {
  const here = run.body.position();
  const reach = arrive ?? Math.max(AT_PLACE, place.radius);
  if (here && horizontal(here, place.position) <= reach) return true;
  return run.body.travel(place.position, run.gait, reach);
}

/**
 * Travel: to the place (within its radius); succeeds there. A place outside the loaded area
 * (in another cell or worldspace): it stays while the package runs (TODO(M10) 2.2 and 3.4:
 * the way there through doors, and actors away).
 */
const travel: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (!place) return hold(run);
  return (await goTo(run, place)) ? 'success' : 'failure';
};

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
 * Guard: to its place, facing the way its marker faces, and stays. TODO(M10) 4.1: watching for
 * those it is suspicious of (detection).
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
 * succeeds at the end. "Start at nearest": it begins at the point of the patrol nearest it.
 * TODO(M10) 3.3: the idles at idle markers on the way (their timers).
 */
const patrol: ProcedureRunner = async (run) => {
  const target = run.inputs.target(0);
  const start = target && (await run.mind.target(target, run.actor, run.context));
  if (start === undefined) return hold(run);
  const radius = run.inputs.number(1, AT_PLACE) || AT_PLACE;
  const repeatable = run.inputs.bool(2);
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
    for (; index < points.length; index++) {
      if (run.stopped()) return 'failure';
      const point = points[index];
      const at = point === undefined ? undefined : await run.mind.placement(point);
      if (!at) continue;
      if (!(await goTo(run, { position: at.position, radius }, radius))) {
        // Not reached (blocked): a moment, then on to the next.
        await run.wait(IDLE_SECONDS);
      }
    }
    if (!repeatable) return 'success';
    index = 0;
  }
};

/**
 * Follow: keeps within its maximum radius of its target, closing to the minimum when it falls
 * behind; stands, facing it, between. TODO(M10) 3.5: through doors, riding, Need LOS.
 */
const follow: ProcedureRunner = async (run) => {
  const target = run.inputs.target(0);
  const leader = target && (await run.mind.target(target, run.actor, run.context));
  if (leader === undefined) return hold(run);
  const min = Math.max(run.inputs.number(1, 128), 64);
  const max = Math.max(run.inputs.number(2, 256), min);
  while (!run.stopped()) {
    const at = await run.mind.placement(leader);
    const here = run.body.position();
    if (at && here && horizontal(here, at.position) > max) {
      await run.body.travel(at.position, 'run', min);
    } else if (at && here) {
      run.body.face(Math.atan2(at.position[0] - here[0], at.position[1] - here[1]));
      await run.wait(IDLE_SECONDS / 2);
    } else {
      await run.wait(IDLE_SECONDS);
    }
  }
  return 'failure';
};

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
 * Wander: goes from one random point of its place to another, pausing between, for as long as
 * the package runs. TODO(M13): how far and how long the engine's wander goes.
 */
const wander: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (!place) return hold(run);
  while (!run.stopped()) {
    await run.body.travel(pointIn(run, place), 'walk', 48);
    await run.wait(3 + run.random() * 6);
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
    if (!(await goTo(run, { position: at.position, radius: 0 }, ARRIVE_AT_MARKER))) return false;
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
 * timing are not documented (here: a free spot or a walk, picked at random). TODO(M10) 3.2:
 * eating (Allow Eating); 4.3: conversations (Allow Conversation).
 */
const sandbox: ProcedureRunner = async (run) => {
  const place = await placeIn(run, 0);
  if (!place) return hold(run);
  await goTo(run, place);
  const allows: Readonly<Record<SandboxSpot['kind'], boolean>> = {
    sit: run.inputs.bool(5, true),
    sleep: run.inputs.bool(2, false),
    special: run.inputs.bool(9, false),
    idle: run.inputs.bool(4, true),
  };
  const wanders = run.inputs.bool(6, true);
  const energy = Math.min(100, Math.max(0, run.inputs.number(8, 50)));
  const radius = Math.max(place.radius, AT_PLACE);
  while (!run.stopped()) {
    // An active actor (high energy) moves on sooner.
    const stay =
      (SANDBOX_STAY_MIN + (100 - energy) * SANDBOX_STAY_PER_ENERGY) * (0.5 + run.random());
    const spots = (await run.mind.around(place.position, radius, run.actor)).filter(
      (spot) => allows[spot.kind],
    );
    const choices = spots.length + (wanders && place.radius > 0 ? 1 : 0);
    const pick = Math.floor(run.random() * choices);
    const spot = spots[pick];
    if (run.stopped()) break;
    if (spot?.kind === 'idle') {
      if (!(await atIdleMarker(run, spot.reference, stay))) await run.wait(IDLE_SECONDS);
    } else if (spot) {
      if (await run.body.useFurniture(spot.reference, SPOT_MARKERS[spot.kind])) {
        await waitFor(run, stay);
        if (!run.stopped()) await run.body.leaveFurniture();
      } else {
        await run.wait(IDLE_SECONDS);
      }
    } else if (choices > 0) {
      await run.body.travel(pointIn(run, place), 'walk', 48);
      await waitFor(run, stay / 4);
    } else {
      await waitFor(run, stay / 4);
    }
  }
  return 'failure';
};

/**
 * Sit, Sleep, UseIdleMarker: uses the furniture it is given (its markers of the procedure's
 * kinds: sitting and leaning, sleeping, any) and stays in it while the package runs; at an idle
 * marker, plays its idles. Furniture it cannot use (taken, no way in): to it, facing its way.
 * TODO(M10) 3.2: furniture found by searching (ObjectList).
 */
const useFurniture =
  (types: number): ProcedureRunner =>
  async (run) => {
    // Its target, or the first it may use of those a Find found ("Found Bed", "Found Chair").
    const candidates = await targetsIn(run, 0);
    for (const reference of candidates) {
      if (run.stopped()) return 'failure';
      if (await run.body.useFurniture(reference, types)) return hold(run);
    }
    const first = candidates[0];
    if (first !== undefined && (await run.mind.idleMarker(first))) {
      await atIdleMarker(run, first);
      return run.stopped() ? 'failure' : hold(run);
    }
    if (run.stopped()) return 'failure';
    const at = first === undefined ? undefined : await run.mind.placement(first);
    if (at) {
      await goTo(run, { position: at.position, radius: 0 }, AT_PLACE);
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
 * gets a novice one) or unlocked; done at once. TODO(M10) 4.3: LockDoors' Warn Before Locking
 * (the player inside).
 */
const doors =
  (locked: boolean): ProcedureRunner =>
  async (run) => {
    const place = await placeIn(run, 0);
    if (!place) return 'failure';
    await run.mind.lockDoors(place, locked);
    return 'success';
  };

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
 * to. TODO(M11): Allow Pickpocketing; TODO(M10) 5.1: Allow Killing.
 */
const acquire: ProcedureRunner = async (run) => {
  const wanted = Math.max(1, run.inputs.number(1, 1));
  let taken = 0;
  for (const reference of await targetsIn(run, 0)) {
    if (run.stopped() || taken >= wanted) break;
    if (!(await goToReference(run, reference, REACH))) continue;
    if (await run.body.take(reference)) taken++;
  }
  return taken > 0 ? 'success' : 'failure';
};

/** Activate: goes to its target (or those its object list holds) and activates it. */
const activate: ProcedureRunner = async (run) => {
  const count = Math.max(1, run.inputs.number(1, 1));
  let done = 0;
  for (const reference of await targetsIn(run, 0)) {
    if (run.stopped() || done >= count) break;
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
 * Say: says its topic, facing its target if it should; with Finish Speaking it waits for the
 * line. TODO(M13): the line's own length (here: a few seconds); TODO(M10) 4.3: Force
 * Subtitle.
 */
const say: ProcedureRunner = async (run) => {
  const topic = run.inputs.topic(0);
  if (topic === undefined) return 'failure';
  const target = (await targetsIn(run, 1))[0];
  if (target !== undefined && run.inputs.bool(3, true)) await faceReference(run, target);
  run.body.say(topic);
  if (run.inputs.bool(2, true)) await waitFor(run, SAY_SECONDS);
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
    const reach = Math.max(trigger?.radius ?? 0, AT_PLACE);
    const inside = player && (!trigger || horizontal(player.position, trigger.position) <= reach);
    if (player && inside) {
      const here = run.body.position();
      const near = here !== undefined && horizontal(here, player.position) <= GREET_DISTANCE;
      if (near || (await run.body.travel(player.position, run.gait, GREET_DISTANCE))) {
        if (run.body.greet(typeof topic === 'number' ? topic : undefined)) return 'success';
      }
    }
    await run.wait(IDLE_SECONDS);
  }
  return 'failure';
};

/**
 * DialogueActivate: from where it talks (else beside its target), it talks to its target: the
 * player gets the conversation. TODO(M10) 4.3: conversations between actors.
 */
const dialogueActivate: ProcedureRunner = async (run) => {
  const target = (await targetsIn(run, 0))[0];
  if (target === undefined) return hold(run);
  const from = await placeIn(run, 1);
  if (from) await goTo(run, from);
  else await goToReference(run, target, GREET_DISTANCE);
  if (run.inputs.bool(2, true)) await faceReference(run, target);
  if (target === PLAYER && run.body.greet(undefined)) return 'success';
  return hold(run);
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
    !place || horizontal(place.position, at) <= Math.max(place.radius, AT_PLACE);
  while (!run.stopped()) {
    const at = await run.mind.placement(target);
    if (!at) {
      await run.wait(IDLE_SECONDS);
      continue;
    }
    if (within(area, at.position)) {
      await faceReference(run, target);
    } else if (within(pursuit, at.position)) {
      await run.body.travel(at.position, run.gait, AT_PLACE * 2);
    } else {
      return 'success';
    }
  }
  return 'failure';
};

/**
 * Escort: leads its target to the destination; where it falls behind (farther than the
 * distance to wait for followers) it stops and waits for it, facing it.
 */
const escort: ProcedureRunner = async (run) => {
  const follower = (await targetsIn(run, 0))[0];
  const destination = await placeIn(run, 2);
  if (!destination) return hold(run);
  const waitDistance = Math.max(run.inputs.number(3, 512), AT_PLACE * 2);
  const reach = Math.max(destination.radius, AT_PLACE);
  let going: Promise<boolean> | undefined;
  while (!run.stopped()) {
    const here = run.body.position();
    if (here && horizontal(here, destination.position) <= reach) return 'success';
    const at = follower === undefined ? undefined : await run.mind.placement(follower);
    if (at && here && horizontal(at.position, here) > waitDistance) {
      if (going) run.body.stop();
      going = undefined;
      run.body.face(Math.atan2(at.position[0] - here[0], at.position[1] - here[1]));
    } else if (!going) {
      run.body.face(undefined);
      going = run.body.travel(destination.position, run.gait, reach).finally(() => {
        going = undefined;
      });
    }
    await run.wait(IDLE_SECONDS);
  }
  return 'failure';
};

/** FollowTo: follows its target (between its radii) until one of them reaches the destination. */
const followTo: ProcedureRunner = async (run) => {
  const leader = (await targetsIn(run, 0))[0];
  if (leader === undefined) return hold(run);
  const destination = await placeIn(run, 1);
  const min = Math.max(run.inputs.number(2, 128), 64);
  const max = Math.max(run.inputs.number(3, 256), min);
  while (!run.stopped()) {
    const at = await run.mind.placement(leader);
    const here = run.body.position();
    const reach = Math.max(destination?.radius ?? 0, AT_PLACE);
    if (
      destination &&
      ((here && horizontal(here, destination.position) <= reach) ||
        (at && horizontal(at.position, destination.position) <= reach))
    ) {
      return 'success';
    }
    if (at && here && horizontal(here, at.position) > max) {
      await run.body.travel(at.position, 'run', min);
    } else {
      await run.wait(IDLE_SECONDS / 2);
    }
  }
  return 'failure';
};

/**
 * Flee (not in combat): runs to its flee-to place, else away from what it flees from by its
 * flee distance. TODO(M10) 5.1: Counts As Fleeing (IsFleeing), fleeing in combat.
 */
const flee: ProcedureRunner = async (run) => {
  const to = await placeIn(run, 1);
  const here = run.body.position();
  let goal: Vec3 | undefined = to?.position;
  if (!goal && here) {
    const threat = (await targetsIn(run, 0))[0];
    const from = threat === undefined ? undefined : await run.mind.placement(threat);
    const distance = Math.max(run.inputs.number(5, 1024), AT_PLACE);
    const dx = from ? here[0] - from.position[0] : 0;
    const dy = from ? here[1] - from.position[1] : 1;
    const length = Math.hypot(dx, dy) || 1;
    goal = [here[0] + (dx / length) * distance, here[1] + (dy / length) * distance, here[2]];
  }
  if (!goal) return 'failure';
  const arrived = await run.body.travel(goal, 'run', Math.max(to?.radius ?? 0, AT_PLACE));
  return arrived ? 'success' : 'failure';
};

/**
 * The procedures run, by lower-case name; the others hold the actor where it is (standing up
 * from furniture first): UseWeapon, UseMagic and Shout (TODO(M10) 5.1–5.3: combat), Hover,
 * Orbit and FlightGrab (TODO(M10) 5.3: dragons' flight).
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
  sit: useFurniture(SIT | LEAN),
  sleep: useFurniture(SLEEP),
  useidlemarker: useFurniture(SIT | SLEEP | LEAN),
  unlockdoors: doors(false),
  lockdoors: doors(true),
  find,
  acquire: standing(acquire),
  activate: standing(activate),
  eat,
  say,
  forcegreet: standing(forceGreet),
  dialogueactivate: standing(dialogueActivate),
  keepaneyeon: standing(keepAnEyeOn),
  escort: standing(escort),
  followto: standing(followTo),
  flee: standing(flee),
};
