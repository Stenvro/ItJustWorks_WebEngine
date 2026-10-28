// Talking outside conversations with the player (docs/ai.md, "Talking"): which of the actors
// near the player greets them as they pass, says a line of idle chatter, asks the story manager
// for a scene with another actor (the Actor Dialogue event, ADIA) or comments on what the
// player does, and when a scene the story manager started for two actors may begin. What the
// engine keeps for it per actor is CommonLibSSE's HighProcessData (greetingTimer,
// exclusiveTimer, idleTimer, checkToTalkTimer, lastSpokenToArray, clearTalkToListTimer); the
// running package allows each (PKDT interrupt flags: hellos to the player, random
// conversations, idle chatter, reactions to the player's actions); the timers are the game
// settings below. The conversations between actors follow the engine's own rule, observed in
// it (docs/ai.md, "Conversations between actors"); the greetings and the chatter follow
// the settings' names, marked TODO(M13) where they are this file's own. What is said is the
// dialogue engine's (subtype lines, src/scripting/runtime/dialogue-engine.ts) and the scenes'
// (src/ai/scene-runtime.ts). Platform-independent.

import { InterruptFlag } from './package-records.ts';

type Vec3 = readonly [number, number, number];

export interface TalkSettings {
  /** Seconds before an actor greets the player again (fAIGreetingTimer). */
  readonly greetingTimer: number;
  /** Seconds after a greeting before another actor greets the player (fAIExclusiveGreetingTimer). */
  readonly exclusiveGreetingTimer: number;
  /** An actor greets the player as they come this near (units; fAIMinGreetingDistance). */
  readonly greetingDistance: number;
  /**
   * A greeting holds its actor (stopped, facing the player) while the player stays this near
   * (units; fAIInDialogueModeWithPlayerDistance); walking off past it lets the actor go on
   * with its package while the line plays out.
   */
  readonly greetingHoldDistance: number;
  /** Seconds between an actor's lines of idle chatter (fIdleChatterCommentTimer .. Max). */
  readonly idleChatterMin: number;
  readonly idleChatterMax: number;
  /** Idle chatter is said within this of the player (units; TODO(M13): the engine's reach). */
  readonly chatterDistance: number;
  /**
   * Seconds between an actor's asks for a scene with another actor
   * (fAISocialTimerForConversationsMin .. Max): drawn again each time the story manager
   * answered, counted while the actor is in no scene.
   */
  readonly socialMin: number;
  readonly socialMax: number;
  /**
   * How far from the one that asks the other may be (fAISocialRadiusToTriggerConversation;
   * where the one asking is in an interior, ...Interior).
   */
  readonly conversationRadius: number;
  readonly conversationRadiusInterior: number;
  /**
   * Both actors of a conversation are within this of the player (units;
   * fDistancetoPlayerforConversations).
   */
  readonly playerConversationDistance: number;
  /**
   * Seconds an actor keeps those it asked or was asked by (fAItalktosameNPCtimer): it does not
   * ask them again until its list is cleared.
   */
  readonly talkedWithTimer: number;
  /**
   * The one that starts a random scene walks up to within this of the other
   * (iAISocialDistanceToTriggerEvent); with both seated or asleep they talk from up to
   * iAIMaxSocialDistanceToTriggerEvent apart; seated, the one that starts reaches 20 more.
   */
  readonly conversationDistance: number;
  readonly conversationDistanceMax: number;
  /** Seconds DialogueActivate waits for a scene after its ask (fAISocialTimerToWaitForEvent). */
  readonly waitForEvent: number;
  /** DialogueActivate's actor walks up to within this of its target (fAIDialogueDistance). */
  readonly dialogueDistance: number;
  /**
   * A scene's line waits until its speaker faces whom it speaks to within this (degrees;
   * fAIMinAngleRangeToStartSceneDialogue): two actors brought together face each other so.
   */
  readonly sceneDialogueAngle: number;
  /** The same for a speaker moving at 5 units a second or more (degrees; fAIMaxAngleRangeMovingToStartSceneDialogue). */
  readonly sceneDialogueAngleMoving: number;
  /**
   * Seconds before the next random scene may begin, drawn as one begins
   * (fRandomSceneAgainMinTime .. MaxTime).
   */
  readonly randomSceneAgainMin: number;
  readonly randomSceneAgainMax: number;
  /**
   * Seconds between an actor's comments on what the player does (fCommentOnPlayerActionsTimer),
   * on the player knocking things over (fCommentOnPlayerKnockingThings).
   */
  readonly playerActionTimer: number;
  readonly knockingTimer: number;
}

/**
 * The values of the vanilla load order: Skyrim.esm's game settings, and for those it does not
 * set the engine's built-in values (observed in the original); the chatter distance is this file's own.
 */
