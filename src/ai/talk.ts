// Talking outside conversations with the player (docs/ai.md, "Talking"): which of the actors
// near the player greets them as they pass, says a line of idle chatter, starts a conversation
// with another actor or comments on what the player does, and the turns of a conversation
// between two actors. What the engine keeps for it per actor is CommonLibSSE's HighProcessData
// (greetingTimer, exclusiveTimer, idleTimer, checkToTalkTimer "fAISocialTimerForConversationsMin",
// lastSpokenToArray, clearTalkToListTimer); the running package allows each (PKDT interrupt
// flags: hellos to the player, random conversations, idle chatter, reactions to the player's
// actions); the timers are the game settings below. How the engine combines them is not
// documented: the rules here follow the settings' names and are marked TODO(M13) where they
// are this file's own. What is said is the dialogue engine's (subtype lines,
// src/scripting/runtime/dialogue-engine.ts). Platform-independent.

import { InterruptFlag } from './package-records.ts';

type Vec3 = readonly [number, number, number];

export interface TalkSettings {
  /** Seconds before an actor greets the player again (fAIGreetingTimer). */
  readonly greetingTimer: number;
  /** Seconds after a greeting before another actor greets the player (fAIExclusiveGreetingTimer). */
  readonly exclusiveGreetingTimer: number;
  /**
   * An actor greets the player as they come this near (units). No game setting of the load
   * order gives it (TODO(M13): the engine's built-in distance).
   */
  readonly greetingDistance: number;
  /** Seconds between an actor's lines of idle chatter (fIdleChatterCommentTimer .. Max). */
  readonly idleChatterMin: number;
  readonly idleChatterMax: number;
  /** Idle chatter is said within this of the player (units; TODO(M13): the engine's reach). */
  readonly chatterDistance: number;
  /**
   * Seconds between an actor's looks for someone to talk to (fAISocialTimerForConversationsMin
   * .. Max), the percent chance one starts a conversation (fAISocialchanceForConversation,
   * inside: ...Interior) and how far it looks (fAISocialRadiusToTriggerConversation, inside:
   * ...Interior).
   */
  readonly socialMin: number;
  readonly socialMax: number;
  readonly conversationChance: number;
  readonly conversationChanceInterior: number;
  readonly conversationRadius: number;
  readonly conversationRadiusInterior: number;
  /**
   * Two actors talk within this of each other (units): the one that starts walks up to the
   * other (iAISocialDistanceToTriggerEvent).
   */
  readonly conversationDistance: number;
  /**
   * Seconds before two actors talk with each other again (the engine clears its list of those
   * it spoke to, lastSpokenToArray, on clearTalkToListTimer; TODO(M13): its time).
   */
  readonly talkedWithTimer: number;
  /**
   * Seconds between an actor's comments on what the player does (fCommentOnPlayerActionsTimer),
   * on the player knocking things over (fCommentOnPlayerKnockingThings).
   */
  readonly playerActionTimer: number;
  readonly knockingTimer: number;
}

/** The vanilla values (Skyrim.esm's game settings; the distances this file's own). */
export const VANILLA_TALK: TalkSettings = {
  greetingTimer: 5,
  exclusiveGreetingTimer: 2.5,
  greetingDistance: 150,
  idleChatterMin: 10,
  idleChatterMax: 20,
  chatterDistance: 1024,
  socialMin: 10,
  socialMax: 30,
  conversationChance: 10,
  conversationChanceInterior: 10,
  conversationRadius: 500,
  conversationRadiusInterior: 500,
  conversationDistance: 200,
  talkedWithTimer: 120,
  playerActionTimer: 20,
  knockingTimer: 40,
};

