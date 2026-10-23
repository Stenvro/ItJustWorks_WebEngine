// Actors away (docs/ai.md, "Actors away"; docs/m10-plan.md, 3.4): the low process. Actors that
// are not in the loaded area still keep their schedules: as the game's hour changes, those of
// the player's space and of the cells one door from it are asked where their packages have
// them (src/ai/package-start.ts, its look resolved but no 3D made); one that should be
// elsewhere sets out along its route (src/ai/routes.ts) and walks it, unseen, at its walking
// speed: through each load door to the other side, until it reaches its place or comes into
// the loaded area (a door into a loaded cell, a loaded cell of a worldspace it walks across),
// where it appears and its AI goes on. An actor walking out of the loaded area through a load
// door goes on the same way. Where the game's time jumps (waiting, sleeping, fast travel) or
// the player comes into another space, actors are put where their packages have them at once.
// TODO(M13): the engine's own rules for the low process (how often, how far round, its speed).

import type { PackageStart, Space } from '../ai/package-start.ts';
import { MovementCatalog } from '../ai/movement-types.ts';
import {
  findRoute,
  polylineLength,
  type Route,
  type RouteDoor,
  type RouteEnd,
  type RouteMap,
} from '../ai/routes.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { linkedReferences, parseReference } from '../world/cell-records.ts';
import type { CellActor } from '../world/cell-loader.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import type { ActorDoors } from './actor-doors.ts';
import type { ActorPlacer } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Where something is: its space and its position there. */
export interface AwayPlace {
  readonly space: Space;
  readonly position: Vec3;
  readonly heading?: number;
}

export interface ActorsAwayOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  /** Whether a place is in a loaded cell of the view (an actor there is on the stage). */
  readonly loaded: (place: AwayPlace) => boolean;
  /** Whether an actor is on the stage now (its AI is the high process's). */
  readonly staged: (actor: number) => boolean;
  /** The doors actors go through: locked load doors, those of the loaded area swinging. */
  readonly doors?: ActorDoors;
}

/** A stretch of a trip: points in one space, ending at a load door (or at the place). */
interface Leg {
  readonly space: Space;
  readonly points: readonly Vec3[];
  readonly length: number;
  readonly door: RouteDoor | undefined;
}

/** A run of the schedules: how many actors it asked and sent or put elsewhere, how long. */
interface ScheduleRun {
  readonly mode: 'jump' | 'walk';
  readonly actors: number;
  moved: number;
  seconds: number;
}

/** An actor on its way while away. */
interface Trip {
  readonly destination: AwayPlace;
  readonly speed: number;
  legs: readonly Leg[] | undefined;
  leg: number;
  /** How far along its leg it is (units). */
  along: number;
  /** Its route is being searched (or its move made): it waits. */
  busy: boolean;
}

/** An actor counts as at its place within this of it (units). */
const AT_PLACE = 256;
/** Actors walk at this speed where no movement type gives one (units per second). */
const WALK_SPEED = 90;
/** The game's time jumped where it ran this many game seconds more than real time allows. */
const SKIP_SECONDS = 600;
/** Actors asked at once by a run of the schedules. */
const SCHEDULE_PARALLEL = 16;
/**
 * How long a run of the schedules works before it lets a frame be drawn (ms): asking a
 * worldspace's actors where their packages have them is a long run of cached reads and
 * conditions (docs/ai.md, "Actors away").
 */
