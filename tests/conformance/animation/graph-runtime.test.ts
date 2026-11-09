// Conformance: the graph runtime (engine map: Animation and bodies > Graph runtime): how the
// behaviour graphs' events reach the engine with their payloads, and how often a graph updates.
//
// Sources:
// - Havok Behavior: an event carries an hkbStringEventPayload (AnimObjLoad's object,
//   StartAnimatedCamera's node); a clip annotation "Tag.payload" reaches the engine as its tag
//   and the text after the first dot (docs/animation.md, "Graph events").
// - The engine's graph manager update, observed in the original (docs/animation.md, "How often graphs
//   update"), and its [Animation] INI settings: the engine's defaults (bAnimInterpEnable 1,
//   fAnimInterpMinTime 0.08, fAnimInterpMaxTime 0.25, fAnimInterpNearDist 400,
//   fAnimInterpFarDist 800, fAnimInterpSlop 0.25).

import { describe, expect, it } from 'vitest';
import {
  ANIMATION_RATE,
  animationRate,
  animationRateSettings,
} from '../../../src/animation/animated-skeleton.ts';
import { graphEvent } from '../../../src/animation/graph-events.ts';
import { ActorGraphEvents } from '../../../src/shell/actor-graph-events.ts';
import { BehaviorRuntime, type ActorGraphState } from '../../../src/animation/behavior-runtime.ts';
import type { AnimationBinding, HkxSkeleton } from '../../../src/formats/hkx/animation.ts';
import type { BehaviorGenerator, BehaviorGraph } from '../../../src/formats/hkx/behavior.ts';

describe('event payloads (Havok Behavior, the response files)', () => {
  it('a payload of its own is kept whole, the name untouched', () => {
    expect(graphEvent('AnimObjLoad', 'AnimObjectTankard')).toEqual({
      name: 'AnimObjLoad',
      payload: 'AnimObjectTankard',
      text: 'AnimObjLoad',
    });
  });
  it('an annotation’s text splits at its first dot into tag and payload', () => {
    expect(graphEvent('CameraShake.0.5')).toEqual({
      name: 'CameraShake',
      payload: '0.5',
      text: 'CameraShake.0.5',
    });
    expect(graphEvent('SoundPlay.NPCGiantAttackStomp').name).toBe('SoundPlay');
  });
  it('a name without a dot has no payload', () => {
    expect(graphEvent('weaponSwing')).toEqual({ name: 'weaponSwing', text: 'weaponSwing' });
  });
});

describe('how often a graph updates (original, [Animation] settings)', () => {
  const camera = { position: [0, 0, 0] as const, forward: [0, 1, 0] as const, fov: 80 };
  const ini = {
    number: (_section: string, key: string): number =>
      ({
        fAnimInterpMinTime: 0.08,
        fAnimInterpMaxTime: 0.25,
        fAnimInterpNearDist: 400,
        fAnimInterpFarDist: 800,
        fAnimInterpSlop: 0.25,
      })[key] ?? 0,
    bool: (): boolean => true,
  };

  it('reads the INI’s settings by name', () => {
    const settings = animationRateSettings(ini);
    expect(settings.minTime).toBeCloseTo(0.08, 6);
    expect(settings.maxTime).toBe(0.25);
    expect(settings.nearDistance).toBe(400);
    expect(settings.farDistance).toBe(800);
    expect(settings.slop).toBe(0.25);
    expect(ANIMATION_RATE.enabled).toBe(true);
  });
  it('every frame up to fAnimInterpNearDist', () => {
    expect(animationRate([0, 399, 0], camera).interval).toBe(0);
  });
  it('fAnimInterpMinTime just beyond it, rising to fAnimInterpMaxTime at fAnimInterpFarDist', () => {
    expect(animationRate([0, 401, 0], camera).interval).toBeCloseTo(0.08, 2);
    expect(animationRate([0, 600, 0], camera).interval).toBeCloseTo(0.165, 3);
    expect(animationRate([0, 800, 0], camera).interval).toBeCloseTo(0.25, 6);
    expect(animationRate([0, 5000, 0], camera).interval).toBeCloseTo(0.25, 6);
  });
  it('a zoomed view (half the field of view) brings it twice as near', () => {
    expect(animationRate([0, 300, 0], { ...camera, fov: 40 }).interval).toBeCloseTo(0.165, 3);
  });
});