/** The settings from the game's (a setting the load order does not have keeps its vanilla value). */
export function talkSettings(setting: (name: string) => number | undefined): TalkSettings {
  const v = VANILLA_TALK;
  return {
    ...v,
    greetingTimer: setting('fAIGreetingTimer') ?? v.greetingTimer,
    exclusiveGreetingTimer: setting('fAIExclusiveGreetingTimer') ?? v.exclusiveGreetingTimer,
    idleChatterMin: setting('fIdleChatterCommentTimer') ?? v.idleChatterMin,
    idleChatterMax: setting('fIdleChatterCommentTimerMax') ?? v.idleChatterMax,
    socialMin: setting('fAISocialTimerForConversationsMin') ?? v.socialMin,
    socialMax: setting('fAISocialTimerForConversationsMax') ?? v.socialMax,
    conversationChance: setting('fAISocialchanceForConversation') ?? v.conversationChance,
    conversationChanceInterior:
      setting('fAISocialchanceForConversationInterior') ?? v.conversationChanceInterior,
    conversationRadius: setting('fAISocialRadiusToTriggerConversation') ?? v.conversationRadius,
    conversationRadiusInterior:
      setting('fAISocialRadiusToTriggerConversationInterior') ?? v.conversationRadiusInterior,
    conversationDistance: setting('iAISocialDistanceToTriggerEvent') ?? v.conversationDistance,
    playerActionTimer: setting('fCommentOnPlayerActionsTimer') ?? v.playerActionTimer,
    knockingTimer: setting('fCommentOnPlayerKnockingThings') ?? v.knockingTimer,
  };
}

/** The interrupt flags of an actor that runs no package: it may do all. TODO(M13). */
export const NO_PACKAGE_INTERRUPTS = 0xffff;

/** An actor of the high process as talking sees it now. */
export interface TalkActor {
  readonly reference: number;
  readonly position: Vec3;
  /** The interrupt flags of the package it runs (PKDT, InterruptFlag). */
  readonly interrupts: number;
  /** It may start or join a conversation (a sandbox's Allow Conversation; not on its way). */
  readonly sociable: boolean;
  /**
   * It can talk now: alive, awake, not saying a line, not in a conversation, a scene or combat,
   * not talking with the player.
   */
  readonly free: boolean;
  /** It is aware of the player (it detects them). */
  readonly seesPlayer: boolean;
}

/** What talking sees of the player and the place. */
export interface TalkScene {
  readonly player: Vec3 | undefined;
  /** The player talks with someone (no one greets them or chatters at them meanwhile). */
  readonly playerBusy: boolean;
  readonly interior: boolean;
  /** Someone says a line of idle chatter now (one at a time). TODO(M13). */
  readonly chattering: boolean;
}

export type TalkIntent =
  | { readonly kind: 'hello'; readonly actor: number }
  | { readonly kind: 'idle'; readonly actor: number }
  | { readonly kind: 'conversation'; readonly actor: number; readonly listener: number };

/** What talking keeps of an actor. */
interface Talker {
  /** Seconds since it last greeted the player. */
  sinceGreeting: number;
  /** It greeted the player since they last came near (it greets again once they left). */
  greeted: boolean;
  /** Seconds to its next line of idle chatter and its next look for someone to talk to. */
  idle: number;
  social: number;
  /** Seconds since it commented on what the player does. */
  sinceComment: number;
  /** Those it talked with lately: seconds since. */
  readonly talkedWith: Map<number, number>;
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The player has left an actor's greeting distance once this much farther (no churn). */
const GREETING_LEAVE = 1.25;

export class TalkPlanner {
  readonly #settings: TalkSettings;
  readonly #random: () => number;
  readonly #talkers = new Map<number, Talker>();
  /** Seconds before anyone greets the player again (after a greeting). */
  #exclusive = 0;

  constructor(settings: TalkSettings, random: () => number) {
    this.#settings = settings;
    this.#random = random;
  }

  #between(min: number, max: number): number {
    return min + (Math.max(min, max) - min) * this.#random();
  }

