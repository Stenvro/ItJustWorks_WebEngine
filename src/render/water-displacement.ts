// The water's interactive displacement, the way the original runs it: a height field on a square
// grid that follows the camera, in which actors wading and swimming, splashes and projectiles
// stamp ripples and a damped wave equation carries them away. The water shader bends its normals
// by the field's slopes (water.wgsl displacementSlope), scaled by the water type's displacement
// dampener. This file decides what the field does each frame and holds the math; the GPU runs
// it (water-displacement-gpu.ts, shaders/water-displacement.wgsl). Platform-independent.
//
// Observed in the original:
// - The grid is fWadingWaterQuadSize (2048) units across, fWadingWaterTextureRes (512) texels a
//   side, centred on the camera. Its centre moves in whole steps of 4 units (a texel), once the
//   camera is more than 4 units from it; the field is shifted with it, so ripples stay in place.
// - Each frame, every actor in the water stamps a ripple along its way since the last frame
//   (from where it was to where it is); a splash or a projectile meeting the water stamps a small
//   one (scale 0.01) at its point, if bUseBulletWaterDisplacements is set and the point lies
//   within fWadingWaterQuadSize of the grid's centre.
// - The field then steps at a fixed 0.025 seconds (40 a second), as many steps as the frame's
//   time holds.
// - Two layers run side by side: the wading layer and the rain layer, each with four values
//   (force, velocity, falloff, starting size). The wading values are set every frame to 0.2, 1.7,
//   0.99 and 0.01, the rain values stay at 0.1, 0.6, 0.985 and 0.01: the water types' own
//   Displacement Simulator values (WATR DNAM) do not drive the simulation; their dampener goes to
//   the water's material.
// - Once nothing has stamped a ripple for 10 seconds the simulation stops, and it starts from
//   a still field when the next ripple comes.
//
// Our reading of the four values (the simulation's shaders are not readable, TODO(M13)):
// a ripple pushes the surface down by `force` along its way, `size` × half the grid wide (a
// soft round brush); each step the field follows the wave equation
//   next = ((2 − v)·h + (v / 4)·Σ neighbours − previous) · falloff
// with v = `velocity` (stable up to 2). Rain: drops at random points while it rains, at
// RAIN_DROPS_PER_STEP × the rain's amount a step (TODO(M13): the original's rain pattern).

import type { IniSettings } from '../world/ini-settings.ts';
import type { Vec3 } from './math.ts';

/** The [Water] INI settings of the displacement. */
export interface DisplacementSettings {
  /** bUseWaterDisplacements: the simulation runs at all. */
  readonly enabled: boolean;
  /** bUseBulletWaterDisplacements: splashes and projectiles stamp ripples. */
  readonly bullets: boolean;
  /** fWadingWaterQuadSize: the grid's width (units). */
  readonly quadSize: number;
  /** fWadingWaterTextureRes: its texels a side. */
  readonly textureRes: number;
}

/** The engine's defaults (Skyrim_Default.ini has no [Water] section). */
export const DISPLACEMENT_DEFAULTS: DisplacementSettings = {
  enabled: true,
  bullets: true,
  quadSize: 2048,
  textureRes: 512,
};

/** The settings from the INI files ([Water]). */
export function displacementSettings(ini: IniSettings): DisplacementSettings {
  return {
    enabled: ini.bool('Water', 'bUseWaterDisplacements'),
    bullets: ini.bool('Water', 'bUseBulletWaterDisplacements'),
    quadSize: Math.max(ini.number('Water', 'fWadingWaterQuadSize'), GRID_STEP * 2),
    textureRes: Math.min(
      Math.max(Math.round(ini.number('Water', 'fWadingWaterTextureRes')), 8),
      2048,
    ),
  };
}

/** A layer's values: the push of a ripple, its waves' speed and fade, a ripple's size. */
export interface RippleVars {
  readonly force: number;
  readonly velocity: number;
  readonly falloff: number;
  readonly size: number;
}

/** The wading layer's values, set every frame (observed in the original). */
export const WADING_VARS: RippleVars = { force: 0.2, velocity: 1.7, falloff: 0.99, size: 0.01 };
/** The rain layer's values (observed in the original). */
export const RAIN_VARS: RippleVars = { force: 0.1, velocity: 0.6, falloff: 0.985, size: 0.01 };

