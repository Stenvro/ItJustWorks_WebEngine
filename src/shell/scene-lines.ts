// The lines actors say in scenes (src/ai/scene-runtime.ts; the info and its fragments:
// src/scripting/runtime/scene-host.ts): each response in the speaker's voice (its voice type's
// file), its lips moving, the response's emotion (TRDT; a neutral one takes the scene action's,
// DEMO / DEVA) on its face while it speaks, and the HUD's subtitle with the setting General
// Subtitles (or the info's Force Subtitle). An actor not on stage says nothing here: its line
// passes silently. TODO(M10) 4.3: who hears it (detection), the speaker's and listener's
// idles (SNAM / LNAM), the distance subtitles reach.

import { InfoFlag } from '../world/dialogue-records.ts';
import type { SceneSpeech } from '../scripting/runtime/scene-host.ts';
import type { PlacedActor } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Seconds per character of a line without a voice file (GMST fAIDefaultSpeechMult). */
const DEFAULT_SPEECH_MULT = 0.15;

/** Dialogue emotions (TRDT, DEMO: 0 neutral .. 7 puzzled) as the face's expressions. */
const EMOTIONS = [
  undefined,
  'DialogueAnger',
  'DialogueDisgusted',
  'DialogueFear',
  'DialogueSad',
  'DialogueHappy',
  'DialogueSurprise',
  'DialoguePuzzled',
] as const;

export class SceneLines {
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  /** The subtitle shown last (a line clears only its own). */
  #subtitle: object | undefined;

  constructor(session: GameSession, terminal: Terminal) {
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Says a response of a scene's line; undefined when the speaker is not on stage. */
  speak(speech: SceneSpeech): Promise<void> | undefined {
    const placed = this.#session.placedActor?.(speech.speaker);
    if (!placed) return undefined;
    return this.#speak(placed, speech).catch((error: unknown) => {
      this.#terminal.log(
        'papyrus',
        `scene line ${speech.topic.toString(16)}: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    });
  }

  async #speak(placed: PlacedActor, speech: SceneSpeech): Promise<void> {
    const session = this.#session;
    const engine = session.scriptsReady?.dialogue;
    if (!engine) return;
    const { spoken, response } = speech;
    const voice = placed.look.voiceType;
    const path =
      voice === undefined ? undefined : await engine.voiceFile(spoken, response.number, voice);
    const [placer, settings] = await Promise.all([session.actors(), session.settings()]);
    const line = path ? await placer.say(placed, path) : undefined;
    const neutral = response.emotion === 0;
    const expression = EMOTIONS[neutral ? speech.emotion : response.emotion];
    const strength = (neutral ? speech.emotionValue : response.emotionValue) / 100;
    if (expression) placed.face?.setExpression(expression, strength);
    const forced = (spoken.info.flags & InfoFlag.forceSubtitle) !== 0;
    const subtitle = {};
    if (forced || session.ini.bool('Interface', 'bGeneralSubtitles')) {
      this.#subtitle = subtitle;
      session.hud.subtitle(response.text);
    }
    const perCharacter = settings.number('fAIDefaultSpeechMult') ?? DEFAULT_SPEECH_MULT;
    const seconds = line?.duration ?? Math.max(1, response.text.length * perCharacter);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    if (expression) placed.face?.setExpression(undefined);
    if (this.#subtitle === subtitle) {
      this.#subtitle = undefined;
      session.hud.subtitle(undefined);
    }
  }
}
