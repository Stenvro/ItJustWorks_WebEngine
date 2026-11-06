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
import { havokHitSpeed, type HavokHitSettings } from '../gameplay/impulses.ts';
import { Articulation } from '../physics/articulation.ts';
import {
  blendObjectControl,
  driveHierarchy,
  HARD_KEYFRAME,
  type BodyFrame,
  type BodyVelocity,
  type HierarchyBody,
  type HierarchyControl,
} from '../physics/keyframe-hierarchy.ts';
import { Layer } from '../physics/collision-layers.ts';
import { RagdollPenetration } from '../physics/ragdoll-penetration.ts';
import { HAVOK_SCALE, type CollisionBody, type CollisionData } from '../physics/collision-data.ts';
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
  /** The body on the nearest node above its node (an index into the bodies; −1: none). */
  readonly parent: number;
  /** How it follows its node, keyframed (its blend collision object's gains). */
  readonly control: HierarchyControl;
}

/**
 * A target that moved farther than this in one update (Havok units) went there, not moved
 * there (a placement moved by a script, a load door): its keyframe has no velocity.
 */
const JUMP = 2;

/** Its bodies' velocities carry into its ragdoll when it was followed this lately (seconds). */
const CARRY_SECONDS = 0.25;

interface ActorBody {
  readonly staged: BodyHolder;
  /** The body it was made for (an actor made again in another race gets new bodies). */
  readonly actor: PlacedActor;
  readonly placed: PlacedCollision;
  readonly pose: ActorPose;
  readonly world: Mat4;
  readonly bodies: readonly PosedBody[];
  /** Its actor is disabled or deleted: a ragdoll's bodies are out of the world meanwhile. */
  disabled?: boolean;
  /** The pose and placement versions the bodies were last moved to. */
  poseVersion: number;
  worldVersion: number;
  /** Dead or knocked down: its bodies move it (its ragdoll). */
  articulation: Articulation | undefined;
  /** Where its first body was as it went limp (Havok units): how far it moved since (moved). */
  limpFrom?: Vec3;
  /** Knocked down living: its ragdoll lies until it gets up (src/shell/actor-knockdowns.ts). */
  knocked: boolean;
  /** Dead: its limbs through the world are brought back for a while (ragdoll-penetration.ts). */
  penetration: RagdollPenetration | undefined;
  /** Its bodies find their contacts with fixed bodies while keyframed (touching). */
  fixedContacts: boolean;
  /** Its ragdoll's joints are powered toward its graph's pose (#power). */
  powered: boolean;
  /** Where the animation put each body last (Havok units, world), and how they moved since. */
  targets: (BodyFrame | undefined)[];
  velocities: (BodyVelocity | undefined)[];
  /** Seconds since its bodies were last moved toward their nodes. */
  since: number;
  /**
   * Its ragdoll in the world, driven by its graph (a dying graph's AnimateToRagdoll, a
   * knocked-down actor getting up): undefined when not; `dynamic` while the graph's rigid
   * body controls drive bodies of it (#drive), `blend` the seconds since they began.
   */
  driven: { dynamic: boolean; blend: number } | undefined;
}

export class ActorBodies {
  readonly #session: GameSession;
  readonly #bodies = new Map<number, ActorBody>();
  readonly #adding = new Map<number, Promise<void>>();
  /** The nodes (lower-case) whose bodies are out of collision, by actor: a cut-off head's. */
  readonly #severed = new Map<number, ReadonlySet<string>>();
  #physics: PhysicsWorld | undefined;

  /**
   * Whether the ground under an actor has its collision (a dead actor's ragdoll waits for it:
   * let go over ground not loaded, it fell through the world).
   */
  readonly #groundReady: (reference: number) => boolean;
  /** The dead whose ragdolls wait for the ground under them (#groundReady). */
  readonly #waiting = new Map<number, BodyHolder>();

  constructor(session: GameSession, groundReady: (reference: number) => boolean = () => true) {
    this.#session = session;
    this.#groundReady = groundReady;
  }

