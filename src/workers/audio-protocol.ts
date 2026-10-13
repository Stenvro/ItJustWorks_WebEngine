// Messages between the main thread and the audio worker.

import type { BsaPayload } from '../formats/bsa/bsa.ts';

export interface AudioRequest {
  readonly id: number;
  /** For error messages only. */
  readonly path: string;
  readonly payload: BsaPayload;
  /** Music: a WAV file the browser's media player streams, instead of samples. */
  readonly stream?: boolean;
}

export type AudioResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: 'stream';
      /** A WAV file (16-bit PCM for xWMA music; a WAV file as it is), transferred. */
      readonly file: Uint8Array;
      /** The gain that restores its level (xWMA music is stored with headroom). */
      readonly gain: number;
      readonly workMs: number;
    }
  | {
      readonly id: number;
      readonly ok: true;
      readonly kind: 'samples';
      readonly sampleRate: number;
      /** One array per channel, −1 to 1 (transferred). */
      readonly channels: Float32Array[];
      /** The WAV sampler loop, in frames (end exclusive). */
      readonly loop?: { readonly start: number; readonly end: number };
      /** A FUZ file's lip-sync data (src/formats/audio/lip.ts). */
      readonly lip?: Uint8Array;
      /** Milliseconds spent decoding in the worker. */
      readonly workMs: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };
