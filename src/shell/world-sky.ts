// Time of day and weather for an exterior worldspace, as the engine runs them: the clock
// advances at the timescale, the weather comes from the cell's weather region (else the
// climate) and changes with a transition when the camera enters a region whose list does
// not have the current weather. Drives the sky, the directional light, ambient and fog.

import type {
  GpuPrecipitation,
  PrecipitationFrame,
  PrecipitationRenderer,
} from '../render/precipitation.ts';
import type { Vec3 } from '../render/math.ts';
import type { GpuScene, SceneLighting, SceneRenderer } from '../render/scene-renderer.ts';
import type { TextureCache } from '../render/texture-cache.ts';
import {
  flashIntensity,
  FLASH_SECONDS,
  lightningInterval,
  thunderAmount,
} from '../world/lightning.ts';
import { parsePrecipitation, precipitationAmounts } from '../world/precipitation.ts';
import type { GpuSky, SkyFrame, SkyRenderer } from '../render/sky.ts';
import { skyShapes } from '../render/sky-data.ts';
import { blendImageSpaces, parseImageSpace, type ImageSpace } from '../world/image-space.ts';
import type { GameRecord, RecordDatabase } from '../world/record-db.ts';
import { skySettings, skyState, type SkySettings, type SkyState } from '../world/sky-state.ts';
import {
  cellWeathers,
  parseClimate,
  parseRegionWeather,
  parseWeather,
  pickWeather,
  type ClimateRecord,
  type RegionWeather,
  type WeatherChance,
  type WeatherRecord,
} from '../world/weather.ts';
import type { Worldspace } from '../world/worldspace.ts';
import type { GameSession } from './game-session.ts';
import { SkyObjects } from './sky-objects.ts';
import type { Terminal } from './terminal.ts';
import { clockPaceText } from '../world/game-time.ts';

const DEFAULT_SKY_MODEL = 'meshes\\sky\\stars.nif';
const DEFAULT_SUN = 'textures\\sky\\sun.dds';
const DEFAULT_SUN_GLARE = 'textures\\sky\\sunglare.dds';

export interface SkyElements {
  readonly sky: HTMLElement;
  readonly time: HTMLInputElement;
  readonly timeLabel: HTMLOutputElement;
  /** Speeds the game clock up in steps (CLOCK_SPEEDS). */
  readonly timeSpeed: HTMLButtonElement;
  /** How fast the clock runs (the TimeScale global, times the fast-forward). */
  readonly timeScale: HTMLElement;
  readonly weather: HTMLSelectElement;
}

/** Shows the clock's fast-forward step on its button and its pace beside it. */
export function showClockSpeed(ui: SkyElements, timeScale: number, speed: number): void {
  ui.timeSpeed.textContent = speed === 1 ? 'off' : `${String(speed)}×`;
  ui.timeSpeed.title =
    speed === 1 ? 'the game clock at its own pace: speed it up' : 'speed the game clock up more';
  ui.timeScale.textContent = clockPaceText(timeScale, speed);
}

/** A path, or the engine's default when it is empty or missing. */
const orDefault = (path: string | undefined, fallback: string): string =>
  path === undefined || path === '' ? fallback : path;

