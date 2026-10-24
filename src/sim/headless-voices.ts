// The actors' voices in the headless simulation: a spoken line is not heard, but it takes as long
// as its file does and its face moves by its lip data, so conversations, scenes and barks run on
// the game's own timing. The line's length is read from the file's headers (an xWMA's decoded
// size, a WAV's frames; a .fuz holds the lip data and the xWMA), without decoding the audio.

import { parseFuz } from '../formats/audio/fuz.ts';
import { parseWav } from '../formats/audio/wav.ts';
import { parseXwma, riffForm } from '../formats/audio/xwma.ts';
import type { SoundInstance, SoundPlace } from '../audio/sound-instance.ts';
import type { VoiceLine } from '../audio/sound-system.ts';
import type { VoicePort } from '../shell/game-session.ts';
import type { Vfs } from '../vfs/vfs.ts';
import { soundFileCandidates } from '../world/sound-records.ts';

export class HeadlessVoices implements VoicePort {
  readonly #vfs: Vfs;
  /** A line asked to play (its file and where): the simulation records it. */
  onLine: ((path: string, place: SoundPlace) => void) | undefined;

  constructor(vfs: Vfs) {
    this.#vfs = vfs;
  }

  hasFile(path: string): boolean {
    return this.#find(path) !== undefined;
  }

  async voiceLine(path: string): Promise<VoiceLine | undefined> {
    const found = this.#find(path);
    if (found === undefined) return undefined;
    const bytes = await this.#vfs.read(found);
    let audio = bytes;
    let lip: Uint8Array | undefined;
    if (found.endsWith('.fuz')) {
      const fuz = parseFuz(bytes);
      audio = fuz.audio;
      if (fuz.lip.byteLength > 0) lip = fuz.lip.slice();
    }
    const form = riffForm(audio);
    const duration =
      form === 'XWMA'
        ? parseXwma(audio).duration
        : form === 'WAVE'
          ? (() => {
              const wav = parseWav(audio);
              return wav.format.sampleRate > 0 ? wav.frames / wav.format.sampleRate : 0;
            })()
          : 0;
    return {
      duration,
      ...(lip && { lip }),
      play: (place: SoundPlace): Promise<SoundInstance | undefined> => {
        this.onLine?.(found, place);
        return Promise.resolve(undefined);
      },
    };
  }

  #find(path: string): string | undefined {
    return soundFileCandidates(path).find((candidate) => this.#vfs.has(candidate));
  }
}
