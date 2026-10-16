// The bodies of the living actors of the loaded area (docs/m10-plan.md, 1.2 and 1.4): an actor
// near the player has its race's ragdoll (the skeleton model's bodies on the main bones,
// skeleton.nif) in the physics world, keyframed to its animated pose, on the BIPED layer:
// what hits it, picks it and sees it meets those bodies. When it dies its bodies are let go
// from where they are and its pose follows them: the dead fall as ragdolls from the pose they
// had, as the dead placed in their cells do (src/shell/actors.ts, ragdollsOf).

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

/** A body on a node of the actor's pose, with its place relative to the node. */
interface PosedBody {
  readonly body: PlacedBody;
  readonly node: number;
  readonly offset: Mat4;
}

interface ActorBody {
  readonly staged: StagedActor;
  /** The body it was made for (an actor made again in another race gets new bodies). */
  readonly actor: PlacedActor;
  readonly placed: PlacedCollision;
  readonly pose: ActorPose;
  readonly world: Mat4;
  readonly bodies: readonly PosedBody[];
  /** The pose and placement versions the bodies were last moved to. */
  poseVersion: number;
  worldVersion: number;
  /** Dead: its bodies move it (its ragdoll). */
  articulation: Articulation | undefined;
}

export class ActorBodies {
  readonly #session: GameSession;
  readonly #bodies = new Map<number, ActorBody>();
  readonly #adding = new Set<number>();
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
    const entry = this.#bodies.get(reference);
    if (entry) this.#free(entry);
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
  frame(actors: Iterable<StagedActor>, focus: Vec3 | undefined): void {
    const physics = this.#physics;
    if (!physics) return;
    for (const staged of actors) {
      const entry = this.#bodies.get(staged.reference);
      if (entry?.articulation) {
        entry.articulation.update();
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
  async kill(staged: StagedActor): Promise<void> {
    let entry = this.#bodies.get(staged.reference);
    if (!entry) {
      await this.#add(staged, true);
      entry = this.#bodies.get(staged.reference);
    }
    const physics = this.#physics;
    if (!entry || !physics || entry.articulation) return;
    physics.setMotion(entry.placed, false);
    entry.articulation = new Articulation(entry.placed, entry.pose, entry.world);
  }

  #lives(staged: StagedActor): boolean {
    const placed = staged.placed;
    return (
      !staged.dead &&
      !staged.visibility.hidden &&
      !placed.actor.startsDead &&
      placed.behavior !== undefined &&
      placed.look.skeleton !== undefined
    );
  }

  async #add(staged: StagedActor, dying = false): Promise<void> {
    const reference = staged.reference;
    if (this.#adding.has(reference) || this.#bodies.has(reference)) return;
    const skeleton = staged.placed.look.skeleton;
    if (skeleton === undefined) return;
    this.#adding.add(reference);
    try {
      const collision = await this.#session.collision(skeleton);
      const physics = this.#physics;
      const placed = staged.placed;
      const world = placed.instances[0]?.world;
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
      };
      this.#bodies.set(reference, entry);
      this.#follow(entry, physics, true);
    } finally {
      this.#adding.delete(reference);
    }
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
