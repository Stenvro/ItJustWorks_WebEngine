// The gamepad's two rumble buses on the audio context (docs/audio.md, "Rumble"): the sounds
// whose output model allows rumble send into them (sound-instance.ts), and once a frame the
// sound system reads each bus's loudest sample (rumble.ts turns the peaks into the motors').

import { blockPeak, type RumbleLevels } from './rumble.ts';

/** Samples a bus meter looks at each frame (about one of the original's 10 ms passes). */
const METER_SIZE = 512;

export class RumbleBuses {
  readonly small: GainNode;
  readonly big: GainNode;
  readonly #meters: readonly [AnalyserNode, AnalyserNode];
  readonly #block = new Float32Array(METER_SIZE);

  constructor(context: BaseAudioContext) {
    const bus = (): [GainNode, AnalyserNode] => {
      const gain = context.createGain();
      const meter = context.createAnalyser();
      meter.fftSize = METER_SIZE;
      gain.connect(meter);
      return [gain, meter];
    };
    const [small, smallMeter] = bus();
    const [big, bigMeter] = bus();
    this.small = small;
    this.big = big;
    this.#meters = [smallMeter, bigMeter];
  }

  /** The buses' loudest samples over their latest block. */
  peaks(): RumbleLevels {
    const read = (meter: AnalyserNode): number => {
      meter.getFloatTimeDomainData(this.#block);
      return blockPeak(this.#block);
    };
    return { small: read(this.#meters[0]), big: read(this.#meters[1]) };
  }
}
