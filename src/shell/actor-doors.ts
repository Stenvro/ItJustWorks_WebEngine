// The doors actors go through (docs/ai.md, "Paths"). A door on an actor's way opens as it comes
// near (its open sequence and sound) and stays open while actors come to it, shutting a few
// seconds after the last (its close sequence and sound); a door the player opened stays as it
// is. One still opening holds the actor before it. A locked door opens to an actor that carries
// its key or owns its lock, or whose package unlocks the doors on its way (it is unlocked then);
// to the others it is shut: their way is blocked there and they search again round it,
// remembering it a while. Load doors swing open with their sound as an actor steps through
// (it leaves the game's fTeleportDoorActivateDelayTimer later) and as one comes out of the door
// on the other side. A door a script opens or shuts (SetOpen) swings so and stays.

import type { DoorPassage } from '../ai/path-follower.ts';
import { findRoute, type Route, type RouteEnd, type RouteMap } from '../ai/routes.ts';
import type { Vec3 } from '../render/math.ts';
import type { ModelInstance } from '../render/scene-renderer.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { GameSession } from './game-session.ts';
import { clock } from './object-graphs.ts';

/** A placed door of the loaded area and its instance (its sequences). */
export interface DoorObject {
  readonly object: CellObject;
  readonly instance: ModelInstance | undefined;
}

export interface ActorDoorsOptions {
  readonly session: GameSession;
  /** A door of the loaded area by its reference (undefined: not loaded). */
  readonly find: (reference: number) => DoorObject | undefined;
  /** Whether the package an actor runs now unlocks the doors on its way. */
  readonly unlocks?: (actor: number) => boolean;
}

/** A door actors opened shuts this long after the last came to it (seconds). TODO(M13). */
const CLOSE_AFTER = 3;
/** An open sequence's length where the model has none (seconds). */
const OPEN_SECONDS = 1;
/** Whether an actor may open a locked door, and that a door was shut to it, hold this long (ms). */
const REMEMBER_MS = 30_000;
/** The vanilla fTeleportDoorActivateDelayTimer (seconds). */
const TELEPORT_DELAY = 0.6;
/** A route is searched again round load doors locked to the actor this many times at most. */
const ROUTE_TRIES = 8;

export class ActorDoors {
  readonly #options: ActorDoorsOptions;
  /** Doors actors opened: the timer that shuts each. */
  readonly #closing = new Map<number, ReturnType<typeof setTimeout>>();
  /** Whether an actor may open a locked door (undefined: being asked), by `actor:door`. */
  readonly #access = new Map<string, { allowed: boolean | undefined; readonly at: number }>();
  /** The doors shut to each actor, and when each was found shut. */
  readonly #shut = new Map<number, Map<number, number>>();
  #teleportDelay: number | undefined;

  constructor(options: ActorDoorsOptions) {
    this.#options = options;
  }

  /**
   * A door on an actor's way as it comes near (asked every step until it is through): opened if
   * the actor may open it. 'opening' until its open sequence has played (or while whether the
   * actor may open its lock is asked), 'shut' if it is locked to it. Undefined: not a door of the
   * loaded area.
   */
  passage(door: number, actor: number): DoorPassage | undefined {
    const entry = this.#options.find(door);
    if (entry?.object.baseType !== 'DOOR') return undefined;
    // Load doors are the AI's to take (through).
    if (entry.object.teleport) return 'open';
    const playback = entry.instance?.playback;
    // Opened by the player (no actor's timer on it): it stays open.
    if (playback?.sequence === 'open' && !this.#closing.has(door)) return 'open';
    if (this.#options.session.hud.uses?.lockOf(entry.object) !== undefined) {
      const allowed = this.#allowed(actor, door);
      if (allowed === undefined) return 'opening';
      if (!allowed) {
        this.#remember(actor, door);
        return 'shut';
      }
      // A package that unlocks the doors on its way leaves this one unlocked.
      if (this.#options.unlocks?.(actor) === true) {
        void this.#options.session.scriptsReady?.setLocked(door, false);
      }
    }
    return this.#open(door, entry);
  }

  /** The doors found shut to an actor lately (its paths keep off them). */
  shutTo(actor: number): ReadonlySet<number> {
    const doors = this.#shut.get(actor);
    if (!doors) return new Set();
    const now = performance.now();
    for (const [door, at] of doors) if (now - at > REMEMBER_MS) doors.delete(door);
    return new Set(doors.keys());
  }

  /** Where the doors found shut to an actor lately stand (its paths keep off them). */
  shutPlaces(actor: number): { readonly at: Vec3; readonly radius: number }[] {
    const places: { at: Vec3; radius: number }[] = [];
    for (const door of this.shutTo(actor)) {
      const world = this.#options.find(door)?.object.world;
      if (world) places.push({ at: [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0], radius: 64 });
    }
    return places;
  }

  /**
   * Whether an actor may go through a load door: unlocked, or it may open its lock (its key, its
   * owner, its package).
   */
  async mayPass(door: number, actor: number): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || !(await runtime.lock(door)).locked) return true;
    if (this.#options.unlocks?.(actor) === true) return true;
    return runtime.mayUnlock(actor, door);
  }

