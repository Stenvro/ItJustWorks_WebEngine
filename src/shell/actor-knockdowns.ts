// Knock-downs on the stage (docs/ai.md, "Combat": Staggers and knock-downs): an actor knocked
// down (Actor.PushActorAway, Unrelenting Force's script, an explosion's knock-down flags, an
// attack's knockdown, paralysis) goes limp as the engine's do: its graph gets "Ragdoll"
// (FullyRagdoll: its controller leaves the world, a cast is interrupted), its ragdoll is let go
// from the pose it had (src/shell/actor-bodies.ts) and pushed, its controller goes. Once the
// ragdoll has come to rest (paralysis: once it ends) the engine gets it up: the ragdoll's pose
// goes to its graph (setRagdollPose) and GetUpBegin turns the get-up's matching on (its pose
// matcher picks the get-up clip whose first pose fits the ragdoll best, turned to fit:
// src/animation/pose-matching.ts); the graph's timer raises GetUpStart, where the actor is
// stood where the match puts it, its bodies follow its pose again and hkbGetUpModifier blends
// from the ragdoll's pose into the get-up clip; the clip's GetUpEnd gives it its controller
// back. The knock state (GetKnockStateEnum) follows: queued, down, get up, normal. TODO(M13): when the engine begins the get-up (the
// rest it waits for, how long at least) is not documented: below, half a second at rest after
// a second down, or eight seconds at most.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { GraphEvent } from '../animation/graph-events.ts';
import type { ActorGraphSource } from './actor-graph-events.ts';
import { KnockState } from '../gameplay/combat/combat-state.ts';
import { TRANSFORM_FLOATS } from '../formats/hkx/animation.ts';
import { invert } from '../render/frustum.ts';
import { multiply, type Mat4, type Vec3 } from '../render/math.ts';
import { referenceMatrix } from '../world/cell-loader.ts';
import { Layer } from '../physics/collision-layers.ts';
import { matrixQuaternion, type PhysicsWorld } from '../physics/physics-world.ts';
import type { ActorBodies, BodyHolder } from './actor-bodies.ts';
import type { PlacedActor } from './actors.ts';
import type { Terminal } from './terminal.ts';

/** Its ragdoll counts as at rest below this speed (units a second). TODO(M13). */
const REST_SPEED = 30;
/** Seconds at rest before it gets up, and down at the least and at the most. TODO(M13). */
const REST_SECONDS = 0.5;
const DOWN_MIN = 1;
const DOWN_MAX = 8;
/** Seconds the graph has to answer the get-up's events before the engine stands it up. */
const GET_UP_WAIT = 3;
const RISE_MAX = 6;
/** A held ragdoll's root goes this share of the way to its hold a second, at most this fast. */
const HOLD_GAIN = 8;
const HOLD_SPEED = 600;
/** How far down from the ragdoll's root the ground under it is looked for (units). */
const GROUND_REACH = 512;

/**
 * One who can be knocked down: an actor of the stage, or the player (their avatar's body:
 * src/shell/player-knockdown.ts).
 */
export interface KnockSubject {
  readonly reference: number;
  /** Its body now (made again when its race changes: the knock ends). */
  readonly placed: PlacedActor;
  /** Its body as ActorBodies keeps it. */
  readonly holder: BodyHolder;
  readonly heading: number;
  readonly dead: boolean;
  /** Puts it at a place facing a heading (it has no controller while it lies). */
  moveTo(position: Vec3, heading: number): void;
  /** It falls (true) or is up again (false): the player's keys and camera follow. */
  lying?(on: boolean): void;
  /** Every frame while it lies or gets up (the player's camera on the body). */
  frame?(seconds: number): void;
}

export interface ActorKnockdownsOptions {
  readonly terminal: Terminal;
  readonly bodies: ActorBodies;
  readonly physics: () => PhysicsWorld | undefined;
  /** Who a reference is, to knock down (undefined: not here, dead, hidden). */
  readonly subject: (reference: number) => KnockSubject | undefined;
  /** The knock state changed (combat's GetKnockStateEnum, canAct). */
  readonly changed?: (reference: number, state: number) => void;
}

type Phase = 'down' | 'matching' | 'rising';

