import { describe, expect, it } from 'vitest';
import type { ScriptAttachments } from '../formats/esm/vmad.ts';
import type { Condition } from '../scripting/conditions.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import {
  DEFAULT_ACTOR_BEHAVIOUR,
  SceneActionFlag,
  SceneActorBehaviour,
  SceneActorFlag,
  SceneFlag,
  type SceneAction,
  type SceneActor,
  type SceneDialogueAction,
  type ScenePhase,
  type SceneRecord,
} from './scene-records.ts';
import {
  SceneDirector,
  type SceneActorState,
  type SceneHost,
  type SceneLine,
} from './scene-runtime.ts';

const QUEST = 0x500;
/** The fake condition IsSceneActionComplete(scene, action) is (its UESP index). */
const IS_SCENE_ACTION_COMPLETE = 550;

/** A condition the fake host holds when its form is in `truths`. */
const truth = (form: number): Condition =>
  ({
    function: 0,
    form,
    param2: 0,
    runOn: 0,
    operator: 0,
    comparand: 1,
    or: false,
  }) as unknown as Condition;
const actionDone = (scene: number, action: number): Condition =>
  ({
    function: IS_SCENE_ACTION_COMPLETE,
    form: scene,
    param2: action,
    runOn: 0,
    operator: 0,
    comparand: 1,
    or: false,
  }) as unknown as Condition;

const phase = (start: Condition[] = [], complete: Condition[] = []): ScenePhase => ({
  name: '',
  startConditions: start,
  completionConditions: complete,
  editorWidth: 0,
});
const actor = (alias: number, flags = 0, behaviour = DEFAULT_ACTOR_BEHAVIOUR): SceneActor => ({
  alias,
  flags,
  behaviour,
});
const base = (index: number, alias: number, start: number, end: number) => ({
  name: '',
  alias,
  index,
  flags: 0,
  startPhase: start,
  endPhase: end,
  unknown: undefined,
});
const line = (
  index: number,
  alias: number,
  start: number,
  end: number,
  topic: number | undefined,
  extra: Partial<SceneDialogueAction> = {},
): SceneAction => ({
  ...base(index, alias, start, end),
  type: 'dialogue',
  topic,
  headtrackAlias: -1,
  loopingMax: 0,
  loopingMin: 0,
  emotion: 0,
  emotionValue: 0,
  ...extra,
});
const timer = (index: number, start: number, end: number, seconds: number): SceneAction => ({
  ...base(index, 0, start, end),
  type: 'timer',
  seconds,
});
const packages = (
  index: number,
  alias: number,
  start: number,
  end: number,
  list: number[],
): SceneAction => ({ ...base(index, alias, start, end), type: 'package', packages: list });
const scene = (formId: number, overrides: Partial<SceneRecord>): SceneRecord => ({
  formId,
  editorId: `Scene${formId.toString(16)}`,
  flags: 0,
  phases: [],
  actors: [],
  actions: [],
  quest: QUEST,
  lastActionIndex: 0,
  behaviourSettings: undefined,
  conditions: [],
  scripts: undefined,
  ...overrides,
});
const fragments = (
  begin: boolean,
  end: boolean,
  phases: { phase: number; when: number }[] = [],
): ScriptAttachments => ({
  version: 5,
  scripts: [],
  fragmentScript: 'SF_Test',
  fragments: [
    ...(begin
      ? [{ stage: 'begin' as const, logEntry: 0, script: 'SF_Test', function: 'Begin' }]
      : []),
    ...(end ? [{ stage: 'end' as const, logEntry: 0, script: 'SF_Test', function: 'End' }] : []),
  ],
  phaseFragments: phases.map(({ phase: at, when }) => ({
    phase: at,
    when,
    script: 'SF_Test',
    function: `Phase${String(at)}${when === 1 ? 'Start' : 'Done'}`,
  })),
  aliases: [],
});