// A creature killed where its graph does not take its death idle (a cow grazing: no active state
// answers DeathAnimation) and one whose graph takes it, though its active states have not changed
// yet: the engine's death (src/shell/actor-graph-events.ts died) asks the graph's answer.
describe('the death idle’s check (original)', () => {
  const COW = 0x100;

  /** The engine's death handling with one dying actor, whose graph answers `answer`. */
  function dying(answer: boolean | undefined): { frame(seconds: number): void; limp: number[] } {
    const limp: number[] = [];
    const graph = {
      states: () => [{ machine: 'Behavior', state: 'Grazing' }],
      answered: (name: string): boolean | undefined =>
        name === 'DeathAnimation' ? answer : undefined,
      declares: () => false,
      synchronizedClip: () => undefined,
      poweredRagdollForce: () => 0,
      keyframedRagdollBones: () => new Set<number>(),
    };
    const staged = { reference: COW, placed: { behavior: graph }, dead: false };
    const stage = {
      get: (reference: number) => (reference === COW ? staged : undefined),
      bodies: {
        knocked: () => false,
        kill: (actor: typeof staged) => {
          limp.push(actor.reference);
          return Promise.resolve();
        },
        driveRagdoll: () => undefined,
      },
      combat: { paired: () => false },
      userOf: () => ({ reference: COW }),
      // The idle tree gives the creature's ActionDeath its DeathAnimation, sent to its graph.
      furniture: {
        actionEvent: (_user: unknown, action: string) =>
          Promise.resolve(action === 'ActionDeath' ? 'DeathAnimation' : undefined),
      },
    };
    const events = new ActorGraphEvents({
      session: { animation: { animationData: () => new Promise(() => undefined) } },
      terminal: { log: () => undefined },
      stage,
      sounding: {},
      gait: () => undefined,
    } as never);
    const died = events.died(staged as never, undefined, true);
    return {
      limp,
      frame: (seconds) => {
        void died.then(() => {
          events.frame(seconds);
        });
      },
    };
  }

  it('an event no active node takes reports not handled: the body is let go at once', async () => {
    const cow = dying(false);
    cow.frame(1 / 60);
    await Promise.resolve();
    await Promise.resolve();
    expect(cow.limp).toEqual([COW]);
  });
  it('one its graph took plays on, its states as yet unchanged', async () => {
    const cow = dying(true);
    for (let i = 0; i < 30; i++) cow.frame(1 / 60);
    await Promise.resolve();
    await Promise.resolve();
    expect(cow.limp).toEqual([]);
  });
});

// An actor's graph caught in a save (docs/formats/save.md, "Animation graphs"): two states, the
// second a clip of two seconds; a variable the engine set; an event raised and not handled yet.
describe('graph variables and states in saves (M12)', () => {
  const skeleton: HkxSkeleton = {
    name: 'Root',
    bones: [{ name: 'Root', lockTranslation: false }],
    parents: Int16Array.of(-1),
    referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
    floatSlots: [],
    referenceFloats: new Float32Array(0),
  };
  /** A clip that moves the bone along x by its local time. */
  const binding: AnimationBinding = {
    skeletonName: 'Root',
    animation: {
      duration: 2,
      trackCount: 1,
      floatTrackCount: 0,
      annotations: [],
      motion: undefined,
      sample: (time, out) => {
        out.set([time, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
      },
    },
    trackToBone: undefined,
    floatTrackToSlot: undefined,
    additive: false,
  };
  const clip = (name: string): BehaviorGenerator => ({
    kind: 'clip',
    name,
    animation: name,
    mode: 1,
    playbackSpeed: 1,
  });
  const behavior: BehaviorGraph = {
    name: 'actor',
    events: ['sitStart', 'getUp'],
    variables: [{ name: 'Speed', type: 4, initial: 0 }],
    root: {
      kind: 'state-machine',
      name: 'Root',
      startStateId: { value: 0 },
      startStateMode: 0,
      wildcardTransitions: [],
      states: [
        {
          id: 0,
          name: 'Standing',
          probability: 1,
          enable: true,
          generator: clip('stand'),
          transitions: [
            { eventId: 0, toStateId: 1, flags: 0, priority: 0, conditional: false, duration: 0 },
          ],
        },
        {
          id: 1,
          name: 'Sitting',
          probability: 1,
          enable: true,
          generator: clip('sit'),
          transitions: [
            { eventId: 1, toStateId: 0, flags: 0, priority: 0, conditional: false, duration: 0 },
          ],
        },
      ],
    },
  };
  const graph = (): BehaviorRuntime =>
    new BehaviorRuntime({
      root: behavior,
      host: { clip: () => binding, behavior: () => undefined },
      skeleton,
    });

  it('a graph put back from its save goes on in its state, its clip’s time, its variables and its events', () => {
    const before = graph();
    before.update(0.1);
    before.sendEvent('sitStart');
    before.setVariable('Speed', 42);
    before.update(0.75);
    // Saved with an event not handled yet: the get-up asked as the save was made.
    before.sendEvent('getUp');
    const saved = JSON.parse(JSON.stringify(before.saveActorState())) as ActorGraphState;
    const after = graph();
    after.restoreActorState(saved);
    expect(after.variable('Speed')).toBe(42);
    after.update(0);
    // The waiting get-up is handled as it first runs.
    expect(after.states()).toEqual([{ machine: 'Root', state: 'Standing' }]);
    // Without the event: the sitting clip goes on from its local time (0.75 s in).
    const sitting = graph();
    sitting.restoreActorState({ ...saved, events: [] });
    sitting.update(0.25);
    expect(sitting.states()).toEqual([{ machine: 'Root', state: 'Sitting' }]);
    expect(sitting.pose[0]).toBeCloseTo(1, 5);
  });
});

describe('the graph runtime (todo)', () => {
  // TODO(M13): MQ101's walk to the block plays IdleWalkingCameraStart (an idle for 0_Master.hkx)
  // on the player; the third-person graph takes it into MT WalkingCamera, an additive arm clip
  // alone, so the body glides there in third person. Whether the engine keeps that idle from the
  // third-person graph (or the view in first person) is not read yet. The data so far
  // (2026-10-27): MT WalkingCamera is state 49 of the Master machine itself (on
  // IdleWalkingCameraStart from Root, out on IdleWalkingCameraEnd), its only generator the clip
  // MT_WalkingCamera.hkx (0.333 s, 10 tracks, additive), so any rule that keeps the graph in it
  // leaves no walk to add to; and MQ101 disables the camera switch from stage 4 on
  // (DisablePlayerControls abCamSwitch), so the original walks to the block in the view of the
  // cart (first person) and its third-person body there is never seen.
  it.todo(
    'the AI-driven player’s third-person body walks to the block: its steps match the walk’s root motion  [original]',
  );
});
