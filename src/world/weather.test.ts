import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  CLOUD_LAYERS,
  cellWeathers,
  cloudTextureField,
  parseClimate,
  parseRegionWeather,
  parseWeather,
  pickWeather,
  RegionDataType,
  WeatherColor,
  type WeatherSource,
} from './weather.ts';

function record(fields: [string, Uint8Array][], editorId = 'Test'): WeatherSource {
  return {
    formId: 0x100,
    editorId,
    fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
    formIdAt: (data, offset) =>
      new DataView(data.buffer, data.byteOffset).getUint32(offset ?? 0, true),
  };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);

function floats(values: number[]): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    new DataView(data.buffer).setFloat32(i * 4, v, true);
  });
  return data;
}

function u32s(values: number[]): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    new DataView(data.buffer).setUint32(i * 4, v, true);
  });
  return data;
}

describe('cloudTextureField', () => {
  it('counts on in ASCII after 9', () => {
    expect(cloudTextureField(0)).toBe('00TX');
    expect(cloudTextureField(9)).toBe('90TX');
    expect(cloudTextureField(10)).toBe(':0TX');
    expect(cloudTextureField(CLOUD_LAYERS - 1)).toBe('O0TX');
  });
});

describe('parseWeather', () => {
  it('reads cloud layers: texture, speed, colours, alphas and disabled bits', () => {
    const pnam = new Uint8Array(512);
    pnam.set([255, 128, 0, 0], 1 * 16 + 1 * 4); // layer 1, day
    const rnam = new Uint8Array(32).fill(127);
    const qnam = new Uint8Array(32).fill(127);
    qnam[1] = 254;
    rnam[1] = 0;
    const weather = parseWeather(
      record([
        ['10TX', text('Sky\\SkyrimCloudsUpper01.dds')],
        ['RNAM', rnam],
        ['QNAM', qnam],
        ['PNAM', pnam],
        ['JNAM', floats(Array.from({ length: 128 }, (_, i) => (i === 1 * 4 + 1 ? 0.5 : 1)))],
        ['NAM1', u32s([1 << 2])],
      ]),
    );
    const layer = weather.clouds[1];
    expect(layer?.texture).toBe('textures\\sky\\skyrimcloudsupper01.dds');
    expect(layer?.speed[0]).toBeCloseTo(0.1, 5);
    expect(layer?.speed[1]).toBeCloseTo(-0.1, 5);
    expect(layer?.colors[1]).toEqual([1, 128 / 255, 0]);
    expect(layer?.alphas[1]).toBe(0.5);
    expect(layer?.enabled).toBe(true);
    expect(weather.clouds[2]?.enabled).toBe(false);
    expect(weather.clouds[0]?.texture).toBe('');
    expect(weather.clouds[0]?.speed).toEqual([0, 0]);
  });

  it('reads NAM0 colours per time of day and fills the defaults of short tables', () => {
    const nam0 = new Uint8Array(13 * 16);
    nam0.set([10, 20, 30, 0], WeatherColor.sunlight * 16 + 3 * 4); // night sunlight
    const weather = parseWeather(record([['NAM0', nam0]]));
    expect(weather.colors[WeatherColor.sunlight]?.[3]).toEqual([10 / 255, 20 / 255, 30 / 255]);
    expect(weather.colors[WeatherColor.waterMultiplier]?.[1]).toEqual([1, 1, 1]);
    expect(weather.colors[WeatherColor.fogFar]?.[1]).toEqual([0, 0, 0]);
  });

  it('reads fog, DATA, image spaces and directional ambient', () => {
    const data = new Uint8Array(19);
    data.set([255, 0, 0, 255, 191]);
    data[11] = 0x04;
    data[17] = 128;
    const dalc = (value: number): Uint8Array => {
      const entry = new Uint8Array(32);
      entry.fill(value, 0, 24);
      new DataView(entry.buffer).setFloat32(28, 0.5, true);
      return entry;
    };
    const weather = parseWeather(
      record([
        ['FNAM', floats([100, 80000, 50, 40000, 0.4, 0.5, 0.85, 0.9])],
        ['DATA', data],
        ['IMSP', u32s([0x10, 0x11, 0, 0x13])],
        ['DALC', dalc(10)],
        ['DALC', dalc(20)],
        ['DALC', dalc(30)],
        ['DALC', dalc(40)],
        ['MODL', text('Sky\\SkyrimAurora.nif')],
      ]),
    );
    expect(weather.fog).toEqual({
      dayNear: 100,
      dayFar: 80000,
      nightNear: 50,
      nightFar: 40000,
      dayPower: expect.closeTo(0.4, 5) as number,
      nightPower: 0.5,
      dayMax: expect.closeTo(0.85, 5) as number,
      nightMax: expect.closeTo(0.9, 5) as number,
    });
    expect(weather.windSpeed).toBe(1);
    expect(weather.transDelta).toBeCloseTo(0.25, 5);
    expect(weather.sunGlare).toBeCloseTo(0.75, 2);
    expect(weather.flags).toBe(0x04);
    expect(weather.windDirection).toBeCloseTo(180.7, 1);
    expect(weather.imageSpaces).toEqual([0x10, 0x11, undefined, 0x13]);
    expect(weather.directionalAmbient?.[3]?.colors[5]).toEqual([40 / 255, 40 / 255, 40 / 255]);
    expect(weather.directionalAmbient?.[0]?.fresnelPower).toBe(0.5);
    expect(weather.aurora).toBe('meshes\\sky\\skyrimaurora.nif');
  });
});

