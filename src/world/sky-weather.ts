// The sky's weather as the engine keeps it, one for the whole game: the weather now and the one
// it is leaving, how far the change between them is, the weather the regions chose (the
// default) and one a script or the console holds over them (the override), the region the
// player's weather comes from, and the sky's mode. Scripts (Weather.SetActive, ForceActive,
// ReleaseOverride, FindWeather, ...), the console (fw, sw, rwo, ts), the conditions (IsRaining,
// GetCurrentWeatherPercent, ...) and the viewers that draw the sky all read and drive this one
// state. Observed in the original; notes: docs/rendering.md ("Weather").
// Platform-independent.

import { insidePolygon, type BorderPoint } from './border.ts';
import { RegionDataType, type WeatherChance, type WeatherRecord } from './weather.ts';

/** The sky's modes (Weather.GetSkyMode). */
export const SkyMode = { none: 0, interior: 1, skyDomeOnly: 2, full: 3 } as const;
export type SkyMode = (typeof SkyMode)[keyof typeof SkyMode];

/** CELL DATA flags the sky reads. */
const CELL_SHOW_SKY = 0x80;
const CELL_USE_SKY_LIGHTING = 0x100;
/** REGN record flags. */
const RECORD_DELETED = 0x20;

/** The game settings of weather changes (GMST; the engine's defaults as the fallback). */
export interface WeatherSettings {
  /** fWeatherTransMin / Max: game hours a change of weather takes (Trans Delta 0 .. 1). */
  readonly transMin: number;
  readonly transMax: number;
  /** fWeatherTransAccel: how many times faster an accelerated change finishes (plus one). */
  readonly transAccel: number;
}

export const DEFAULT_WEATHER_SETTINGS: WeatherSettings = {
  transMin: 0.01,
  transMax: 0.25,
  transAccel: 4,
};

export function weatherSettings(get: (editorId: string) => number | undefined): WeatherSettings {
  const d = DEFAULT_WEATHER_SETTINGS;
  return {
    transMin: get('fWeatherTransMin') ?? d.transMin,
    transMax: get('fWeatherTransMax') ?? d.transMax,
    transAccel: get('fWeatherTransAccel') ?? d.transAccel,
  };
}

/** What the sky reads of a weather (WTHR DATA). */
export type WeatherTraits = Pick<
  WeatherRecord,
  'formId' | 'transDelta' | 'flags' | 'precipitationFadeIn' | 'precipitationFadeOut' | 'windSpeed'
>;

/** A climate as the sky reads it: its weather list and how often its weathers change. */
export interface SkyClimate {
  readonly formId: number;
  readonly weathers: readonly WeatherChance[];
  /** TNAM volatility (0..255): the higher, the shorter a weather lasts. */
  readonly volatility: number;
}

/** A weather region (a REGN with a weather tab): the list the sky picks from there. */
export interface SkyRegion {
  readonly formId: number;
  readonly weathers: readonly WeatherChance[];
}

/** What the sky asks of the game around it. */
export interface SkyWeatherHost {
  /** The time of day now (game hours, 0..24). */
  hour(): number;
  /** A weather's data (undefined while unknown). */
  weather(formId: number): WeatherTraits | undefined;
  /** A global's value: a weather's chance in a list can come from one. */
  global(formId: number): number | undefined;
  /** A random number in [0, 1). */
  random(): number;
}

/** Where the player is, as the sky's mode follows it. */
export type SkyPlace =
  | {
      readonly interior: true;
      /** CELL DATA flags (Show Sky 0x80, Use Sky Lighting 0x100). */
      readonly cellFlags: number;
    }
  | {
      readonly interior: false;
      /** The worldspace has a lighting template (WRLD LTMP). */
      readonly lightingTemplate: boolean;
      /** WRLD DATA No Sky (0x20). */
      readonly noSky: boolean;
    };

/**
 * The sky's mode in a place: the full sky outside; a worldspace with its own lighting template
 * shows only the dome (none of it with No Sky, as an interior); an interior shows the dome if
 * it has Show Sky, the full sky with Use Sky Lighting too, else none (its weather stands still).
 */
export function skyModeAt(place: SkyPlace): SkyMode {
  if (place.interior) {
    if ((place.cellFlags & CELL_SHOW_SKY) === 0) return SkyMode.interior;
    return (place.cellFlags & CELL_USE_SKY_LIGHTING) !== 0 ? SkyMode.full : SkyMode.skyDomeOnly;
  }
  if (!place.lightingTemplate) return SkyMode.full;
  return place.noSky ? SkyMode.interior : SkyMode.skyDomeOnly;
}

