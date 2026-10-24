// What a beam projectile shows (BeamProjectile: Sparks, Lightning Bolt, Chain Lightning's jumps,
// Thunderbolt, the staffs' and traps' bolts; docs/gameplay.md, "A hand's cast"): its model
// (PROJ MODL) from where it leaves to where it met something, observed in the original.
// The model is drawn from the caster's hand along the aim, its own behavior graph playing (its
// idle sequence drives the bolts' generation, mutation and arc), its shapes stretched along
// their Y axis by the beam's length over the model's BeamEnd distance (512 units in the vanilla
// bolts): the procedural lightning keeps its zigzag across while it reaches the hit. While it
// lives the beam stays at the hand that cast it; then it fades over the projectile's fade
// duration. Its light (PROJ light) shines at the model's AttachLight node.
// TODO(M13): the engine stretches every shape of a beam model so; here only the procedural
// lightning is (the meshed beams, Staff of Magnus' and Auriel's Bow's, keep their own length,
// and they do not fade).

import type { Vec3 } from '../render/math.ts';
import { LightningSimulation } from '../render/lightning.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { GpuScene, InstanceMotion, ModelInstance } from '../render/scene-renderer.ts';
import type { ObjectGraph } from '../animation/object-graph.ts';
import { meshPath } from '../world/actors.ts';
import type { CellLight } from '../world/cell-loader.ts';
import type { LightRecord } from '../world/cell-records.ts';
import type { ProjectileRecord } from '../world/projectile-data.ts';
import type { GameSession } from './game-session.ts';
import { alongMatrix, cellLight, type MagicFx } from './magic-fx.ts';
import { startObjectGraph } from './object-graphs.ts';
import type { Terminal } from './terminal.ts';

/** The length a beam model is built at when it has no BeamEnd node (the vanilla bolts'). */
const DEFAULT_BEAM_END = 512;
/** Where the light shines along a beam whose model has no AttachLight node (units). */
const DEFAULT_LIGHT_AT = 200;

export interface MagicBeamsOptions {
  readonly session: GameSession;
  readonly renderer: RenderPort;
  readonly terminal: Terminal;
  readonly fx?: MagicFx;
}

interface Beam {
  readonly projectile: ProjectileRecord;
  origin: Vec3;
  /** Unit vector along the beam. */
  readonly direction: Vec3;
  /** From the hand to what it met (or its range). */
  readonly length: number;
  /** Where the hand that cast it is now (undefined: it stays where it left). */
  readonly follow: (() => Vec3 | undefined) | undefined;
  /** The model's BeamEnd distance and AttachLight place (once loaded). */
  beamEnd: number;
  lightAt: number;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  instance: ModelInstance | undefined;
  scene: GpuScene | undefined;
  graph: ObjectGraph | undefined;
  light: LightRecord | undefined;
  age: number;
  /** Seconds it shows whole, then seconds it fades. */
  readonly life: number;
  readonly fade: number;
  done: boolean;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

let seeds = 1;

export class MagicBeams {
  readonly #options: MagicBeamsOptions;
  readonly #beams = new Set<Beam>();

  constructor(options: MagicBeamsOptions) {
    this.#options = options;
  }