export const VANILLA_TALK: TalkSettings = {
  greetingTimer: 5,
  exclusiveGreetingTimer: 2.5,
  greetingDistance: 150,
  greetingHoldDistance: 500,
  idleChatterMin: 10,
  idleChatterMax: 20,
  chatterDistance: 1024,
  socialMin: 10,
  socialMax: 30,
  conversationRadius: 500,
  conversationRadiusInterior: 500,
  playerConversationDistance: 3000,
  talkedWithTimer: 120,
  conversationDistance: 200,
  conversationDistanceMax: 500,
  waitForEvent: 20,
  dialogueDistance: 170,
  sceneDialogueAngle: 20,
  sceneDialogueAngleMoving: 80,
  randomSceneAgainMin: 10,
  randomSceneAgainMax: 30,
  playerActionTimer: 20,
  knockingTimer: 40,
};

/** The settings from the game's (a setting the load order does not have keeps its vanilla value). */
export function talkSettings(setting: (name: string) => number | undefined): TalkSettings {
  const v = VANILLA_TALK;
  return {
    ...v,
    greetingTimer: setting('fAIGreetingTimer') ?? v.greetingTimer,
    greetingDistance: setting('fAIMinGreetingDistance') ?? v.greetingDistance,
    greetingHoldDistance: setting('fAIInDialogueModeWithPlayerDistance') ?? v.greetingHoldDistance,
    exclusiveGreetingTimer: setting('fAIExclusiveGreetingTimer') ?? v.exclusiveGreetingTimer,
    idleChatterMin: setting('fIdleChatterCommentTimer') ?? v.idleChatterMin,
    idleChatterMax: setting('fIdleChatterCommentTimerMax') ?? v.idleChatterMax,
    socialMin: setting('fAISocialTimerForConversationsMin') ?? v.socialMin,
    socialMax: setting('fAISocialTimerForConversationsMax') ?? v.socialMax,
    conversationRadius: setting('fAISocialRadiusToTriggerConversation') ?? v.conversationRadius,
    conversationRadiusInterior:
      setting('fAISocialRadiusToTriggerConversationInterior') ?? v.conversationRadiusInterior,
    playerConversationDistance:
      setting('fDistancetoPlayerforConversations') ?? v.playerConversationDistance,
    talkedWithTimer: setting('fAItalktosameNPCtimer') ?? v.talkedWithTimer,
    conversationDistance: setting('iAISocialDistanceToTriggerEvent') ?? v.conversationDistance,
    conversationDistanceMax:
      setting('iAIMaxSocialDistanceToTriggerEvent') ?? v.conversationDistanceMax,
    waitForEvent: setting('fAISocialTimerToWaitForEvent') ?? v.waitForEvent,
    dialogueDistance: setting('fAIDialogueDistance') ?? v.dialogueDistance,
    sceneDialogueAngle: setting('fAIMinAngleRangeToStartSceneDialogue') ?? v.sceneDialogueAngle,
    sceneDialogueAngleMoving:
      setting('fAIMaxAngleRangeMovingToStartSceneDialogue') ?? v.sceneDialogueAngleMoving,
    randomSceneAgainMin: setting('fRandomSceneAgainMinTime') ?? v.randomSceneAgainMin,
    randomSceneAgainMax: setting('fRandomSceneAgainMaxTime') ?? v.randomSceneAgainMax,
    playerActionTimer: setting('fCommentOnPlayerActionsTimer') ?? v.playerActionTimer,
    knockingTimer: setting('fCommentOnPlayerKnockingThings') ?? v.knockingTimer,
  };
}

/** The interrupt flags of an actor that runs no package: it may do all. TODO(M13). */
export const NO_PACKAGE_INTERRUPTS = 0xffff;

/** How an actor is placed: on its feet, seated, asleep, or in other furniture or on its way in. */
export type TalkPosture = 'standing' | 'sitting' | 'sleeping' | 'other';

/** An actor of the high process as talking sees it now. */
export interface TalkActor {
  readonly reference: number;
  readonly position: Vec3;
  /** The interrupt flags of the package it runs (PKDT, InterruptFlag). */
  readonly interrupts: number;
  /**
   * It can talk now: alive, not saying a line, not in combat, not talking with the player, not
   * in a conversation with another actor.
   */
  readonly free: boolean;
  /** It plays in a scene (GetCurrentScene). */
  readonly inScene: boolean;
  /** It speaks at all (it has a voice: the engine's actor flag "can speak"). */
  readonly canSpeak: boolean;
  readonly posture: TalkPosture;
  /** It is aware of the player (it detects them). */
  readonly seesPlayer: boolean;
}

/** What talking sees of the player and the place. */
export interface TalkScene {
  readonly player: Vec3 | undefined;
  /** The player talks with someone (no one greets them, chatters or asks for a scene meanwhile). */
  readonly playerBusy: boolean;
  readonly interior: boolean;
  /** Someone says a line of idle chatter now (one at a time). TODO(M13). */
  readonly chattering: boolean;
}

