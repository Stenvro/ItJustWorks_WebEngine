// Audio worker: decodes sound files off the main thread (and converts Bink videos for the
// media player, src/audio/bink-video.ts): WAV (PCM) directly, xWMA (music, and
// voice inside FUZ files) with ffmpeg.wasm, which loads on the first xWMA file. Music is
// streamed by the browser's media player instead: it gets a 16-bit WAV file. The core and its
// WebAssembly binary are served from node_modules (no CDN).

import coreUrl from '@ffmpeg/core?url';
import wasmUrl from '@ffmpeg/core/wasm?url';
import {
  decodeXwma,
  decodeXwmaToWav,
  STREAM_HEADROOM,
  type FfmpegCore,
} from '../audio/xwma-decoder.ts';
import { transcodeBink } from '../audio/bink-video.ts';
import { decodeBsaPayload } from '../formats/bsa/bsa.ts';
import { parseFuz } from '../formats/audio/fuz.ts';
import { decodeWav, parseWav, type PcmAudio } from '../formats/audio/wav.ts';
import { riffForm } from '../formats/audio/xwma.ts';
import type { AudioRequest, AudioResponse } from './audio-protocol.ts';

interface WorkerScope {
  postMessage(message: AudioResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<AudioRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
let core: Promise<FfmpegCore> | undefined;

function ffmpeg(): Promise<FfmpegCore> {
  core ??= (async () => {
    const [module, wasm] = await Promise.all([
      import(/* @vite-ignore */ coreUrl) as Promise<{
        default: (options: { wasmBinary: Uint8Array }) => Promise<FfmpegCore>;
      }>,
      fetch(wasmUrl).then((response) => response.arrayBuffer()),
    ]);
    return module.default({ wasmBinary: new Uint8Array(wasm) });
  })();
  return core;
}

async function decode(request: AudioRequest): Promise<{ pcm: PcmAudio; lip?: Uint8Array }> {
  const bytes = decodeBsaPayload(request.payload);
  let audio = bytes;
  let lip: Uint8Array | undefined;
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'FUZE') {
    const fuz = parseFuz(bytes);
    audio = fuz.audio;
    if (fuz.lip.byteLength > 0) lip = fuz.lip.slice();
  }
  const form = riffForm(audio);
  if (form === 'XWMA') return { pcm: decodeXwma(await ffmpeg(), audio), ...(lip && { lip }) };
  if (form === 'WAVE') return { pcm: decodeWav(parseWav(audio)), ...(lip && { lip }) };
  throw new Error(`not a sound file (${form ?? 'no RIFF header'})`);
}

/** Music for the media player: xWMA as a 16-bit WAV file, a WAV file as it is. */
async function stream(request: AudioRequest): Promise<{ file: Uint8Array; gain: number }> {
  const bytes = decodeBsaPayload(request.payload);
  const form = riffForm(bytes);
  if (form === 'XWMA') {
    return { file: decodeXwmaToWav(await ffmpeg(), bytes), gain: STREAM_HEADROOM };
  }
  if (form === 'WAVE') return { file: bytes.slice(), gain: 1 };
  throw new Error(`not a music file (${form ?? 'no RIFF header'})`);
}

function fail(request: AudioRequest, error: unknown): void {
  scope.postMessage(
    {
      id: request.id,
      ok: false,
      error: `${request.path}: ${error instanceof Error ? error.message : String(error)}`,
    },
    [],
  );
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  const start = performance.now();
  if (request.video) {
    ffmpeg()
      .then((loaded) => transcodeBink(loaded, decodeBsaPayload(request.payload)))
      .then(
        (file) => {
          scope.postMessage(
            { id: request.id, ok: true, kind: 'video', file, workMs: performance.now() - start },
            [file.buffer as ArrayBuffer],
          );
        },
        (error: unknown) => {
          fail(request, error);
        },
      );
    return;
  }
  if (request.stream) {
    stream(request).then(
      ({ file, gain }) => {
        scope.postMessage(
          {
            id: request.id,
            ok: true,
            kind: 'stream',
            file,
            gain,
            workMs: performance.now() - start,
          },
          [file.buffer as ArrayBuffer],
        );
      },
      (error: unknown) => {
        fail(request, error);
      },
    );
    return;
  }
  decode(request).then(
    ({ pcm, lip }) => {
      const channels = [...pcm.channels];
      const transfer: Transferable[] = channels.map((channel) => channel.buffer as ArrayBuffer);
      if (lip) transfer.push(lip.buffer as ArrayBuffer);
      scope.postMessage(
        {
          id: request.id,
          ok: true,
          kind: 'samples',
          sampleRate: pcm.sampleRate,
          channels,
          ...(pcm.loop && { loop: pcm.loop }),
          ...(lip && { lip }),
          workMs: performance.now() - start,
        },
        transfer,
      );
    },
    (error: unknown) => {
      fail(request, error);
    },
  );
});
