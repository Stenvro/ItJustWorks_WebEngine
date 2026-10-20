// What the actors of the loaded area say outside the dialogue menu (docs/ai.md, "Talking"): they
// greet the player as they pass, chatter, talk with each other, say their packages' lines and
// bark (a topic subtype's line: combat, detection and crime call `bark`); the rules of who talks
// when are src/ai/talk.ts's, what is said the dialogue engine's (subtype lines,
// src/scripting/runtime/dialogue-engine.ts), and how a line is said (voice, lips, emotion,
// subtitle) src/shell/world-lines.ts's.

import { InterruptFlag } from '../ai/package-records.ts';
import type { SayOptions } from '../ai/package-runtime.ts';
import {
  converse,
  NO_PACKAGE_INTERRUPTS,
  TalkPlanner,
  talkSettings,
  type TalkActor,
  type TalkIntent,
  type TalkScene,
  type TalkSettings,
} from '../ai/talk.ts';
import type { Vec3 } from '../render/math.ts';
import type { SpokenInfo } from '../scripting/runtime/dialogue-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { InfoFlag } from '../world/dialogue-records.ts';
import { DIALOGUE_SUBTYPES } from '../world/dialogue-subtypes.ts';
import type { ActorAi } from './actor-ai.ts';
import type { ActorFurniture } from './actor-furniture.ts';
import type { ActorMovers } from './actor-movers.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Topic subtypes (DIAL SNAM; src/world/dialogue-subtypes.ts) said here. */
const HELLO = 'HELO';
const IDLE = 'IDLE';
const ACTOR_COLLIDE = 'ACAC';
/** Furniture animation type and state of an actor asleep in a bed (ActorInteraction). */
const SLEEP_TYPE = 2;
const IN_FURNITURE = 3;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ActorTalkOptions {
  readonly session: GameSession;
  readonly terminal: Terminal;
  readonly movers: ActorMovers;
  readonly ai: ActorAi;
  readonly furniture: ActorFurniture;
  /** Whether an actor is aware of the player (its detection; all are without). */
  readonly detects?: (actor: number) => boolean;
  /**
   * Where an actor looks while it speaks to someone (its head tracking of dialogue; undefined:
   * it stops): the actor stage makes it a dialogue head track (src/shell/actor-looks.ts).
   */
  readonly lookAt?: (actor: number, target: number | undefined) => void;
}

export class ActorTalk {
  readonly #options: ActorTalkOptions;
  #settings: TalkSettings | undefined;
  #reading: Promise<void> | undefined;
  #planner: TalkPlanner | undefined;
  /** The actors of the high process this frame, by reference. */
  readonly #staged = new Map<number, StagedActor>();
  /** The last frame's view of them (what the player's actions are commented by). */
  #seen: readonly TalkActor[] = [];
  #scene: TalkScene = { player: undefined, playerBusy: false, interior: false, chattering: false };
  /** Those in a conversation with another actor now. */
  readonly #conversing = new Set<number>();
  /** Those whose sandbox lets them talk with others (Allow Conversation). */
  readonly #sociable = new Set<number>();
  /** Who says a line of idle chatter now. */
  #chatter: number | undefined;
  /** Those whose next line is being found (they are not free meanwhile). */
  readonly #looking = new Set<number>();
  /** Whether the player is in an interior (the conversation settings' interior values). */
  #interior = false;
  #sinceSpace = Infinity;

  constructor(options: ActorTalkOptions) {
    this.#options = options;
  }

