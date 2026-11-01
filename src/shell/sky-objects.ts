// The weather's objects in the sky: its sky statics (WTHR TNAM: the distant cloud banks round the
// mountains, Sovngarde's sky) and its aurora (WTHR MODL).
// - The sky statics are placed references (persistent, Full LOD: 1059 in vanilla); the sky shows
//   those whose base the current or outgoing weather lists, faded by the weather change
//   (weather.ts skyStaticShare). Their cloud shapes are effects with External_Emittance and
//   Effect_Lighting: they are lit by the weather's sky statics colour (NAM0 Sky Statics, by the
//   hour), not by the sun and ambient light.
// - The aurora is drawn around the camera, scaled up so it lies behind everything (same angular
//   size), without fog, and fades with changes of weather and with the time of day.
// Notes: docs/formats/esm.md ("Climate and weather").

import type { Vec3 } from '../render/math.ts';
import type {
  GpuScene,
  InstanceFade,
  ModelInstance,
  SceneRenderer,
} from '../render/scene-renderer.ts';
import type { SkyState } from '../world/sky-state.ts';
import { skyStaticShare, WeatherFlag, type WeatherRecord } from '../world/weather.ts';
import type { GameSession } from './game-session.ts';

/** How much larger than modelled the aurora is drawn (in sky-mesh units, behind the dome). */
const AURORA_SCALE = 3000;

interface SkyScene {
  readonly scene: GpuScene;
  /** The placement every part follows (updated in place each frame). */
  readonly world: Float32Array;
}

export class SkyObjects {
  readonly #session: GameSession;
  readonly #renderer: SceneRenderer;
  /** Aurora scenes by model; undefined while loading. */
  readonly #scenes = new Map<string, SkyScene | undefined>();
  #active: GpuScene[] = [];
  /** Every weather's sky statics (the bases whose references the sky shows or hides). */
  #statics = new Set<number>();
  /** This frame's weathers (the statics' shares). */
  #weather: WeatherRecord | undefined;
  #previous: WeatherRecord | undefined;
  #transition = 1;
  /** The statics' emittance: the sky statics colour of this frame's sky (shared by all). */
  readonly #emittance: { rgb: readonly [number, number, number]; version: number } = {
    rgb: [0, 0, 0],
    version: 0,
  };

  constructor(session: GameSession, renderer: SceneRenderer) {
    this.#session = session;
    this.#renderer = renderer;
    void session.weathers().then((weathers) => {
      const statics = new Set<number>();
      for (const { formId } of weathers) {
        for (const base of session.weatherRecord(formId)?.skyStatics ?? []) statics.add(base);
      }
      this.#statics = statics;
    });
  }

  /** Places and fades the aurora, and takes the weathers the sky statics are shown by. */
  update(
    weather: WeatherRecord | undefined,
    previous: WeatherRecord | undefined,
    transition: number,
    state: SkyState | undefined,
    camera: Vec3,
  ): void {
    this.#weather = weather;
    this.#previous = previous;
    this.#transition = transition;
    const active: GpuScene[] = [];
    if (!weather || !state) {
      this.#active = active;
      return;
    }
    const light = state.skyStatics;
    if (light.some((value, i) => Math.abs(value - (this.#emittance.rgb[i] ?? 0)) > 1 / 1024)) {
      this.#emittance.rgb = [light[0], light[1], light[2]];
      this.#emittance.version++;
    }
    if (weather.aurora !== '' && state.aurora > 0) {
      const key = weather.aurora;
      if (!this.#scenes.has(key)) {
        this.#scenes.set(key, undefined);
        void this.#loadAurora(key).then(
          (scene) => this.#scenes.set(key, scene),
          () => undefined,
        );
      }
      const sky = this.#scenes.get(key);
      if (sky) {
        // Auroras that follow the sun turn with its heading.
        const turn =
          (weather.flags & WeatherFlag.followsSunPosition) !== 0
            ? -Math.atan2(state.sunDirection[0], state.sunDirection[1])
            : 0;
        const cos = Math.cos(turn) * AURORA_SCALE;
        const sin = Math.sin(turn) * AURORA_SCALE;
        sky.world.set([cos, sin, 0, 0, -sin, cos, 0, 0, 0, 0, AURORA_SCALE, 0, ...camera, 1]);
        this.#renderer.fadeScene(sky.scene, state.aurora);
        active.push(sky.scene);
      }
    }
    this.#active = active;
  }

  /** The sky scenes to draw this frame (the aurora). */
  scenes(): readonly GpuScene[] {
    return this.#active;
  }

  /** Whether a base is a sky static of some weather (its references are the sky's). */
  isSkyStatic(base: number): boolean {
    return this.#statics.has(base);
  }

  /** How much of a sky static's references this frame's weathers show (0..1). */
  share(base: number): number {
    return skyStaticShare(base, this.#weather, this.#previous, this.#transition);
  }

  /**
   * A placed reference of a sky static as the sky shows it: lit by the sky statics colour and
   * veiled (dithered away) by the share of it this frame's weathers do not show.
   */
  placeStatic(instance: ModelInstance, base: number): ModelInstance {
    const share = (): number => this.share(base);
    const fade: InstanceFade = {
      kind: instance.fade?.kind ?? 'skyCell',
      ...(instance.fade?.byDistance !== undefined && { byDistance: instance.fade.byDistance }),
      get veil(): number {
        return 1 - share();
      },
    };
    return { ...instance, emittance: this.#emittance, fade };
  }

  dispose(): void {
    for (const sky of this.#scenes.values()) sky?.scene.destroy();
    this.#scenes.clear();
    this.#active = [];
  }

  async #loadAurora(path: string): Promise<SkyScene | undefined> {
    const model = await this.#session.model(path);
    if (!model) return undefined;
    // Placed at the camera every frame; the scale sizes the parts' bounds (draw order).
    const s = AURORA_SCALE;
    const world = new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
    return { scene: this.#renderer.createScene([{ model, world }], { sky: true }), world };
  }
}
