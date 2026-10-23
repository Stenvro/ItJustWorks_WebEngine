import { describe, expect, it } from 'vitest';
import type { AnimationBinding, HkxAnimation, HkxSkeleton } from '../formats/hkx/animation.ts';
import type {
  BehaviorGenerator,
  BehaviorGraph,
  BehaviorModifier,
  StateTransition,
  Vec4,
} from '../formats/hkx/behavior.ts';
import { BehaviorRuntime, type BehaviorHost } from './behavior-runtime.ts';
import type { GraphEvent } from './graph-events.ts';

/** Raised events by their names as the graph has them. */
const names = (events: readonly GraphEvent[]): string[] => events.map((event) => event.text);

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
    expect(names(runtime.takeRaised())).toEqual(['idleExit']);
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
    expect(names(runtime.takeRaised())).toEqual(['halfway']);
    runtime.update(0.6); // wraps past 0.9 and back to 0.2
    expect(names(runtime.takeRaised())).toEqual(['FootLeft']);
    expect(runtime.pose[0]).toBeCloseTo(0.2);
  });

  it('raises events with their payloads: a string payload, an annotation after its dot', () => {
    const playing: BehaviorGenerator = {
      ...(clip('work') as Extract<BehaviorGenerator, { kind: 'clip' }>),
      triggers: [
        {
          localTime: 0.2,
          event: { id: 0, payload: 'AnimObjectTankard' },
          relativeToEndOfClip: false,
          acyclic: false,
          isAnnotation: false,
        },
      ],
    };
    const runtime = new BehaviorRuntime({
      // The graph declares the annotation's whole text as an event: it is handled as one.
      root: graph(playing, ['AnimObjLoad', 'CameraShake.0.5']),
      host: host({
        work: animation(0, 1, [
          { time: 0.4, text: 'CameraShake.0.5' },
          { time: 0.6, text: 'AnimObjLoad.DecapitationHeadGore' },
        ]),
      }),
      skeleton,
    });
    runtime.update(0);
    runtime.update(0.7);
    expect(runtime.takeRaised()).toEqual([
      { name: 'AnimObjLoad', payload: 'AnimObjectTankard', text: 'AnimObjLoad' },
      { name: 'CameraShake', payload: '0.5', text: 'CameraShake.0.5' },
      {
        name: 'AnimObjLoad',
        payload: 'DecapitationHeadGore',
        text: 'AnimObjLoad.DecapitationHeadGore',
      },
    ]);
    // Sent with a payload, an event is taken as any other.
    expect(runtime.sendEvent('AnimObjLoad', 'AnimObjectBook')).toBe(true);
    expect(runtime.sendEvent('NoSuchEvent', 'x')).toBe(false);
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
    expect(names(runtime.takeRaised())).toEqual(['runStart']);
    runtime.update(0.1);
    expect(names(runtime.takeRaised())).toEqual([]);
  });

  it('sets the iState its state machines are in and tags it (BSIStateManagerModifier)', () => {
    const machine: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'H2HBehavior',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'Default',
          probability: 1,
          enable: true,
          generator: clip('idle'),
          transitions: [transition(0, 18)],
        },
        {
          id: 18,
          name: 'Sprint',
          probability: 1,
          enable: true,
          generator: clip('sprint'),
          transitions: [],
        },
      ],
      wildcardTransitions: [],
    };
    const manager: BehaviorModifier = {
      kind: 'istate-manager',
      name: 'WWiStateManagerModifier',
      enable: { value: 1 },
      iStateVar: { value: 0, variable: 0 },
      states: [
        { machine, stateId: 0, iState: { value: 0, variable: 1 } },
        { machine, stateId: 18, iState: { value: 0, variable: 2 } },
      ],
    };
    const runtime = new BehaviorRuntime({
      root: graph(
        { kind: 'modifier-generator', name: 'Mods', modifier: manager, generator: machine },
        ['sprintStart'],
        [
          { name: 'iState', initial: 0 },
          { name: 'iState_WerewolfBeastDefault', initial: 0 },
          { name: 'iState_WerewolfBeastSprint', initial: 1 },
        ],
      ),
      host: host({ idle: animation(0), sprint: animation(1) }),
      skeleton,
    });
    runtime.update(0.1);
    expect(runtime.variable('iState')).toBe(0);
    expect(runtime.taggedState()).toBe(0);
    runtime.sendEvent('sprintStart');
    runtime.update(0.1);
    runtime.update(0.1);
    expect(runtime.variable('iState')).toBe(1);
    expect(runtime.taggedState()).toBe(1);
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

  it('freezes a cyclic blend on its event and cross-blends to the live parameter on the next', () => {
    const blender: BehaviorGenerator = {
      kind: 'blender',
      name: 'Direction',
      flags: 0x10,
      blendParameter: { value: 0, variable: 0 },
      children: [
        { weight: { value: 0 }, generator: clip('walk') },
        { weight: { value: 1 }, generator: clip('run') },
      ],
    };
    const cyclic: BehaviorGenerator = {
      kind: 'cyclic-blend',
      name: 'Cyclic',
      generator: blender,
      freezeEvent: { id: 0 },
      crossBlendEvent: { id: 1 },
      blendParameter: { value: 0, variable: 0 },
      transitionDuration: 1,
      blendCurve: 1,
    };
    const runtime = new BehaviorRuntime({
      root: graph(
        cyclic,
        ['CyclicFreeze', 'CyclicCrossBlend'],
        [{ name: 'Direction', initial: 0.25 }],
      ),
      host: host({ walk: animation(0, 10), run: animation(40, 10) }),
      skeleton,
    });
    runtime.update(0);
    expect(runtime.pose[0]).toBeCloseTo(10);
    // Events are handled at the next update, before the variable changes.
    runtime.sendEvent('CyclicFreeze');
    runtime.update(0);
    runtime.setVariable('Direction', 1);
    runtime.update(0);
    expect(runtime.pose[0]).toBeCloseTo(10);
    runtime.sendEvent('CyclicCrossBlend');
    runtime.update(0.5);
    // Half way (linear) from the frozen 0.25 (10.5 after 0.5 s) to the live 1 (40.5).
    expect(runtime.pose[0]).toBeCloseTo(25.5);
    runtime.update(0.6);
    expect(runtime.pose[0]).toBeCloseTo(41.1);
  });

  it('lays an offset clip on, sampled where its variable says', () => {
    const offset: AnimationBinding = {
      ...animation(0, 2),
      additive: true,
      animation: {
        duration: 2,
        trackCount: 1,
        floatTrackCount: 0,
        annotations: [],
        motion: undefined,
        sample: (time, out) => {
          out.set([time * 10, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
        },
      },
    };
    const root: BehaviorGenerator = {
      kind: 'offset-animation',
      name: 'WeaponAdjustment',
      generator: clip('idle'),
      offsetGenerator: clip('adjust'),
      offsetVariable: { value: 0, variable: 0 },
      rangeStart: 0,
      rangeEnd: 1,
    };
    const runtime = new BehaviorRuntime({
      root: graph(root, [], [{ name: 'weapAdj', initial: 0.5 }]),
      host: host({ idle: animation(3), adjust: offset }),
      skeleton,
    });
    runtime.update(0);
    // The idle at 3, plus the offset clip at half its 2 s (10).
    expect(runtime.pose[0]).toBeCloseTo(13);
  });

  it('delays a transition to its initiate interval and limits one to its trigger interval', () => {
    const interval = (enter: number, exit: number) => ({
      enterEventId: enter,
      exitEventId: exit,
      enterTime: 0,
      exitTime: 0,
    });
    const machine: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Machine',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'Sit',
          probability: 1,
          enable: true,
          generator: clip('sit'),
          transitions: [
            // Getting up waits for InitiateStart (events 1 and 2).
            transition(0, 1, { flags: 0x2, initiateInterval: interval(1, 2) }),
            // An attack only between R1_Start and R1_Stop (events 4 and 5).
            transition(3, 2, { flags: 0x1, triggerInterval: interval(4, 5) }),
          ],
        },
        {
          id: 1,
          name: 'Stand',
          probability: 1,
          enable: true,
          generator: clip('a'),
          transitions: [],
        },
        {
          id: 2,
          name: 'Attack',
          probability: 1,
          enable: true,
          generator: clip('a'),
          transitions: [],
        },
      ],
      wildcardTransitions: [],
    };
    const make = () =>
      new BehaviorRuntime({
        root: graph(machine, [
          'getUp',
          'InitiateStart',
          'InitiateEnd',
          'attack',
          'R1_Start',
          'R1_Stop',
        ]),
        host: host({ sit: animation(0), a: animation(1) }),
        skeleton,
      });
    const sit = make();
    sit.update(0);
    sit.sendEvent('getUp');
    sit.update(0.1);
    expect(sit.states()[0]?.state).toBe('Sit');
    sit.sendEvent('InitiateStart');
    sit.update(0.1);
    expect(sit.states()[0]?.state).toBe('Stand');

    const attack = make();
    attack.update(0);
    attack.sendEvent('attack');
    attack.update(0.1);
    expect(attack.states()[0]?.state).toBe('Sit');
    attack.sendEvent('R1_Start');
    attack.update(0.1);
    attack.sendEvent('R1_Stop');
    attack.update(0.1);
    attack.sendEvent('attack');
    attack.update(0.1);
    expect(attack.states()[0]?.state).toBe('Sit');
    attack.sendEvent('R1_Start');
    attack.update(0.1);
    attack.sendEvent('attack');
    attack.update(0.1);
    expect(attack.states()[0]?.state).toBe('Attack');
  });

  it("takes a nested machine's global wildcard from the machine above it", () => {
    // Master_Behavior's Root has no way into Cart_State; its Cart machine's IdleCartPrisonerASway
    // is a global wildcard (0xd00), its IdleCartPrisonerAIdle a local one (0x900).
    const state = (id: number, name: string, generator: BehaviorGenerator) => ({
      id,
      name,
      probability: 1,
      enable: true,
      generator,
      transitions: [],
    });
    const cart: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Cart',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [state(0, 'Idle', clip('idle')), state(1, 'Sway', clip('sway'))],
      wildcardTransitions: [transition(0, 0, { flags: 0x900 }), transition(1, 1, { flags: 0xd00 })],
    };
    const master: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Master',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [state(0, 'Root', clip('root')), state(1, 'Cart_State', cart)],
      wildcardTransitions: [],
    };
    const runtime = new BehaviorRuntime({
      root: graph(master, ['IdleCartIdle', 'IdleCartSway']),
      host: host({ root: animation(0), idle: animation(10), sway: animation(20) }),
      skeleton,
    });
    runtime.update(0);
    // A local wildcard of a machine that does not run: nothing.
    runtime.sendEvent('IdleCartIdle');
    runtime.update(0.1);
    expect(runtime.states()).toEqual([{ machine: 'Master', state: 'Root' }]);
    runtime.sendEvent('IdleCartSway');
    runtime.update(0.1);
    expect(runtime.states()).toEqual([
      { machine: 'Master', state: 'Cart_State' },
      { machine: 'Cart', state: 'Sway' },
    ]);
    // Within it its local wildcard goes on.
    runtime.sendEvent('IdleCartIdle');
    runtime.update(0.1);
    expect(runtime.states()[1]).toEqual({ machine: 'Cart', state: 'Idle' });
  });
});

