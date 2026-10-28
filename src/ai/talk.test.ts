import { describe, expect, it } from 'vitest';
import { InterruptFlag } from './package-records.ts';
import {
  NO_PACKAGE_INTERRUPTS,
  TalkPlanner,
  greetingHolds,
  talkSettings,
  triggerDistance,
  VANILLA_TALK,
  type TalkActor,
  type TalkScene,
} from './talk.ts';

const actor = (reference: number, x: number, more: Partial<TalkActor> = {}): TalkActor => ({
  reference,
  position: [x, 0, 0],
  interrupts: NO_PACKAGE_INTERRUPTS,
  free: true,
  inScene: false,
  canSpeak: true,
  posture: 'standing',
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

/** A planner whose timers start (and are drawn) at their least. */
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

describe('asks for scenes between actors (the Actor Dialogue event)', () => {
  const talker = (reference: number, x: number, more: Partial<TalkActor> = {}): TalkActor =>
    actor(reference, x, {
      interrupts: InterruptFlag.randomConversations,
      seesPlayer: false,
      ...more,
    });

  it('on its social timer asks the first in order within the radius, with no chance roll', () => {
    // Every roll would miss a chance: there is none.
    const talk = new TalkPlanner(VANILLA_TALK, () => 0.99);
    const fresh = new TalkPlanner(VANILLA_TALK, () => 0);
    const actors = [talker(1, 0), talker(2, 450), talker(3, 300), talker(4, 900)];
    expect(fresh.update(9, actors, scene())).toEqual([]);
    expect(fresh.update(1, actors, scene())).toEqual([{ kind: 'ask', actor: 1, partner: 2 }]);
    // Timers drawn at the top of fAISocialTimerForConversationsMin .. Max still run out.
    expect(talk.update(VANILLA_TALK.socialMax, actors, scene())).toEqual([
      { kind: 'ask', actor: 1, partner: 2 },
    ]);
  });

  it('keeps both taken while the ask waits or its scene plays', () => {
    const talk = planner();
    const actors = [talker(1, 0), talker(2, 100), talker(3, 200)];
    expect(talk.update(10, actors, scene())).toEqual([{ kind: 'ask', actor: 1, partner: 2 }]);
    expect(talk.partnerOf(1)).toBe(2);
    expect(talk.partnerOf(2)).toBe(1);
    // The third finds neither while they are taken.
    expect(talk.update(1, actors, scene())).toEqual([]);
    talk.answered(1, 2, true);
    expect(talk.update(1, actors, scene())).toEqual([]);
    // Their scene is over: free again, each with its social timer drawn anew.
    talk.released(1);
    expect(talk.partnerOf(2)).toBeUndefined();
    expect(talk.update(1, actors, scene())).toEqual([{ kind: 'ask', actor: 3, partner: 1 }]);
  });

  it('without a quest both are free again, but not asking each other until their lists clear', () => {
    const talk = planner();
    const actors = [talker(1, 0), talker(2, 100)];
    expect(talk.update(10, actors, scene())).toEqual([{ kind: 'ask', actor: 1, partner: 2 }]);
    talk.answered(1, 2, false);
    expect(talk.partnerOf(1)).toBeUndefined();
    // The second may ask at once (only the first of the two drew its timer), the first once its
    // timer ran out; but each has the other on its list until it is cleared
    // (fAItalktosameNPCtimer, counted while the actor looks).
    expect(talk.update(1, actors, scene())).toEqual([]);
    expect(talk.update(9, actors, scene())).toEqual([]);
    expect(talk.update(VANILLA_TALK.talkedWithTimer, actors, scene())).toEqual([
      { kind: 'ask', actor: 1, partner: 2 },
    ]);
  });

  it('asks only where its package allows random conversations, awake, in no scene', () => {
    const blocked = [
      [talker(1, 0, { interrupts: InterruptFlag.hellosToPlayer }), talker(2, 100)],
      [talker(1, 0, { inScene: true }), talker(2, 100, { inScene: true })],
      [talker(1, 0, { posture: 'sleeping' }), talker(2, 100, { posture: 'sleeping' })],
      [talker(1, 0, { canSpeak: false }), talker(2, 100, { canSpeak: false })],
      [talker(1, 0, { free: false }), talker(2, 100, { free: false })],
    ];
    for (const actors of blocked) expect(planner().update(10, actors, scene())).toEqual([]);
    // Not while the player talks with someone, nor far from them (fDistancetoPlayerforConversations).
    expect(
      planner().update(10, [talker(1, 0), talker(2, 100)], scene({ playerBusy: true })),
    ).toEqual([]);
    expect(planner().update(10, [talker(1, 4000), talker(2, 4100)], scene())).toEqual([]);
    // One seated may be asked; one in other furniture or on its way in may not.
    expect(
      planner().update(10, [talker(1, 0), talker(2, 100, { posture: 'sitting' })], scene()),
    ).toEqual([{ kind: 'ask', actor: 1, partner: 2 }]);
    const settling = [talker(1, 0, { posture: 'other' }), talker(2, 100, { posture: 'other' })];
    expect(planner().update(10, settling, scene())).toEqual([]);
  });

  it('inside, asks only one on its floor; out of doors any within the radius', () => {
    const above = [talker(1, 0), talker(2, 100, { position: [100, 0, 120] })];
    expect(planner().update(10, above, scene({ interior: true }))).toEqual([]);
    expect(planner().update(10, above, scene({ interior: false }))).toEqual([
      { kind: 'ask', actor: 1, partner: 2 },
    ]);
    // The radius (fAISocialRadiusToTriggerConversation, 500 in the vanilla load order).
    expect(planner().update(10, [talker(1, 0), talker(2, 600)], scene())).toEqual([]);
  });

  it('may still talk as their scene begins: looked at again', () => {
    const talk = planner();
    const one = talker(1, 0);
    const two = talker(2, 100);
    expect(talk.mayTalk(one, two, scene())).toBe(true);
    expect(talk.mayTalk(one, { ...two, posture: 'sleeping' }, scene())).toBe(false);
    expect(talk.mayTalk({ ...one, posture: 'sleeping' }, two, scene())).toBe(false);
    expect(talk.mayTalk(one, two, scene({ playerBusy: true }))).toBe(false);
    // In their scene already: that does not keep them from it.
    expect(talk.mayTalk({ ...one, inScene: true }, { ...two, inScene: true }, scene())).toBe(true);
  });

  it('the one that starts walks up to the trigger distance; both resting, they stay', () => {
    const s = VANILLA_TALK;
    expect(triggerDistance(s, 'standing', 'standing')).toBe(s.conversationDistance);
    expect(triggerDistance(s, 'standing', 'sitting')).toBe(s.conversationDistance);
    expect(triggerDistance(s, 'sitting', 'standing')).toBe(s.conversationDistance + 20);
    expect(triggerDistance(s, 'sitting', 'sleeping')).toBe(s.conversationDistanceMax + 20);
    expect(triggerDistance(s, 'sleeping', 'sitting')).toBe(s.conversationDistanceMax);
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
      name === 'fAIGreetingTimer' ? 8 : name === 'fAISocialTimerToWaitForEvent' ? 25 : undefined,
    );
    expect(settings.greetingTimer).toBe(8);
    expect(settings.waitForEvent).toBe(25);
    expect(settings.exclusiveGreetingTimer).toBe(2.5);
    // Not in the vanilla load order: the engine's built-in values.
    expect(settings.dialogueDistance).toBe(170);
    expect(settings.talkedWithTimer).toBe(120);
  });

  it('greets from fAIMinGreetingDistance and lets go when the player walks off', () => {
    const settings = talkSettings((name) =>
      name === 'fAIMinGreetingDistance'
        ? 200
        : name === 'fAIInDialogueModeWithPlayerDistance'
          ? 400
          : undefined,
    );
    expect(settings.greetingDistance).toBe(200);
    expect(greetingHolds([0, 0, 0], [399, 0, 0], settings)).toBe(true);
    expect(greetingHolds([0, 0, 0], [401, 0, 0], settings)).toBe(false);
    expect(greetingHolds([0, 0, 0], undefined, VANILLA_TALK)).toBe(false);
  });
});