const SCHEDULE_SLICE_MS = 4;
/** The size of an exterior cell (units). */
const CELL_SIZE = 4096;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sameSpace = (a: Space, b: Space): boolean =>
  a.kind === 'world'
    ? b.kind === 'world' && a.world === b.world
    : b.kind === 'interior' && a.cell === b.cell;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class ActorsAway {
  readonly #options: ActorsAwayOptions;
  readonly #trips = new Map<number, Trip>();
  /** The plugins' actor references of each cell asked about (#candidates). */
  readonly #cellActors = new Map<number, readonly number[]>();
  #walkSpeed: number | undefined;
  #hour: number | undefined;
  #playerSpace: string | undefined;
  #gameSeconds: number | undefined;
  #scheduling = false;
  /** Real seconds since the player's space was last looked at. */
  #sincePlayer = Infinity;
  #pending: 'jump' | 'walk' | undefined;
  #lastRun: ScheduleRun | undefined;

  constructor(options: ActorsAwayOptions) {
    this.#options = options;
  }

  /** The actors on their way while away (development checks). */
  get trips(): ReadonlyMap<number, { readonly destination: AwayPlace; readonly leg: number }> {
    return this.#trips;
  }

  /**
   * An actor sets out for a place it cannot walk to in the loaded area (another cell or
   * worldspace), from where it is now (`from`: where it stepped out through a load door).
   */
  depart(actor: number, from: AwayPlace, destination: AwayPlace): void {
    const trip: Trip = {
      destination,
      speed: this.#walkSpeed ?? WALK_SPEED,
      legs: undefined,
      leg: 0,
      along: 0,
      busy: true,
    };
    this.#trips.set(actor, trip);
    void this.#plan(actor, trip, from);
  }

  /** Whether schedules are being asked now, and the last run (development checks). */
  get scheduling(): { readonly busy: boolean; readonly last: ScheduleRun | undefined } {
    return { busy: this.#scheduling, last: this.#lastRun };
  }

  /** The actor came onto the stage (or left the game): its trip is the high process's now. */
  arrived(actor: number): void {
    this.#trips.delete(actor);
  }

  /** Every frame (real seconds): trips walk on; schedules are asked again when it is time. */
  frame(seconds: number): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    this.#watchTime(seconds);
    for (const [actor, trip] of this.#trips) {
      if (trip.busy || !trip.legs) continue;
      if (this.#options.staged(actor)) {
        this.#trips.delete(actor);
        continue;
      }
      this.#walk(runtime, actor, trip, seconds);
    }
  }

  /** The hour, the player's space and jumps of the game's time: when schedules are asked. */
  #watchTime(seconds: number): void {
    const session = this.#options.session;
    const time = session.gameTime();
    // Whole days passed, and the hour of this one.
    const gameSeconds = session.gameDaysPassed * 86400 + time.hour * 3600;
    const previous = this.#gameSeconds;
    this.#gameSeconds = gameSeconds;
    const hour = Math.floor(time.hour);
    // The game's clock runs `timescale` times real time; much more than that is a jump.
    const timescale = session.scriptsReady?.timeScale ?? 20;
    const jumped =
      previous !== undefined && gameSeconds - previous > seconds * timescale + SKIP_SECONDS;
    if (jumped) {
      this.#finishAll();
      this.#ask('jump');
    } else if (this.#hour !== undefined && hour !== this.#hour) {
      this.#ask('walk');
    }
    this.#hour = hour;
    this.#sincePlayer += seconds;
    if (this.#sincePlayer >= 1) {
      this.#sincePlayer = 0;
      void this.#watchPlayer();
    }
  }

  /** The player came into another space: what is there now is put where it should be. */
  async #watchPlayer(): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const at = await runtime?.placement(PLAYER_REF);
    if (!at) return;
    const key = at.world !== undefined ? `w${String(at.world)}` : `c${String(at.cell)}`;
    if (key === this.#playerSpace) return;
    this.#playerSpace = key;
    this.#ask('jump');
  }

  /** Schedules are asked (one run at a time; a jump outranks a walk). */
  #ask(mode: 'jump' | 'walk'): void {
    if (this.#scheduling) {
      if (this.#pending !== 'jump') this.#pending = mode;
      return;
    }
    this.#scheduling = true;
    void this.#schedule(mode)
      .catch((error: unknown) => {
        this.#options.terminal.log('actor', `actors away: ${describe(error)}`, 'warn');
      })
      .finally(() => {
        this.#scheduling = false;
        const next = this.#pending;
        this.#pending = undefined;
        if (next) this.#ask(next);
      });
  }

  /** Every trip ends at once: each actor is at its place (the game's time jumped). */
  #finishAll(): void {
    const runtime = this.#options.session.scriptsReady;
    for (const [actor, trip] of this.#trips) {
      this.#trips.delete(actor);
      if (runtime) void this.#moveTo(runtime, actor, trip.destination);
    }
  }

  /**
   * Where the actors of the player's space and of the cells one door from it should be now:
   * `jump` puts them there at once, `walk` sends those that should be elsewhere on their way.
   */
  async #schedule(mode: 'jump' | 'walk'): Promise<void> {
    const session = this.#options.session;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const [routes, placer, db] = await Promise.all([
      session.routeMap(),
      session.actors(),
      session.db,
    ]);
    this.#walkSpeed ??= await MovementCatalog.read(db).then(
      (catalog) => catalog.default('walk')?.walk.forward ?? WALK_SPEED,
      () => WALK_SPEED,
    );
    const player = await runtime.placement(PLAYER_REF);
    if (!player) return;
    const here = spaceOf(player);
    const spaces = [here, ...spacesNextTo(routes, here)];
    const begun = performance.now();
    const candidates = await this.#candidates(runtime, spaces);
    const run: ScheduleRun = { mode, actors: candidates.length, moved: 0, seconds: 0 };
    // Several at once: each waits on its records more than it works.
    const queue = [...candidates];
    const scheduler = runtime.vm.scheduler;
    let since = scheduler.now();
    const next = async (): Promise<void> => {
      for (let actor = queue.pop(); actor !== undefined; actor = queue.pop()) {
        since = await scheduler.giveWay(since, SCHEDULE_SLICE_MS);
        if (await this.#scheduleActor(runtime, placer, actor, mode)) run.moved++;
      }
    };
    await Promise.all(Array.from({ length: SCHEDULE_PARALLEL }, next));
    run.seconds = (performance.now() - begun) / 1000;
    this.#lastRun = run;
  }

  /** One actor asked where it should be, sent or put there; whether it was. */
  async #scheduleActor(
    runtime: ScriptRuntime,
    placer: ActorPlacer,
    actor: number,
    mode: 'jump' | 'walk',
  ): Promise<boolean> {
    if (this.#options.staged(actor) || (mode === 'walk' && this.#trips.has(actor))) return false;
    const now = await runtime.placement(actor, false);
    const record = await runtime.forms.record(actor);
    if (!now || record?.type !== 'ACHR') return false;
    const current: AwayPlace = { space: spaceOf(now), position: now.position };
    const placed = cellActor(record, now.position, now.rotation[2]);
    const start = await placer.whereNow(placed, current.space).catch(() => undefined);
    const destination = start && (await this.#destination(runtime, actor, start, current));
    if (!destination) return false;
    if (
      sameSpace(destination.space, current.space) &&
      distance(destination.position, current.position) <= AT_PLACE
    ) {
      return false;
    }
    // It came onto the stage meanwhile: the high process has it.
    if (this.#options.staged(actor)) return false;
    if (mode === 'jump') {
      this.#trips.delete(actor);
      await this.#moveTo(runtime, actor, destination);
    } else {
      this.depart(actor, current, destination);
    }
    return true;
  }

  /** Where a package start puts an actor that is away (undefined: where it is, or not known). */
  async #destination(
    runtime: ScriptRuntime,
    actor: number,
    start: PackageStart,
    current: AwayPlace,
  ): Promise<AwayPlace | undefined> {
    const at = async (reference: number): Promise<AwayPlace | undefined> => {
      const placement = await runtime.placement(reference, false);
      return (
        placement && {
          space: spaceOf(placement),
          position: placement.position,
          heading: placement.rotation[2],
        }
      );
    };
    if (start.kind === 'at') return at(start.reference);
    if (start.kind === 'elsewhere')
      return start.reference === undefined ? undefined : at(start.reference);
    if (start.kind === 'here' && start.editor === true) {
      // Back to its editor location (its home), if it is away from it.
      const editor = await runtime.editorPlacement(actor);
      const cell = runtime.forms.db.cellOfReference(actor);
      if (!editor || cell === undefined) return undefined;
      const world = runtime.forms.db.worldOfCell(cell);
      const space: Space =
        world === undefined ? { kind: 'interior', cell } : { kind: 'world', world };
      return sameSpace(space, current.space) &&
        distance(editor.position, current.position) <= AT_PLACE * 4
        ? undefined
        : { space, position: editor.position, heading: editor.rotation[2] };
    }
    return undefined;
  }

  /**
   * The actors to ask: those placed in the spaces (an interior's actors, a worldspace's
   * persistent ones) and those the low process or scripts left there, living and enabled.
   */
  async #candidates(runtime: ScriptRuntime, spaces: readonly Space[]): Promise<number[]> {
    const db = runtime.forms.db;
    const found = new Set<number>();
    for (const space of spaces) {
      const cell = space.kind === 'interior' ? space.cell : db.persistentCell(space.world);
      if (cell === undefined) continue;
      // The plugins' actors of a cell, found once: a worldspace's persistent cell has tens of
      // thousands of references, looked through in 200 ms as each schedule ran.
      let actors = this.#cellActors.get(cell);
      if (!actors) {
        actors = db.cellReferences(cell).filter((reference) => {
          const location = db.locate(reference);
          return location !== undefined && db.typeAt(location) === 'ACHR';
        });
        this.#cellActors.set(cell, actors);
      }
      for (const reference of actors) found.add(reference);
    }
    for (const [reference, state] of runtime.state.references) {
      if (!state.position || reference === PLAYER_REF) continue;
      const space: Space =
        state.world !== undefined
          ? { kind: 'world', world: state.world }
          : { kind: 'interior', cell: state.cell ?? 0 };
      if (spaces.some((other) => sameSpace(other, space))) found.add(reference);
    }
    const living: number[] = [];
    let since = runtime.vm.scheduler.now();
    for (const reference of found) {
      since = await runtime.vm.scheduler.giveWay(since, SCHEDULE_SLICE_MS);
      if (runtime.state.actors.get(reference)?.dead === true) continue;
      if (!(await runtime.isEnabled(reference))) continue;
      living.push(reference);
    }
    return living;
  }

  /** A trip's legs: its route's doors, the roads it walks between them. */
  async #plan(actor: number, trip: Trip, from: AwayPlace): Promise<void> {
    try {
      const routes = await this.#options.session.routeMap();
      const start = routes.nearestNavmesh(from.space, from.position);
      const end = routes.nearestNavmesh(trip.destination.space, trip.destination.position);
      const route =
        start === undefined || end === undefined
          ? undefined
          : await this.#route(
              routes,
              { space: from.space, position: from.position, navmesh: start },
              { ...trip.destination, navmesh: end },
              actor,
            );
      if (this.#trips.get(actor) !== trip) return;
      if (!route) {
        // No way there over the navmeshes: it gets there all the same, at once.
        this.#trips.delete(actor);
        const runtime = this.#options.session.scriptsReady;
        if (runtime) await this.#moveTo(runtime, actor, trip.destination);
        return;
      }
      const legs: Leg[] = [];
      let space = from.space;
      let at = from.position;
      const leg = (to: Vec3, door: RouteDoor | undefined): void => {
        const points = routes.roadPoints(space, at, to) ?? [at, to];
        legs.push({ space, points, length: polylineLength(points), door });
      };
      for (const door of route.doors) {
        leg(door.position, door);
        space = door.arrivalSpace;
        at = door.arrival;
      }
      leg(trip.destination.position, undefined);
      trip.legs = legs;
    } finally {
      trip.busy = false;
    }
  }

  /** A trip walks on: through its doors; it appears where it comes into the loaded area. */
  #walk(runtime: ScriptRuntime, actor: number, trip: Trip, seconds: number): void {
    const legs = trip.legs ?? [];
    trip.along += trip.speed * seconds;
    for (let leg = legs[trip.leg]; leg; leg = legs[trip.leg]) {
      const point = pointAlong(leg.points, Math.min(trip.along, leg.length));
      if (this.#options.loaded({ space: leg.space, position: point })) {
        // It walked into a loaded cell: it shows from here, its AI going on.
        this.#trips.delete(actor);
        void this.#moveTo(runtime, actor, { space: leg.space, position: point });
        return;
      }
      if (trip.along < leg.length) return;
      trip.along -= leg.length;
      trip.leg++;
      const door = leg.door;
      if (!door) {
        // At its place.
        this.#trips.delete(actor);
        void this.#moveTo(runtime, actor, trip.destination);
        return;
      }
      const arrival: AwayPlace = {
        space: door.arrivalSpace,
        position: door.arrival,
        heading: door.arrivalHeading,
      };
      if (this.#options.loaded(arrival)) {
        // Through a door into the loaded area: it comes out of it there (the door swings).
        this.#trips.delete(actor);
        this.#options.doors?.arrive(door.destination, actor);
        void this.#moveTo(runtime, actor, arrival);
        return;
      }
      // Through a door: the game state has it in the space it came into (a script asking for
      // its cell or worldspace gets that one). TODO(M13): its place along the way between.
      void this.#moveTo(runtime, actor, arrival);
    }
  }

  /** A route through the load doors an actor may pass (locked ones it may open). */
  #route(map: RouteMap, from: RouteEnd, to: RouteEnd, actor: number): Promise<Route | undefined> {
    const doors = this.#options.doors;
    return doors ? doors.route(map, from, to, actor) : Promise.resolve(findRoute(map, from, to));
  }

  /** Puts an actor at a place (the game state; the views show it if they hold the place). */
  async place(actor: number, place: AwayPlace): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (runtime) await this.#moveTo(runtime, actor, place);
  }

  async #moveTo(runtime: ScriptRuntime, actor: number, place: AwayPlace): Promise<void> {
    const { space, position } = place;
    let cell: number | undefined;
    let world: number | undefined;
    if (space.kind === 'interior') {
      cell = space.cell;
    } else {
      world = space.world;
      cell = await runtime.forms.db.exteriorCell(
        world,
        Math.floor(position[0] / CELL_SIZE),
        Math.floor(position[1] / CELL_SIZE),
      );
      // A worldspace's cell no plugin has: the persistent cell holds it.
      cell ??= runtime.forms.db.persistentCell(world);
    }
    runtime.move(actor, [...position], [0, 0, place.heading ?? 0], cell, world);
  }
}