  /** The physics world of the play (undefined: none; the bodies go). */
  attach(physics: PhysicsWorld | undefined): void {
    if (physics === this.#physics) return;
    for (const entry of [...this.#bodies.values()]) this.#free(entry);
    this.#physics = physics;
  }

  remove(reference: number): void {
    this.#severed.delete(reference);
    this.#waiting.delete(reference);
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

  /** An actor's bodies in the world, living or dead (none: not there). */
  placements(reference: number): readonly PlacedCollision[] {
    const entry = this.#bodies.get(reference);
    return entry ? [entry.placed] : [];
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
  frame(actors: Iterable<BodyHolder>, focus: Vec3 | undefined, seconds = 0): void {
    const physics = this.#physics;
    if (!physics) return;
    for (const [reference, staged] of this.#waiting) {
      // Its bodies are made again if they went meanwhile (far off).
      if (this.#groundReady(reference)) void this.kill(staged);
    }
    for (const staged of actors) {
      let entry = this.#bodies.get(staged.reference);
      // A ragdoll whose actor was made again (its look changed: an outfit, a cut-off head)
      // moves the new one's pose from now on.
      if (entry?.articulation && staged.placed !== entry.actor) entry = this.#rehome(entry, staged);
      if (entry?.articulation) {
        // A ragdoll disabled or deleted leaves the world with its actor (it blocked nothing to
        // see, and stayed in its trigger volumes); enabled, it is back where it lay.
        if ((entry.disabled === true) !== staged.visibility.hidden) {
          entry.disabled = staged.visibility.hidden;
          physics.setEnabled(entry.placed, !entry.disabled);
        }
        if (entry.disabled === true) continue;
        if (entry.penetration && !entry.penetration.update(seconds)) entry.penetration = undefined;
        // A knocked-down actor's graph animated its pose meanwhile: its motors pull the ragdoll
        // toward that pose (as far as the graph powers it), then the pose is the ragdoll's again.
        if (entry.knocked) this.#power(entry, physics);
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
      if (entry.driven) this.#drive(entry, physics, seconds);
      else this.#follow(entry, physics, false, seconds);
    }
  }

  /**
   * The graph adds the ragdoll to the world (AddRagdollToWorld while dying; a knocked-down
   * actor's get-up) or removes it: added, its bodies are driven by its graph's controls
   * (#drive), else they follow its pose as the living's do.
   */
  driveRagdoll(reference: number, on: boolean): void {
    const entry = this.#bodies.get(reference);
    if (!entry || entry.articulation) return;
    if (on) {
      entry.driven ??= { dynamic: false, blend: 0 };
      return;
    }
    if (entry.driven?.dynamic && this.#physics) this.#physics.keyframe(entry.placed);
    entry.driven = undefined;
  }

  /**
   * An actor died: its bodies are let go from where its pose has them (they fall), and its
   * pose follows them from now on. Without bodies yet (far, or just placed) they are made
   * first, in its pose now. `force` (ForceAddRagdollToWorld): let go now, without waiting for
   * the ground under it (a hanged corpse hangs from its constraints).
   */
  async kill(staged: BodyHolder, force = false): Promise<void> {
    let entry = this.#bodies.get(staged.reference);
    // Twice: bodies being made for it living as it died are not made (it no longer lives).
    for (let i = 0; i < 2 && !entry; i++) {
      await this.#add(staged, true);
      entry = this.#bodies.get(staged.reference);
    }
    const physics = this.#physics;
    if (!entry || !physics) return;
    if (!force && !this.#groundReady(staged.reference)) {
      this.#waiting.set(staged.reference, staged);
      return;
    }
    this.#waiting.delete(staged.reference);
    // Knocked down as it died: it lies on as the dead do, limp.
    entry.knocked = false;
    this.#unpower(entry, physics);
    // Observed in the original: a dead actor's ragdoll lies on the dead bodies' layer
    // (L_DEADBIP: it meets clutter, weapons, projectiles and other corpses, no character
    // controller), and its limbs through the world are brought back for a while.
    if (!entry.penetration) {
      physics.setLayer(entry.placed, Layer.deadBip);
      entry.penetration = new RagdollPenetration(physics, entry.placed, staged.reference);
    }
    if (entry.articulation) return;
    this.#letGo(entry, physics);
  }

  /**
   * The blow that killed an actor pushes its ragdoll (src/shell/actor-combat.ts: fDeathForce*),
   * once its bodies are let go (kill). Observed in the original: every body of the ragdoll
   * gains `speed` (Havok units a second) along the blow, times its biped part's share
   * (DEATH_PUSH_SHARES): the limbs' ends less than the trunk.
   */
  async push(staged: BodyHolder, direction: Vec3, speed: number): Promise<void> {
    await this.kill(staged);
    const entry = this.#bodies.get(staged.reference);
    if (entry?.articulation) {
      this.#physics?.kick(entry.placed, direction, speed, deathPushShare);
    }
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
    this.#letGo(entry, physics);
    entry.knocked = true;
    return true;
  }

  /** Whether an actor lies knocked down as a ragdoll. */
  /** Holds a knocked-down actor's ragdoll in its pose, or lets it go on its joints again. */
  stiffen(reference: number, on: boolean): void {
    const entry = this.#bodies.get(reference);
    if (entry) this.#physics?.stiffen(entry.placed, on);
  }

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
  standUp(reference: number, rising = false): void {
    const entry = this.#bodies.get(reference);
    if (!entry) return;
    if (!entry.knocked) {
      // Up: its ragdoll leaves the world (its bodies follow its pose as the living's do).
      if (!rising) this.driveRagdoll(reference, false);
      return;
    }
    entry.knocked = false;
    entry.articulation = undefined;
    if (this.#physics) this.#unpower(entry, this.#physics);
    this.#physics?.keyframe(entry.placed);
    entry.poseVersion = -1;
    entry.targets = [];
    entry.velocities = [];
    // Getting up, its ragdoll stays in the world, driven by its graph's get-up (#drive).
    entry.driven = rising ? { dynamic: false, blend: 0 } : undefined;
  }

  /**
   * Its bodies let go (a death, a knock-down): simulated from now on, each moving as the
   * animation last moved it (Havok's keyframed bodies carry their velocities: the ragdoll goes
   * on from the pose it had, as it moved), and its pose follows them.
   */
  #letGo(entry: ActorBody, physics: PhysicsWorld): void {
    const wasDynamic = entry.driven?.dynamic === true;
    entry.driven = undefined;
    physics.setMotion(entry.placed, false);
    if (!wasDynamic && entry.since <= CARRY_SECONDS) {
      entry.bodies.forEach(({ body }, i) => {
        const velocity = entry.velocities[i];
        if (velocity) physics.setBodyVelocity(body, velocity.linear, velocity.angular);
      });
    }
    physics.liftStill(entry.placed);
    entry.articulation = new Articulation(entry.placed, entry.pose, entry.world);
    const first = entry.placed.bodies[0]?.body.translation();
    if (first) entry.limpFrom = [first.x, first.y, first.z];
  }

  /**
   * How far a limp ragdoll has carried its actor since it went limp (game units; undefined:
   * none). A dead actor is where its ragdoll is: one killed in the air is where it fell to,
   * not where it died (its distance to others, its scripts' GetPosition). TODO(M13): the
   * engine's own point of the ragdoll its reference follows (here its first body's way).
   */
  moved(reference: number): Vec3 | undefined {
    const entry = this.#bodies.get(reference);
    const from = entry?.limpFrom;
    const body = entry?.placed.bodies[0]?.body;
    if (!from || !body?.isValid()) return undefined;
    const now = body.translation();
    return [
      (now.x - from[0]) * HAVOK_SCALE,
      (now.y - from[1]) * HAVOK_SCALE,
      (now.z - from[2]) * HAVOK_SCALE,
    ];
  }

  /**
   * Whether a knocked-down actor's ragdoll is powered now (its graph's powered ragdoll controls
   * pull it toward its pose: matching its get-up).
   */
  powered(reference: number): boolean {
    return this.#bodies.get(reference)?.powered === true;
  }

  /**
   * The graph's powered ragdoll controls on a knocked-down actor's ragdoll (the engine's powered
   * ragdoll controller, as hkbPoweredRagdollControlsModifier asks): with force, each joint's
   * motor pulls its body's turn toward the graph's pose of this update (FullyRagdoll's 0:
   * limp; matching the get-up's first pose, 200), only the bones the modifier names if it
   * names any. TODO(M13): which bodies Havok's controller powers when the modifier names none
   * (here all), and its world-from-model mode (the ragdoll's root is not driven here).
   */
  #power(entry: ActorBody, physics: PhysicsWorld): void {
    const control = entry.staged.placed.behavior?.poweredRagdoll();
    if (!control || control.maxForce <= 0) {
      this.#unpower(entry, physics);
      return;
    }
    const named = new Set(control.bones.map((bone) => bone.toLowerCase()));
    const poses = new Map<PlacedBody, Mat4>();
    const only = new Set<PlacedBody>();
    const worlds = entry.pose.worlds;
    for (const { body, node, offset } of entry.bodies) {
      poses.set(body, multiply(worlds.subarray(node * 16, node * 16 + 16), offset));
      if (named.size === 0 || named.has(body.data.node.toLowerCase())) only.add(body);
    }
    physics.power(entry.placed, poses, entry.world, control, only);
    entry.powered = true;
  }

  #unpower(entry: ActorBody, physics: PhysicsWorld): void {
    if (!entry.powered) return;
    entry.powered = false;
    physics.power(entry.placed, new Map(), entry.world, undefined);
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
   * A blow on a ragdoll, with [Animation] bEnableHavokHit on (it is off in the game): every body
   * flies off along `direction` (havokHitSpeed). `now`: seconds. Whether it pushed.
   */
  havokHit(reference: number, direction: Vec3, settings: HavokHitSettings, now: number): boolean {
    const entry = this.#bodies.get(reference);
    if (!entry?.articulation) return false;
    const mass = entry.placed.bodies.reduce((sum, { body }) => sum + body.mass(), 0);
    const since = now - (this.#havokHits.get(reference) ?? -Infinity);
    const speed = havokHitSpeed(settings, mass, since);
    if (speed <= 0) return false;
    this.#havokHits.set(reference, now);
    this.#physics?.kick(entry.placed, direction, speed);
    return true;
  }

  /** When a blow last pushed each ragdoll (havokHit, seconds). */
  readonly #havokHits = new Map<number, number>();

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
    // Its keyframed bodies' contacts with fixed ones are found from the first ask on (a dying
    // graph listening; Rapier computes none by default, and for every living actor they cost).
    if (!entry.fixedContacts) {
      entry.fixedContacts = true;
      physics.findFixedContacts(entry.placed);
    }
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
      penetration: undefined,
      fixedContacts: false,
      powered: false,
      targets: [],
      velocities: [],
      since: 0,
      driven: undefined,
    };
    this.#bodies.set(reference, entry);
    this.#disableSevered(entry);
    // Made in the pose it has now: a keyframed body only gets there by the next step, and one
    // made as its actor dies is let go before that (made where the model's rest pose has it,
    // the dead stood upright in their bind pose, balanced, until they fell asleep so: Lokir,
    // a Stormcloak at Helgen's block).
    const now = new Map(entry.bodies.map((posed) => [posed.body, posed]));
    physics.poseBodies(bodies.placed, world, (body) => {
      const posed = now.get(body);
      return (
        posed &&
        multiply(entry.pose.worlds.subarray(posed.node * 16, posed.node * 16 + 16), posed.offset)
      );
    });
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
    const found: { body: PlacedBody; node: number; offset: Mat4 }[] = [];
    for (const body of placed.bodies) {
      const node = pose.skeleton.nodeByName.get(body.data.node.toLowerCase());
      if (node === undefined) continue;
      const restInverse = invert(rest.subarray(node * 16, node * 16 + 16));
      if (!restInverse) continue;
      found.push({ body, node, offset: multiply(restInverse, body.data.transform) });
    }
    return { placed, posed: withParents(found, pose) };
  }

  /**
   * The keyframed bodies go toward where the pose (and placement) puts their nodes now, by the
   * hierarchy controller with their blend collision objects' gains (1 and 1 in the data: there
   * by the next step, moving as the animation moves them).
   */
  #follow(entry: ActorBody, physics: PhysicsWorld, force = false, seconds = 0): void {
    entry.since += seconds;
    const motion = entry.staged.placed.instances[0]?.motion;
    const worldVersion = motion?.version ?? 0;
    if (!force && entry.poseVersion === entry.pose.version && entry.worldVersion === worldVersion) {
      return;
    }
    entry.poseVersion = entry.pose.version;
    entry.worldVersion = worldVersion;
    if (force) {
      const worlds = entry.pose.worlds;
      for (const { body, node, offset } of entry.bodies) {
        const nodeWorld = worlds.subarray(node * 16, node * 16 + 16);
        physics.moveBody(entry.placed, body, multiply(nodeWorld, offset), entry.world);
      }
      entry.targets = this.#targets(entry, physics);
      entry.velocities = [];
      entry.since = 0;
      return;
    }
    this.#steer(entry, physics, () => undefined);
  }

  /** Where the pose puts each body now (Havok units, world). */
  #targets(entry: ActorBody, physics: PhysicsWorld): BodyFrame[] {
    const worlds = entry.pose.worlds;
    const target = physics.bodyTargets(entry.placed, entry.world);
    const nodeWorld = this.#nodeWorld;
    return entry.bodies.map(({ node, offset }) =>
      target(multiply(worlds.subarray(node * 16, node * 16 + 16), offset, nodeWorld)),
    );
  }

  /** A body's node's world matrix as #targets works it out (one for all). */
  readonly #nodeWorld = new Float32Array(16);

  /**
   * Drives the bodies toward their nodes by the hierarchy controller (keyframe-hierarchy.ts),
   * each by the control `controlOf` gives it (undefined: its own, its blend object's), blended
   * in from its own motion by its weight.
   */
  #steer(
    entry: ActorBody,
    physics: PhysicsWorld,
    controlOf: (posed: PosedBody) => { control: HierarchyControl; weight: number } | undefined,
  ): void {
    const seconds = entry.since > 0 ? entry.since : 1 / 60;
    entry.since = 0;
    const targets = this.#targets(entry, physics);
    const bodies: HierarchyBody[] = entry.bodies.map((posed, i) => {
      const target = targets[i] ?? physics.bodyMotion(posed.body);
      let previous = entry.targets[i];
      if (previous && distance(previous.position, target.position) > JUMP) previous = undefined;
      const velocity = entry.velocities[i];
      const chosen = controlOf(posed);
      return {
        parent: posed.parent,
        control: chosen?.control ?? posed.control,
        target,
        previous,
        // A keyframed body's velocity is the one it was driven at (Rapier keeps none).
        motion:
          posed.body.body.isDynamic() || !velocity
            ? physics.bodyMotion(posed.body)
            : {
                ...physics.bodyFrame(posed.body),
                linear: velocity.linear,
                angular: velocity.angular,
              },
        weight: chosen?.weight ?? 1,
      };
    });
    const velocities = driveHierarchy(bodies, seconds);
    entry.bodies.forEach((posed, i) => {
      const body = bodies[i];
      const velocity = velocities[i];
      if (!body || !velocity) return;
      physics.driveBody(posed.body, velocity.linear, velocity.angular, seconds, body.motion);
      entry.velocities[i] = velocity;
    });
    entry.targets = targets;
  }

  /**
   * A ragdoll in the world driven by its graph (Havok's ragdoll driver, as the graph's
   * modifiers ask): the bones its keyframe bones modifiers name are keyframed hard; the others
   * follow the pose by its rigid body ragdoll controls (hkbRigidBodyRagdollControlsModifier:
   * the hierarchy controller with its control data, blended in over its durationToBlend), as
   * simulated bodies that meet the world, while those are active and no powered ragdoll
   * controls are (the powered controller takes them: FullyRagdoll's limp). With neither, they
   * follow the pose keyframed as the living's do. TODO(M13): whether the original then lets
   * them go limp, and whether it draws the driven bones from their bodies.
   */
  #drive(entry: ActorBody, physics: PhysicsWorld, seconds: number): void {
    const driven = entry.driven;
    const graph = entry.staged.placed.behavior;
    if (!driven || !graph) return;
    const rigid = graph.rigidBodyRagdoll();
    const active = rigid !== undefined && graph.poweredRagdoll() === undefined;
    if (active !== driven.dynamic) {
      driven.dynamic = active;
      driven.blend = 0;
      if (active) {
        // Simulated from here, moving on as they were driven.
        physics.setMotion(entry.placed, false);
        entry.bodies.forEach(({ body }, i) => {
          const velocity = entry.velocities[i];
          if (velocity) physics.setBodyVelocity(body, velocity.linear, velocity.angular);
        });
        physics.liftStill(entry.placed);
      } else physics.keyframe(entry.placed);
    }
    if (!rigid || !active) {
      this.#follow(entry, physics, false, seconds);
      return;
    }
    driven.blend += seconds;
    entry.since += seconds;
    const keyframed = new Set(
      graph.ragdollBoneNames(graph.keyframedRagdollBones()).map((name) => name.toLowerCase()),
    );
    const named = new Set(rigid.bones.map((name) => name.toLowerCase()));
    const duration = rigid.durationToBlend;
    const weight = duration > 0 ? Math.min(1, driven.blend / duration) : 1;
    const nodes = entry.pose.skeleton.rig.names;
    this.#steer(entry, physics, ({ node }) => {
      const name = (nodes[node] ?? '').toLowerCase();
      if (keyframed.has(name)) return { control: HARD_KEYFRAME, weight: 1 };
      if (named.size === 0 || named.has(name)) return { control: rigid.control, weight };
      return { control: HARD_KEYFRAME, weight: 1 };
    });
  }

