// Messages between the main thread and the audio worker.

import type { BsaPayload } from '../formats/bsa/bsa.ts';

export interface AudioRequest {
  readonly id: number;
  /** For error messages only. */
  readonly path: string;
  readonly payload: BsaPayload;
}

export type AudioResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly sampleRate: number;
      /** One array per channel, −1 to 1 (transferred). */
      readonly channels: Float32Array[];
      /** The WAV sampler loop, in frames (end exclusive). */
      readonly loop?: { readonly start: number; readonly end: number };
      /** A FUZ file's lip-sync data (TODO(M7): faces). */
      readonly lip?: Uint8Array;
      /** Milliseconds spent decoding in the worker. */
      readonly workMs: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };
