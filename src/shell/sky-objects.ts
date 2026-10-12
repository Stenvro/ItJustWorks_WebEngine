// The weather's objects in the sky: its sky statics (WTHR TNAM: distant cloud banks on the
// horizon, Sovngarde's sky) and its aurora (WTHR MODL). They are drawn around the camera,
// scaled up so they lie behind everything (same angular size), without fog, and fade with
// changes of weather and, for the aurora, with the time of day.
// Notes: docs/formats/esm.md ("Climate and weather").

import type { Vec3 } from '../render/math.ts';
import type { GpuScene, SceneRenderer } from '../render/scene-renderer.ts';
import { baseModelPath } from '../world/cell-records.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import type { SkyState } from '../world/sky-state.ts';
import { WeatherFlag, type WeatherRecord } from '../world/weather.ts';
import type { GameSession } from './game-session.ts';

/**
 * How much larger than modelled sky objects are drawn: far beyond the landscape's LOD, the
 * aurora (in sky-mesh units, behind the dome) beyond the distant clouds (in world units).
 */
const STATICS_SCALE = 100;
const AURORA_SCALE = 3000;

interface SkyScene {
  readonly scene: GpuScene;
  /** The placement every part follows (updated in place each frame). */
  readonly world: Float32Array;
}

export class SkyObjects {
  readonly #session: GameSession;
  readonly #db: RecordDatabase;
  readonly #renderer: SceneRenderer;
  /** Sky scenes by key (statics of a weather, an aurora model); undefined while loading. */
  readonly #scenes = new Map<string, SkyScene | undefined>();
  #active: GpuScene[] = [];

  constructor(session: GameSession, db: RecordDatabase, renderer: SceneRenderer) {
    this.#session = session;
    this.#db = db;
    this.#renderer = renderer;
  }

  /** Places and fades the sky objects of the current (and previous) weather. */
  update(
    weather: WeatherRecord,
    previous: WeatherRecord | undefined,
    transition: number,
    state: SkyState,
    camera: Vec3,
  ): void {
    const active: GpuScene[] = [];
    const show = (
      key: string,
      load: () => Promise<SkyScene | undefined>,
      fade: number,
      turn = 0,
    ) => {
      if (fade <= 0) return;
      if (!this.#scenes.has(key)) {
        this.#scenes.set(key, undefined);
        void load().then(
          (scene) => this.#scenes.set(key, scene),
          () => undefined,
        );
      }
      const sky = this.#scenes.get(key);
      if (!sky) return;
      const scale = key.startsWith('aurora') ? AURORA_SCALE : STATICS_SCALE;
      const cos = Math.cos(turn) * scale;
      const sin = Math.sin(turn) * scale;
      sky.world.set([cos, sin, 0, 0, -sin, cos, 0, 0, 0, 0, scale, 0, ...camera, 1]);
      this.#renderer.fadeScene(sky.scene, fade);
      active.push(sky.scene);
    };
    for (const [entry, weight] of [
      [weather, previous ? transition : 1],
      [previous, 1 - transition],
    ] as const) {
      if (!entry || entry.skyStatics.length === 0) continue;
      show(`statics ${String(entry.formId)}`, () => this.#loadStatics(entry), weight);
    }
    if (weather.aurora !== '' && state.aurora > 0) {
      // Auroras that follow the sun turn with its heading.
      const turn =
        (weather.flags & WeatherFlag.followsSunPosition) !== 0
          ? -Math.atan2(state.sunDirection[0], state.sunDirection[1])
          : 0;
      show(
        `aurora ${weather.aurora}`,
        () => this.#loadModels([weather.aurora], AURORA_SCALE),
        state.aurora,
        turn,
      );
    }
    this.#active = active;
  }

  /** The sky scenes to draw this frame. */
  scenes(): readonly GpuScene[] {
    return this.#active;
  }

  dispose(): void {
    for (const sky of this.#scenes.values()) sky?.scene.destroy();
    this.#scenes.clear();
    this.#active = [];
  }

  async #loadStatics(weather: WeatherRecord): Promise<SkyScene | undefined> {
    const paths: string[] = [];
    for (const formId of weather.skyStatics) {
      const record = await this.#db.get(formId);
      const path = record && baseModelPath(record);
      if (path) paths.push(path);
    }
    return this.#loadModels(paths, STATICS_SCALE);
  }

  async #loadModels(paths: readonly string[], scale: number): Promise<SkyScene | undefined> {
    const models = await Promise.all(paths.map((path) => this.#session.model(path)));
    // Placed at the camera every frame; the scale sizes the parts' bounds (draw order).
    const world = new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
    const instances = models.flatMap((model) => (model ? [{ model, world }] : []));
    if (instances.length === 0) return undefined;
    return { scene: this.#renderer.createScene(instances, { sky: true }), world };
  }
}
