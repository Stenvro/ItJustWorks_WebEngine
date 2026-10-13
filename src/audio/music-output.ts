// Music in Web Audio: each music type plays into its own bus (a gain that ducking turns down),
// into the music category (default object MDSC). Each file is streamed by the browser's media
// player: the audio worker turns it into a 16-bit WAV file, an <audio> element plays it through
// a MediaElementAudioSourceNode and a gain for its fades. Streaming keeps a 3½-minute track at
// about 38 MB instead of 76 MB of decoded floats in an AudioBuffer. Notes: docs/audio.md
// ("Music").

import type { MusicTrack, MusicType } from '../world/sound-records.ts';
import type { AudioEngine } from './audio-engine.ts';
import type { AudioLoader } from './audio-loader.ts';
import type { MusicBus, MusicOutput, MusicVoice } from './music.ts';

/** Music files kept ready (WAV bytes); the least recently used ones not playing go first. */
const STREAM_BUDGET = 192 * 1024 * 1024;
/** Loop ends are checked every frame: a loop restarts at most this late. */
const LOOP_TOLERANCE = 0.05;

/** Where music types and tracks come from (the sound system's record caches). */
export interface MusicRecords {
  musicType(formId: number): Promise<MusicType | undefined>;
  musicTrack(formId: number): Promise<MusicTrack | undefined>;
}

interface Stream {
  state: 'loading' | 'ready' | 'failed';
  url: string | undefined;
  /** Restores the stream's level (xWMA music is stored with headroom). */
  gain: number;
  bytes: number;
  used: number;
  playing: number;
}

export class WebMusicOutput implements MusicOutput {
  readonly #engine: AudioEngine;
  readonly #loader: AudioLoader;
  readonly #records: MusicRecords;
  readonly #category: number | undefined;
  readonly #warn: (message: string) => void;
  readonly #streams = new Map<string, Stream>();
  readonly #voices = new Set<StreamVoice>();
  #bytes = 0;

  constructor(
    engine: AudioEngine,
    loader: AudioLoader,
    records: MusicRecords,
    category: number | undefined,
    warn: (message: string) => void,
  ) {
    this.#engine = engine;
    this.#loader = loader;
    this.#records = records;
    this.#category = category;
    this.#warn = warn;
  }

  /** WAV bytes kept ready. */
  get bytes(): number {
    return this.#bytes;
  }

  musicType(formId: number): Promise<MusicType | undefined> {
    return this.#records.musicType(formId);
  }

  musicTrack(formId: number): Promise<MusicTrack | undefined> {
    return this.#records.musicTrack(formId);
  }

