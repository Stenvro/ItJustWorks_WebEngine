import { describe, expect, it } from 'vitest';
import { MusicTypeFlag, type MusicTrack, type MusicType } from '../world/sound-records.ts';
import { dbToGain } from './attenuation.ts';
import { Music, type MusicBus, type MusicOutput, type MusicVoice } from './music.ts';
import type { SoundConditionContext } from './sound-conditions.ts';

const context: SoundConditionContext = {
  hour: 10,
  weather: undefined,
  raining: false,
  interior: false,
  swimming: false,
  global: () => 0,
};

const type = (formId: number, overrides: Partial<MusicType>): MusicType => ({
  formId,
  editorId: `MUSC${formId.toString(16)}`,
  flags: 0,
  priority: 50,
  ducking: 0,
  fadeDuration: 0,
  tracks: [],
  ...overrides,
});

const track = (formId: number, overrides: Partial<MusicTrack>): MusicTrack => ({
  formId,
  editorId: `MUST${formId.toString(16)}`,
  type: 'single',
  duration: 0,
  fadeOut: 0,
  file: undefined,
  finale: undefined,
  loop: undefined,
  cuePoints: [],
  conditions: [],
  layers: [],
  ...overrides,
});

class FakeVoice implements MusicVoice {
  readonly file: string;
  readonly fadeIn: number;
  readonly #clock: { now: number };
  readonly #start: number;
  readonly #length: number;
  stoppedAt: number | undefined;
  stopFade = 0;

  constructor(file: string, fadeIn: number, clock: { now: number }, length: number) {
    this.file = file;
    this.fadeIn = fadeIn;
    this.#clock = clock;
    this.#start = clock.now;
    this.#length = length;
  }

  get position(): number {
    return this.#clock.now - this.#start;
  }

  get ended(): boolean {
    if (this.stoppedAt !== undefined) return this.#clock.now >= this.stoppedAt + this.stopFade;
    return this.position >= this.#length;
  }

  stop(seconds: number): void {
    if (this.stoppedAt !== undefined) return;
    this.stoppedAt = this.#clock.now;
    this.stopFade = seconds;
  }
}

class FakeBus implements MusicBus {
  level = 1;
  fadeSeconds = 0;
  disposed = false;

