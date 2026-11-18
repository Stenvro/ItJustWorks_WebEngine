// A placed sound's distance curve and place as the listener and the sound move: what it sets on
// its nodes each frame (on fake Web Audio nodes that record their parameters' schedules).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SoundDescriptor, SoundOutputModel } from '../src/world/sound-records.ts';
import type { AudioEngine } from '../src/audio/audio-engine.ts';
import { SoundInstance, type SoundBuffer } from '../src/audio/sound-instance.ts';

/** One scheduled change of a parameter: its kind, value and time. */
type Scheduled = readonly [string, number, number];

class FakeParam {
  value = 1;
  readonly calls: Scheduled[] = [];
  setValueAtTime(value: number, time: number): void {
    this.calls.push(['set', value, time]);
  }
  setTargetAtTime(value: number, time: number): void {
    this.calls.push(['target', value, time]);
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push(['ramp', value, time]);
  }
  cancelScheduledValues(): void {
    // Nothing scheduled ahead in these cases.
  }
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  readonly playbackRate = new FakeParam();
  buffer: unknown;
  loop = false;
  onended: (() => void) | null = null;
  connect(): void {
    // The graph is not followed.
  }
  disconnect(): void {
    // The graph is not followed.
  }
  start(): void {
    // Nothing plays.
  }
  stop(): void {
    // Nothing plays.
  }
}

/** Every node made, by kind. */
let made: { panners: FakeNode[]; filters: FakeNode[]; gains: FakeNode[] };
const saved = { panner: globalThis.PannerNode, filter: globalThis.BiquadFilterNode };

beforeEach(() => {
  made = { panners: [], filters: [], gains: [] };
  const record = (list: FakeNode[]): FakeNode => {
    const node = new FakeNode();
    list.push(node);
    return node;
  };
  Object.assign(globalThis, {
    PannerNode: function PannerNode() {
      return record(made.panners);
    },
    BiquadFilterNode: function BiquadFilterNode() {
      return record(made.filters);
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { PannerNode: saved.panner, BiquadFilterNode: saved.filter });
});

const context = {
  currentTime: 0,
  sampleRate: 48000,
  createGain: () => {
    const node = new FakeNode();
    made.gains.push(node);
    return node;
  },
  createBufferSource: () => new FakeNode(),
};

const engine = {
  context,
  reverbSend: new FakeNode(),
  categoryNode: () => new FakeNode(),
  categoryVolume: () => 1,
  held: () => undefined,
} as unknown as AudioEngine;

const descriptor: SoundDescriptor = {
  formId: 1,
  editorId: 'TestLoop',
  category: undefined,
  alternateFor: undefined,
  files: [],
  outputModel: undefined,
  looping: 'loop',
  frequencyShift: 0,
  frequencyVariance: 0,
  priority: 128,
  dbVariance: 0,
  staticAttenuation: 0,
  conditions: [],
};

const model: SoundOutputModel = {
  formId: 2,
  editorId: 'TestModel',
  attenuatesWithDistance: true,
  reverbSend: 0.5,
  uses3d: true,
  speakers: undefined,
  attenuation: { minDistance: 100, maxDistance: 2000, curve: [100, 50, 20, 5, 0] },
};

const sound = { buffer: { duration: 2, numberOfChannels: 1 } } as unknown as SoundBuffer;

/** How many changes the placed sound's parameters have scheduled in all. */
function scheduled(): number {
  return [...made.panners, ...made.filters, ...made.gains]
    .flatMap((node) => [node.gain, node.frequency, node.Q, node.positionX, node.positionY])
    .concat(made.panners.map((node) => node.positionZ))
    .reduce((sum, param) => sum + param.calls.length, 0);
}

describe('a placed sound following its place', () => {
  it('sets its distance curve and place, and nothing again while neither changes', () => {
    const at: [number, number, number] = [500, 0, 0];
    const instance = new SoundInstance(
      engine,
      sound,
      descriptor,
      model,
      () => at,
      () => 0.5,
    );
    const panner = made.panners[0];
    const filter = made.filters[0];
    expect(panner && filter).toBeDefined();
    instance.update([0, 0, 0]);
    const first = scheduled();
    expect(panner?.positionX.calls).toEqual([['set', 500, 0]]);
    // The first update sets the levels at once.
    expect(filter?.frequency.calls.map(([kind]) => kind)).toEqual(['set']);
    // Standing still, and the listener too: nothing more scheduled.
    for (let i = 0; i < 10; i++) instance.update([0, 0, 0]);
    expect(scheduled()).toBe(first);
    // The listener moves: the levels ease toward their new values; the place stays.
    instance.update([100, 0, 0]);
    expect(filter?.frequency.calls.map(([kind]) => kind)).toEqual(['set', 'target']);
    expect(panner?.positionX.calls).toHaveLength(1);
    // The sound moves with the listener (the same distance): only its place is set.
    at[0] = 600;
    const levels = filter?.frequency.calls.length;
    instance.update([200, 0, 0]);
    expect(panner?.positionX.calls.at(-1)).toEqual(['set', 600, 0]);
    expect(filter?.frequency.calls.length).toBe(levels);
  });
});