const formatHour = (hour: number): string => {
  const minutes = Math.floor((((hour % 24) + 24) % 24) * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

/** The climate's sun and its glare (else the engine's). */
export function sunTextures(climate: ClimateRecord | undefined): {
  sunTexture: string;
  sunGlareTexture: string;
} {
  return {
    sunTexture: orDefault(climate?.sunTexture, DEFAULT_SUN),
    sunGlareTexture: orDefault(climate?.sunGlareTexture, DEFAULT_SUN_GLARE),
  };
}

/** The sky's directional light (fading at the horizon), ambient and fog. */
export function skyLighting(
  state: SkyState,
  imageSpace: ImageSpace | undefined,
): Omit<SceneLighting, 'lights'> {
  // The light fades as the sun (or the night light) nears the horizon.
  const height = Math.abs(state.sunDirection[2]);
  // The imagespace's Sunlight Scale brightens the directional light (HDR).
  const fade = Math.min(1, height / 0.05) * (imageSpace?.hdr.sunlightScale ?? 1);
  const [ambientX, ambientNX, ambientY, ambientNY, ambientZ, ambientNZ] = state.ambient.colors;
  const dark = [0, 0, 0] as const;
  return {
    sunDirection: [...state.lightDirection],
    sunColor: [state.sunlight[0] * fade, state.sunlight[1] * fade, state.sunlight[2] * fade],
    ambient: [
      [...(ambientX ?? dark)],
      [...(ambientNX ?? dark)],
      [...(ambientY ?? dark)],
      [...(ambientNY ?? dark)],
      [...(ambientZ ?? dark)],
      [...(ambientNZ ?? dark)],
    ],
    wind: state.windSpeed,
    windDirection: (state.windDirection * Math.PI) / 180,
    fog: {
      nearColor: [...state.fogNear],
      farColor: [...state.fogFar],
      near: state.fogNearDistance,
      far: state.fogFarDistance,
      power: state.fogPower,
      max: state.fogMax,
    },
  };
}

/** The sky's dome, clouds and stars on the GPU (the climate's sky model, else the default). */
export async function createGpuSky(
  session: GameSession,
  sky: SkyRenderer,
  climate: ClimateRecord | undefined,
  terminal: Terminal,
): Promise<GpuSky> {
  const [atmosphere, clouds, stars] = await Promise.all(
    [
      'meshes\\sky\\atmosphere.nif',
      'meshes\\sky\\clouds.nif',
      orDefault(climate?.skyModel, DEFAULT_SKY_MODEL),
    ].map(async (path) => {
      try {
        return skyShapes(await session.nif(path));
      } catch (error) {
        terminal.log(
          'sky',
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
        return [];
      }
    }),
  );
  return sky.createSky(
    { atmosphere: atmosphere ?? [], clouds: clouds ?? [], stars: stars ?? [] },
    session.textures,
  );
}

export class WorldSky {
  readonly #db: RecordDatabase;
  readonly #ui: SkyElements;
  readonly #terminal: Terminal;
  readonly #settings: SkySettings;
  readonly #climate: ClimateRecord | undefined;
  readonly #gpu: GpuSky;
  readonly #weathers = new Map<number, Promise<WeatherRecord | undefined>>();
  readonly #regions = new Map<number, Promise<RegionWeather | undefined>>();
  /** Imagespaces by form id; undefined while loading or if missing. */
  readonly #imageSpaces = new Map<number, ImageSpace | undefined>();
  #imageSpace: ImageSpace | undefined;
  readonly #detach: () => void;
  #weather: WeatherRecord | undefined;
  #previous: WeatherRecord | undefined;
  #transition = 1;
  #list: readonly WeatherChance[] = [];
  /** Weather picked by hand (UI): kept while the camera moves. */
  #pinned = false;
  #hour = 10;
  readonly #session: GameSession;
  #seconds = 0;
  /** Game minutes the clouds have scrolled for (they follow the clock). */
  #cloudMinutes = 0;
  #lastFrame: number | undefined;
  #state: SkyState | undefined;
  #cell: string | undefined;
  /** The regions of the camera's cell (XCLR) and the music it names (XCMO). */
  #regionIds: readonly number[] = [];
  #cellMusic: number | undefined;
  #located = false;
  readonly #precipitationRenderer: PrecipitationRenderer;
  readonly #objects: SkyObjects;
  readonly #textures: TextureCache;
  /** Precipitation types on the GPU by SPGD form id (undefined while loading or if broken). */
  readonly #precipitation = new Map<number, GpuPrecipitation | undefined>();
  #falling: PrecipitationFrame[] = [];
  /** Lightning: when the next flash comes and when the last one began (seconds). */
  #nextFlash: number | undefined;
  /** The mean interval the next flash was drawn with. */
  #flashInterval: number | undefined;
  #flashStart = -Infinity;

  private constructor(
    session: GameSession,
    db: RecordDatabase,
    ui: SkyElements,
    terminal: Terminal,
    settings: SkySettings,
    climate: ClimateRecord | undefined,
    gpu: GpuSky,
    precipitation: PrecipitationRenderer,
    textures: TextureCache,
    objects: SkyObjects,
  ) {
    this.#session = session;
    this.#hour = session.gameHour;
    showClockSpeed(ui, session.timeScale, session.timeSpeed);
    this.#objects = objects;
    this.#precipitationRenderer = precipitation;
    this.#textures = textures;
    this.#db = db;
    this.#ui = ui;
    this.#terminal = terminal;
    this.#settings = settings;
    this.#climate = climate;
    this.#gpu = gpu;
    const onTime = (): void => {
      this.#hour = Number(ui.time.value);
      session.gameHour = this.#hour;
      ui.timeLabel.value = formatHour(this.#hour);
    };
    const onWeather = (): void => {
      const id = Number(ui.weather.value);
      if (!Number.isFinite(id) || id === 0) {
        this.#pinned = false;
        session.pinnedWeather = undefined;
        this.#cell = undefined; // re-pick from the region on the next update
        return;
      }
      this.#pinned = true;
      session.pinnedWeather = id;
      void this.#changeWeather(id, false);
    };
    ui.time.addEventListener('input', onTime);
    ui.weather.addEventListener('change', onWeather);
    this.#detach = () => {
      ui.time.removeEventListener('input', onTime);
      ui.weather.removeEventListener('change', onWeather);
    };
    ui.time.value = String(this.#hour);
    ui.timeLabel.value = formatHour(this.#hour);
    ui.sky.hidden = false;
    // A weather picked by hand (also indoors) stays.
    const pinned = session.pinnedWeather;
    if (pinned !== undefined) {
      this.#pinned = true;
      void this.#changeWeather(pinned, false);
    }
    this.#fillWeatherSelect();
  }

  static async create(
    session: GameSession,
    sky: SkyRenderer,
    precipitation: PrecipitationRenderer,
    scene: SceneRenderer,
    world: Worldspace,
    ui: SkyElements,
    terminal: Terminal,
  ): Promise<WorldSky> {
    const db = await session.db;
    const settings = skySettings(
      (
        (gmst) => (id: string) =>
          gmst.number(id)
      )(await session.settings()),
    );
    const climateId = world.climateWorld.climate;
    const climateRecord = climateId === undefined ? undefined : await db.get(climateId);
    const climate = climateRecord ? parseClimate(climateRecord) : undefined;
    const gpu = await createGpuSky(session, sky, climate, terminal);
    return new WorldSky(
      session,
      db,
      ui,
      terminal,
      settings,
      climate,
      gpu,
      precipitation,
      session.textures,
      new SkyObjects(session, db, scene),
    );
  }

  get hour(): number {
    return this.#hour;
  }

  set hour(hour: number) {
    this.#hour = ((hour % 24) + 24) % 24;
    this.#session.gameHour = this.#hour;
  }

  get weather(): WeatherRecord | undefined {
    return this.#weather;
  }

  /** The weather being left during a change of weather (undefined once it is done). */
  get previousWeather(): WeatherRecord | undefined {
    return this.#previous;
  }

  /** How far a change of weather is (0–1). */
  get transition(): number {
    return this.#transition;
  }

  /** When the last lightning flash began (sky seconds; -Infinity before the first). */
  get flashStart(): number {
    return this.#flashStart;
  }

  /** The regions of the camera's cell (their sounds play: src/audio/ambience.ts). */
  get regions(): readonly number[] {
    return this.#regionIds;
  }

  /** Whether the camera's cell has been looked up (its regions and music are known). */
  get located(): boolean {
    return this.#located;
  }

  /** The music type the camera's cell names (XCMO). */
  get cellMusic(): number | undefined {
    return this.#cellMusic;
  }

  /** The weathers that can occur in the current cell. */
  get weatherList(): readonly WeatherChance[] {
    return this.#list;
  }

  /** Sets a weather by form id at once (dev helper); `transition` fades to it instead. */
  async setWeather(formId: number, transition = false): Promise<void> {
    this.#pinned = true;
    this.#session.pinnedWeather = formId;
    await this.#changeWeather(formId, transition);
  }

  /** Looks up the weather list of the camera's cell; changes weather if it does not fit. */
  async update(world: Worldspace, x: number, y: number): Promise<void> {
    const key = `${String(x)},${String(y)}`;
    if (key === this.#cell) return;
    this.#cell = key;
    const [ids, music] = await Promise.all([world.regions(x, y), world.cellMusic(x, y)]);
    if (key !== this.#cell) return;
    this.#regionIds = ids;
    this.#cellMusic = music;
    this.#located = true;
    const regions = await Promise.all(ids.map((id) => this.#region(id)));
    const list = cellWeathers(regions, this.#climate);
    const changed =
      list.length !== this.#list.length ||
      list.some((w, i) => w.weather !== this.#list[i]?.weather);
    this.#list = list;
    if (changed) this.#fillWeatherSelect();
    if (this.#pinned) return;
    const current = this.#weather?.formId;
    if (current !== undefined && list.some((entry) => entry.weather === current)) return;
    const pick = pickWeather(list, Math.random());
    if (pick !== undefined) await this.#changeWeather(pick, current !== undefined);
  }

  /**
   * Advances the clock and the weather transition, and places the sky objects around the
   * camera; call once per frame.
   */
  frame(now: number, camera: Vec3): SkyState | undefined {
    const delta =
      this.#lastFrame === undefined ? 0 : Math.min(0.25, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    this.#seconds += delta;
    // The session's clock runs at the TimeScale (times the panel's fast-forward), the clouds
    // with it; the sky follows it (the scripts, waiting and the slider set it too).
    // It stands still while the game is in a menu.
    const rate = this.#session.menuMode ? 0 : this.#session.clockRate;
    this.#session.advanceClock((delta * rate) / 3600);
    this.#hour = this.#session.gameHour;
    this.#cloudMinutes += (delta * rate) / 60;
    if (Math.abs(Number(this.#ui.time.value) - this.#hour) > 0.04) {
      this.#ui.time.value = this.#hour.toFixed(2);
      this.#ui.timeLabel.value = formatHour(this.#hour);
    }
    // The colours of the references' emittance follow the clock (window glow by night,
    // sunbeams by day).
    this.#session.updateEmittance(this.#hour, this.#climate);
    const weather = this.#weather;
    if (!weather) return undefined;
    if (this.#previous) {
      // The new weather's Trans Delta: the share of the change done per real second.
      // TODO(M13): when the engine applies fWeatherTransAccel (forced weather changes).
      const speed = Math.max(weather.transDelta, 0.004);
      this.#transition = Math.min(1, this.#transition + delta * speed);
      if (this.#transition >= 1) this.#previous = undefined;
    }
    this.#state = skyState({
      lightning: this.#lightning(weather),
      weather,
      ...(this.#previous && { previous: this.#previous, transition: this.#transition }),
      climate: this.#climate,
      hour: this.#hour,
      daysPassed: this.#session.gameDaysPassed,
      cloudMinutes: this.#cloudMinutes,
      settings: this.#settings,
    });
    const spaces: { space: ImageSpace; weight: number }[] = [];
    for (const { formId, weight } of this.#state.imageSpaces) {
      const space = this.#loadImageSpace(formId);
      if (space) spaces.push({ space, weight });
    }
    this.#imageSpace = spaces.length > 0 ? blendImageSpaces(spaces) : undefined;
    this.#falling = [];
    for (const { formId, amount } of precipitationAmounts(
      weather,
      this.#previous,
      this.#transition,
    )) {
      const system = this.#loadPrecipitation(formId);
      if (system) this.#falling.push({ system, amount });
    }
    this.#objects.update(weather, this.#previous, this.#transition, this.#state, camera);
    return this.#state;
  }

  /** The sky of the last frame. */
  skyFrame(): SkyFrame | undefined {
    const state = this.#state;
    if (!state) return undefined;
    return {
      sky: this.#gpu,
      state,
      ...sunTextures(this.#climate),
    };
  }

  /** The sky statics and aurora of the last frame. */
  skyScenes(): readonly GpuScene[] {
    return this.#objects.scenes();
  }

  /** The rain and snow of the last frame. */
  precipitation(): readonly PrecipitationFrame[] {
    return this.#falling;
  }

  /** The weather's imagespace of the last frame (blended by time of day). */
  imageSpace(): ImageSpace | undefined {
    return this.#imageSpace;
  }

  /** Directional light, ambient and fog of the last frame. */
  lighting(): Omit<SceneLighting, 'lights'> | undefined {
    return this.#state && skyLighting(this.#state, this.#imageSpace);
  }

  dispose(): void {
    this.#detach();
    this.#ui.sky.hidden = true;
    this.#gpu.destroy();
    for (const system of this.#precipitation.values()) system?.destroy();
    this.#objects.dispose();
    this.#precipitation.clear();
  }

  async #changeWeather(formId: number, transition: boolean): Promise<void> {
    const weather = await this.#weatherRecord(formId);
    if (!weather) {
      this.#terminal.log('sky', `weather ${formId.toString(16)} does not exist`, 'warn');
      return;
    }
    if (weather.formId === this.#weather?.formId) return;
    if (transition && this.#weather) {
      this.#previous = this.#weather;
      this.#transition = 0;
    } else {
      this.#previous = undefined;
      this.#transition = 1;
    }
    this.#weather = weather;
    if (this.#ui.weather.value !== String(formId) && this.#pinned)
      this.#ui.weather.value = String(formId);
    this.#terminal.log('sky', `weather ${weather.editorId}${transition ? ' (changing)' : ''}`);
  }

  /** The lightning flash this frame: storms flash at random, about their weather's interval. */
  #lightning(weather: WeatherRecord): number {
    const amount = thunderAmount(weather, this.#previous, this.#transition);
    const stormy =
      amount > 0
        ? this.#previous && weather.thunderFrequency >= 255
          ? this.#previous
          : weather
        : undefined;
    const interval = stormy && lightningInterval(stormy.thunderFrequency);
    if (interval === undefined) {
      this.#nextFlash = undefined;
      return 0;
    }
    // Exponentially distributed waits: flashes come at random, `interval` apart on average.
    // They have no memory, so a storm of another frequency simply draws its next flash anew.
    const wait = (): number => -Math.log(1 - Math.random()) * interval;
    if (interval !== this.#flashInterval) {
      this.#flashInterval = interval;
      this.#nextFlash = undefined;
    }
    this.#nextFlash ??= this.#seconds + wait();
    if (this.#seconds >= this.#nextFlash) {
      this.#flashStart = this.#seconds;
      this.#nextFlash = this.#seconds + FLASH_SECONDS + wait();
    }
    return flashIntensity(this.#seconds - this.#flashStart) * amount;
  }

  #loadPrecipitation(formId: number): GpuPrecipitation | undefined {
    if (!this.#precipitation.has(formId)) {
      this.#precipitation.set(formId, undefined);
      void this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'SPGD'
            ? this.#precipitationRenderer.create(parsePrecipitation(record), this.#textures)
            : undefined,
        )
        .then((system) => {
          this.#precipitation.set(formId, system);
        });
    }
    return this.#precipitation.get(formId);
  }

  #loadImageSpace(formId: number): ImageSpace | undefined {
    if (!this.#imageSpaces.has(formId)) {
      this.#imageSpaces.set(formId, undefined);
      void this.#db.get(formId).then((record) => {
        if (record?.type === 'IMGS') this.#imageSpaces.set(formId, parseImageSpace(record));
      });
    }
    return this.#imageSpaces.get(formId);
  }

  #weatherRecord(formId: number): Promise<WeatherRecord | undefined> {
    let pending = this.#weathers.get(formId);
    if (!pending) {
      pending = this.#db
        .get(formId)
        .then((record) => (record?.type === 'WTHR' ? parseWeather(record) : undefined));
      this.#weathers.set(formId, pending);
    }
    return pending;
  }

  #region(formId: number): Promise<RegionWeather | undefined> {
    let pending = this.#regions.get(formId);
    if (!pending) {
      pending = this.#db
        .get(formId)
        .then((record: GameRecord | undefined) =>
          record?.type === 'REGN' ? parseRegionWeather(record) : undefined,
        );
      this.#regions.set(formId, pending);
    }
    return pending;
  }

  /** The region's weathers with their chances, then every other weather (as the console's fw). */
  #fillWeatherSelect(): void {
    const select = this.#ui.weather;
    const total = this.#list.reduce((sum, entry) => sum + entry.chance, 0) || 1;
    void Promise.all([
      Promise.all(this.#list.map((entry) => this.#weatherRecord(entry.weather))),
      this.#session.weathers(),
    ]).then(([records, all]) => {
      const current = this.#pinned ? String(this.#session.pinnedWeather ?? 0) : '0';
      const region = document.createElement('optgroup');
      region.label = 'this region';
      const listed = new Set<number>();
      records.forEach((record, i) => {
        const entry = this.#list[i];
        if (!record || !entry) return;
        listed.add(record.formId);
        const percent = Math.round((entry.chance / total) * 100);
        region.append(
          new Option(`${record.editorId} · ${String(percent)}%`, String(record.formId)),
        );
      });
      const others = document.createElement('optgroup');
      others.label = 'all weathers';
      for (const weather of all) {
        if (!listed.has(weather.formId)) {
          others.append(new Option(weather.editorId, String(weather.formId)));
        }
      }
      select.replaceChildren(new Option('as the region picks', '0'), region, others);
      select.value = current;
      if (select.value !== current) select.value = '0';
    });
  }
}
