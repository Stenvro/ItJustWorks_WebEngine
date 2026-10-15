// The world map's 3D: what the map menu shows behind its movie. The world as its distant LOD
// draws it, locked to one size of blocks over the whole world ([MapMenu] uLockedTerrainLOD 32,
// uLockedObjectMapLOD 16; no tree billboards), under the world map's own weather
// (WorldMapWeather, Skyrim.esm 000A6858: its sky, light and imagespaces at the time of day)
// and its cloud bank (the map world's WRLD MODL; Tamriel has none and gets the engine's
// meshes\sky\skyrimworldmapcloudbank.nif). The map's imagespace is the weather's with the
// [Display] fGlobalMap* boosts (bloom threshold, brightness, contrast) and the map's blur
// (ISWorldMap, src/render/shaders/dof.wgsl): a 7×7 box whose step is the distance from
// fWorldMapFocalDepth times fWorldMapDepthBlurScale, up to fWorldMapMaximumDepthBlur pixels,
// times fWorldMapNearDepthBlurScale nearer than the focus (the clouds), the sky too unless
// bWorldMapNoSkyDepthBlur. Notes: docs/ui.md ("The map").

import { identity } from '../render/math.ts';
import type { SceneView } from '../render/renderer.ts';
import type { GpuSky } from '../render/sky.ts';
import type { GpuModel, GpuScene, WaterFrame } from '../render/scene-renderer.ts';
import { blendImageSpaces, parseImageSpace, type ImageSpace } from '../world/image-space.ts';
import { MAP_CAMERA_DEFAULTS, MapCamera, type MapCameraSettings } from '../world/map-camera.ts';
import { skySettings, skyState, type SkySettings, type SkyState } from '../world/sky-state.ts';
import {
  parseClimate,
  parseWeather,
  type ClimateRecord,
  type WeatherRecord,
} from '../world/weather.ts';
import { WorldFlag, Worldspace, type WorldMapData } from '../world/worldspace.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';
import { WorldLod } from './world-lod.ts';
import { createGpuSky, skyLighting, sunTextures } from './world-sky.ts';
import type { Vec3 } from '../render/math.ts';

/** WorldMapWeather (Skyrim.esm): the weather the engine shows the world map under. */
export const WORLD_MAP_WEATHER = 0xa6858;
/** The world map's clouds where the map world has no cloud model (WRLD MODL). */
const DEFAULT_CLOUD_MODEL = 'meshes\\sky\\skyrimworldmapcloudbank.nif';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The camera settings from [MapMenu] (and [Main], [Display]). */
export function mapCameraSettings(session: GameSession): MapCameraSettings {
  const ini = session.ini;
  const map = (key: Parameters<typeof ini.number<'MapMenu'>>[1]): number =>
    ini.number('MapMenu', key);
  return {
    ...MAP_CAMERA_DEFAULTS,
    minPitch: map('fMapWorldMinPitch'),
    maxPitch: map('fMapWorldMaxPitch'),
    yawRange: map('fMapWorldYawRange'),
    zoomMouseSpeed: map('fMapZoomMouseSpeed'),
    heightAdjustmentForce: map('fMapWorldHeightAdjustmentForce'),
    minPanSpeed: map('fMapWorldMinPanSpeed'),
    maxPanSpeed: map('fMapWorldMaxPanSpeed'),
    cursorMoveArea: map('fMapWorldCursorMoveArea'),
    lookMouseSpeed: map('fMapLookMouseSpeed'),
    transitionHeight: map('fMapWorldTransitionHeight'),
    transitionSpeed: map('fMapTransitionSpeed'),
    targetTransitionTime: ini.number('Main', 'fMapWorldTargetTransitionTime'),
    nearClip: map('fMapMenuNearClipPlane'),
    worldFov: ini.number('Display', 'fDefaultWorldFOV'),
  };
}

