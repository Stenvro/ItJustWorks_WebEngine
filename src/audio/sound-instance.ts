// One playing sound: its file in a buffer source (looping per the descriptor), its own volume
// (static attenuation, dB variance) and pitch, the distance curve of its output model, then
// either a 3D panner (output models that use HRTF) or fixed speaker levels, into its category;
// a share goes to the reverb. Notes: docs/audio.md.

import type { Vec3 } from '../render/math.ts';
import type { SoundDescriptor, SoundOutputModel } from '../world/sound-records.ts';
import { distanceGain, instanceGain, instancePitch } from './attenuation.ts';
import type { AudioEngine } from './audio-engine.ts';

/** A decoded sound file on the audio context, with its loop (seconds). */
export interface SoundBuffer {
  readonly buffer: AudioBuffer;
  readonly loop?: { readonly start: number; readonly end: number };
  /** A voice file's lip-sync data (.fuz, or the .lip beside it). */
  readonly lip?: Uint8Array;
}

/** Where a sound is: a fixed point, a moving one, or nowhere (2D, at the listener). */
export type SoundPlace = Vec3 | (() => Vec3) | undefined;

/** Seconds over which distance changes are smoothed. */
const SMOOTHING = 0.05;

export class SoundInstance {
  readonly descriptor: SoundDescriptor;
  readonly model: SoundOutputModel | undefined;
  /** It finished (or was stopped and its release ended). */
  ended = false;
  readonly #engine: AudioEngine;
  readonly #sound: SoundBuffer;
  readonly #place: SoundPlace;
  readonly #rate: number;
  /** The world's clock (Slow Time) on its pitch: setTimeRate. */
  #timeRate = 1;
  readonly #volume: GainNode;
  /** A spoken line's level among the others (speech highlighting: setSpeechLevel). */
  readonly #speech: GainNode;
  #speechLevel = 1;
  /** Fades (region and acoustic space loops fade in and out). */
  readonly #fade: GainNode;
  readonly #distance: GainNode;
  readonly #panner: PannerNode | undefined;
  #source: AudioBufferSourceNode;
  #stopping = false;
  #level = 1;