  /**
   * A ragdoll's actor made again: the new pose takes the old one's nodes (by name) and the
   * ragdoll moves it from now on (else the new look stood in its bind pose over the corpse).
   */
  #rehome(entry: ActorBody, staged: BodyHolder): ActorBody | undefined {
    const placed = staged.placed;
    const world = staged.world ?? placed.instances[0]?.world;
    if (!world) return entry;
    const old = entry.pose;
    const pose = placed.pose;
    const nodes = new Map<number, Float32Array>();
    pose.skeleton.rig.names.forEach((name, node) => {
      const from = old.skeleton.nodeByName.get(name.toLowerCase());
      if (from !== undefined) nodes.set(node, old.worlds.slice(from * 16, from * 16 + 16));
    });
    pose.place(nodes);
    const rest = new Pose(pose.skeleton).worlds;
    const found: { body: PlacedBody; node: number; offset: Mat4 }[] = [];
    for (const { body } of entry.bodies) {
      const node = pose.skeleton.nodeByName.get(body.data.node.toLowerCase());
      const restInverse =
        node === undefined ? undefined : invert(rest.subarray(node * 16, node * 16 + 16));
      if (node === undefined || !restInverse) continue;
      found.push({ body, node, offset: multiply(restInverse, body.data.transform) });
    }
    const bodies = withParents(found, pose);
    const moved: ActorBody = {
      ...entry,
      staged,
      actor: placed,
      pose,
      world,
      bodies,
      poseVersion: -1,
      worldVersion: -1,
      articulation: new Articulation(entry.placed, pose, world),
    };
    this.#bodies.set(staged.reference, moved);
    return moved;
  }

  #free(entry: ActorBody): void {
    entry.penetration?.stop();
    this.#bodies.delete(entry.staged.reference);
    this.#physics?.remove(entry.placed);
  }
}

