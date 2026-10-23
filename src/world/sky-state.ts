// The sky at a moment: time-of-day blending of a weather's colours, the sun's path, moon
// phases and the transition between two weathers. The sun's path follows how Community Shaders
// reproduces the vanilla sun (THIRD_PARTY_NOTICES.md). Platform-independent.
// Rules and sources: docs/formats/esm.md ("Climate and weather").

import {
  DEFAULT_TIMING,
  TIMES_OF_DAY,
  WeatherColor,
  type ClimateRecord,
  type CloudLayer,
  type DirectionalAmbient,
  type Rgb,
  type SunTiming,
  type WeatherRecord,
} from './weather.ts';

export type Vec3 = readonly [number, number, number];
/** Weights of sunrise, day, sunset and night (they add up to 1). */
export type TimeWeights = readonly [number, number, number, number];

/** Game settings (GMST) the sky uses, with their Skyrim.esm values. */
export interface SkySettings {
  readonly sunXExtreme: number;
  readonly masserSize: number;
  readonly secundaSize: number;
  readonly masserAngleFadeStart: number;
  readonly masserAngleFadeEnd: number;
  readonly secundaAngleFadeStart: number;
  readonly secundaAngleFadeEnd: number;
  readonly starsRotateDays: number;
  readonly starsRotateAxis: Vec3;
  readonly auroraFadeInStart: number;
  readonly auroraFadeIn: number;
  readonly auroraFadeOut: number;
  readonly weatherTransAccel: number;
  readonly sunMinimumGlareScale: number;
  /** INI [Weather] fSunBaseSize / fSunGlareSize. */
  readonly sunBaseSize: number;
  readonly sunGlareSize: number;
}

/**
 * Sky settings from the game settings (GMST) of the load order; INI values keep the
 * engine's defaults. `get` returns a GMST's number by editor id.
 */
export function skySettings(get: (editorId: string) => number | undefined): SkySettings {
  const d = DEFAULT_SKY_SETTINGS;
  const value = (id: string, fallback: number): number => get(id) ?? fallback;
  return {
    ...d,
    sunXExtreme: value('fSunXExtreme', d.sunXExtreme),
    masserSize: value('iMasserSize', d.masserSize),
    secundaSize: value('iSecundaSize', d.secundaSize),
    masserAngleFadeStart: value('fMasserAngleFadeStart', d.masserAngleFadeStart),
    masserAngleFadeEnd: value('fMasserAngleFadeEnd', d.masserAngleFadeEnd),
    secundaAngleFadeStart: value('fSecundaAngleFadeStart', d.secundaAngleFadeStart),
    secundaAngleFadeEnd: value('fSecundaAngleFadeEnd', d.secundaAngleFadeEnd),
    starsRotateDays: value('fStarsRotateDays', d.starsRotateDays),
    starsRotateAxis: [
      value('fStarsRotateXAxis', d.starsRotateAxis[0]),
      value('fStarsRotateYAxis', d.starsRotateAxis[1]),
      value('fStarsRotateZAxis', d.starsRotateAxis[2]),
    ],
    auroraFadeInStart: value('fAuroraFadeInStart', d.auroraFadeInStart),
    // Both spelled "Autora" in Skyrim.esm.
    auroraFadeIn: value('fAutoraFadeIn', d.auroraFadeIn),
    auroraFadeOut: value('fAutoraFadeOut', d.auroraFadeOut),
    weatherTransAccel: value('fWeatherTransAccel', d.weatherTransAccel),
    sunMinimumGlareScale: value('fSunMinimumGlareScale', d.sunMinimumGlareScale),
  };
}