/** Lets the scenes' promises run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  scenes: SceneRecord[],
  more: (director: () => SceneDirector) => Partial<SceneHost> = () => ({}),
) {
  const events: string[] = [];
  const truths = new Set<number>();
  const aliases = new Map<number, number>([
    [0, 100],
    [1, 101],
    [2, 102],
  ]);
  const running = new Set([QUEST]);
  const states = new Map<number, Partial<SceneActorState>>();
  const current = new Map<number, number>();
  /** Packages whose conditions do not hold. */
  const blocked = new Set<number>();
  /** Lines that wait to be finished by the test (topic → finish). */
  const slow = new Set<number>();
  const pending = new Map<number, () => void>();
  const made: { director?: SceneDirector } = {};
  const host: SceneHost = {
    scene: (formId) => Promise.resolve(scenes.find((entry) => entry.formId === formId)),
    scenesOf: (quest) =>
      Promise.resolve(scenes.filter((entry) => entry.quest === quest).map((entry) => entry.formId)),
    questRunning: (quest) => running.has(quest),
    aliasReference: (_quest, alias) => aliases.get(alias),
    aliasOptional: () => Promise.resolve(false),
    actor: (reference) => ({
      dead: false,
      combat: false,
      observingCombat: false,
      talking: false,
      ...states.get(reference),
    }),
    alive: (reference) => Promise.resolve(states.get(reference)?.dead !== true),
    conditionsHold: (conditions) =>
      Promise.resolve(
        conditions.every((condition) =>
          condition.function === IS_SCENE_ACTION_COMPLETE
            ? (made.director?.actionComplete(condition.form, condition.param2) ?? false)
            : truths.has(condition.form),
        ),
      ),
    fragment: (_scene, _script, fn) => {
      events.push(`fragment ${fn}`);
      return Promise.resolve();
    },
    say: (said: SceneLine) => {
      events.push(`say ${said.speaker.toString(16)} ${said.topic.toString(16)}`);
      if (!slow.has(said.topic)) return Promise.resolve();
      return new Promise((resolve) => {
        pending.set(said.topic, () => {
          resolve();
        });
      });
    },
    look: (who, look) => {
      events.push(
        `look ${who.toString(16)} ${look?.target === undefined ? '-' : look.target.toString(16)}${look?.face ? ' face' : ''}`,
      );
    },
    packagesChanged: (who) => {
      events.push(`packages ${who.toString(16)}`);
    },
    currentPackage: (who) => current.get(who),
    packagesRunnable: (_who, packages) =>
      Promise.resolve(!packages.every((pack) => blocked.has(pack))),
    stopQuest: (quest) => {
      events.push(`stop quest ${quest.toString(16)}`);
      running.delete(quest);
    },
    random: () => 0,
    warn: (message) => {
      events.push(`warn ${message}`);
    },
    ...more(() => {
      if (!made.director) throw new Error('no director yet');
      return made.director;
    }),
  };
  const scenes_ = new SceneDirector(host);
  made.director = scenes_;
  return {
    director: scenes_,
    events,
    truths,
    aliases,
    running,
    states,
    current,
    blocked,
    slow,
    /** Finishes a slow line. */
    finish: (topic: number) => {
      pending.get(topic)?.();
      pending.delete(topic);
    },
    /** A frame of `seconds`, then the scenes' work. */
    tick: async (seconds = 0.1) => {
      scenes_.update(seconds);
      await settle();
    },
    /** The events of a kind, in order. */
    only: (prefix: string) => events.filter((event) => event.startsWith(prefix)),
  };
}

