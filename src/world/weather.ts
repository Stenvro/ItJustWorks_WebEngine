// Climates (CLMT), weathers (WTHR) and region weather lists (REGN): what the sky, the sun,
// fog and ambient light look like at a time of day. Platform-independent.
// Layouts: docs/formats/esm.md ("Climate and weather"); UESP "Skyrim Mod:Mod File Format".

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

/** What the parsers need of a record. */
export type WeatherSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

export type Rgb = readonly [number, number, number];

/** The four times of day every weather colour is given for. */
export const TimeOfDay = { sunrise: 0, day: 1, sunset: 2, night: 3 } as const;
export const TIMES_OF_DAY = 4;

/** WTHR NAM0: the weather's colours, each given per time of day. */
export const WeatherColor = {
  skyUpper: 0,
  fogNear: 1,
  ambient: 3,
  sunlight: 4,
  sun: 5,
  stars: 6,
  skyLower: 7,
  horizon: 8,
  effectLighting: 9,
  cloudLodDiffuse: 10,
  cloudLodAmbient: 11,
  fogFar: 12,
  skyStatics: 13,
  waterMultiplier: 14,
  sunGlare: 15,
  moonGlare: 16,
} as const;
export const WEATHER_COLORS = 17;

/** WTHR DATA flags. */
export const WeatherFlag = {
  pleasant: 0x01,
  cloudy: 0x02,
  rainy: 0x04,
  snow: 0x08,
  alwaysVisible: 0x10,
  followsSunPosition: 0x20,
} as const;

/** Cloud layers a weather can have (clouds.nif has 29 shapes for them). */
export const CLOUD_LAYERS = 32;

export interface CloudLayer {
  /** Texture path ('' when the layer has none). */
  readonly texture: string;
  /** Scroll speed in texture widths per second (x, y). */
  readonly speed: readonly [number, number];
  readonly colors: readonly Rgb[];
  readonly alphas: readonly number[];
  readonly enabled: boolean;
}

export interface WeatherFog {
  readonly dayNear: number;
  readonly dayFar: number;
  readonly nightNear: number;
  readonly nightFar: number;
  readonly dayPower: number;
  readonly nightPower: number;
  readonly dayMax: number;
  readonly nightMax: number;
}

export interface DirectionalAmbient {
  /** Light arriving from +X, −X, +Y, −Y, +Z, −Z. */
  readonly colors: readonly Rgb[];
  readonly specular: Rgb;
  readonly fresnelPower: number;
}

export interface WeatherRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly clouds: readonly CloudLayer[];
  /** WEATHER_COLORS × TIMES_OF_DAY, 0..1. */
  readonly colors: readonly (readonly Rgb[])[];
  readonly fog: WeatherFog;
  /** 0..1. */
  readonly windSpeed: number;
  /** Fraction of the transition done per second at fWeatherTransAccel 1 (0..0.25). */
  readonly transDelta: number;
  readonly sunGlare: number;
  readonly sunDamage: number;
  readonly precipitationFadeIn: number;
  readonly precipitationFadeOut: number;
  readonly thunderFadeIn: number;
  readonly thunderFadeOut: number;
  readonly thunderFrequency: number;
  /** WeatherFlag bits. */
  readonly flags: number;
  readonly lightningColor: Rgb;
  readonly visualEffectBegin: number;
  readonly visualEffectEnd: number;
  /** Degrees (0..360) and spread (0..180). */
  readonly windDirection: number;
  readonly windDirectionRange: number;
  /** IMGS per time of day. */
  readonly imageSpaces: readonly (number | undefined)[];
  /** DALC per time of day (undefined: none). */
  readonly directionalAmbient: readonly DirectionalAmbient[] | undefined;
  /** SPGD (rain, snow). */
  readonly precipitation: number | undefined;
  /** RFCT visual effect. */
  readonly visualEffect: number | undefined;
  readonly sounds: readonly { readonly sound: number; readonly type: number }[];
  /** STAT records drawn in the sky (TNAM). */
  readonly skyStatics: readonly number[];
  /** Aurora model (meshes\...), '' for none. */
  readonly aurora: string;
}

