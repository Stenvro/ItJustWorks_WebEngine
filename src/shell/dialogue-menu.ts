// A conversation in the game's dialogue menu (interface\dialoguemenu.swf): the actor greets the
// player, the player picks topics, the actor says each info's responses (its voice file for
// its voice type, its face lip-syncing, the line as the menu's subtitle), the info's fragments
// run before and after, and its choices are the next topics (an Invisible Continue info goes on
// to its next topic without them); a Goodbye info, Tab, or no topics left end it, and walking
// away with Tab says the listed topics' Walk Away line. An actor with no topics only says its
// greeting (no menu opens). What is said comes from the dialogue engine
// (src/scripting/runtime/dialogue-engine.ts; the flags' rules: dialogue-rules.ts). The game goes
// on around a conversation (no menu mode); the player stands while it lasts.
// Notes: docs/ui.md ("Dialogue").

import {
  type DialogueEngine,
  type SpokenInfo,
  type TopicChoice,
} from '../scripting/runtime/dialogue-engine.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { afterInfo } from '../scripting/runtime/dialogue-rules.ts';
import { InfoFlag } from '../world/dialogue-records.ts';
import { silentLineSeconds } from '../world/dialogue.ts';
import type { PlacedActor, SpokenLine } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** The dialogue menu's depth among the game's menus. */
const DIALOGUE_DEPTH = 5;

/** Invisible Continue infos said one after another at most (a loop of them in a mod ends). */
const MAX_CONTINUES = 32;

/** Seconds per character of a line without a voice file (GMST fAIDefaultSpeechMult). */
const DEFAULT_SPEECH_MULT = 0.15;