/** A weather list entry's chance: its global's value if it names one (whole numbers). */
function chanceOf(entry: WeatherChance, host: SkyWeatherHost): number {
  const value = entry.global === undefined ? entry.chance : (host.global(entry.global) ?? 0);
  return Math.max(0, Math.trunc(value));
}

/**
 * A weather from a list by chance: a random whole number below the sum of the chances falls
 * into one entry's share (entries of chance 0 never come).
 */
export function pickFromList(
  list: readonly WeatherChance[],
  host: SkyWeatherHost,
): number | undefined {
  const total = list.reduce((sum, entry) => sum + chanceOf(entry, host), 0);
  if (total === 0) return undefined;
  const roll = Math.floor(host.random() * 2 ** 32) % total;
  let below = 0;
  for (const entry of list) {
    const chance = chanceOf(entry, host);
    if (chance === 0) continue;
    if (roll < below + chance) return entry.weather;
    below += chance;
  }
  return list[list.length - 1]?.weather;
}

/** Whether a list can bring a weather (it is in it with a chance above 0). */
export function listHas(
  list: readonly WeatherChance[],
  weather: number | undefined,
  host: SkyWeatherHost,
): boolean {
  return (
    weather !== undefined &&
    list.some((entry) => entry.weather === weather && chanceOf(entry, host) !== 0)
  );
}

/**
 * Weather.FindWeather: of a list's weathers of a classification (0 pleasant, 1 cloudy, 2 rainy,
 * 3 snow), the one with the lowest chance (the first of equals); undefined if none has it.
 */
export function findInList(
  list: readonly WeatherChance[],
  classification: number,
  host: SkyWeatherHost,
): number | undefined {
  const bit = 1 << (classification & 0x1f);
  let found: number | undefined;
  let lowest = Infinity;
  for (const entry of list) {
    const flags = host.weather(entry.weather)?.flags ?? 0;
    const chance = chanceOf(entry, host);
    if ((flags & bit) !== 0 && chance < lowest) {
      found = entry.weather;
      lowest = chance;
    }
  }
  return found;
}

/** A region as the player's weather region is chosen from: its areas and its weather tab. */
export interface WeatherRegionArea {
  readonly formId: number;
  /** WNAM: the worldspace it lies in. */
  readonly world: number | undefined;
  readonly deleted: boolean;
  /** RPLD polygons (x, y). */
  readonly areas: readonly (readonly BorderPoint[])[];
  /** Its weather tab (RDAT type 3), if it has one. */
  readonly weather:
    | {
        readonly override: boolean;
        readonly priority: number;
        readonly weathers: readonly WeatherChance[];
      }
    | undefined;
}

/** A region record as weatherRegionAt reads it. */
export interface RegionSource {
  readonly formId: number;
  readonly flags: number;
  readonly fields: {
    readonly list: readonly { readonly type: string; readonly data: Uint8Array }[];
  };
  formIdField(type: string): number | undefined;
  formIdAt(data: Uint8Array, offset: number): number;
}

/** A REGN's areas and weather tab. */
export function parseWeatherRegionArea(record: RegionSource): WeatherRegionArea {
  const areas: BorderPoint[][] = [];
  let tab: { type: number; override: boolean; priority: number } | undefined;
  let weather: WeatherRegionArea['weather'];
  for (const field of record.fields.list) {
    const view = new DataView(field.data.buffer, field.data.byteOffset, field.data.byteLength);
    if (field.type === 'RPLD') {
      const points: BorderPoint[] = [];
      for (let offset = 0; offset + 8 <= field.data.byteLength; offset += 8)
        points.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true)]);
      areas.push(points);
    } else if (field.type === 'RDAT' && field.data.byteLength >= 6) {
      tab = {
        type: view.getUint32(0, true),
        override: ((field.data[4] ?? 0) & 1) !== 0,
        priority: field.data[5] ?? 0,
      };
      // A weather tab without a list still counts (its list is empty).
      if (tab.type === RegionDataType.weather)
        weather ??= { override: tab.override, priority: tab.priority, weathers: [] };
    } else if (field.type === 'RDWT' && tab?.type === RegionDataType.weather) {
      const weathers: WeatherChance[] = [];
      for (let offset = 0; offset + 12 <= field.data.byteLength; offset += 12) {
        if (view.getUint32(offset, true) === 0) continue;
        const global = view.getUint32(offset + 8, true);
        weathers.push({
          weather: record.formIdAt(field.data, offset),
          chance: view.getUint32(offset + 4, true),
          global: global === 0 ? undefined : record.formIdAt(field.data, offset + 8),
        });
      }
      weather = { override: tab.override, priority: tab.priority, weathers };
    }
  }
  const world = record.formIdField('WNAM');
  return {
    formId: record.formId,
    world: world === 0 ? undefined : world,
    deleted: (record.flags & RECORD_DELETED) !== 0,
    areas,
    weather,
  };
}

