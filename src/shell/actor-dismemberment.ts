// Dismemberment (docs/animation.md, "Dismemberment"), observed in the original: an actor's
// head comes off as its graph raises Decapitate (an execution's chop: MQ101's headsman; a
// decapitating killmove's victim hears its killer's 2_Decapitate). The handler gives the actor
// its race's decapitation armor (the neck's stump and the head's cut, worn like any armor),
// records the head as gone (the engine's ExtraDismemberedLimbs: IsLimbGone; the corpse stays so)
// and queues the cut (at most iActorsDismemberedPerFrame a frame). The cut copies the head (its
// skeleton's head node with the nodes under it, the shapes skinned to them, and the FaceGen head
// moved whole) into a piece of its own in the world: its shapes show only their 100s partitions
// (the helmet's and the head's cut), it gets the ragdoll's head body on the dead bodies' layer,
// free of the neck, and flies off from the neck at fDecapInitialSpeed, bent the way the killer's
// weapon swings, spinning about that line. The body keeps, of its shapes skinned to the head,
// only the partitions under 100 (the stump); its ragdoll's head body leaves collision; the race's
// blood art (NAM7) sprays from it for fDecapitateBloodTime. A dismembered actor placed again
// (its cell loaded again) is cut again as it appears, the head falling from the neck.

import { ActorPose } from '../animation/skeleton.ts';
import {
  decapitationLaunch,
  type DismemberedLimb,
  faceKeepsPartition,
  HEAD_LIMB,
  limbGone,
  pieceShowsPartition,
} from '../gameplay/combat/dismemberment.ts';
import { Layer } from '../physics/collision-layers.ts';
import { HAVOK_SCALE, type CollisionData } from '../physics/collision-data.ts';
import type { PhysicsWorld, PlacedCollision } from '../physics/physics-world.ts';
import { invert } from '../render/frustum.ts';
import type { ModelPart } from '../render/model-data.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { Renderer } from '../render/renderer.ts';
import type {
  GpuScene,
  InstanceMotion,
  InstanceVisibility,
  ModelInstance,
} from '../render/scene-renderer.ts';
import { partitionVisible } from '../world/actors.ts';
import type { ActorBodies } from './actor-bodies.ts';
import { skinnedTo, wornInPlace, type PlacedActor } from './actors.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** A body that can lose its head: a staged actor's, or the player's avatar's. */
export interface SeveredBody {
  readonly reference: number;
  readonly placed: PlacedActor;
  /** Where it is drawn (its instances' shared placement). */
  readonly world: Mat4;
  readonly visibility?: InstanceVisibility;
  /** Draws it again from its instances (what it shows changed). */
  redraw(): void;
}

export interface ActorDismembermentOptions {
  readonly session: GameSession;
  readonly renderer: Renderer;
  readonly terminal: Terminal;
  readonly body: (reference: number) => SeveredBody | undefined;
  readonly bodies: ActorBodies;
  /** An art object (ARTO) on an actor for a while (src/shell/actor-effects.ts). */
  readonly art: (art: number, reference: number, seconds: number) => void;
  /**
   * Who kills an actor: its killer once dead, before that the leader of the killmove it is in
   * (the engine reads its myKiller as the head flies).
   */
  readonly killer: (reference: number) => number | undefined;
}

/** The node a human's right-hand weapon hangs on: the killer's swing is read from it. */
const WEAPON_NODE = 'weapon';
/** The engine's built-in values of the game settings read here. */
const DECAPITATE_BLOOD_TIME = 5;
const DISMEMBERED_LIMB_VELOCITY = 10;

/** A cut waiting its turn (iActorsDismemberedPerFrame a frame). */
interface Pending {
  readonly reference: number;
  /** Flung off (a decapitation now), or dropped where it is (a dismembered actor placed again). */
  readonly launch: boolean;
  /** Where the killer's weapon was as the head was struck, to read its swing from. */
  readonly weapon:
    { readonly killer: number; readonly at: Vec3; readonly time: number } | undefined;
}

/** A cut-off head in the world: its draws, its body, and how its body places them. */
interface Piece {
  readonly reference: number;
  readonly scene: GpuScene;
  readonly collision: PlacedCollision | undefined;
  /** The draws' placement (they share it), rewritten as the body moves. */
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  /** The body's placement times this is the draws' (the head's rest node to its pose). */
  readonly bodyToDraw: Mat4;
}

