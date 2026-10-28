// Arrows and bolts in flight (docs/ai.md, "Combat"; src/gameplay/combat/projectile.ts): loosed
// at the bow's arrowRelease, drawn as the projectile's model (PROJ MODL: the arrow and its
// tracer) along its flight, falling under the PROJ's gravity, until they meet the world or an
// actor (what L_PROJECTILE collides with: the actors' bodies on BIPED; the player's character
// controller) or have flown their range. An actor hit takes the shot's damage (the combat's
// hit); iArrowInventoryChance % of the arrows go into its inventory. One that hits the world
// sticks fCombatMissileStickDepth deep where it hit if the surface's material lets arrows stick
// (MATT "Arrows Stick": wood, earth, snow, cloth, flesh; not stone, metal or glass), else it
// drops there: either way an arrow lying there to pick up (a reference of the ammunition), at
// most 15 of them (the oldest goes). One that hits an actor stays stuck in its body (the
// engine's ExtraAttachedArrows3D: drawn only, no reference): its model where it struck, as deep
// as one in the world, on the body's node nearest the hit and moving with it, for
// fAttachedArrowAgeMax seconds, at most iMaxAttachedArrows in one actor (the oldest goes);
// Actor.ClearExtraArrows takes an actor's away at once (clearAttached).

import { Layer } from '../physics/collision-layers.ts';
import type { PhysicsWorld } from '../physics/physics-world.ts';
import { invert } from '../render/frustum.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { GpuModel, GpuScene, InstanceMotion } from '../render/scene-renderer.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import { nearestNode, type BleedingBody } from './combat-impacts.ts';
import {
  expiredArrows,
  fly,
  homeOn,
  launch,
  MAX_STUCK_ARROWS,
  pointing,
  spent,
  WORLD_GRAVITY,
  type Flight,
} from '../gameplay/combat/projectile.ts';
import type { ProjectileCombat } from '../gameplay/combat/combat-records.ts';
import { arrowKnock, loadImpulseSettings } from '../gameplay/impulses.ts';
import { meshPath } from '../world/actors.ts';
import { MaterialFlag } from '../world/material-type.ts';
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
  /** Its model, once loaded (an arrow stuck in an actor draws it too). */
  model: GpuModel | undefined;
  /** Whatever the shot carries for its hit (its damage, its draw). */
  readonly payload: unknown;
  /** An Always Hit shot's target point now (it flies onto it), while there is one. */
  readonly homing: (() => Vec3 | undefined) | undefined;
}

/** An arrow stuck in an actor's body, kept on the node nearest where it struck. */
interface StuckInActor {
  readonly target: number;
  readonly until: number;
  readonly node: number;
  /** Its place in the node's space. */
  readonly local: Mat4;
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  readonly scene: GpuScene;
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
  readonly renderer: RenderPort;
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
  /** A shot met a surface; `reference`: the object it belongs to (0 or none: the land). */
  readonly onWorldHit: (
    point: Vec3,
    direction: Vec3,
    material: number,
    ammo: number,
    reference: number | undefined,
    payload: unknown,
  ) => void;
  /** fCombatMissileStickDepth: how deep an arrow sticks (game units). */
  readonly stickDepth: () => number;
  /** An actor's posed body now (an arrow stuck in it follows its nodes), if it has one shown. */
  readonly body?: (reference: number) => BleedingBody | undefined;
  /** fAttachedArrowAgeMax (seconds) and iMaxAttachedArrows: arrows stuck in actors. */
  readonly attachedArrows?: () => { readonly ageMax: number; readonly max: number };
  /** Shapes tested as such (the player), with their reference. */
  readonly shapes: () => Iterable<ShotTarget>;
}

/** Steps a frame is cut into, at most this long (seconds). */
const STEP = 1 / 60;
/** An arrow that does not stick is laid this far back out of what it hit (units). */
const BOUNCE_CLEARANCE = 8;
/** A shot does not hit its shooter (its own bodies around the bow) in its first this many units. */
const OWN_REACH = 64;