export class WorldMapView {
  readonly camera: MapCamera;
  /** The world whose map this is (the shown world, or its parent's map). */
  readonly world: Worldspace;
  readonly map: WorldMapData;
  readonly #session: GameSession;
  readonly #lod: WorldLod | undefined;
  readonly #sky: GpuSky;
  readonly #weather: WeatherRecord;
  readonly #climate: ClimateRecord | undefined;
  readonly #skySettings: SkySettings;
  readonly #clouds: GpuScene | undefined;
  readonly #noSky: boolean;
  readonly #imageSpaces = new Map<number, ImageSpace | undefined>();
  #state: SkyState | undefined;
  #imageSpace: ImageSpace | undefined;
  #disposed = false;

  private constructor(
    session: GameSession,
    world: Worldspace,
    map: WorldMapData,
    camera: MapCamera,
    parts: {
      readonly lod: WorldLod | undefined;
      readonly sky: GpuSky;
      readonly weather: WeatherRecord;
      readonly climate: ClimateRecord | undefined;
      readonly skySettings: SkySettings;
      readonly cloudModel: GpuModel | undefined;
    },
  ) {
    this.#session = session;
    this.world = world;
    this.map = map;
    this.camera = camera;
    this.#lod = parts.lod;
    this.#sky = parts.sky;
    this.#weather = parts.weather;
    this.#climate = parts.climate;
    this.#skySettings = parts.skySettings;
    this.#noSky = (world.record.flags & WorldFlag.noSky) !== 0;
    this.#clouds = parts.cloudModel
      ? session.renderer.scene.createScene([{ model: parts.cloudModel, world: identity() }])
      : undefined;
  }

  /**
   * The map of a world (its own, or its parent's when it uses the parent's map data), the
   * camera over `at`; undefined if the world has no map or the map weather is missing.
   */
  static async create(
    session: GameSession,
    terminal: Terminal,
    shown: Worldspace,
    at: Vec3,
  ): Promise<WorldMapView | undefined> {
    const db = await session.db;
    const world =
      shown.mapWorld.formId === shown.record.formId
        ? shown
        : await session.worldspace(shown.mapWorld.formId);
    const map = world.record.map;
    if (!map) return undefined;
    const weatherRecord = await db.get(WORLD_MAP_WEATHER);
    if (weatherRecord?.type !== 'WTHR') {
      terminal.log('map', 'the world map weather (000A6858) is missing', 'warn');
      return undefined;
    }
    const weather = parseWeather(weatherRecord);
    const climateId = world.climateWorld.climate;
    const climateRecord = climateId === undefined ? undefined : await db.get(climateId);
    const climate = climateRecord ? parseClimate(climateRecord) : undefined;
    const renderer = session.renderer;
    const ini = session.ini;
    const [lod, sky, cloudModel] = await Promise.all([
      WorldLod.create(session, renderer, world, terminal).catch((error: unknown) => {
        terminal.log('map', `the map's LOD: ${describe(error)}`, 'warn');
        return undefined;
      }),
      createGpuSky(session, renderer.sky, climate, terminal),
      (async () => {
        const model = world.record.cloudModel;
        const path = model ? `meshes\\${model.replace(/^meshes[\\/]/i, '')}` : DEFAULT_CLOUD_MODEL;
        try {
          return await session.model(path.toLowerCase());
        } catch (error) {
          terminal.log('map', `${path}: ${describe(error)}`, 'warn');
          return undefined;
        }
      })(),
    ]);
    lod?.lock(
      ini.number('MapMenu', 'uLockedTerrainLOD'),
      ini.number('MapMenu', 'uLockedObjectMapLOD'),
    );
    const settings = await session.settings();
    const camera = new MapCamera(map, mapCameraSettings(session), at);
    camera.clocked = true;
    return new WorldMapView(session, world, map, camera, {
      lod,
      sky,
      weather,
      climate,
      skySettings: skySettings((id) => settings.number(id)),
      cloudModel,
    });
  }