export class DialogueMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  #menu: Menu | undefined;
  #speaker: PlacedActor | undefined;
  #choices: TopicChoice[] = [];
  /** The topic said as the player walks away from the topics listed now (INFO Walk Away). */
  #walkAway: TopicChoice | undefined;
  /** Tab was pressed while the topics were listed: the walk-away line is said once it fades. */
  #walkingAway: TopicChoice | undefined;
  /** The line being said (Skip ends it). */
  #line: { stop(): void; skip: () => void } | undefined;
  #closed: (() => void) | undefined;
  #busy = false;
  /** A conversation is being worked out (its greeting, its topics) before its menu opens. */
  #starting = false;
  /** Actors saying their greeting outside a conversation (they had no topics). */
  readonly #greeting = new Set<number>();

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  get isOpen(): boolean {
    return this.#menu !== undefined;
  }

  /**
   * The conversation steps aside while a menu it opened is open (barter, gift, training); back,
   * it has the keys again (Tab, the topics).
   */
  set shown(on: boolean) {
    const menu = this.#menu;
    const element = menu?.element;
    if (element) element.style.visibility = on ? '' : 'hidden';
    if (on) menu?.focus();
  }

  /** The conversation's engine for the game now running. */
  #engine(): DialogueEngine | undefined {
    return this.#session.scriptsReady?.dialogue;
  }

  /**
   * Reads ahead what the first conversation would wait for: the game's dialogue (its topics and
   * infos), what its conditions read of the whole load order, the menu's movie.
   */
  prepare(): void {
    const engine = this.#engine();
    if (!engine) return;
    const start = performance.now();
    void engine
      .prepare()
      .then(() => this.#host.files.read('dialoguemenu.swf'))
      .then(() => {
        this.#terminal.log(
          'ui',
          `dialogue read ahead · ${(performance.now() - start).toFixed(0)} ms`,
          'ok',
        );
      });
  }

  /**
   * A conversation: the actor's greeting (or the line of `opening`, a topic it starts with),
   * then the topics to choose; `opened` as its menu opens, `closed` once the menu has gone. An
   * actor with no topics to choose says its greeting where it stands, and no menu opens (as
   * in the game: a guard's line as the player talks to them).
   */
  async talk(
    speaker: PlacedActor,
    events: { readonly opened: () => void; readonly closed: () => void },
    opening?: number,
  ): Promise<void> {
    const engine = this.#engine();
    const runtime = this.#session.scriptsReady;
    const reference = speaker.actor.reference;
    if (!engine || !runtime || this.#menu || this.#starting || this.#greeting.has(reference)) {
      return;
    }
    this.#starting = true;
    let greeting: SpokenInfo | undefined;
    let choices: TopicChoice[];
    try {
      greeting =
        opening === undefined
          ? await engine.greeting(reference)
          : await engine.topicLine(opening, reference);
      choices = await engine.topics(reference, greeting?.info.choices);
    } finally {
      this.#starting = false;
    }
    // With nothing to list, or a Goodbye greeting, the greeting is said where the actor stands;
    // an Invisible Continue greeting goes on in the menu.
    const after = greeting && afterInfo(greeting.info);
    if (
      (choices.every((choice) => choice.hidden === true) && after !== 'continue') ||
      after === 'close'
    ) {
      if (!greeting) {
        this.#terminal.log('ui', `${speaker.look.name} has nothing to say`);
        return;
      }
      runtime.state.actor(reference).talkedToPlayer = true;
      this.#greeting.add(reference);
      try {
        await this.#session.lines.speak(greeting, reference);
      } finally {
        this.#greeting.delete(reference);
      }
      return;
    }
    this.#speaker = speaker;
    this.#lastChosen = undefined;
    this.#closed = events.closed;
    runtime.dialogueSpeaker = reference;
    events.opened();
    this.#menu = await this.#host.open('dialoguemenu.swf', {
      depth: DIALOGUE_DEPTH,
      interactive: true,
      handlers: {
        // The menu has left its list for the answer: a click with no topic under it or
        // highlighted (no index) gets the list back instead of leaving the menu waiting.
        TopicClicked: (menu, args) => {
          const choice = this.#choices[typeof args[1] === 'number' ? args[1] : -1];
          if (choice && !this.#busy) void this.#chosen(choice);
          else if (!this.#busy) this.#listTopics(menu);
        },
        SkipText: () => {
          this.#line?.skip();
        },
        // Tab: the menu fades out and asks to close; FadeDone once it has faded.
        CloseMenu: () => {
          this.#walkingAway = this.#busy ? undefined : this.#walkAway;
          this.#line?.stop();
          this.#line = undefined;
        },
        FadeDone: () => {
          const walkAway = this.#walkingAway;
          this.#walkingAway = undefined;
          this.close();
          if (walkAway) void this.#walkAwayLine(walkAway, reference);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        menu.call('SetSpeakerName', speaker.look.name);
        // With the speaker named the other voices and effects duck (fNonDialogVoiceDucking).
        this.#session.soundSystem?.duckForDialogue(true);
      },
    });
    runtime.state.actor(reference).talkedToPlayer = true;
    if (greeting) await this.#say(greeting);
    await this.#goOn(greeting);
  }

  /**
   * The player walked away from the topics (Tab): the actor says the Walk Away topic's line
   * where it stands, its fragments running as if the player had chosen it (a quest's "I'll
   * think about it").
   */
  async #walkAwayLine(choice: TopicChoice, reference: number): Promise<void> {
    const engine = this.#engine();
    if (!engine) return;
    const spoken = await engine.choose(choice, reference);
    if (spoken) await this.#session.lines.speak(spoken, reference);
  }

  /**
   * After an info: Invisible Continue says its next topic at once (again while the next has
   * the flag too), Goodbye ends the conversation, else the topics show: the last info's
   * choices, or the actor's topics where a continue found nothing to say.
   */
  async #goOn(spoken: SpokenInfo | undefined): Promise<void> {
    const engine = this.#engine();
    const speaker = this.#speaker;
    if (!engine || !speaker) return;
    let current = spoken;
    let closing = false;
    let offered = spoken?.info.choices;
    for (let step = 0; current && step < MAX_CONTINUES; step++) {
      if ((current.info.flags & InfoFlag.goodbye) !== 0) closing = true;
      if (afterInfo(current.info) !== 'continue') break;
      const next = await engine.continueAfter(current, speaker.actor.reference);
      if (!next) {
        offered = undefined;
        break;
      }
      if (!this.#menu) return;
      await this.#say(next);
      current = next;
      offered = next.info.choices;
    }
    if (!this.#menu) return;
    if (closing || (current && (current.info.flags & InfoFlag.goodbye) !== 0)) {
      this.#menu.call('StartHideMenu');
      return;
    }
    await this.#showTopics(offered);
  }

  #openMenu(): Menu | undefined {
    return this.#menu;
  }

  /** Ends the conversation (its menu has faded, or Play ends). */
  close(): void {
    this.#line?.stop();
    this.#line = undefined;
    const menu = this.#menu;
    this.#menu = undefined;
    if (menu) {
      this.#host.close(menu);
      this.#session.soundSystem?.duckForDialogue(false);
    }
    const runtime = this.#session.scriptsReady;
    if (runtime) runtime.dialogueSpeaker = undefined;
    this.#speaker = undefined;
    this.#walkAway = undefined;
    const closed = this.#closed;
    this.#closed = undefined;
    closed?.();
  }

  /** A topic chosen: the actor says its info, then the info's choices (or the topics) show. */
  async #chosen(choice: TopicChoice): Promise<void> {
    const engine = this.#engine();
    const speaker = this.#speaker;
    if (!engine || !speaker || this.#busy) return;
    this.#busy = true;
    this.#lastChosen = choice.text;
    try {
      const spoken = await engine.choose(choice, speaker.actor.reference);
      if (!spoken) {
        this.#menu?.call('StartHideMenu');
        return;
      }
      await this.#say(spoken);
      await this.#goOn(spoken);
    } finally {
      this.#busy = false;
    }
  }

  /**
   * The topics the player may choose now (an info's choices, else the actor's topics); with
   * none left (what was said changed the game) the conversation ends.
   */
  async #showTopics(offered: readonly number[] | undefined): Promise<void> {
    const engine = this.#engine();
    const speaker = this.#speaker;
    const menu = this.#menu;
    if (!engine || !speaker || !menu) return;
    const all = await engine.topics(speaker.actor.reference, offered);
    this.#walkAway = all.find((choice) => choice.walkAway === true);
    this.#choices = all.filter((choice) => choice.hidden !== true);
    if (this.#choices.length === 0) {
      menu.call('StartHideMenu');
      return;
    }
    this.#listTopics(menu);
  }

  /**
   * Lists the topics: (text, isNew, index) per topic, then the one to select (the list's
   * SetSelectedTopic): the topic chosen last if it is listed again, else the first, so that E
   * (or a click, which takes the highlighted topic) chooses one at once, as in the game.
   * Inferred from the movie (it selects nothing for -1, and E then chooses nothing).
   */
  #listTopics(menu: Menu): void {
    const values = this.#choices.flatMap((choice, index) => [choice.text, choice.isNew, index]);
    const last = this.#lastChosen;
    const again = last === undefined ? -1 : this.#choices.findIndex((c) => c.text === last);
    menu.call('PopulateDialogueList', ...values, Math.max(0, again));
    menu.call('ShowDialogueList', true, false);
  }

  /** The text of the topic chosen last (selected again when it is listed again). */
  #lastChosen: string | undefined;

  /**
   * The actor says an info: its begin fragment, each response (the voice file of its voice
   * type, the text as the subtitle), its end fragment. Without a voice file a response shows
   * for its length (fAIDefaultSpeechMult a character).
   */
  async #say(spoken: SpokenInfo): Promise<void> {
    const engine = this.#engine();
    const speaker = this.#speaker;
    const runtime = this.#session.scriptsReady;
    if (!engine || !speaker || !runtime) return;
    const reference = speaker.actor.reference;
    await this.#fragment(engine, spoken, 'begin', reference);
    const placer = await this.#session.actors();
    const settings = await this.#session.settings();
    const perCharacter = settings.number('fAIDefaultSpeechMult') ?? DEFAULT_SPEECH_MULT;
    for (const response of spoken.source.info.responses) {
      if (!this.#menu) break;
      const voiceType = speaker.look.voiceType;
      const path =
        voiceType === undefined
          ? undefined
          : await this.#session.lines.voiceFile(spoken, response.number, voiceType);
      const line: SpokenLine | undefined = path ? await placer.say(speaker, path) : undefined;
      // Its face shows the response's emotion (src/animation/face.ts).
      speaker.face?.showEmotion(response.emotion, response.emotionValue);
      this.#session.lines.responseBegins(reference, spoken, response, undefined);
      // Its text shows with the setting Dialogue Subtitles (off by default, as in the game), or
      // when the info forces it (INFO flag Force Subtitle).
      if (
        this.#session.ini.bool('Interface', 'bDialogueSubtitles') ||
        (spoken.info.flags & InfoFlag.forceSubtitle) !== 0
      ) {
        this.#menu.call('ShowDialogueText', response.text);
      }
      // The menu lets the player skip once the voice is ready.
      this.#menu.call('NotifyVoiceReady');
      const seconds = line?.duration ?? silentLineSeconds(response.text, perCharacter);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        this.#line = {
          stop: () => {
            clearTimeout(timer);
            line?.stop();
            resolve();
          },
          skip: () => {
            clearTimeout(timer);
            line?.stop();
            resolve();
          },
        };
      });
      this.#line = undefined;
      // The menu may have closed while the line was said.
      const after: Menu | undefined = this.#openMenu();
      after?.call('HideDialogueText');
    }
    speaker.face?.showEmotion(undefined);
    this.#session.lines.lineEnds(reference);
    engine.said(spoken.info);
    await this.#fragment(engine, spoken, 'end', reference);
  }

  async #fragment(
    engine: DialogueEngine,
    spoken: SpokenInfo,
    when: 'begin' | 'end',
    speaker: number,
  ): Promise<void> {
    try {
      await engine.runFragment(spoken.info, when, speaker);
    } catch (error) {
      this.#terminal.log(
        'papyrus',
        `dialogue fragment: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }
}
