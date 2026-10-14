import { describe, expect, it } from 'vitest';
import type { BehaviorRuntime } from './behavior-runtime.ts';
import type { ObjectGraph } from './object-graph.ts';
import { placedScriptGraph } from './script-graphs.ts';

/** A graph that knows some events and variables, and records what it is sent. */
function fakeGraph(events: string[], variables: Record<string, number>) {
  const sent: string[] = [];
  const values = new Map(Object.entries(variables));
  const graph = {
    sent,
    values,
    send: (event: string) => {
      if (!events.includes(event)) return false;
      sent.push(event);
      return true;
    },
    sendEvent: (event: string) => graph.send(event),
    variable: (name: string) => values.get(name),
    setVariable: (name: string, value: number) => {
      if (values.has(name)) values.set(name, value);
    },
  };
  return graph;
}

describe('placedScriptGraph', () => {
  it('reaches both the sequences and the skeleton of one object', () => {
    const sequences = fakeGraph(['Open'], { iState: 1 });
    const skeleton = fakeGraph(['Open', 'Trip'], { fSpeed: 2 });
    const graph = placedScriptGraph(
      sequences as unknown as ObjectGraph,
      skeleton as unknown as BehaviorRuntime,
      () => 0,
    );
    expect(graph?.send('Open')).toBe(true);
    expect(sequences.sent).toEqual(['Open']);
    expect(skeleton.sent).toEqual(['Open']);
    // An event only one of them has still counts.
    expect(graph?.send('Trip')).toBe(true);
    expect(graph?.send('Nothing')).toBe(false);
    expect(graph?.variable('iState')).toBe(1);
    expect(graph?.variable('fSpeed')).toBe(2);
    graph?.setVariable('fSpeed', 5);
    expect(skeleton.values.get('fSpeed')).toBe(5);
  });

  it('is one graph alone, or none', () => {
    const skeleton = fakeGraph(['Trip'], {});
    expect(
      placedScriptGraph(undefined, skeleton as unknown as BehaviorRuntime, () => 0)?.send('Trip'),
    ).toBe(true);
    expect(placedScriptGraph(undefined, undefined, () => 0)).toBeUndefined();
  });
});