interface Knock {
  readonly subject: KnockSubject;
  /** The body it fell in. */
  readonly placed: PlacedActor;
  phase: Phase;
  /** Seconds down, at rest, and since its get-up began. */
  down: number;
  resting: number;
  since: number;
  /** Paralysed: it lies until that ends. */
  paralyzed: boolean;
  /** Held (Grab Actor): its ragdoll's root is pulled to this point until it is let go. */
  held: (() => Vec3 | undefined) | undefined;
  /** Events of its graph this frame that move it on. */
  readonly heard: Set<string>;
  /** Where its get-up was matched from. */
  frame: GroundFrame | undefined;
}

export class ActorKnockdowns {
  readonly #options: ActorKnockdownsOptions;
  readonly #knocks = new Map<number, Knock>();
  readonly #paralyzed = new Set<number>();

  constructor(options: ActorKnockdownsOptions) {
    this.#options = options;
  }

  /** GetKnockStateEnum: normal, down, get up. */
  state(reference: number): number {
    const knock = this.#knocks.get(reference);
    if (!knock) return KnockState.normal;
    return knock.phase === 'down' ? KnockState.down : KnockState.getUp;
  }

  /** Whether it lies or gets up (no controller, no acting of its own). */
  holds(reference: number): boolean {
    return this.#knocks.has(reference);
  }

  /** The player's body while they lie knocked down (ActorBodies moves its pose). */
  get playerBody(): BodyHolder | undefined {
    return this.#knocks.get(PLAYER_REF)?.subject.holder;
  }

  /**
   * Knocks an actor down: its graph's ragdoll (the idle tree's ActionKnockdown chose "Ragdoll"
   * or "RagdollInstant", which combat has sent), its bodies let go and pushed along `push`. One
   * that lies already is pushed again. Whether it lies now.
   */
  async knockDown(
    reference: number,
    push?: { readonly direction: Vec3; readonly force: number },
  ): Promise<boolean> {
    const bodies = this.#options.bodies;
    let knock = this.#knocks.get(reference);
    if (!knock) {
      const subject = this.#options.subject(reference);
      if (!subject || subject.dead) return false;
      knock = {
        subject,
        placed: subject.placed,
        phase: 'down',
        down: 0,
        resting: 0,
        since: 0,
        paralyzed: this.#paralyzed.has(reference),
        held: undefined,
        heard: new Set(),
        frame: undefined,
      };
      this.#knocks.set(reference, knock);
      this.#options.changed?.(reference, KnockState.queued);
      subject.lying?.(true);
      if (!(await bodies.knockDown(subject.holder))) {
        // No ragdoll for it (no bodies, no physics): it does not fall.
        this.#knocks.delete(reference);
        subject.lying?.(false);
        this.#options.changed?.(reference, KnockState.normal);
        return false;
      }
      this.#options.changed?.(reference, KnockState.down);
    } else if (knock.phase !== 'down') {
      // Pushed again as it gets up: it falls again.
      knock.phase = 'down';
      knock.down = 0;
      knock.resting = 0;
      knock.placed.behavior?.sendEvent('Ragdoll');
      if (!(await bodies.knockDown(knock.subject.holder))) return false;
      this.#options.changed?.(reference, KnockState.down);
    }
    // The force read as the speed each body flies off at (TODO(M13): PushActorAway's unit is
    // not documented; so read, Unrelenting Force's 15 flings a man about as far as the game's).
    if (push && push.force > 0) bodies.kickRagdoll(reference, push.direction, push.force);
    return true;
  }

  /**
   * A hit on an actor lying knocked down pushes its ragdoll (an impulse, as the dead's:
   * ActorBodies.push). Whether it lay as a ragdoll.
   */
  push(reference: number, direction: Vec3, force: number): boolean {
    const knock = this.#knocks.get(reference);
    if (knock?.phase !== 'down') return false;
    knock.resting = 0;
    return this.#options.bodies.pushRagdoll(reference, direction, force);
  }

  /** Paralysis begins or ends on an actor (it lies until it ends: Paralyze's ragdoll). */
  paralyze(reference: number, on: boolean): void {
    if (on) this.#paralyzed.add(reference);
    else this.#paralyzed.delete(reference);
    const knock = this.#knocks.get(reference);
    if (knock) knock.paralyzed = on;
  }