  /**
   * A beam from `origin` along `direction` (a unit vector), `length` units to what it met.
   * `follow`: where the casting hand is now (the beam stays on it while it shows).
   */
  show(
    projectile: ProjectileRecord,
    origin: Vec3,
    direction: Vec3,
    length: number,
    follow?: () => Vec3 | undefined,
  ): void {
    // It shows for its lifetime, at least until a held beam's next relaunch (a concentration
    // spell's beam is cast anew every relaunch interval), then fades over its fade duration.
    // TODO(M13): how the engine times a beam's fade; the lifetime and fade duration are read as
    // seconds shown and seconds fading.
    const beam: Beam = {
      projectile,
      origin: [...origin],
      direction,
      length: Math.max(1, length),
      follow,
      beamEnd: DEFAULT_BEAM_END,
      lightAt: DEFAULT_LIGHT_AT,
      world: new Float32Array(16),
      motion: { version: 0 },
      instance: undefined,
      scene: undefined,
      graph: undefined,
      light: undefined,
      age: 0,
      life: Math.max(projectile.lifetime, projectile.relaunchInterval, 0.05),
      fade: Math.max(0, projectile.fadeDuration),
      done: false,
    };
    this.#place(beam);
    this.#beams.add(beam);
    void this.#options.fx?.lightRecord(projectile.light).then((light) => {
      beam.light = light;
    });
    if (projectile.model) this.#load(beam, projectile.model);
  }

  #load(beam: Beam, path: string): void {
    const { session, renderer, terminal } = this.#options;
    session
      .model(meshPath(path))
      .then((model) => {
        if (!model || beam.done) return;
        const end = model.nodeWorlds.get('beamend');
        const endY = end ? (end[13] ?? 0) : 0;
        if (endY > 0) beam.beamEnd = endY;
        const attach = model.nodeWorlds.get('attachlight');
        if (attach) beam.lightAt = attach[13] ?? DEFAULT_LIGHT_AT;
        // Its graph plays its idle sequence (the bolts' generation, mutation and arc).
        const seed = seeds++;
        beam.graph = startObjectGraph(model, seed);
        const options = {
          stretch: () => beam.length / beam.beamEnd,
          opacity: () => this.#opacity(beam),
        };
        const instance: ModelInstance = {
          model,
          world: beam.world,
          motion: beam.motion,
          ...(beam.graph && { graph: beam.graph }),
          particleSource: (system) =>
            system.lightning ? new LightningSimulation(system, seed, options) : undefined,
        };
        beam.instance = instance;
        beam.scene = renderer.scene.createScene([instance]);
      })
      .catch((error: unknown) => {
        terminal.log('magic', `${path}: ${describe(error)}`, 'warn');
      });
  }

  /** How opaque a beam is now: whole while it lives, then fading. */
  #opacity(beam: Beam): number {
    if (beam.age <= beam.life) return 1;
    return beam.fade > 0 ? Math.max(0, 1 - (beam.age - beam.life) / beam.fade) : 0;
  }

  /** At the hand, along the beam (the model's Y axis forward, its Z axis as near up as it goes). */
  #place(beam: Beam): void {
    beam.world.set(alongMatrix(beam.origin, beam.direction));
    beam.motion.version++;
  }

  /** Every frame: the beams follow their hands, fade and go. */
  frame(seconds: number): void {
    for (const beam of [...this.#beams]) {
      beam.age += seconds;
      if (beam.age >= beam.life + beam.fade) {
        this.#end(beam);
        continue;
      }
      const at = beam.follow?.();
      if (
        at &&
        (at[0] !== beam.origin[0] || at[1] !== beam.origin[1] || at[2] !== beam.origin[2])
      ) {
        beam.origin = [...at];
        this.#place(beam);
      }
    }
  }

  *scenes(): Iterable<GpuScene> {
    for (const beam of this.#beams) if (beam.scene) yield beam.scene;
  }

  /** Their lights (at the AttachLight node, within the beam), fading with them. */
  *lights(): Iterable<CellLight> {
    for (const beam of this.#beams) {
      const light = beam.light;
      if (!light) continue;
      const along = Math.min(beam.lightAt, beam.length);
      const at: Vec3 = [
        beam.origin[0] + beam.direction[0] * along,
        beam.origin[1] + beam.direction[1] * along,
        beam.origin[2] + beam.direction[2] * along,
      ];
      yield cellLight(0, at, light, this.#opacity(beam));
    }
  }

  #end(beam: Beam): void {
    beam.done = true;
    this.#beams.delete(beam);
    beam.scene?.destroy();
    beam.scene = undefined;
  }

  clear(): void {
    for (const beam of [...this.#beams]) this.#end(beam);
  }
}