export const DEFAULT_SKY_SETTINGS: SkySettings = {
  sunXExtreme: 400,
  masserSize: 90,
  secundaSize: 40,
  masserAngleFadeStart: 35,
  masserAngleFadeEnd: 20,
  secundaAngleFadeStart: 35,
  secundaAngleFadeEnd: 20,
  starsRotateDays: 1.0027,
  starsRotateAxis: [-0.09, 0.35, 1],
  auroraFadeInStart: 19,
  auroraFadeIn: 20,
  auroraFadeOut: 6,
  weatherTransAccel: 16,
  sunMinimumGlareScale: 0.25,
  sunBaseSize: 425,
  sunGlareSize: 600,
};

/**
 * Time-of-day weights. Sunrise colours peak halfway through the climate's sunrise (when the
 * sun reaches the horizon), sunset colours halfway through its sunset; night fades into
 * sunrise from sunrise begin, sunrise into day until sunrise end, and the same backwards in
 * the evening.
 */
export function timeOfDayWeights(hour: number, timing: SunTiming = DEFAULT_TIMING): TimeWeights {
  const h = ((hour % 24) + 24) % 24;
  const { sunriseBegin: r0, sunriseEnd: r1, sunsetBegin: s0, sunsetEnd: s1 } = timing;
  const rm = (r0 + r1) / 2;
  const sm = (s0 + s1) / 2;
  const ramp = (from: number, to: number): number => (to > from ? (h - from) / (to - from) : 1);
  if (h < r0 || h >= s1) return [0, 0, 0, 1];
  if (h < rm) {
    const t = ramp(r0, rm);
    return [t, 0, 0, 1 - t];
  }
  if (h < r1) {
    const t = ramp(rm, r1);
    return [1 - t, t, 0, 0];
  }
  if (h < s0) return [0, 1, 0, 0];
  if (h < sm) {
    const t = ramp(s0, sm);
    return [0, 1 - t, t, 0];
  }
  const t = ramp(sm, s1);
  return [0, 0, 1 - t, t];
}

/**
 * The sun's angle along its arc: 0 when it rises in the east, π when it sets in the west,
 * continuing below the horizon through the night. It is on the horizon a quarter of an hour
 * before the middle of the climate's sunrise and after the middle of its sunset.
 */
export function sunAngle(hour: number, timing: SunTiming = DEFAULT_TIMING): number {
  const h = ((hour % 24) + 24) % 24;
  const rise = (timing.sunriseBegin + timing.sunriseEnd) / 2 - 0.25;
  const set = (timing.sunsetBegin + timing.sunsetEnd) / 2 + 0.25;
  if (h >= rise && h <= set) return (Math.PI * (h - rise)) / Math.max(set - rise, 1e-3);
  const night = 24 - (set - rise);
  const sinceSet = h > set ? h - set : h + 24 - set;
  return Math.PI + (Math.PI * sinceSet) / Math.max(night, 1e-3);
}

/** Tilt of the sun's arc from the horizon: 95° (it passes just north of the zenith). */
const SUN_ARC_TILT = (95 * Math.PI) / 180;

