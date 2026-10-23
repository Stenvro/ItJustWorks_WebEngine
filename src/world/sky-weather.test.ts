import { describe, expect, it } from 'vitest';
import {
  classShare,
  DEFAULT_WEATHER,
  findInList,
  parseWeatherRegionArea,
  pickFromList,
  precipitating,
  SkyMode,
  skyModeAt,
  SkyWeather,
  weatherRegionAt,
  type SkyClimate,
  type SkyRegion,
  type SkyWeatherHost,
  type WeatherRegionArea,
  type WeatherTraits,
} from './sky-weather.ts';
import type { WeatherChance } from './weather.ts';

const CLEAR = 0x10;
const CLOUDY = 0x11;
const RAIN = 0x12;
const SNOW = 0x13;
const STORM = 0x14;

const traits = (formId: number, flags: number, transDelta = 0.5): WeatherTraits => ({
  formId,
  flags,
  transDelta,
  precipitationFadeIn: 0.4,
  precipitationFadeOut: 0.6,
  windSpeed: flags === 0x4 ? 0.8 : 0.2,
});

const WEATHERS = new Map<number, WeatherTraits>([
  [CLEAR, traits(CLEAR, 0x1)],
  [CLOUDY, traits(CLOUDY, 0x2)],
  [RAIN, traits(RAIN, 0x4)],
  [SNOW, traits(SNOW, 0x8)],
  [STORM, traits(STORM, 0x4, 0)],
]);

const list = (...entries: [number, number][]): WeatherChance[] =>
  entries.map(([weather, chance]) => ({ weather, chance, global: undefined }));

/** A host whose clock and dice the test sets. */
function host(rolls: number[] = []): SkyWeatherHost & { now: number; rolls: number[] } {
  const h = {
    now: 10,
    rolls,
    hour: () => h.now,
    weather: (id: number) => WEATHERS.get(id),
    global: (id: number) => (id === 0x900 ? 30 : undefined),
    random: () => h.rolls.shift() ?? 0,
  };
  return h;
}

// SkyrimClimate's volatility: a weather lasts (205 * 22) / 255 + 1 = 18.69 game hours.
const climate: SkyClimate = { formId: 0x812, weathers: list([CLOUDY, 100]), volatility: 50 };
const LIFETIME = 4510 / 255 + 1;
/** A change to a weather of Trans Delta 0.5 takes 0.5 * (0.25 - 0.01) + 0.01 = 0.13 hours. */
const CHANGE = 0.13;

/** A sky under the climate with a weather in place (forced, then one frame). */
function skyWith(weather: number, h = host()): SkyWeather {
  const sky = new SkyWeather(h);
  sky.setClimate(climate);
  sky.forceWeather(weather, false);
  sky.frame();
  return sky;
}

