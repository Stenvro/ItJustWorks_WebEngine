import { describe, expect, it } from 'vitest';
import { InterruptFlag } from './package-records.ts';
import {
  converse,
  NO_PACKAGE_INTERRUPTS,
  TalkPlanner,
  talkSettings,
  VANILLA_TALK,
  type TalkActor,
  type TalkScene,
} from './talk.ts';

const actor = (reference: number, x: number, more: Partial<TalkActor> = {}): TalkActor => ({
  reference,
  position: [x, 0, 0],
  interrupts: NO_PACKAGE_INTERRUPTS,
  sociable: false,
  free: true,
  seesPlayer: true,
  ...more,
});

const scene = (more: Partial<TalkScene> = {}): TalkScene => ({
  player: [0, 0, 0],
  playerBusy: false,
  interior: true,
  chattering: false,
  ...more,
});

/** A planner whose chance always succeeds and whose timers start at their least. */
const planner = (): TalkPlanner => new TalkPlanner(VANILLA_TALK, () => 0);

describe('greetings', () => {
  it('greets the player once as they come near, again after they left and came back', () => {
    const talk = planner();
    // Far: nothing.
    expect(talk.update(0.1, [actor(1, 400)], scene())).toEqual([]);
    // Near: it greets, once.
    expect(talk.update(0.1, [actor(1, 100)], scene())).toEqual([{ kind: 'hello', actor: 1 }]);
    expect(talk.update(6, [actor(1, 100)], scene())).toEqual([]);
    // The player leaves and comes back: it greets again (its timer ran out meanwhile).
    talk.update(0.1, [actor(1, 400)], scene());
    expect(talk.update(0.1, [actor(1, 100)], scene())).toEqual([{ kind: 'hello', actor: 1 }]);
  });

  it('waits fAIGreetingTimer before it greets again', () => {
    const talk = planner();
    expect(talk.update(0.1, [actor(1, 100)], scene())).toHaveLength(1);
    talk.update(1, [actor(1, 400)], scene());
    // Back within 5 seconds of the greeting: not yet.
    expect(talk.update(1, [actor(1, 100)], scene())).toEqual([]);
    expect(talk.update(3.5, [actor(1, 100)], scene())).toEqual([{ kind: 'hello', actor: 1 }]);
  });

  it('greets only if its package allows hellos to the player', () => {
    const talk = planner();
    const quiet = actor(1, 100, { interrupts: InterruptFlag.randomConversations });
    expect(talk.update(0.1, [quiet], scene())).toEqual([]);
  });

  it('does not greet a player who talks with someone, nor when it cannot see them', () => {
    const talk = planner();
    expect(talk.update(0.1, [actor(1, 100)], scene({ playerBusy: true }))).toEqual([]);
    expect(talk.update(0.1, [actor(1, 100, { seesPlayer: false })], scene())).toEqual([]);
    expect(talk.update(0.1, [actor(1, 100, { free: false })], scene())).toEqual([]);
    expect(talk.update(0.1, [actor(1, 100)], scene())).toEqual([{ kind: 'hello', actor: 1 }]);
  });

  it('lets one greet at a time, the nearest first (fAIExclusiveGreetingTimer)', () => {
    const talk = planner();
    const two = [actor(1, 120), actor(2, 80)];
    expect(talk.update(0.1, two, scene())).toEqual([{ kind: 'hello', actor: 2 }]);
    expect(talk.update(2, two, scene())).toEqual([]);
    expect(talk.update(0.6, two, scene())).toEqual([{ kind: 'hello', actor: 1 }]);
  });
});

describe('idle chatter', () => {
  it('says a line on its timer when the player is near and its package allows chatter', () => {
    const talk = planner();
    const quiet = actor(1, 600, { interrupts: InterruptFlag.hellosToPlayer });
    const chatty = actor(2, 600, { interrupts: InterruptFlag.allowIdleChatter });
    expect(talk.update(9, [quiet, chatty], scene())).toEqual([]);
    expect(talk.update(1.5, [quiet, chatty], scene())).toEqual([{ kind: 'idle', actor: 2 }]);
    // Its timer starts again (10 to 20 seconds).
    expect(talk.update(5, [quiet, chatty], scene())).toEqual([]);
  });

  it('one line of chatter at a time, none far from the player', () => {
    const talk = planner();
    const chatty = (reference: number, x: number): TalkActor =>
      actor(reference, x, { interrupts: InterruptFlag.allowIdleChatter });
    expect(talk.update(10, [chatty(1, 600), chatty(2, 700)], scene())).toEqual([
      { kind: 'idle', actor: 1 },
    ]);
    expect(talk.update(10, [chatty(3, 600)], scene({ chattering: true }))).toEqual([]);
    expect(talk.update(10, [chatty(4, 5000)], scene())).toEqual([]);
  });
});