  prepare(file: string): boolean | undefined {
    const known = this.#streams.get(file);
    if (known) {
      known.used = performance.now();
      return known.state === 'loading' ? undefined : known.state === 'ready';
    }
    const stream: Stream = {
      state: 'loading',
      url: undefined,
      gain: 1,
      bytes: 0,
      used: performance.now(),
      playing: 0,
    };
    this.#streams.set(file, stream);
    this.#loader.loadStream(file).then(
      (result) => {
        if (this.#streams.get(file) !== stream) return;
        if (!result) {
          stream.state = 'failed';
          this.#warn(`${file}: not found`);
          return;
        }
        stream.url = URL.createObjectURL(
          new Blob([result.file as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
        );
        stream.gain = result.gain;
        stream.bytes = result.file.byteLength;
        stream.state = 'ready';
        this.#bytes += stream.bytes;
        this.#evict();
      },
      (error: unknown) => {
        stream.state = 'failed';
        this.#warn(error instanceof Error ? error.message : String(error));
      },
    );
    return undefined;
  }

  play(
    file: string,
    bus: MusicBus,
    fadeIn: number,
    loop: MusicTrack['loop'],
  ): MusicVoice | undefined {
    const stream = this.#streams.get(file);
    if (stream?.state !== 'ready' || stream.url === undefined || !(bus instanceof StreamBus)) {
      return undefined;
    }
    stream.playing++;
    stream.used = performance.now();
    const voice = new StreamVoice(
      this.#engine.context,
      stream.url,
      bus.node,
      stream.gain,
      fadeIn,
      loop,
      () => {
        stream.playing--;
        stream.used = performance.now();
        this.#voices.delete(voice);
      },
    );
    voice.onError = (message) => {
      this.#warn(`${file}: ${message}`);
    };
    this.#voices.add(voice);
    return voice;
  }

  bus(): MusicBus {
    return new StreamBus(this.#engine.context, this.#engine.categoryNode(this.#category));
  }

  /** Every frame: loops. */
  update(): void {
    for (const voice of this.#voices) voice.update();
  }

  /** Stops every voice at once. */
  stop(): void {
    for (const voice of [...this.#voices]) voice.stop(0);
  }

  dispose(): void {
    this.stop();
    for (const stream of this.#streams.values()) {
      if (stream.url !== undefined) URL.revokeObjectURL(stream.url);
    }
    this.#streams.clear();
    this.#bytes = 0;
  }

  #evict(): void {
    if (this.#bytes <= STREAM_BUDGET) return;
    const entries = [...this.#streams].sort((a, b) => a[1].used - b[1].used);
    for (const [file, stream] of entries) {
      if (this.#bytes <= STREAM_BUDGET) break;
      if (stream.state !== 'ready' || stream.playing > 0) continue;
      if (stream.url !== undefined) URL.revokeObjectURL(stream.url);
      this.#streams.delete(file);
      this.#bytes -= stream.bytes;
    }
  }
}

/** A music type's output: ducking fades it. */
class StreamBus implements MusicBus {
  readonly node: GainNode;

  constructor(context: AudioContext, output: AudioNode) {
    this.node = context.createGain();
    this.node.connect(output);
  }

  fade(level: number, seconds: number): void {
    const gain = this.node.gain;
    const time = this.node.context.currentTime;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    gain.linearRampToValueAtTime(level, time + Math.max(seconds, 0.01));
  }

  dispose(): void {
    this.node.disconnect();
  }
}

/** A music file streamed by an <audio> element. */
class StreamVoice implements MusicVoice {
  readonly #audio: HTMLAudioElement;
  readonly #source: MediaElementAudioSourceNode;
  readonly #gain: GainNode;
  readonly #loop: MusicTrack['loop'];
  readonly #onEnd: () => void;
  /** Loop passes left (Infinity: until stopped). */
  #loopsLeft: number;
  #lastPosition = 0;
  #stopping = false;
  #ended = false;
  onError: ((message: string) => void) | undefined;

  constructor(
    context: AudioContext,
    url: string,
    output: AudioNode,
    level: number,
    fadeIn: number,
    loop: MusicTrack['loop'],
    onEnd: () => void,
  ) {
    this.#loop = loop;
    this.#loopsLeft = loop ? (loop.count > 0 ? loop.count : Infinity) : 0;
    this.#onEnd = onEnd;
    this.#audio = new Audio(url);
    this.#audio.preload = 'auto';
    this.#source = context.createMediaElementSource(this.#audio);
    this.#gain = context.createGain();
    this.#gain.gain.value = level;
    if (fadeIn > 0) {
      this.#gain.gain.setValueAtTime(0, context.currentTime);
      this.#gain.gain.linearRampToValueAtTime(level, context.currentTime + fadeIn);
    }
    this.#source.connect(this.#gain);
    this.#gain.connect(output);
    this.#audio.addEventListener('ended', () => {
      this.#finish();
    });
    this.#audio.addEventListener('error', () => {
      this.onError?.(this.#audio.error?.message ?? 'cannot play');
      this.#finish();
    });
    this.#audio.play().catch((error: unknown) => {
      this.onError?.(error instanceof Error ? error.message : String(error));
      this.#finish();
    });
  }

  get position(): number {
    return this.#audio.currentTime;
  }

  get ended(): boolean {
    return this.#ended;
  }

  stop(seconds: number): void {
    if (this.#stopping || this.#ended) return;
    this.#stopping = true;
    const gain = this.#gain.gain;
    const time = this.#gain.context.currentTime;
    const fade = Math.max(seconds, 0.02);
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    gain.linearRampToValueAtTime(0, time + fade);
    setTimeout(() => {
      this.#finish();
    }, fade * 1000);
  }

  /** LNAM loops: a loop over the whole file loops natively; others jump back. */
  update(): void {
    const loop = this.#loop;
    if (!loop || this.#ended) return;
    const audio = this.#audio;
    const position = audio.currentTime;
    const whole =
      Number.isFinite(audio.duration) &&
      loop.start <= LOOP_TOLERANCE &&
      loop.end >= audio.duration - LOOP_TOLERANCE;
    if (whole) {
      // The element wrapped around: one pass done.
      if (audio.loop && position + 1 < this.#lastPosition) this.#loopsLeft--;
      audio.loop = this.#loopsLeft > 0;
    } else if (this.#loopsLeft > 0 && position >= loop.end) {
      audio.currentTime = loop.start;
      this.#loopsLeft--;
    }
    this.#lastPosition = audio.currentTime;
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#audio.pause();
    this.#audio.removeAttribute('src');
    this.#audio.load();
    this.#source.disconnect();
    this.#gain.disconnect();
    this.#onEnd();
  }
}
