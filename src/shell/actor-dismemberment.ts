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

import { shownAhead } from '../animation/animated-skeleton.ts';
import { ActorPose } from '../animation/skeleton.ts';
import {
  decapitationLaunch,
  type DismemberedLimb,
  faceKeepsPartition,
  HEAD_LIMB,
  limbGone,
  pieceShowsPartition,
  redressing,
  SWING_SECONDS,
  SwingTrail,
} from '../gameplay/combat/dismemberment.ts';
import { Layer } from '../physics/collision-layers.ts';
import { HAVOK_SCALE, type CollisionData } from '../physics/collision-data.ts';
import type { PhysicsWorld, PlacedCollision } from '../physics/physics-world.ts';
import { invert } from '../render/frustum.ts';
import type { ModelPart } from '../render/model-data.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import type { RenderPort } from '../render/render-port.ts';
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
  readonly renderer: RenderPort;
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
  /**
   * The executioner of an actor in furniture (its chopping block's headsman), whose swing is
   * read where it has no killer yet: the chop decapitates before it kills.
   */
  readonly executioner?: (reference: number) => Promise<number | undefined>;
  /**
   * Those who may strike a head off now (in furniture, in a killmove): where their weapons were
   * is kept for the moment one does.
   */
  readonly striking?: () => Iterable<number>;
}

/** The node a human's right-hand weapon hangs on: the killer's swing is read from it. */
const WEAPON_NODE = 'weapon';
/** The engine's built-in values of the game settings read here. */
const DECAPITATE_BLOOD_TIME = 5;
const DISMEMBERED_LIMB_VELOCITY = 10;

/**
 * When in its graph's update a blow fell: `late`, how long before the update's end (the
 * Decapitate's GraphEvent.late, in seconds of the animation clock: animateSkeletons puts it on
 * the whole frame where a frame longer than its MAX_STEP had its update cut, below 10 frames a
 * second, and the player's is divided by the player's pace); `graphTime`, the update's
 * end on the animation clock (an actor's graph runs on it, ahead of it between the updates of a
 * graph far from the camera or unseen). Without `graphTime` the graph runs on a clock of its own
 * and updates every frame (the player's body: PlayerAvatar's clock, which runs in menus that show
 * the player and at the player's pace), so its update ends at the frame's animation clock; its
 * own clock is never compared with the animation clock.
 */
export interface BlowMoment {
  readonly late: number;
  readonly graphTime?: number;
}

/**
 * A blow as it fell: the actor as shown at the blow's moment, which the head flies from however
 * long its cut takes (its armor's models may still be read), and who struck. The moment is the
 * Decapitate's on the animation clock (its clip's annotation, GraphEvent.late; BlowMoment), not
 * the end of the update that raised it, up to a frame later (a frame at 15 a second is 67 ms;
 * measured at Helgen's block: 6 ms at 60 frames a second, 39 ms at 15), or more for a graph
 * updated ahead of the clock where nothing held the update short of the event (animateSkeletons
 * holds it short of the active clips' next trigger or annotation; a clip a transition starts
 * within the update is not counted). Where the actor is shown as the clock
 * runs (every frame, or blending on), the blow waits for the clock and takes the pose between the
 * two frames shown around its moment. Where it is shown at once ahead (unseen, not interpolated),
 * it takes the pose between the one shown before the update and the one after, the graph's at
 * the update's two ends. The killer's swing is read up to the moment. TODO(M13): inferred; the
 * engine queues its cut too, and whether that reads the pose of the blow or of its turn was not
 * read.
 */
interface Blow {
  /**
   * The blow's moment on the animation clock; undefined until the frame it fell in has its clock
   * (#settle: a graph on a clock of its own, the player's).
   */
  time: number | undefined;
  /** How long before the end of its graph's update it fell (seconds of the animation clock). */
  readonly late: number;
  /** When `world` and `worlds` were shown (the clock then; the graph's time for `ahead`). */
  shownAt: number;
  /**
   * The update its graph ran ahead in and shows at once (shownAhead): from the graph's time of
   * the pose shown before it to its time after; undefined: the pose is shown as the clock runs.
   */
  readonly ahead: { readonly from: number; readonly until: number } | undefined;
  readonly world: Float32Array;
  readonly worlds: Float32Array;
  /** The pose is the moment's (the clock reached it). */
  settled: boolean;
  killer: number | undefined;
}

/** A cut waiting its turn (iActorsDismemberedPerFrame a frame). */
interface Pending {
  readonly reference: number;
  /** Flung off (a decapitation now), or dropped where it is (a dismembered actor placed again). */
  readonly launch: boolean;
  /** The blow that cut it; none: a dismembered actor placed again. */
  readonly blow: Blow | undefined;
}

