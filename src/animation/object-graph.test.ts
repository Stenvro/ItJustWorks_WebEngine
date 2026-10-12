import { describe, expect, it } from 'vitest';
import type { BehaviorGenerator, BehaviorGraph, StateTransition } from '../formats/hkx/behavior.ts';
import { nextTextKey, ObjectGraph, type SequenceClock } from './object-graph.ts';

const leaf = (sequence: string): BehaviorGenerator => ({
  kind: 'gamebryo-sequence',
  name: sequence,
  sequence,
  blendMode: 0,
  percent: { value: 1 },
});

const on = (eventId: number, toStateId: number, flags = 0x100): StateTransition => ({
  eventId,
  toStateId,
  flags,
  priority: 0,
  conditional: false,
  duration: 0,
});

/** The generic AutoPlay graph: AutoPlay, then AutoLoop on "End"; "StopEffect" fades out. */
const autoplay: BehaviorGraph = {
  name: 'AutoplayBehavior.hkb',
  events: ['End', 'StopEffect'],
  variables: [],
  root: {
    kind: 'state-machine',
    name: 'Behavior00',
    startStateId: { value: 0 },
    startStateMode: 0,
    states: [
      {
        id: 0,
        name: 'Play',
        probability: 1,
        enable: true,
        generator: leaf('AutoPlay'),
        transitions: [on(0, 1)],
      },
      {
        id: 1,
        name: 'Loop',
        probability: 1,
        enable: true,
        generator: leaf('AutoLoop'),
        transitions: [],
      },
      {
        id: 2,
        name: 'Fade',
        probability: 1,
        enable: true,
        generator: leaf('AutoFadeOut'),
        transitions: [],
      },
    ],
    wildcardTransitions: [on(1, 2, 0x900)],
  },
};

const clock = (stop: number, cycle: number, keys: [string, number][]): SequenceClock => ({
  start: 0,
  stop,
  frequency: 1,
  cycle,
  textKeys: keys.map(([text, time]) => ({ text, time })),
});

const sequences = new Map<string, SequenceClock>([
  [
    'autoplay',
    clock(1, 2, [
      ['start', 0],
      ['end', 1],
    ]),
  ],
  [
    'autoloop',
    clock(2, 0, [
      ['start', 0],
      ['end', 2],
    ]),
  ],
  [
    'autofadeout',
    clock(0.5, 2, [
      ['start', 0],
      ['end', 0.5],
    ]),
  ],
]);

describe('object behavior graphs', () => {
  it('plays the start state, then moves on when its sequence sends "end"', () => {
    const graph = new ObjectGraph(autoplay, sequences, 10);
    expect(graph.playing).toEqual([{ sequence: 'autoplay', start: 10, weight: 1 }]);
    graph.update(10.5);
    expect(graph.playing[0]?.sequence).toBe('autoplay');
    const version = graph.version;
    graph.update(11.25);
    // The loop starts exactly when the intro ended, not at the frame that noticed it.
    expect(graph.playing).toEqual([{ sequence: 'autoloop', start: 11, weight: 1 }]);
    expect(graph.version).toBeGreaterThan(version);
    // The loop's own "end" keys lead nowhere.
    graph.update(30);
    expect(graph.playing[0]?.sequence).toBe('autoloop');
  });

  it('takes wildcard transitions on events sent by name', () => {
    const graph = new ObjectGraph(autoplay, sequences, 0);
    expect(graph.send('stopeffect', 0.25)).toBe(true);
    expect(graph.playing).toEqual([{ sequence: 'autofadeout', start: 0.25, weight: 1 }]);
    expect(graph.send('NoSuchEvent', 1)).toBe(false);
  });

  it('plays nothing for sequences the mesh does not have', () => {
    const graph = new ObjectGraph(autoplay, new Map([['autoloop', clock(2, 0, [])]]), 0);
    expect(graph.playing).toEqual([]);
  });

  it('picks random start states by probability', () => {
    const random: BehaviorGraph = {
      ...autoplay,
      root:
        autoplay.root?.kind === 'state-machine'
          ? { ...autoplay.root, startStateMode: 2 }
          : undefined,
    };
    expect(new ObjectGraph(random, sequences, 0, () => 0.1).playing[0]?.sequence).toBe('autoplay');
    expect(new ObjectGraph(random, sequences, 0, () => 0.5).playing[0]?.sequence).toBe('autoloop');
    expect(new ObjectGraph(random, sequences, 0, () => 0.9).playing[0]?.sequence).toBe(
      'autofadeout',
    );
  });

  it('weights sequence leaves by their blend mode and bound variable', () => {
    const toggle: BehaviorGraph = {
      name: 'Toggle',
      events: [],
      variables: [{ name: 'fToggleBlendDampened', type: 4, initial: 0 }],
      root: {
        kind: 'blender',
        name: 'Blend',
        flags: 0,
        blendParameter: { value: 1 },
        children: ['partA', 'partB'].map((sequence, i) => ({
          weight: { value: 1 },
          generator: {
            kind: 'gamebryo-sequence',
            name: sequence,
            sequence,
            blendMode: i + 1,
            percent: { value: 1, variable: 0 },
          },
        })),
      },
    };
    const parts = new Map([
      ['parta', clock(5, 0, [])],
      ['partb', clock(5, 0, [])],
    ]);
    // An unlit fire: partA at 0, partB (one minus percent) fully.
    expect(new ObjectGraph(toggle, parts, 0).playing).toEqual([
      { sequence: 'partb', start: 0, weight: 1 },
    ]);
  });
});

describe('text keys', () => {
  it('passes the keys of clamped sequences once', () => {
    const once = clock(1, 2, [
      ['start', 0],
      ['end', 1],
    ]);
    expect(nextTextKey(once, 5, Number.NEGATIVE_INFINITY, 5)).toEqual({ text: 'start', time: 5 });
    expect(nextTextKey(once, 5, 5, 5.5)).toBeUndefined();
    expect(nextTextKey(once, 5, 5, 9)).toEqual({ text: 'end', time: 6 });
    expect(nextTextKey(once, 5, 6, 9)).toBeUndefined();
  });

  it('passes the keys of looping sequences every cycle, and reverse ones back and forth', () => {
    const loop = clock(2, 0, [['hit', 0.5]]);
    expect(nextTextKey(loop, 0, 0.5, 10)).toEqual({ text: 'hit', time: 2.5 });
    expect(nextTextKey(loop, 0, 2.5, 4.4)).toBeUndefined();
    const reverse = clock(2, 1, [['hit', 0.5]]);
    // Forward at 0.5, backwards in the second cycle at 2 + 1.5.
    expect(nextTextKey(reverse, 0, 0.5, 10)).toEqual({ text: 'hit', time: 3.5 });
  });
});