  /** What the renderer draws while the map is open. */
  view(): SceneView {
    return {
      scenes: () => this.#scenes(),
      sky: () =>
        this.#noSky || !this.#state
          ? undefined
          : { sky: this.#sky, state: this.#state, ...sunTextures(this.#climate) },
      water: () => this.#waterFrame(),
      imageSpace: () => this.#imageSpace,
      camera: this.camera,
      clock: () => performance.now() / 1000,
      lighting: () => {
        this.#frame();
        const state = this.#state;
        return state
          ? { ...skyLighting(state, this.#imageSpace), lights: [] }
          : {
              sunDirection: [0, 0, 1],
              sunColor: [1, 1, 1],
              ambient: [
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
              ],
              fog: undefined,
              lights: [],
            };
      },
      backdrop: false,
      shadows: false,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lod?.dispose();
    this.#sky.destroy();
    this.#clouds?.destroy();
    this.#imageSpaces.clear();
  }

  /** Once a frame: the LOD's blocks (loaded as they come; locked, so once). */
  update(): void {
    this.#lod?.update(this.camera.target[0], this.camera.target[1]);
  }

  *#scenes(): Iterable<GpuScene> {
    if (this.#lod) yield* this.#lod.scenes();
    if (this.#clouds) yield this.#clouds;
  }

  /** The sky, light and imagespace at the game's time (the game stands still under the map). */
  #frame(): void {
    const session = this.#session;
    const hour = session.gameHour;
    const days = session.gameDaysPassed;
    this.#state = skyState({
      lightning: 0,
      weather: this.#weather,
      climate: this.#climate,
      hour,
      daysPassed: days,
      cloudMinutes: (days * 24 + hour) * 60,
      settings: this.#skySettings,
    });
    const spaces: { space: ImageSpace; weight: number }[] = [];
    for (const { formId, weight } of this.#state.imageSpaces) {
      const space = this.#loadImageSpace(formId);
      if (space) spaces.push({ space, weight });
    }
    const blended = spaces.length > 0 ? blendImageSpaces(spaces) : undefined;
    this.#imageSpace = blended && this.#mapImageSpace(blended);
  }

  /** The weather's imagespace as the map shows it: the map's boosts and depth of field. */
  #mapImageSpace(space: ImageSpace): ImageSpace {
    const ini = this.#session.ini;
    const map = (key: Parameters<typeof ini.number<'MapMenu'>>[1]): number =>
      ini.number('MapMenu', key);
    const maxBlur = map('fWorldMapMaximumDepthBlur');
    return {
      ...space,
      hdr: {
        ...space.hdr,
        bloomThreshold:
          space.hdr.bloomThreshold + ini.number('Display', 'fGlobalMapBloomThresholdBoost'),
      },
      brightness: space.brightness + ini.number('Display', 'fGlobalMapBrightnessBoost'),
      contrast: space.contrast + ini.number('Display', 'fGlobalMapContrastBoost'),
      depthOfField:
        maxBlur > 0
          ? {
              strength: 1,
              distance: 0,
              range: 0,
              blurRadius: 0,
              sky: !ini.bool('MapMenu', 'bWorldMapNoSkyDepthBlur'),
              worldMap: {
                focal: map('fWorldMapFocalDepth'),
                maxBlur,
                scale: map('fWorldMapDepthBlurScale'),
                nearScale: map('fWorldMapNearDepthBlurScale'),
              },
            }
          : { strength: 0, distance: 0, range: 0, blurRadius: 0, sky: true },
    };
  }

  #waterFrame(): WaterFrame | undefined {
    const state = this.#state;
    if (!state) return undefined;
    return {
      horizon: state.horizon,
      lower: state.skyLower,
      upper: state.skyUpper,
      multiplier: state.waterMultiplier,
      profile: this.#sky.profile,
    };
  }

  #loadImageSpace(formId: number): ImageSpace | undefined {
    if (!this.#imageSpaces.has(formId)) {
      this.#imageSpaces.set(formId, undefined);
      void this.#session.db
        .then((db) => db.get(formId))
        .then((record) => {
          if (record?.type === 'IMGS' && !this.#disposed) {
            this.#imageSpaces.set(formId, parseImageSpace(record));
          }
        });
    }
    return this.#imageSpaces.get(formId);
  }
}
