// Conformance: paired animations (engine map: Animation and bodies > Paired animations): one clip
// for two actors (killmoves, mounts, vampire feeding), each playing its side.
//
// Sources:
// - The data: a paired clip's tracks are the pair's root ("PairedRoot"), the first actor's bones
//   unprefixed and the second's prefixed "2_" (the human's 99 bones, the horse's 55 on its side);
//   the second's placement from the root is the track named "2_" alone (Havok packfiles of
//   meshes\actors\character\animations\paired_*.hkx; `node tools/hkx-anim.ts`).
// - The response files: pairedStop (PairedStopHandler), a killmove victim's 2_KillMoveEnd,
//   2_Decapitate, 2_KillActor reach the victim's graph (docs/animation.md, "Killmoves").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BehaviorRuntime } from '../../../src/animation/behavior-runtime.ts';
import {
  GraphEventDispatch,
  graphEvent,
  pairedEvent,
  type GraphEvent,
  type GraphEventSource,
} from '../../../src/animation/graph-events.ts';
import { parseAnimationResponses } from '../../../src/formats/animdata/responses.ts';
import type { AnimationBinding, HkxSkeleton } from '../../../src/formats/hkx/animation.ts';
import type { BehaviorGenerator } from '../../../src/formats/hkx/behavior.ts';
import {
  PAIRED_ROOT,
  PARTNER_PREFIX,
  pairedSide,
  pairedTrackBones,
} from '../../../src/animation/paired-clips.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const HUMAN = ['NPC Root [Root]', 'NPC Pelvis [Pelv]', 'NPC Head [Head]'];
const HORSE = ['HorseRoot', 'Horse Pelvis', 'Horse Head'];
const TRACKS = [
  PAIRED_ROOT,
  'NPC Root [Root]',
  'NPC Pelvis [Pelv]',
  'NPC Head [Head]',
  '2_',
  '2_HorseRoot',
  '2_Horse Pelvis',
  '2_Horse Head',
];

describe('the sides of a paired clip (the data’s track names)', () => {
  it('the root and the partner prefix', () => {
    expect(PAIRED_ROOT).toBe('PairedRoot');
    expect(PARTNER_PREFIX).toBe('2_');
  });
  it('a skeleton plays the side that names more of its bones', () => {
    expect(pairedSide(TRACKS, HUMAN)).toBe('first');
    expect(pairedSide(TRACKS, HORSE)).toBe('second');
  });
  it('each side takes its own tracks; PairedRoot is no actor’s bone', () => {
    expect([...pairedTrackBones(TRACKS, HUMAN)]).toEqual([-1, 0, 1, 2, -1, -1, -1, -1]);
    expect([...pairedTrackBones(TRACKS, HORSE)]).toEqual([-1, -1, -1, -1, -1, 0, 1, 2]);
  });
  it('two actors of one skeleton: the second side takes the prefixed tracks', () => {
    const tracks = [PAIRED_ROOT, 'NPC Head [Head]', '2_NPC Head [Head]'];
    expect([...pairedTrackBones(tracks, HUMAN, 'second')]).toEqual([-1, -1, 2]);
  });
});

/** A one-bone skeleton and a clip of it that lasts a second. */
const SKELETON: HkxSkeleton = {
  name: 'Root',
  bones: [{ name: 'Root', lockTranslation: false }],
  parents: Int16Array.of(-1),
  referencePose: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
  floatSlots: [],
  referenceFloats: new Float32Array(0),
};
const SECOND: AnimationBinding = {
  skeletonName: 'Root',
  animation: {
    duration: 1,
    trackCount: 1,
    floatTrackCount: 0,
    annotations: [],
    motion: undefined,
    sample: (_time, out) => {
      out.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    },
  },
  trackToBone: undefined,
  floatTrackToSlot: undefined,
  additive: false,
};
const EVENTS = ['2_KillActor', '2_PairEnd', 'NPCHitFrame', 'PairEnd', 'Done', 'KillActor'];
const event = (name: string): number => EVENTS.indexOf(name);

/**
 * A graph whose first state plays one side of a paired clip (its SyncAnimPrefix `prefix`) that
 * raises `raised` at 0.1 s, 0.2 s, ...; the clip's PairEnd takes it to the state Done.
 */
function sideOf(prefix: string | undefined, raised: readonly string[]): BehaviorRuntime {
  const root: BehaviorGenerator = {
    kind: 'state-machine',
    name: 'Pair',
    startStateId: { value: 0 },
    startStateMode: 0,
    states: [
      {
        id: 0,
        name: 'Paired',
        probability: 1,
        enable: true,
        generator: {
          kind: 'synchronized-clip',
          name: 'Synced',
          syncPrefix: prefix,
          ignoreMarkPlacement: false,
          getToMarkTime: 0,
          markErrorThreshold: 1,
          leadCharacter: prefix !== undefined,
          reorientSupport: true,
          applyMotionFromRoot: false,
          generator: {
            kind: 'clip',
            name: 'PairedClip',
            animation: 'paired',
            mode: 0,
            playbackSpeed: 1,
            triggers: raised.map((name, index) => ({
              localTime: 0.1 * (index + 1),
              event: { id: event(name) },
              relativeToEndOfClip: false,
              acyclic: false,
              isAnnotation: false,
            })),
          },
        },
        transitions: [
          {
            eventId: event('PairEnd'),
            toStateId: 1,
            flags: 0,
            priority: 0,
            conditional: false,
            duration: 0,
          },
        ],
      },
      {
        id: 1,
        name: 'Done',
        probability: 1,
        enable: true,
        generator: {
          kind: 'clip',
          name: 'DoneClip',
          animation: 'paired',
          mode: 1,
          playbackSpeed: 1,
        },
        transitions: [],
      },
    ],
    wildcardTransitions: [],
  };
  return new BehaviorRuntime({
    root: { name: 'side', events: EVENTS, variables: [], root },
    host: { clip: () => SECOND, behavior: () => undefined },
    skeleton: SKELETON,
  });
}

