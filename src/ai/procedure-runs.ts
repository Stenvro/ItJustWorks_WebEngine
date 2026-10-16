// The package procedures an actor runs (docs/ai.md, "Packages"), each reading its parameters by
// slot (src/ai/procedures.ts). How the engine runs them is not documented beyond the Creation
// Kit's names and its parameters; what they do here follows the names and parameters, and
// where the engine's own rule is not known it is marked TODO(M13). Platform-independent.

import { IdleCollectionFlag } from './idle-records.ts';
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
  if (location) return run.mind.place(location, run.actor);
  const target = run.inputs.target(slot);
  const reference = target && (await run.mind.target(target, run.actor));
  if (reference === undefined) return undefined;
  const at = await run.mind.placement(reference);
  return at && { position: at.position, radius: 0, reference, heading: at.heading };
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
  const start = target && (await run.mind.target(target, run.actor));
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
  const leader = target && (await run.mind.target(target, run.actor));
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
    const place = await placeIn(run, 0);
    if (!place) return hold(run);
    const reference = place.reference;
    if (reference !== undefined && (await run.body.useFurniture(reference, types))) {
      return hold(run);
    }
    if (reference !== undefined && (await run.mind.idleMarker(reference))) {
      await atIdleMarker(run, reference);
      return run.stopped() ? 'failure' : hold(run);
    }
    if (run.stopped()) return 'failure';
    await goTo(run, place, AT_PLACE);
    if (place.heading !== undefined) run.body.face(place.heading);
    return hold(run);
  };

/** A procedure that does not use furniture: the actor gets up first. */
const standing =
  (runner: ProcedureRunner): ProcedureRunner =>
  async (run) => {
    await run.body.leaveFurniture();
    return run.stopped() ? 'failure' : runner(run);
  };

/** UnlockDoors, LockDoors: done at once. TODO(M10) 3.2: the doors of its place locked. */
const doors: ProcedureRunner = () => Promise.resolve('success');

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
  sit: useFurniture(SIT | LEAN),
  sleep: useFurniture(SLEEP),
  useidlemarker: useFurniture(SIT | SLEEP | LEAN),
  unlockdoors: doors,
  lockdoors: doors,
};
