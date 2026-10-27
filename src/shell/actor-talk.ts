// What the actors of the loaded area say outside the dialogue menu (docs/ai.md, "Talking"): they
// greet the player as they pass, chatter, ask the story manager for scenes with each other (the
// Actor Dialogue event), say their packages' lines and bark (a topic subtype's line: combat,
// detection and crime call `bark`); the rules of who talks when are src/ai/talk.ts's, what is
// said the dialogue engine's (subtype lines, src/scripting/runtime/dialogue-engine.ts) and the
// scenes' (src/ai/scene-runtime.ts), and how a line is said (voice, lips, emotion, subtitle)
// src/shell/world-lines.ts's.

import { aiSettingsOf } from '../ai/ai-settings.ts';
import { AVOID_PLAYER_ACTIONS, avoidPlayer, avoidsPlayer } from '../ai/engine-packages.ts';
import { InterruptFlag } from '../ai/package-records.ts';
import type { SayOptions } from '../ai/package-runtime.ts';
import {
  NO_PACKAGE_INTERRUPTS,
  TalkPlanner,
  talkSettings,
  triggerDistance,
  type TalkActor,
  type TalkIntent,
  type TalkPosture,
  type TalkScene,
  type TalkSettings,
} from '../ai/talk.ts';
import type { Vec3 } from '../render/math.ts';
import type { SpokenInfo } from '../scripting/runtime/dialogue-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { actorDialogueEvent } from '../scripting/runtime/story-manager.ts';
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
/** Furniture animation types and the state of an actor in its furniture (ActorInteraction). */
const SIT_TYPE = 1;
const SLEEP_TYPE = 2;
const LEAN_TYPE = 4;
const IN_FURNITURE = 3;
/**
 * Two actors brought together for a scene face each other within the scene's line angle, or
 * after this long (seconds) they begin all the same. TODO(M13): the engine's own patience.
 */
const FACING_PATIENCE = 2;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const hex = (formId: number): string => formId.toString(16).padStart(8, '0');

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
  /**
   * Whether an actor fights (or flees, searches) now: it greets, chatters and asks for scenes
   * no more (its combat moves it: a greeting would stop a coward fleeing in its tracks).
   */
  readonly engaged?: (actor: number) => boolean;
}

/** An ask for a scene (the Actor Dialogue event) and what came of it. */
interface Ask {
  /** The one that asked (R1) and the one it asked (R2). */
  readonly actor: number;
  readonly partner: number;
  /**
   * What asked: an actor's social timer (it walks up to the trigger distance), or its
   * DialogueActivate procedure (it walks up to fAIDialogueDistance).
   */
  readonly by: 'social' | 'procedure';
  /** The quests the story manager started for it (none yet: it waits for the answer). */
  quests: readonly number[];
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
  /** Asks waiting for the story manager, or whose quests run. */
  readonly #asks = new Set<Ask>();
  /** Those being brought together for their random scene (they are not free meanwhile). */
  readonly #approaching = new Set<number>();
  /** Those held talking in their random scene, by the scene. */
  readonly #inScene = new Map<number, number>();
  /** Those whose sandbox lets them talk with others (Allow Conversation). */
  readonly #sociable = new Set<number>();
  /** Who says a line of idle chatter now. */
  #chatter: number | undefined;
  /** Those whose next line is being found (they are not free meanwhile). */
  readonly #looking = new Set<number>();
  /** Whether the player is in an interior (the conversation settings' interior values). */
  #interior = false;
  #sinceSpace = Infinity;
  /** Real seconds of frames (what DialogueActivate's wait counts). */
  #clock = 0;
  /** What waits for the next frame. */
  #frames: (() => void)[] = [];

  constructor(options: ActorTalkOptions) {
    this.#options = options;
  }

