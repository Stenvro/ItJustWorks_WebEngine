// The bodies of the living actors of the loaded area (docs/m10-plan.md, 1.2 and 1.4): an actor
// near the player has its race's ragdoll (the skeleton model's bodies on the main bones,
// skeleton.nif) in the physics world, keyframed to its animated pose, on the BIPED layer:
// what hits it, picks it and sees it meets those bodies. When it dies its bodies are let go
// from where they are and its pose follows them: the dead fall as ragdolls from the pose they
// had, as the dead placed in their cells do (src/shell/actors.ts, ragdollsOf). The dead
// player's avatar gets its bodies so too (src/shell/player-death.ts). A living actor knocked
// down lies as a ragdoll the same way until it gets up (src/shell/actor-knockdowns.ts); hits
// on a ragdoll push it.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { ActorPose } from '../animation/skeleton.ts';
import { Articulation } from '../physics/articulation.ts';
import type { CollisionData } from '../physics/collision-data.ts';
import type { PhysicsWorld, PlacedBody, PlacedCollision } from '../physics/physics-world.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import { ActorPose as Pose } from '../animation/skeleton.ts';
import type { StagedActor } from './actor-stage.ts';
import type { PlacedActor } from './actors.ts';
import { HIGH_PROCESS_DISTANCE } from './actor-movers.ts';
import type { GameSession } from './game-session.ts';

/** Actors keep their bodies until this far (no churn at the edge). */
const LEAVE_DISTANCE = HIGH_PROCESS_DISTANCE * 1.25;

/**
 * An actor whose bodies are kept: one of the stage, or the dead player's avatar
 * (src/shell/player-death.ts), whose body is drawn at its own placement (`world`).
 */
export type BodyHolder = Pick<
  StagedActor,
  'reference' | 'placed' | 'position' | 'visibility' | 'dead'
> & {
  /** Where its body is drawn, if not at its first instance's placement. */
  readonly world?: Mat4;
};

/** A body on a node of the actor's pose, with its place relative to the node. */
interface PosedBody {
  readonly body: PlacedBody;
  readonly node: number;
  readonly offset: Mat4;
}

interface ActorBody {
  readonly staged: BodyHolder;
  /** The body it was made for (an actor made again in another race gets new bodies). */
  readonly actor: PlacedActor;
  readonly placed: PlacedCollision;
  readonly pose: ActorPose;
  readonly world: Mat4;
  readonly bodies: readonly PosedBody[];
  /** The pose and placement versions the bodies were last moved to. */
  poseVersion: number;
  worldVersion: number;
  /** Dead or knocked down: its bodies move it (its ragdoll). */
  articulation: Articulation | undefined;
  /** Knocked down living: its ragdoll lies until it gets up (src/shell/actor-knockdowns.ts). */
  knocked: boolean;
}

export class ActorBodies {
  readonly #session: GameSession;
  readonly #bodies = new Map<number, ActorBody>();
  readonly #adding = new Map<number, Promise<void>>();
  /** The nodes (lower-case) whose bodies are out of collision, by actor: a cut-off head's. */
  readonly #severed = new Map<number, ReadonlySet<string>>();
  #physics: PhysicsWorld | undefined;

  constructor(session: GameSession) {
    this.#session = session;
  }

