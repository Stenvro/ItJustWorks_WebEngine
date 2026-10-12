// Time of day and weather for an exterior worldspace, as the engine runs them: the clock
// advances at the timescale, the weather comes from the cell's weather region (else the
// climate) and changes with a transition when the camera enters a region whose list does
// not have the current weather. Drives the sky, the directional light, ambient and fog.

import type { SceneLighting } from '../render/scene-renderer.ts';
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
import type { Terminal } from './terminal.ts';

/** Game seconds per real second (GLOB TimeScale default). */
const TIMESCALE = 20;
const DEFAULT_SKY_MODEL = 'meshes\\sky\\stars.nif';
const DEFAULT_SUN = 'textures\\sky\\sun.dds';
const DEFAULT_SUN_GLARE = 'textures\\sky\\sunglare.dds';

export interface SkyElements {
  readonly sky: HTMLElement;
  readonly time: HTMLInputElement;
  readonly timeLabel: HTMLOutputElement;
  readonly timeFlows: HTMLInputElement;
  readonly weather: HTMLSelectElement;
}

/** A path, or the engine's default when it is empty or missing. */
const orDefault = (path: string | undefined, fallback: string): string =>
  path === undefined || path === '' ? fallback : path;

const formatHour = (hour: number): string => {
  const minutes = Math.floor((((hour % 24) + 24) % 24) * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

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
  #days = 0;
  #seconds = 0;
  #lastFrame: number | undefined;
  #state: SkyState | undefined;
  #cell: string | undefined;

  private constructor(
    db: RecordDatabase,
    ui: SkyElements,
    terminal: Terminal,
    settings: SkySettings,
    climate: ClimateRecord | undefined,
    gpu: GpuSky,
  ) {
    this.#db = db;
    this.#ui = ui;
    this.#terminal = terminal;
    this.#settings = settings;
    this.#climate = climate;
    this.#gpu = gpu;
    const onTime = (): void => {
      this.#hour = Number(ui.time.value);
      ui.timeLabel.value = formatHour(this.#hour);
    };
    const onWeather = (): void => {
      const id = Number(ui.weather.value);
      if (!Number.isFinite(id) || id === 0) {
        this.#pinned = false;
        this.#cell = undefined; // re-pick from the region on the next update
        return;
      }
      this.#pinned = true;
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
  }

  static async create(
    session: GameSession,
    sky: SkyRenderer,
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
    const gpu = sky.createSky(
      { atmosphere: atmosphere ?? [], clouds: clouds ?? [], stars: stars ?? [] },
      session.textures,
    );
    return new WorldSky(db, ui, terminal, settings, climate, gpu);
  }

  get hour(): number {
    return this.#hour;
  }

  set hour(hour: number) {
    this.#hour = ((hour % 24) + 24) % 24;
  }

  get weather(): WeatherRecord | undefined {
    return this.#weather;
  }

  /** The weathers that can occur in the current cell. */
  get weatherList(): readonly WeatherChance[] {
    return this.#list;
  }

  /** Sets a weather by form id at once (dev helper); `transition` fades to it instead. */
  async setWeather(formId: number, transition = false): Promise<void> {
    this.#pinned = true;
    await this.#changeWeather(formId, transition);
  }

  /** Looks up the weather list of the camera's cell; changes weather if it does not fit. */
  async update(world: Worldspace, x: number, y: number): Promise<void> {
    const key = `${String(x)},${String(y)}`;
    if (key === this.#cell) return;
    this.#cell = key;
    const regions = await Promise.all((await world.regions(x, y)).map((id) => this.#region(id)));
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

  /** Advances the clock and the weather transition; call once per frame. */
  frame(now: number): SkyState | undefined {
    const delta =
      this.#lastFrame === undefined ? 0 : Math.min(0.25, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    this.#seconds += delta;
    if (this.#ui.timeFlows.checked) {
      this.#hour += (delta * TIMESCALE) / 3600;
      if (this.#hour >= 24) {
        this.#hour -= 24;
        this.#days++;
      }
      if (Math.abs(Number(this.#ui.time.value) - this.#hour) > 0.04) {
        this.#ui.time.value = this.#hour.toFixed(2);
        this.#ui.timeLabel.value = formatHour(this.#hour);
      }
    }
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
      weather,
      ...(this.#previous && { previous: this.#previous, transition: this.#transition }),
      climate: this.#climate,
      hour: this.#hour,
      daysPassed: this.#days,
      seconds: this.#seconds,
      settings: this.#settings,
    });
    const spaces: { space: ImageSpace; weight: number }[] = [];
    for (const { formId, weight } of this.#state.imageSpaces) {
      const space = this.#loadImageSpace(formId);
      if (space) spaces.push({ space, weight });
    }
    this.#imageSpace = spaces.length > 0 ? blendImageSpaces(spaces) : undefined;
    return this.#state;
  }

  /** The sky of the last frame. */
  skyFrame(): SkyFrame | undefined {
    const state = this.#state;
    if (!state) return undefined;
    return {
      sky: this.#gpu,
      state,
      sunTexture: orDefault(this.#climate?.sunTexture, DEFAULT_SUN),
      sunGlareTexture: orDefault(this.#climate?.sunGlareTexture, DEFAULT_SUN_GLARE),
    };
  }

  /** The weather's imagespace of the last frame (blended by time of day). */
  imageSpace(): ImageSpace | undefined {
    return this.#imageSpace;
  }

  /** Directional light, ambient and fog of the last frame. */
  lighting(): Omit<SceneLighting, 'lights'> | undefined {
    const state = this.#state;
    if (!state) return undefined;
    // The light fades as the sun (or the night light) nears the horizon.
    const height = Math.abs(state.sunDirection[2]);
    // The imagespace's Sunlight Scale brightens the directional light (HDR).
    const fade = Math.min(1, height / 0.05) * (this.#imageSpace?.hdr.sunlightScale ?? 1);
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

  dispose(): void {
    this.#detach();
    this.#ui.sky.hidden = true;
    this.#gpu.destroy();
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

  #fillWeatherSelect(): void {
    const select = this.#ui.weather;
    const current = this.#pinned ? select.value : '0';
    const options = [new Option('as the region picks', '0')];
    const total = this.#list.reduce((sum, entry) => sum + entry.chance, 0) || 1;
    void Promise.all(this.#list.map((entry) => this.#weatherRecord(entry.weather))).then(
      (records) => {
        records.forEach((record, i) => {
          const entry = this.#list[i];
          if (!record || !entry) return;
          const percent = Math.round((entry.chance / total) * 100);
          options.push(
            new Option(`${record.editorId} · ${String(percent)}%`, String(record.formId)),
          );
        });
        select.replaceChildren(...options);
        select.value = current;
        if (select.value !== current) select.value = '0';
      },
    );
  }
}
