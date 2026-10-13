import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxAnimation, HkxSkeleton } from '../formats/hkx/animation.ts';
import type {
  BehaviorGenerator,
  BehaviorGraph,
  BehaviorModifier,
  StateTransition,
} from '../formats/hkx/behavior.ts';
import { BehaviorRuntime, type BehaviorHost } from './behavior-runtime.ts';

/** One bone; a clip moves it along x to `x` (or by time with `speed`). */
const skeleton: HkxSkeleton = {
  name: 'Root',
  bones: [{ name: 'Root', lockTranslation: false }],
  parents: Int16Array.of(-1),
  referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};

function animation(
  x: number,
  duration = 1,
  annotations: { time: number; text: string }[] = [],
): AnimationBinding {
  const clip: HkxAnimation = {
    duration,
    trackCount: 1,
    floatTrackCount: 0,
    annotations,
    motion: undefined,
    sample: (time, out) => {
      out.set([x + time, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    },
  };
  return {
    skeletonName: 'Root',
    animation: clip,
    trackToBone: undefined,
    floatTrackToSlot: undefined,
    additive: false,
  };
}

const clip = (name: string, mode = 1): BehaviorGenerator => ({
  kind: 'clip',
  name,
  animation: name,
  mode,
  playbackSpeed: 1,
});

const transition = (
  eventId: number,
  toStateId: number,
  extra: Partial<StateTransition> = {},
): StateTransition => ({
  eventId,
  toStateId,
  flags: 0,
  priority: 0,
  conditional: extra.condition !== undefined,
  duration: 0,
  ...extra,
});

const host = (clips: Record<string, AnimationBinding>): BehaviorHost => ({
  clip: (name) => clips[name],
  behavior: () => undefined,
});

const graph = (
  root: BehaviorGenerator,
  events: string[],
  variables: { name: string; initial: number }[] = [],
): BehaviorGraph => ({
  name: 'test',
  events,
  variables: variables.map((variable) => ({ ...variable, type: 4 })),
  root,
});

describe('the behavior runtime', () => {
  it('starts in the start state and blends into another on its event', () => {
    const machine: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Machine',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'Idle',
          probability: 1,
          enable: true,
          generator: clip('idle'),
          transitions: [
            transition(0, 1, {
              duration: 1,
              effect: {
                duration: 1,
                toGeneratorStartTimeFraction: 0,
                flags: 0,
                endMode: 0,
                blendCurve: 1,
                selfTransitionMode: 0,
                eventMode: 0,
              },
            }),
          ],
          exitNotifyEvents: [{ id: 1 }],
        },
        {
          id: 1,
          name: 'Walk',
          probability: 1,
          enable: true,
          generator: clip('walk'),
          transitions: [],
        },
      ],
      wildcardTransitions: [],
    };
    const runtime = new BehaviorRuntime({
      root: graph(machine, ['moveStart', 'idleExit']),
      host: host({ idle: animation(0, 10), walk: animation(100, 10) }),
      skeleton,
    });
    runtime.update(0);
    expect(runtime.states()).toEqual([{ machine: 'Machine', state: 'Idle' }]);
    expect(runtime.pose[0]).toBeCloseTo(0);
    runtime.sendEvent('MoveStart');
    runtime.update(0.5);
    // Halfway through the linear blend: idle at 0.5, walk at 100.5 (started late by 0).
    expect(runtime.states()).toEqual([{ machine: 'Machine', state: 'Walk' }]);
    expect(runtime.pose[0]).toBeCloseTo(50.5, 0);
    expect(runtime.takeRaised()).toEqual(['idleExit']);
    runtime.update(0.6);
    expect(runtime.pose[0]).toBeCloseTo(101.1);
  });

  it('takes transitions without an event once their condition holds', () => {
    const machine: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Machine',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'A',
          probability: 1,
          enable: true,
          generator: clip('a'),
          transitions: [transition(-1, 1, { condition: 'Speed > 100' })],
        },
        { id: 1, name: 'B', probability: 1, enable: true, generator: clip('b'), transitions: [] },
      ],
      wildcardTransitions: [],
    };
    const runtime = new BehaviorRuntime({
      root: graph(machine, [], [{ name: 'Speed', initial: 0 }]),
      host: host({ a: animation(0), b: animation(5) }),
      skeleton,
    });
    runtime.update(0.1);
    expect(runtime.states()[0]?.state).toBe('A');
    runtime.setVariable('speed', 150);
    runtime.update(0.1);
    expect(runtime.states()[0]?.state).toBe('B');
  });

  it("raises a looping clip's triggers and annotations as it passes them", () => {
    const looping: BehaviorGenerator = {
      ...(clip('step') as Extract<BehaviorGenerator, { kind: 'clip' }>),
      triggers: [
        {
          localTime: 0.5,
          event: { id: 0 },
          relativeToEndOfClip: false,
          acyclic: false,
          isAnnotation: false,
        },
      ],
    };
    const runtime = new BehaviorRuntime({
      root: graph(looping, ['halfway']),
      host: host({ step: animation(0, 1, [{ time: 0.9, text: 'FootLeft' }]) }),
      skeleton,
    });
    runtime.update(0);
    runtime.update(0.6);
    expect(runtime.takeRaised()).toEqual(['halfway']);
    runtime.update(0.6); // wraps past 0.9 and back to 0.2
    expect(runtime.takeRaised()).toEqual(['FootLeft']);
    expect(runtime.pose[0]).toBeCloseTo(0.2);
  });

  it('runs modifiers: expressions assign, BSIsActiveModifier flags while active', () => {
    const expressions: BehaviorModifier = {
      kind: 'expressions',
      name: 'Eval',
      enable: { value: 1 },
      expressions: [
        {
          expression: 'iMovementSpeed = cond((Speed < 100), 0, 1)',
          variable: -1,
          event: -1,
          eventMode: 0,
        },
        { expression: 'runStart if (Speed > 350)', variable: -1, event: -1, eventMode: 2 },
      ],
    };
    const active: BehaviorModifier = {
      kind: 'is-active',
      name: 'Active',
      enable: { value: 1 },
      slots: [{ output: { value: 0, variable: 2 }, invert: false }],
    };
    const root: BehaviorGenerator = {
      kind: 'modifier-generator',
      name: 'Mods',
      modifier: {
        kind: 'list',
        name: 'List',
        enable: { value: 1 },
        modifiers: [expressions, active],
      },
      generator: clip('idle'),
    };
    const runtime = new BehaviorRuntime({
      root: graph(
        root,
        ['runStart'],
        [
          { name: 'Speed', initial: 400 },
          { name: 'iMovementSpeed', initial: 0 },
          { name: 'bIsActive', initial: 0 },
        ],
      ),
      host: host({ idle: animation(0) }),
      skeleton,
    });
    runtime.update(0.1);
    expect(runtime.variable('iMovementSpeed')).toBe(1);
    expect(runtime.variable('bIsActive')).toBe(1);
    expect(runtime.takeRaised()).toEqual(['runStart']);
    runtime.update(0.1);
    expect(runtime.takeRaised()).toEqual([]);
  });

  it('blends a parametric blender by its parameter', () => {
    const blender: BehaviorGenerator = {
      kind: 'blender',
      name: 'Speed',
      flags: 0x10,
      blendParameter: { value: 0, variable: 0 },
      children: [
        { weight: { value: 0 }, generator: clip('walk') },
        { weight: { value: 1 }, generator: clip('run') },
      ],
    };
    const runtime = new BehaviorRuntime({
      root: graph(blender, [], [{ name: 'Speed', initial: 0.25 }]),
      host: host({ walk: animation(0, 10), run: animation(40, 10) }),
      skeleton,
    });
    runtime.update(0);
    expect(runtime.pose[0]).toBeCloseTo(10);
  });
});
