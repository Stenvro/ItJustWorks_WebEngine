// What magic shows for a moment in the world (docs/gameplay.md, "Casting and shouts"): an
// explosion's model (EXPL MODL) and light where it bursts, a projectile's muzzle flash (PROJ
// NAM1 and its muzzle flash light, for its muzzle flash duration) where it leaves the hand, an
// impact's model (IPCT MODL, for its duration) where a spell meets a surface, a cone's wave
// (Unrelenting Force: its projectile's model sweeping out to its range at its speed, with its
// light), Clairvoyance's trail (its hazard's model travelling the way to the quest's target);
// and the hazards standing in the world: their light, their sound while they stand, their
// image-space modifier on the player within their image-space radius. The lights fade with
// what carries them; each is a CellLight the viewers light the world with.

import type { Vec3 } from '../render/math.ts';
import type { RenderPort } from '../render/render-port.ts';
import type {
  GpuModel,
  GpuScene,
  InstanceMotion,
  ModelInstance,
} from '../render/scene-renderer.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { meshPath } from '../world/actors.ts';
import type { CellLight } from '../world/cell-loader.ts';
import { parseLight, type LightRecord } from '../world/cell-records.ts';
import type { GameSession } from './game-session.ts';
import { startObjectGraph } from './object-graphs.ts';
import type { Terminal } from './terminal.ts';

/** What an effect shown is (the QA monitors count them by it). */
export type FxKind = 'muzzle-flash' | 'cone' | 'explosion' | 'impact' | 'trail';

/** A model (and light) shown for a while. */
interface Fx {
  readonly key: object;
  readonly kind: FxKind;
  readonly model: string | undefined;
  scene: GpuScene | undefined;
  instance: ModelInstance | undefined;
  readonly motion: InstanceMotion;
  position: Vec3;
  /** Which way it faces (radians: yaw, pitch); upright: none. */
  readonly yaw: number;
  readonly pitch: number;
  /** Moves this fast (units a second) along its facing, at most this far (a cone's wave). */
  readonly speed: number;
  readonly range: number;
  travelled: number;
  /** Its own way (Clairvoyance's trail): points it travels through. */
  readonly path: readonly Vec3[] | undefined;
  leg: number;
  age: number;
  /** Seconds it shows (undefined: its model's own time once it has loaded). */
  duration: number | undefined;
  light: LightRecord | undefined;
  /** Its light fades over its time (an explosion's flash, a muzzle flash). */
  readonly fades: boolean;
  done: boolean;
}

/** What a model shows when its own time is not known (seconds). */
const DEFAULT_SECONDS = 3;
/** The longest an effect model shows (seconds). */
const MAX_SECONDS = 10;
/** Clairvoyance's trail moves this fast along its way (units a second). TODO(M13): the engine's. */
const TRAIL_SPEED = 600;
/** It floats this high over the ground's way (units). */
const TRAIL_HEIGHT = 48;

export interface MagicFxOptions {
  readonly session: GameSession;
  readonly renderer: RenderPort;
  readonly terminal: Terminal;
  /** Where the camera (the player's view) is, for hazards' image-space modifiers. */
  readonly player: () => Vec3 | undefined;
}