/**
 * The player's weather region in an exterior cell, chosen as the player enters the cell: of
 * the cell's regions (XCLR, in order) of this worldspace, those with an area around the
 * player; of their weather tabs one marked Override beats one that is not, else the higher
 * priority wins, else the first stays.
 */
export function weatherRegionAt(
  regions: readonly (WeatherRegionArea | undefined)[],
  world: number | undefined,
  x: number,
  y: number,
): WeatherRegionArea | undefined {
  let best: WeatherRegionArea | undefined;
  for (const region of regions) {
    if (!region || region.deleted) continue;
    if (region.world !== undefined && region.world !== world) continue;
    if (!region.areas.some((area) => area.length > 2 && insidePolygon(area, x, y))) continue;
    const tab = region.weather;
    if (!tab) continue;
    const held = best?.weather;
    if (
      !held ||
      (tab.override && !held.override) ||
      (tab.override === held.override && held.priority < tab.priority)
    )
      best = region;
  }
  return best;
}

/** IsRaining / IsSnowing: the precipitation of a class has begun or not yet ended. */
export function precipitating(
  current: WeatherTraits | undefined,
  outgoing: WeatherTraits | undefined,
  transition: number,
  classBit: number,
): boolean {
  // The current weather's rain has begun past its fade-in; the one leaving rains until its
  // fade-out (both a little short of the stored fraction, as the engine scales them).
  if (
    current &&
    (current.flags & classBit) !== 0 &&
    transition > current.precipitationFadeIn * 0.999
  )
    return true;
  return (
    outgoing !== undefined &&
    (outgoing.flags & classBit) !== 0 &&
    transition < outgoing.precipitationFadeOut * 0.999 + 0.001
  );
}

/** IsPleasant / IsCloudy: how much of the sky's weather is of a class (0..1). */
export function classShare(
  current: WeatherTraits | undefined,
  outgoing: WeatherTraits | undefined,
  transition: number,
  classBit: number,
): number {
  const now = current && (current.flags & classBit) !== 0 ? transition : 0;
  const before = outgoing && (outgoing.flags & classBit) !== 0 ? 1 - transition : 0;
  return now + before;
}

/** DefaultWeather (Skyrim.esm): the weather when no list gives one. */
export const DEFAULT_WEATHER = 0x15e;

export class SkyWeather {
  readonly #host: SkyWeatherHost;
  #settings: WeatherSettings;
  #climate: SkyClimate | undefined;
  #current: number | undefined;
  #outgoing: number | undefined;
  /** The weather the regions (or a script without override) chose. */
  #default: number | undefined;
  /** The weather a script or the console holds over the regions. */
  #override: number | undefined;
  /** The region the current choice was made in. */
  #region: SkyRegion | undefined;
  /** The player's weather region (chosen as the player enters an exterior cell). */
  #playerRegion: SkyRegion | undefined;
  /** In an interior: its sky region (XCCM) if it has one. */
  #interior: { readonly region: SkyRegion | undefined } | undefined;
  #mode: SkyMode = SkyMode.full;
  #place: SkyPlace = { interior: false, lightingTemplate: false, noSky: false };
  /** The time of day of the last update, and when the current weather came (game hours). */
  #hour: number;
  #since: number;
  #transition = 1;
  /** An accelerated change: from where it speeds up. */
  #accelerating = false;
  #acceleratedFrom = 0;
  /** The override was let go: the regions choose again at once. */
  #released = false;
  /** Fast travel: the next weather comes at once. */
  #fastTravel = false;
  #windSpeed = 0;
  /** ForceActive and the console's fw wait for the next frame, as the engine's task queue. */
  #forced: { readonly weather: number; readonly override: boolean }[] = [];
  /** Counts each new current weather (viewers notice a change by it). */
  #changes = 0;

  constructor(host: SkyWeatherHost, settings: WeatherSettings = DEFAULT_WEATHER_SETTINGS) {
    this.#host = host;
    this.#settings = settings;
    this.#hour = host.hour();
    this.#since = this.#hour;
  }

  set settings(settings: WeatherSettings) {
    this.#settings = settings;
  }

  /** Weather.GetCurrentWeather. */
  get current(): number | undefined {
    return this.#current;
  }

