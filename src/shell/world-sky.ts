// Time of day and weather for an exterior worldspace: the clock advances at the timescale and
// the session's sky (src/world/sky-weather.ts, the engine's one weather state, which scripts
// and the console drive too) runs each frame; this shows its current weather and the change
// from the outgoing one in the sky, the directional light, ambient and fog. As the player
// enters a cell it tells the sky the weather region there and the worldspace's climate.

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
import { parseLensFlare, type LensFlare } from '../world/lens-flare.ts';
import {
  blendVolumetricLighting,
  godRays,
  parseVolumetricLighting,
  type VolumetricLighting,
} from '../world/volumetric-lighting.ts';
import type { SunEffectsFrame } from '../render/sun-effects.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { skySettings, skyState, type SkySettings, type SkyState } from '../world/sky-state.ts';
import { SkyMode, weatherRegionAt } from '../world/sky-weather.ts';
import {
  parseClimate,
  type ClimateRecord,
  type WeatherChance,
  type WeatherRecord,
} from '../world/weather.ts';
import { WorldFlag, type Worldspace } from '../world/worldspace.ts';
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
  /** Imagespaces by form id; undefined while loading or if missing. */
  readonly #imageSpaces = new Map<number, ImageSpace | undefined>();
  readonly #volumetric = new Map<number, VolumetricLighting | undefined>();
  readonly #lenses = new Map<
    number,
    { lens: LensFlare; textures: Map<string, GPUTexture> } | undefined
  >();
  #imageSpace: ImageSpace | undefined;
  readonly #detach: () => void;
  /** The sky's current and outgoing weather of the last frame, and the change between. */
  #weather: WeatherRecord | undefined;
  #previous: WeatherRecord | undefined;
  #transition = 1;
  /** The sky's count of new weathers last seen (a change is logged once). */
  #seenChanges = -1;
  /** The weather list the panel offers (the sky's region's, else the climate's). */
  #list: readonly WeatherChance[] = [];
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
    // A weather picked on the panel is the console's `fw <weather> 1`; "as the region picks"
    // its `rwo`.
    const onWeather = (): void => {
      const id = Number(ui.weather.value);
      if (!Number.isFinite(id) || id === 0) session.sky.releaseOverride();
      else session.sky.forceWeather(id, true);
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
    // The sky's climate is the worldspace's; the place is outside (the dome only under a
    // worldspace's own lighting template, nothing of it with No Sky as well).
    await session.weathers();
    if (climate) await session.weatherGlobals(climate.weathers);
    session.sky.setClimate(climate);
    session.sky.setPlace({
      interior: false,
      lightingTemplate: world.record.lightingTemplate !== undefined,
      noSky: (world.record.flags & WorldFlag.noSky) !== 0,
    });
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

  /** The weathers that can occur here (the sky's region's list, else the climate's). */
  get weatherList(): readonly WeatherChance[] {
    return this.#list;
  }

  /**
   * The player entered a cell (at x, y in the world): the sky learns the weather region there,
   * chosen among the cell's regions (XCLR) by where the player stands, as the engine does on
   * the player's change of cell.
   */
  async update(
    world: Worldspace,
    x: number,
    y: number,
    at: readonly [number, number],
  ): Promise<void> {
    const key = `${String(x)},${String(y)}`;
    if (key === this.#cell) return;
    this.#cell = key;
    const [ids, music] = await Promise.all([world.regions(x, y), world.cellMusic(x, y)]);
    if (key !== this.#cell) return;
    this.#regionIds = ids;
    this.#cellMusic = music;
    this.#located = true;
    const regions = await Promise.all(ids.map((id) => this.#session.weatherRegion(id)));
    if (key !== this.#cell) return;
    const region = weatherRegionAt(regions, world.record.formId, at[0], at[1]);
    this.#session.sky.enterExterior(
      region && { formId: region.formId, weathers: region.weather?.weathers ?? [] },
    );
    const list = this.#session.sky.region?.weathers ?? this.#climate?.weathers ?? [];
    const changed =
      list.length !== this.#list.length ||
      list.some((w, i) => w.weather !== this.#list[i]?.weather);
    this.#list = list;
    if (changed) this.#fillWeatherSelect();
  }

  /**
   * Advances the clock, runs the sky's weather and shows it, and places the sky objects around
   * the camera; call once per frame.
   */
  frame(now: number, camera: Vec3): SkyState | undefined {
    const delta =
      this.#lastFrame === undefined ? 0 : Math.min(0.25, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    this.#seconds += delta;
    // The session's clock runs at the TimeScale (times the panel's fast-forward), the clouds
    // with it; the sky follows it (the scripts, waiting and the slider set it too).
    // It stands still while the game is in a menu.
    const rate = this.#session.menuMode || this.#session.loading ? 0 : this.#session.clockRate;
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
    this.#showSky();
    const weather = this.#weather;
    if (!weather) return undefined;
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
    // The image-space modifiers on the screen change the weather's imagespace (also the
    // Sunlight Scale the directional light takes from it).
    this.#imageSpace = this.#session.imageSpaceModifiers.imageSpace(
      spaces.length > 0 ? blendImageSpaces(spaces) : undefined,
      now,
    );
    this.#falling = [];
    if (this.#session.sky.mode !== SkyMode.none) {
      for (const { formId, amount } of precipitationAmounts(
        weather,
        this.#previous,
        this.#transition,
      )) {
        const system = this.#loadPrecipitation(formId);
        if (system) this.#falling.push({ system, amount });
      }
    }
    this.#objects.update(weather, this.#previous, this.#transition, this.#state, camera);
    return this.#state;
  }

  /** The sky's turn this frame: its weathers move on; this shows its current and outgoing. */
  #showSky(): void {
    const sky = this.#session.sky;
    sky.frame();
    const current =
      sky.current === undefined ? undefined : this.#session.weatherRecord(sky.current);
    const outgoing =
      sky.outgoing === undefined ? undefined : this.#session.weatherRecord(sky.outgoing);
    this.#weather = current;
    this.#previous = current && outgoing;
    this.#transition = this.#previous ? sky.transition : 1;
    if (sky.changes !== this.#seenChanges) {
      this.#seenChanges = sky.changes;
      if (current) {
        this.#terminal.log(
          'sky',
          `weather ${current.editorId}${outgoing ? ` (changing from ${outgoing.editorId})` : ''}`,
        );
      }
      const shown = String(sky.override ?? 0);
      if (this.#ui.weather.value !== shown) this.#ui.weather.value = shown;
    }
  }

  /** The sky of the last frame (none while the console's ts has turned it off). */
  skyFrame(): SkyFrame | undefined {
    const state = this.#state;
    if (!state || this.#session.sky.mode === SkyMode.none) return undefined;
    return {
      sky: this.#gpu,
      state,
      ...sunTextures(this.#climate),
    };
  }

  /** The sky statics and aurora of the last frame. */
  skyScenes(): readonly GpuScene[] {
    return this.#session.sky.mode === SkyMode.none ? [] : this.#objects.scenes();
  }

  /** The rain and snow of the last frame. */
  precipitation(): readonly PrecipitationFrame[] {
    return this.#falling;
  }

  /** The weather's imagespace of the last frame (blended by time of day, with modifiers). */
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

  /**
   * The weather's god rays (its VOLI by time of day, scaled by [Display]
   * fVolumetricLightingIntensity) and its sun's lens flare (LENS, [ImageSpace]
   * fLensFlareGlobalIntensity) for the last frame; none while the sky is off.
   */
  sunEffects(): SunEffectsFrame | undefined {
    const state = this.#state;
    if (!state || this.#session.sky.mode === SkyMode.none) return undefined;
    const ini = this.#session.ini;
    const entries: { lighting: VolumetricLighting; weight: number }[] = [];
    for (const { formId, weight } of state.volumetricLightings ?? []) {
      const lighting = this.#loadVolumetric(formId);
      if (lighting) entries.push({ lighting, weight });
    }
    const lighting = blendVolumetricLighting(entries);
    const rays = godRays(
      lighting,
      {
        enabled: ini.bool('Display', 'bVolumetricLightingEnable'),
        intensity: ini.number('Display', 'fVolumetricLightingIntensity'),
      },
      state.sunlight,
      Math.abs(state.sunDirection[2]),
    );
    const lens = state.lensFlare === undefined ? undefined : this.#loadLens(state.lensFlare);
    return {
      lightDirection: state.lightDirection,
      ...(rays.strength > 0 && {
        rays: { ...rays, reach: Math.min(1, lighting.rangeFactor / 40) },
      }),
      ...(lens &&
        ini.bool('ImageSpace', 'bLensFlare') && {
          flare: {
            lens: lens.lens,
            textures: lens.textures,
            sunDirection: state.sunDirection,
            color: state.sunGlareColor,
            intensity: ini.number('ImageSpace', 'fLensFlareGlobalIntensity'),
          },
        }),
    };
  }

  #loadVolumetric(formId: number): VolumetricLighting | undefined {
    if (!this.#volumetric.has(formId)) {
      this.#volumetric.set(formId, undefined);
      void this.#db.get(formId).then((record) => {
        if (record?.type === 'VOLI') this.#volumetric.set(formId, parseVolumetricLighting(record));
      });
    }
    return this.#volumetric.get(formId);
  }

  /** A lens flare and its sprites' textures (each shown once it is loaded). */
  #loadLens(formId: number): { lens: LensFlare; textures: Map<string, GPUTexture> } | undefined {
    if (!this.#lenses.has(formId)) {
      this.#lenses.set(formId, undefined);
      void this.#db.get(formId).then((record) => {
        if (record?.type !== 'LENS') return;
        const entry = { lens: parseLensFlare(record), textures: new Map<string, GPUTexture>() };
        this.#lenses.set(formId, entry);
        for (const { texture } of entry.lens.sprites) {
          if (texture === '' || entry.textures.has(texture)) continue;
          void this.#session.textures.get(texture, true).then((gpu) => {
            if (gpu) entry.textures.set(texture, gpu);
          });
        }
      });
    }
    return this.#lenses.get(formId);
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

  /** The region's weathers with their chances, then every other weather (as the console's fw). */
  #fillWeatherSelect(): void {
    const select = this.#ui.weather;
    const total = this.#list.reduce((sum, entry) => sum + entry.chance, 0) || 1;
    void this.#session.weathers().then((all) => {
      const current = String(this.#session.sky.override ?? 0);
      const region = document.createElement('optgroup');
      region.label = 'this region';
      const listed = new Set<number>();
      for (const entry of this.#list) {
        const record = this.#session.weatherRecord(entry.weather);
        if (!record) continue;
        listed.add(record.formId);
        const percent = Math.round((entry.chance / total) * 100);
        region.append(
          new Option(`${record.editorId} · ${String(percent)}%`, String(record.formId)),
        );
      }
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
