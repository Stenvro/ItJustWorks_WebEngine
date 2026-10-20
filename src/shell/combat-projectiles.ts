// Arrows and bolts in flight (docs/ai.md, "Combat"; src/gameplay/combat/projectile.ts): loosed
// at the bow's arrowRelease, drawn as the projectile's model (PROJ MODL: the arrow and its
// tracer) along its flight, falling under the PROJ's gravity, until they meet the world or an
// actor (what L_PROJECTILE collides with: the actors' bodies on BIPED; the player's character
// controller) or have flown their range. An actor hit takes the shot's damage (the combat's
// hit); iArrowInventoryChance % of the arrows go into its inventory. One that hits the world
// sticks fCombatMissileStickDepth deep where it hit: an arrow lying there to pick up (a
// reference of the ammunition, kept still), at most 15 of them (the oldest goes).

import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import type { Renderer } from '../render/renderer.ts';
import type { GpuModel, GpuScene, InstanceMotion } from '../render/scene-renderer.ts';
import type { Vec3 } from '../render/math.ts';
import {
  fly,
  launch,
  MAX_STUCK_ARROWS,
  pointing,
  spent,
  WORLD_GRAVITY,
  type Flight,
} from '../gameplay/combat/projectile.ts';
import type { ProjectileCombat } from '../gameplay/combat/combat-records.ts';
import { meshPath } from '../world/actors.ts';
import type { GameSession } from './game-session.ts';

/** A shot on its way. */
interface Shot {
  readonly shooter: number;
  readonly ammo: number;
  readonly projectile: ProjectileCombat;
  readonly flight: Flight;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  scene: GpuScene | undefined;
  /** Whatever the shot carries for its hit (its damage, its draw). */
  readonly payload: unknown;
}

/** An actor a shot may hit (the player's shape is tested apart: it has no bodies). */
export interface ShotTarget {
  readonly reference: number;
  readonly feet: Vec3;
  readonly radius: number;
  readonly height: number;
}

export interface ProjectileOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  /** A shot hit an actor at a point (its hit is the combat's). */
  readonly onActorHit: (shot: {
    readonly shooter: number;
    readonly target: number;
    readonly ammo: number;
    readonly point: Vec3;
    readonly direction: Vec3;
    readonly payload: unknown;
  }) => void;
  /** A shot hit the world: its impact (material: the collision id). */
  readonly onWorldHit: (point: Vec3, direction: Vec3, material: number, ammo: number) => void;
  /** fCombatMissileStickDepth: how deep an arrow sticks (game units). */
  readonly stickDepth: () => number;
  /** Shapes tested as such (the player), with their reference. */
  readonly shapes: () => Iterable<ShotTarget>;
}

/** Steps a frame is cut into, at most this long (seconds). */
const STEP = 1 / 60;
/** A shot does not hit its shooter (its own bodies around the bow) in its first this many units. */
const OWN_REACH = 64;

export class CombatProjectiles {
  readonly #options: ProjectileOptions;
  readonly #shots: Shot[] = [];
  /** The arrows lying where they hit (references made for them), oldest first. */
  readonly #stuck: number[] = [];
  readonly #models = new Map<string, Promise<GpuModel | undefined>>();

  constructor(options: ProjectileOptions) {
    this.#options = options;
  }