const meshPath = (value: string): string => withRoot('meshes', value);
const texturePath = (value: string): string => withRoot('textures', value);

function withRoot(root: string, value: string): string {
  if (value === '') return '';
  const normalized = value.replaceAll('/', '\\').toLowerCase();
  return normalized.startsWith(`${root}\\`) ? normalized : `${root}\\${normalized}`;
}

const rgbAt = (data: DataView, offset: number): Rgb =>
  offset + 3 <= data.byteLength
    ? [
        data.getUint8(offset) / 255,
        data.getUint8(offset + 1) / 255,
        data.getUint8(offset + 2) / 255,
      ]
    : [0, 0, 0];

/** Cloud layer n's texture field: '0'+n then "0TX" (00TX, 10TX, … 90TX, :0TX, … L0TX). */
export const cloudTextureField = (layer: number): string =>
  `${String.fromCharCode(0x30 + layer)}0TX`;

/** Cloud speed byte: 0 → −0.1, 127 → 0, 254 → 0.1 (xEdit). */
const cloudSpeed = (value: number): number => (value - 127) / 1270;

/** Colours the engine uses when NAM0 is shorter than 17 entries (UESP). */
const COLOR_DEFAULTS: Partial<Record<number, Rgb>> = {
  [WeatherColor.fogFar]: [0, 0, 0],
  [WeatherColor.skyStatics]: [0, 0, 0],
  [WeatherColor.waterMultiplier]: [1, 1, 1],
  [WeatherColor.sunGlare]: [1, 1, 1],
  [WeatherColor.moonGlare]: [1, 1, 1],
};