  /**
   * Every frame (real seconds): the actors whose AI runs greet, chatter and start conversations
   * as src/ai/talk.ts has them.
   */
  frame(actors: Iterable<StagedActor>, seconds: number, player: Vec3 | undefined): void {
    const { session, ai, movers, furniture } = this.#options;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const planner = this.#planner ?? this.#start();
    if (!planner) return;
    // An actor the player talks to stops its line (the conversation's lines are the menu's).
    const speaker = runtime.dialogueSpeaker;
    if (speaker !== undefined && session.lines.speaking(speaker)) session.lines.stop(speaker);
    this.#sinceSpace += seconds;
    if (this.#sinceSpace >= 1) {
      this.#sinceSpace = 0;
      void runtime.placement(PLAYER_REF).then((at) => {
        if (at) this.#interior = at.world === undefined;
      });
    }
    this.#staged.clear();
    const seen: TalkActor[] = [];
    for (const staged of actors) {
      const reference = staged.reference;
      if (staged.dead || staged.visibility.hidden || !movers.runsAi(reference)) continue;
      this.#staged.set(reference, staged);
      const using = furniture.interaction(reference);
      const asleep = using?.animationType === SLEEP_TYPE && using.state === IN_FURNITURE;
      seen.push({
        reference,
        position: staged.position,
        interrupts: ai.current(reference)?.interrupts ?? NO_PACKAGE_INTERRUPTS,
        // Not while on its way somewhere. TODO(M13): whether the engine lets walkers talk.
        sociable: this.#sociable.has(reference) && movers.travelOf(reference) === undefined,
        free: this.#free(reference) && !asleep,
        seesPlayer: this.#options.detects?.(reference) ?? true,
      });
    }
    this.#seen = seen;
    this.#scene = {
      player,
      playerBusy: speaker !== undefined,
      interior: this.#interior,
      chattering: this.#chatter !== undefined,
    };
    for (const intent of planner.update(seconds, seen, this.#scene)) this.#act(intent);
  }

  /** The talking rules once the game settings are read (undefined meanwhile). */
  #start(): TalkPlanner | undefined {
    if (this.#settings) {
      this.#planner = new TalkPlanner(this.#settings, Math.random);
      return this.#planner;
    }
    if (this.#reading) return undefined;
    this.#reading = this.#options.session
      .settings()
      .then((settings) => {
        this.#settings = talkSettings((name) => settings.number(name));
      })
      .catch((error: unknown) => {
        this.#options.terminal.log('actor', `talking: ${describe(error)}`, 'warn');
      });
    return undefined;
  }

  /** Whether an actor can say a line now (not saying one, not talking with the player, ...). */
  #free(reference: number): boolean {
    const runtime = this.#options.session.scriptsReady;
    return (
      runtime !== undefined &&
      runtime.dialogueSpeaker !== reference &&
      runtime.scenes.sceneOf(reference) === undefined &&
      !this.#conversing.has(reference) &&
      !this.#looking.has(reference) &&
      !this.#options.session.lines.speaking(reference)
    );
  }

