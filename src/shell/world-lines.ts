// Lines actors say outside the dialogue menu (docs/ai.md, "Talking"): ObjectReference.Say from
// a script, the greeting of an actor the player talks to that has no topics, and what
// src/shell/actor-talk.ts has them say (a package's Say and its topics,
// greetings as the player passes, idle chatter, conversations between actors, barks). An
// info's responses are said in turn in the speaker's voice (or another's: Say's
// akActorToSpeakAs), lips moving and the face showing each response's emotion, the info's
// fragments before and after; a voice file is followed by fGameplayVoiceFilePadding seconds, a
// response without one lasts fAIDefaultSpeechMult seconds a character. The HUD shows each
// response as a subtitle with the setting General Subtitles, or when the info (INFO flag Force
// Subtitle) or the package's Say forces it, while the speaker is within fMaxSubtitleDistance
// (1250) of the player, the speaker's name first with bShowSubtitleSpeakerName (subtitleText).
// An actor says one line at a time: a new one ends the one it says. An actor not on
// screen says nothing. A line spoken in the player's head (Say's abSpeakInPlayersHead) plays at
// the listener (the 2D dialogue output model, DOP3), its subtitle shown wherever the speaker is.
// Lines are no noise to the actors' detection (src/shell/actor-senses.ts).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { SpokenInfo } from '../scripting/runtime/dialogue-engine.ts';
import { InfoFlag, type InfoResponse } from '../world/dialogue-records.ts';
import { headPosition, type SpokenLine } from './actors.ts';
import type { GameSession } from './game-session.ts';
import { subtitleText } from './subtitles.ts';
import type { Terminal } from './terminal.ts';

/** Seconds per character of a line without a voice file (GMST fAIDefaultSpeechMult). */
const DEFAULT_SPEECH_MULT = 0.15;
/** Seconds after a voice file before the next response (GMST fGameplayVoiceFilePadding). */
const DEFAULT_VOICE_PADDING = 0.5;

/** How a line is said. */
export interface SpeakOptions {
  /** The actor whose voice says it (Say's akActorToSpeakAs). */
  readonly speakAs?: number | undefined;
  /** Its subtitle shows whatever the setting (a package's Say: Force Subtitle). */
  readonly forceSubtitle?: boolean | undefined;
  /** Whom it is said to (its listener's idles; a Hello to the player greets them). */
  readonly target?: number | undefined;
  /** Spoken in the player's head (Say's abSpeakInPlayersHead): heard wherever they are. */
  readonly inPlayersHead?: boolean | undefined;
}

/** What an actor says now, as its conditions see it. */
export interface Talking {
  /** The response's emotion (EmotionType) and its value (0..100). */
  readonly emotion: number;
  readonly emotionValue: number;
  /** It greets the player (a Hello topic's line to them). */
  readonly greeting: boolean;
}

/** The Hello subtype (DIAL SNAM). */
const HELLO = 'HELO';
/** The action whose idles an actor plays as it talks (AACT ActionTalking). */
const ACTION_TALKING = 'ActionTalking';