describe('parseClimate', () => {
  it('reads the weather list, sun textures and timing in 10-minute units', () => {
    const tnam = Uint8Array.from([33, 60, 96, 123, 0, 0xc3]);
    const climate = parseClimate(
      record([
        ['WLST', u32s([0x200, 60, 0, 0x201, 40, 0x300])],
        ['FNAM', text('Sky\\Sun.dds')],
        ['GNAM', text('Sky\\SunGlare.dds')],
        ['MODL', text('Sky\\Stars.nif')],
        ['TNAM', tnam],
      ]),
    );
    expect(climate.weathers).toEqual([
      { weather: 0x200, chance: 60, global: undefined },
      { weather: 0x201, chance: 40, global: 0x300 },
    ]);
    expect(climate.sunTexture).toBe('textures\\sky\\sun.dds');
    expect(climate.skyModel).toBe('meshes\\sky\\stars.nif');
    expect(climate.timing).toEqual({
      sunriseBegin: 5.5,
      sunriseEnd: 10,
      sunsetBegin: 16,
      sunsetEnd: 20.5,
    });
    expect(climate.masser).toBe(true);
    expect(climate.secunda).toBe(true);
    expect(climate.phaseLength).toBe(3);
  });
});

describe('region weather', () => {
  const rdat = (type: number, priority: number): Uint8Array => {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setUint32(0, type, true);
    data[5] = priority;
    return data;
  };

  it('reads the weather list of the weather tab', () => {
    const region = parseRegionWeather(
      record([
        ['RDAT', rdat(RegionDataType.objects, 10)],
        ['RDAT', rdat(RegionDataType.weather, 50)],
        ['RDWT', u32s([0x200, 70, 0, 0x201, 30, 0])],
      ]),
    );
    expect(region?.priority).toBe(50);
    expect(region?.weathers.map((w) => w.weather)).toEqual([0x200, 0x201]);
    expect(parseRegionWeather(record([['RDAT', rdat(RegionDataType.sound, 1)]]))).toBeUndefined();
  });

  it('takes the highest-priority region list, else the climate', () => {
    const list = (weather: number) => [{ weather, chance: 100, global: undefined }];
    const climate = parseClimate(record([['WLST', u32s([0x900, 100, 0])]]));
    expect(
      cellWeathers(
        [
          { priority: 50, override: false, weathers: list(1) },
          undefined,
          { priority: 60, override: false, weathers: list(2) },
        ],
        climate,
      ),
    ).toEqual(list(2));
    expect(cellWeathers([undefined], climate)).toEqual(list(0x900));
  });

  it('picks weathers by chance', () => {
    const entries = [
      { weather: 1, chance: 45, global: undefined },
      { weather: 2, chance: 55, global: undefined },
    ];
    expect(pickWeather(entries, 0)).toBe(1);
    expect(pickWeather(entries, 0.44)).toBe(1);
    expect(pickWeather(entries, 0.46)).toBe(2);
    expect(pickWeather(entries, 0.999)).toBe(2);
    expect(pickWeather([], 0.5)).toBeUndefined();
  });
});
