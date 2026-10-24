// The events behavior graphs raise for the engine, and their dispatch to the engine's handlers.
//
// An event a graph raises reaches the engine as a tag and a payload: a graph event's own
// payload (hkbStringEventPayload: AnimObjLoad's animation object, StartAnimatedCamera's camera
// node), or, for an event named "Tag.payload" (a clip's annotation, SoundPlay.NPCGiantAttackStomp,
// CameraShake.0.5, AnimObjLoad.DecapitationHeadGore), the text after its first dot. Its tag picks
// the engine handler that answers it: meshes\responses\actorresponse.txt names them for every
// actor (weaponSwing : WeaponRightSwingHandler), playercharacterresponse.txt for the player
// (idleChairSitting : PlayerChairEnterHandler, the actors' list behind it). Systems implement
// handlers by their class name; events no response file names reach the systems that listen to
// all of an actor's events (footsteps, sounds, scripts, the combat state's other events).
// Notes: docs/animation.md ("Graph events"). Platform-independent.

import { animationResponse, type AnimationResponses } from '../formats/animdata/responses.ts';

/** An event a graph raised (or one sent to it). */
export interface GraphEvent {
  /** Its tag: what picks its handler (the text before the first dot of a dotted name). */
  readonly name: string;
  /** Its payload: the event's string payload, else the text after the first dot. */
  readonly payload?: string;
  /** Its name as the graph has it (scripts register for these: SoundPlay.NPCGiantAttackStomp). */
  readonly text: string;
}

/**
 * An event as the engine receives it: `text` is the graph's name of it (or a clip annotation's
 * text), `payload` its own string payload. A dotted name without a payload of its own splits
 * at its first dot into tag and payload.
 */
export function graphEvent(text: string, payload?: string): GraphEvent {
  if (payload !== undefined) return { name: text, payload, text };
  const dot = text.indexOf('.');
  if (dot <= 0) return { name: text, text };
  return { name: text.slice(0, dot), payload: text.slice(dot + 1), text };
}

/** Whether an event's tag is `name` (any case). */
export function isEvent(event: GraphEvent, name: string): boolean {
  return event.name.toLowerCase() === name.toLowerCase();
}

/** The graph that raised events: whose they are. */
export interface GraphEventSource {
  /** The actor (or object) reference. */
  readonly reference: number;
  /** The player's (the player's response list answers). */
  readonly player: boolean;
}

/** An engine handler: what it does with one event of an actor's graph. */
export type GraphEventHandler<S extends GraphEventSource> = (source: S, event: GraphEvent) => void;

/** A listener to every event of every graph the dispatch hears. */
export type GraphEventListener<S extends GraphEventSource> = (
  source: S,
  events: readonly GraphEvent[],
) => void;

/** Dispatches waiting for the response files, at most (older ones are dropped). */
const MAX_WAITING = 256;

/**
 * The engine's answer to graph events: each event's handler class by the response files (the
 * player's list for the player), and the implementations the systems registered for them.
 */
export class GraphEventDispatch<S extends GraphEventSource> {
  #actor: AnimationResponses | undefined;
  #player: AnimationResponses | undefined;
  #ready = false;
  readonly #handlers = new Map<string, GraphEventHandler<S>[]>();
  readonly #listeners: GraphEventListener<S>[] = [];
  readonly #otherwise: GraphEventHandler<S>[] = [];
  /** Handler classes a system answers from its listener, by the event's name (class → system). */
  readonly #heard = new Map<string, string>();
  /** What came before the response files were read (dispatched once they are). */
  #waiting: { source: S; events: readonly GraphEvent[] }[] = [];
  /** Handler classes events asked for that nothing implements (each once). */
  readonly #unanswered = new Set<string>();

  /**
   * The response files (actorresponse.txt; playercharacterresponse.txt, whose BackupResponse
   * falls back to the actors'). Dispatches made before are dispatched now.
   */
  setResponses(
    actor: AnimationResponses | undefined,
    player: AnimationResponses | undefined,
  ): void {
    this.#actor = actor;
    this.#player = player;
    this.#ready = true;
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const { source, events } of waiting) this.dispatch(source, events);
  }

  /** The handler class that answers an event (its tag) of the player's graph or an actor's. */
  handlerOf(event: string, player: boolean): string | undefined {
    const actor = this.#actor;
    if (!actor) return undefined;
    const own = player ? this.#player : undefined;
    if (!own) return animationResponse(event, actor);
    return animationResponse(event, own, own.backup === undefined ? undefined : actor);
  }

  /**
   * Implements an engine handler class (by its name in the response files, any case): it answers
   * every event the files map to it. A class may have several parts (each system its own).
   */
  handle(handler: string, implementation: GraphEventHandler<S>): void {
    const key = handler.toLowerCase();
    const list = this.#handlers.get(key) ?? [];
    list.push(implementation);
    this.#handlers.set(key, list);
  }

  /** Hears every event of every graph dispatched (sounds, scripts, the systems' own events). */
  listen(listener: GraphEventListener<S>): void {
    this.#listeners.push(listener);
  }

  /**
   * Answers the events the response files name no handler for (the actor's own: WeapEquip_Out,
   * blockStop), each in its turn among the handled ones.
   */
  otherwise(implementation: GraphEventHandler<S>): void {
    this.#otherwise.push(implementation);
  }

  /**
   * A handler class that a system answers from its listener (it hears every event and follows
   * these by name: the flight states, a get-up, a cart's exit), so the class needs no
   * implementation of its own.
   */
  heardBy(handler: string, system: string): void {
    this.#heard.set(handler.toLowerCase(), system);
  }

  /** Whether a handler class is answered: implemented, or heard by a system's listener. */
  answered(handler: string): boolean {
    return this.implements(handler) || this.#heard.has(handler.toLowerCase());
  }

  /** Whether a handler class has an implementation. */
  implements(handler: string): boolean {
    return this.#handlers.has(handler.toLowerCase());
  }

  /** The handler classes events asked for that have no implementation (for the audit). */
  unanswered(): string[] {
    return [...this.#unanswered];
  }

  /**
   * The events one graph raised in an update: the listeners hear them all, then each event's
   * handler (by its tag) answers it, in the order they were raised (one without a handler goes
   * to those that answer the others).
   */
  dispatch(source: S, events: readonly GraphEvent[]): void {
    if (events.length === 0) return;
    if (!this.#ready) {
      this.#waiting.push({ source, events });
      if (this.#waiting.length > MAX_WAITING) this.#waiting.shift();
      return;
    }
    for (const listener of this.#listeners) listener(source, events);
    for (const event of events) {
      if (event.name === '') continue;
      const handler = this.handlerOf(event.name, source.player);
      if (handler === undefined) {
        for (const implementation of this.#otherwise) implementation(source, event);
        continue;
      }
      const implementations = this.#handlers.get(handler.toLowerCase());
      if (!implementations) {
        if (!this.#heard.has(handler.toLowerCase())) this.#unanswered.add(handler);
        continue;
      }
      for (const implementation of implementations) implementation(source, event);
    }
  }
}