  /**
   * A route for an actor (src/ai/routes.ts) through the load doors it may pass: one on it that
   * is locked to the actor is left out and the route searched again.
   */
  async route(
    map: RouteMap,
    from: RouteEnd,
    to: RouteEnd,
    actor: number,
  ): Promise<Route | undefined> {
    const closed = new Set(this.shutTo(actor));
    for (let tries = 0; tries < ROUTE_TRIES; tries++) {
      const route = findRoute(map, from, to, closed);
      if (!route) return undefined;
      let shut: number | undefined;
      for (const step of route.doors) {
        if (await this.mayPass(step.door, actor)) continue;
        shut = step.door;
        break;
      }
      if (shut === undefined) return route;
      closed.add(shut);
      this.#remember(actor, shut);
    }
    return undefined;
  }

  /**
   * An actor steps through a load door of the loaded area: it swings open with its sound (and
   * shuts after); resolves once the actor is through (fTeleportDoorActivateDelayTimer).
   */
  async through(door: number): Promise<void> {
    const entry = this.#options.find(door);
    if (entry) this.#swing(door, entry);
    const delay = await this.#delay();
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
  }

  /** An actor comes out of a load door of the loaded area: it swings open and shuts behind. */
  arrive(door: number): void {
    const entry = this.#options.find(door);
    if (entry) this.#swing(door, entry);
  }

  /**
   * A script opened or shut a door (ObjectReference.SetOpen): it swings with its sound, and it
   * stays as the script left it (no actor's timer shuts it); one already so does nothing.
   */
  setOpen(door: number, open: boolean): void {
    const entry = this.#options.find(door);
    const playback = entry?.instance?.playback;
    if (!entry || entry.object.teleport) return;
    clearTimeout(this.#closing.get(door));
    this.#closing.delete(door);
    const sequence = open ? 'open' : 'close';
    if (!playback || (playback.sequence ?? 'close') === sequence) return;
    this.#play(entry, sequence);
    playback.sequence = sequence;
    playback.start = clock();
  }

  /** A door opens (if shut) and shuts CLOSE_AFTER after the last actor came: open yet? */
  #open(door: number, entry: DoorObject): DoorPassage {
    const playback = entry.instance?.playback;
    // A door without sequences has nothing to open.
    if (!playback) return 'open';
    if (playback.sequence !== 'open') {
      this.#play(entry, 'open');
      playback.sequence = 'open';
      playback.start = clock();
    }
    clearTimeout(this.#closing.get(door));
    this.#closing.set(
      door,
      setTimeout(() => {
        this.#closing.delete(door);
        if (playback.sequence !== 'open') return;
        this.#play(entry, 'close');
        playback.sequence = 'close';
        playback.start = clock();
      }, CLOSE_AFTER * 1000),
    );
    const length = entry.instance.model.sequences?.byName.get('open')?.duration ?? OPEN_SECONDS;
    return clock() - playback.start >= length ? 'open' : 'opening';
  }

  /** A load door swings open and shut (its sounds; its sequences, if it has them). */
  #swing(door: number, entry: DoorObject): void {
    if (entry.instance?.playback) {
      this.#open(door, entry);
      return;
    }
    this.#play(entry, 'open');
  }

  #play(entry: DoorObject, sound: 'open' | 'close'): void {
    const descriptor = entry.object.sounds?.[sound];
    if (descriptor === undefined) return;
    const world = entry.object.world;
    const at: Vec3 = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    void this.#options.session.soundSystem?.play(descriptor, at);
  }

  /** Whether an actor may open a locked door: asked once a while (undefined meanwhile). */
  #allowed(actor: number, door: number): boolean | undefined {
    const key = `${String(actor)}:${String(door)}`;
    const known = this.#access.get(key);
    if (known && performance.now() - known.at < REMEMBER_MS) return known.allowed;
    const asked: { allowed: boolean | undefined; readonly at: number } = {
      allowed: undefined,
      at: performance.now(),
    };
    this.#access.set(key, asked);
    void this.mayPass(door, actor).then(
      (allowed) => {
        asked.allowed = allowed;
      },
      () => {
        asked.allowed = false;
      },
    );
    return undefined;
  }

  #remember(actor: number, door: number): void {
    let doors = this.#shut.get(actor);
    if (!doors) {
      doors = new Map();
      this.#shut.set(actor, doors);
    }
    doors.set(door, performance.now());
  }

  async #delay(): Promise<number> {
    this.#teleportDelay ??= await this.#options.session.settings().then(
      (settings) => settings.number('fTeleportDoorActivateDelayTimer') ?? TELEPORT_DELAY,
      () => TELEPORT_DELAY,
    );
    return this.#teleportDelay;
  }
}
