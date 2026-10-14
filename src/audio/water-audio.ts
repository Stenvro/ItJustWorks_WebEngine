// The sound of water near the listener: each water type's open sound (WATR SNAM: rivers,
// cave pools, Apocrypha's sea) loops while there is water of that type around. As the [Audio]
// settings describe it, water is sampled on a grid of uWaterAudioAxisSamplePoints² points
// around the listener, reaching uWaterAudioAmbientAttenuation units each way; the
// uWaterAudioSamplePointsToUse nearest water points place the sound (here: their centre,
// weighted by nearness, at the nearest one's distance), which fades in over
// fWaterAudioFadeInSeconds and out over fWaterAudioFadeOutSeconds. How the engine combines
// the points is not documented: TODO(M13): compare with the game. Platform-independent.
// Notes: docs/audio.md ("Water").

import { invert } from '../render/frustum.ts';
import { transformPoint, type Mat4, type Vec3 } from '../render/math.ts';
import type { IniSettings } from '../world/ini-settings.ts';

/**
 * Water at a point: its surface height (the one nearest the height `z`) and type (WATR), if
 * water covers the ground there.
 */
export type WaterAt = (
  x: number,
  y: number,
  z: number,
) => { height: number; type: number } | undefined;

/** A water activator's surface (CellWaterArea). */
export interface WaterArea {
  readonly type: number;
  readonly world: Mat4;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * The surface height of a water activator over a point, if the point lies within its bounds:
 * the top of its box for flat water; water running down a slope or stairs (Whiterun's streams)
 * lies somewhere between its box's bottom and top, taken as the height there nearest `z`.
 */
export function waterAreaHeight(
  area: WaterArea,
  x: number,
  y: number,
  z: number,
): number | undefined {
  const top = transformPoint(area.world, [0, 0, area.max[2]])[2];
  const bottom = transformPoint(area.world, [0, 0, area.min[2]])[2];
  const toLocal = invert(area.world);
  if (!toLocal) return undefined;
  const [lx, ly] = transformPoint(toLocal, [x, y, top]);
  if (lx < area.min[0] || lx > area.max[0] || ly < area.min[1] || ly > area.max[1]) {
    return undefined;
  }
  return Math.min(Math.max(z, Math.min(bottom, top)), Math.max(bottom, top));
}

/** A playing water loop as water audio controls it (SoundInstance). */
export interface WaterSound {
  fadeOut(seconds: number): void;
  stop(immediately?: boolean): void;
}

/** What water audio plays through (the sound system). */
export interface WaterPlayer {
  /** A water type's open sound (WATR SNAM), if it has one. */
  waterSound(type: number): Promise<number | undefined>;
  play(sound: number, place: () => Vec3, fadeIn: number): Promise<WaterSound | undefined>;
}

/** The grid is sampled this often (seconds); the sounds follow every frame. */
const SAMPLE_SECONDS = 0.25;

interface WaterLoop {
  sound: WaterSound | undefined;
  /** Where it sounds from now. */
  position: Vec3;
  dropped: boolean;
}

export class WaterAudio {
  readonly #player: WaterPlayer;
  readonly #ini: IniSettings;
  readonly #sounds = new Map<number, number | undefined>();
  /** Loops by water sound (SNDR). */
  readonly #loops = new Map<number, WaterLoop>();
  #lastSample = -Infinity;

  constructor(player: WaterPlayer, ini: IniSettings) {
    this.#player = player;
    this.#ini = ini;
  }

  /** The water loops playing (SNDR form ids). */
  get playing(): number[] {
    return [...this.#loops.keys()];
  }

  /** Every frame (`now`: seconds). */
  update(listener: Vec3, waterAt: WaterAt | undefined, now: number): void {
    if (now - this.#lastSample < SAMPLE_SECONDS) return;
    this.#lastSample = now;
    const found = waterAt ? this.#sample(listener, waterAt) : new Map<number, Vec3>();
    for (const [sound, loop] of this.#loops) {
      const position = found.get(sound);
      if (position) {
        loop.position = position;
        continue;
      }
      loop.dropped = true;
      loop.sound?.fadeOut(this.#ini.number('Audio', 'fWaterAudioFadeOutSeconds'));
      this.#loops.delete(sound);
    }
    for (const [sound, position] of found) {
      if (this.#loops.has(sound)) continue;
      const loop: WaterLoop = { sound: undefined, position, dropped: false };
      this.#loops.set(sound, loop);
      const fadeIn = this.#ini.number('Audio', 'fWaterAudioFadeInSeconds');
      void this.#player
        .play(sound, () => loop.position, fadeIn)
        .then((playing) => {
          if (loop.dropped) playing?.stop(true);
          else loop.sound = playing;
        });
    }
  }

  stop(): void {
    for (const loop of this.#loops.values()) {
      loop.dropped = true;
      loop.sound?.stop(true);
    }
    this.#loops.clear();
    this.#lastSample = -Infinity;
  }

  /** The water sounds around the listener and where each sounds from. */
  #sample(listener: Vec3, waterAt: WaterAt): Map<number, Vec3> {
    const count = Math.max(2, this.#ini.number('Audio', 'uWaterAudioAxisSamplePoints'));
    const reach = this.#ini.number('Audio', 'uWaterAudioAmbientAttenuation');
    const use = this.#ini.number('Audio', 'uWaterAudioSamplePointsToUse');
    const step = (2 * reach) / (count - 1);
    const points: { x: number; y: number; z: number; distance: number; sound: number }[] = [];
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const x = listener[0] - reach + i * step;
        const y = listener[1] - reach + j * step;
        const water = waterAt(x, y, listener[2]);
        if (!water) continue;
        const sound = this.#sound(water.type);
        if (sound === undefined) continue;
        const distance = Math.hypot(x - listener[0], y - listener[1], water.height - listener[2]);
        points.push({ x, y, z: water.height, distance, sound });
      }
    }
    points.sort((a, b) => a.distance - b.distance);
    const bySound = new Map<number, typeof points>();
    for (const point of points.slice(0, use)) {
      const list = bySound.get(point.sound) ?? [];
      list.push(point);
      bySound.set(point.sound, list);
    }
    const found = new Map<number, Vec3>();
    for (const [sound, list] of bySound) {
      // The direction of the water nearby, at the distance of the nearest point.
      let wx = 0;
      let wy = 0;
      let wz = 0;
      let total = 0;
      for (const point of list) {
        const weight = 1 / Math.max(point.distance, 1) ** 2;
        wx += point.x * weight;
        wy += point.y * weight;
        wz += point.z * weight;
        total += weight;
      }
      const centre: Vec3 = [wx / total, wy / total, wz / total];
      const nearest = list[0]?.distance ?? 0;
      const dx = centre[0] - listener[0];
      const dy = centre[1] - listener[1];
      const dz = centre[2] - listener[2];
      const length = Math.hypot(dx, dy, dz);
      found.set(
        sound,
        length < 1
          ? centre
          : [
              listener[0] + (dx / length) * nearest,
              listener[1] + (dy / length) * nearest,
              listener[2] + (dz / length) * nearest,
            ],
      );
    }
    return found;
  }

  #sound(type: number): number | undefined {
    if (!this.#sounds.has(type)) {
      this.#sounds.set(type, undefined);
      void this.#player.waterSound(type).then((sound) => {
        this.#sounds.set(type, sound);
      });
    }
    return this.#sounds.get(type);
  }
}
