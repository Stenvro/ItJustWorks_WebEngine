// The animation objects actors hold (ANIO: src/world/anim-object-records.ts), as the engine
// keeps them, observed in the original (docs/animation.md, "Animation objects"). One list
// for all actors, an entry per actor and object:
//
// - AnimObjLoad (its payload the object's editor id) adds an entry, unless the actor has one
//   for that object already, and starts loading its model. When the model is in, it is
//   attached to the actor's 3D as shown then (the player's first-person skeleton in first
//   person) on the node its "Prn" names, hidden unless a draw came while it loaded.
// - AnimObjDraw shows it (once attached; before, it is shown as it attaches).
// - Any event its holder's graph raises that is an object's unload event (BNAM) takes away
//   every object of that actor with that unload event (AnimObjectUnequip: all, in vanilla).
// - The actor's 3D unloading takes away all of its objects.
//
// Platform-independent: the caller loads and attaches the models (`T`, what it attached).

import type { BehaviorGenerator, BehaviorGraph } from '../formats/hkx/behavior.ts';

/** An animation object as the list needs it. */
export interface AnimObjectForm {
  readonly editorId: string;
  /** The graph event that unloads it (undefined: none). */
  readonly unloadEvent: string | undefined;
}

/** One actor's animation object. */
export interface HeldAnimObject<F extends AnimObjectForm, T> {
  readonly actor: number;
  readonly form: F;
  /** What the caller attached once the model was in (undefined: loading, or not attached). */
  attached: T | undefined;
  /** The model has come in (attached or not). */
  loaded: boolean;
  /** A draw came before the model was in: shown as it attaches. */
  drawRequested: boolean;
  /** Shown on the actor. */
  shown: boolean;
}

export class AnimObjectList<F extends AnimObjectForm, T> {
  readonly #entries: HeldAnimObject<F, T>[] = [];

  /** The objects of an actor. */
  of(actor: number): HeldAnimObject<F, T>[] {
    return this.#entries.filter((entry) => entry.actor === actor);
  }

  all(): readonly HeldAnimObject<F, T>[] {
    return this.#entries;
  }

  /**
   * AnimObjLoad: a new entry for the actor and object, whose model the caller loads now;
   * undefined if the actor has one for it already (it loads once).
   */
  load(actor: number, form: F): HeldAnimObject<F, T> | undefined {
    if (this.#entries.some((entry) => entry.actor === actor && entry.form === form)) {
      return undefined;
    }
    const entry: HeldAnimObject<F, T> = {
      actor,
      form,
      attached: undefined,
      loaded: false,
      drawRequested: false,
      shown: false,
    };
    this.#entries.push(entry);
    return entry;
  }

  /**
   * The model of an entry came in: `attached` is what the caller hung on the actor (undefined:
   * the actor had no 3D, or the model no node to hang on). Shown if a draw came meanwhile.
   * False if the entry went meanwhile (the caller drops what it attached).
   */
  loaded(entry: HeldAnimObject<F, T>, attached: T | undefined): boolean {
    if (!this.#entries.includes(entry)) return false;
    entry.loaded = true;
    entry.attached = attached;
    entry.shown = attached !== undefined && entry.drawRequested;
    return true;
  }

  /**
   * AnimObjDraw: shows the actor's object (one still loading is shown as it attaches); nothing
   * if the actor did not load it.
   */
  draw(actor: number, form: F): HeldAnimObject<F, T> | undefined {
    const entry = this.#entries.find((held) => held.actor === actor && held.form === form);
    if (!entry) return undefined;
    if (!entry.loaded) entry.drawRequested = true;
    else if (entry.attached !== undefined) entry.shown = true;
    return entry;
  }

  /**
   * An event the actor's graph raised: the actor's objects whose unload event it is go (the
   * engine compares the names as its fixed strings do, without case). Returns them.
   */
  unloadEvent(actor: number, event: string): HeldAnimObject<F, T>[] {
    if (event === '') return [];
    const key = event.toLowerCase();
    return this.#remove(
      (entry) => entry.actor === actor && entry.form.unloadEvent?.toLowerCase() === key,
    );
  }

  /** One object of an actor goes (whatever its unload event). */
  unload(actor: number, form: F): HeldAnimObject<F, T>[] {
    return this.#remove((entry) => entry.actor === actor && entry.form === form);
  }

  /** The actor's 3D went: all of its objects go. */
  unloadActor(actor: number): HeldAnimObject<F, T>[] {
    return this.#remove((entry) => entry.actor === actor);
  }

  /** Everything goes (a game loaded, the play ended). */
  clear(): HeldAnimObject<F, T>[] {
    return this.#remove(() => true);
  }