describe('scene phases and actions', () => {
  it('runs its phases in order: lines one after another, a timer, the fragments', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0), actor(1)],
        phases: [phase(), phase(), phase()],
        actions: [line(1, 0, 0, 0, 0xa1), timer(2, 1, 1, 2), line(3, 1, 2, 2, 0xa2)],
        scripts: fragments(true, true, [
          { phase: 0, when: 2 },
          { phase: 2, when: 1 },
        ]),
      }),
    ]);
    test.director.start(0x10);
    expect(test.director.isPlaying(0x10)).toBe(true);
    await test.tick();
    await test.tick();
    // The first line is said; its phase completes (its fragment), the timer runs.
    expect(test.events.filter((event) => !event.startsWith('look'))).toEqual([
      'fragment Begin',
      'say 64 a1',
      'fragment Phase0Done',
    ]);
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    expect(test.director.actionComplete(0x10, 2)).toBe(false);
    await test.tick(1);
    expect(test.only('say')).toEqual(['say 64 a1']);
    await test.tick(1.5);
    await test.tick();
    expect(test.only('say')).toEqual(['say 64 a1', 'say 65 a2']);
    expect(test.only('fragment')).toEqual([
      'fragment Begin',
      'fragment Phase0Done',
      'fragment Phase2Start',
      'fragment End',
    ]);
    expect(test.director.isPlaying(0x10)).toBe(false);
    expect(test.director.sceneOf(0x100)).toBeUndefined();
  });

  it('skips a phase whose start conditions do not hold', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0)],
        phases: [phase([truth(7)]), phase([truth(8)])],
        actions: [line(1, 0, 0, 0, 0xa1), line(2, 0, 1, 1, 0xa2)],
      }),
    ]);
    test.truths.add(8);
    test.director.start(0x10);
    await test.tick();
    await test.tick();
    expect(test.only('say')).toEqual(['say 64 a2']);
    expect(test.director.isPlaying(0x10)).toBe(false);
  });

  it('waits for the lines that end in a phase, not for those that go on', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0), actor(1)],
        phases: [phase(), phase()],
        actions: [line(1, 0, 0, 1, 0xa1), line(2, 1, 0, 0, 0xa2), line(3, 1, 1, 1, 0xa3)],
      }),
    ]);
    test.slow.add(0xa1);
    test.slow.add(0xa2);
    test.director.start(0x10);
    await test.tick();
    // Both lines of phase 0 are said at once; the phase waits for the one that ends in it.
    expect(test.only('say')).toEqual(['say 64 a1', 'say 65 a2']);
    test.finish(0xa2);
    await test.tick();
    await test.tick();
    expect(test.only('say')).toEqual(['say 64 a1', 'say 65 a2', 'say 65 a3']);
    // Phase 1 waits for the first line, which ends in it.
    expect(test.director.isPlaying(0x10)).toBe(true);
    test.finish(0xa1);
    await test.tick();
    await test.tick();
    expect(test.director.isPlaying(0x10)).toBe(false);
  });

  it('completes a phase on its completion conditions without waiting for its actions', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0)],
        phases: [phase([], [actionDone(0x10, 2)]), phase()],
        actions: [packages(1, 0, 0, 0, [0x900]), timer(2, 0, 0, 1), line(3, 0, 1, 1, 0xa3)],
      }),
    ]);
    test.director.start(0x10);
    await test.tick();
    expect(test.director.packagesOf(0x64)).toEqual([0x900]);
    expect(test.director.packageRunning(0x64)).toBe(true);
    await test.tick(1.2);
    await test.tick();
    // The timer is done: the phase completes though the package never did; its actor lets go.
    expect(test.director.packagesOf(0x64)).toBeUndefined();
    expect(test.only('say')).toEqual(['say 64 a3']);
  });

  it('holds a look-only line until its phase ends; names its target, else the player', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0), actor(1)],
        phases: [phase(), phase([], [truth(9)]), phase()],
        actions: [
          line(1, 0, 0, 1, undefined, { headtrackAlias: 1, flags: SceneActionFlag.faceTarget }),
          // Its own alias named: the player, with Headtrack Player.
          line(2, 1, 0, 0, undefined, {
            headtrackAlias: 1,
            flags: SceneActionFlag.headtrackPlayer,
          }),
          // Phase 1: a look-only line with no target clears actor 0's head tracking.
          line(3, 0, 1, 1, undefined),
        ],
      }),
    ]);
    test.director.start(0x10);
    await test.tick();
    await test.tick();
    expect(test.director.lookOf(0x64)).toEqual({ target: undefined, face: false });
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    expect(test.only('look')).toEqual(['look 64 65 face', 'look 65 14', 'look 65 -', 'look 64 -']);
    test.truths.add(9);
    await test.tick();
    await test.tick();
    expect(test.director.lookOf(0x64)).toBeUndefined();
    expect(test.only('look').slice(-1)).toEqual(['look 64 -']);
    expect(PLAYER_REF).toBe(0x14);
  });

  it('says a looping line again until its phase ends', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0)],
        phases: [phase([], [truth(9)])],
        actions: [
          line(1, 0, 0, 0, 0xa1, { flags: SceneActionFlag.looping, loopingMin: 2, loopingMax: 4 }),
        ],
      }),
    ]);
    test.director.start(0x10);
    await test.tick();
    expect(test.only('say')).toHaveLength(1);
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    // random() 0: the least wait, 2 seconds.
    await test.tick(1);
    expect(test.only('say')).toHaveLength(1);
    await test.tick(1.1);
    expect(test.only('say')).toHaveLength(2);
    test.truths.add(9);
    await test.tick();
    await test.tick(3);
    expect(test.only('say')).toHaveLength(2);
    expect(test.director.isPlaying(0x10)).toBe(false);
  });

  it('gives a package action its packages until one completes, its actor standing after', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0)],
        phases: [phase(), phase([], [truth(9)])],
        actions: [packages(1, 0, 0, 1, [0x900, 0x901]), line(2, 0, 1, 1, 0xa2)],
      }),
    ]);
    test.director.start(0x10);
    await test.tick();
    expect(test.director.packagesOf(0x64)).toEqual([0x900, 0x901]);
    expect(test.director.packagesOf(0x65)).toBeUndefined();
    // Its AI runs another package of its own: not the scene's.
    test.current.set(0x64, 0x777);
    expect(test.director.packageRunning(0x64)).toBe(false);
    test.current.set(0x64, 0x901);
    expect(test.director.packageRunning(0x64)).toBe(true);
    // The package completes: the action is done, the phase (no conditions) completes; the
    // actor stands (no packages) while the action spans phase 1.
    test.director.packageEnded(0x64, 0x901);
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    expect(test.director.packagesOf(0x64)).toEqual([]);
    await test.tick();
    await test.tick();
    expect(test.only('say')).toEqual(['say 64 a2']);
    test.truths.add(9);
    await test.tick();
    await test.tick();
    expect(test.director.packagesOf(0x64)).toBeUndefined();
    expect(test.only('packages').length).toBeGreaterThanOrEqual(3);
  });

  it('is done with a package action none of whose packages may run, at once or later', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0), actor(1)],
        phases: [phase()],
        actions: [packages(1, 0, 0, 0, [0x900]), packages(2, 1, 0, 0, [0x901])],
      }),
    ]);
    test.blocked.add(0x900);
    test.director.start(0x10);
    await test.tick();
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    expect(test.director.actionComplete(0x10, 2)).toBe(false);
    // The second actor runs its scene package; once its conditions fail it is left to its own,
    // and the action is looked at again.
    test.current.set(0x65, 0x901);
    test.blocked.add(0x901);
    await test.tick(1);
    expect(test.director.actionComplete(0x10, 2)).toBe(false);
    test.current.set(0x65, 0x777);
    await test.tick(1);
    await test.tick();
    // Done, its phase (no conditions) completes and the scene ends.
    expect(test.director.isPlaying(0x10)).toBe(false);
  });
});