describe('sky weather', () => {
  it('forces a weather on the next frame, at once', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    expect(sky.current).toBe(CLEAR);
    sky.forceWeather(RAIN, true);
    expect(sky.current).toBe(CLEAR);
    sky.frame();
    expect(sky.current).toBe(RAIN);
    expect(sky.outgoing).toBeUndefined();
    expect(sky.transition).toBe(1);
    expect(sky.override).toBe(RAIN);
    expect(sky.default).toBeUndefined();
  });

  it('changes to an override over the new weather Trans Delta span of game hours', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.setWeather(RAIN, true, false);
    expect(sky.current).toBe(CLEAR);
    sky.frame();
    expect(sky.current).toBe(RAIN);
    expect(sky.outgoing).toBe(CLEAR);
    expect(sky.transition).toBe(0);
    h.now += CHANGE / 2;
    sky.frame();
    expect(sky.transition).toBeCloseTo(0.5, 5);
    h.now += CHANGE / 2 + 0.001;
    sky.frame();
    expect(sky.outgoing).toBeUndefined();
    expect(sky.transition).toBe(1);
  });

  it('lets a new weather wait for a change under way, and hurries it when asked', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.setWeather(RAIN, true, false);
    sky.frame();
    h.now += CHANGE * 0.2;
    sky.frame();
    // Another override waits; accelerated, the rest goes fWeatherTransAccel + 1 = 5 times faster.
    sky.setWeather(SNOW, true, true);
    h.now += CHANGE * 0.1;
    sky.frame();
    expect(sky.current).toBe(RAIN);
    expect(sky.transition).toBeCloseTo(0.2 + 0.1 * 5, 5);
    h.now += CHANGE * 0.1;
    sky.frame();
    expect(sky.outgoing).toBeUndefined();
    // The next frame the snow comes, at the ordinary pace.
    sky.frame();
    expect(sky.current).toBe(SNOW);
    expect(sky.outgoing).toBe(RAIN);
    h.now += CHANGE / 2;
    sky.frame();
    expect(sky.transition).toBeCloseTo(0.5, 5);
  });

  it('holds an override until released or until a weather would have changed', () => {
    const h = host([0.99]);
    const region: SkyRegion = { formId: 0x500, weathers: list([CLEAR, 100]) };
    const sky = skyWith(CLEAR, h);
    sky.enterExterior(region);
    sky.setWeather(STORM, true, false);
    sky.frame();
    expect(sky.current).toBe(STORM);
    h.now += 1;
    sky.frame();
    expect(sky.current).toBe(STORM);
    // Past the lifetime the regions choose again: the region has only clear weather.
    h.now = 10 + LIFETIME + 0.01;
    sky.frame();
    expect(sky.override).toBeUndefined();
    expect(sky.current).toBe(CLEAR);
    expect(sky.outgoing).toBe(STORM);
  });

  it('keeps a young weather the region also has when an override is released', () => {
    const region: SkyRegion = { formId: 0x500, weathers: list([CLEAR, 50], [RAIN, 50]) };
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.enterExterior(region);
    sky.frame();
    sky.setWeather(RAIN, true, false);
    sky.frame();
    h.now += 1;
    sky.frame();
    // Released one game hour in: the region picks clear (roll 0), but the rain is young
    // (1 / 18.69 of its life) and the region has it: a roll above that keeps it.
    h.rolls = [0, 0.5];
    sky.releaseOverride();
    sky.frame();
    expect(sky.current).toBe(RAIN);
    // An old one goes: rolled below the share of its life that has passed.
    h.now += LIFETIME * 0.9;
    sky.setWeather(RAIN, true, false);
    sky.frame();
    h.rolls = [0, 0.5];
    sky.releaseOverride();
    sky.frame();
    expect(sky.current).toBe(CLEAR);
  });

  it('picks again from the region once a weather has had its time, until another comes', () => {
    const region: SkyRegion = { formId: 0x500, weathers: list([CLEAR, 50], [RAIN, 50]) };
    const h = host([0]);
    const sky = new SkyWeather(h);
    sky.setClimate(climate);
    sky.enterExterior(region);
    sky.frame();
    expect(sky.current).toBe(CLEAR);
    h.now += LIFETIME - 0.01;
    sky.frame();
    expect(sky.current).toBe(CLEAR);
    // Over its time: rolls of clear change nothing, the first rain roll brings rain.
    h.now += 0.02;
    h.rolls = [0, 0.1, 0.9];
    sky.frame();
    expect(sky.current).toBe(CLEAR);
    sky.frame();
    expect(sky.current).toBe(CLEAR);
    sky.frame();
    expect(sky.current).toBe(RAIN);
  });

  it('counts the time of a weather across midnight', () => {
    const h = host();
    h.now = 23.95;
    const sky = skyWith(CLEAR, h);
    sky.setWeather(RAIN, true, false);
    sky.frame();
    h.now = 0.015;
    sky.frame();
    expect(sky.transition).toBeCloseTo(0.065 / CHANGE, 4);
  });

  it('a weather set without override stands for the regions until the player moves on', () => {
    const region: SkyRegion = { formId: 0x500, weathers: list([CLEAR, 100]) };
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.enterExterior(region);
    sky.frame();
    sky.setWeather(SNOW, false, false);
    sky.frame();
    expect(sky.current).toBe(SNOW);
    expect(sky.default).toBe(SNOW);
    h.now += CHANGE + 0.01;
    sky.frame();
    // Entering the next cell of the region chooses from it again (the snow is not in it).
    sky.enterExterior(region);
    sky.frame();
    expect(sky.current).toBe(CLEAR);
  });

  it('takes the next weather at once after fast travel', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.setWeather(RAIN, true, false);
    sky.frame();
    sky.setWeather(SNOW, true, false);
    sky.fastTravel();
    sky.frame();
    expect(sky.current).toBe(SNOW);
    expect(sky.outgoing).toBeUndefined();
  });

  it('keeps the weather still in an interior without a sky', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.setWeather(RAIN, true, false);
    sky.frame();
    sky.setPlace({ interior: true, cellFlags: 0x1 });
    expect(sky.mode).toBe(SkyMode.interior);
    h.now += 5;
    sky.frame();
    expect(sky.outgoing).toBe(CLEAR);
    expect(sky.transition).toBe(0);
    // Out again, the hours inside count: the change is done at once.
    sky.setPlace({ interior: false, lightingTemplate: false, noSky: false });
    sky.frame();
    expect(sky.outgoing).toBeUndefined();
    // A forced weather still comes indoors.
    sky.setPlace({ interior: true, cellFlags: 0x1 });
    sky.forceWeather(SNOW, false);
    sky.frame();
    expect(sky.current).toBe(SNOW);
  });

  it('blends the wind of a change under the full sky', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    sky.setWeather(RAIN, true, false);
    sky.frame();
    h.now += CHANGE / 4;
    sky.frame();
    expect(sky.windSpeed).toBeCloseTo(0.8 * 0.25 + 0.2 * 0.75, 5);
  });

  it('finds a weather of a class: the lowest chance, from the region, else the climate', () => {
    const h = host();
    const sky = skyWith(CLEAR, h);
    expect(sky.findWeather(1)).toBe(CLOUDY);
    expect(sky.findWeather(2)).toBeUndefined();
    sky.enterExterior({ formId: 0x500, weathers: list([RAIN, 40], [STORM, 10], [CLEAR, 50]) });
    expect(sky.findWeather(2)).toBe(STORM);
    expect(sky.findWeather(0)).toBe(CLEAR);
    expect(sky.findWeather(1)).toBeUndefined();
    // An interior's sky region comes first; one without weathers finds none.
    sky.enterInterior({ formId: 0x501, weathers: list([SNOW, 100]) });
    expect(sky.findWeather(3)).toBe(SNOW);
    sky.enterInterior(undefined);
    expect(sky.findWeather(2)).toBe(STORM);
  });

  it('starts with a weather from the climate (DefaultWeather if it has none)', () => {
    const sky = new SkyWeather(host());
    sky.setClimate(climate);
    sky.frame();
    expect(sky.current).toBe(CLOUDY);
    const bare = new SkyWeather(host());
    bare.setClimate({ formId: 1, weathers: [], volatility: 0 });
    bare.frame();
    expect(bare.current).toBe(DEFAULT_WEATHER);
  });

  it('toggles the sky off and back to the place', () => {
    const sky = skyWith(CLEAR);
    sky.setPlace({ interior: true, cellFlags: 0x81 });
    expect(sky.mode).toBe(SkyMode.skyDomeOnly);
    expect(sky.toggleSky()).toBe(false);
    expect(sky.mode).toBe(SkyMode.none);
    sky.setPlace({ interior: false, lightingTemplate: false, noSky: false });
    expect(sky.mode).toBe(SkyMode.none);
    expect(sky.toggleSky()).toBe(true);
    expect(sky.mode).toBe(SkyMode.full);
  });
});