  #remove(which: (entry: HeldAnimObject<F, T>) => boolean): HeldAnimObject<F, T>[] {
    const removed: HeldAnimObject<F, T>[] = [];
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i];
      if (entry && which(entry)) {
        removed.unshift(entry);
        this.#entries.splice(i, 1);
      }
    }
    return removed;
  }
}

/** An animation object event of a graph: AnimObjLoad or AnimObjDraw with its payload. */
export interface AnimObjectEvent {
  readonly kind: 'load' | 'draw';
  /** The payload: the object's editor id. */
  readonly editorId: string;
}

/** The engine's response handlers for animation objects, by lower-case event name. */
const EVENT_KINDS: ReadonlyMap<string, 'load' | 'draw'> = new Map([
  ['animobjload', 'load'],
  ['animobjdraw', 'draw'],
]);

/** The kind of an animation object event by its name (undefined: not one). */
export function animObjectEventKind(name: string): 'load' | 'draw' | undefined {
  return EVENT_KINDS.get(name.toLowerCase());
}

/**
 * An animation object event written as one annotation of a clip, "AnimObjLoad.<EditorId>"
 * (the engine's "event.payload" form: AnimObjLoad.DecapitationHeadGore, AnimObjLoad.
 * AnimObjectSkeletonKey); undefined if the text is no such event.
 */
export function annotatedAnimObjectEvent(text: string): AnimObjectEvent | undefined {
  const dot = text.indexOf('.');
  if (dot <= 0) return undefined;
  const kind = animObjectEventKind(text.slice(0, dot));
  const editorId = text.slice(dot + 1);
  return kind && editorId !== '' ? { kind, editorId } : undefined;
}

/**
 * TEMPORARY (until the behavior runtime carries event payloads to the engine: the graph event
 * dispatch, docs/engine-map.md): where a set of behavior files raises animation object events
 * with their payloads. `states`: by state machine and state name ("machine\0state"), the
 * events its states raise as they are entered; `clips`: by lower-case animation, the events
 * the clips playing it raise at their triggers. Used to tell which object an AnimObjLoad or
 * AnimObjDraw the runtime raised (by name only) was for.
 */
export interface AnimObjectPayloads {
  readonly states: ReadonlyMap<string, readonly AnimObjectEvent[]>;
  readonly clips: ReadonlyMap<string, readonly AnimObjectEvent[]>;
}

/** The key of a state in AnimObjectPayloads.states. */
export const stateKey = (machine: string, state: string): string => `${machine}\0${state}`;

/** TEMPORARY (see AnimObjectPayloads): the animation object events of behavior files. */
export function animObjectPayloads(files: Iterable<BehaviorGraph>): AnimObjectPayloads {
  const states = new Map<string, AnimObjectEvent[]>();
  const clips = new Map<string, AnimObjectEvent[]>();
  const add = (map: Map<string, AnimObjectEvent[]>, key: string, event: AnimObjectEvent): void => {
    const list = map.get(key) ?? [];
    if (!list.some((known) => known.kind === event.kind && known.editorId === event.editorId)) {
      list.push(event);
    }
    map.set(key, list);
  };
  for (const graph of files) {
    const of = (id: number, payload: string | undefined): AnimObjectEvent | undefined => {
      const kind = animObjectEventKind(graph.events[id] ?? '');
      return kind && payload !== undefined && payload !== ''
        ? { kind, editorId: payload }
        : undefined;
    };
    const seen = new Set<object>();
    const visit = (node: BehaviorGenerator | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      switch (node.kind) {
        case 'state-machine':
          for (const state of node.states) {
            for (const notify of state.enterNotifyEvents ?? []) {
              const event = of(notify.id, notify.payload);
              if (event) add(states, stateKey(node.name, state.name), event);
            }
            visit(state.generator);
          }
          return;
        case 'clip':
          for (const trigger of node.triggers ?? []) {
            const event = of(trigger.event.id, trigger.event.payload);
            if (event) add(clips, node.animation.toLowerCase(), event);
          }
          return;
        case 'blender':
          for (const child of node.children) visit(child.generator);
          return;
        case 'manual-selector':
          for (const child of node.generators) visit(child);
          return;
        case 'bone-switch':
          visit(node.generator);
          for (const child of node.children) visit(child.generator);
          return;
        case 'offset-animation':
          visit(node.generator);
          visit(node.offsetGenerator);
          return;
        case 'modifier-generator':
        case 'state-tagging':
        case 'cyclic-blend':
        case 'synchronized-clip':
          visit(node.generator);
          return;
        default:
          return;
      }
    };
    visit(graph.root);
  }
  return { states, clips };
}