  /** The physics world of the play (undefined: none; the bodies go). */
  attach(physics: PhysicsWorld | undefined): void {
    if (physics === this.#physics) return;
    for (const entry of [...this.#bodies.values()]) this.#free(entry);
    this.#physics = physics;
  }

  remove(reference: number): void {
    this.#severed.delete(reference);
    const entry = this.#bodies.get(reference);
    if (entry) this.#free(entry);
  }

  /**
   * A limb came off an actor (src/shell/actor-dismemberment.ts): the bodies of its ragdoll on the
   * limb's nodes (lower-case names) leave collision, now and in the bodies made for it later
   * (the cut piece has its own); they still hang on their joints, unseen.
   */
  sever(reference: number, nodes: ReadonlySet<string>): void {
    this.#severed.set(reference, nodes);
    const entry = this.#bodies.get(reference);
    if (entry) this.#disableSevered(entry);
  }

  #disableSevered(entry: ActorBody): void {
    const nodes = this.#severed.get(entry.staged.reference);
    const physics = this.#physics;
    if (!nodes || !physics) return;
    for (const body of entry.placed.bodies) {
      if (nodes.has(body.data.node.toLowerCase())) physics.disableBody(body);
    }
  }

  /** A living actor's bodies' colliders (none: no bodies, or dead). */
  colliders(reference: number): readonly RAPIER.Collider[] {
    const entry = this.#bodies.get(reference);
    return entry && !entry.articulation ? entry.placed.colliders : [];
  }

  /** Whether an actor's bodies are in the world (living or dead). */
  has(reference: number): boolean {
    return this.#bodies.has(reference);
  }

  /**
   * Every frame, after the physics steps and before the skeletons animate: the dead's poses go
   * where their bodies fell; living actors near `focus` get their bodies, far ones lose them,
   * and the bodies go where the last animated pose puts their nodes (in the next steps).
   */
  frame(actors: Iterable<BodyHolder>, focus: Vec3 | undefined): void {
    const physics = this.#physics;
    if (!physics) return;
    for (const staged of actors) {
      const entry = this.#bodies.get(staged.reference);
      if (entry?.articulation) {
        // A knocked-down actor's graph animated its pose meanwhile: the ragdoll's again.
        entry.articulation.update(entry.knocked);
        continue;
      }
      const distance = focus
        ? Math.hypot(staged.position[0] - focus[0], staged.position[1] - focus[1])
        : 0;
      if (!entry) {
        if (distance < HIGH_PROCESS_DISTANCE && this.#lives(staged)) void this.#add(staged);
        continue;
      }
      if (distance > LEAVE_DISTANCE || staged.visibility.hidden || staged.placed !== entry.actor) {
        this.#free(entry);
        continue;
      }
      this.#follow(entry, physics);
    }
  }

  /**
   * An actor died: its bodies are let go from where its pose has them (they fall), and its
   * pose follows them from now on. Without bodies yet (far, or just placed) they are made
   * first, in its pose now.
   */
  async kill(staged: BodyHolder): Promise<void> {
    let entry = this.#bodies.get(staged.reference);
    // Twice: bodies being made for it living as it died are not made (it no longer lives).
    for (let i = 0; i < 2 && !entry; i++) {
      await this.#add(staged, true);
      entry = this.#bodies.get(staged.reference);
    }
    const physics = this.#physics;
    if (!entry || !physics) return;
    // Knocked down as it died: it lies on as the dead do.
    entry.knocked = false;
    if (entry.articulation) return;
    physics.setMotion(entry.placed, false);
    entry.articulation = new Articulation(entry.placed, entry.pose, entry.world);
  }

  /**
   * The blow that killed an actor pushes its ragdoll (src/shell/actor-combat.ts: fDeathForce*),
   * once its bodies are let go (kill).
   */
  async push(staged: BodyHolder, direction: Vec3, magnitude: number): Promise<void> {
    await this.kill(staged);
    const entry = this.#bodies.get(staged.reference);
    if (entry?.articulation) this.#physics?.impulse(entry.placed, direction, magnitude);
  }

  /**
   * A living actor knocked down (src/shell/actor-knockdowns.ts): its bodies are let go from
   * where its pose has them, as a death's are, and its pose follows them until it gets up
   * (standUp). Whether it lies as a ragdoll now (false: no bodies for it, no physics).
   */
  async knockDown(staged: BodyHolder): Promise<boolean> {
    let entry = this.#bodies.get(staged.reference);
    for (let i = 0; i < 2 && !entry; i++) {
      await this.#add(staged, true);
      entry = this.#bodies.get(staged.reference);
    }
    const physics = this.#physics;
    if (!entry || !physics || staged.dead) return false;
    if (entry.articulation) return entry.knocked;
    physics.setMotion(entry.placed, false);
    entry.articulation = new Articulation(entry.placed, entry.pose, entry.world);
    entry.knocked = true;
    return true;
  }

  /** Whether an actor lies knocked down as a ragdoll. */
  knocked(reference: number): boolean {
    return this.#bodies.get(reference)?.knocked === true;
  }

  /**
   * Whether a knocked-down actor's ragdoll has come to rest: every body sleeps or moves slower
   * than `speed` (units a second). True without one.
   */
  resting(reference: number, speed: number): boolean {
    const entry = this.#bodies.get(reference);
    return entry?.articulation?.resting(speed) ?? true;
  }

  /**
   * A knocked-down actor gets up: its bodies are keyframed again and follow its pose (its
   * graph's get-up) from now on.
   */
  standUp(reference: number): void {
    const entry = this.#bodies.get(reference);
    if (!entry?.knocked) return;
    entry.knocked = false;
    entry.articulation = undefined;
    this.#physics?.keyframe(entry.placed);
    entry.poseVersion = -1;
  }

  /**
   * A hit on a ragdoll (one dead or knocked down) pushes it: an impulse along `direction`
   * (Havok units). False when the actor lies as no ragdoll (it stands: its bodies follow its
   * pose).
   */
  pushRagdoll(reference: number, direction: Vec3, magnitude: number): boolean {
    const entry = this.#bodies.get(reference);
    if (!entry?.articulation || magnitude <= 0) return false;
    this.#physics?.impulse(entry.placed, direction, magnitude);
    return true;
  }

  /**
   * A knock-down's push on a ragdoll (PushActorAway's force): every body flies off at that
   * speed along `direction` (Havok units a second). False without a ragdoll.
   */
  kickRagdoll(reference: number, direction: Vec3, speed: number): boolean {
    const entry = this.#bodies.get(reference);
    if (!entry?.articulation || speed <= 0) return false;
    this.#physics?.kick(entry.placed, direction, speed);
    return true;
  }

  /**
   * Pulls one body of a ragdoll (on `node`) toward a point: its speed set to `gain` × the way
   * there a second, at most `limit` units a second (a ragdoll held by its root).
   */
  pullRagdoll(reference: number, node: string, point: Vec3, gain: number, limit: number): void {
    const entry = this.#bodies.get(reference);
    if (!entry?.articulation) return;
    const body = entry.placed.bodies.find(
      ({ data }) => data.node.toLowerCase() === node.toLowerCase(),
    );
    if (body) this.#physics?.pullBody(body, point, gain, limit);
  }

  /**
   * Whether a body of an actor's ragdoll on the nodes named (all when none are) touches
   * something not its own (BSRagdollContactListenerModifier).
   */
  touching(reference: number, nodes: readonly string[]): boolean {
    const entry = this.#bodies.get(reference);
    const physics = this.#physics;
    if (!entry || !physics) return false;
    return physics.touching(
      entry.placed,
      nodes.length > 0 ? new Set(nodes.map((node) => node.toLowerCase())) : undefined,
    );
  }

  #lives(staged: BodyHolder): boolean {
    const placed = staged.placed;
    return (
      !staged.dead &&
      !staged.visibility.hidden &&
      !placed.actor.startsDead &&
      placed.behavior !== undefined &&
      placed.look.skeleton !== undefined
    );
  }

  /** Makes an actor's bodies; while they are being made, the same making (a death awaits it). */
  #add(staged: BodyHolder, dying = false): Promise<void> {
    const reference = staged.reference;
    const pending = this.#adding.get(reference);
    if (pending) return pending;
    if (this.#bodies.has(reference)) return Promise.resolve();
    const adding = this.#make(staged, dying).finally(() => {
      this.#adding.delete(reference);
    });
    this.#adding.set(reference, adding);
    return adding;
  }

