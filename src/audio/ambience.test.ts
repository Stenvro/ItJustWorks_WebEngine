import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import { IniSettings } from '../world/ini-settings.ts';
import type { RegionAudio, SoundDescriptor, SoundLooping } from '../world/sound-records.ts';
import {
  Ambience,
  type AmbientPlayer,
  type AmbientSound,
  type AmbientState,
  type AmbientWeather,
} from './ambience.ts';

const descriptor = (formId: number, looping: SoundLooping): SoundDescriptor => ({
  formId,
  editorId: `SNDR${formId.toString(16)}`,
  category: undefined,
  alternateFor: undefined,
  files: ['sound\\fx\\test.wav'],
  outputModel: undefined,
  looping,
  frequencyShift: 0,
  frequencyVariance: 0,
  priority: 128,
  dbVariance: 0,
  staticAttenuation: 0,
  conditions: [],
});

const WIND = 0x100;
const SNOW_WIND = 0x101;
const BIRD = 0x102;
const RAIN = 0x103;
const THUNDER = 0x104;
const GUST = 0x105;

const descriptors = new Map([
  [WIND, descriptor(WIND, 'loop')],
  [SNOW_WIND, descriptor(SNOW_WIND, 'loop')],
  [BIRD, descriptor(BIRD, 'none')],
  [RAIN, descriptor(RAIN, 'loop')],
  [THUNDER, descriptor(THUNDER, 'none')],
  [GUST, descriptor(GUST, 'none')],
]);

const FOREST = 0x200;
const regions = new Map<number, RegionAudio>([
  [
    FOREST,
    {
      priority: 50,
      override: false,
      sounds: [
        { sound: WIND, flags: 0xf, chance: 1 },
        { sound: SNOW_WIND, flags: 0x8, chance: 1 },
        { sound: BIRD, flags: 0x1, chance: 0.05 },
      ],
      music: undefined,
    },
  ],
]);

const clear: AmbientWeather = { formId: 0x300, flags: 0x1, thunderFrequency: 255, sounds: [] };
const storm: AmbientWeather = {
  formId: 0x301,
  flags: 0x4,
  thunderFrequency: 246,
  sounds: [
    { sound: RAIN, type: 1 },
    { sound: THUNDER, type: 3 },
  ],
};
const snowstorm: AmbientWeather = {
  formId: 0x302,
  flags: 0x8,
  thunderFrequency: 255,
  sounds: [{ sound: GUST, type: 2 }],
};

interface Played {
  sound: number;
  place: Vec3 | undefined;
  fadeIn: number;
  level: number;
  fadedOut: number | undefined;
  stopped: boolean;
}

class FakePlayer implements AmbientPlayer {
  readonly played: Played[] = [];

  descriptor(formId: number): Promise<SoundDescriptor | undefined> {
    return Promise.resolve(descriptors.get(formId));
  }

  regionAudio(formId: number): Promise<RegionAudio | undefined> {
    return Promise.resolve(regions.get(formId));
  }

  global(): number {
    return 0;
  }

  play(sound: number, place: Vec3 | undefined, fadeIn: number): Promise<AmbientSound | undefined> {
    const entry: Played = { sound, place, fadeIn, level: 1, fadedOut: undefined, stopped: false };
    this.played.push(entry);
    const instance: AmbientSound = {
      setLevel: (level: number) => {
        entry.level = level;
      },
      fadeOut: (seconds: number) => {
        entry.fadedOut = seconds;
      },
      stop: () => {
        entry.stopped = true;
      },
    };
    return Promise.resolve(instance);
  }

  of(sound: number): Played[] {
    return this.played.filter((entry) => entry.sound === sound);
  }
}

const state = (overrides: Partial<AmbientState> = {}): AmbientState => ({
  regions: [FOREST],
  weather: clear,
  previousWeather: undefined,
  transition: 1,
  hour: 10,
  interior: false,
  swimming: false,
  flash: undefined,
  cellMusic: undefined,
  worldMusic: undefined,
  waterAt: undefined,
  underwater: false,
  ...overrides,
});

const LISTENER: Vec3 = [1000, 2000, 300];