describe("the dragon's flight modifiers", () => {
  /** A graph whose root modifies a clip (2 s) with `modifier`, with these variables. */
  const flying = (
    modifier: BehaviorModifier,
    variables: { name: string; type: number; initial: number; vector?: Vec4 }[],
    events: string[] = [],
  ): BehaviorRuntime =>
    new BehaviorRuntime({
      root: {
        name: 'flight',
        events,
        variables,
        root: {
          kind: 'modifier-generator',
          name: 'Mods',
          modifier,
          generator: clip('glide', 0),
        },
      },
      host: host({ glide: animation(0, 2) }),
      skeleton,
    });
  /** The character's world matrix: at the origin, facing +y. */
  const place = (runtime: BehaviorRuntime): Float32Array => {
    const matrix = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    runtime.world = { worldFromModel: matrix };
    return matrix;
  };
  /** Moves the character by the root motion its graph reports (it keeps facing +y). */
  const move = (matrix: Float32Array, runtime: BehaviorRuntime): void => {
    const [x, y, z] = runtime.rootMotion().translation;
    matrix[12] = (matrix[12] ?? 0) + x;
    matrix[13] = (matrix[13] ?? 0) + y;
    matrix[14] = (matrix[14] ?? 0) + z;
  };

  it('tweens the character to its target over what is left of its clips (BSTweenerModifier)', () => {
    const runtime = flying(
      {
        kind: 'tweener',
        name: 'Tween',
        enable: { value: 1 },
        tweenPosition: true,
        tweenRotation: false,
        useTweenDuration: false,
        tweenDuration: { value: 0 },
        targetPosition: { value: [0, 0, 0, 0], variable: 0 },
        targetRotation: { value: [0, 0, 0, 1] },
      },
      [{ name: 'TweenPosition', type: 7, initial: 0, vector: [0, 100, 50, 0] }],
    );
    const matrix = place(runtime);
    const way: number[] = [];
    for (let i = 0; i < 4; i++) {
      runtime.update(0.5);
      move(matrix, runtime);
      way.push(Math.round(matrix[13] ?? 0));
    }
    // A quarter of the way each half second of the clip's two, there at its end.
    expect(way).toEqual([25, 50, 75, 100]);
    expect(matrix[14]).toBeCloseTo(50);
  });

  it('turns the character to its target rotation within its tween duration', () => {
    const quarter = Math.sin(Math.PI / 4);
    const runtime = flying(
      {
        kind: 'tweener',
        name: 'Turn',
        enable: { value: 1 },
        tweenPosition: false,
        tweenRotation: true,
        useTweenDuration: true,
        tweenDuration: { value: 0.5 },
        targetPosition: { value: [0, 0, 0, 0] },
        // A quarter turn counter-clockwise about z.
        targetRotation: { value: [0, 0, quarter, quarter] },
      },
      [],
    );
    place(runtime);
    runtime.update(0.25);
    expect(runtime.rootMotion().yaw).toBeCloseTo(Math.PI / 4);
  });

  it('raises a BSTimerModifier alarm again and again (resetAlarm)', () => {
    const runtime = flying(
      {
        kind: 'timer',
        name: 'PickNewIdle',
        enable: { value: 1 },
        alarmTime: { value: 1 },
        alarmEvent: { id: 0 },
        reset: true,
      },
      [],
      ['PickNewIdle'],
    );
    const raised: string[] = [];
    for (let i = 0; i < 6; i++) {
      runtime.update(0.5);
      raised.push(...names(runtime.takeRaised()));
    }
    expect(raised).toEqual(['PickNewIdle', 'PickNewIdle', 'PickNewIdle']);
  });

  it('writes the time step, splits a vector and transforms one', () => {
    const runtime = flying(
      {
        kind: 'list',
        name: 'List',
        enable: { value: 1 },
        modifiers: [
          {
            kind: 'time-step',
            name: 'Step',
            enable: { value: 1 },
            timeStep: { value: 0, variable: 0 },
          },
          {
            kind: 'decompose-vector',
            name: 'Direction',
            enable: { value: 1 },
            vector: { value: [0, 0, 0, 0], variable: 1 },
            x: { value: 0 },
            y: { value: 0 },
            z: { value: 0, variable: 2 },
            w: { value: 0 },
          },
          {
            kind: 'transform-vector',
            name: 'Offset',
            enable: { value: 1 },
            // Half a turn about z, then 10 up.
            rotation: { value: [0, 0, 1, 0] },
            translation: { value: [0, 0, 10, 0] },
            vectorIn: { value: [100, -7, -0.5, 0] },
            vectorOut: { value: [0, 0, 0, 0], variable: 3 },
            rotateOnly: false,
            inverse: false,
            computeOnActivate: true,
            computeOnModify: false,
          },
        ],
      },
      [
        { name: 'TimeStep', type: 4, initial: 0 },
        { name: 'MovementDirection', type: 7, initial: 0, vector: [0, 0.6, 0.8, 0] },
        { name: 'MoveDirZ', type: 4, initial: 0 },
        { name: 'ConstraintOffset', type: 7, initial: 0, vector: [0, 0, 0, 0] },
      ],
    );
    runtime.update(1 / 30);
    expect(runtime.variable('TimeStep')).toBeCloseTo(1 / 30);
    expect(runtime.variable('MoveDirZ')).toBeCloseTo(0.8);
    const offset = runtime.vector('ConstraintOffset') ?? [];
    expect(Array.from(offset, (v) => Math.round(v * 10) / 10)).toEqual([-100, 7, 9.5, 0]);
  });

  it('raises its event as the character flies past its target (BSPassByTargetTriggerModifier)', () => {
    const runtime = flying(
      {
        kind: 'pass-by-target',
        name: 'PassBy',
        enable: { value: 1 },
        targetPosition: { value: [0, 0, 0, 0] },
        radius: { value: 4000 },
        movementDirection: { value: [0, 0, 0, 0] },
        triggerEvent: { id: 0 },
      },
      [],
      ['DragonPassByEffect'],
    );
    const matrix = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1000, 500, 1);
    runtime.world = { worldFromModel: matrix, passByTarget: [0, 0, 0] };
    const raised: string[] = [];
    for (const y of [-1000, -200, 300, 900]) {
      matrix[13] = y;
      runtime.update(0.1);
      raised.push(...names(runtime.takeRaised()));
    }
    expect(raised).toEqual(['DragonPassByEffect']);
  });

  it('activates the is-active modifiers events enter before an outer modifier reads them', () => {
    // The magic graph's shape: CastingState's CastStop (an event-on-false-to-true of NotCasting)
    // over the hand's states, whose cast state sets NotCasting to 0 while it is active.
    const notCasting: BehaviorModifier = {
      kind: 'is-active',
      name: 'InvertNotCasting',
      enable: { value: 1 },
      slots: [{ output: { value: 0, variable: 0 }, invert: true }],
    };
    const hand: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'Hand',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'HandReady',
          probability: 1,
          enable: true,
          generator: clip('ready'),
          transitions: [transition(2, 1)],
        },
        {
          id: 1,
          name: 'HandCast',
          probability: 1,
          enable: true,
          generator: {
            kind: 'modifier-generator',
            name: 'Cast_MG',
            modifier: notCasting,
            generator: clip('cast'),
          },
          transitions: [transition(3, 0)],
        },
      ],
      wildcardTransitions: [],
    };
    const castStop: BehaviorModifier = {
      kind: 'event-on-false-to-true',
      name: 'CastStop',
      enable: { value: 1 },
      slots: [{ enabled: { value: 1 }, test: { value: 0, variable: 0 }, event: { id: 1 } }],
    };
    const root: BehaviorGenerator = {
      kind: 'state-machine',
      name: 'MagicRoot',
      startStateId: { value: 0 },
      startStateMode: 0,
      states: [
        {
          id: 0,
          name: 'MagicReady',
          probability: 1,
          enable: true,
          generator: clip('ready'),
          transitions: [transition(0, 1)],
        },
        {
          id: 1,
          name: 'Casting',
          probability: 1,
          enable: true,
          generator: {
            kind: 'modifier-generator',
            name: 'Casting_MG',
            modifier: castStop,
            generator: hand,
          },
          transitions: [transition(1, 0)],
        },
      ],
      wildcardTransitions: [],
    };
    const runtime = new BehaviorRuntime({
      root: graph(
        root,
        ['BeginCastRight', 'CastStop', 'MRh_SpellAimedStart', 'MRh_Equipped_Event'],
        [{ name: 'NotCasting', initial: 1 }],
      ),
      host: host({ ready: animation(0), cast: animation(10) }),
      skeleton,
    });
    runtime.update(0.1);
    runtime.sendEvent('BeginCastRight');
    runtime.sendEvent('MRh_SpellAimedStart');
    for (let i = 0; i < 3; i++) runtime.update(0.1);
    expect(runtime.variable('NotCasting')).toBe(0);
    expect(runtime.takeRaised()).not.toContain('CastStop');
    expect(runtime.states().map((state) => state.state)).toContain('HandCast');
    // The hand back to its ready state: NotCasting again, CastStop ends CastingState.
    runtime.sendEvent('MRh_Equipped_Event');
    for (let i = 0; i < 3; i++) runtime.update(0.1);
    expect(names(runtime.takeRaised())).toContain('CastStop');
    expect(runtime.states().map((state) => state.state)).toContain('MagicReady');
  });
});
