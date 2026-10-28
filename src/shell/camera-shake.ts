// The camera's shake (docs/animation.md, "Graph events"): a giant's stomp (its graph's
// CameraShake event, payload the strength), Game.ShakeCamera, a shout, an explosion. Observed in the
// original, in our words: a shake starts at a strength (above 0) from a place. Within
// fCameraShakeDistFadeStart × strength of the camera (at least fCameraShakeDistMin) it keeps its
// strength; beyond, it fades over fCameraShakeDistFadeDelta × strength, and past that it does
// not start. Its strength is then kept within fCameraShakeMultMin and 1, and it lasts the time
// asked for (fCameraShakeTime when none). A new shake replaces the one under way. Each frame the
// camera turns by the rotation meshes\actors\character\camerashake.nif's animation has then
// against its first key, its angles times the strength, which fades out over the shake's last
// fCameraShakeFadeTime seconds.

import { parseNif } from '../formats/nif/nif.ts';
import {
  buildAnimation,
  controllerTime,
  sampleTransform,
  type AnimationTrack,
  type Timing,
  type TransformSource,
} from '../render/animation.ts';
import type { Vec3 } from '../render/math.ts';
import type { Vfs } from '../vfs/vfs.ts';

/** What the shake reads its model and settings from (the game session). */
export interface ShakeSource {
  readonly vfs: Pick<Vfs, 'read'>;
  settings(): Promise<{ number(name: string): number | undefined }>;
}

/** The shake's model: its root node's animation (the engine's sCameraShakeFilename). */
const SHAKE_MODEL = 'meshes\\actors\\character\\camerashake.nif';

/** The game settings of the shake (GMST), with the engine's built-in values. */
export interface CameraShakeSettings {
  /** fCameraShakeTime: how long a shake lasts when its caller asks no time (seconds). */
  readonly time: number;
  /** fCameraShakeFadeTime: its last seconds, over which it fades out. */
  readonly fadeTime: number;
  /** fCameraShakeMultMin: the least strength a shake has. */
  readonly multMin: number;
  /** fCameraShakeDistMin: the least distance it keeps its strength within (game units). */
  readonly distMin: number;
  /** fCameraShakeDistFadeStart: times the strength, the distance it begins to fade at. */
  readonly distFadeStart: number;
  /** fCameraShakeDistFadeDelta: times the strength, the distance it fades over. */
  readonly distFadeDelta: number;
  /** fCameraShakeExplosionDistMult: an explosion's shake strength per unit of its radius. */
  readonly explosionDistMult: number;
}

export const CAMERA_SHAKE_DEFAULTS: CameraShakeSettings = {
  time: 1.25,
  fadeTime: 0.25,
  multMin: 0,
  distMin: 300,
  distFadeStart: 2000,
  distFadeDelta: 2500,
  explosionDistMult: 0.001,
};

/** The shake's settings: the load order's GMSTs, else the engine's values. */
export async function readCameraShakeSettings(
  setting: (name: string) => Promise<number | string | undefined>,
): Promise<CameraShakeSettings> {
  const number = async (name: string, fallback: number): Promise<number> => {
    const value = await setting(name);
    return typeof value === 'number' ? value : fallback;
  };
  const d = CAMERA_SHAKE_DEFAULTS;
  return {
    time: await number('fCameraShakeTime', d.time),
    fadeTime: await number('fCameraShakeFadeTime', d.fadeTime),
    multMin: await number('fCameraShakeMultMin', d.multMin),
    distMin: await number('fCameraShakeDistMin', d.distMin),
    distFadeStart: await number('fCameraShakeDistFadeStart', d.distFadeStart),
    distFadeDelta: await number('fCameraShakeDistFadeDelta', d.distFadeDelta),
    explosionDistMult: await number('fCameraShakeExplosionDistMult', d.explosionDistMult),
  };
}

/**
 * A shake's strength at the camera, `distance` away from where it starts: undefined when it is
 * too far to start (or asks for none).
 */
export function shakeStrength(
  strength: number,
  distance: number,
  settings: CameraShakeSettings,
): number | undefined {
  if (!(strength > 0)) return undefined;
  const fadeStart = Math.max(settings.distFadeStart * strength, settings.distMin);
  const fadeDelta = settings.distFadeDelta * strength;
  if (distance >= fadeStart + fadeDelta) return undefined;
  let at = strength;
  if (distance > fadeStart) at *= 1 - (distance - fadeStart) / fadeDelta;
  if (at > 1) return 1;
  return at < settings.multMin ? settings.multMin : at;
}

/** What an explosion's shake reads of it (EXPL DATA). */
export interface ShakingExplosion {
  readonly radius: number;
  readonly sound: number | undefined;
  readonly sound2: number | undefined;
}