describe('the events of a paired clip go to each side by their prefix (inferred from the data)', () => {
  it('the second side (SyncAnimPrefix 2_) takes its 2_ events as its own, the prefix off', () => {
    const victim = sideOf('2_', ['2_KillActor', 'NPCHitFrame']);
    victim.update(0.25);
    expect(victim.takeRaised()).toEqual([
      { name: 'KillActor', text: '2_KillActor' },
      { name: 'NPCHitFrame', text: 'NPCHitFrame' },
    ]);
  });
  it('the first side (no prefix of its clip’s own) takes its NPC events as its own', () => {
    const killer = sideOf(undefined, ['NPCHitFrame', '2_KillActor']);
    killer.update(0.25);
    expect(killer.takeRaised()).toEqual([
      { name: 'HitFrame', text: 'NPCHitFrame' },
      { name: '2_KillActor', text: '2_KillActor' },
    ]);
  });
  it('the side’s graph is sent its own event without the prefix (2_PairEnd ends its clip)', () => {
    const victim = sideOf('2_', ['2_PairEnd']);
    victim.update(0.15);
    victim.update(0.05);
    expect(victim.states().map((entry) => entry.state)).toEqual(['Done']);
    // The other side's event is not its own: its graph stays in the clip.
    const killer = sideOf(undefined, ['2_PairEnd']);
    killer.update(0.15);
    killer.update(0.05);
    expect(killer.states().map((entry) => entry.state)).toEqual(['Paired']);
  });
  it('the response files answer it by its name without the prefix (KillActor : KillActorHandler)', () => {
    const dispatch = new GraphEventDispatch<GraphEventSource>();
    dispatch.setResponses(parseAnimationResponses('KillActor : KillActorHandler'), undefined);
    const killed: number[] = [];
    dispatch.handle('KillActorHandler', (source) => killed.push(source.reference));
    const victim = sideOf('2_', ['2_KillActor']);
    victim.update(0.15);
    dispatch.dispatch({ reference: 7, player: false }, victim.takeRaised());
    expect(killed).toEqual([7]);
  });
});

// The player and Hulda (the Bannered Mare's innkeeper) paired as the engine pairs two actors
// (a paired idle: ActorCombat.pairIdle), their graphs' events handed to the engine's handlers.
const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;

describe.skipIf(!hasGamedata())('a pair’s end (headless simulation)', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  /** Events as an actor's body graph raises them, to the engine's handlers. */
  const raise = (actor: number, events: readonly GraphEvent[]): void => {
    const skeleton =
      actor === PLAYER_REF ? sim.world.playerView?.avatar?.body : sim.actor(actor)?.placed;
    if (!skeleton) throw new Error('no body');
    const source = { reference: actor, player: actor === PLAYER_REF, firstPerson: false, skeleton };
    sim.world.stage.graphEvents.dispatch.dispatch(source, events);
  };
  const paired = (): boolean[] => [
    sim.world.stage.combat.paired(PLAYER_REF),
    sim.world.stage.combat.paired(HULDA),
  ];

  it('pairedStop (PairedStopHandler) ends the pair for both actors  [original, inferred]', () => {
    sim.world.stage.combat.pairIdle(PLAYER_REF, HULDA, 'pa_PairedTest');
    expect(paired()).toEqual([true, true]);
    // The leader's clip raises it at its end (NPCpairedStop: the first side's own event).
    raise(PLAYER_REF, [pairedEvent('NPCpairedStop', 'pairedStop')]);
    expect(paired()).toEqual([false, false]);
    // From the other side the same.
    sim.world.stage.combat.pairIdle(PLAYER_REF, HULDA, 'pa_PairedTest');
    raise(HULDA, [pairedEvent('2_pairedStop', 'pairedStop')]);
    expect(paired()).toEqual([false, false]);
  });

  it('a vampire feeding pair (pa_VampireFeed*): VampireFeedEnd ends both sides’ feeding  [original, inferred]', () => {
    const state = sim.runtime.state;
    const feeding = (): boolean => state.actors.get(PLAYER_REF)?.feeding !== undefined;
    state.actor(PLAYER_REF).feeding = { kind: 'vampire', until: state.realTime + 6 };
    sim.world.stage.combat.pairIdle(PLAYER_REF, HULDA, 'pa_VampireFeedStanding_Front');
    // The feeder's clip raises it (NPCVampireFeedEnd, 1.07 s before its end): GetVampireFeed
    // holds no more.
    raise(PLAYER_REF, [pairedEvent('NPCVampireFeedEnd', 'VampireFeedEnd')]);
    expect(feeding()).toBe(false);
    // Raised by the side fed on, the feeder's feeding ends too.
    state.actor(PLAYER_REF).feeding = { kind: 'vampire', until: state.realTime + 6 };
    raise(HULDA, [graphEvent('VampireFeedEnd')]);
    expect(feeding()).toBe(false);
    raise(PLAYER_REF, [pairedEvent('NPCpairedStop', 'pairedStop')]);
    expect(paired()).toEqual([false, false]);
  });
});
