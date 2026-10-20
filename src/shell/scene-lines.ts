// The lines actors say in scenes (src/ai/scene-runtime.ts; the info and its fragments:
// src/scripting/runtime/scene-host.ts): each response said as the actors' other lines are
// (src/shell/world-lines.ts, sayResponse): in the speaker's voice (its voice type's file), its
// lips moving, the response's emotion (TRDT; a neutral one takes the scene action's, DEMO /
// DEVA) on its face while it speaks, its gestures (the response's speaker idle, else
// ActionTalking) and the listener's idle (LNAM), and the HUD's subtitle with the setting General
// Subtitles (or the info's Force Subtitle) while the player is within the voice's reach. An
// actor not on stage says nothing here: its line passes silently. TODO(M10) 4.1: who hears it
// (detection).

import type { SceneSpeech } from '../scripting/runtime/scene-host.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

export class SceneLines {
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  constructor(session: GameSession, terminal: Terminal) {
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Says a response of a scene's line; undefined when the speaker is not on stage. */
  speak(speech: SceneSpeech): Promise<void> | undefined {
    if (!this.#session.placedActor?.(speech.speaker)) return undefined;
    const lines = this.#session.lines;
    return lines
      .sayResponse(speech.speaker, speech.spoken, speech.response, {
        target: speech.target,
        emotion: { type: speech.emotion, value: speech.emotionValue },
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'papyrus',
          `scene line ${speech.topic.toString(16)}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      })
      .finally(() => {
        lines.lineEnds(speech.speaker);
      });
  }
}