export class CombatProjectiles {
  readonly #options: ProjectileOptions;
  readonly #shots: Shot[] = [];
  /** The arrows lying where they hit (references made for them), oldest first. */
  readonly #stuck: number[] = [];
  /** The arrows stuck in actors, oldest first. */
  #attached: StuckInActor[] = [];
  /** Seconds of frames so far (when stuck arrows go). */
  #clock = 0;
  readonly #models = new Map<string, Promise<GpuModel | undefined>>();
  /** The gameplay impulses' settings (src/gameplay/impulses.ts), once read. */
  readonly #impulses: ReturnType<typeof loadImpulseSettings>;

  constructor(options: ProjectileOptions) {
    this.#options = options;
    this.#impulses = loadImpulseSettings(() => options.session.settings());
  }

  /** The shots' scenes. */
  *scenes(): Iterable<GpuScene> {
    for (const shot of this.#shots) if (shot.scene) yield shot.scene;
    for (const arrow of this.#attached) yield arrow.scene;
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
    /** Always Hit: where its target is now (the shot flies onto it). */
    readonly homing?: () => Vec3 | undefined;
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
      model: undefined,
      payload: shot.payload,
      homing: shot.homing,
    };
    place(entry);
    this.#shots.push(entry);
    const path = shot.projectile.model;
    const model = path === undefined ? undefined : await this.#model(meshPath(path));
    if (model && this.#shots.includes(entry)) {
      entry.model = model;
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
  /** The shots in flight (each the same `key` from frame to frame): who dodges them. */
  *flying(): Iterable<{
    readonly key: object;
    readonly shooter: number;
    readonly position: Vec3;
    readonly velocity: Vec3;
  }> {
    for (const shot of this.#shots) {
      yield {
        key: shot,
        shooter: shot.shooter,
        position: shot.flight.position,
        velocity: shot.flight.velocity,
      };
    }
  }

  frame(seconds: number, physics: PhysicsWorld | undefined): void {
    if (seconds <= 0) return;
    this.#clock += seconds;
    this.#follow();
    for (const shot of [...this.#shots]) {
      let left = seconds;
      while (left > 0) {
        const dt = Math.min(STEP, left);
        left -= dt;
        const target = shot.homing?.();
        if (target) homeOn(shot.flight, target);
        const gravity = target ? 0 : shot.projectile.gravity * WORLD_GRAVITY;
        const { from, to } = fly(shot.flight, dt, gravity);
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
    const own = owner?.kind === 'actor' && owner.reference === shot.shooter;
    if (own && shot.flight.distance < OWN_REACH) return false;
    // It knocks the moving body it met (clutter, a corpse's ragdoll) by its speed.
    const v = shot.flight.velocity;
    const speed = Math.hypot(v[0], v[1], v[2]);
    physics.knock(hit.collider, hit.point, direction, (layer, mass) =>
      arrowKnock(speed, layer, mass, this.#impulses.current),
    );
    if (owner?.kind === 'actor') {
      this.#actorHit(shot, owner.reference, hit.distance, from, direction);
      return true;
    }
    this.#options.onWorldHit(
      hit.point,
      direction,
      hit.material,
      shot.ammo,
      owner?.kind === 'object' && owner.reference !== 0 ? owner.reference : undefined,
      shot.payload,
    );
    void this.#stick(shot, hit.point, direction, hit.material);
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
    this.#attach(shot, target, from, direction, along);
  }

  /** The arrow stays stuck in the actor it hit, on the body's node nearest the hit. */
  #attach(shot: Shot, target: number, from: Vec3, direction: Vec3, along: number): void {
    const body = this.#options.body?.(target);
    const limits = this.#options.attachedArrows?.();
    if (!shot.model || !body || !limits || limits.max <= 0) return;
    const point: Vec3 = [
      from[0] + direction[0] * along,
      from[1] + direction[1] * along,
      from[2] + direction[2] * along,
    ];
    const node = nearestNode(body, point);
    const nodeWorld = attachedNode(body, node);
    const inverse = nodeWorld && invert(nodeWorld);
    if (!inverse) return;
    // As deep as one stuck in the world (#stick), along its flight.
    const depth = this.#options.stickDepth() * 0.5;
    const at = new Float32Array(16);
    orient(at, direction, [
      point[0] - direction[0] * depth,
      point[1] - direction[1] * depth,
      point[2] - direction[2] * depth,
    ]);
    const world = new Float32Array(at);
    const motion: InstanceMotion = { version: 0 };
    const scene = this.#options.renderer.scene.createScene([{ model: shot.model, world, motion }]);
    if (!scene) return;
    this.#attached.push({
      target,
      until: this.#clock + limits.ageMax,
      node,
      local: multiply(inverse, at),
      world,
      motion,
      scene,
    });
    this.#follow();
  }

  /** The arrows stuck in actors follow their nodes; the old, the extra and the orphaned go. */
  #follow(): void {
    if (this.#attached.length === 0) return;
    const limits = this.#options.attachedArrows?.() ?? { ageMax: 0, max: 0 };
    const gone = new Set(
      expiredArrows(this.#attached, this.#clock, limits.max, (target) =>
        Boolean(this.#options.body?.(target)),
      ),
    );
    for (const arrow of gone) arrow.scene.destroy();
    if (gone.size > 0) this.#attached = this.#attached.filter((arrow) => !gone.has(arrow));
    for (const arrow of this.#attached) {
      const body = this.#options.body?.(arrow.target);
      const nodeWorld = body && attachedNode(body, arrow.node);
      if (!nodeWorld) continue;
      arrow.world.set(multiply(nodeWorld, arrow.local));
      arrow.motion.version++;
    }
  }

  /** Actor.ClearExtraArrows: the arrows stuck in an actor go (every actor's, without one). */
  clearAttached(target?: number): void {
    for (const arrow of this.#attached)
      if (target === undefined || arrow.target === target) arrow.scene.destroy();
    this.#attached =
      target === undefined ? [] : this.#attached.filter((arrow) => arrow.target !== target);
  }

  /**
   * The arrow lies where it hit: fCombatMissileStickDepth into it, held still, where its material
   * (a collision material id) lets arrows stick (a material that is no material type does), else
   * just out of it, falling (TODO(M13): the bounce, fArrowBounce*): a reference to pick up.
   */
  async #stick(shot: Shot, point: Vec3, direction: Vec3, material: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime) return;
    const flags = (await this.#options.session.playerData()).materialFlags.get(material);
    const sticks = flags === undefined || (flags & MaterialFlag.arrowsStick) !== 0;
    const depth = sticks ? this.#options.stickDepth() : -2 * BOUNCE_CLEARANCE;
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
    // Stuck it is held (keyframed); not, it falls (dynamic).
    state.motionType = sticks ? 4 : 1;
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
    this.clearAttached();
  }
}

/** A shot's model along its flight (its +Y forward). */
function place(shot: Shot): void {
  orient(shot.world, shot.flight.velocity, shot.flight.position);
  shot.motion.version++;
}

/** A body's node in the world (its pose's node in its model's world), if it has that node. */
function attachedNode(body: BleedingBody, node: number): Mat4 | undefined {
  if (node < 0 || node * 16 + 16 > body.pose.worlds.length) return undefined;
  return multiply(body.world, body.pose.worlds.subarray(node * 16, node * 16 + 16));
}

/** An arrow's model at a point, its +Y along a direction. */
function orient(out: Float32Array, direction: Vec3, position: Vec3): void {
  const { heading, pitch } = pointing(direction);
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Columns: right, forward, up.
  const forward = [sh * cp, ch * cp, sp];
  const right = [ch, -sh, 0];
  const up = [-sh * sp, -ch * sp, cp];
  const [x, y, z] = position;
  out.set([
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