describe('sky modes', () => {
  it('follows interiors and worldspaces', () => {
    expect(skyModeAt({ interior: true, cellFlags: 0x1 })).toBe(SkyMode.interior);
    expect(skyModeAt({ interior: true, cellFlags: 0x81 })).toBe(SkyMode.skyDomeOnly);
    expect(skyModeAt({ interior: true, cellFlags: 0x181 })).toBe(SkyMode.full);
    expect(skyModeAt({ interior: false, lightingTemplate: false, noSky: true })).toBe(SkyMode.full);
    expect(skyModeAt({ interior: false, lightingTemplate: true, noSky: false })).toBe(
      SkyMode.skyDomeOnly,
    );
    expect(skyModeAt({ interior: false, lightingTemplate: true, noSky: true })).toBe(
      SkyMode.interior,
    );
  });
});

describe('weather lists', () => {
  it('picks by whole-number chance, a global standing in for one', () => {
    const entries: WeatherChance[] = [
      { weather: CLEAR, chance: 45, global: undefined },
      { weather: CLOUDY, chance: 0, global: undefined },
      { weather: RAIN, chance: 5, global: 0x900 },
    ];
    // 45 + 30 = 75: rolls 0..44 clear, 45..74 rain.
    const at = (roll: number): number | undefined =>
      pickFromList(entries, host([(roll + 0.5) / 2 ** 32]));
    expect(at(0)).toBe(CLEAR);
    expect(at(44)).toBe(CLEAR);
    expect(at(45)).toBe(RAIN);
    expect(at(74)).toBe(RAIN);
    expect(at(75)).toBe(CLEAR);
    expect(pickFromList(list([CLEAR, 0]), host())).toBeUndefined();
  });

  it('finds the lowest chance of a class, the first of equals', () => {
    const h = host();
    expect(findInList(list([RAIN, 30], [STORM, 30]), 2, h)).toBe(RAIN);
    expect(findInList(list([RAIN, 30], [STORM, 0]), 2, h)).toBe(STORM);
  });
});