export function parseWeather(record: WeatherSource): WeatherRecord {
  const { fields } = record;
  const bytes = (type: string): DataView | undefined => {
    const data = fields.first(type);
    return data ? view(data) : undefined;
  };
  const formIdOr = (data: Uint8Array | undefined, offset = 0): number | undefined => {
    if (!data || data.length < offset + 4) return undefined;
    const id = record.formIdAt(data, offset);
    return id === 0 || view(data).getUint32(offset, true) === 0 ? undefined : id;
  };

  const rnam = bytes('RNAM');
  const qnam = bytes('QNAM');
  const pnam = bytes('PNAM');
  const jnam = bytes('JNAM');
  const disabled = fields.u32('NAM1') ?? 0;
  const clouds = Array.from({ length: CLOUD_LAYERS }, (_, layer): CloudLayer => {
    const speed = (data: DataView | undefined): number =>
      data && layer < data.byteLength ? cloudSpeed(data.getUint8(layer)) : 0;
    return {
      texture: texturePath(fields.zstring(cloudTextureField(layer)) ?? ''),
      speed: [speed(qnam), speed(rnam)],
      colors: Array.from({ length: TIMES_OF_DAY }, (_, t) =>
        pnam ? rgbAt(pnam, layer * 16 + t * 4) : ([1, 1, 1] as Rgb),
      ),
      alphas: Array.from({ length: TIMES_OF_DAY }, (_, t) =>
        jnam && layer * 16 + t * 4 + 4 <= jnam.byteLength
          ? jnam.getFloat32(layer * 16 + t * 4, true)
          : 1,
      ),
      enabled: (disabled & (1 << layer)) === 0,
    };
  });

  const nam0 = bytes('NAM0');
  const colors = Array.from({ length: WEATHER_COLORS }, (_, color) =>
    Array.from({ length: TIMES_OF_DAY }, (_, t): Rgb => {
      const offset = color * 16 + t * 4;
      if (nam0 && offset + 4 <= nam0.byteLength) return rgbAt(nam0, offset);
      return COLOR_DEFAULTS[color] ?? [0, 0, 0];
    }),
  );

  const fnam = bytes('FNAM');
  const fogValue = (index: number, fallback: number): number =>
    fnam && index * 4 + 4 <= fnam.byteLength ? fnam.getFloat32(index * 4, true) : fallback;
  const fog: WeatherFog = {
    dayNear: fogValue(0, 0),
    dayFar: fogValue(1, 0),
    nightNear: fogValue(2, 0),
    nightFar: fogValue(3, 0),
    dayPower: fogValue(4, 1),
    nightPower: fogValue(5, 1),
    dayMax: fogValue(6, 1),
    nightMax: fogValue(7, 1),
  };

  const data = fields.first('DATA') ?? new Uint8Array(0);
  const u8 = (offset: number): number => data[offset] ?? 0;
  const unit = (offset: number): number => u8(offset) / 255;

  const imsp = fields.first('IMSP');
  const dalc = fields.all('DALC');
  const directionalAmbient =
    dalc.length >= TIMES_OF_DAY
      ? dalc.slice(0, TIMES_OF_DAY).map((entry): DirectionalAmbient => {
          const d = view(entry);
          return {
            colors: Array.from({ length: 6 }, (_, i) => rgbAt(d, i * 4)),
            specular: entry.length >= 28 ? rgbAt(d, 24) : [0, 0, 0],
            fresnelPower: entry.length >= 32 ? d.getFloat32(28, true) : 1,
          };
        })
      : undefined;

  const sounds: { sound: number; type: number }[] = [];
  for (const entry of fields.all('SNAM')) {
    const sound = formIdOr(entry);
    if (sound !== undefined && entry.length >= 8)
      sounds.push({ sound, type: view(entry).getUint32(4, true) });
  }
  const skyStatics: number[] = [];
  for (const entry of fields.all('TNAM')) {
    for (let offset = 0; offset + 4 <= entry.length; offset += 4) {
      const id = formIdOr(entry, offset);
      if (id !== undefined) skyStatics.push(id);
    }
  }

  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    clouds,
    colors,
    fog,
    windSpeed: unit(0),
    transDelta: u8(3) / 1020,
    sunGlare: unit(4),
    sunDamage: unit(5),
    precipitationFadeIn: unit(6),
    precipitationFadeOut: unit(7),
    thunderFadeIn: unit(8),
    thunderFadeOut: unit(9),
    thunderFrequency: u8(10),
    flags: u8(11),
    lightningColor: [u8(12) / 255, u8(13) / 255, u8(14) / 255],
    visualEffectBegin: unit(15),
    visualEffectEnd: unit(16),
    windDirection: (u8(17) / 255) * 360,
    windDirectionRange: (u8(18) / 255) * 180,
    imageSpaces: Array.from({ length: TIMES_OF_DAY }, (_, t) => formIdOr(imsp, t * 4)),
    directionalAmbient,
    precipitation: formIdOr(fields.first('MNAM')),
    visualEffect: formIdOr(fields.first('NNAM')),
    sounds,
    skyStatics,
    aurora: meshPath(fields.zstring('MODL') ?? ''),
  };
}

// --- Climate ------------------------------------------------------------------------------

export interface WeatherChance {
  readonly weather: number;
  /** Percent. */
  readonly chance: number;
  readonly global: number | undefined;
}

/** Hours (0..24) of the climate's sunrise and sunset. */
export interface SunTiming {
  readonly sunriseBegin: number;
  readonly sunriseEnd: number;
  readonly sunsetBegin: number;
  readonly sunsetEnd: number;
}

export interface ClimateRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly weathers: readonly WeatherChance[];
  /** textures\... ('' for none). */
  readonly sunTexture: string;
  readonly sunGlareTexture: string;
  /** Night sky model (meshes\sky\stars.nif). */
  readonly skyModel: string;
  readonly timing: SunTiming;
  readonly volatility: number;
  readonly masser: boolean;
  readonly secunda: boolean;
  /** Days per moon phase (8 phases per cycle). */
  readonly phaseLength: number;
}

/** The engine's timing without a climate (DefaultClimate's values). */
export const DEFAULT_TIMING: SunTiming = {
  sunriseBegin: 5.5,
  sunriseEnd: 10,
  sunsetBegin: 16,
  sunsetEnd: 20.5,
};

