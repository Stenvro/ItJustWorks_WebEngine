// Loads sound files: the VFS reads the stored bytes on the main thread, the audio worker
// decompresses and decodes them (src/workers/audio-worker.ts). Sound files are found as the
// engine finds them: under the name, else with the other extension (.wav ↔ .xwm).

import type { Vfs } from '../vfs/vfs.ts';
import { soundFileCandidates } from '../world/sound-records.ts';
import type { AudioRequest, AudioResponse } from '../workers/audio-protocol.ts';

/** A decoded sound file. */
export interface DecodedSound {
  /** The path it was found under. */
  readonly path: string;
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
  readonly loop?: { readonly start: number; readonly end: number };
  readonly lip?: Uint8Array;
}

export class AudioLoader {
  readonly #vfs: Vfs;
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { readonly resolve: (response: AudioResponse) => void; readonly reject: (error: Error) => void }
  >();
  #nextId = 1;

  constructor(vfs: Vfs) {
    this.#vfs = vfs;
    this.#worker = new Worker(new URL('../workers/audio-worker.ts', import.meta.url), {
      type: 'module',
      name: 'audio',
    });
    this.#worker.addEventListener('message', (event: MessageEvent<AudioResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      pending.resolve(event.data);
    });
    this.#worker.addEventListener('error', (event) => {
      const error = new Error(`Audio worker crashed: ${event.message}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  /** The path a sound file is found under, or undefined if none of its names exists. */
  find(path: string): string | undefined {
    return soundFileCandidates(path).find((candidate) => this.#vfs.has(candidate));
  }

  /** Decodes a sound file; undefined if it does not exist. */
  async load(path: string): Promise<DecodedSound | undefined> {
    const found = this.find(path);
    if (found === undefined) return undefined;
    const payload = await this.#vfs.readPayload(found);
    const id = this.#nextId++;
    const request: AudioRequest = { id, path: found, payload };
    const response = await new Promise<AudioResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const buffer = payload.bytes.buffer;
      this.#worker.postMessage(request, buffer instanceof ArrayBuffer ? [buffer] : []);
    });
    if (!response.ok) throw new Error(response.error);
    return {
      path: found,
      sampleRate: response.sampleRate,
      channels: response.channels,
      ...(response.loop && { loop: response.loop }),
      ...(response.lip && { lip: response.lip }),
    };
  }

  dispose(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values())
      pending.reject(new Error('Audio loader disposed'));
    this.#pending.clear();
  }
}