describe('weather regions', () => {
  const square = (x: number, y: number, size: number): [number, number][] => [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
  const region = (
    formId: number,
    tab: WeatherRegionArea['weather'],
    areas = [square(0, 0, 100)],
    world: number | undefined = 0x3c,
  ): WeatherRegionArea => ({ formId, world, deleted: false, areas, weather: tab });

  it('chooses among the regions around the player: override, then priority, then the first', () => {
    const low = region(1, { override: false, priority: 20, weathers: [] });
    const high = region(2, { override: false, priority: 60, weathers: [] });
    const overriding = region(3, { override: true, priority: 10, weathers: [] });
    const elsewhere = region(4, { override: true, priority: 99, weathers: [] }, [
      square(500, 500, 10),
    ]);
    const otherWorld = region(5, { override: true, priority: 99, weathers: [] }, undefined, 0x99);
    const noWeather = region(6, undefined);
    const tie = region(7, { override: false, priority: 60, weathers: [] });
    expect(weatherRegionAt([low, high, tie], 0x3c, 50, 50)?.formId).toBe(2);
    expect(weatherRegionAt([high, overriding], 0x3c, 50, 50)?.formId).toBe(3);
    expect(weatherRegionAt([low, elsewhere, otherWorld, noWeather], 0x3c, 50, 50)?.formId).toBe(1);
    expect(weatherRegionAt([noWeather, undefined], 0x3c, 50, 50)).toBeUndefined();
  });

  it('reads a region record: areas, world, weather tab (also one without a list)', () => {
    const f32s = (...values: number[]): Uint8Array =>
      new Uint8Array(new Float32Array(values).buffer);
    const u32s = (...values: number[]): Uint8Array =>
      new Uint8Array(new Uint32Array(values).buffer);
    const rdat = (type: number, flags: number, priority: number): Uint8Array => {
      const data = new Uint8Array(8);
      new DataView(data.buffer).setUint32(0, type, true);
      data[4] = flags;
      data[5] = priority;
      return data;
    };
    const record = (fields: [string, Uint8Array][], flags = 0) => ({
      formId: 0x700,
      flags,
      fields: { list: fields.map(([type, data]) => ({ type, data })) },
      formIdField: (type: string) => {
        const field = fields.find(([t]) => t === type)?.[1];
        return field && new DataView(field.buffer).getUint32(0, true);
      },
      formIdAt: (data: Uint8Array, offset: number) =>
        new DataView(data.buffer, data.byteOffset).getUint32(offset, true),
    });
    const parsed = parseWeatherRegionArea(
      record([
        ['WNAM', u32s(0x3c)],
        ['RPLI', u32s(0)],
        ['RPLD', f32s(0, 0, 10, 0, 10, 10)],
        ['RDAT', rdat(2, 0, 10)],
        ['RDAT', rdat(3, 1, 50)],
        ['RDWT', u32s(CLEAR, 70, 0, RAIN, 30, 0x900)],
      ]),
    );
    expect(parsed.world).toBe(0x3c);
    expect(parsed.areas).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    ]);
    expect(parsed.weather?.override).toBe(true);
    expect(parsed.weather?.priority).toBe(50);
    expect(parsed.weather?.weathers).toEqual([
      { weather: CLEAR, chance: 70, global: undefined },
      { weather: RAIN, chance: 30, global: 0x900 },
    ]);
    const empty = parseWeatherRegionArea(record([['RDAT', rdat(3, 0, 5)]], 0x20));
    expect(empty.weather?.weathers).toEqual([]);
    expect(empty.deleted).toBe(true);
  });
});

describe('weather conditions', () => {
  const rain = WEATHERS.get(RAIN);
  const clear = WEATHERS.get(CLEAR);
  it('rains past the fade-in of a rainy weather, and until the fade-out of one being left', () => {
    expect(precipitating(rain, clear, 0.39, 0x4)).toBe(false);
    expect(precipitating(rain, clear, 0.41, 0x4)).toBe(true);
    expect(precipitating(clear, rain, 0.59, 0x4)).toBe(true);
    expect(precipitating(clear, rain, 0.61, 0x4)).toBe(false);
    expect(precipitating(rain, undefined, 1, 0x8)).toBe(false);
  });

  it('shares a class between the weathers of a change', () => {
    expect(classShare(clear, rain, 0.3, 0x1)).toBeCloseTo(0.3, 5);
    expect(classShare(rain, clear, 0.3, 0x1)).toBeCloseTo(0.7, 5);
    expect(classShare(clear, undefined, 1, 0x1)).toBe(1);
  });
});
