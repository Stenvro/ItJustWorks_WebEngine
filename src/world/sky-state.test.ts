import { describe, expect, it } from 'vitest';
import {
  arcDirection,
  moonPhase,
  skySettings,
  skyState,
  sunAngle,
  timeOfDayWeights,
} from './sky-state.ts';
import {
  CLOUD_LAYERS,
  DEFAULT_TIMING,
  TIMES_OF_DAY,
  WEATHER_COLORS,
  WeatherColor,
  type Rgb,
  type WeatherRecord,
} from './weather.ts';

function weather(overrides: Partial<WeatherRecord> = {}): WeatherRecord {
  // Colour = time of day index / 3 (sunrise 0, day 1/3, sunset 2/3, night 1).
  const colors = Array.from({ length: WEATHER_COLORS }, () =>
    Array.from({ length: TIMES_OF_DAY }, (_, t): Rgb => [t / 3, t / 3, t / 3]),
  );
  return {
    formId: 1,
    editorId: 'Test',
    clouds: Array.from({ length: CLOUD_LAYERS }, () => ({
      texture: '',
      speed: [0, 0] as const,
      colors: [],
      alphas: [],
      enabled: true,
    })),
    colors,
    fog: {
      dayNear: 0,
      dayFar: 80000,
      nightNear: 0,
      nightFar: 40000,
      dayPower: 1,
      nightPower: 1,
      dayMax: 1,
      nightMax: 1,
    },
    windSpeed: 0,
    transDelta: 0.01,
    sunGlare: 0.5,
    sunDamage: 0,
    precipitationFadeIn: 0,
    precipitationFadeOut: 0,
    thunderFadeIn: 0,
    thunderFadeOut: 0,
    thunderFrequency: 0,
    flags: 0,
    lightningColor: [0, 0, 0],
    visualEffectBegin: 0,
    visualEffectEnd: 0,
    windDirection: 0,
    windDirectionRange: 0,
    imageSpaces: [10, 11, 12, 13],
    directionalAmbient: undefined,
    precipitation: undefined,
    visualEffect: undefined,
    sounds: [],
    skyStatics: [],
    aurora: '',
    ...overrides,
  };
}

const sum = (weights: readonly number[]): number => weights.reduce((a, b) => a + b, 0);

describe('timeOfDayWeights', () => {
  it('is night before sunrise and after sunset', () => {
    expect(timeOfDayWeights(3)).toEqual([0, 0, 0, 1]);
    expect(timeOfDayWeights(22)).toEqual([0, 0, 0, 1]);
  });

  it('peaks at sunrise and sunset halfway through them, day between', () => {
    expect(timeOfDayWeights(7.75)).toEqual([1, 0, 0, 0]);
    expect(timeOfDayWeights(13)).toEqual([0, 1, 0, 0]);
    expect(timeOfDayWeights(18.25)).toEqual([0, 0, 1, 0]);
  });

  it('blends linearly in the transitions and always adds up to 1', () => {
    const [sunrise, , , night] = timeOfDayWeights(6.625);
    expect(sunrise).toBeCloseTo(0.5, 5);
    expect(night).toBeCloseTo(0.5, 5);
    for (let hour = 0; hour < 24; hour += 0.25) {
      expect(sum(timeOfDayWeights(hour))).toBeCloseTo(1, 6);
    }
  });

  it('wraps hours outside 0..24', () => {
    expect(timeOfDayWeights(37)).toEqual(timeOfDayWeights(13));
  });
});

describe('the sun', () => {
  it('rises in the east a quarter hour before the middle of sunrise', () => {
    expect(sunAngle(7.5, DEFAULT_TIMING)).toBeCloseTo(0, 6);
    const [x, , z] = arcDirection(sunAngle(7.5));
    expect(x).toBeCloseTo(1, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it('passes just north of the zenith at midday and sets in the west', () => {
    const noon = arcDirection(sunAngle(13));
    expect(noon[2]).toBeGreaterThan(0.99);
    expect(noon[1]).toBeGreaterThan(0); // north
    const [x, , z] = arcDirection(sunAngle(18.5));
    expect(x).toBeCloseTo(-1, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it('is below the horizon at night', () => {
    expect(arcDirection(sunAngle(0))[2]).toBeLessThan(-0.9);
  });
});

describe('moonPhase', () => {
  it('advances one of eight phases every phase length', () => {
    expect(moonPhase(0, 3)).toBe(0);
    expect(moonPhase(2.9, 3)).toBe(0);
    expect(moonPhase(3, 3)).toBe(1);
    expect(moonPhase(24, 3)).toBe(0);
  });
});

describe('skyState', () => {
  it('blends colours by time of day', () => {
    const state = skyState({
      weather: weather(),
      climate: undefined,
      hour: 13,
      daysPassed: 0,
      cloudMinutes: 0,
    });
    expect(state.skyUpper).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(state.fogFarDistance).toBe(80000);
    expect(state.imageSpaces).toEqual([{ formId: 11, weight: 1 }]);
    expect(state.starsAlpha).toBe(0);
  });

  it('uses night fog distances at night and lights from above', () => {
    const state = skyState({
      weather: weather(),
      climate: undefined,
      hour: 1,
      daysPassed: 0,
      cloudMinutes: 0,
    });
    expect(state.fogFarDistance).toBe(40000);
    expect(state.lightDirection[2]).toBeGreaterThan(0);
    expect(state.starsAlpha).toBe(1);
  });

  it('fades between two weathers', () => {
    const dark = weather();
    const bright = weather({
      colors: dark.colors.map((times, i) =>
        i === WeatherColor.horizon ? times.map((): Rgb => [1, 1, 1]) : times,
      ),
    });
    const state = skyState({
      weather: bright,
      previous: dark,
      transition: 0.5,
      climate: undefined,
      hour: 13,
      daysPassed: 0,
      cloudMinutes: 0,
    });
    expect(state.horizon[0]).toBeCloseTo((1 / 3 + 1) / 2, 6);
  });

  it('scrolls cloud layers with their speed', () => {
    const clouds = weather().clouds.map((layer, i) =>
      i === 3
        ? {
            ...layer,
            texture: 'textures\\sky\\a.dds',
            speed: [0.01, -0.02] as const,
            colors: [[1, 1, 1] as Rgb, [1, 1, 1] as Rgb, [1, 1, 1] as Rgb, [1, 1, 1] as Rgb],
            alphas: [1, 1, 1, 1],
          }
        : layer,
    );
    const state = skyState({
      weather: weather({ clouds }),
      climate: undefined,
      hour: 13,
      daysPassed: 0,
      cloudMinutes: 10,
    });
    expect(state.clouds.map((c) => c.layer)).toEqual([3]);
    expect(state.clouds[0]?.offset[0]).toBeCloseTo(0.1, 6);
    expect(state.clouds[0]?.offset[1]).toBeCloseTo(0.8, 6);
  });
});

describe('skySettings', () => {
  it('reads game settings and keeps defaults for missing ones', () => {
    const settings = skySettings((id) => (id === 'iMasserSize' ? 120 : undefined));
    expect(settings.masserSize).toBe(120);
    expect(settings.secundaSize).toBe(40);
  });
});
