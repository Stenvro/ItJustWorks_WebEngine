// The reverb of an acoustic space (REVB: XAudio2's I3DL2 parameters) as an impulse response
// for a convolver. XAudio2's reverb is an algorithmic network whose inner workings are not
// documented; this builds a response with the same parameters: early reflections at the
// reflections delay, then late reverb after the reverb delay that falls 60 dB over the decay
// time (above the HF reference by the decay time × the HF ratio), with the room HF cut above
// the reference. As I3DL2 defines them, Reflections and Reverb are the energies of those parts
// relative to the direct sound (both under Room): each part is scaled so that its energy, the
// sum of its squared samples, is that level — a long decay spreads the same energy over more
// time instead of adding to it. Diffusion and density are not modelled. TODO(M13): compare
// with the game. Platform-independent.

import type { Reverb } from '../world/sound-records.ts';
import { dbToGain } from './attenuation.ts';

/** Levels at or below this (dB) mean "no reverb" (DefaultReverb has −100 everywhere). */
const SILENT_DB = -90;
/** Early reflections: taps spread over this many milliseconds after the reflections delay. */
const REFLECTION_SPREAD_MS = 20;
const REFLECTION_TAPS = 8;
/** Longest response, seconds. */
const MAX_SECONDS = 8;

/**
 * The impulse response of a reverb (stereo), or undefined when it is silent. `random` gives
 * values in [0, 1) (seeded by the caller for a stable response).
 */
export function reverbImpulse(
  reverb: Reverb,
  sampleRate: number,
  random: () => number,
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] | undefined {
  if (reverb.room <= SILENT_DB || (reverb.reverb <= SILENT_DB && reverb.reflections <= SILENT_DB)) {
    return undefined;
  }
  const decay = Math.max(0.1, reverb.decayTime / 1000);
  const decayHf = Math.max(0.05, decay * Math.max(0.1, reverb.decayHfRatio));
  const reflectionsDelay = reverb.reflectionsDelay / 1000;
  const lateStart = reflectionsDelay + reverb.reverbDelay / 1000;
  const seconds = Math.min(MAX_SECONDS, lateStart + Math.max(decay, decayHf));
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const room = dbToGain(reverb.room);
  const late = dbToGain(reverb.reverb) * room;
  const early = dbToGain(reverb.reflections) * room;
  const roomHf = dbToGain(reverb.roomHf);
  // One-pole split of the noise at the HF reference.
  const cutoff = Math.min(0.99, (2 * Math.PI * Math.max(20, reverb.hfReference)) / sampleRate);
  const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  const highPart = new Float32Array(length);
  for (const channel of channels) {
    // The late tail's low and high bands, then scaled to the reverb's energy (before the room
    // HF cut, which takes energy away above the reference).
    let low = 0;
    let energy = 0;
    highPart.fill(0);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate - lateStart;
      if (t < 0) continue;
      const noise = random() * 2 - 1;
      low += cutoff * (noise - low);
      const high = noise - low;
      // −60 dB at the decay time: e^(−6.91 t / T).
      const lowSample = low * Math.exp((-6.91 * t) / decay);
      const highSample = high * Math.exp((-6.91 * t) / decayHf);
      channel[i] = lowSample;
      highPart[i] = highSample;
      energy += (lowSample + highSample) ** 2;
    }
    const scale = energy > 0 ? late / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i++) {
      channel[i] = scale * ((channel[i] ?? 0) + roomHf * (highPart[i] ?? 0));
    }
    // Early reflections: taps whose energies add up to the reflections level.
    const tapLevel = early / Math.sqrt(REFLECTION_TAPS);
    for (let tap = 0; tap < REFLECTION_TAPS; tap++) {
      const at = reflectionsDelay + (random() * REFLECTION_SPREAD_MS) / 1000;
      const index = Math.min(length - 1, Math.floor(at * sampleRate));
      channel[index] = (channel[index] ?? 0) + tapLevel * (random() < 0.5 ? -1 : 1);
    }
  }
  return channels;
}