/** Seconds a simulation step stands for. */
export const SIMULATION_STEP = 0.025;
/** Seconds without a new ripple after which the simulation stops. */
export const IDLE_TIMEOUT = 10;
/** The scale of a splash's or a projectile's ripple. */
export const SPLASH_RIPPLE = 0.01;
/** The grid's centre moves in steps of this many units, once the camera is further away. */
export const GRID_STEP = 4;
/** At most this many steps a frame (ours: a long frame or a pause drops the rest). */
export const MAX_STEPS = 8;
/** At most this many ripples a frame (the GPU's list; the oldest go). */
export const MAX_RIPPLES = 64;
/** A wading actor's way longer than this in a frame (units) is not a ripple (ours). */
export const MAX_WADING_STRIDE = 256;
/** Rain drops a step at full rain (ours, TODO(M13)). */
export const RAIN_DROPS_PER_STEP = 4;
/**
 * Heights stay within ± this (ours: a field stored around a middle value, as the original's
 * render targets are, cannot go further; TODO(M13): its format). An actor standing in the
 * water stamps every frame; the limit keeps the hollow it makes from deepening without end.
 */
export const HEIGHT_LIMIT = 0.5;

/** A ripple stamped into a layer, in texels of the grid (x east, y north from its corner). */
export interface RippleStamp {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** The brush's radius (texels) and its push. */
  readonly radius: number;
  readonly force: number;
  /** 0: the wading layer, 1: the rain layer. */
  readonly layer: 0 | 1;
}

/** What the field does this frame. */
export interface DisplacementFrame {
  /** The grid's centre (world units) and size, and its texels a side. */
  readonly center: readonly [number, number];
  readonly quadSize: number;
  readonly textureRes: number;
  /** Texels the grid moved since the last frame (its content moves the other way). */
  readonly shift: readonly [number, number];
  /** The field starts still (the simulation was stopped). */
  readonly clear: boolean;
  readonly stamps: readonly RippleStamp[];
  /** Simulation steps to run. */
  readonly steps: number;
  readonly wading: RippleVars;
  readonly rain: RippleVars;
}

export class WaterDisplacement {
  readonly settings: DisplacementSettings;
  #center: [number, number] | undefined;
  /** Ripples since the last frame, in world units: from where to where, layer 0. */
  #pending: { x0: number; y0: number; x1: number; y1: number }[] = [];
  /** Each wading actor's last point. */
  readonly #wading = new Map<number, { x: number; y: number }>();
  #idle = IDLE_TIMEOUT;
  #running = false;
  /** Seconds of frames not yet stepped. */
  #time = 0;
  #last: number | undefined;
  readonly #random: () => number;

  constructor(settings: DisplacementSettings = DISPLACEMENT_DEFAULTS, random = Math.random) {
    this.settings = settings;
    this.#random = random;
  }

  /** A splash or a projectile met the water at a point (the original's AddRipple). */
  ripple(position: Vec3, scale = SPLASH_RIPPLE): void {
    if (!this.settings.enabled || !this.settings.bullets) return;
    const center = this.#center;
    if (center) {
      const dx = position[0] - center[0];
      const dy = position[1] - center[1];
      if (dx * dx + dy * dy > this.settings.quadSize * this.settings.quadSize) return;
    }
    // The ripple runs from its point a scale's half of the grid's half-width north-east.
    const reach = (scale / 2) * (this.settings.quadSize / 2);
    this.#push(position[0], position[1], position[0] + reach, position[1] + reach);
  }

  /** An actor (key) in the water this frame, at the surface above its feet. */
  wade(key: number, position: Vec3): void {
    if (!this.settings.enabled) return;
    let last = this.#wading.get(key);
    this.#wading.set(key, { x: position[0], y: position[1] });
    // A jump of its place (a teleport, a frame long missed) starts afresh.
    if (last && Math.hypot(position[0] - last.x, position[1] - last.y) > MAX_WADING_STRIDE) {
      last = undefined;
    }
    this.#push(last?.x ?? position[0], last?.y ?? position[1], position[0], position[1]);
  }

  /** An actor left the water: its next wading starts where it enters. */
  leave(key: number): void {
    this.#wading.delete(key);
  }

  /** Whether the simulation runs (it stops once nothing has stirred the water for a while). */
  get running(): boolean {
    return this.#running;
  }

