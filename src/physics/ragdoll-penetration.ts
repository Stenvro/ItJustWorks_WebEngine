// A ragdoll's limbs that went through the world as it was let go (a dying actor's foot through
// the ground on a slope, a corpse placed half in a rock) are brought back, as the engine's
// bhkRagdollPenetrationUtil does (observed in the original; docs/physics.md, "Ragdoll
// penetration"): for [RagdollAnim] fDetectionUpdateTimeSec after a dead actor's ragdoll is set
// up, every frame, while all its bodies are simulated, each bone is tested by a ray from its
// parent bone's pivot to its own (and back: a surface met from behind), against what dead bodies
// collide with (L_DEADBIP) but its own bodies. A bone whose ray meets something is penetrating
// and so are its descendants: they collide with nothing until it is out (their joints still
// hold); the penetrating bone itself gets an impulse at the point where its ray met the surface,
// along the surface's normal, that brings its speed there along the normal to fDesiredVel,
// at most fImpulseLimit either way. A frame with no penetration, and the end of the time, give
// every bone its collision back. Platform-independent.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../render/math.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { Layer } from './collision-layers.ts';
import type { PhysicsWorld, PlacedBody, PlacedCollision, PlacedJoint } from './physics-world.ts';

/** The engine's settings for it ([RagdollAnim] in the INI). */
export interface PenetrationSettings {
  /** fDetectionUpdateTimeSec: how long a ragdoll is watched after it is set up (seconds). */
  readonly seconds: number;
  /** fDesiredVel: the speed a penetrating bone is given back along the normal (Havok units/s). */
  readonly desiredSpeed: number;
  /** fImpulseLimit: the largest impulse a bone gets in a frame (kg·m/s). */
  readonly impulseLimit: number;
}

/** The engine's built-in values. */
export const PENETRATION_DEFAULTS: PenetrationSettings = {
  seconds: 5,
  desiredSpeed: 1.5,
  impulseLimit: 15,
};

/** A bone of the ragdoll: its body, the joint to its parent, its parent bone. */
interface Bone {
  readonly body: PlacedBody;
  /** The joint to its parent (undefined: the root). */
  readonly joint: PlacedJoint | undefined;
  /** Its parent's index in the bones (−1: the root). */
  readonly parent: number;
}

/** A ragdoll watched for limbs through the world. */
export class RagdollPenetration {
  readonly #physics: PhysicsWorld;
  readonly #owner: number;
  readonly #settings: PenetrationSettings;
  /** Parents before children. */
  readonly #bones: readonly Bone[];
  #time = 0;
  #passing = false;
  /** Frames in which a bone was found penetrating. */
  penetrations = 0;

  /** `owner`: the actor whose ragdoll it is (its own bodies are no surface). */
  constructor(
    physics: PhysicsWorld,
    placed: PlacedCollision,
    owner: number,
    settings: PenetrationSettings = physics.penetration,
  ) {
    this.#physics = physics;
    this.#owner = owner;
    this.#settings = settings;
    this.#bones = bonesOf(placed);
  }

  /** Whether it is still watched. */
  get watching(): boolean {
    return this.#time < this.#settings.seconds;
  }