  /**
   * Holds one lying (Grab Actor): its ragdoll's root is pulled each frame to where `point` says;
   * undefined lets it go (it falls, and gets up once at rest).
   */
  hold(reference: number, point: (() => Vec3 | undefined) | undefined): void {
    const knock = this.#knocks.get(reference);
    if (knock) knock.held = point;
  }

  /** Whether an actor is paralysed now. */
  paralyzed(reference: number): boolean {
    return this.#paralyzed.has(reference);
  }

  /**
   * Every frame, before the skeletons animate: the knocked down lie until their ragdolls rest,
   * then their get-up begins (GetUpBegin, with the ragdoll's pose given to the graph).
   */
  frame(seconds: number): void {
    for (const [reference, knock] of [...this.#knocks]) {
      const subject = knock.subject;
      if (subject.dead || subject.placed !== knock.placed) {
        // Dead (it lies as the dead do) or its body made again (it stands in the new one).
        this.#knocks.delete(reference);
        if (!subject.dead) this.#end(knock);
        continue;
      }
      subject.frame?.(seconds);
      if (knock.phase === 'down') {
        knock.down += seconds;
        const bodies = this.#options.bodies;
        if (!bodies.knocked(reference)) {
          // Its bodies went (far from the player): it is up at once.
          this.#stand(knock, undefined);
          continue;
        }
        const held = knock.held?.();
        if (held) {
          // Held: its root drawn to the point (HOLD_GAIN of the way a second, at most
          // HOLD_SPEED), as if hanging from the hand that grips it.
          const root = knock.placed.behavior?.ragdollBoneNames([0])[0];
          if (root !== undefined) bodies.pullRagdoll(reference, root, held, HOLD_GAIN, HOLD_SPEED);
          knock.resting = 0;
          continue;
        }
        knock.resting = bodies.resting(reference, REST_SPEED) ? knock.resting + seconds : 0;
        const rested = knock.down >= DOWN_MIN && knock.resting >= REST_SECONDS;
        if (!knock.paralyzed && (rested || knock.down >= DOWN_MAX)) this.#beginGetUp(knock);
        continue;
      }
      knock.since += seconds;
      if (knock.phase === 'matching' && knock.since >= GET_UP_WAIT) {
        // The graph never raised GetUpStart: the engine stands it up itself.
        this.#rise(knock);
      } else if (knock.phase === 'rising' && knock.since >= RISE_MAX) {
        this.#finish(knock);
      }
    }
  }

  /**
   * After the skeletons animated: one whose graph raised GetUpStart is stood where its get-up
   * was matched (its pose the ragdoll's, in that frame, for this frame); one whose get-up clip
   * ended is up.
   */
  afterAnimate(): void {
    for (const knock of [...this.#knocks.values()]) {
      const heard = knock.heard;
      if (heard.size === 0) continue;
      if (knock.phase === 'matching' && heard.has('getupstart')) this.#rise(knock);
      // Up at the clip's GetUpEnd (or GetUpExit): its controller comes back then. The graph's
      // AddCharacterControllerToWorld comes earlier in the clip; the controller waits so that
      // nothing moves it while it rises (its package's walk, a push).
      if (knock.phase === 'rising' && (heard.has('getupend') || heard.has('getupexit'))) {
        this.#finish(knock);
      }
      heard.clear();
    }
  }

  /** An actor left the stage or died: it lies no more (the dead lie as their bodies do). */
  remove(reference: number): void {
    const knock = this.#knocks.get(reference);
    this.#knocks.delete(reference);
    this.#paralyzed.delete(reference);
    if (knock && !knock.subject.dead) knock.subject.lying?.(false);
  }

  clear(): void {
    for (const reference of [...this.#knocks.keys()]) this.remove(reference);
    this.#paralyzed.clear();
  }

  /**
   * What a body's graph raised (the stage's dispatch, src/shell/actor-graph-events.ts), for
   * whoever lies in it then: its get-up's GetUpStart and GetUpEnd (the engine's
   * GetUpStartHandler and GetUpEndHandler), GetUpExit.
   */
  graphEvents(source: ActorGraphSource, events: readonly GraphEvent[]): void {
    const knock = this.#knocks.get(source.reference);
    if (knock?.placed !== source.skeleton) return;
    for (const event of events) knock.heard.add(event.name.toLowerCase());
  }

  /**
   * The engine begins its get-up: the ragdoll's pose (in a frame at its root on the ground
   * under it, facing as it did) to its graph, iGetUpType 1 and GetUpBegin. A graph without a
   * get-up has it stand at once.
   */
  #beginGetUp(knock: Knock): void {
    const placed = knock.placed;
    const behavior = placed.behavior;
    const frame = this.#groundFrame(knock);
    if (!behavior || !frame) {
      this.#stand(knock, frame);
      return;
    }
    const world = knock.subject.holder.world ?? placed.instances[0]?.world;
    const pose = world && ragdollBonePose(placed, world, frame.world);
    if (pose) behavior.setRagdollPose(pose);
    behavior.setVariable('iGetUpType', 1);
    knock.frame = frame;
    if (!behavior.sendEvent('GetUpBegin')) {
      this.#stand(knock, frame);
      return;
    }
    knock.phase = 'matching';
    knock.since = 0;
    this.#options.changed?.(knock.subject.reference, KnockState.getUp);
  }

  /**
   * GetUpStart: it stands where the match puts it (the frame turned and shifted by it), its
   * bodies follow its pose again, and its pose is the ragdoll's in that frame until the
   * get-up's blend takes it on.
   */
  #rise(knock: Knock): void {
    const placed = knock.placed;
    const behavior = placed.behavior;
    const frame = knock.frame ?? this.#groundFrame(knock);
    // Unmatched (no ragdoll pose, its clips not loaded): its root where the ragdoll's lies.
    const match = behavior?.poseMatch() ?? { yaw: 0, offset: [0, 0] as const };
    this.#stand(knock, frame, { yaw: match.yaw, offset: match.offset });
    const matched = behavior?.matchedRagdollPose();
    if (matched) placed.pose.update(matched);
    knock.phase = 'rising';
    knock.since = 0;
  }

  /**
   * Stands it at a frame (moved by a match: then it rises on, else it is up at once), its
   * bodies following its pose again.
   */
  #stand(
    knock: Knock,
    frame: GroundFrame | undefined,
    match?: { readonly yaw: number; readonly offset: readonly [number, number] },
  ): void {
    const subject = knock.subject;
    if (frame) {
      const [ox, oy] = match?.offset ?? [0, 0];
      const scale = frame.scale;
      const cos = Math.cos(frame.heading);
      const sin = Math.sin(frame.heading);
      // The model's x, y (scaled) in the world: rotated by −heading (referenceMatrix's turn).
      const position: Vec3 = [
        frame.position[0] + (ox * cos + oy * sin) * scale,
        frame.position[1] + (-ox * sin + oy * cos) * scale,
        frame.position[2],
      ];
      subject.moveTo(position, frame.heading - (match?.yaw ?? 0));
    }
    this.#options.bodies.standUp(subject.reference);
    if (!match) this.#finish(knock);
  }

  /** Up: its controller comes back (the movers give it one: it is held no more). */
  #finish(knock: Knock): void {
    const reference = knock.subject.reference;
    if (this.#knocks.get(reference) !== knock) return;
    this.#knocks.delete(reference);
    this.#end(knock);
  }

  #end(knock: Knock): void {
    knock.placed.behavior?.setRagdollPose(undefined);
    this.#options.bodies.standUp(knock.subject.reference);
    knock.subject.lying?.(false);
    this.#options.changed?.(knock.subject.reference, KnockState.normal);
  }