/** The space of a placement: its worldspace, or its interior cell. */
export function spaceOf(placement: {
  readonly cell: number | undefined;
  readonly world: number | undefined;
}): Space {
  return placement.world !== undefined
    ? { kind: 'world', world: placement.world }
    : { kind: 'interior', cell: placement.cell ?? 0 };
}

/** The spaces one load door from a space. */
function spacesNextTo(routes: RouteMap, space: Space): Space[] {
  const found: Space[] = [];
  for (const door of routes.doorsInSpace(space)) {
    if (!found.some((other) => sameSpace(other, door.arrivalSpace))) found.push(door.arrivalSpace);
  }
  return found;
}

/** The point a distance along a line through points. */
function pointAlong(points: readonly Vec3[], along: number): Vec3 {
  let left = along;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const length = distance(a, b);
    if (left <= length) {
      const t = length > 0 ? left / length : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    left -= length;
  }
  return points[points.length - 1] ?? [0, 0, 0];
}

/** A placed actor's reference as a cell gives it, where it is now. */
function cellActor(
  record: { readonly flags: number } & Parameters<typeof parseReference>[0],
  position: Vec3,
  heading: number,
): CellActor {
  const placed = parseReference(record);
  return {
    reference: placed.formId,
    editorId: placed.editorId,
    base: placed.base,
    position: [...position],
    rotation: [0, 0, heading],
    scale: placed.scale,
    links: linkedReferences(record),
    startsDead: (record.flags & RecordFlag.startsDead) !== 0,
  };
}
