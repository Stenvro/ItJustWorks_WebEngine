// Lines actors say outside a conversation (ObjectReference.Say from a script): the topic's first
// valid info for the speaker, its responses in turn in the speaker's voice (or another's: Say's
// akActorToSpeakAs), lips moving, the info's fragments around them; the HUD shows each response
// as a subtitle with the setting General Subtitles (ShowSubtitle, HideSubtitle). An actor not
// on screen says nothing. TODO(M10): who hears it (detection), a line spoken in the player's head
// (abSpeakInPlayersHead) at the listener, the distance subtitles reach.

import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Seconds per character of a line without a voice file (GMST fAIDefaultSpeechMult). */
const DEFAULT_SPEECH_MULT = 0.15;

export class WorldLines {
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  constructor(session: GameSession, terminal: Terminal) {
    this.#session = session;
    this.#terminal = terminal;
  }

  async say(speaker: number, topic: number, speakAs: number | undefined): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    const placed = session.placedActor?.(speaker);
    if (!runtime || !placed) return;
    const engine = runtime.dialogue;
    const spoken = await engine.topicLine(topic, speaker);
    if (!spoken) {
      this.#terminal.log(
        'papyrus',
        `${topic.toString(16)}: nothing to say for ${speaker.toString(16)}`,
      );
      return;
    }
    const voice = (speakAs === undefined ? placed : (session.placedActor?.(speakAs) ?? placed)).look
      .voiceType;
    const [placer, settings] = await Promise.all([session.actors(), session.settings()]);
    const perCharacter = settings.number('fAIDefaultSpeechMult') ?? DEFAULT_SPEECH_MULT;
    await engine.runFragment(spoken.info, 'begin', speaker);
    for (const response of spoken.source.info.responses) {
      const path =
        voice === undefined ? undefined : await engine.voiceFile(spoken, response.number, voice);
      const line = path ? await placer.say(placed, path) : undefined;
      const subtitles = session.ini.bool('Interface', 'bGeneralSubtitles');
      if (subtitles) session.hud.subtitle(response.text);
      const seconds = line?.duration ?? Math.max(1, response.text.length * perCharacter);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      if (subtitles) session.hud.subtitle(undefined);
    }
    engine.said(spoken.info);
    await engine.runFragment(spoken.info, 'end', speaker);
  }
}