  /**
   * The frame's turn: the grid follows the camera, the ripples since the last frame are stamped,
   * and the steps the time holds run. `now` in seconds; `rain` 0..1 while it rains.
   */
  frame(camera: Vec3, now: number, rain = 0): DisplacementFrame | undefined {
    const seconds = this.#last === undefined ? 0 : Math.max(0, Math.min(now - this.#last, 1));
    this.#last = now;
    if (!this.settings.enabled) return undefined;
    const { quadSize, textureRes } = this.settings;
    const texel = quadSize / textureRes;
    // The grid follows the camera in whole steps.
    let shift: [number, number] = [0, 0];
    const previous = this.#center;
    if (
      !previous ||
      Math.abs(camera[0] - previous[0]) > GRID_STEP ||
      Math.abs(camera[1] - previous[1]) > GRID_STEP
    ) {
      const center: [number, number] = [
        Math.floor(camera[0] / GRID_STEP) * GRID_STEP,
        Math.floor(camera[1] / GRID_STEP) * GRID_STEP,
      ];
      if (previous) {
        shift = [
          Math.round((center[0] - previous[0]) / texel),
          Math.round((center[1] - previous[1]) / texel),
        ];
      }
      this.#center = center;
    }
    const center = this.#center ?? [0, 0];
    // Rain stirs the water too (a ripple each drop).
    const drops = Math.max(0, rain) * RAIN_DROPS_PER_STEP;
    const placed = this.#pending.length > 0 || drops > 0;
    let clear = false;
    if (placed) {
      this.#idle = 0;
      if (!this.#running) {
        this.#running = true;
        clear = true;
        this.#time = 0;
      }
    } else {
      this.#idle += seconds;
      if (this.#idle >= IDLE_TIMEOUT) this.#running = false;
    }
    const pending = this.#pending.slice(-MAX_RIPPLES);
    this.#pending = [];
    if (!this.#running) return undefined;
    const toTexel = (value: number, origin: number): number =>
      (value - origin) / texel + textureRes / 2;
    const radius = (WADING_VARS.size * textureRes) / 2;
    const stamps: RippleStamp[] = pending.map((ripple) => ({
      x0: toTexel(ripple.x0, center[0]),
      y0: toTexel(ripple.y0, center[1]),
      x1: toTexel(ripple.x1, center[0]),
      y1: toTexel(ripple.y1, center[1]),
      radius: Math.max(radius, 1),
      force: WADING_VARS.force,
      layer: 0,
    }));
    // A field that starts now has no time behind it.
    if (!clear) this.#time += seconds;
    const steps = Math.min(Math.floor(this.#time / SIMULATION_STEP), MAX_STEPS);
    this.#time = Math.min(this.#time - steps * SIMULATION_STEP, SIMULATION_STEP);
    // Rain: drops at random over the grid, a number for each step.
    let count = drops * steps;
    while (count > 0 && stamps.length < MAX_RIPPLES) {
      if (count < 1 && this.#random() >= count) break;
      count -= 1;
      const x = this.#random() * textureRes;
      const y = this.#random() * textureRes;
      const rainRadius = Math.max((RAIN_VARS.size * textureRes) / 2, 1);
      stamps.push({
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        radius: rainRadius,
        force: RAIN_VARS.force,
        layer: 1,
      });
    }
    return {
      center: [center[0], center[1]],
      quadSize,
      textureRes,
      shift,
      clear,
      stamps,
      steps,
      wading: WADING_VARS,
      rain: RAIN_VARS,
    };
  }

  #push(x0: number, y0: number, x1: number, y1: number): void {
    this.#pending.push({ x0, y0, x1, y1 });
    if (this.#pending.length > MAX_RIPPLES * 2) this.#pending.splice(0, MAX_RIPPLES);
  }
}

/**
 * A ripple's push at a texel (its centre at x, y): a soft round brush along the ripple's way,
 * full on the line, nothing past its radius. Negative: the surface is pushed down.
 */
export function stampAt(stamp: RippleStamp, x: number, y: number): number {
  const dx = stamp.x1 - stamp.x0;
  const dy = stamp.y1 - stamp.y0;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 > 0
      ? Math.max(0, Math.min(1, ((x - stamp.x0) * dx + (y - stamp.y0) * dy) / length2))
      : 0;
  const distance = Math.hypot(x - (stamp.x0 + dx * t), y - (stamp.y0 + dy * t));
  if (distance >= stamp.radius) return 0;
  return -stamp.force * 0.5 * (1 + Math.cos((Math.PI * distance) / stamp.radius));
}

/**
 * One simulation step of a layer on the CPU (the GPU's step, for tests): `height` and `previous`
 * are size × size fields (row-major, rows northward); texels past the edge are still water.
 */
export function waveStep(
  height: Float32Array,
  previous: Float32Array,
  size: number,
  vars: RippleVars,
): Float32Array {
  const next = new Float32Array(size * size);
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= size || y >= size ? 0 : (height[y * size + x] ?? 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const around = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1);
      const h = height[i] ?? 0;
      const value =
        ((2 - vars.velocity) * h + (vars.velocity / 4) * around - (previous[i] ?? 0)) *
        vars.falloff;
      next[i] = Math.max(-HEIGHT_LIMIT, Math.min(HEIGHT_LIMIT, value));
    }
  }
  return next;
}