/** Lets the fake player's promises resolve (descriptors and regions load asynchronously). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('ambience', () => {
  const ini = new IniSettings(undefined);
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays the region loops that fit the weather, fading them in and out', async () => {
    const player = new FakePlayer();
    const ambience = new Ambience(player, ini, () => 0.99);
    ambience.update(state(), LISTENER, 0);
    await settle();
    // Updates come every half second.
    ambience.update(state(), LISTENER, 0.1);
    expect(player.of(WIND)).toHaveLength(0);
    ambience.update(state(), LISTENER, 0.5);
    await settle();
    expect(player.of(WIND)).toHaveLength(1);
    expect(player.of(WIND)[0]?.fadeIn).toBe(ini.number('Audio', 'fRegionLoopFadeInTime'));
    expect(player.of(SNOW_WIND)).toHaveLength(0);
    // Snow: the snowy loop joins; out of the weather it fades out.
    ambience.update(state({ weather: snowstorm }), LISTENER, 1);
    await settle();
    expect(player.of(SNOW_WIND)).toHaveLength(1);
    ambience.update(state(), LISTENER, 1.5);
    expect(player.of(SNOW_WIND)[0]?.fadedOut).toBe(ini.number('Audio', 'fRegionLoopFadeOutTime'));
    // Regions without sounds: what plays fades out over 0.3 s.
    ambience.update(state({ regions: [] }), LISTENER, 2);
    expect(player.of(WIND)[0]?.fadedOut).toBe(0.3);
  });

  it('gives one-shots half their chance each half-second update, placed around the listener', async () => {
    const player = new FakePlayer();
    let roll = 0;
    const ambience = new Ambience(player, ini, () => roll);
    ambience.update(state(), LISTENER, 0);
    await settle();
    // The first update starts the wind loop: one sound an update (uRegionSoundsAllowedPerUpdate).
    ambience.update(state(), LISTENER, 0.5);
    expect(player.of(BIRD)).toHaveLength(0);
    ambience.update(state(), LISTENER, 1);
    expect(player.of(BIRD)).toHaveLength(1);
    // Chance 0.05: 0.025 an update.
    roll = 0.03;
    ambience.update(state(), LISTENER, 1.5);
    expect(player.of(BIRD)).toHaveLength(1);
    const place = player.of(BIRD)[0]?.place;
    const [x, y, z] = place ?? [0, 0, 0];
    const base = ini.number('Audio', 'fRegionRandomSoundPlacementBase');
    expect(Math.abs(x - LISTENER[0])).toBeGreaterThanOrEqual(base);
    expect(Math.abs(x - LISTENER[0])).toBeLessThanOrEqual(
      ini.number('Audio', 'fRegionSoundPlacementRandomOffset'),
    );
    expect(Math.abs(y - LISTENER[1])).toBe(base);
    expect(z).toBe(LISTENER[2] + ini.number('Audio', 'fRegionSoundPlacementZOffset'));
    // Not in other weathers than its flags name.
    roll = 0;
    ambience.update(state({ weather: storm }), LISTENER, 4);
    expect(player.of(BIRD)).toHaveLength(1);
  });

  it('crossfades weather loops with a change of weather and plays thunder after flashes', async () => {
    const player = new FakePlayer();
    const ambience = new Ambience(player, ini, () => 0.5);
    const changing = { weather: storm, previousWeather: clear, transition: 0.25, flash: 5 };
    ambience.update(state(changing), LISTENER, 0);
    await settle();
    ambience.update(state(changing), LISTENER, 0.1);
    await settle();
    ambience.update(state(changing), LISTENER, 0.2);
    expect(player.of(RAIN)[0]?.level).toBe(0.25);
    // The flash under way when ambience starts is not followed; the next one is.
    vi.advanceTimersByTime(5000);
    expect(player.of(THUNDER)).toHaveLength(0);
    ambience.update(state({ weather: storm, flash: 9 }), LISTENER, 0.4);
    expect(player.of(THUNDER)).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(player.of(THUNDER)).toHaveLength(1);
    // Indoors: no weather.
    ambience.update(state({ weather: storm, interior: true, regions: [] }), LISTENER, 0.5);
    expect(player.of(RAIN)[0]?.fadedOut).toBeDefined();
  });

  it('plays the single weather sounds of weathers without lightning at random', async () => {
    const player = new FakePlayer();
    const ambience = new Ambience(player, ini, () => 0);
    ambience.update(state({ weather: snowstorm, regions: [] }), LISTENER, 0);
    await settle();
    ambience.update(state({ weather: snowstorm, regions: [] }), LISTENER, 1);
    expect(player.of(GUST)).toHaveLength(1);
  });

  it('stops everything at once', async () => {
    const player = new FakePlayer();
    const ambience = new Ambience(player, ini, () => 0.99);
    ambience.update(state(), LISTENER, 0);
    await settle();
    ambience.update(state(), LISTENER, 0.5);
    await settle();
    ambience.stop();
    expect(player.of(WIND)[0]?.stopped).toBe(true);
  });
});
