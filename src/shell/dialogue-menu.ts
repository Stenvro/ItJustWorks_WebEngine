// A conversation in the game's dialogue menu (interface\dialoguemenu.swf): the actor greets the
// player, the player picks topics, the actor says each info's responses (its voice file for
// its voice type, its face lip-syncing, the line as the menu's subtitle), the info's fragments
// run before and after, and its choices are the next topics; a Goodbye info, or Tab, ends it.
// What is said comes from the dialogue engine (src/scripting/runtime/dialogue-engine.ts). The
// game goes on around a conversation (no menu mode); the player stands while it lasts.
// Notes: docs/ui.md ("Dialogue").

import {
  DialogueEngine,
  type SpokenInfo,
  type TopicChoice,
} from '../scripting/runtime/dialogue-engine.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { InfoFlag } from '../world/dialogue-records.ts';
import type { PlacedActor, SpokenLine } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** The dialogue menu's depth among the game's menus. */
const DIALOGUE_DEPTH = 5;

/** Seconds per character of a line without a voice file (GMST fAIDefaultSpeechMult). */
const DEFAULT_SPEECH_MULT = 0.15;

export class DialogueMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #engines = new WeakMap<ScriptRuntime, DialogueEngine>();
  #menu: Menu | undefined;
  #speaker: PlacedActor | undefined;
  #choices: TopicChoice[] = [];
  /** The line being said (Skip ends it). */
  #line: { stop(): void; skip: () => void } | undefined;
  #closed: (() => void) | undefined;
  #busy = false;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  get isOpen(): boolean {
    return this.#menu !== undefined;
  }

  /** The conversation steps aside while a menu it opened is open (barter, gift, training). */
  set shown(on: boolean) {
    const element = this.#menu?.element;
    if (element) element.style.visibility = on ? '' : 'hidden';
  }

  /** The conversation's engine for the game now running. */
  #engine(): DialogueEngine | undefined {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return undefined;
    let engine = this.#engines.get(runtime);
    if (!engine) {
      engine = new DialogueEngine(runtime);
      this.#engines.set(runtime, engine);
    }
    return engine;
  }

  /** Reads the game's dialogue ahead (its topics and infos), so the first conversation starts at once. */
  prepare(): void {
    void this.#engine()?.index.build();
  }

  /** Talks to an actor: the menu opens with its greeting; `closed` once the menu has gone. */
  async talk(speaker: PlacedActor, closed: () => void): Promise<void> {
    const engine = this.#engine();
    const runtime = this.#session.scriptsReady;
    if (!engine || !runtime || this.#menu) return;
    const reference = speaker.actor.reference;
    this.#speaker = speaker;
    this.#closed = closed;
    runtime.dialogueSpeaker = reference;
    const greeting = await engine.greeting(reference);
    this.#menu = await this.#host.open('dialoguemenu.swf', {
      depth: DIALOGUE_DEPTH,
      interactive: true,
      handlers: {
        TopicClicked: (_menu, args) => {
          const choice = this.#choices[typeof args[1] === 'number' ? args[1] : -1];
          if (choice) void this.#chosen(choice);
        },
        SkipText: () => {
          this.#line?.skip();
        },
        // Tab: the menu fades out and asks to close; FadeDone once it has faded.
        CloseMenu: () => {
          this.#line?.stop();
          this.#line = undefined;
        },
        FadeDone: () => {
          this.close();
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        menu.call('SetSpeakerName', speaker.look.name);
      },
    });
    runtime.state.actor(reference).talkedToPlayer = true;
    if (greeting) await this.#say(greeting);
    await this.#showTopics(greeting?.info.choices);
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
    if (menu) this.#host.close(menu);
    const runtime = this.#session.scriptsReady;
    if (runtime) runtime.dialogueSpeaker = undefined;
    this.#speaker = undefined;
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
    try {
      const spoken = await engine.choose(choice, speaker.actor.reference);
      if (spoken) await this.#say(spoken);
      if (!spoken || (spoken.info.flags & InfoFlag.goodbye) !== 0) {
        this.#menu?.call('StartHideMenu');
        return;
      }
      await this.#showTopics(spoken.info.choices);
    } finally {
      this.#busy = false;
    }
  }

  /** The topics the player may choose now (an info's choices, else the actor's topics). */
  async #showTopics(offered: readonly number[] | undefined): Promise<void> {
    const engine = this.#engine();
    const speaker = this.#speaker;
    const menu = this.#menu;
    if (!engine || !speaker || !menu) return;
    this.#choices = await engine.topics(speaker.actor.reference, offered);
    // (text, isNew, index) per topic, then the one to select (-1: none).
    const values = this.#choices.flatMap((choice, index) => [choice.text, choice.isNew, index]);
    menu.call('PopulateDialogueList', ...values, -1);
    menu.call('ShowDialogueList', true, false);
  }

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
          : await engine.voiceFile(spoken, response.number, voiceType);
      const line: SpokenLine | undefined = path ? await placer.say(speaker, path) : undefined;
      // Its text shows with the setting Dialogue Subtitles (off by default, as in the game).
      if (this.#session.ini.bool('Interface', 'bDialogueSubtitles')) {
        this.#menu.call('ShowDialogueText', response.text);
      }
      // The menu lets the player skip once the voice is ready.
      this.#menu.call('NotifyVoiceReady');
      const seconds = line?.duration ?? Math.max(1, response.text.length * perCharacter);
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