  constructor(
    engine: AudioEngine,
    sound: SoundBuffer,
    descriptor: SoundDescriptor,
    model: SoundOutputModel | undefined,
    place: SoundPlace,
    random: () => number,
    /** Seconds to fade in from silence (0: at once). */
    fadeIn = 0,
  ) {
    const context = engine.context;
    this.#engine = engine;
    this.#sound = sound;
    this.#place = place;
    this.descriptor = descriptor;
    this.model = model;
    this.#rate = instancePitch(descriptor, random());
    this.#volume = context.createGain();
    this.#volume.gain.value = instanceGain(descriptor, random());
    this.#fade = context.createGain();
    if (fadeIn > 0) {
      this.#fade.gain.setValueAtTime(0, context.currentTime);
      this.#fade.gain.linearRampToValueAtTime(1, context.currentTime + fadeIn);
    }
    this.#distance = context.createGain();
    this.#speech = context.createGain();
    this.#volume.connect(this.#speech);
    this.#speech.connect(this.#fade);
    this.#fade.connect(this.#distance);
    const output = engine.categoryNode(descriptor.category);
    if (model?.uses3d !== false && place !== undefined) {
      // HRTF panning only; the distance curve is the output model's, not the panner's.
      this.#panner = new PannerNode(context, {
        panningModel: 'HRTF',
        distanceModel: 'linear',
        refDistance: 1,
        maxDistance: 1e9,
        rolloffFactor: 0,
      });
      this.#distance.connect(this.#panner);
      this.#panner.connect(output);
    } else {
      this.#speakerOutput(output);
    }
    const send = model?.reverbSend ?? 0;
    if (send > 0) {
      const reverb = context.createGain();
      reverb.gain.value = send * engine.categoryVolume(descriptor.category);
      this.#distance.connect(reverb);
      reverb.connect(engine.reverbSend);
    }
    this.#source = this.#start(0, descriptor.looping !== 'none');
  }

  /**
   * The world's clock runs at `rate` (Slow Time): the sound plays that much slower and lower
   * (sounds in the world only: SoundSystem.setTimeMultiplier).
   */
  setTimeRate(rate: number): void {
    if (rate === this.#timeRate) return;
    this.#timeRate = rate;
    this.#source.playbackRate.value = this.#rate * rate;
  }

  /** Whether it has a place in the world (not 2D: the interface, music). */
  get placed(): boolean {
    return this.#place !== undefined;
  }

  /** The distance gain was set once (later updates ease towards theirs). */
  #placed = false;

  /** The point the sound is at now (undefined: 2D). */
  get position(): Vec3 | undefined {
    const place = this.#place;
    return typeof place === 'function' ? place() : place;
  }

  /** Follows its place and applies the distance curve for the listener at `listener`. */
  update(listener: Vec3): void {
    const position = this.position;
    if (!position) return;
    const time = this.#engine.context.currentTime;
    const distance = Math.hypot(
      position[0] - listener[0],
      position[1] - listener[1],
      position[2] - listener[2],
    );
    const gain = this.model?.attenuatesWithDistance
      ? distanceGain(this.model.attenuation, distance)
      : 1;
    // Its first update sets the gain at once: smoothed from the node's 1, a distant footstep
    // would start at full volume (a thump each, a drumming of the far actors' steps).
    if (this.#placed) this.#distance.gain.setTargetAtTime(gain, time, SMOOTHING);
    else this.#distance.gain.setValueAtTime(gain, time);
    this.#placed = true;
    if (this.#panner) {
      this.#panner.positionX.setValueAtTime(position[0], time);
      this.#panner.positionY.setValueAtTime(position[1], time);
      this.#panner.positionZ.setValueAtTime(position[2], time);
    }
  }

  /**
   * Stops it the way its looping type says: an envelope-fast loop jumps to its release, an
   * envelope-slow one plays its pass through the loop and then the release; anything else stops
   * at once (`immediately`: also envelopes, as when its cell unloads).
   */
  stop(immediately = false): void {
    if (this.#stopping || this.ended) return;
    this.#stopping = true;
    if (immediately) {
      this.#source.stop();
      return;
    }
    const loop = this.#sound.loop;
    const looping = this.descriptor.looping;
    if (loop && looping === 'envelope-slow') {
      this.#source.loop = false;
      return;
    }
    if (loop && looping === 'envelope-fast' && loop.end < this.#sound.buffer.duration) {
      const old = this.#source;
      old.onended = null;
      old.stop();
      this.#source = this.#start(loop.end, false);
      return;
    }
    this.#source.stop();
  }

  /** Sets its level (0–1) smoothly: weather loops follow a change of weather. */
  setLevel(level: number): void {
    if (this.#stopping || Math.abs(level - this.#level) < 0.01) return;
    this.#level = level;
    // Replaces a fade-in still under way, which would otherwise end at full level.
    const time = this.#engine.context.currentTime;
    const gain = this.#fade.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    gain.setTargetAtTime(level, time, 0.5);
  }

  /**
   * A spoken line's level among the others (0–1), reached in a straight line over `seconds`
   * (speech highlighting: SoundSystem).
   */
  setSpeechLevel(level: number, seconds: number): void {
    if (Math.abs(level - this.#speechLevel) < 1e-4) return;
    this.#speechLevel = level;
    const time = this.#engine.context.currentTime;
    const gain = this.#speech.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    if (seconds <= 0) gain.setValueAtTime(level, time);
    else gain.linearRampToValueAtTime(level, time + seconds);
  }

  /** Fades out over `seconds`, then stops (region and acoustic space loops). */
  fadeOut(seconds: number): void {
    if (this.#stopping || this.ended) return;
    if (seconds <= 0) {
      this.stop();
      return;
    }
    this.#stopping = true;
    const time = this.#engine.context.currentTime;
    const gain = this.#fade.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    gain.linearRampToValueAtTime(0, time + seconds);
    this.#source.stop(time + seconds);
  }

  #start(offset: number, loop: boolean): AudioBufferSourceNode {
    const context = this.#engine.context;
    const source = context.createBufferSource();
    source.buffer = this.#sound.buffer;
    source.playbackRate.value = this.#rate * this.#timeRate;
    if (loop) {
      source.loop = true;
      const region = this.#sound.loop;
      if (region) {
        source.loopStart = region.start;
        source.loopEnd = region.end;
      }
    }
    source.connect(this.#volume);
    source.onended = () => {
      this.ended = true;
      this.#volume.disconnect();
    };
    source.start(context.currentTime, offset);
    return source;
  }

  /**
   * Fixed speaker levels (output models with defined speaker output, and 2D sounds): mono and
   * the two stereo inputs onto left and right (centre at −3 dB to both, the rear pairs to their
   * side; no surround output yet).
   */
  #speakerOutput(output: AudioNode): void {
    const levels = this.model?.speakers;
    const context = this.#engine.context;
    if (!levels) {
      this.#distance.connect(output);
      return;
    }
    const toStereo = (row: readonly number[] | undefined): [number, number] => {
      const [l = 0, r = 0, c = 0, , rl = 0, rr = 0, bl = 0, br = 0] = row ?? [];
      const half = Math.SQRT1_2;
      return [(l + c * half + rl + bl) / 100, (r + c * half + rr + br) / 100];
    };
    const mono = this.#sound.buffer.numberOfChannels === 1;
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    this.#distance.connect(splitter);
    const route = (input: number, row: readonly number[] | undefined): void => {
      const [left, right] = toStereo(row);
      const toLeft = context.createGain();
      toLeft.gain.value = left;
      const toRight = context.createGain();
      toRight.gain.value = right;
      splitter.connect(toLeft, input);
      splitter.connect(toRight, input);
      toLeft.connect(merger, 0, 0);
      toRight.connect(merger, 0, 1);
    };
    if (mono) route(0, levels[0]);
    else {
      route(0, levels[1]);
      route(1, levels[2]);
    }
    merger.connect(output);
  }
}