/**
 * The shake an explosion starts where it bursts (observed in the original): its radius
 * times fCameraShakeExplosionDistMult (a 200-unit fireball: 0.2), for fCameraShakeTime, faded by
 * its distance as every shake; only an explosion with a sound shakes the camera (the engine
 * starts it with the explosion's sounds).
 */
export function explosionShake(
  explosion: ShakingExplosion,
  settings: Pick<CameraShakeSettings, 'explosionDistMult'>,
): number {
  if (explosion.sound === undefined && explosion.sound2 === undefined) return 0;
  return settings.explosionDistMult * explosion.radius;
}

/** A shake's strength with `left` seconds of it to go: it fades over its last fadeTime. */
export function fadedStrength(
  strength: number,
  left: number,
  settings: CameraShakeSettings,
): number {
  if (left <= 0) return 0;
  return left < settings.fadeTime ? (left * strength) / settings.fadeTime : strength;
}

/** A rotation (w, x, y, z). */
type Quaternion = readonly [number, number, number, number];

/** The shake model's motion: its root's rotation at a time against its first key. */
export interface ShakeMotion {
  turn(seconds: number): Quaternion;
}

/**
 * The angles (radians) about x, y and z of a rotation, as rotating about x, then y, then z
 * makes it (the engine's Euler XYZ); a shake's are a few degrees.
 */
export function eulerXyz(q: Quaternion): Vec3 {
  const [w, x, y, z] = q;
  const x2 = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const y2 = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const z2 = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [x2, y2, z2];
}

/** The camera's shake: started from places, stepped with the game's time. */
export class CameraShake {
  #settings = CAMERA_SHAKE_DEFAULTS;
  #motion: ShakeMotion | undefined;
  #strength = 0;
  #left = 0;
  #clock = 0;
  /** The turn this frame (radians about the camera's right, forward and up), if it shakes. */
  angles: Vec3 | undefined;

  /** Its settings and its model's motion (read once a session has them). */
  configure(settings: CameraShakeSettings, motion: ShakeMotion | undefined): void {
    this.#settings = settings;
    this.#motion = motion;
  }

  get settings(): CameraShakeSettings {
    return this.#settings;
  }

  /** A shake starts `distance` from the camera (seconds: its length; 0 or none: fCameraShakeTime). */
  start(strength: number, distance: number, seconds?: number): void {
    const at = shakeStrength(strength, distance, this.#settings);
    if (at === undefined) return;
    this.#strength = at;
    this.#left = seconds !== undefined && seconds > 0 ? seconds : this.#settings.time;
  }

  /** Whether it shakes now. */
  get shaking(): boolean {
    return this.#left > 0 && this.#strength > 0;
  }

  /** The game's time goes on `seconds`: the turn of this frame (angles), or none. */
  step(seconds: number): void {
    this.#clock += seconds;
    if (!this.shaking) {
      this.angles = undefined;
      return;
    }
    this.#left -= seconds;
    const strength = fadedStrength(this.#strength, this.#left, this.#settings);
    if (this.#left <= 0) {
      this.#strength = 0;
      this.#left = 0;
    }
    const motion = this.#motion;
    if (strength <= 0 || !motion) {
      this.angles = undefined;
      return;
    }
    const [x, y, z] = eulerXyz(motion.turn(this.#clock));
    this.angles = [x * strength, y * strength, z * strength];
  }
}

/** Gives a play's camera shake its settings and its model's motion (a missing model: none). */
export async function prepareCameraShake(session: ShakeSource, shake: CameraShake): Promise<void> {
  const settings = await session.settings();
  const [read, motion] = await Promise.all([
    readCameraShakeSettings((name) => Promise.resolve(settings.number(name))),
    loadShakeMotion(session).catch(() => undefined),
  ]);
  shake.configure(read, motion);
}

/** The shake model's motion (undefined: it has none we read). */
export async function loadShakeMotion(session: ShakeSource): Promise<ShakeMotion | undefined> {
  const file = parseNif(await session.vfs.read(SHAKE_MODEL));
  const animation = buildAnimation(file);
  let track: Extract<AnimationTrack, { kind: 'transform' }> | undefined;
  for (const entry of animation?.tracks ?? []) if (entry.kind === 'transform') track ??= entry;
  if (!track) return undefined;
  const source: TransformSource = track.source;
  const timing: Timing = track.timing;
  const conjugate = (q: Quaternion): Quaternion => [q[0], -q[1], -q[2], -q[3]];
  const rest = sampleTransform(source, timing.start).rotation ?? [1, 0, 0, 0];
  const restInverse = conjugate(rest);
  return {
    turn: (seconds) => {
      const now = sampleTransform(source, controllerTime(timing, seconds)).rotation ?? rest;
      return multiplyQuaternions(now, restInverse);
    },
  };
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}