describe('conversations between actors', () => {
  const sociable = (reference: number, x: number, more: Partial<TalkActor> = {}): TalkActor =>
    actor(reference, x, {
      interrupts: InterruptFlag.randomConversations,
      sociable: true,
      seesPlayer: false,
      ...more,
    });

  it('starts one on its social timer with the nearest within the radius', () => {
    const talk = planner();
    const actors = [sociable(1, 0), sociable(2, 450), sociable(3, 300), sociable(4, 900)];
    expect(talk.update(9, actors, scene())).toEqual([]);
    expect(talk.update(1, actors, scene())).toEqual([
      { kind: 'conversation', actor: 1, listener: 3 },
      { kind: 'conversation', actor: 2, listener: 4 },
    ]);
  });

  it('needs both to be sociable and free, and not to have talked lately', () => {
    const talk = planner();
    const lone = [sociable(1, 0), sociable(2, 100, { sociable: false })];
    expect(talk.update(10, lone, scene())).toEqual([]);
    const pair = [sociable(1, 0), sociable(2, 100)];
    expect(talk.update(30, pair, scene())).toEqual([
      { kind: 'conversation', actor: 1, listener: 2 },
    ]);
    // They talked: not again with each other until the list is cleared.
    expect(talk.update(30, pair, scene())).toEqual([]);
    expect(talk.update(VANILLA_TALK.talkedWithTimer, pair, scene())).toEqual([
      { kind: 'conversation', actor: 1, listener: 2 },
    ]);
  });

  it('starts one by its chance (fAISocialchanceForConversation)', () => {
    // The roll misses (above 10 percent).
    const talk = new TalkPlanner(VANILLA_TALK, () => 0.5);
    expect(talk.update(30, [sociable(1, 0), sociable(2, 100)], scene())).toEqual([]);
  });

  it('take turns: Hello each, then Idle lines, until one has nothing to say', async () => {
    const said: string[] = [];
    const lines = await converse(
      1,
      2,
      (speaker, listener, subtype) => {
        said.push(`${String(speaker)}>${String(listener)} ${subtype}`);
        // The second has no idle chatter.
        return Promise.resolve(!(speaker === 2 && subtype === 'IDLE'));
      },
      () => true,
      6,
    );
    expect(said).toEqual(['1>2 HELO', '2>1 HELO', '1>2 IDLE', '2>1 IDLE']);
    expect(lines).toBe(3);
  });

  it('stop when broken off', async () => {
    let going = true;
    const said: number[] = [];
    const lines = await converse(
      1,
      2,
      (speaker) => {
        said.push(speaker);
        going = false;
        return Promise.resolve(true);
      },
      () => going,
    );
    expect(said).toEqual([1]);
    expect(lines).toBe(1);
  });
});

describe('comments on what the player does', () => {
  it('the nearest that may react comments, then not again within its timer', () => {
    const talk = planner();
    const reacting = InterruptFlag.reactionToPlayerActions;
    const actors = [
      actor(1, 300, { interrupts: reacting }),
      actor(2, 200, { interrupts: InterruptFlag.hellosToPlayer }),
    ];
    talk.update(0, actors, scene());
    expect(talk.commenter(actors, scene(), false)).toBe(1);
    expect(talk.commenter(actors, scene(), false)).toBeUndefined();
    talk.update(VANILLA_TALK.playerActionTimer, actors, scene());
    expect(talk.commenter(actors, scene(), false)).toBe(1);
    // Knocking things over waits longer (fCommentOnPlayerKnockingThings).
    talk.update(VANILLA_TALK.playerActionTimer, actors, scene());
    expect(talk.commenter(actors, scene(), true)).toBeUndefined();
  });
});

describe('settings', () => {
  it('reads the game settings, keeping vanilla values for those not set', () => {
    const settings = talkSettings((name) =>
      name === 'fAIGreetingTimer' ? 8 : name === 'fAISocialchanceForConversation' ? 25 : undefined,
    );
    expect(settings.greetingTimer).toBe(8);
    expect(settings.conversationChance).toBe(25);
    expect(settings.exclusiveGreetingTimer).toBe(2.5);
  });
});