export class ActorDismemberment {
  readonly #options: ActorDismembermentOptions;
  #physics: PhysicsWorld | undefined;
  readonly #queue: Pending[] = [];
  readonly #pieces = new Map<number, Piece>();
  /** Decapitation armors being put on, with what the actor wears once they are on. */
  readonly #dressing = new Map<number, Promise<readonly number[] | undefined>>();
  /** Actors whose Decapitate is being answered. */
  readonly #deciding = new Set<number>();
  #clock = 0;
  readonly #placement = new Float32Array(16);

  constructor(options: ActorDismembermentOptions) {
    this.#options = options;
  }

  /** The physics world the cut heads fall in (undefined: the play ended; they go). */
  attach(physics: PhysicsWorld | undefined): void {
    if (physics === this.#physics) return;
    this.clear();
    this.#physics = physics;
  }

  // --- Decapitate ----------------------------------------------------------------------------

  /**
   * The Decapitate handler (the graph's Decapitate, a killmove victim's 2_Decapitate): observed in
   * the original, unless its head is gone already, an actor whose race has a decapitation
   * armor for its sex is given it to wear (AddWornItem: put in its inventory and worn), its head
   * is recorded as gone, with what it wears, and it is queued for the cut.
   */
  async decapitate(reference: number): Promise<void> {
    const { session } = this.#options;
    const runtime = session.scriptsReady;
    const body = this.#options.body(reference);
    if (!runtime || !body) return;
    const state = runtime.state.actor(reference);
    // One at a time: the graph may raise it again while the armor goes on.
    if (limbGone(state.dismembered, HEAD_LIMB) || this.#deciding.has(reference)) return;
    this.#deciding.add(reference);
    try {
      await this.#decapitate(reference, body, state);
    } finally {
      this.#deciding.delete(reference);
    }
  }

  async #decapitate(
    reference: number,
    body: SeveredBody,
    state: { dismembered?: DismemberedLimb[] },
  ): Promise<void> {
    const { session } = this.#options;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const { look } = body.placed;
    const placer = await session.actors();
    const race = await placer.race(look.race);
    const armor = race?.decapitateArmors[look.female ? 1 : 0];
    if (armor === undefined) return;
    const weapon = this.#weaponAt(reference);
    // Its look changes in place (the stage does not make it again: dressedInPlace).
    const dressing = (async (): Promise<readonly number[] | undefined> => {
      await runtime.equipment.equip(reference, armor, { silent: true });
      return runtime.equipment.worn(reference);
    })();
    this.#dressing.set(reference, dressing);
    const worn = await dressing.catch((error: unknown) => {
      this.#options.terminal.log('actor', `a decapitation: ${describe(error)}`, 'warn');
      return undefined;
    });
    state.dismembered = [
      ...(state.dismembered ?? []).filter((limb) => limb.limb !== HEAD_LIMB),
      { limb: HEAD_LIMB, worn: worn ?? [] },
    ];
    this.#queue.push({ reference, launch: true, weapon });
  }

  /**
   * Whether an actor's look change is the decapitation armor put on (asked before the actor is
   * made again for it): its body puts it on in place, so a dying body is not made again in the
   * middle of its death. Anything else it puts on or takes off meanwhile makes it again.
   */
  async dressedInPlace(reference: number): Promise<boolean> {
    const dressing = this.#dressing.get(reference);
    if (!dressing) return false;
    const expected = await dressing.catch(() => undefined);
    if (this.#dressing.get(reference) === dressing) this.#dressing.delete(reference);
    const runtime = this.#options.session.scriptsReady;
    if (!expected || !runtime) return false;
    const now = await runtime.equipment.worn(reference);
    return now.length === expected.length && now.every((form) => expected.includes(form));
  }

  /**
   * An actor's body was made (placed in its cell, or made again where it stands), before its
   * scene is built: if its head is gone it is drawn so, its ragdoll's head left out, and a
   * head is dropped from its neck unless one of it lies in the world already.
   */
  prepare(reference: number, placed: PlacedActor): void {
    const runtime = this.#options.session.scriptsReady;
    const limbs = runtime?.state.actors.get(reference)?.dismembered;
    if (!limbGone(limbs, HEAD_LIMB)) return;
    const cut = this.#sever(reference, placed);
    if (!cut) return;
    if (!this.#pieces.has(reference) && !this.#queue.some((entry) => entry.reference === reference))
      this.#queue.push({ reference, launch: false, weapon: undefined });
  }

  // --- Every frame ---------------------------------------------------------------------------

  /** The queued cuts (iActorsDismemberedPerFrame a frame); the heads follow their bodies. */
  frame(seconds: number): void {
    this.#clock += seconds;
    const ini = this.#options.session.ini;
    const perFrame = Math.max(1, ini.number('GamePlay', 'iActorsDismemberedPerFrame'));
    for (let i = 0; i < perFrame && this.#queue.length > 0; i++) {
      const pending = this.#queue.shift();
      if (pending) {
        this.#cut(pending).catch((error: unknown) => {
          this.#options.terminal.log('actor', `a decapitation: ${describe(error)}`, 'warn');
        });
      }
    }
    const placement = this.#placement;
    for (const piece of this.#pieces.values()) {
      if (!piece.collision?.placement(placement)) continue;
      multiply(placement, piece.bodyToDraw, piece.world);
      piece.motion.version++;
    }
  }

  *scenes(): Iterable<GpuScene> {
    for (const piece of this.#pieces.values()) yield piece.scene;
  }

  /** An actor left the stage: its cut head goes with it (it is cut again as it comes back). */
  remove(reference: number): void {
    const piece = this.#pieces.get(reference);
    this.#pieces.delete(reference);
    if (piece) this.#drop(piece);
    this.#dressing.delete(reference);
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      if (this.#queue[i]?.reference === reference) this.#queue.splice(i, 1);
    }
  }

  clear(): void {
    for (const piece of this.#pieces.values()) this.#drop(piece);
    this.#pieces.clear();
    this.#queue.length = 0;
    this.#dressing.clear();
    this.#deciding.clear();
  }

  // --- The cut -------------------------------------------------------------------------------

  /**
   * The skeleton nodes of an actor's head (its body part data's head node and those under it),
   * lower-case, marked cut on its body (its draws read them as they are built) and its
   * ragdoll's bodies on them out of collision. Undefined: it has no head node.
   */
  #sever(reference: number, placed: PlacedActor): ReadonlySet<string> | undefined {
    const headNode = placed.look.headNode;
    const rig = placed.pose.skeleton.rig;
    const head =
      headNode === undefined
        ? undefined
        : placed.pose.skeleton.nodeByName.get(headNode.toLowerCase());
    if (head === undefined) return undefined;
    const inside = new Set<number>([head]);
    // Parents come before their children in the rig.
    for (let node = head + 1; node < rig.names.length; node++) {
      if (inside.has(rig.parents[node] ?? -1)) inside.add(node);
    }
    const { severing } = placed;
    severing.nodes.clear();
    for (const node of inside) severing.nodes.add((rig.names[node] ?? '').toLowerCase());
    // The FaceGen head goes whole if any of it hangs on the head.
    severing.face = placed.instances.some(
      (instance) =>
        severing.heads.has(instance.model) &&
        instance.model.parts.some(({ part }) => skinnedTo(part, severing.nodes)),
    );
    this.#options.bodies.sever(reference, severing.nodes);
    return severing.nodes;
  }

  /**
   * The cut (the engine's queued dismemberment task): the body drawn without its head and with
   * the decapitation armor it wears, the head made a piece of its own falling in the world, the
   * neck bleeding. bDisableAllGore leaves the body whole.
   */
  async #cut(pending: Pending): Promise<void> {
    const { session } = this.#options;
    if (session.ini.number('General', 'bDisableAllGore') !== 0) return;
    const reference = pending.reference;
    const body = this.#options.body(reference);
    const runtime = session.scriptsReady;
    if (!body || !runtime) return;
    const { placed } = body;
    const cut = this.#sever(reference, placed);
    if (!cut) return;
    const placer = await session.actors();
    const race = await placer.race(placed.look.race);
    // The decapitation armor: worn by the look made since, else put on the body as it is.
    const armor = race?.decapitateArmors[placed.look.female ? 1 : 0];
    if (armor !== undefined && !placed.look.worn.some((addon) => addon.armor === armor)) {
      const models = await placer.armorModels(placed, armor);
      if (this.#options.body(reference)?.placed !== placed) return;
      (placed.instances as ModelInstance[]).push(...wornInPlace(placed, models));
    }
    if (this.#options.body(reference)?.placed !== placed) return;
    body.redraw();
    // A head lies in the world already (the body made again): it stays.
    if (!this.#pieces.has(reference)) await this.#spawn(body, cut, pending);
    // The neck bleeds (the race's NAM7) for fDecapitateBloodTime.
    const blood = race?.dismemberBlood;
    if (blood !== undefined) {
      const settings = await session.settings();
      const seconds = settings.number('fDecapitateBloodTime') ?? DECAPITATE_BLOOD_TIME;
      this.#options.art(blood, reference, seconds);
    }
  }

  /** The head as a piece of its own: the head's shapes on a still copy of the pose, its body. */
  async #spawn(body: SeveredBody, cut: ReadonlySet<string>, pending: Pending): Promise<void> {
    const { placed } = body;
    const skeleton = placed.pose.skeleton;
    const head = skeleton.nodeByName.get((placed.look.headNode ?? '').toLowerCase());
    if (head === undefined) return;
    // The pose as it is now, kept: the piece is rigid.
    const pose = new ActorPose(skeleton);
    pose.worlds.set(placed.pose.worlds);
    pose.version++;
    const world = new Float32Array(body.world);
    const motion: InstanceMotion = { version: 0 };
    const { severing, look } = placed;
    const instances: ModelInstance[] = [];
    for (const instance of placed.instances) {
      const face = severing.heads.has(instance.model);
      if (face && !severing.face) continue;
      if (!face && !instance.model.parts.some(({ part }) => skinnedTo(part, cut))) continue;
      instances.push({
        model: instance.model,
        world,
        motion,
        pose,
        ...(instance.poseNodes && { poseNodes: instance.poseNodes }),
        ...(instance.tints && { tints: instance.tints }),
        ...(instance.face && { face: instance.face }),
        ...(body.visibility && { visibility: body.visibility }),
        // The FaceGen head is moved whole, keeping what it showed but its neck; the worn shapes
        // skinned to the head are copied, showing their 100s.
        ...(face
          ? {
              partitionVisible: (bodyPart: number) =>
                partitionVisible(bodyPart, look.owners, undefined) && faceKeepsPartition(bodyPart),
            }
          : {
              partShown: (part: ModelPart) => skinnedTo(part, cut),
              partitionVisible: pieceShowsPartition,
            }),
      });
    }
    if (instances.length === 0) return;
    const scene = this.#options.renderer.scene.createScene(instances);
    // Its body: the ragdoll's head body (the skeleton model's) on the dead bodies' layer, free.
    const rest = new ActorPose(skeleton).worlds;
    const restHead = rest.subarray(head * 16, head * 16 + 16);
    const poseHead = pose.worlds.subarray(head * 16, head * 16 + 16);
    const restInverse = invert(restHead);
    const poseInverse = invert(poseHead);
    const collision = await this.#headCollision(placed);
    const physics = this.#physics;
    let placedCollision: PlacedCollision | undefined;
    let bodyToDraw: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    if (collision && physics && restInverse && poseInverse) {
      // The body's model is the skeleton at rest, placed so its head node is where the head is.
      const bodyWorld = multiply(multiply(world, poseHead), restInverse);
      placedCollision = physics.addObject(
        collision,
        bodyWorld,
        // No reference's: it is part of no reference one activates (the crosshair names none).
        { reference: 0, kind: 'object' },
        true,
      );
      bodyToDraw = multiply(restHead, poseInverse);
      if (pending.launch) this.#launch(body, placedCollision, pose, head, pending);
      else await this.#nudge(body, placedCollision, pose, head);
    }
    if (this.#options.body(body.reference)?.placed !== placed) {
      scene.destroy();
      if (placedCollision) physics?.remove(placedCollision);
      return;
    }
    this.#pieces.set(body.reference, {
      reference: body.reference,
      scene,
      collision: placedCollision,
      world,
      motion,
      bodyToDraw,
    });
  }

  /** The ragdoll's body on the head node, alone, simulated on the dead bodies' layer. */
  async #headCollision(placed: PlacedActor): Promise<CollisionData | undefined> {
    const skeleton = placed.look.skeleton;
    const headNode = placed.look.headNode?.toLowerCase();
    if (skeleton === undefined || headNode === undefined) return undefined;
    const ragdoll = await this.#options.session.collision(skeleton);
    const head = ragdoll?.bodies.find((body) => body.node.toLowerCase() === headNode);
    if (!head) return undefined;
    return {
      bodies: [
        {
          ...head,
          motion: 'dynamic',
          phantom: false,
          layer: Layer.deadBip,
          shapes: head.shapes.map((shape) => ({ ...shape, layer: Layer.deadBip })),
        },
      ],
      constraints: [],
      skipped: [],
    };
  }