/**
 * The share of a death's push each body of a ragdoll gets, by its biped part (observed in the
 * original): the trunk, neck, head and upper arms all of it, forearms and thighs three
 * quarters, hands and calves half, feet a quarter, the parts beyond (tails, wings: 17 to 22)
 * three quarters, and the parts past those nothing. TODO(M13): the engine gives the head one
 * and a half when its hit data says so (a field of the hit not known).
 */
const DEATH_PUSH_SHARES = [
  1, 1, 1, 1, 1, 1, 0.75, 0.5, 0.75, 0.5, 0.25, 1, 0.75, 0.5, 0.75, 0.5, 0.25, 0.75, 0.75, 0.75,
  0.75, 0.75, 0.75,
];

function deathPushShare(body: CollisionBody): number {
  return DEATH_PUSH_SHARES[body.part ?? 0] ?? 0;
}

/**
 * The bodies with their parents (the body on the nearest node above each one's, as Havok's
 * ragdoll orders its bones) and their controls (their blend collision objects' gains).
 */
function withParents(
  found: readonly { body: PlacedBody; node: number; offset: Mat4 }[],
  pose: ActorPose,
): PosedBody[] {
  const byNode = new Map(found.map(({ node }, i) => [node, i]));
  const parents = pose.skeleton.rig.parents;
  return found.map((posed) => {
    let up = parents[posed.node] ?? -1;
    while (up >= 0 && !byNode.has(up)) up = parents[up] ?? -1;
    const blend = posed.body.data.blend;
    return {
      ...posed,
      parent: up >= 0 ? (byNode.get(up) ?? -1) : -1,
      control: blend ? blendObjectControl(blend) : HARD_KEYFRAME,
    };
  });
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
