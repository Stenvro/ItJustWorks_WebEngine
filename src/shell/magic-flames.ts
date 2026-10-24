// What a flame projectile shows (FlameProjectile: Flames, Fire Breath and Frost Breath, the
// flame traps and staffs; docs/gameplay.md, "A hand's cast"): a concentration spell or a breath
// sprays a flame projectile every relaunch interval, and each spray flies on its own to what it
// meets (src/shell/magic-projectiles.ts), but what is seen is one stream: the projectile's model
// (PROJ MODL: FireSprayFX01, MAGdragonFire01) at the hand or mouth that casts, along the aim,
// its particles leaving it as it follows the caster, its own behavior graph playing. The models
// are built so: their emitters throw their particles out at several times the projectile's
// speed from a fixed node, and FireSprayFX01's graph (Magic\SprayRange.hkx) blends its long
// and short spray by fFlameProjectileLength, the share of its range the flame reaches before it
// meets something (a variable the engine sets on the flame's 3D: CommonLibSSE's FixedStrings
// name it). A stream goes once its sprays stop for two relaunch intervals. Its light (PROJ light)
// shines halfway along the reach.
// TODO(M13): observed in the original how the engine keeps a flame's 3D (one per relaunch at the hand, or
// one per cast) and when it lets it go; one per caster and projectile here, as it looks.

import type { ObjectGraph } from '../animation/object-graph.ts';
import type { Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import { meshPath } from '../world/actors.ts';
import type { CellLight } from '../world/cell-loader.ts';
import type { LightRecord } from '../world/cell-records.ts';
import type { ProjectileRecord } from '../world/projectile-data.ts';
import type { GameSession } from './game-session.ts';
import { alongMatrix, cellLight, type MagicFx } from './magic-fx.ts';
import { startObjectGraph } from './object-graphs.ts';
import type { Terminal } from './terminal.ts';

/** The graph variable a flame's 3D reads its reach from (0: at the hand, 1: its full range). */
const FLAME_LENGTH = 'fFlameProjectileLength';
/** A stream outlives its last spray by this many relaunch intervals. */
const INTERVALS_KEPT = 2;
/** ... and at least this long (seconds: a slow relaunch interval of 0). */
const MIN_KEPT = 0.2;

export interface MagicFlamesOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  readonly fx?: MagicFx;
}

/** One caster's flame stream of one projectile. */
export interface FlameStream {
  readonly projectile: ProjectileRecord;
  origin: Vec3;
  /** Unit vector along the aim. */
  direction: Vec3;
  /** Where the casting hand or mouth is now (undefined: it stays where it left). */
  follow: (() => Vec3 | undefined) | undefined;
  /** Units the latest sprays reached (its range until one met something). */
  reach: number;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  instance: ModelInstance | undefined;
  scene: GpuScene | undefined;
  graph: ObjectGraph | undefined;
  light: LightRecord | undefined;
  /** Seconds since its last spray. */
  since: number;
  done: boolean;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

let seeds = 1;

export class MagicFlames {
  readonly #options: MagicFlamesOptions;
  readonly #streams = new Map<string, FlameStream>();

  constructor(options: MagicFlamesOptions) {
    this.#options = options;
  }