  /**
   * Where it gets up from: its ragdoll root's place (the COM, else the skeleton's first node)
   * on the ground under it, facing as it did, at its size.
   */
  #groundFrame(knock: Knock): GroundFrame | undefined {
    const subject = knock.subject;
    const placed = knock.placed;
    const world = subject.holder.world ?? placed.instances[0]?.world;
    if (!world) return undefined;
    const rootName = placed.behavior?.ragdollBoneNames([0])[0];
    const pose = placed.pose;
    const node =
      (rootName === undefined ? undefined : pose.world(rootName)) ?? pose.worlds.subarray(0, 16);
    const at = multiply(world, node);
    const root: Vec3 = [at[12] ?? 0, at[13] ?? 0, at[14] ?? 0];
    const ground = this.#ground(root, subject.reference) ?? root[2];
    const scale = Math.hypot(world[0] ?? 1, world[1] ?? 0, world[2] ?? 0);
    const position: Vec3 = [root[0], root[1], ground];
    return {
      position,
      heading: subject.heading,
      scale,
      world: referenceMatrix({ position, rotation: [0, 0, subject.heading], scale }),
    };
  }
  /** The floor under a point (what character controllers stand on), not the actor's own body. */
  #ground(from: Vec3, reference: number): number | undefined {
    const physics = this.#options.physics();
    if (!physics?.queriesCurrent) return undefined;
    let origin: Vec3 = [from[0], from[1], from[2] + 32];
    for (let i = 0; i < 4; i++) {
      const hit = physics.raycast(origin, [0, 0, -1], GROUND_REACH, Layer.charController);
      if (!hit) return undefined;
      if (hit.owner?.reference !== reference) return hit.point[2];
      origin = [hit.point[0], hit.point[1], hit.point[2] - 1];
    }
    return undefined;
  }
}

