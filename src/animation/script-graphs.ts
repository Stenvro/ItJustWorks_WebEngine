// A reference's running behavior graphs as the scripts reach them: the events they send
// (ObjectReference.PlayAnimation), the animation variables they read and set, and the events
// the graph raises (OnAnimationEvent). Platform-independent.

import type { AnimatedSkeleton } from './animated-skeleton.ts';
import type { BehaviorGraphState, BehaviorRuntime } from './behavior-runtime.ts';
import type { ObjectGraph, ObjectGraphState } from './object-graph.ts';

/**
 * A placed object's graph as a save keeps it: the sequences' graph (ObjectGraph) and the
 * skeleton's run of it (BehaviorRuntime), each where it was moved from its start.
 */
export interface SavedGraph {
  readonly sequences?: ObjectGraphState | undefined;
  readonly skeleton?: BehaviorGraphState | undefined;
}

/** A running behavior graph as scripts use it (PlayAnimation, the animation variables). */
export interface ScriptGraph {
  /** Sends an event: false if the graph has none so named. */
  send(event: string): boolean;
  variable(name: string): number | undefined;
  setVariable(name: string, value: number): void;
  /** What a save keeps of a placed object's graph (undefined: as it started); none for actors. */
  save?(): SavedGraph | undefined;
}

/** An object's graph (sequences) for the scripts; `clock`: the renderer's, in seconds. */
export function objectScriptGraph(
  graph: ObjectGraph | undefined,
  clock: () => number,
): ScriptGraph | undefined {
  return (
    graph && {
      send: (event) => graph.send(event, clock()),
      variable: (name) => graph.variable(name),
      setVariable: (name, value) => {
        graph.setVariable(name, value);
      },
    }
  );
}

/** An actor's behavior graph (or a placed object's skeletal one) for the scripts. */
export function actorScriptGraph(behavior: BehaviorRuntime | undefined): ScriptGraph | undefined {
  return (
    behavior && {
      send: (event) => behavior.sendEvent(event),
      variable: (name) => behavior.variable(name),
      setVariable: (name, value) => {
        behavior.setVariable(name, value);
      },
    }
  );
}

/**
 * A placed object's graphs together: its model's one graph runs as the sequences it plays
 * (ObjectGraph) and, where it plays skeletal clips, as the skeleton's runtime; an event or a
 * variable reaches both, as it reaches the one graph in the game.
 */
export function placedScriptGraph(
  graph: ObjectGraph | undefined,
  skeleton: BehaviorRuntime | undefined,
  clock: () => number,
): ScriptGraph | undefined {
  const parts = [objectScriptGraph(graph, clock), actorScriptGraph(skeleton)].filter(
    (part): part is ScriptGraph => part !== undefined,
  );
  const save = (): SavedGraph | undefined => {
    const sequences = graph?.saveState();
    const skeletal = skeleton?.saveState();
    return sequences || skeletal ? { sequences, skeleton: skeletal } : undefined;
  };
  if (parts.length === 0) return undefined;
  if (parts.length === 1 && parts[0]) return { ...parts[0], save };
  return {
    send: (event) => parts.map((part) => part.send(event)).some(Boolean),
    variable: (name) => {
      for (const part of parts) {
        const value = part.variable(name);
        if (value !== undefined) return value;
      }
      return undefined;
    },
    setVariable: (name, value) => {
      for (const part of parts) part.setVariable(name, value);
    },
    save,
  };
}

/**
 * The events a placed object's skeletal graph raises reach its scripts (OnAnimationEvent), by
 * their names as the graph has them.
 */
export function skeletonEventsToScripts(
  skeleton: AnimatedSkeleton,
  send: (event: string) => void,
): void {
  const previous = skeleton.onEvents;
  skeleton.onEvents = (events) => {
    previous?.(events);
    for (const event of events) send(event.text);
  };
}