/** Unit direction towards a body on a tilted east-west arc (+X east, +Y north, +Z up). */
export function arcDirection(angle: number, tilt = SUN_ARC_TILT): Vec3 {
  const x = Math.cos(angle);
  const y = -Math.sin(angle) * Math.cos(tilt);
  const z = Math.sin(angle) * Math.sin(tilt);
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** The eight moon phases, in order, as their texture name parts. */
export const MOON_PHASES = [
  'full',
  'three_wan',
  'half_wan',
  'one_wan',
  'new',
  'one_wax',
  'half_wax',
  'three_wax',
] as const;

export function moonPhase(daysPassed: number, phaseLength: number): number {
  if (phaseLength <= 0) return 0;
  return Math.floor(daysPassed / phaseLength) % MOON_PHASES.length;
}

export interface MoonState {
  readonly visible: boolean;
  readonly direction: Vec3;
  /** Texture (textures\sky\<moon>_<phase>.dds). */
  readonly texture: string;
  readonly size: number;
  /** 0..1, fades out near the horizon and in daylight. */
  readonly alpha: number;
}

export interface CloudState {
  readonly layer: number;
  readonly texture: string;
  /** Texture of the previous weather's layer during a transition ('' for none). */
  readonly previousTexture: string;
  /** Weight of `texture` over `previousTexture`. */
  readonly blend: number;
  readonly color: Rgb;
  readonly alpha: number;
  readonly offset: readonly [number, number];
}

export interface SkyState {
  readonly hour: number;
  readonly weights: TimeWeights;
  readonly skyUpper: Rgb;
  readonly skyLower: Rgb;
  readonly horizon: Rgb;
  readonly sunColor: Rgb;
  readonly sunGlareColor: Rgb;
  readonly sunGlare: number;
  readonly moonGlareColor: Rgb;
  /** Star tint (NAM0 Stars; most weathers keep it white all day). */
  readonly starsColor: Rgb;
  /** Star visibility 0..1: they come out as night falls. */
  readonly starsAlpha: number;
  readonly sunlight: Rgb;
  /** Where the sun is (may be below the horizon). */
  readonly sunDirection: Vec3;
  /** Towards the directional light: the sun, or the night light from above. */
  readonly lightDirection: Vec3;
  readonly ambient: DirectionalAmbient;
  readonly fogNear: Rgb;
  readonly fogFar: Rgb;
  readonly fogNearDistance: number;
  readonly fogFarDistance: number;
  readonly fogPower: number;
  readonly fogMax: number;
  readonly waterMultiplier: Rgb;
  /** The lightning flash this moment: its colour times its brightness (added to the sky). */
  readonly lightning: Rgb;
  /** Wind speed 0..1. */
  readonly windSpeed: number;
  /** Wind direction in degrees (WTHR; the current weather's during a transition). */
  readonly windDirection: number;
  readonly clouds: readonly CloudState[];
  readonly masser: MoonState;
  readonly secunda: MoonState;
  /** Rotation of the star sphere (radians about `starsAxis`). */
  readonly starsRotation: number;
  readonly starsAxis: Vec3;
  /** Sun disc and glare size in sky-mesh units. */
  readonly sunSize: number;
  readonly sunGlareSize: number;
  /** Aurora visibility 0..1 (weathers with an aurora model). */
  readonly aurora: number;
  /** Imagespaces of the time of day and their weights (both weathers during a change). */
  readonly imageSpaces: readonly { readonly formId: number; readonly weight: number }[];
}

export interface SkyInput {
  readonly weather: WeatherRecord;
  /** Weather being faded out, and how far the fade to `weather` is (0..1). */
  readonly previous?: WeatherRecord;
  readonly transition?: number;
  readonly climate: ClimateRecord | undefined;
  /** Game hour 0..24. */
  readonly hour: number;
  /** Days since the game started (moon phases, stars). */
  readonly daysPassed: number;
  /**
   * Game minutes the clouds have scrolled for: the layers' speeds read as texture widths per
   * game minute, so they follow the clock (at TimeScale 20, a third of a minute a real second;
   * faster as the clock is sped up). TODO(M13): UESP and the Creation Kit give no unit; real
   * seconds scrolled three times too fast and ignored the TimeScale, unlike the game's clouds
   * in timelapses at a raised timescale.
   */
  readonly cloudMinutes: number;
  readonly settings?: SkySettings;
  /** Lightning flash 0..1 this moment (see lightning.ts). */
  readonly lightning?: number;
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function blendTimes(values: readonly Rgb[], weights: TimeWeights): Rgb {
  const out: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < TIMES_OF_DAY; t++) {
    const value = values[t] ?? [0, 0, 0];
    const w = weights[t] ?? 0;
    out[0] += value[0] * w;
    out[1] += value[1] * w;
    out[2] += value[2] * w;
  }
  return out;
}

function blendScalar(values: readonly number[], weights: TimeWeights): number {
  let sum = 0;
  for (let t = 0; t < TIMES_OF_DAY; t++) sum += (values[t] ?? 0) * (weights[t] ?? 0);
  return sum;
}

const DEFAULT_AMBIENT: DirectionalAmbient = {
  colors: Array.from({ length: 6 }, (): Rgb => [0.3, 0.3, 0.3]),
  specular: [0, 0, 0],
  fresnelPower: 1,
};

function ambientOf(weather: WeatherRecord, weights: TimeWeights): DirectionalAmbient {
  const dalc = weather.directionalAmbient;
  if (!dalc) {
    // Without DALC the engine lights evenly with the NAM0 ambient colour.
    const ambient = blendTimes(weather.colors[WeatherColor.ambient] ?? [], weights);
    return { ...DEFAULT_AMBIENT, colors: Array.from({ length: 6 }, () => ambient) };
  }
  return {
    colors: Array.from({ length: 6 }, (_, i) =>
      blendTimes(
        dalc.map((entry) => entry.colors[i] ?? [0, 0, 0]),
        weights,
      ),
    ),
    specular: blendTimes(
      dalc.map((entry) => entry.specular),
      weights,
    ),
    fresnelPower: blendScalar(
      dalc.map((entry) => entry.fresnelPower),
      weights,
    ),
  };
}

interface WeatherLook {
  readonly color: (index: number) => Rgb;
  readonly ambient: DirectionalAmbient;
  readonly fogNearDistance: number;
  readonly fogFarDistance: number;
  readonly fogPower: number;
  readonly fogMax: number;
}

function lookOf(weather: WeatherRecord, weights: TimeWeights): WeatherLook {
  // Fog distances are given for day and night only; sunrise and sunset use the day values.
  const night = weights[3];
  const { fog } = weather;
  const mix = (day: number, nightValue: number): number => day + (nightValue - day) * night;
  return {
    color: (index) => blendTimes(weather.colors[index] ?? [], weights),
    ambient: ambientOf(weather, weights),
    fogNearDistance: mix(fog.dayNear, fog.nightNear),
    fogFarDistance: mix(fog.dayFar, fog.nightFar),
    fogPower: mix(fog.dayPower, fog.nightPower),
    fogMax: mix(fog.dayMax, fog.nightMax),
  };
}

function cloudStates(
  weather: WeatherRecord,
  previous: WeatherRecord | undefined,
  transition: number,
  weights: TimeWeights,
  minutes: number,
): CloudState[] {
  const states: CloudState[] = [];
  weather.clouds.forEach((layer, index) => {
    const old: CloudLayer | undefined = previous?.clouds[index];
    const newAlpha = layerAlpha(layer, weights);
    const oldAlpha = old ? layerAlpha(old, weights) : 0;
    const alpha = previous ? oldAlpha + (newAlpha - oldAlpha) * transition : newAlpha;
    if (alpha <= 0) return;
    const color =
      previous && old
        ? mixRgb(blendTimes(old.colors, weights), blendTimes(layer.colors, weights), transition)
        : blendTimes(layer.colors, weights);
    const texture = layer.enabled ? layer.texture : '';
    states.push({
      layer: index,
      texture,
      previousTexture: previous && old?.enabled ? old.texture : '',
      blend: previous ? transition : 1,
      color,
      alpha,
      offset: [wrap(layer.speed[0] * minutes), wrap(layer.speed[1] * minutes)],
    });
  });
  return states;
}

function layerAlpha(layer: CloudLayer, weights: TimeWeights): number {
  if (!layer.enabled || layer.texture === '') return 0;
  return blendScalar(layer.alphas, weights);
}

const wrap = (value: number): number => value - Math.floor(value);

function moon(
  name: 'masser' | 'secunda',
  present: boolean,
  angle: number,
  tilt: number,
  phase: number,
  size: number,
  fadeStart: number,
  fadeEnd: number,
  nightVisibility: number,
): MoonState {
  const direction = arcDirection(angle, tilt);
  const elevation = (Math.asin(Math.max(-1, Math.min(1, direction[2]))) * 180) / Math.PI;
  const horizonFade =
    fadeStart > fadeEnd
      ? Math.max(0, Math.min(1, (elevation - fadeEnd) / (fadeStart - fadeEnd)))
      : elevation > fadeEnd
        ? 1
        : 0;
  const alpha = present ? horizonFade * nightVisibility : 0;
  return {
    visible: alpha > 0,
    direction,
    texture: `textures\\sky\\${name}_${MOON_PHASES[phase] ?? 'full'}.dds`,
    size,
    alpha,
  };
}

export function skyState(input: SkyInput): SkyState {
  const settings = input.settings ?? DEFAULT_SKY_SETTINGS;
  const timing = input.climate?.timing ?? DEFAULT_TIMING;
  const weights = timeOfDayWeights(input.hour, timing);
  const transition = input.previous ? Math.max(0, Math.min(1, input.transition ?? 1)) : 1;
  const current = lookOf(input.weather, weights);
  const old = input.previous ? lookOf(input.previous, weights) : undefined;
  const color = (index: number): Rgb =>
    old ? mixRgb(old.color(index), current.color(index), transition) : current.color(index);
  const scalar = (pick: (look: WeatherLook) => number): number =>
    old ? pick(old) + (pick(current) - pick(old)) * transition : pick(current);
  const ambient: DirectionalAmbient = old
    ? {
        colors: current.ambient.colors.map((c, i) =>
          mixRgb(old.ambient.colors[i] ?? c, c, transition),
        ),
        specular: mixRgb(old.ambient.specular, current.ambient.specular, transition),
        fresnelPower:
          old.ambient.fresnelPower +
          (current.ambient.fresnelPower - old.ambient.fresnelPower) * transition,
      }
    : current.ambient;

  const angle = sunAngle(input.hour, timing);
  const sunDirection = arcDirection(angle);
  // Below the horizon the directional light comes from the opposite side, above it.
  const lightDirection: Vec3 =
    sunDirection[2] >= 0 ? sunDirection : [-sunDirection[0], -sunDirection[1], -sunDirection[2]];

  const starsColor = color(WeatherColor.stars);
  // Stars fade in with the night colours; the moons show from twilight on.
  const starsAlpha = weights[3];
  const nightVisibility = 1 - weights[1];
  const climate = input.climate;
  const phase = moonPhase(input.daysPassed, climate?.phaseLength ?? 3);
  // TODO(M13): the moons' exact orbits (Moon::speed/zOffset are not documented); they
  // follow the night side of the sun's arc, Masser trailing and Secunda leading.
  const masser = moon(
    'masser',
    climate?.masser ?? true,
    angle + Math.PI - 0.35,
    (110 * Math.PI) / 180,
    phase,
    settings.masserSize,
    settings.masserAngleFadeStart,
    settings.masserAngleFadeEnd,
    nightVisibility,
  );
  const secunda = moon(
    'secunda',
    climate?.secunda ?? true,
    angle + Math.PI + 0.3,
    (120 * Math.PI) / 180,
    phase,
    settings.secundaSize,
    settings.secundaAngleFadeStart,
    settings.secundaAngleFadeEnd,
    nightVisibility,
  );

  const days = input.daysPassed + input.hour / 24;
  const starsRotation = ((2 * Math.PI * days) / settings.starsRotateDays) % (2 * Math.PI);

  // Aurora: fades in from fAuroraFadeInStart to fAutoraFadeIn, out until fAutoraFadeOut.
  let aurora = 0;
  if (input.weather.aurora !== '') {
    const h = ((input.hour % 24) + 24) % 24;
    const { auroraFadeInStart: start, auroraFadeIn: full, auroraFadeOut: end } = settings;
    if (h >= start && h < full) aurora = (h - start) / Math.max(full - start, 1e-3);
    else if (h >= full || h < end) aurora = 1;
    aurora *= transition;
  }

  // Imagespaces of the time of day, the fading weather's included.
  const imageSpaces: { formId: number; weight: number }[] = [];
  const addImageSpaces = (weather: WeatherRecord, share: number): void => {
    weather.imageSpaces.forEach((formId, t) => {
      const weight = (weights[t] ?? 0) * share;
      if (formId !== undefined && weight > 0) imageSpaces.push({ formId, weight });
    });
  };
  addImageSpaces(input.weather, transition);
  if (input.previous) addImageSpaces(input.previous, 1 - transition);

  // A lightning flash lights the sky and, less, everything under it.
  const flash = Math.max(0, Math.min(1, input.lightning ?? 0));
  const flashColor =
    input.weather.thunderFrequency < 255 || !input.previous
      ? input.weather.lightningColor
      : input.previous.lightningColor;
  const lightning: Rgb = [flashColor[0] * flash, flashColor[1] * flash, flashColor[2] * flash];
  const lit = (c: Rgb, share: number): Rgb => [
    c[0] + lightning[0] * share,
    c[1] + lightning[1] * share,
    c[2] + lightning[2] * share,
  ];
  const litAmbient: DirectionalAmbient =
    flash > 0 ? { ...ambient, colors: ambient.colors.map((c) => lit(c, 0.5)) } : ambient;

  return {
    hour: input.hour,
    weights,
    skyUpper: lit(color(WeatherColor.skyUpper), 1),
    skyLower: lit(color(WeatherColor.skyLower), 1),
    horizon: lit(color(WeatherColor.horizon), 1),
    sunColor: color(WeatherColor.sun),
    sunGlareColor: color(WeatherColor.sunGlare),
    sunGlare: input.previous
      ? input.previous.sunGlare + (input.weather.sunGlare - input.previous.sunGlare) * transition
      : input.weather.sunGlare,
    moonGlareColor: color(WeatherColor.moonGlare),
    starsColor,
    starsAlpha,
    sunlight: color(WeatherColor.sunlight),
    sunDirection,
    lightDirection,
    ambient: litAmbient,
    fogNear: lit(color(WeatherColor.fogNear), 0.5),
    fogFar: lit(color(WeatherColor.fogFar), 0.5),
    fogNearDistance: scalar((l) => l.fogNearDistance),
    fogFarDistance: scalar((l) => l.fogFarDistance),
    fogPower: scalar((l) => l.fogPower),
    fogMax: scalar((l) => l.fogMax),
    waterMultiplier: color(WeatherColor.waterMultiplier),
    lightning,
    windSpeed: input.previous
      ? input.previous.windSpeed + (input.weather.windSpeed - input.previous.windSpeed) * transition
      : input.weather.windSpeed,
    windDirection: input.weather.windDirection,
    clouds: cloudStates(input.weather, input.previous, transition, weights, input.cloudMinutes),
    masser,
    secunda,
    starsRotation,
    starsAxis: settings.starsRotateAxis,
    sunSize: settings.sunBaseSize,
    sunGlareSize: settings.sunGlareSize,
    aurora,
    imageSpaces,
  };
}

/** The sun's distance in sky-mesh units (fSunXExtreme; the sky draws it there). */
const SUN_SKY_DISTANCE = 400;

/**
 * Whether a look along `direction` meets the sun as the sky draws it: the sun above the horizon
 * and the look within its disc (its size, fSunBaseSize, at its distance). The player's bow shot
 * tells it (TESPlayerBowShotEvent's sun gazing: Auriel's Bow). TODO(M13): the engine's own test
 * (its sun glare's visibility) is not read; the disc is inferred.
 */
export function sunInView(
  state: Pick<SkyState, 'sunDirection' | 'sunSize'>,
  direction: Vec3,
): boolean {
  const sun = state.sunDirection;
  if (sun[2] <= 0) return false;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length === 0) return false;
  const cos = (sun[0] * direction[0] + sun[1] * direction[1] + sun[2] * direction[2]) / length;
  return cos >= Math.cos(Math.atan(state.sunSize / 2 / SUN_SKY_DISTANCE));
}