describe('scene starts, stops and behaviour', () => {
  it('waits for actors playing in another scene; a forced start takes them', async () => {
    const test = setup([
      scene(0x10, { actors: [actor(0)], phases: [phase([], [truth(9)])] }),
      scene(0x11, { actors: [actor(0)], phases: [phase([], [truth(9)])] }),
      scene(0x12, { actors: [actor(0)], phases: [phase([], [truth(9)])] }),
    ]);
    test.director.start(0x10);
    await test.tick();
    expect(test.director.sceneOf(0x64)).toBe(0x10);
    test.director.start(0x11);
    await test.tick();
    expect(test.director.isPlaying(0x11)).toBe(false);
    expect(test.director.waiting).toEqual([0x11]);
    test.director.stop(0x10);
    await test.tick();
    await test.tick();
    expect(test.director.sceneOf(0x64)).toBe(0x11);
    test.director.start(0x12, true);
    await test.tick();
    expect(test.director.sceneOf(0x64)).toBe(0x12);
    expect(test.director.isPlaying(0x11)).toBe(false);
  });

  it('does not start without its quest or a required actor; an optional one may be missing', async () => {
    const test = setup([
      scene(0x10, { actors: [actor(0), actor(5)], phases: [phase([], [truth(9)])] }),
      scene(0x11, {
        actors: [actor(0), actor(5, SceneActorFlag.optional)],
        phases: [phase([], [truth(9)])],
        quest: 0x501,
      }),
      scene(0x12, {
        actors: [actor(0), actor(5, SceneActorFlag.optional)],
        phases: [phase([], [truth(9)])],
      }),
    ]);
    for (const formId of [0x10, 0x11, 0x12]) test.director.start(formId);
    await test.tick();
    expect(test.director.isPlaying(0x10)).toBe(false);
    expect(test.director.isPlaying(0x11)).toBe(false);
    expect(test.director.isPlaying(0x12)).toBe(true);
  });

  it('casts a dead actor whose death does not end it (done with); one whose death ends it keeps it from starting', async () => {
    const test = setup([
      // MQ101AlduinAttackScene1: StormcloakPrisoner01, beheaded before it, behaviour none.
      scene(0x10, {
        actors: [actor(0), actor(1, 0, 0)],
        phases: [phase([], [truth(9)])],
        actions: [line(1, 1, 0, 0, 0xa1), line(2, 0, 0, 0, 0xa2)],
      }),
      scene(0x11, { actors: [actor(0), actor(1)], phases: [phase([], [truth(9)])] }),
    ]);
    test.states.set(0x65, { dead: true });
    test.director.start(0x10);
    test.director.start(0x11);
    await test.tick();
    expect(test.director.isPlaying(0x10)).toBe(true);
    expect(test.director.isPlaying(0x11)).toBe(false);
    // The dead actor's line is done at once (nothing said); the living one's is said.
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    expect(test.only('say')).toEqual(['say 64 a2']);
  });

  it('pauses while its actor talks with the player and ends when one dies', async () => {
    const test = setup([
      scene(0x10, {
        actors: [
          actor(0, 0, SceneActorBehaviour.dialoguePause | SceneActorBehaviour.deathEnd),
          actor(1, SceneActorFlag.noPlayerActivation, 0),
        ],
        phases: [phase(), phase([], [truth(9)])],
        actions: [timer(1, 0, 0, 1)],
        flags: SceneFlag.stopQuestOnEnd,
      }),
    ]);
    test.director.start(0x10);
    await test.tick();
    expect(test.director.blocksActivation(0x65)).toBe(true);
    expect(test.director.blocksActivation(0x64)).toBe(false);
    test.states.set(0x64, { talking: true });
    await test.tick(5);
    expect(test.director.actionComplete(0x10, 1)).toBe(false);
    test.states.delete(0x64);
    await test.tick(1.1);
    expect(test.director.actionComplete(0x10, 1)).toBe(true);
    test.states.set(0x64, { dead: true });
    await test.tick();
    await test.tick();
    expect(test.director.isPlaying(0x10)).toBe(false);
    expect(test.only('stop quest')).toEqual(['stop quest 500']);
  });

  it('begins with its quest, ends as it stops, repeats while its conditions hold', async () => {
    const test = setup([
      scene(0x10, {
        actors: [actor(0)],
        phases: [phase([], [truth(9)])],
        flags: SceneFlag.beginOnQuestStart,
      }),
      scene(0x11, {
        actors: [actor(1)],
        phases: [phase()],
        actions: [line(1, 1, 0, 0, 0xa1)],
        flags: SceneFlag.beginOnQuestStart | SceneFlag.repeatConditionsWhileTrue,
        conditions: [truth(8)],
      }),
    ]);
    test.truths.add(8);
    await test.director.questStarted(QUEST);
    await test.tick();
    expect(test.director.isPlaying(0x10)).toBe(true);
    // The repeating scene says its line once a round while its conditions hold.
    await test.tick();
    await test.tick();
    await test.tick();
    expect(test.only('say').length).toBeGreaterThanOrEqual(2);
    test.truths.delete(8);
    await test.tick();
    await test.tick();
    expect(test.director.isPlaying(0x11)).toBe(false);
    test.running.delete(QUEST);
    test.director.questStopped(QUEST);
    expect(test.director.isPlaying(0x10)).toBe(false);
    expect(test.director.sceneOf(0x64)).toBeUndefined();
  });
});