  async #make(staged: BodyHolder, dying: boolean): Promise<void> {
    const reference = staged.reference;
    const skeleton = staged.placed.look.skeleton;
    if (skeleton === undefined) return;
    const collision = await this.#session.collision(skeleton);
    const physics = this.#physics;
    const placed = staged.placed;
    const world = staged.world ?? placed.instances[0]?.world;
    if (!physics || !world || !collision || this.#bodies.has(reference)) return;
    if (!dying && !this.#lives(staged)) return;
    const bodies = this.#place(physics, collision, world, placed.pose, reference);
    if (!bodies) return;
    const entry: ActorBody = {
      staged,
      actor: placed,
      placed: bodies.placed,
      pose: placed.pose,
      world,
      bodies: bodies.posed,
      poseVersion: -1,
      worldVersion: -1,
      articulation: undefined,
      knocked: false,
    };
    this.#bodies.set(reference, entry);
    this.#disableSevered(entry);
    this.#follow(entry, physics, true);
  }

  /** The skeleton's bodies in the world, keyframed, each on the pose node it hangs on. */
  #place(
    physics: PhysicsWorld,
    collision: CollisionData,
    world: Mat4,
    pose: ActorPose,
    reference: number,
  ): { placed: PlacedCollision; posed: PosedBody[] } | undefined {
    if (!collision.bodies.some((body) => body.motion === 'dynamic' && !body.phantom)) {
      return undefined;
    }
    const placed = physics.addObject(collision, world, { reference, kind: 'actor' }, false);
    physics.keyframe(placed);
    // Bodies keep their place relative to their node: from the rest pose to the node's pose.
    const rest = new Pose(pose.skeleton).worlds;
    const posed: PosedBody[] = [];
    for (const body of placed.bodies) {
      const node = pose.skeleton.nodeByName.get(body.data.node.toLowerCase());
      if (node === undefined) continue;
      const restInverse = invert(rest.subarray(node * 16, node * 16 + 16));
      if (!restInverse) continue;
      posed.push({ body, node, offset: multiply(restInverse, body.data.transform) });
    }
    return { placed, posed };
  }

  /** The keyframed bodies go where the pose (and placement) puts their nodes now. */
  #follow(entry: ActorBody, physics: PhysicsWorld, force = false): void {
    const motion = entry.staged.placed.instances[0]?.motion;
    const worldVersion = motion?.version ?? 0;
    if (!force && entry.poseVersion === entry.pose.version && entry.worldVersion === worldVersion) {
      return;
    }
    entry.poseVersion = entry.pose.version;
    entry.worldVersion = worldVersion;
    const worlds = entry.pose.worlds;
    for (const { body, node, offset } of entry.bodies) {
      const nodeWorld = worlds.subarray(node * 16, node * 16 + 16);
      physics.moveBody(entry.placed, body, multiply(nodeWorld, offset), entry.world);
    }
  }

  #free(entry: ActorBody): void {
    this.#bodies.delete(entry.staged.reference);
    this.#physics?.remove(entry.placed);
  }
}