export type TalkIntent =
  | { readonly kind: 'hello'; readonly actor: number }
  | { readonly kind: 'idle'; readonly actor: number }
  /** The actor asks the story manager for a scene with the partner (the ADIA event). */
  | { readonly kind: 'ask'; readonly actor: number; readonly partner: number };

/** What talking keeps of an actor. */
interface Talker {
  /** Seconds since it last greeted the player. */
  sinceGreeting: number;
  /** It greeted the player since they last came near (it greets again once they left). */
  greeted: boolean;
  /** Seconds to its next line of idle chatter and to its next ask for a scene. */
  idle: number;
  social: number;
  /** Seconds since it commented on what the player does. */
  sinceComment: number;
  /** Those it asked or was asked by (lastSpokenToArray), cleared when `sameTimer` runs out. */
  readonly talkedWith: Set<number>;
  sameTimer: number;
  /**
   * The one it asked or was asked by while the ask waits for the story manager or the scene
   * the story manager started plays (the engine's "in random scene" flag): it is not asked
   * again meanwhile.
   */
  partner: number | undefined;
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The player has left an actor's greeting distance once this much farther (no churn). */
const GREETING_LEAVE = 1.25;

/** In an interior, the one asked stands within this height of the one asking (one floor). */
const SAME_FLOOR = 90;

export class TalkPlanner {
  readonly #settings: TalkSettings;
  readonly #random: () => number;
  readonly #talkers = new Map<number, Talker>();
  /** Seconds before anyone greets the player again (after a greeting). */
  #exclusive = 0;
  /** The actors of the last update, in their order (the engine's high process list). */
  #order: readonly number[] = [];

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
        talkedWith: new Set(),
        sameTimer: s.talkedWithTimer,
        partner: undefined,
      };
      this.#talkers.set(reference, talker);
    }
    return talker;
  }

  /**
   * Seconds pass: who greets, chatters and asks for a scene now. At most one greeting (the
   * nearest of those the player came near) and one line of chatter each time; the actors named
   * are not free until the shell says so again.
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
      // The social timer counts while the actor plays in no scene.
      if (!actor.inScene) talker.social -= seconds;
    }
    for (const reference of [...this.#talkers.keys()]) {
      if (!present.has(reference)) this.#talkers.delete(reference);
    }
    this.#order = actors.map((actor) => actor.reference);
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
          actor.inScene ||
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
        actor.inScene ||
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

    // Asks for a scene: an actor whose social timer ran out looks, every update until it finds
    // one, through the actors in their order for the first it may talk with (no chance roll).
    for (const actor of actors) {
      const talker = this.#talker(actor.reference);
      if (busy.has(actor.reference) || !this.#mayAsk(actor, talker, scene)) continue;
      // The list of those it talked with is cleared every fAItalktosameNPCtimer it looks.
      talker.sameTimer -= seconds;
      if (talker.sameTimer <= 0) {
        talker.talkedWith.clear();
        talker.sameTimer = s.talkedWithTimer;
      }
      const radius = scene.interior ? s.conversationRadiusInterior : s.conversationRadius;
      const partner = actors.find(
        (other) =>
          !busy.has(other.reference) &&
          this.#mayBeAsked(other, actor, scene) &&
          distance(actor.position, other.position) <= radius &&
          !talker.talkedWith.has(other.reference),
      );
      if (!partner) continue;
      const other = this.#talker(partner.reference);
      talker.talkedWith.add(partner.reference);
      other.talkedWith.add(actor.reference);
      talker.partner = partner.reference;
      other.partner = actor.reference;
      busy.add(actor.reference);
      busy.add(partner.reference);
      intents.push({ kind: 'ask', actor: actor.reference, partner: partner.reference });
    }
    return intents;
  }

  /** Whether an actor may ask for a scene now. */
  #mayAsk(actor: TalkActor, talker: Talker, scene: TalkScene): boolean {
    const player = scene.player;
    return (
      player !== undefined &&
      !scene.playerBusy &&
      talker.social <= 0 &&
      talker.partner === undefined &&
      actor.free &&
      !actor.inScene &&
      actor.canSpeak &&
      actor.posture !== 'sleeping' &&
      (actor.interrupts & InterruptFlag.randomConversations) !== 0 &&
      distance(actor.position, player) <= this.#settings.playerConversationDistance
    );
  }

  /**
   * Whether another actor may be asked by one: it speaks, is free, on its feet or seated, its
   * package allows random conversations, it is near the player and, in an interior, on the
   * asking one's floor; and (unless `again`: the two are already each other's) in no scene and
   * no other ask.
   */
  #mayBeAsked(other: TalkActor, asking: TalkActor, scene: TalkScene, again = false): boolean {
    const player = scene.player;
    return (
      other.reference !== asking.reference &&
      player !== undefined &&
      (again || (this.#talker(other.reference).partner === undefined && !other.inScene)) &&
      other.free &&
      other.canSpeak &&
      (other.posture === 'standing' || other.posture === 'sitting') &&
      (other.interrupts & InterruptFlag.randomConversations) !== 0 &&
      (!scene.interior || Math.abs(other.position[2] - asking.position[2]) < SAME_FLOOR) &&
      distance(other.position, player) <= this.#settings.playerConversationDistance
    );
  }

  /**
   * Whether two actors may still talk as the scene the story manager started for them begins:
   * the engine looks again then, the second as the one asking and the first as the one asked.
   */
  mayTalk(first: TalkActor, second: TalkActor, scene: TalkScene): boolean {
    return (
      scene.player !== undefined &&
      !scene.playerBusy &&
      second.canSpeak &&
      second.free &&
      second.posture !== 'sleeping' &&
      (second.interrupts & InterruptFlag.randomConversations) !== 0 &&
      this.#mayBeAsked(first, second, scene, true)
    );
  }

  /**
   * The story manager answered an ask. With a quest both draw their social timers again and
   * stay taken until `released`; without one both are free again and the first of the two in
   * the actors' order draws its timer (the other may ask at once).
   */
  answered(actor: number, partner: number, gotQuest: boolean): void {
    const s = this.#settings;
    const draw = (reference: number): void => {
      const talker = this.#talkers.get(reference);
      if (talker) talker.social = this.#between(s.socialMin, s.socialMax);
    };
    if (gotQuest) {
      draw(actor);
      draw(partner);
      return;
    }
    this.released(actor);
    const first = this.#order.find((reference) => reference === actor || reference === partner);
    draw(first ?? actor);
  }

  /** The scene of an actor's ask is over (or never came): it and its partner are free again. */
  released(actor: number): void {
    const talker = this.#talkers.get(actor);
    const partner = talker?.partner;
    if (talker) talker.partner = undefined;
    const other = partner === undefined ? undefined : this.#talkers.get(partner);
    if (other?.partner === actor) other.partner = undefined;
  }

  /** The one an actor asked or was asked by, while that ask or its scene lasts. */
  partnerOf(actor: number): number | undefined {
    return this.#talkers.get(actor)?.partner;
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
 * Where the one that starts a random scene walks to: within iAISocialDistanceToTriggerEvent of
 * the other, or iAIMaxSocialDistanceToTriggerEvent with both seated or asleep (they talk from
 * where they are); seated, the one that starts reaches 20 units more.
 */
export function triggerDistance(
  settings: TalkSettings,
  starter: TalkPosture,
  other: TalkPosture,
): number {
  const resting = (posture: TalkPosture): boolean =>
    posture === 'sitting' || posture === 'sleeping';
  const reach =
    resting(starter) && resting(other)
      ? settings.conversationDistanceMax
      : settings.conversationDistance;
  return starter === 'sitting' ? reach + 20 : reach;
}

/**
 * Whether a greeting still holds its actor: the player has not walked off past the greeting's
 * hold distance. Past it the actor goes on with its package; the line itself plays out (the
 * engine does not cut a greeting the player walks away from).
 * TODO(M13): the hold distance is fAIInDialogueModeWithPlayerDistance by its name; where the
 * engine reads it was not found.
 */
export function greetingHolds(
  actor: Vec3,
  player: Vec3 | undefined,
  settings: Pick<TalkSettings, 'greetingHoldDistance'>,
): boolean {
  return player !== undefined && distance(actor, player) <= settings.greetingHoldDistance;
}

/** The speed (units a second) from which a scene's speaker counts as moving (observed in the original). */
const SCENE_SPEAKER_MOVING = 5;

/**
 * Whether a scene's line may begin as far as its speaker's facing goes (observed in the
 * original): it waits only while the speaker turns to face whom it speaks to (one that does not
 * turn: held in furniture, blocked, not moved by its AI, says it as it stands); the angle it
 * must come within is fAIMinAngleRangeToStartSceneDialogue, or
 * fAIMaxAngleRangeMovingToStartSceneDialogue while it moves at 5 units a second or more. The
 * engine has no time limit on the wait.
 */
export function sceneLineFaces(
  speaker: { readonly offDegrees: number; readonly speed: number; readonly turning: boolean },
  settings: Pick<TalkSettings, 'sceneDialogueAngle' | 'sceneDialogueAngleMoving'>,
): boolean {
  if (!speaker.turning) return true;
  const limit =
    speaker.speed >= SCENE_SPEAKER_MOVING
      ? settings.sceneDialogueAngleMoving
      : settings.sceneDialogueAngle;
  return Math.abs(speaker.offDegrees) <= limit;
}