/** A cut-off head in the world: its draws, its body, and how its body places them. */
interface Piece {
  readonly reference: number;
  readonly scene: GpuScene | undefined;
  readonly collision: PlacedCollision | undefined;
  /** The draws' placement (they share it), rewritten as the body moves. */
  readonly world: Float32Array;
  readonly motion: InstanceMotion;
  /** The body's placement times this is the draws' (the head's rest node to its pose). */
  readonly bodyToDraw: Mat4;
  /** Where the head node lies in its body (the skeleton model at rest). */
  readonly head: Vec3;
}

export class ActorDismemberment {
  readonly #options: ActorDismembermentOptions;
  #physics: PhysicsWorld | undefined;
  readonly #queue: Pending[] = [];
  /** Where the weapons of those who may strike were lately. */
  readonly #swings = new Map<number, SwingTrail>();
  readonly #pieces = new Map<number, Piece>();
  /** Decapitation armors being put on, with what the actor wears once they are on. */
  readonly #dressing = new Map<number, Promise<readonly number[] | undefined>>();
  /** Actors whose Decapitate is being answered. */
  readonly #deciding = new Set<number>();
  /** Dismembered actors being dressed again as their cut limb's record says. */
  readonly #redressing = new Set<number>();
  /** Blows whose moment the clock has not reached yet, with whom they cut. */
  readonly #blows = new Map<Blow, number>();
  /** The animation clock (seconds: the skeletons' and their graphs' clock). */
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
   * is recorded as gone, with what it wears, and it is queued for the cut. `moment`: when in
   * its graph's update the blow fell; none: as the actor was last shown.
   */
  async decapitate(reference: number, moment?: BlowMoment): Promise<void> {
    const { session } = this.#options;
    const runtime = session.scriptsReady;
    const body = this.#options.body(reference);
    if (!runtime || !body) return;
    const state = runtime.state.actor(reference);
    // One at a time: the graph may raise it again while the armor goes on.
    if (limbGone(state.dismembered, HEAD_LIMB) || this.#deciding.has(reference)) return;
    this.#deciding.add(reference);
    // As last shown (the update raising it has not been posed yet): settled as the clock passes
    // its moment (#settle).
    const late = moment && Number.isFinite(moment.late) ? Math.max(0, moment.late) : 0;
    const graphTime =
      moment?.graphTime !== undefined && Number.isFinite(moment.graphTime)
        ? moment.graphTime
        : undefined;
    const span = graphTime === undefined ? undefined : shownAhead(body.placed);
    const ahead =
      span && graphTime !== undefined && Math.abs(span.until - graphTime) < 1e-6 ? span : undefined;
    const blow: Blow = {
      time: !moment ? this.#clock : graphTime === undefined ? undefined : graphTime - late,
      late,
      shownAt: ahead ? ahead.from : this.#clock,
      ahead,
      world: new Float32Array(body.world),
      worlds: new Float32Array(body.placed.pose.worlds),
      settled: false,
      killer: undefined,
    };
    this.#blows.set(blow, reference);
    try {
      await this.#decapitate(reference, body, state, blow);
    } finally {
      this.#deciding.delete(reference);
    }
  }

  async #decapitate(
    reference: number,
    body: SeveredBody,
    state: { dismembered?: DismemberedLimb[] },
    blow: Blow,
  ): Promise<void> {
    const { session } = this.#options;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const { look } = body.placed;
    const placer = await session.actors();
    const race = await placer.race(look.race);
    const armor = race?.decapitateArmors[look.female ? 1 : 0];
    if (armor === undefined) return;
    blow.killer = await this.#killerOf(reference);
    // Its look changes in place (the stage does not make it again: dressedInPlace).
    const dressing = (async (): Promise<readonly number[] | undefined> => {
      await runtime.equipment.equip(reference, armor, { silent: true, worn: true });
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
    this.#queue.push({ reference, launch: true, blow });
  }

  /**
   * Whether an actor's look change is the decapitation armor put on (asked before the actor is
   * made again for it): its body puts it on in place, so a dying body is not made again in the
   * middle of its death. It is asked for every look change until the cut is made (putting the
   * armor on may change what it wears in several steps, each told on its own). Anything else it
   * puts on or takes off meanwhile makes it again.
   */
  async dressedInPlace(reference: number): Promise<boolean> {
    const dressing = this.#dressing.get(reference);
    if (!dressing) return false;
    const expected = await dressing.catch(() => undefined);
    const runtime = this.#options.session.scriptsReady;
    if (!expected || !runtime) return false;
    const now = await runtime.equipment.worn(reference);
    const same = now.length === expected.length && now.every((form) => expected.includes(form));
    if (!same && this.#dressing.get(reference) === dressing) this.#dressing.delete(reference);
    return same;
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
    // Dressed again as its cut limb's record says, if it wears otherwise (it is made again in
    // what it wears then, and cut again).
    if (!this.#dressing.has(reference)) void this.#redress(reference);
    const cut = this.#sever(reference, placed);
    if (!cut) return;
    if (!this.#pieces.has(reference) && !this.#queue.some((entry) => entry.reference === reference))
      this.#queue.push({ reference, launch: false, blow: undefined });
  }

  /**
   * Observed in the original: as a dismembered actor's 3D loads, what it wears is compared
   * with what its cut limb's record says it wore, and it is dressed so again where they differ
   * (redressing): a reloaded corpse whose outfit came back whole wears its decapitation armor
   * again.
   */
  async #redress(reference: number): Promise<void> {
    const runtime = this.#options.session.scriptsReady;
    if (!runtime || this.#redressing.has(reference)) return;
    this.#redressing.add(reference);
    try {
      const limbs = runtime.state.actors.get(reference)?.dismembered;
      const plan = redressing(limbs, await runtime.equipment.worn(reference));
      if (!plan) return;
      for (const form of plan.unequip) await runtime.equipment.unequip(reference, form);
      // Only what it still has: what was taken off it (looted) is not given back.
      for (const form of plan.equip) {
        if ((await runtime.itemCount(reference, form)) <= 0) continue;
        await runtime.equipment.equip(reference, form, { silent: true });
      }
    } catch (error: unknown) {
      this.#options.terminal.log(
        'actor',
        `a dismembered actor dressed again: ${describe(error)}`,
        'warn',
      );
    } finally {
      this.#redressing.delete(reference);
    }
  }

  // --- Every frame ---------------------------------------------------------------------------

  /**
   * The queued cuts (iActorsDismemberedPerFrame a frame, each once the clock has reached its
   * blow); the heads follow their bodies. `clock`: the animation clock now (the skeletons'
   * time; else it runs on by `seconds`).
   */
  frame(seconds: number, clock = this.#clock + seconds): void {
    this.#clock = clock;
    this.#followSwings();
    this.#settle();
    const ini = this.#options.session.ini;
    const perFrame = Math.max(1, ini.number('GamePlay', 'iActorsDismemberedPerFrame'));
    let cuts = 0;
    for (let i = 0; i < this.#queue.length && cuts < perFrame;) {
      const pending = this.#queue[i];
      if (pending?.blow && !pending.blow.settled) {
        i++;
        continue;
      }
      this.#queue.splice(i, 1);
      cuts++;
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

  /**
   * The blows whose moment the clock has reached take the pose the actor had then, between the
   * one shown before and the one shown now; those still ahead keep the one shown now. A blow of
   * a graph shown ahead at once takes the pose between the two ends of its update, in the frame
   * it fell (the pose after it is shown by then).
   */
  #settle(): void {
    for (const [blow, reference] of this.#blows) {
      const body = this.#options.body(reference);
      const worlds = body?.placed.pose.worlds;
      if (!body || worlds?.length !== blow.worlds.length) {
        blow.settled = true;
        this.#blows.delete(blow);
        continue;
      }
      // A graph on a clock of its own (the player's) updates every frame: its update ended now.
      blow.time ??= this.#clock - blow.late;
      if (blow.ahead) {
        const { from, until } = blow.ahead;
        const t = Math.min(1, Math.max(0, (blow.time - from) / (until - from)));
        lerpInto(blow.world, body.world, t);
        lerpInto(blow.worlds, worlds, t);
        blow.settled = true;
        this.#blows.delete(blow);
        continue;
      }
      if (blow.time > this.#clock) {
        blow.world.set(body.world);
        blow.worlds.set(worlds);
        blow.shownAt = this.#clock;
        continue;
      }
      const span = this.#clock - blow.shownAt;
      const t = span > 1e-6 ? Math.min(1, Math.max(0, (blow.time - blow.shownAt) / span)) : 1;
      lerpInto(blow.world, body.world, t);
      lerpInto(blow.worlds, worlds, t);
      blow.settled = true;
      this.#blows.delete(blow);
    }
  }

  #followSwings(): void {
    for (const actor of this.#options.striking?.() ?? []) {
      const at = this.#weaponOf(actor);
      if (!at) continue;
      let trail = this.#swings.get(actor);
      if (!trail) {
        trail = new SwingTrail();
        this.#swings.set(actor, trail);
      }
      trail.record(this.#clock, at);
    }
    for (const [actor, trail] of this.#swings)
      if (trail.latest < this.#clock) this.#swings.delete(actor);
  }

  *scenes(): Iterable<GpuScene> {
    for (const piece of this.#pieces.values()) if (piece.scene) yield piece.scene;
  }

  /** Where an actor's cut head (its head node) is in the world now; undefined: none lies. */
  headAt(reference: number): Vec3 | undefined {
    const piece = this.#pieces.get(reference);
    const m = this.#placement;
    if (!piece?.collision?.placement(m)) return undefined;
    const [x, y, z] = piece.head;
    return [
      (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
      (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
      (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
    ];
  }

  /** An actor left the stage: its cut head goes with it (it is cut again as it comes back). */
  remove(reference: number): void {
    const piece = this.#pieces.get(reference);
    this.#pieces.delete(reference);
    if (piece) this.#drop(piece);
    this.#dressing.delete(reference);
    for (const [blow, of] of this.#blows) {
      if (of !== reference) continue;
      blow.settled = true;
      this.#blows.delete(blow);
    }
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
    this.#swings.clear();
    for (const blow of this.#blows.keys()) blow.settled = true;
    this.#blows.clear();
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
    // The pose as the blow found it (else as it is now), kept: the piece is rigid.
    const pose = new ActorPose(skeleton);
    pose.worlds.set(pending.blow?.worlds ?? placed.pose.worlds);
    pose.version++;
    const world = new Float32Array(pending.blow?.world ?? body.world);
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
    // Nothing to draw (no models loaded: the headless simulation), the head still falls.
    const scene =
      instances.length === 0 ? undefined : this.#options.renderer.scene.createScene(instances);
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
      if (pending.launch) this.#launch(world, placedCollision, pose, head, pending);
      else await this.#nudge(body, placedCollision, pose, head);
    }
    if (this.#options.body(body.reference)?.placed !== placed) {
      scene?.destroy();
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
      head: [restHead[12] ?? 0, restHead[13] ?? 0, restHead[14] ?? 0],
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
   * The head flies off: from the neck through the head, bent the way the killer's weapon came
   * into the blow (#weaponAt), at fDecapInitialSpeed; spinning about that line.
   */
  #launch(
    bodyWorld: Mat4,
    collision: PlacedCollision,
    pose: ActorPose,
    head: number,
    pending: Pending,
  ): void {
    const neck = pose.skeleton.rig.parents[head] ?? -1;
    if (neck < 0) return;
    const at = (node: number): Vec3 => {
      const world = multiply(bodyWorld, pose.worlds.subarray(node * 16, node * 16 + 16));
      return [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
    };
    const speed = this.#options.session.ini.number('Combat', 'fDecapInitialSpeed');
    const velocity = decapitationLaunch(at(head), at(neck), this.#swingInto(pending.blow), speed);
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

  /**
   * How the killer's weapon came into a blow (SwingTrail); undefined: it is not known to have
   * moved.
   */
  #swingInto(blow: Blow | undefined): Vec3 | undefined {
    const trail = blow?.killer === undefined ? undefined : this.#swings.get(blow.killer);
    if (!blow || !trail) return undefined;
    const time = blow.time ?? this.#clock;
    const to = trail.at(time);
    const from = trail.at(time - SWING_SECONDS);
    if (!to || !from || to.time <= from.time) return undefined;
    const dt = to.time - from.time;
    return [
      (to.at[0] - from.at[0]) / dt,
      (to.at[1] - from.at[1]) / dt,
      (to.at[2] - from.at[2]) / dt,
    ];
  }

  /**
   * Who struck a blow, whose weapon's swing is read: an actor's killer, else its executioner. Observed in the original: Helgen's first prisoner's head drops into the
   * basket before the block, its flight bent down by the headsman's chop; unbent (he has no
   * killer until his clip's KillActor, 4.8 s after its Decapitate), it flew level at
   * fDecapInitialSpeed over the basket and rolled on down the street. TODO(M13): how the
   * engine knows the executioner (the victim's myKiller is unset at the chop).
   */
  async #killerOf(reference: number): Promise<number | undefined> {
    return this.#options.killer(reference) ?? (await this.#options.executioner?.(reference));
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
    piece.scene?.destroy();
    if (piece.collision) this.#physics?.remove(piece.collision);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `into` moved `t` of the way to `to`, value by value. */
function lerpInto(into: Float32Array, to: Float32Array, t: number): void {
  for (let i = 0; i < into.length; i++) {
    const a = into[i] ?? 0;
    into[i] = a + ((to[i] ?? 0) - a) * t;
  }
}