describe('random scenes (the Actor Dialogue event)', () => {
  const OTHER_QUEST = 0x501;
  const talk = (formId: number, quest: number, flags = 0): SceneRecord =>
    scene(formId, {
      quest,
      flags,
      actors: [actor(0), actor(1)],
      phases: [phase()],
      actions: [line(1, 0, 0, 0, 0x700 + formId)],
    });

  it('plays one at a time: the next begins as the first ends', async () => {
    const asked: string[] = [];
    const test = setup([talk(0x20, QUEST), talk(0x21, OTHER_QUEST)], () => ({
      randomScene: () => true,
      randomSceneStarts: (formId, first, second) => {
        asked.push(`${formId.toString(16)} ${first.toString(16)} ${second.toString(16)}`);
        return true;
      },
      randomSceneAgain: () => 3,
    }));
    test.running.add(OTHER_QUEST);
    test.slow.add(0x720);
    test.director.start(0x20);
    await test.tick();
    expect(test.director.randomScene).toBe(0x20);
    // The world was asked to bring its first two actors together.
    expect(asked).toEqual(['20 64 65']);
    test.director.start(0x21);
    await test.tick();
    expect(test.director.waiting).toEqual([0x21]);
    test.finish(0x720);
    await test.tick();
    await test.tick();
    // The waiting start begins in the update after the one that retried it.
    await test.tick();
    // The pause drawn as the first began is cleared as it ends (read from the engine).
    expect(test.director.randomScene).toBe(0x21);
  });

  it('waits a second when an actor of it plays in another scene', async () => {
    const test = setup(
      [
        talk(0x20, QUEST),
        scene(0x22, { quest: 0x502, actors: [actor(0)], phases: [phase([], [truth(9)])] }),
      ],
      () => ({ randomScene: (quest) => quest !== 0x502, randomSceneStarts: () => true }),
    );
    test.running.add(0x502);
    test.slow.add(0x720);
    test.director.start(0x22);
    await test.tick();
    test.director.start(0x20);
    await test.tick();
    expect(test.director.waiting).toEqual([0x20]);
    test.director.stop(0x22);
    await test.tick(0.5);
    expect(test.director.isPlaying(0x20)).toBe(false);
    await test.tick(0.6);
    await test.tick();
    expect(test.director.randomScene).toBe(0x20);
  });

  it('does not play when its actors may no longer talk; its quest stops with Stop Quest on End', async () => {
    const test = setup([talk(0x20, QUEST, SceneFlag.stopQuestOnEnd)], () => ({
      randomScene: () => true,
      randomSceneStarts: () => false,
    }));
    test.director.start(0x20);
    await test.tick();
    expect(test.director.isPlaying(0x20)).toBe(false);
    expect(test.only('say')).toEqual([]);
    expect(test.only('stop quest')).toEqual(['stop quest 500']);
  });

  it('holds while its actors come together, then says its lines', async () => {
    const test = setup([talk(0x20, QUEST)], (director) => ({
      randomScene: () => true,
      randomSceneStarts: (_scene, first) => {
        director().hold(first, true);
        return true;
      },
    }));
    test.director.start(0x20);
    await test.tick();
    await test.tick();
    expect(test.director.isPlaying(0x20)).toBe(true);
    expect(test.only('say')).toEqual([]);
    test.director.hold(0x64, false);
    await test.tick();
    await test.tick();
    expect(test.only('say')).toEqual(['say 64 720']);
  });
});