/** Where a knocked-down actor's get-up is matched from: on the ground under its root. */
interface GroundFrame {
  readonly position: Vec3;
  readonly heading: number;
  readonly scale: number;
  readonly world: Mat4;
}

/**
 * An actor's pose now (its nodes, as its ragdoll placed them under its placement `world`) as
 * bone-local transforms of its Havok skeleton in another frame (`frame`, a world placement): what the graph's get-up
 * matches and blends from. Bones without a node keep the skeleton's reference pose.
 */
export function ragdollBonePose(
  placed: PlacedActor,
  world: Mat4,
  frame: Mat4,
): Float32Array | undefined {
  const havok = placed.pose.skeleton.hkx;
  const toFrame = invert(frame);
  if (!havok || !toFrame) return undefined;
  const { boneOfNode } = placed.pose.skeleton;
  const nodeOfBone = new Int16Array(havok.bones.length).fill(-1);
  boneOfNode.forEach((bone, node) => {
    if (bone >= 0 && (nodeOfBone[bone] ?? -1) < 0) nodeOfBone[bone] = node;
  });
  const into = multiply(toFrame, world);
  const models: (Mat4 | undefined)[] = [];
  const out = havok.referencePose.slice();
  for (let bone = 0; bone < havok.bones.length; bone++) {
    const node = nodeOfBone[bone] ?? -1;
    if (node < 0) continue;
    const model = multiply(into, placed.pose.worlds.subarray(node * 16, node * 16 + 16));
    models[bone] = model;
  }
  for (let bone = 0; bone < havok.bones.length; bone++) {
    const model = models[bone];
    if (!model) continue;
    const parent = havok.parents[bone] ?? -1;
    const parentModel = parent >= 0 ? models[parent] : undefined;
    let local: Mat4 = model;
    if (parent >= 0) {
      if (!parentModel) continue;
      const inverse = invert(parentModel);
      if (!inverse) continue;
      local = multiply(inverse, model);
    }
    writeTransform(out, bone, local);
  }
  return out;
}

/** A matrix (rotation, uniform scale, translation) as a bone's hkQsTransform in a pose. */
function writeTransform(pose: Float32Array, bone: number, m: Mat4): void {
  const o = bone * TRANSFORM_FLOATS;
  const scale = Math.hypot(m[0] ?? 1, m[1] ?? 0, m[2] ?? 0) || 1;
  const rotation = new Float32Array(16);
  for (let i = 0; i < 12; i++) rotation[i] = (m[i] ?? 0) / scale;
  rotation[15] = 1;
  const q = matrixQuaternion(rotation);
  pose[o] = m[12] ?? 0;
  pose[o + 1] = m[13] ?? 0;
  pose[o + 2] = m[14] ?? 0;
  pose[o + 3] = q.x;
  pose[o + 4] = q.y;
  pose[o + 5] = q.z;
  pose[o + 6] = q.w;
  pose[o + 7] = scale;
  pose[o + 8] = scale;
  pose[o + 9] = scale;
}