  /**
   * The head flies off: from the neck through the head, bent the way the killer's weapon moved
   * since the blow, at fDecapInitialSpeed; spinning about that line.
   */
  #launch(
    body: SeveredBody,
    collision: PlacedCollision,
    pose: ActorPose,
    head: number,
    pending: Pending,
  ): void {
    const neck = pose.skeleton.rig.parents[head] ?? -1;
    if (neck < 0) return;
    const at = (node: number): Vec3 => {
      const world = multiply(body.world, pose.worlds.subarray(node * 16, node * 16 + 16));
      return [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    };
    let swing: Vec3 | undefined;
    const weapon = pending.weapon;
    const now = weapon ? this.#weaponOf(weapon.killer) : undefined;
    if (weapon && now && this.#clock > weapon.time) {
      const dt = this.#clock - weapon.time;
      swing = [
        (now[0] - weapon.at[0]) / dt,
        (now[1] - weapon.at[1]) / dt,
        (now[2] - weapon.at[2]) / dt,
      ];
    }
    const speed = this.#options.session.ini.number('Combat', 'fDecapInitialSpeed');
    const velocity = decapitationLaunch(at(head), at(neck), swing, speed);
    if (!velocity) return;
    const spin: Vec3 = [
      velocity[0] / HAVOK_SCALE,
      velocity[1] / HAVOK_SCALE,
      velocity[2] / HAVOK_SCALE,
    ];
    this.#physics?.setVelocity(collision, velocity, spin);
  }

  /**
   * A head cut again as its body was placed again: observed in the original, it is pushed
   * away from the body's root at fCombatDismemberedLimbVelocity (units a second).
   */
  async #nudge(
    body: SeveredBody,
    collision: PlacedCollision,
    pose: ActorPose,
    head: number,
  ): Promise<void> {
    const settings = await this.#options.session.settings();
    const speed = settings.number('fCombatDismemberedLimbVelocity') ?? DISMEMBERED_LIMB_VELOCITY;
    const world = multiply(body.world, pose.worlds.subarray(head * 16, head * 16 + 16));
    const away: Vec3 = [
      (world[12] ?? 0) - (body.world[12] ?? 0),
      (world[13] ?? 0) - (body.world[13] ?? 0),
      (world[14] ?? 0) - (body.world[14] ?? 0),
    ];
    const velocity = decapitationLaunch(away, [0, 0, 0], undefined, speed);
    if (velocity) this.#physics?.setVelocity(collision, velocity, [0, 0, 0]);
  }

  /** Where the weapon of an actor's killer is now, to read its swing from. */
  #weaponAt(reference: number): Pending['weapon'] {
    const killer = this.#options.killer(reference);
    const at = killer === undefined ? undefined : this.#weaponOf(killer);
    return killer === undefined || !at ? undefined : { killer, at, time: this.#clock };
  }

  /** Where an actor's right-hand weapon node is in the world. */
  #weaponOf(actor: number): Vec3 | undefined {
    const body = this.#options.body(actor);
    const node = body?.placed.pose.world(WEAPON_NODE);
    if (!body || !node) return undefined;
    const world = multiply(body.world, node);
    return [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
  }

  #drop(piece: Piece): void {
    piece.scene.destroy();
    if (piece.collision) this.#physics?.remove(piece.collision);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