  /**
   * Every frame (real seconds): the actors whose AI runs greet, chatter and ask for scenes as
   * src/ai/talk.ts has them.
   */
  frame(actors: Iterable<StagedActor>, seconds: number, player: Vec3 | undefined): void {
    const { session, ai, movers } = this.#options;
    this.#clock += seconds;
    const waiting = this.#frames;
    this.#frames = [];
    for (const resolve of waiting) resolve();
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
      seen.push({
        reference,
        position: staged.position,
        interrupts: ai.current(reference)?.interrupts ?? NO_PACKAGE_INTERRUPTS,
        free: this.#available(reference),
        inScene: runtime.scenes.sceneOf(reference) !== undefined,
        canSpeak: staged.placed.look.voiceType !== undefined,
        posture: this.#posture(reference),
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
    this.#settle(planner);
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

  /** How an actor is placed (its furniture). */
  #posture(reference: number): TalkPosture {
    const using = this.#options.furniture.interaction(reference);
    if (!using) return 'standing';
    if (using.state !== IN_FURNITURE) return 'other';
    if (using.animationType === SLEEP_TYPE) return 'sleeping';
    return using.animationType === SIT_TYPE || using.animationType === LEAN_TYPE
      ? 'sitting'
      : 'other';
  }

  /**
   * Whether an actor can talk now (scenes aside): not talking with the player, not fighting,
   * not saying a line, not on its way to someone it talks with.
   */
  #available(reference: number): boolean {
    const runtime = this.#options.session.scriptsReady;
    return (
      runtime !== undefined &&
      runtime.dialogueSpeaker !== reference &&
      this.#options.engaged?.(reference) !== true &&
      !this.#approaching.has(reference) &&
      !this.#looking.has(reference) &&
      !this.#options.session.lines.speaking(reference)
    );
  }

  /** Whether an actor can say a line now (available and in no scene). */
  #free(reference: number): boolean {
    const runtime = this.#options.session.scriptsReady;
    return (
      runtime !== undefined &&
      this.#available(reference) &&
      runtime.scenes.sceneOf(reference) === undefined
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
      case 'ask':
        run('actor dialogue', this.#ask(intent.actor, intent.partner, 'social'));
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

  // --- Conversations between actors ------------------------------------------------------

  /** A reference's name in the log: its editor id, else its form id. */
  async #name(reference: number): Promise<string> {
    const runtime = this.#options.session.scriptsReady;
    const editorId = (await runtime?.forms.record(reference))?.editorId;
    return editorId === undefined || editorId === '' ? hex(reference) : editorId;
  }

  /**
   * An actor asks the story manager for a scene with another (the Actor Dialogue event: its
   * location, it as R1, the other as R2). The answer is the quests the event started (their
   * scenes then begin as random scenes); with none nothing else happens: there is no
   * conversation of the engine's own. Resolves whether a quest started.
   */
  async #ask(actor: number, partner: number, by: Ask['by']): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const terminal = this.#options.terminal;
    if (!runtime) return false;
    const ask: Ask = { actor, partner, by, quests: [] };
    this.#asks.add(ask);
    let quests: readonly number[] = [];
    try {
      const [location, names] = await Promise.all([
        runtime.locationOf(actor),
        Promise.all([this.#name(actor), this.#name(partner)]),
      ]);
      terminal.log('actor', `${names[0]} asking for random scene with ${names[1]}`);
      quests = await runtime.storyManager.quests(actorDialogueEvent(location, actor, partner));
      if (quests.length > 0) {
        const started = await Promise.all(quests.map((quest) => this.#name(quest)));
        terminal.log('actor', `${names[0]} got a quest back: ${started.join(', ')}`, 'ok');
      } else {
        terminal.log('actor', `${names[0]} failed to get a quest`);
      }
    } finally {
      ask.quests = quests;
      if (quests.length === 0) this.#asks.delete(ask);
      if (by === 'social') this.#planner?.answered(actor, partner, quests.length > 0);
    }
    return quests.length > 0;
  }

  /**
   * Every frame: asks whose quests all stopped are over (their actors free again); an actor
   * held for its random scene is let go once that scene ended, or as the scene gives it a
   * package (its scene package moves it).
   */
  #settle(planner: TalkPlanner): void {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    for (const ask of [...this.#asks]) {
      if (ask.quests.length === 0) continue;
      if (ask.quests.some((quest) => runtime.quests.isRunning(quest))) continue;
      this.#asks.delete(ask);
      if (ask.by === 'social') planner.released(ask.actor);
    }
    for (const [actor, scene] of [...this.#inScene]) {
      if (this.#approaching.has(actor)) continue;
      const ended = runtime.scenes.sceneOf(actor) !== scene;
      if (!ended && runtime.scenes.packagesOf(actor) === undefined) continue;
      this.#inScene.delete(actor);
      this.#options.ai.releaseFromTalk(actor);
      if (ended && planner.partnerOf(actor) !== undefined) planner.released(actor);
    }
  }

  /**
   * A random scene is about to begin with two actors (src/ai/scene-runtime.ts): the engine
   * looks again whether they may talk (the second as the one asking), then the one that asked
   * (else the second) walks up to the other, both stop their packages and face each other, and
   * the scene holds until they do. They stay so while it plays (the engine's in-game dialogue
   * package on both). Undefined: not actors of this stage.
   */
  /**
   * Whether a staged speaker faces whom it speaks to (an actor of the stage, the player) within
   * fAIMinAngleRangeToStartSceneDialogue: a scene's Face Target line waits for it. One held in
   * furniture faces as it sits. Undefined: either is not on this stage.
   */
  faces(speaker: number, target: number): boolean | undefined {
    const self = this.#staged.get(speaker);
    const at = target === PLAYER_REF ? this.#scene.player : this.#staged.get(target)?.position;
    const settings = this.#settings;
    if (!self || !at || !settings) return undefined;
    if (this.#options.furniture.holds(speaker)) return true;
    return facingWithin(self, at, settings.sceneDialogueAngle);
  }

  randomSceneStarts(scene: number, first: number, second: number): boolean | undefined {
    const planner = this.#planner;
    const settings = this.#settings;
    const one = this.#seen.find((actor) => actor.reference === first);
    const two = this.#seen.find((actor) => actor.reference === second);
    if (!planner || !settings || !one || !two) return undefined;
    if (!planner.mayTalk(one, two, this.#scene)) {
      void Promise.all([this.#name(first), this.#name(second)]).then(([a, b]) => {
        this.#options.terminal.log('actor', `${a} and ${b} may no longer talk: scene dropped`);
      });
      return false;
    }
    const ask = [...this.#asks].find(
      (entry) =>
        (entry.actor === first && entry.partner === second) ||
        (entry.actor === second && entry.partner === first),
    );
    const starter = ask?.actor ?? second;
    const [from, to] = starter === first ? [one, two] : [two, one];
    const reach =
      ask?.by === 'procedure'
        ? settings.dialogueDistance
        : triggerDistance(settings, from.posture, to.posture);
    this.#together(scene, from.reference, to.reference, reach).catch((error: unknown) => {
      this.#options.terminal.log('actor', `random scene: ${describe(error)}`, 'warn');
    });
    return true;
  }

  /**
   * Brings two actors together for their scene: the scene holds; the one that starts walks up
   * to within `reach` of the other (seated, the other comes to it; both seated, they talk from
   * where they are), then they face each other (fAIMinAngleRangeToStartSceneDialogue, a scene
   * line's own angle) and the scene goes on.
   */
  async #together(scene: number, starter: number, other: number, reach: number): Promise<void> {
    const { ai, movers, furniture, session } = this.#options;
    const runtime = session.scriptsReady;
    const settings = this.#settings;
    if (!runtime || !settings) return;
    const director = runtime.scenes;
    const pair = [starter, other];
    let walking: number | undefined;
    for (const actor of pair) {
      const facing = actor === starter ? other : starter;
      director.hold(actor, true);
      this.#approaching.add(actor);
      this.#inScene.set(actor, scene);
      ai.holdToTalk(actor, () =>
        walking === actor ? undefined : this.#staged.get(facing)?.position,
      );
    }
    const going = (): boolean =>
      pair.every((actor) => this.#staged.has(actor) && director.sceneOf(actor) === scene);
    const apartNow = (): number => {
      const a = this.#staged.get(starter)?.position;
      const b = this.#staged.get(other)?.position;
      return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity;
    };
    try {
      const [names, title] = await Promise.all([
        Promise.all([this.#name(starter), this.#name(other)]),
        this.#name(scene),
      ]);
      this.#options.terminal.log(
        'actor',
        `${names[0]} comes to ${names[1]} for ${title} (${apartNow().toFixed(0)} apart, to ${reach.toFixed(0)})`,
      );
      const a = this.#staged.get(starter);
      const b = this.#staged.get(other);
      if (!a || !b) return;
      const apart = apartNow();
      if (apart > reach) {
        // TODO(M13): whether the engine's dialogue package gets a seated starter up
        // (InitiateGetUpPackage) rather than have the other come.
        const [walker, to] = furniture.holds(starter) ? [b, a] : [a, b];
        if (!furniture.holds(walker.reference)) {
          walking = walker.reference;
          await movers.travel(walker.reference, to.position, 'walk', reach);
          walking = undefined;
        }
      }
      // They turn to each other (their talk hold faces them), the scene waits until they do.
      const started = this.#clock;
      while (going() && this.#clock - started < FACING_PATIENCE) {
        const faced = pair.every((actor) => {
          const self = this.#staged.get(actor);
          const target = this.#staged.get(actor === starter ? other : starter);
          if (!self || !target || furniture.holds(actor)) return true;
          return facingWithin(self, target.position, settings.sceneDialogueAngle);
        });
        if (faced) break;
        await this.#nextFrame();
      }
      this.#options.terminal.log(
        'actor',
        `${names[0]} and ${names[1]} face each other ${apartNow().toFixed(0)} apart: ${title} goes on`,
      );
    } finally {
      for (const actor of pair) {
        director.hold(actor, false);
        this.#approaching.delete(actor);
      }
    }
  }

  /** Resolves at the next frame. */
  #nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.#frames.push(resolve);
    });
  }

  /**
   * DialogueActivate between actors (its procedure; observed in the original): the actor
   * asks the story manager for a scene with its target (the Actor Dialogue event) and waits
   * fAISocialTimerToWaitForEvent (20 s) for a scene to take it: none, the procedure fails. In
   * the scene it walks up to within fAIDialogueDistance (170) of its target and both face each
   * other (`randomSceneStarts`); the procedure succeeds as the scene ends. A dead target fails
   * it at once.
   */
  async dialogueActivate(actor: number, target: number): Promise<boolean> {
    const runtime = this.#options.session.scriptsReady;
    const settings = this.#settings;
    if (!runtime || !settings || actor === target) return false;
    if (await runtime.actors.isDead(target)) return false;
    const asked = this.#clock;
    await this.#ask(actor, target, 'procedure');
    while (runtime.scenes.sceneOf(actor) === undefined) {
      if (this.#clock - asked >= settings.waitForEvent || !this.#staged.has(actor)) return false;
      await this.#nextFrame();
    }
    while (runtime.scenes.sceneOf(actor) !== undefined && this.#staged.has(actor)) {
      await this.#nextFrame();
    }
    return true;
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

  /**
   * Whether an actor's sandbox lets it talk with other actors (Allow Conversation). The social
   * timers' asks do not depend on it (the engine's rule reads the package's Random
   * Conversations flag). TODO(M13): the sandbox's own conversations (an activity that seeks
   * someone to talk with: fAIConversationExploreTime).
   */
  allowConversation(actor: number, allowed: boolean): void {
    if (allowed) this.#sociable.add(actor);
    else this.#sociable.delete(actor);
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
   * player's, play-mode's); SWMW, FIWE and PIRN (a drawn bow aimed: src/shell/actor-combat.ts);
   * PCPS, PCSS and PCSH (the player's casts and shouts: src/shell/actor-stage.ts). TODO(M13):
   * KNOO and STOF (the physics does not tell who knocked what).
   */
  async playerAction(subtype: string): Promise<boolean> {
    const planner = this.#planner;
    const commenter = planner?.commenter(this.#seen, this.#scene, subtype === 'KNOO');
    if (commenter === undefined) return false;
    if (AVOID_PLAYER_ACTIONS.has(subtype)) this.#avoidPlayer(commenter);
    return this.bark(commenter, subtype);
  }

  /**
   * The player swung a weapon, shot a bow or cast a projectile spell: the one picked to comment
   * on it (the nearest that may) also avoids them, if it is within fTriggerAvoidPlayerDistance,
   * sees them and fights no one (observed in the original: the engine's Avoid Player
   * package, src/ai/engine-packages.ts).
   */
  #avoidPlayer(commenter: number): void {
    const player = this.#scene.player;
    if (!player) return;
    const trigger = aiSettingsOf(this.#options.session).triggerAvoidPlayerDistance;
    for (const actor of this.#seen) {
      if (actor.reference !== commenter || actor.inScene) continue;
      const distance = Math.hypot(
        actor.position[0] - player[0],
        actor.position[1] - player[1],
        actor.position[2] - player[2],
      );
      const fighting = this.#options.engaged?.(actor.reference) === true;
      if (avoidsPlayer(distance, actor.seesPlayer, fighting, trigger)) {
        this.#options.ai.pushEngine(actor.reference, 'avoidPlayer', avoidPlayer, PLAYER_REF);
      }
    }
  }

  /** An actor left the stage or died: it stops its line. */
  remove(actor: number): void {
    this.#sociable.delete(actor);
    this.#options.session.lines.stop(actor);
    if (this.#inScene.delete(actor)) this.#options.ai.releaseFromTalk(actor);
  }
}

/** Whether an actor faces a point within an angle (degrees; its heading about z from +y). */
function facingWithin(actor: StagedActor, at: Vec3, degrees: number): boolean {
  const toward = Math.atan2(at[0] - actor.position[0], at[1] - actor.position[1]);
  let off = Math.abs(toward - actor.heading) % (2 * Math.PI);
  if (off > Math.PI) off = 2 * Math.PI - off;
  return off <= (degrees * Math.PI) / 180;
}
