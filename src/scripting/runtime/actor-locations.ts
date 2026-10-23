// Where actors are, location-wise: the producer of the hub's actorLocationChange event
// (TESActorLocationChangeEvent; docs/scripting.md, "Events"). Observed in the original: an
// actor's location is looked at again whenever it is put into another cell (the player as the
// world takes them into it, an NPC as it walks across a cell's border or is moved by a script
// or its packages away from the player), and the event goes out when that location differs from
// the one before: the actor, the old location and the new (none: the wilderness). The player's
// current location is kept (GameState.playerLocation: none at a new game, so the first cell the
// player is put in with a location tells it); an NPC's is where it stands. The story manager's
// Change Location event (CLOC) is raised from the player's (story-events.ts).
// Platform-independent.

import { PLAYER_REF } from './forms.ts';
import type { Vec3 } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

/** Where a reference was before a script moved it (its game-state placement, if it had one). */
export interface PlacementSnapshot {
  readonly position: Vec3;
  readonly cell: number | undefined;
  readonly world: number | undefined;
}

interface Tracked {
  /** The cell it is in as last told (a key the world chose), if told. */
  cell: string | undefined;
  /** Its location as last known. */
  location: number | undefined;
  /** Its looks, one after another (a quick second cell waits for the first's answer). */
  chain: Promise<void>;
}

export class ActorLocations {
  readonly #runtime: ScriptRuntime;
  readonly #tracked = new Map<number, Tracked>();

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** An actor's location as last known here (the player's: the one the engine keeps). */
  known(actor: number): number | undefined {
    if (actor === PLAYER_REF) return this.#runtime.state.playerLocation;
    return this.#tracked.get(actor)?.location;
  }

  /**
   * The world tells which cell an actor is in now (every frame: the player's from the view,
   * a staged actor's from the stage; `cell` any key that differs between cells). As it
   * changes, its location is read: a new one is told. An NPC seen for the first time only
   * has its location noted; the player's is compared with the one kept.
   */
  inCell(actor: number, cell: string): void {
    const tracked = this.#tracked.get(actor);
    if (tracked?.cell === cell) return;
    const first = tracked === undefined && actor !== PLAYER_REF;
    const entry: Tracked = tracked ?? {
      cell,
      location: this.known(actor),
      chain: Promise.resolve(),
    };
    entry.cell = cell;
    this.#tracked.set(actor, entry);
    this.#then(entry, async () => {
      const now = await this.#runtime.locationOf(actor);
      if (first) entry.location = now;
      else this.#changed(actor, entry, now);
    });
  }

  /**
   * A script or the AI moved a reference (ScriptRuntime.move): an NPC's location is read from
   * where it was put (not yet where the world shows it), and told if it changed. `before`: its
   * placement before the move, for one not seen yet. The player's is told by the world as it
   * takes them there (inCell).
   */
  moved(reference: number, before: PlacementSnapshot | undefined): void {
    if (reference === PLAYER_REF) return;
    const runtime = this.#runtime;
    const tracked = this.#tracked.get(reference);
    const from =
      tracked === undefined
        ? (async () => runtime.locationAt(before ?? (await runtime.editorPlace(reference))))()
        : undefined;
    const entry: Tracked = tracked ?? {
      cell: undefined,
      location: undefined,
      chain: Promise.resolve(),
    };
    this.#tracked.set(reference, entry);
    this.#then(entry, async () => {
      if (!(await runtime.actors.isActor(reference))) {
        this.#tracked.delete(reference);
        return;
      }
      if (from) entry.location = await from;
      const now = await runtime.locationAt(await runtime.placement(reference, false));
      this.#changed(reference, entry, now);
    });
  }

  /** Forgets an actor (deleted): the next it is seen is a first sight. */
  forget(actor: number): void {
    this.#tracked.delete(actor);
  }

  #then(entry: Tracked, look: () => Promise<void>): void {
    entry.chain = entry.chain.then(look).catch((error: unknown) => {
      this.#runtime.warn(
        `actor location: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  #changed(actor: number, entry: Tracked, now: number | undefined): void {
    const before = actor === PLAYER_REF ? this.#runtime.state.playerLocation : entry.location;
    entry.location = now;
    if (actor === PLAYER_REF) this.#runtime.state.playerLocation = now;
    if (before === now) return;
    this.#runtime.events.emit('actorLocationChange', { actor, from: before, to: now });
  }
}