  fade(level: number, seconds: number): void {
    this.level = level;
    this.fadeSeconds = seconds;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeOutput implements MusicOutput {
  readonly clock = { now: 0 };
  readonly voices: FakeVoice[] = [];
  readonly buses: FakeBus[] = [];
  readonly types = new Map<number, MusicType>();
  readonly tracks = new Map<number, MusicTrack>();
  /** File lengths, seconds. */
  readonly files = new Map<string, number>();

  musicType(formId: number): Promise<MusicType | undefined> {
    return Promise.resolve(this.types.get(formId));
  }

  musicTrack(formId: number): Promise<MusicTrack | undefined> {
    return Promise.resolve(this.tracks.get(formId));
  }

  prepare(file: string): boolean {
    return this.files.has(file);
  }

  play(file: string, bus: MusicBus, fadeIn: number): MusicVoice | undefined {
    const length = this.files.get(file);
    if (length === undefined || !this.buses.includes(bus as FakeBus)) return undefined;
    const voice = new FakeVoice(file, fadeIn, this.clock, length);
    this.voices.push(voice);
    return voice;
  }

  bus(): MusicBus {
    const bus = new FakeBus();
    this.buses.push(bus);
    return bus;
  }

  /** Files started, in order. */
  get played(): string[] {
    return this.voices.map((voice) => voice.file);
  }

  playing(file: string): FakeVoice | undefined {
    return this.voices.find((voice) => voice.file === file && !voice.ended);
  }
}

/** Lets loads resolve, then runs the music for `seconds` in steps. */
async function run(music: Music, output: FakeOutput, seconds: number, step = 0.5): Promise<void> {
  for (let t = 0; t < seconds; t += step) {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    music.update(output.clock.now, context);
    output.clock.now += step;
  }
}

const SETTINGS = { duckingSeconds: 6, unDuckingSeconds: 8, finaleFadeIn: 3, finaleFadeOut: 6 };

function explore(output: FakeOutput): void {
  output.types.set(
    0x10,
    type(0x10, {
      priority: 49,
      flags: MusicTypeFlag.cycleTracks,
      fadeDuration: 12,
      tracks: [1, 2, 3],
    }),
  );
  output.tracks.set(1, track(1, { file: 'music\\day.wav' }));
  output.tracks.set(2, track(2, { type: 'silent', duration: 10 }));
  output.tracks.set(3, track(3, { file: 'music\\night.wav', conditions: [night] }));
  output.files.set('music\\day.wav', 20);
  output.files.set('music\\night.wav', 20);
}

/** GetCurrentTime >= 22: never at 10:00. */
const night = {
  function: 18,
  operator: 3,
  comparand: 22,
  or: false,
  form: 0,
  param2: 0,
  strings: [],
};

describe('music', () => {
  it('plays the location type, skipping tracks whose conditions do not hold, and cycles', async () => {
    const output = new FakeOutput();
    explore(output);
    const music = new Music(output, SETTINGS, () => 0);
    music.setLocation(0x10);
    await run(music, output, 75);
    expect(output.played.every((file) => file === 'music\\day.wav')).toBe(true);
    // 20 s day, 10 s silence, again: three times in 75 s.
    expect(output.played).toHaveLength(3);
    expect(music.state.current).toBe(0x10);
  });

  it('keeps the order of types that maintain it, and ends types that do not cycle', async () => {
    const output = new FakeOutput();
    output.types.set(0x20, type(0x20, { flags: MusicTypeFlag.maintainTrackOrder, tracks: [4, 5] }));
    output.tracks.set(4, track(4, { file: 'a.wav' }));
    output.tracks.set(5, track(5, { file: 'b.wav' }));
    output.files.set('a.wav', 5);
    output.files.set('b.wav', 5);
    const music = new Music(output, SETTINGS, () => 0.99);
    music.setLocation(0x20);
    await run(music, output, 30);
    expect(output.played).toEqual(['a.wav', 'b.wav']);
  });

  it('ducks the current music under combat, which ends at a cue point in its finale', async () => {
    const output = new FakeOutput();
    explore(output);
    output.types.set(
      0x30,
      type(0x30, {
        priority: 2,
        flags: MusicTypeFlag.ducksCurrentTrack | MusicTypeFlag.cycleTracks,
        ducking: 100,
        fadeDuration: 9,
        tracks: [6],
      }),
    );
    output.tracks.set(
      6,
      track(6, { file: 'combat.wav', finale: 'finale.wav', cuePoints: [4, 8, 12] }),
    );
    output.files.set('combat.wav', 60);
    output.files.set('finale.wav', 5);
    const music = new Music(output, SETTINGS, () => 0.99);
    music.setLocation(0x10);
    await run(music, output, 2);
    const exploreBus = output.buses[0];
    music.add(0x30);
    await run(music, output, 5);
    expect(music.state.current).toBe(0x30);
    expect(music.state.ducked).toEqual([0x10]);
    expect(exploreBus?.level).toBeCloseTo(dbToGain(-100));
    expect(exploreBus?.fadeSeconds).toBe(9);
    expect(output.playing('combat.wav')).toBeDefined();
    expect(output.playing('music\\day.wav')).toBeDefined();
    // Combat ends: the next cue point (8 s into the track) crossfades into the finale.
    music.remove(0x30);
    await run(music, output, 1);
    expect(output.playing('finale.wav')).toBeUndefined();
    await run(music, output, 3);
    const finale = output.voices.find((voice) => voice.file === 'finale.wav');
    expect(finale?.fadeIn).toBe(3);
    expect(output.voices.find((voice) => voice.file === 'combat.wav')?.stopFade).toBe(6);
    expect(music.state.current).toBe(0x10);
    // The explore music stays ducked until the finale has ended.
    expect(exploreBus?.level).toBeCloseTo(dbToGain(-100));
    await run(music, output, 8);
    expect(music.state.leaving).toEqual([]);
    expect(exploreBus?.level).toBe(1);
    expect(exploreBus?.fadeSeconds).toBe(9);
  });

  it('lets the old type fade out before a new one starts', async () => {
    const output = new FakeOutput();
    explore(output);
    output.types.set(0x40, type(0x40, { fadeDuration: 6, tracks: [7] }));
    output.tracks.set(7, track(7, { file: 'dungeon.wav' }));
    output.files.set('dungeon.wav', 30);
    const music = new Music(output, SETTINGS, () => 0.99);
    music.setLocation(0x10);
    await run(music, output, 2);
    music.setLocation(0x40);
    await run(music, output, 3);
    expect(output.voices[0]?.stopFade).toBe(6);
    expect(output.playing('dungeon.wav')).toBeUndefined();
    await run(music, output, 5);
    expect(output.playing('dungeon.wav')).toBeDefined();
    expect(output.buses[0]?.disposed).toBe(true);
  });

  it('plays one selection and drops types that do not queue', async () => {
    const output = new FakeOutput();
    explore(output);
    output.types.set(
      0x50,
      type(0x50, {
        priority: 3,
        flags: MusicTypeFlag.playsOneSelection | MusicTypeFlag.ducksCurrentTrack,
        ducking: 20,
        tracks: [8, 8],
      }),
    );
    output.tracks.set(8, track(8, { file: 'discover.wav' }));
    output.files.set('discover.wav', 4);
    output.types.set(
      0x60,
      type(0x60, { priority: 60, flags: MusicTypeFlag.doesNotQueue, tracks: [8] }),
    );
    const music = new Music(output, SETTINGS, () => 0.99);
    music.setLocation(0x10);
    await run(music, output, 1);
    music.add(0x50);
    music.add(0x60);
    await run(music, output, 2);
    expect(music.state.added).toEqual([0x50]);
    expect(output.buses[0]?.fadeSeconds).toBe(6);
    await run(music, output, 6);
    expect(output.played.filter((file) => file === 'discover.wav')).toHaveLength(1);
    expect(music.state.added).toEqual([]);
    expect(music.state.current).toBe(0x10);
    expect(output.buses[0]?.level).toBe(1);
    expect(output.buses[0]?.fadeSeconds).toBe(8);
  });

  it('plays the layers of a palette together until its duration, then fades them out', async () => {
    const output = new FakeOutput();
    output.types.set(0x70, type(0x70, { flags: MusicTypeFlag.cycleTracks, tracks: [9] }));
    output.tracks.set(
      9,
      track(9, { type: 'palette', duration: 30, fadeOut: 5, layers: [[10, 11], [12]] }),
    );
    output.tracks.set(10, track(10, { file: 'a1.wav' }));
    output.tracks.set(11, track(11, { type: 'silent', duration: 3 }));
    output.tracks.set(12, track(12, { file: 'b1.wav' }));
    output.files.set('a1.wav', 8);
    output.files.set('b1.wav', 12);
    const music = new Music(output, SETTINGS, () => 0);
    music.setLocation(0x70);
    await run(music, output, 2);
    expect(output.playing('a1.wav')).toBeDefined();
    expect(output.playing('b1.wav')).toBeDefined();
    await run(music, output, 27);
    // Layer B chained its piece: 0, 12, 24 s.
    expect(output.played.filter((file) => file === 'b1.wav')).toHaveLength(3);
    await run(music, output, 3);
    const fading = output.voices.filter((voice) => voice.stoppedAt !== undefined);
    expect(fading.some((voice) => voice.stopFade === 5)).toBe(true);
  });
});