  /** Finds an actor's line (it is not free meanwhile). */
  async #lineFor(
    reference: number,
    find: () => Promise<SpokenInfo | undefined>,
  ): Promise<SpokenInfo | undefined> {
    this.#looking.add(reference);
    try {
      return await find();
    } finally {
      this.#looking.delete(reference);
    }
  }

  #act(intent: TalkIntent): void {
    const run = (what: string, work: Promise<unknown>): void => {
      work.catch((error: unknown) => {
        this.#options.terminal.log('actor', `${what}: ${describe(error)}`, 'warn');
      });
    };
    switch (intent.kind) {
      case 'hello':
        run('greeting', this.#greet(intent.actor));
        break;
      case 'idle':
        run('idle chatter', this.#chat(intent.actor));
        break;
      case 'conversation':
        run('conversation', this.converse(intent.actor, intent.listener));
        break;
    }
  }

  /**
   * An actor greets the player as they pass (its Hello line to them). Unless the info lets it
   * move while greeting (INFO flag Can Move While Greeting), it stops and faces them meanwhile.
   */
  async #greet(reference: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    const spoken = await this.#lineFor(reference, async () =>
      runtime?.dialogue.subtypeLine(reference, HELLO, PLAYER_REF),
    );
    if (!spoken || !this.#free(reference)) return;
    const stops = (spoken.info.flags & InfoFlag.canMoveWhileGreeting) === 0;
    if (stops) this.#options.ai.holdToTalk(reference, () => this.#scene.player);
    try {
      await this.#speak(reference, spoken, PLAYER_REF);
    } finally {
      if (stops) this.#options.ai.releaseFromTalk(reference);
    }
  }

  /** An actor says a line of idle chatter to the player near it. */
  async #chat(reference: number): Promise<void> {
    this.#chatter = reference;
    try {
      const runtime = this.#options.session.scriptsReady;
      const spoken = await this.#lineFor(reference, async () =>
        runtime?.dialogue.subtypeLine(reference, IDLE, PLAYER_REF),
      );
      if (spoken && this.#free(reference)) await this.#speak(reference, spoken, PLAYER_REF);
    } finally {
      if (this.#chatter === reference) this.#chatter = undefined;
    }
  }

  /** Says a line, looking at whom it is said to meanwhile. */
  async #speak(
    reference: number,
    spoken: SpokenInfo,
    target: number,
    options: SayOptions = {},
  ): Promise<boolean> {
    const lookAt = this.#options.lookAt;
    lookAt?.(reference, target);
    try {
      return await this.#options.session.lines.speak(spoken, reference, {
        forceSubtitle: options.forceSubtitle,
        target,
      });
    } finally {
      lookAt?.(reference, undefined);
    }
  }

  /**
   * An actor says a line of a topic subtype ("OBCO" ObserveCombat, "NOTI" NoticeCorpse, "STEA"
   * Steal, "TRES" Trespass, "PICT" PickpocketTopic, "LOOB" LockedObject, "TITG" TimeToGo,
   * ...; combat, detection and crime call it): the first valid info of the subtype's topics for
   * it, to the target (the player without one), said as its other lines are. Not while it
   * talks with the player or says another line (unless `interrupt`). Resolves whether it said
   * one.
   */
  async bark(
    actor: number,
    subtype: string,
    target: number = PLAYER_REF,
    options: { readonly interrupt?: boolean } = {},
  ): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || runtime.dialogueSpeaker === actor) return false;
    if (!options.interrupt && !this.#free(actor)) return false;
    // By its code ("NOTI") or its name ("NoticeCorpse").
    const code = DIALOGUE_SUBTYPES.find((entry) => entry.name === subtype)?.code ?? subtype;
    const spoken = await this.#lineFor(actor, () =>
      runtime.dialogue.subtypeLine(actor, code, target),
    );
    return spoken ? this.#speak(actor, spoken, target) : false;
  }

  /**
   * A package's line (its Say procedure, its begin, end and change topics): a topic's first
   * valid info, or a topic subtype's line, to its target (the player without one); it ends a
   * line the actor says. Resolves once said (whether it said one).
   */
  async say(actor: number, topic: number | string, options: SayOptions = {}): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || runtime.dialogueSpeaker === actor) return false;
    const target = options.target ?? PLAYER_REF;
    const spoken =
      typeof topic === 'number'
        ? await runtime.dialogue.topicLineTo(topic, actor, target)
        : await runtime.dialogue.subtypeLine(actor, topic, target);
    return spoken ? this.#speak(actor, spoken, target, options) : false;
  }

  /** Whether an actor's sandbox lets it talk with other actors (Allow Conversation). */
  allowConversation(actor: number, allowed: boolean): void {
    if (allowed) this.#sociable.add(actor);
    else this.#sociable.delete(actor);
  }

  /**
   * Two actors talk (a conversation the social timers started, DialogueActivate between
   * actors): their packages wait; the one that starts walks up to the other if it is farther
   * than the game's iAISocialDistanceToTriggerEvent (one seated stays: the other comes, or
   * they do not talk), they face each other and take turns (src/ai/talk.ts, converse). It
   * breaks off when one is wanted elsewhere (the player talks to it, a scene takes it, it
   * leaves or dies). Resolves whether they talked.
   */
  async converse(actor: number, other: number): Promise<boolean> {
    const { ai, movers, furniture, session } = this.#options;
    const runtime = session.scriptsReady;
    const settings = this.#settings;
    if (!runtime || !settings || actor === other) return false;
    if (!this.#free(actor) || !this.#free(other)) return false;
    const first = this.#staged.get(actor);
    const second = this.#staged.get(other);
    if (!first || !second) return false;
    this.#conversing.add(actor);
    this.#conversing.add(other);
    // The one walking up is left to go; the other faces it.
    let walking: StagedActor | undefined;
    const facing = (from: StagedActor, to: StagedActor) => (): Vec3 | undefined =>
      walking === from ? undefined : to.position;
    ai.holdToTalk(actor, facing(first, second));
    ai.holdToTalk(other, facing(second, first));
    const goesOn = (): boolean =>
      [first, second].every(
        (staged) =>
          this.#staged.get(staged.reference) === staged &&
          !staged.dead &&
          runtime.dialogueSpeaker !== staged.reference &&
          runtime.scenes.sceneOf(staged.reference) === undefined,
      );
    try {
      const apart = (): number =>
        Math.hypot(first.position[0] - second.position[0], first.position[1] - second.position[1]);
      const near = settings.conversationDistance;
      if (apart() > near) {
        // The one that starts walks up; seated, the other comes to it.
        const [walker, to] = furniture.holds(actor) ? [second, first] : [first, second];
        if (furniture.holds(walker.reference)) return false;
        walking = walker;
        const arrived = await movers.travel(walker.reference, to.position, 'walk', near);
        walking = undefined;
        if (!arrived || !goesOn()) return false;
      }
      const lines = await converse(
        actor,
        other,
        async (speaker, listener, subtype) => {
          if (!goesOn()) return false;
          const spoken = await runtime.dialogue.subtypeLine(speaker, subtype, listener);
          return spoken !== undefined && goesOn() && (await this.#speak(speaker, spoken, listener));
        },
        goesOn,
      );
      return lines > 0;
    } finally {
      this.#conversing.delete(actor);
      this.#conversing.delete(other);
      ai.releaseFromTalk(actor);
      ai.releaseFromTalk(other);
    }
  }

  /**
   * The player walked into an actor (src/shell/actor-movers.ts): it says its
   * ActorCollidewithActor line to them (its infos weigh IsSmallBump and a chance) if its
   * package lets it react to the player's actions.
   */
  bumped(actor: number): void {
    const interrupts = this.#options.ai.current(actor)?.interrupts ?? NO_PACKAGE_INTERRUPTS;
    if ((interrupts & InterruptFlag.reactionToPlayerActions) === 0 || !this.#free(actor)) return;
    this.bark(actor, ACTOR_COLLIDE).catch((error: unknown) => {
      this.#options.terminal.log('actor', `bump: ${describe(error)}`, 'warn');
    });
  }

  /**
   * The player did something the actors near comment on: a topic subtype ("SWMW"
   * SwingMeleeWeapon, "FIWE" ShootBow, "ZKEY" ZKeyObject, "JUMP" Jump, "KNOO" KnockOverObject,
   * "DEOB" DestroyObject, "STOF" StandonFurniture, "LOOB" LockedObject, "PICT" PickpocketTopic,
   * "PIRN" PlayerinIronSights, "PCSH" PlayerShout, ...): the nearest who may comments
   * (src/ai/talk.ts, commenter). Resolves whether one did. Told now: JUMP, ZKEY, LOOB (the
   * player's, play-mode's). TODO(M10) 5.1, 5.3: combat and magic tell theirs (SWMW, FIWE,
   * PIRN, PCSH, ...); TODO(M13): KNOO and STOF (the physics does not tell who knocked what).
   */
  async playerAction(subtype: string): Promise<boolean> {
    const planner = this.#planner;
    const commenter = planner?.commenter(this.#seen, this.#scene, subtype === 'KNOO');
    return commenter === undefined ? false : this.bark(commenter, subtype);
  }

  /** An actor left the stage or died: it stops its line. */
  remove(actor: number): void {
    this.#sociable.delete(actor);
    this.#options.session.lines.stop(actor);
  }
}