/** A line being said: ended early (stopped), its voice and the wait it is in. */
export interface LineControl {
  stopped: boolean;
  line?: SpokenLine | undefined;
  wake?: (() => void) | undefined;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class WorldLines {
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  /** The line each actor says now. */
  readonly #speaking = new Map<number, { stop(): void }>();
  /** The response whose subtitle the HUD shows (another's does not hide it). */
  #subtitle: object | undefined;
  /** What each actor says now (its conditions). */
  readonly #saying = new Map<number, Talking>();

  constructor(session: GameSession, terminal: Terminal) {
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Whether an actor says a line now. */
  speaking(reference: number): boolean {
    return this.#speaking.has(reference);
  }

  /** What an actor says now, here or in the dialogue menu (IsTalking, GetDialogueEmotion, ...). */
  talking(reference: number): Talking | undefined {
    return this.#saying.get(reference);
  }

  /**
   * A response begins (here, or in the dialogue menu): its conditions see it (IsTalking,
   * IsGreetingPlayer, GetDialogueEmotion, GetDialogueEmotionValue), the speaker gestures as it
   * talks (the response's speaker idle, else ActionTalking's idle tree, which picks by the
   * emotion: DialogueAngry, DialogueHappy, hand gestures, a dog's bark) and the listener plays
   * the response's listener idle.
   */
  responseBegins(
    speaker: number,
    spoken: SpokenInfo,
    response: InfoResponse,
    listener: number | undefined,
  ): void {
    this.#saying.set(speaker, {
      emotion: response.emotion,
      emotionValue: response.emotionValue,
      greeting: spoken.topic.subtypeName === HELLO && (listener ?? PLAYER_REF) === PLAYER_REF,
    });
    const world = this.#session.scriptsReady?.world;
    // An actor whose graph locked dialogue idles (IdleDialogueLock) plays its idle as it unlocks.
    const idle = (actor: number, play: () => void): void => {
      if (this.#session.holdDialogueIdle?.(actor, play) !== true) play();
    };
    idle(speaker, () => {
      if (response.speakerIdle) world?.playIdle?.(speaker, response.speakerIdle, listener);
      else this.#session.actorAction?.(speaker, ACTION_TALKING);
    });
    const listenerIdle = response.listenerIdle;
    if (listenerIdle && listener !== undefined && listener !== PLAYER_REF) {
      idle(listener, () => world?.playIdle?.(listener, listenerIdle, speaker));
    }
  }

  /** The actor's line has been said (or ended). */
  lineEnds(speaker: number): void {
    this.#saying.delete(speaker);
  }

  /** Ends the line an actor says (it died, it talks with the player, it says another). */
  stop(reference: number): void {
    this.#speaking.get(reference)?.stop();
  }

  /** ObjectReference.Say: the topic's first valid info for the speaker, said. */
  async say(
    speaker: number,
    topic: number,
    speakAs: number | undefined,
    inPlayersHead = false,
  ): Promise<void> {
    const runtime = this.#session.scriptsReady;
    if (!runtime || !this.#session.placedActor?.(speaker)) return;
    const spoken = await runtime.dialogue.topicLine(topic, speaker);
    if (!spoken) {
      this.#terminal.log(
        'papyrus',
        `${topic.toString(16)}: nothing to say for ${speaker.toString(16)}`,
      );
      return;
    }
    await this.speak(spoken, speaker, { speakAs, inPlayersHead });
  }

  /**
   * An actor says an info's line (see the file's comment): resolves once it is said (or ended
   * early), false if it could not say it (not on screen, no scripts).
   */
  async speak(spoken: SpokenInfo, speaker: number, options: SpeakOptions = {}): Promise<boolean> {
    const runtime = this.#session.scriptsReady;
    if (!runtime || !this.#session.placedActor?.(speaker)) return false;
    this.stop(speaker);
    const engine = runtime.dialogue;
    const control: LineControl = { stopped: false };
    const handle = {
      stop: () => {
        control.stopped = true;
        control.line?.stop();
        control.wake?.();
      },
    };
    this.#speaking.set(speaker, handle);
    const fragment = async (when: 'begin' | 'end'): Promise<void> => {
      try {
        await engine.runFragment(spoken.info, when, speaker);
      } catch (error) {
        this.#terminal.log('papyrus', `dialogue fragment: ${describe(error)}`, 'warn');
      }
    };
    await fragment('begin');
    try {
      for (const response of spoken.source.info.responses) {
        if (control.stopped) break;
        await this.sayResponse(speaker, spoken, response, options, control);
      }
    } finally {
      if (this.#speaking.get(speaker) === handle) {
        this.#speaking.delete(speaker);
        this.lineEnds(speaker);
      }
    }
    engine.said(spoken.info);
    await fragment('end');
    return true;
  }

  /**
   * An actor says one response of an info (its lines here, a scene's lines:
   * src/shell/scene-lines.ts): its voice file and lips, its emotion on the face (or the one
   * given for a neutral response: a scene action's), its gestures and listener's idle
   * (responseBegins), the subtitle while the player hears it; resolves once said (`control`
   * ends it early).
   */
  async sayResponse(
    speaker: number,
    spoken: SpokenInfo,
    response: InfoResponse,
    options: SpeakOptions & {
      /** The emotion of a neutral response (a scene action's DEMO / DEVA). */
      readonly emotion?: { readonly type: number; readonly value: number } | undefined;
    } = {},
    control: LineControl = { stopped: false },
  ): Promise<void> {
    const session = this.#session;
    const engine = session.scriptsReady?.dialogue;
    const placed = session.placedActor?.(speaker);
    if (!engine || !placed) return;
    const voiceOf =
      options.speakAs === undefined ? placed : (session.placedActor?.(options.speakAs) ?? placed);
    const voice = voiceOf.look.voiceType;
    const [placer, settings] = await Promise.all([session.actors(), session.settings()]);
    const perCharacter = settings.number('fAIDefaultSpeechMult') ?? DEFAULT_SPEECH_MULT;
    const padding = settings.number('fGameplayVoiceFilePadding') ?? DEFAULT_VOICE_PADDING;
    const forced =
      options.forceSubtitle === true || (spoken.info.flags & InfoFlag.forceSubtitle) !== 0;
    const path =
      voice === undefined ? undefined : await engine.voiceFile(spoken, response.number, voice);
    // Read anew after each wait (it may be ended meanwhile).
    const ended = (): boolean => control.stopped;
    if (ended()) return;
    control.line = path ? await placer.say(placed, path, options.inPlayersHead) : undefined;
    if (ended()) {
      control.line?.stop();
      return;
    }
    const given = response.emotion === 0 ? options.emotion : undefined;
    placed.face?.showEmotion(
      given?.type ?? response.emotion,
      given?.value ?? response.emotionValue,
    );
    this.responseBegins(speaker, spoken, response, options.target);
    const subtitle = {};
    const ini = session.ini;
    const general = ini.bool('Interface', 'bGeneralSubtitles');
    const reach = ini.number('Interface', 'fMaxSubtitleDistance');
    if ((general || forced) && (options.inPlayersHead === true || this.#heard(speaker, reach))) {
      this.#subtitle = subtitle;
      const name = ini.bool('Interface', 'bShowSubtitleSpeakerName') ? placed.look.name : '';
      session.hud.subtitle(
        subtitleText(response.text, name, ini.number('Interface', 'iSubtitleSpeakerNameColor')),
      );
    }
    const seconds = control.line
      ? control.line.duration + padding
      : Math.max(1, response.text.length * perCharacter);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      control.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    control.wake = undefined;
    control.line = undefined;
    placed.face?.showEmotion(undefined);
    if (this.#subtitle === subtitle) {
      this.#subtitle = undefined;
      session.hud.subtitle(undefined);
    }
  }

  /** Whether the player is within `reach` of a speaker (the subtitles' distance). */
  #heard(speaker: number, reach: number): boolean {
    const placed = this.#session.placedActor?.(speaker);
    const player = this.#session.scriptsReady?.world.livePlacement?.(PLAYER_REF)?.position;
    if (!placed || !player) return true;
    const [x, y, z] = headPosition(placed);
    return Math.hypot(x - player[0], y - player[1], z - player[2]) <= reach;
  }
}