  /** Weather.GetOutgoingWeather: the weather being left (undefined once a change is done). */
  get outgoing(): number | undefined {
    return this.#outgoing;
  }

  /** Weather.GetCurrentWeatherTransition (GetCurrentWeatherPercent): 0..1. */
  get transition(): number {
    return this.#transition;
  }

  get override(): number | undefined {
    return this.#override;
  }

  get default(): number | undefined {
    return this.#default;
  }

  /** Weather.GetSkyMode. */
  get mode(): SkyMode {
    return this.#mode;
  }

  /** GetWindSpeed: the weathers' wind, blended through a change (updated under the full sky). */
  get windSpeed(): number {
    return this.#windSpeed;
  }

  get climate(): SkyClimate | undefined {
    return this.#climate;
  }

  /** The region the weather is chosen from now (FindWeather's). */
  get region(): SkyRegion | undefined {
    return this.#weatherRegion();
  }

  /** How many times a new weather has come. */
  get changes(): number {
    return this.#changes;
  }

  /** The worldspace's climate (Sky's current climate). */
  setClimate(climate: SkyClimate | undefined): void {
    this.#climate = climate;
  }

  /** The player is in another kind of place: the sky's mode follows (ts holds none). */
  setPlace(place: SkyPlace): void {
    this.#place = place;
    if (this.#mode === SkyMode.none) return;
    this.#mode = skyModeAt(place);
  }

  /** The console's ts (ToggleSky): no sky at all, or again the place's; whether it is on. */
  toggleSky(): boolean {
    this.#mode = this.#mode === SkyMode.none ? skyModeAt(this.#place) : SkyMode.none;
    return this.#mode !== SkyMode.none;
  }

  /** The player entered an exterior cell: the weather region chosen there (or none). */
  enterExterior(region: SkyRegion | undefined): void {
    this.#interior = undefined;
    this.#playerRegion = region;
  }

  /** The player entered an interior: the region of its sky (XCCM) if it has one. */
  enterInterior(skyRegion: SkyRegion | undefined): void {
    // Indoors the player's weather region stays the one outside.
    this.#interior = { region: skyRegion };
  }

  /** Fast travel: the next change of weather comes at once. */
  fastTravel(): void {
    this.#fastTravel = true;
  }

  /**
   * Weather.SetActive (and the console's sw): a weather the regions give way to (override) or
   * one that stands for the regions' choice until they choose again; it comes with a change at
   * the next update. Accelerate hurries a change under way, so the new weather comes sooner.
   */
  setWeather(weather: number, override: boolean, accelerate: boolean): void {
    if (this.#current === undefined) {
      this.#force(weather, override);
      return;
    }
    if (override) {
      this.#override = weather;
    } else {
      this.#default = weather;
      this.#playerRegion = undefined;
      this.#region = undefined;
    }
    if (!accelerate) return;
    if (this.#outgoing !== undefined) {
      if (!this.#accelerating) {
        this.#accelerating = true;
        this.#acceleratedFrom = this.#transition;
      }
      return;
    }
    this.#accelerating = false;
    this.#acceleratedFrom = 0;
  }

  /** Weather.ForceActive (and the console's fw): the weather at once, on the next frame. */
  forceWeather(weather: number, override: boolean): void {
    this.#forced.push({ weather, override });
  }

  /** Weather.ReleaseOverride (and the console's rwo): the regions choose again. */
  releaseOverride(): void {
    if (this.#override === undefined) return;
    this.#released = true;
    this.#override = undefined;
  }

  /** Weather.FindWeather: a weather of a classification from the region's list (else the climate's). */
  findWeather(classification: number): number | undefined {
    const region = this.#weatherRegion();
    if (region) return findInList(region.weathers, classification, this.#host);
    return this.#climate && findInList(this.#climate.weathers, classification, this.#host);
  }

  /** The sky's update, once a frame: a forced weather comes; outside interiors the weather moves on. */
  frame(): void {
    for (const { weather, override } of this.#forced.splice(0)) this.#force(weather, override);
    this.#hour = this.#host.hour();
    // An interior without a sky keeps the weather as it was.
    if (this.#mode === SkyMode.interior) return;
    this.#update();
    if (this.#mode === SkyMode.full) this.#windSpeed = this.#wind();
  }

  /** Game hours since the current weather came (the clock wraps at midnight). */
  #elapsed(): number {
    return (this.#hour < this.#since ? 24 : 0) + this.#hour - this.#since;
  }

  /** How long a weather lasts (game hours): 1 to 23 by the climate's volatility. */
  #lifetime(climate: SkyClimate): number {
    return Math.trunc((255 - climate.volatility) * 22) / 255 + 1;
  }

  /** In an interior with a sky region, that one; else the player's. */
  #weatherRegion(): SkyRegion | undefined {
    return this.#interior?.region ?? this.#playerRegion;
  }

  /** A weather from the climate's list as the default (DefaultWeather if it gives none). */
  #climateDefault(climate: SkyClimate): number {
    this.#default = pickFromList(climate.weathers, this.#host) ?? DEFAULT_WEATHER;
    return this.#default;
  }

  #update(): void {
    const climate = this.#climate;
    if (!climate) return;
    const lifetime = this.#lifetime(climate);
    const elapsed = this.#elapsed();
    // An override lasts as long as any weather would; then the regions choose again.
    if (this.#override !== undefined && elapsed > lifetime) this.releaseOverride();
    let next = this.#override;
    next ??= this.#regionChoice(climate, lifetime, elapsed);
    if (this.#current === undefined) next ??= this.#default ?? this.#climateDefault(climate);
    // A new weather waits for a change under way to finish (fast travel does not).
    if (
      next !== undefined &&
      next !== this.#current &&
      (this.#outgoing === undefined || this.#fastTravel)
    )
      this.#begin(next);
    this.#advance();
    this.#released = false;
    this.#fastTravel = false;
  }

  /** What the regions (or the climate) want now, if they want a change. */
  #regionChoice(climate: SkyClimate, lifetime: number, elapsed: number): number | undefined {
    const host = this.#host;
    const region = this.#weatherRegion();
    const old = this.#region;
    if (region === old && !this.#released) {
      if (elapsed <= lifetime) {
        // The weather still has time: only without a region does the default stand.
        if (old) return undefined;
        return this.#default ?? this.#climateDefault(climate);
      }
      // Its time is up: a new pick (each update until one differs from the current).
      if (old) return pickFromList(old.weathers, host);
      return this.#climateDefault(climate);
    }
    // Another region (or the override let go): it picks; a young weather it also has may stay.
    this.#region = region;
    const stays = (): boolean => elapsed / lifetime < host.random();
    if (!region) {
      if (
        this.#current !== this.#default &&
        listHas(climate.weathers, this.#current, host) &&
        stays()
      )
        this.#default = this.#current;
      return this.#default ?? this.#climateDefault(climate);
    }
    const pick = pickFromList(region.weathers, host);
    if (pick !== this.#current && listHas(region.weathers, this.#current, host) && stays())
      return this.#current;
    return pick;
  }

  /** The new weather comes: with a change from the current one, at once without a sky. */
  #begin(weather: number): void {
    this.#outgoing =
      !this.#fastTravel && this.#mode !== SkyMode.interior ? this.#current : undefined;
    this.#current = weather;
    this.#since = this.#hour;
    this.#changes++;
  }

  /** How far the change is: its game hours over the new weather's Trans Delta span. */
  #advance(): void {
    const elapsed = this.#elapsed();
    const current = this.#current === undefined ? undefined : this.#host.weather(this.#current);
    const { transMin, transMax, transAccel } = this.#settings;
    let transition: number;
    if (this.#current === undefined) transition = 0;
    else if (this.#outgoing === undefined) transition = 1;
    else transition = elapsed / ((current?.transDelta ?? 0) * (transMax - transMin) + transMin);
    if (this.#accelerating)
      transition = (transition - this.#acceleratedFrom) * (transAccel + 1) + this.#acceleratedFrom;
    if (transition > 1) {
      this.#outgoing = undefined;
      this.#accelerating = false;
      this.#acceleratedFrom = 0;
      transition = 1;
    }
    this.#transition = transition;
  }

  #force(weather: number, override: boolean): void {
    this.#accelerating = false;
    this.#acceleratedFrom = 0;
    this.#override = override ? weather : undefined;
    this.#default = override ? undefined : weather;
    this.#current = weather;
    this.#outgoing = undefined;
    this.#region = undefined;
    this.#playerRegion = undefined;
    this.#transition = 1;
    this.#hour = this.#host.hour();
    this.#since = this.#hour;
    this.#changes++;
  }

  #wind(): number {
    const current = this.#current === undefined ? undefined : this.#host.weather(this.#current);
    if (!current) return this.#windSpeed;
    const outgoing = this.#outgoing === undefined ? undefined : this.#host.weather(this.#outgoing);
    if (!outgoing) return current.windSpeed;
    return current.windSpeed * this.#transition + outgoing.windSpeed * (1 - this.#transition);
  }
}