  /** The shots' scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const shot of this.#shots) if (shot.scene) yield shot.scene;
  }

  /** Looses a shot from a point along an aim (unit), at its projectile's speed × the draw. */
  async loose(shot: {
    readonly shooter: number;
    readonly ammo: number;
    readonly projectile: ProjectileCombat;
    readonly from: Vec3;
    readonly aim: Vec3;
    readonly power: number;
    readonly payload: unknown;
  }): Promise<void> {
    const flight = launch(shot.from, shot.aim, shot.projectile.speed, shot.power);
    const entry: Shot = {
      shooter: shot.shooter,
      ammo: shot.ammo,
      projectile: shot.projectile,
      flight,
      world: new Float32Array(16),
      motion: { version: 0 },
      scene: undefined,
      payload: shot.payload,
    };
    place(entry);
    this.#shots.push(entry);
    const path = shot.projectile.model;
    const model = path === undefined ? undefined : await this.#model(meshPath(path));
    if (model && this.#shots.includes(entry)) {
      entry.scene = this.#options.renderer.scene.createScene([
        { model, world: entry.world, motion: entry.motion },
      ]);
    }
  }

  #model(path: string): Promise<GpuModel | undefined> {
    let entry = this.#models.get(path);
    if (!entry) {
      const session = this.#options.session;
      entry = session.vfs.has(path) ? session.model(path) : Promise.resolve(undefined);
      this.#models.set(path, entry);
    }
    return entry;
  }

  /** A frame: every shot flies on and meets what it meets. */
  frame(seconds: number, physics: PhysicsWorld | undefined): void {
    if (seconds <= 0) return;
    for (const shot of [...this.#shots]) {
      let left = seconds;
      while (left > 0) {
        const dt = Math.min(STEP, left);
        left -= dt;
        const { from, to } = fly(shot.flight, dt, shot.projectile.gravity * WORLD_GRAVITY);
        if (this.#meets(shot, from, to, physics)) {
          this.#end(shot);
          break;
        }
        if (spent(shot.flight, shot.projectile.range, shot.projectile.lifetime)) {
          this.#end(shot);
          break;
        }
      }
      place(shot);
    }
  }

  /** What a shot meets between two points: an actor's body, a shape, or the world. */
  #meets(shot: Shot, from: Vec3, to: Vec3, physics: PhysicsWorld | undefined): boolean {
    const way: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = Math.hypot(way[0], way[1], way[2]);
    if (length < 1e-6) return false;
    const direction: Vec3 = [way[0] / length, way[1] / length, way[2] / length];
    // The shapes (the player's controller), as cylinders.
    for (const shape of this.#options.shapes()) {
      if (shape.reference === shot.shooter) continue;
      const along = segmentCylinder(from, direction, length, shape);
      if (along === undefined) continue;
      this.#actorHit(shot, shape.reference, along, from, direction);
      return true;
    }
    if (!physics?.queriesCurrent) return false;
    const hit = physics.raycast(from, direction, length, Layer.projectile);
    if (!hit) return false;
    const owner = hit.owner;
    if (owner?.kind === 'actor') {
      if (owner.reference === shot.shooter && shot.flight.distance < OWN_REACH) return false;
      this.#actorHit(shot, owner.reference, hit.distance, from, direction);
      return true;
    }
    this.#options.onWorldHit(hit.point, direction, hit.material, shot.ammo);
    void this.#stick(shot, hit.point, direction);
    return true;
  }

  #actorHit(shot: Shot, target: number, along: number, from: Vec3, direction: Vec3): void {
    this.#options.onActorHit({
      shooter: shot.shooter,
      target,
      ammo: shot.ammo,
      point: [
        from[0] + direction[0] * along,
        from[1] + direction[1] * along,
        from[2] + direction[2] * along,
      ],
      direction,
      payload: shot.payload,
    });
  }

  /** The arrow lies where it hit, fCombatMissileStickDepth into it: a reference to pick up. */
  async #stick(shot: Shot, point: Vec3, direction: Vec3): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const depth = this.#options.stickDepth();
    const at: [number, number, number] = [
      point[0] - direction[0] * depth * 0.5,
      point[1] - direction[1] * depth * 0.5,
      point[2] - direction[2] * depth * 0.5,
    ];
    const shooter = await runtime.placement(shot.shooter);
    const { heading, pitch } = pointing(direction);
    const reference = runtime.state.create(shot.ammo);
    const state = runtime.state.reference(reference);
    state.position = at;
    // The arrow model lies along +Y: turned to the flight's heading, pitched along it.
    state.rotation = [-pitch, 0, heading];
    state.motionType = 4;
    if (shooter?.cell !== undefined) state.cell = shooter.cell;
    if (shooter?.world !== undefined) state.world = shooter.world;
    runtime.world.created?.(reference);
    this.#stuck.push(reference);
    while (this.#stuck.length > MAX_STUCK_ARROWS) {
      const oldest = this.#stuck.shift();
      if (oldest === undefined) break;
      runtime.state.reference(oldest).deleted = true;
      runtime.world.enableChanged?.(oldest, false);
    }
  }

  #end(shot: Shot): void {
    const index = this.#shots.indexOf(shot);
    if (index >= 0) this.#shots.splice(index, 1);
    shot.scene?.destroy();
    shot.scene = undefined;
  }

  clear(): void {
    for (const shot of [...this.#shots]) this.#end(shot);
  }
}

/** A shot's model along its flight (its +Y forward). */
function place(shot: Shot): void {
  const { heading, pitch } = pointing(shot.flight.velocity);
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Columns: right, forward, up.
  const forward = [sh * cp, ch * cp, sp];
  const right = [ch, -sh, 0];
  const up = [-sh * sp, -ch * sp, cp];
  const [x, y, z] = shot.flight.position;
  shot.world.set([
    right[0] ?? 0,
    right[1] ?? 0,
    right[2] ?? 0,
    0,
    forward[0] ?? 0,
    forward[1] ?? 0,
    forward[2] ?? 0,
    0,
    up[0] ?? 0,
    up[1] ?? 0,
    up[2] ?? 0,
    0,
    x,
    y,
    z,
    1,
  ]);
  shot.motion.version++;
}

/** Where along a segment (0..length) it enters an upright cylinder, or undefined. */
function segmentCylinder(
  from: Vec3,
  direction: Vec3,
  length: number,
  shape: ShotTarget,
): number | undefined {
  const ox = from[0] - shape.feet[0];
  const oy = from[1] - shape.feet[1];
  const a = direction[0] * direction[0] + direction[1] * direction[1];
  const b = 2 * (ox * direction[0] + oy * direction[1]);
  const c = ox * ox + oy * oy - shape.radius * shape.radius;
  let enter = 0;
  if (c > 0) {
    if (a < 1e-9) return undefined;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return undefined;
    enter = (-b - Math.sqrt(disc)) / (2 * a);
  }
  if (enter < 0 || enter > length) return undefined;
  const z = from[2] + direction[2] * enter;
  return z >= shape.feet[2] && z <= shape.feet[2] + shape.height ? enter : undefined;
}