let seeds = 1;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MagicFx {
  readonly #options: MagicFxOptions;
  readonly #fx = new Set<Fx>();
  readonly #trails = new Map<string, Fx>();
  /** Each shooter's muzzle flash showing. */
  readonly #muzzles = new Map<number, Fx>();
  readonly #lights = new Map<number, Promise<LightRecord | undefined>>();
  /** Hazards seen standing: their sound playing, their modifier on. */
  readonly #hazards = new Map<
    number,
    {
      sound: number | undefined;
      imageSpace: boolean;
      light: LightRecord | undefined;
      readonly modifier: number | undefined;
    }
  >();

  constructor(options: MagicFxOptions) {
    this.#options = options;
  }

  #runtime(): ScriptRuntime | undefined {
    return this.#options.session.scriptsReady;
  }

  /** A LIGH record, read once. */
  lightRecord(formId: number | undefined): Promise<LightRecord | undefined> {
    if (formId === undefined) return Promise.resolve(undefined);
    let pending = this.#lights.get(formId);
    if (!pending) {
      const runtime = this.#runtime();
      pending = (runtime?.forms.record(formId) ?? Promise.resolve(undefined)).then((record) =>
        record?.type === 'LIGH' ? parseLight(record) : undefined,
      );
      this.#lights.set(formId, pending);
    }
    return pending;
  }

  /**
   * Shows a model (and a light) at a point: facing `direction` (none: upright), for `duration`
   * seconds (none: the model's own time), moving `speed` units a second along it up to
   * `range` (a cone's wave). Either may be missing. A muzzle flash is its shooter's (`owner`):
   * an actor has one at a time (CommonLibSSE's HighProcessData holds a single MuzzleFlash), so
   * a new shot's takes the place of the last one's.
   */
  show(
    model: string | undefined,
    light: number | undefined,
    at: Vec3,
    options: {
      readonly kind: FxKind;
      readonly direction?: Vec3;
      readonly duration?: number;
      readonly speed?: number;
      readonly range?: number;
      readonly fades?: boolean;
      readonly owner?: number;
    },
  ): void {
    if (model === undefined && light === undefined) return;
    const owner = options.owner;
    if (owner !== undefined) {
      const last = this.#muzzles.get(owner);
      if (last) this.#end(last);
    }
    const direction = options.direction;
    const fx: Fx = {
      key: {},
      kind: options.kind,
      model,
      scene: undefined,
      instance: undefined,
      motion: { version: 0 },
      position: [...at],
      yaw: direction ? Math.atan2(direction[0], direction[1]) : 0,
      pitch: direction ? Math.atan2(direction[2], Math.hypot(direction[0], direction[1])) : 0,
      speed: options.speed ?? 0,
      range: options.range ?? 0,
      travelled: 0,
      path: undefined,
      leg: 0,
      age: 0,
      duration: options.duration,
      light: undefined,
      fades: options.fades ?? false,
      done: false,
    };
    this.#fx.add(fx);
    if (owner !== undefined) this.#muzzles.set(owner, fx);
    void this.lightRecord(light).then((record) => {
      fx.light = record;
    });
    if (model !== undefined) this.#load(fx, model);
    else fx.duration ??= DEFAULT_SECONDS;
  }

  #load(fx: Fx, path: string): void {
    const { session, renderer, terminal } = this.#options;
    session
      .model(meshPath(path))
      .then((model) => {
        if (fx.done) return;
        if (!model) {
          fx.duration ??= DEFAULT_SECONDS;
          return;
        }
        fx.duration ??= modelSeconds(model);
        // A model with a behavior graph runs it (its sequences: an explosion's burst, a
        // muzzle flash's flare), as every 3D the engine loads does.
        const graph = startObjectGraph(model, seeds++);
        const instance: ModelInstance = {
          model,
          world: this.#placement(fx),
          motion: fx.motion,
          ...(graph && { graph }),
        };
        fx.instance = instance;
        fx.scene = renderer.scene.createScene([instance]);
      })
      .catch((error: unknown) => {
        fx.duration ??= DEFAULT_SECONDS;
        terminal.log('magic', `${path}: ${describe(error)}`, 'warn');
      });
  }

  #placement(fx: Fx): Float32Array {
    const c = Math.cos(fx.pitch);
    return alongMatrix(fx.position, [
      Math.sin(fx.yaw) * c,
      Math.cos(fx.yaw) * c,
      Math.sin(fx.pitch),
    ]);
  }

  /**
   * Clairvoyance (a Guide effect, `key`): its hazard's model and light travel the way (points
   * over the navmeshes) and go at its end or after the hazard's lifetime; again from the start
   * while the effect lasts.
   */
  trail(key: string, hazard: number, path: readonly Vec3[]): void {
    void (async () => {
      const runtime = this.#runtime();
      const record = runtime && (await runtime.hazards.record(hazard));
      if (!record || path.length < 2) return;
      this.stopTrail(key);
      const first = path[0] ?? [0, 0, 0];
      const fx: Fx = {
        key: {},
        kind: 'trail',
        model: record.model,
        scene: undefined,
        instance: undefined,
        motion: { version: 0 },
        position: [first[0], first[1], first[2] + TRAIL_HEIGHT],
        yaw: 0,
        pitch: 0,
        speed: TRAIL_SPEED,
        range: 0,
        travelled: 0,
        path: path.map((point): Vec3 => [point[0], point[1], point[2] + TRAIL_HEIGHT]),
        leg: 0,
        age: 0,
        duration: record.lifetime > 0 ? record.lifetime : undefined,
        light: await this.lightRecord(record.light),
        fades: false,
        done: false,
      };
      this.#trails.set(key, fx);
      this.#fx.add(fx);
      if (record.model) this.#load(fx, record.model);
    })().catch((error: unknown) => {
      this.#options.terminal.log('magic', `trail: ${describe(error)}`, 'warn');
    });
  }

  /** Whether a trail still travels. */
  trailing(key: string): boolean {
    const fx = this.#trails.get(key);
    return fx !== undefined && !fx.done;
  }

  stopTrail(key: string): void {
    const fx = this.#trails.get(key);
    this.#trails.delete(key);
    if (fx) this.#end(fx);
  }

  #end(fx: Fx): void {
    fx.done = true;
    this.#fx.delete(fx);
    for (const [owner, muzzle] of this.#muzzles) if (muzzle === fx) this.#muzzles.delete(owner);
    fx.scene?.destroy();
    fx.scene = undefined;
  }

  /** Every frame: they move on, fade and go; the hazards' sounds and modifiers follow them. */
  frame(seconds: number): void {
    for (const fx of [...this.#fx]) {
      fx.age += seconds;
      if (fx.duration !== undefined && fx.age >= fx.duration) {
        this.#end(fx);
        continue;
      }
      let moved = false;
      if (fx.path) {
        moved = this.#travel(fx, seconds * fx.speed);
        if (fx.leg >= fx.path.length - 1) {
          this.#end(fx);
          continue;
        }
      } else if (fx.speed > 0 && (fx.range <= 0 || fx.travelled < fx.range)) {
        const step = Math.min(
          seconds * fx.speed,
          fx.range > 0 ? fx.range - fx.travelled : Infinity,
        );
        fx.travelled += step;
        const c = Math.cos(fx.pitch);
        fx.position = [
          fx.position[0] + Math.sin(fx.yaw) * c * step,
          fx.position[1] + Math.cos(fx.yaw) * c * step,
          fx.position[2] + Math.sin(fx.pitch) * step,
        ];
        moved = true;
        // A wave that has swept its range is gone.
        if (fx.range > 0 && fx.travelled >= fx.range) {
          this.#end(fx);
          continue;
        }
      }
      if (moved && fx.instance) {
        fx.instance.world.set(this.#placement(fx));
        fx.motion.version++;
      }
    }
    this.#watchHazards();
  }

  /** A trail moves `distance` along its way; whether it moved. */
  #travel(fx: Fx, distance: number): boolean {
    const path = fx.path;
    if (!path) return false;
    let left = distance;
    while (left > 0 && fx.leg < path.length - 1) {
      const to = path[fx.leg + 1] ?? fx.position;
      const offset: Vec3 = [to[0] - fx.position[0], to[1] - fx.position[1], to[2] - fx.position[2]];
      const length = Math.hypot(...offset);
      if (length <= left) {
        fx.position = [...to];
        fx.leg++;
        left -= length;
        continue;
      }
      const s = left / length;
      fx.position = [
        fx.position[0] + offset[0] * s,
        fx.position[1] + offset[1] * s,
        fx.position[2] + offset[2] * s,
      ];
      left = 0;
    }
    return true;
  }

  /** The hazards standing: their sounds start and stop, their modifiers near the player. */
  #watchHazards(): void {
    const runtime = this.#runtime();
    if (!runtime) return;
    const world = runtime.world;
    const standing = new Set<number>();
    const player = this.#options.player();
    for (const placed of runtime.hazards.active) {
      const reference = placed.reference;
      standing.add(reference);
      let seen = this.#hazards.get(reference);
      if (!seen) {
        seen = {
          sound: undefined,
          imageSpace: false,
          light: undefined,
          modifier: placed.hazard.imageSpaceModifier,
        };
        this.#hazards.set(reference, seen);
        const hazard = placed.hazard;
        if (hazard.sound !== undefined) seen.sound = world.playSound?.(hazard.sound, reference);
        const entry = seen;
        void this.lightRecord(hazard.light).then((record) => {
          entry.light = record;
        });
      }
      const modifier = placed.hazard.imageSpaceModifier;
      if (modifier === undefined || !player) continue;
      const at = world.livePlacement?.(reference)?.position;
      const near =
        at !== undefined &&
        Math.hypot(at[0] - player[0], at[1] - player[1], at[2] - player[2]) <=
          placed.hazard.imageSpaceRadius * 21.333;
      if (near !== seen.imageSpace) {
        seen.imageSpace = near;
        world.imageSpace?.(
          modifier,
          near ? 'apply' : 'remove',
          1,
          undefined,
          near ? reference : undefined,
        );
      }
    }
    for (const [reference, seen] of [...this.#hazards]) {
      if (standing.has(reference)) continue;
      this.#hazards.delete(reference);
      if (seen.sound !== undefined && seen.sound !== 0) world.stopSound?.(seen.sound);
      if (seen.imageSpace && seen.modifier !== undefined)
        world.imageSpace?.(seen.modifier, 'remove', 0);
    }
  }

  /** The lights of what shows now (and of the hazards standing). */
  lights(): CellLight[] {
    const lights: CellLight[] = [];
    for (const fx of this.#fx) {
      const light = fx.light;
      if (!light) continue;
      const share = fx.fades && fx.duration ? Math.max(0, 1 - fx.age / fx.duration) : 1;
      if (share <= 0) continue;
      lights.push(cellLight(0, fx.position, light, share));
    }
    const runtime = this.#runtime();
    for (const [reference, seen] of this.#hazards) {
      const at = seen.light && runtime?.world.livePlacement?.(reference)?.position;
      if (seen.light && at)
        lights.push(cellLight(reference, [at[0], at[1], at[2] + 32], seen.light, 1));
    }
    return lights;
  }

  *scenes(): Iterable<GpuScene> {
    for (const fx of this.#fx) if (fx.scene) yield fx.scene;
  }

  /** How many effects show now. */
  get size(): number {
    return this.#fx.size;
  }

  /** What shows now (the QA monitors): each effect's kind, model and place. */
  *shown(): Iterable<{ readonly kind: FxKind; readonly model: string | undefined; at: Vec3 }> {
    for (const fx of this.#fx) yield { kind: fx.kind, model: fx.model, at: fx.position };
  }

  clear(): void {
    for (const fx of [...this.#fx]) this.#end(fx);
    this.#trails.clear();
    const world = this.#runtime()?.world;
    for (const seen of this.#hazards.values())
      if (seen.sound !== undefined && seen.sound !== 0) world?.stopSound?.(seen.sound);
    this.#hazards.clear();
  }
}

/**
 * The world matrix of a model aimed along `direction` (a unit vector) from `origin`: its Y axis
 * along it, turned about the world's up axis and then tilted, its X axis level (a projectile's,
 * a beam's, an effect's facing). A reference rotation [−pitch, 0, yaw] would tilt about the
 * world's X axis instead, which loses the pitch of anything not facing north or south.
 */
export function alongMatrix(origin: Vec3, direction: Vec3): Float32Array {
  const [dx, dy, dz] = direction;
  const flat = Math.hypot(dx, dy);
  // X: level, to the right of the direction (straight up or down: the world's X).
  const x: Vec3 = flat > 1e-6 ? [dy / flat, -dx / flat, 0] : [1, 0, 0];
  // Z = X × Y.
  const z: Vec3 = [x[1] * dz - x[2] * dy, x[2] * dx - x[0] * dz, x[0] * dy - x[1] * dx];
  return new Float32Array([
    x[0],
    x[1],
    x[2],
    0,
    dx,
    dy,
    dz,
    0,
    z[0],
    z[1],
    z[2],
    0,
    origin[0],
    origin[1],
    origin[2],
    1,
  ]);
}

/** A light record as a CellLight at a point, at a share of its brightness. */
export function cellLight(
  reference: number,
  at: Vec3,
  light: LightRecord,
  share: number,
): CellLight {
  return {
    reference,
    position: [at[0], at[1], at[2]],
    radius: light.radius,
    color: light.color,
    fade: light.fade * share,
    flags: light.flags,
    period: light.period,
    intensityAmplitude: light.intensityAmplitude,
    movementAmplitude: light.movementAmplitude,
  };
}

/**
 * How long an effect model plays (seconds): its controllers' longest run, its particles'
 * longest life past it; DEFAULT_SECONDS when it has neither, at most MAX_SECONDS. TODO(M13):
 * the engine ends an explosion's model as its controllers end; its particles live out here.
 */
export function modelSeconds(model: GpuModel): number {
  let seconds = 0;
  for (const track of model.animation?.tracks ?? []) {
    const timing = track.timing;
    const run = (timing.stop - timing.start) / Math.max(timing.frequency, 1e-6);
    if (Number.isFinite(run)) seconds = Math.max(seconds, run);
  }
  let life = 0;
  for (const system of model.particles)
    for (const emitter of system.data.emitters)
      life = Math.max(life, emitter.lifeSpan + emitter.lifeSpanVariation);
  const total = seconds + life;
  return total > 0 ? Math.min(MAX_SECONDS, Math.max(0.5, total)) : DEFAULT_SECONDS;
}