function weatherList(record: WeatherSource, data: Uint8Array | undefined): WeatherChance[] {
  const list: WeatherChance[] = [];
  if (!data) return list;
  const d = view(data);
  for (let offset = 0; offset + 12 <= data.length; offset += 12) {
    const weather = record.formIdAt(data, offset);
    if (d.getUint32(offset, true) === 0) continue;
    const global = d.getUint32(offset + 8, true);
    list.push({
      weather,
      chance: d.getUint32(offset + 4, true),
      global: global === 0 ? undefined : record.formIdAt(data, offset + 8),
    });
  }
  return list;
}

export function parseClimate(record: WeatherSource): ClimateRecord {
  const { fields } = record;
  const tnam = fields.first('TNAM');
  // Sunrise and sunset in 10-minute units.
  const hours = (index: number, fallback: number): number =>
    tnam && tnam.length > index ? (tnam[index] ?? 0) / 6 : fallback;
  const moons = tnam && tnam.length >= 6 ? (tnam[5] ?? 0) : 0xc3;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    weathers: weatherList(record, fields.first('WLST')),
    sunTexture: texturePath(fields.zstring('FNAM') ?? ''),
    sunGlareTexture: texturePath(fields.zstring('GNAM') ?? ''),
    skyModel: meshPath(fields.zstring('MODL') ?? ''),
    timing: {
      sunriseBegin: hours(0, DEFAULT_TIMING.sunriseBegin),
      sunriseEnd: hours(1, DEFAULT_TIMING.sunriseEnd),
      sunsetBegin: hours(2, DEFAULT_TIMING.sunsetBegin),
      sunsetEnd: hours(3, DEFAULT_TIMING.sunsetEnd),
    },
    volatility: tnam?.[4] ?? 0,
    masser: (moons & 0x40) !== 0,
    secunda: (moons & 0x80) !== 0,
    phaseLength: moons & 0x3f,
  };
}

// --- Regions ------------------------------------------------------------------------------

/** REGN RDAT types. */
export const RegionDataType = {
  objects: 2,
  weather: 3,
  map: 4,
  landscape: 5,
  grass: 6,
  sound: 7,
} as const;

export interface RegionWeather {
  readonly priority: number;
  readonly override: boolean;
  readonly weathers: readonly WeatherChance[];
}

/** The weather list of a region (RDAT type 3 + RDWT), if it has one. */
export function parseRegionWeather(record: WeatherSource): RegionWeather | undefined {
  let header: { type: number; flags: number; priority: number } | undefined;
  for (const field of record.fields.list) {
    if (field.type === 'RDAT' && field.data.length >= 6) {
      const d = view(field.data);
      header = {
        type: d.getUint32(0, true),
        flags: field.data[4] ?? 0,
        priority: field.data[5] ?? 0,
      };
    } else if (field.type === 'RDWT' && header?.type === RegionDataType.weather) {
      return {
        priority: header.priority,
        override: (header.flags & 1) !== 0,
        weathers: weatherList(record, field.data),
      };
    }
  }
  return undefined;
}

/**
 * The weather list that applies in a cell: the highest-priority weather region among the
 * cell's regions (XCLR), else the climate's list.
 */
export function cellWeathers(
  regions: readonly (RegionWeather | undefined)[],
  climate: ClimateRecord | undefined,
): readonly WeatherChance[] {
  let best: RegionWeather | undefined;
  for (const region of regions) {
    if (!region || region.weathers.length === 0) continue;
    if (!best || region.priority > best.priority) best = region;
  }
  return best?.weathers ?? climate?.weathers ?? [];
}

/** Picks a weather from a list by chance; `random` is in [0, 1). */
export function pickWeather(list: readonly WeatherChance[], random: number): number | undefined {
  const total = list.reduce((sum, entry) => sum + entry.chance, 0);
  if (total <= 0) return list[0]?.weather;
  let remaining = random * total;
  for (const entry of list) {
    remaining -= entry.chance;
    if (remaining < 0) return entry.weather;
  }
  return list[list.length - 1]?.weather;
}