  #talker(reference: number): Talker {
    let talker = this.#talkers.get(reference);
    if (!talker) {
      const s = this.#settings;
      talker = {
        sinceGreeting: Infinity,
        greeted: false,
        // Not all at once: each starts somewhere in its timer.
        idle: this.#between(s.idleChatterMin, s.idleChatterMax),
        social: this.#between(s.socialMin, s.socialMax),
        sinceComment: Infinity,
        talkedWith: new Map(),
      };
      this.#talkers.set(reference, talker);
    }
    return talker;
  }

  /**
   * Seconds pass: who greets, chatters and starts a conversation now. At most one greeting (the
   * nearest of those the player came near), one line of chatter and one conversation start
   * each time; the actors named are not free until the shell says so again.
   */
  update(seconds: number, actors: readonly TalkActor[], scene: TalkScene): TalkIntent[] {
    const s = this.#settings;
    const intents: TalkIntent[] = [];
    this.#exclusive = Math.max(0, this.#exclusive - seconds);
    const present = new Set<number>();
    for (const actor of actors) {
      present.add(actor.reference);
      const talker = this.#talker(actor.reference);
      talker.sinceGreeting += seconds;
      talker.sinceComment += seconds;
      talker.idle -= seconds;
      talker.social -= seconds;
      for (const [other, since] of talker.talkedWith) {
        if (since + seconds >= s.talkedWithTimer) talker.talkedWith.delete(other);
        else talker.talkedWith.set(other, since + seconds);
      }
    }
    for (const reference of [...this.#talkers.keys()]) {
      if (!present.has(reference)) this.#talkers.delete(reference);
    }
    const busy = new Set<number>();
    const player = scene.player;

    // Greetings: as the player comes within an actor's greeting distance it greets them, if its
    // package lets it and it has not greeted them within fAIGreetingTimer; one at a time
    // (fAIExclusiveGreetingTimer), the nearest first.
    if (player) {
      let nearest: { actor: TalkActor; away: number } | undefined;
      for (const actor of actors) {
        const talker = this.#talker(actor.reference);
        const away = distance(actor.position, player);
        if (away > s.greetingDistance * GREETING_LEAVE) talker.greeted = false;
        if (
          scene.playerBusy ||
          this.#exclusive > 0 ||
          talker.greeted ||
          !actor.free ||
          !actor.seesPlayer ||
          (actor.interrupts & InterruptFlag.hellosToPlayer) === 0 ||
          away > s.greetingDistance ||
          talker.sinceGreeting < s.greetingTimer
        ) {
          continue;
        }
        if (!nearest || away < nearest.away) nearest = { actor, away };
      }
      if (nearest) {
        const talker = this.#talker(nearest.actor.reference);
        talker.greeted = true;
        talker.sinceGreeting = 0;
        this.#exclusive = s.exclusiveGreetingTimer;
        busy.add(nearest.actor.reference);
        intents.push({ kind: 'hello', actor: nearest.actor.reference });
      }
    }

    // Idle chatter: an actor whose timer ran out says a line to the player near it, if its
    // package allows idle chatter; its timer starts again either way.
    let chattered = scene.chattering;
    for (const actor of actors) {
      const talker = this.#talker(actor.reference);
      if (talker.idle > 0) continue;
      talker.idle = this.#between(s.idleChatterMin, s.idleChatterMax);
      if (
        chattered ||
        !player ||
        scene.playerBusy ||
        busy.has(actor.reference) ||
        !actor.free ||
        !actor.seesPlayer ||
        (actor.interrupts & InterruptFlag.allowIdleChatter) === 0 ||
        distance(actor.position, player) > s.chatterDistance
      ) {
        continue;
      }
      chattered = true;
      busy.add(actor.reference);
      intents.push({ kind: 'idle', actor: actor.reference });
    }

    // Conversations: an actor whose timer ran out starts one by chance with the nearest within
    // its radius who may talk too and with whom it has not talked lately.
    const chance = scene.interior ? s.conversationChanceInterior : s.conversationChance;
    const radius = scene.interior ? s.conversationRadiusInterior : s.conversationRadius;
    const mayConverse = (actor: TalkActor): boolean =>
      actor.free &&
      actor.sociable &&
      !busy.has(actor.reference) &&
      (actor.interrupts & InterruptFlag.randomConversations) !== 0;
    for (const actor of actors) {
      const talker = this.#talker(actor.reference);
      if (talker.social > 0) continue;
      talker.social = this.#between(s.socialMin, s.socialMax);
      if (!mayConverse(actor) || this.#random() * 100 >= chance) continue;
      let listener: { actor: TalkActor; away: number } | undefined;
      for (const other of actors) {
        if (other === actor || !mayConverse(other) || talker.talkedWith.has(other.reference)) {
          continue;
        }
        const away = distance(actor.position, other.position);
        if (away <= radius && (!listener || away < listener.away))
          listener = { actor: other, away };
      }
      if (!listener) continue;
      const reference = listener.actor.reference;
      talker.talkedWith.set(reference, 0);
      this.#talker(reference).talkedWith.set(actor.reference, 0);
      busy.add(actor.reference);
      busy.add(reference);
      intents.push({ kind: 'conversation', actor: actor.reference, listener: reference });
    }
    return intents;
  }

  /**
   * The player did something the actors near comment on (swinging a weapon, shooting, knocking
   * things over, ...): the nearest free one that sees them within the chatter distance, whose
   * package lets it react to the player's actions and who has not commented within its timer
   * (fCommentOnPlayerActionsTimer; knocking things over: fCommentOnPlayerKnockingThings).
   */
  commenter(actors: readonly TalkActor[], scene: TalkScene, knocking: boolean): number | undefined {
    const s = this.#settings;
    const player = scene.player;
    if (!player || scene.playerBusy) return undefined;
    const timer = knocking ? s.knockingTimer : s.playerActionTimer;
    let nearest: { reference: number; away: number } | undefined;
    for (const actor of actors) {
      const away = distance(actor.position, player);
      if (
        !actor.free ||
        !actor.seesPlayer ||
        (actor.interrupts & InterruptFlag.reactionToPlayerActions) === 0 ||
        away > s.chatterDistance ||
        this.#talker(actor.reference).sinceComment < timer
      ) {
        continue;
      }
      if (!nearest || away < nearest.away) nearest = { reference: actor.reference, away };
    }
    if (nearest) this.#talker(nearest.reference).sinceComment = 0;
    return nearest?.reference;
  }
}

/**
 * The topic subtype of a conversation's turn: each greets the other first (Hello), then they
 * take turns with idle chatter (Idle). TODO(M13): the engine's choice of topics for random
 * conversations is not documented.
 */
export function conversationSubtype(turn: number): string {
  return turn < 2 ? 'HELO' : 'IDLE';
}

/** A conversation between two actors says this many lines at most. TODO(M13). */
export const CONVERSATION_LINES = 4;

/**
 * A conversation between two actors: they take turns, the first beginning, each saying to the
 * other the line its turn's subtype gives it (`say`: whether it had one to say, resolving once
 * said). It ends when the one whose turn it is has nothing to say, after `lines` lines, or when
 * it is broken off (`goesOn` false: one of them is wanted elsewhere). Resolves to the lines said.
 */
export async function converse(
  first: number,
  second: number,
  say: (speaker: number, listener: number, subtype: string) => Promise<boolean>,
  goesOn: () => boolean,
  lines = CONVERSATION_LINES,
): Promise<number> {
  let said = 0;
  for (let turn = 0; turn < lines && goesOn(); turn++) {
    const [speaker, listener] = turn % 2 === 0 ? [first, second] : [second, first];
    if (!(await say(speaker, listener, conversationSubtype(turn)))) break;
    said++;
  }
  return said;
}