  /** Every frame (after the physics steps); false once its time is over. */
  update(seconds: number): boolean {
    this.#time += seconds;
    if (!this.watching) {
      this.stop();
      return false;
    }
    const bones = this.#bones;
    // A ragdoll with a body keyframed or held (driven by its graph, placed to wait) is not
    // tested.
    if (
      bones.length < 2 ||
      bones.some(({ body }) => !body.body.isValid() || !body.body.isDynamic())
    )
      return true;
    const pivots = bones.map((bone) => pivotOf(bone));
    // 0: clear, 1: penetrating, 2: a penetrating bone's descendant.
    const states = new Uint8Array(bones.length);
    const hits = new Map<number, { readonly point: Vec3; readonly normal: Vec3 }>();
    bones.forEach((bone, i) => {
      if (bone.parent < 0) return;
      if (states[bone.parent] !== 0) {
        states[i] = 2;
        return;
      }
      const from = pivots[bone.parent];
      const to = pivots[i];
      if (!from || !to) return;
      const hit = this.#physics.segmentHit(from, to, Layer.deadBip, this.#owner);
      if (!hit) return;
      states[i] = 1;
      // The normal toward the parent's side of the surface: the way back out.
      const back: Vec3 = [from[0] - hit.point[0], from[1] - hit.point[1], from[2] - hit.point[2]];
      const n = hit.normal;
      const sign = n[0] * back[0] + n[1] * back[1] + n[2] * back[2] < 0 ? -1 : 1;
      hits.set(i, { point: hit.point, normal: [n[0] * sign, n[1] * sign, n[2] * sign] });
    });
    if (hits.size === 0) {
      if (this.#passing) this.#restore();
      return true;
    }
    this.penetrations++;
    this.#passing = true;
    const { desiredSpeed, impulseLimit } = this.#settings;
    bones.forEach((bone, i) => {
      this.#physics.setPassThrough(bone.body, states[i] !== 0);
      const hit = hits.get(i);
      if (!hit) return;
      const body = bone.body.body;
      const at = {
        x: hit.point[0] / HAVOK_SCALE,
        y: hit.point[1] / HAVOK_SCALE,
        z: hit.point[2] / HAVOK_SCALE,
      };
      const v = body.velocityAtPoint(at);
      const n = hit.normal;
      const along = v.x * n[0] + v.y * n[1] + v.z * n[2];
      const impulse = Math.max(
        -impulseLimit,
        Math.min(impulseLimit, (desiredSpeed - along) * body.mass()),
      );
      this.#physics.pointImpulse(
        bone.body,
        [n[0] * impulse, n[1] * impulse, n[2] * impulse],
        hit.point,
      );
    });
    return true;
  }

  /** Every bone collides again (its time is over, or the ragdoll goes). */
  stop(): void {
    this.#time = this.#settings.seconds;
    if (this.#passing) this.#restore();
  }

  #restore(): void {
    this.#passing = false;
    for (const { body } of this.#bones)
      if (body.body.isValid()) this.#physics.setPassThrough(body, false);
  }
}

/**
 * The bones of a ragdoll, parents first: its simulated bodies joined by its joints, from the
 * first of them (the skeleton's root body: its COM or pelvis, first in the model's order).
 */
function bonesOf(placed: PlacedCollision): Bone[] {
  const simulated = placed.bodies.filter(({ data }) => data.motion === 'dynamic' && !data.phantom);
  const root = simulated[0];
  if (!root) return [];
  const bones: Bone[] = [{ body: root, joint: undefined, parent: -1 }];
  const seen = new Set<PlacedBody>([root]);
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    if (!bone) break;
    for (const joint of placed.joints) {
      const other = joint.a === bone.body ? joint.b : joint.b === bone.body ? joint.a : undefined;
      if (!other || seen.has(other) || !simulated.includes(other)) continue;
      seen.add(other);
      bones.push({ body: other, joint, parent: i });
    }
  }
  return bones;
}

/**
 * A bone's pivot in the world (game units): where its joint to its parent holds it (the root:
 * its body's place).
 */
function pivotOf(bone: Bone): Vec3 | undefined {
  const body = bone.body.body;
  const joint = bone.joint?.joint;
  if (!joint?.isValid()) return toGame(body.translation());
  const own = joint.body1().handle === body.handle;
  return toGame(worldPoint(body, own ? joint.anchor1() : joint.anchor2()));
}

function worldPoint(body: RAPIER.RigidBody, local: RAPIER.Vector): RAPIER.Vector {
  const q = body.rotation();
  const t = body.translation();
  // v + 2w(q×v) + 2q×(q×v)
  const cx = q.y * local.z - q.z * local.y;
  const cy = q.z * local.x - q.x * local.z;
  const cz = q.x * local.y - q.y * local.x;
  const dx = q.y * cz - q.z * cy;
  const dy = q.z * cx - q.x * cz;
  const dz = q.x * cy - q.y * cx;
  return {
    x: t.x + local.x + 2 * (q.w * cx + dx),
    y: t.y + local.y + 2 * (q.w * cy + dy),
    z: t.z + local.z + 2 * (q.w * cz + dz),
  };
}

const toGame = (v: RAPIER.Vector): Vec3 => [
  v.x * HAVOK_SCALE,
  v.y * HAVOK_SCALE,
  v.z * HAVOK_SCALE,
];