  /**
   * A spray leaves `origin` along `direction` (a unit vector): the caster's stream of this
   * projectile shows on (or begins), turned to the new aim. Resolves the stream (its reach is
   * set as the spray meets something: `reached`).
   */
  spray(
    caster: number,
    projectile: ProjectileRecord,
    origin: Vec3,
    direction: Vec3,
    follow?: () => Vec3 | undefined,
  ): FlameStream {
    const key = `${String(caster)}:${String(projectile.formId)}`;
    let stream = this.#streams.get(key);
    if (stream && !stream.done) {
      stream.origin = [...origin];
      stream.direction = direction;
      stream.follow = follow;
      stream.since = 0;
      this.#place(stream);
      return stream;
    }
    const range = projectile.range > 0 ? projectile.range : 1000;
    stream = {
      projectile,
      origin: [...origin],
      direction,
      follow,
      reach: range,
      world: new Float32Array(16),
      motion: { version: 0 },
      instance: undefined,
      scene: undefined,
      graph: undefined,
      light: undefined,
      since: 0,
      done: false,
    };
    this.#streams.set(key, stream);
    this.#place(stream);
    const started = stream;
    void this.#options.fx?.lightRecord(projectile.light).then((light) => {
      started.light = light;
    });
    if (projectile.model) this.#load(stream, projectile.model);
    return stream;
  }

  /** A spray of the stream met something `distance` units from the hand (its reach). */
  reached(stream: FlameStream, distance: number): void {
    const range = stream.projectile.range > 0 ? stream.projectile.range : 1000;
    stream.reach = Math.max(0, Math.min(range, distance));
    stream.graph?.setVariable(FLAME_LENGTH, stream.reach / range);
  }

  #load(stream: FlameStream, path: string): void {
    const { session, renderer, terminal } = this.#options;
    session
      .model(meshPath(path))
      .then((model) => {
        if (!model || stream.done) return;
        stream.graph = startObjectGraph(model, seeds++);
        const range = stream.projectile.range > 0 ? stream.projectile.range : 1000;
        stream.graph?.setVariable(FLAME_LENGTH, stream.reach / range);
        const instance: ModelInstance = {
          model,
          world: stream.world,
          motion: stream.motion,
          ...(stream.graph && { graph: stream.graph }),
        };
        stream.instance = instance;
        stream.scene = renderer.scene.createScene([instance]);
      })
      .catch((error: unknown) => {
        terminal.log('magic', `${path}: ${describe(error)}`, 'warn');
      });
  }

  /** At the hand, along the aim (the model's Y axis forward). */
  #place(stream: FlameStream): void {
    stream.world.set(alongMatrix(stream.origin, stream.direction));
    stream.motion.version++;
  }

  /** Every frame: the streams follow their casters; those whose sprays stopped go. */
  frame(seconds: number): void {
    for (const [key, stream] of [...this.#streams]) {
      stream.since += seconds;
      const kept = Math.max(MIN_KEPT, stream.projectile.relaunchInterval * INTERVALS_KEPT);
      if (stream.since > kept) {
        this.#end(key, stream);
        continue;
      }
      const at = stream.follow?.();
      if (
        at &&
        (at[0] !== stream.origin[0] || at[1] !== stream.origin[1] || at[2] !== stream.origin[2])
      ) {
        stream.origin = [...at];
        this.#place(stream);
      }
    }
  }

  /** How many streams show (the QA monitors). */
  get size(): number {
    return this.#streams.size;
  }

  /** What shows now (the QA monitors): each stream's projectile and place. */
  *shown(): Iterable<{ readonly projectile: string; readonly at: Vec3 }> {
    for (const stream of this.#streams.values())
      yield { projectile: stream.projectile.editorId, at: stream.origin };
  }

  *scenes(): Iterable<GpuScene> {
    for (const stream of this.#streams.values()) if (stream.scene) yield stream.scene;
  }

  /** Their lights, halfway along what they reach. */
  *lights(): Iterable<CellLight> {
    for (const stream of this.#streams.values()) {
      if (!stream.light) continue;
      const along = stream.reach / 2;
      const at: Vec3 = [
        stream.origin[0] + stream.direction[0] * along,
        stream.origin[1] + stream.direction[1] * along,
        stream.origin[2] + stream.direction[2] * along,
      ];
      yield cellLight(0, at, stream.light, 1);
    }
  }

  #end(key: string, stream: FlameStream): void {
    stream.done = true;
    this.#streams.delete(key);
    stream.scene?.destroy();
    stream.scene = undefined;
  }

  clear(): void {
    for (const [key, stream] of [...this.#streams]) this.#end(key, stream);
  }
}
