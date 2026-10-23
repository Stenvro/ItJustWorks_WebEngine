// The physics world (Rapier) in Havok units, as the engine runs Havok: game units are divided
// by HAVOK_SCALE on the way in. Places the collision of models and landscape, filters pairs
// by the collision layers of the COLL records, steps the simulation and answers ray casts.
// Platform-independent (Rapier's WebAssembly runs in browsers and in Node).

import RAPIER from '@dimforge/rapier3d-compat';
import type { ConstraintData, ConstraintFrame } from '../formats/nif/types.ts';
import { identity, type Mat4, type Vec3 } from '../render/math.ts';
import {
  HAVOK_SCALE,
  rigidPart,
  smallestExtent,
  type CollisionBody,
  type CollisionConstraint,
  type CollisionData,
  type CollisionShape,
} from './collision-data.ts';
import { Layer, LayerFlag, type CollisionMatrix } from './collision-layers.ts';
import type { BodyPush } from '../gameplay/magic/explosions.ts';

export type Rapier = typeof RAPIER;

let ready: Promise<void> | undefined;

/** Loads Rapier's WebAssembly once. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

/**
 * The Havok world's gravity (m/s², downwards). Not documented; 9.8 is what mods read from the
 * running game (hkpWorld::m_gravity).
 */
export const GRAVITY = 9.8;

/**
 * Fixed simulation step: the engine steps Havok by [HAVOK] fMaxTime (1/60 s); in a "complex"
 * mode by fMaxTimeComplex, uMaxNumPhysicsStepsPerUpdateComplex times at most (observed in the original;
 * TODO(M13): what turns that mode on is not known).
 */
export const PHYSICS_STEP = 1 / 60;
/**
 * At most this many steps per frame ([HAVOK] uMaxNumPhysicsStepsPerUpdate's built-in value; the
 * sessions set PhysicsWorld.maxSteps from the INI): a longer frame slows the simulation down.
 */
export const MAX_STEPS_PER_UPDATE = 3;
/**
 * Which simulated bodies are swept continuously (the engine's choice of a body's quality as it
 * makes it, observed in the original): one whose shape is thicker than fDebrisMinExtent along all three axes
 * (its smallest extent, Havok units) or whose top speed (its maximum linear velocity, in game
 * units per second) is below fDebrisMaxVelocity is debris, never swept; of the others, one of
 * debris quality becomes a "moving" one, swept against what is fixed (Havok's moving quality),
 * and the rest keep the file's quality. The game settings' built-in defaults; the sessions set the
 * load order's (PhysicsWorld.debris).
 */
export const DEBRIS_QUALITY: DebrisQuality = { minExtent: 2, maxVelocity: 25 };
/** fDebrisMinExtent (Havok units) and fDebrisMaxVelocity (game units per second). */
export interface DebrisQuality {
  readonly minExtent: number;
  readonly maxVelocity: number;
}
/** hkpCollidableQualityType of the files: debris, and moving (swept against fixed bodies). */
const QUALITY_DEBRIS = 2;
const QUALITY_MOVING = 4;

/**
 * Whether a simulated body is swept continuously (Rapier's CCD) by the engine's rule
 * (DEBRIS_QUALITY): its quality is moving or better once the engine has chosen it. `scale`: the
 * placement's.
 */
export function sweptBody(
  data: Pick<CollisionBody, 'quality' | 'maxLinearVelocity' | 'shapes'>,
  scale: number,
  debris: DebrisQuality,
): boolean {
  const extent = (smallestExtent(data.shapes) * scale) / HAVOK_SCALE;
  if (extent > debris.minExtent || data.maxLinearVelocity * HAVOK_SCALE < debris.maxVelocity)
    return false;
  const quality = data.quality === QUALITY_DEBRIS ? QUALITY_MOVING : data.quality;
  return quality >= QUALITY_MOVING;
}
/**
 * Solver iterations per step. Havok's solver holds stacks and hinged bodies (closed books on
 * one another, hanging game) still where Rapier's default 4 lets them creep and jitter: with 8
 * the settled clutter of Jorrvaskr sleeps (34 bodies awake after 10 s with 4, 9 with 8) at
 * about the same cost, as fewer bodies stay awake.
 */
const SOLVER_ITERATIONS = 8;
/**
 * Placed bodies start with what overlaps their placement leaves (books whose corners reach
 * into a shelf's back panel, a cover into the board under it): for this long after they are
 * placed to settle, the solver's push out of those overlaps only moves them, without the speed
 * it would give them (Havok recovers penetrations slowly; Rapier's push sent books off their
 * shelves). TODO(M13): how far the engine's warm start goes.
 */
const DEPENETRATE_SECONDS = 0.5;
/**
 * Hung objects (a fixed body with simulated ones on it: hanging game, chains) placed into
 * other collision deeper than this (Havok units; one game unit) never collide with it: a
 * pheasant's hook set into a beam would push its body against its hinges for good, swinging.
 */
const HUNG_OVERLAP = 1 / HAVOK_SCALE;

/** What a collider belongs to: a placed reference, the landscape, an actor. */
export interface PhysicsOwner {
  /** Reference form id (0 for landscape). */
  readonly reference: number;
  readonly kind: 'object' | 'landscape' | 'actor';
}

/** A body placed in the world, with the model body it came from. */
export interface PlacedBody {
  readonly body: RAPIER.RigidBody;
  readonly data: CollisionBody;
  /**
   * The body's place in its model (rotation, translation × the placement's scale), inverted:
   * the model's placement follows from the body's pose times this.
   */
  readonly bodyToModel: Mat4;
}

/**
 * A model's constraint in the world: the joint, while it holds and one of its bodies is
 * simulated (between two keyframed or held bodies it is out of the world: #syncJoints).
 */
export interface PlacedJoint {
  joint: RAPIER.ImpulseJoint | undefined;
  readonly a: PlacedBody;
  readonly b: PlacedBody;
  readonly constraint: CollisionConstraint;
}

/** A keyframed body pulling a placed body by a joint (PhysicsWorld.addHitch). */
export interface Hitch {
  readonly body: RAPIER.RigidBody;
  /** Where the hitch is by the next step (game units). */
  move(world: Mat4): void;
  remove(): void;
}

/** The collision of one placed model (or landscape cell). */
export class PlacedCollision {
  readonly owner: PhysicsOwner;
  readonly bodies: readonly PlacedBody[];
  readonly colliders: readonly RAPIER.Collider[];
  /** The placement's uniform scale. */
  readonly scale: number;
  /** Bodies without model data (the one a landscape mesh hangs on). */
  readonly fixedBodies: readonly RAPIER.RigidBody[];
  /** The model's constraints between its bodies (removed with them). */
  readonly joints: readonly PlacedJoint[];

  constructor(
    owner: PhysicsOwner,
    bodies: readonly PlacedBody[],
    colliders: readonly RAPIER.Collider[],
    scale: number,
    fixedBodies: readonly RAPIER.RigidBody[] = [],
    joints: readonly PlacedJoint[] = [],
  ) {
    this.owner = owner;
    this.bodies = bodies;
    this.colliders = colliders;
    this.scale = scale;
    this.fixedBodies = fixedBodies;
    this.joints = joints;
  }

  /** Whether a body of this placement is simulated (the model moves with it). */
  get dynamic(): boolean {
    return this.bodies.some(({ data }) => data.motion === 'dynamic');
  }

  /**
   * The model's placement (game units, with its scale) following the first simulated body;
   * written into `out`. Returns false if nothing moves.
   */
  placement(out: Mat4): boolean {
    const moving = this.bodies.find(({ data }) => data.motion === 'dynamic');
    if (!moving) return false;
    const t = moving.body.translation();
    const pose = poseMatrix(
      [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE],
      moving.body.rotation(),
    );
    multiplyInto(pose, moving.bodyToModel, out);
    for (let i = 0; i < 12; i++) if (i % 4 !== 3) out[i] = (out[i] ?? 0) * this.scale;
    return true;
  }
}

/** What a sphere cast touched: where the sphere's centre was then, and the collider. */
export interface PickHit {
  readonly distance: number;
  readonly owner: PhysicsOwner | undefined;
  readonly layer: number;
  readonly collider: RAPIER.Collider;
  /** The sphere's centre when it touched (game units). */
  readonly point: Vec3;
}

export interface RayHit {
  /** Distance along the ray (game units). */
  readonly distance: number;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly layer: number;
  readonly owner: PhysicsOwner | undefined;
  /** The material id (MATT) of the shape hit (0: the landscape, by its land texture). */
  readonly material: number;
}

// --- Small math helpers -------------------------------------------------------------------

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Quaternion of the rotation part of a column-major matrix (assumed orthonormal). */
export function matrixQuaternion(m: Mat4): Quaternion {
  const m00 = m[0] ?? 1;
  const m11 = m[5] ?? 1;
  const m22 = m[10] ?? 1;
  const m01 = m[4] ?? 0;
  const m10 = m[1] ?? 0;
  const m02 = m[8] ?? 0;
  const m20 = m[2] ?? 0;
  const m12 = m[9] ?? 0;
  const m21 = m[6] ?? 0;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

/** Rigid matrix (game units) of a translation and a quaternion. */
export function poseMatrix(t: Vec3, q: Quaternion): Mat4 {
  const { x, y, z, w } = q;
  const m = new Float32Array(16);
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

/** A body the simulation moves (not a phantom). */
function dynamicBody(data: CollisionBody): boolean {
  return data.motion === 'dynamic' && !data.phantom;
}

/** A key for an unordered pair of colliders. */
function pairKey(a: number, b: number): string {
  return a < b ? `${String(a)}:${String(b)}` : `${String(b)}:${String(a)}`;
}

/** Whether a placed object hangs: simulated bodies on a fixed one (hanging game, chains). */
function isHung(placed: PlacedCollision): boolean {
  let fixed = false;
  let simulated = false;
  for (const { data } of placed.bodies) {
    if (data.phantom) continue;
    if (data.motion === 'fixed') fixed = true;
    else if (data.motion === 'dynamic') simulated = true;
  }
  return fixed && simulated && placed.joints.length > 0;
}

/** The inverse of a rotation and translation. */
function rigidInverse(m: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = m[row * 4 + col] ?? 0;
  }
  for (let row = 0; row < 3; row++) {
    out[12 + row] = -(
      (out[row] ?? 0) * (m[12] ?? 0) +
      (out[4 + row] ?? 0) * (m[13] ?? 0) +
      (out[8 + row] ?? 0) * (m[14] ?? 0)
    );
  }
  out[15] = 1;
  return out;
}

function multiplyInto(a: Mat4, b: Mat4, out: Mat4): void {
  const r = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      r[col * 4 + row] = sum;
    }
  }
  out.set(r);
}

/** Inverse of a rigid matrix. */
function invertRigid(m: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) out[col * 4 + row] = m[row * 4 + col] ?? 0;
  const tx = m[12] ?? 0;
  const ty = m[13] ?? 0;
  const tz = m[14] ?? 0;
  out[12] = -((out[0] ?? 0) * tx + (out[4] ?? 0) * ty + (out[8] ?? 0) * tz);
  out[13] = -((out[1] ?? 0) * tx + (out[5] ?? 0) * ty + (out[9] ?? 0) * tz);
  out[14] = -((out[2] ?? 0) * tx + (out[6] ?? 0) * ty + (out[10] ?? 0) * tz);
  out[15] = 1;
  return out;
}

/** Rotation that turns +Y (Rapier's capsule and cylinder axis) onto `direction`. */
function alignY(direction: Vec3): Quaternion {
  const length = Math.hypot(...direction) || 1;
  const [dx, dy, dz] = [direction[0] / length, direction[1] / length, direction[2] / length];
  // Half-way quaternion between (0, 1, 0) and d.
  const dot = dy;
  if (dot < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const x = dz;
  const y = 0;
  const z = -dx;
  const w = 1 + dot;
  const n = Math.hypot(x, y, z, w);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

const toHavok = (v: number): number => v / HAVOK_SCALE;

/** Rapier's raw joint set, which takes limits on any axis of any joint. */
interface RawJointLimits {
  readonly rawSet: {
    jointSetLimits(handle: number, axis: number, min: number, max: number): void;
    jointConfigureMotorPosition(
      handle: number,
      axis: number,
      target: number,
      stiffness: number,
      damping: number,
    ): void;
    jointConfigureMotorVelocity(handle: number, axis: number, target: number, factor: number): void;
    jointSetMotorMaxForce(handle: number, axis: number, maxForce: number): void;
  };
  readonly handle: number;
}

/**
 * How firmly a joint's friction holds its axis still (the motor's gain towards no relative
 * speed, per second): stiff, so that the friction's maximum torque alone decides when the joint
 * gives way, as Havok's friction (an angular or linear friction atom: no relative motion, up to
 * the constraint's maximum friction torque or force).
 */
const JOINT_FRICTION_GAIN = 1000;

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A collision hard enough to be heard (src/audio/impacts.ts). */
export interface PhysicsImpact {
  /** Where: the simulated body's position, game units. */
  readonly position: Vec3;
  /**
   * How hard the sides met: the speed the contact took out of their approach, game units per
   * second (the contact's impulse over the bodies' masses).
   */
  readonly speed: number;
  /** The simulated side's material and the material it hit (MATT ids; 0: unknown). */
  readonly material: number;
  readonly against: number;
  /** What it hit. */
  readonly againstKind: PhysicsOwner['kind'] | undefined;
  /** The simulated body (impacts are spaced out per body). */
  readonly body: number;
}

/** How thick a flat hull is made (Havok units): a sliver, its convex radius does the rest. */
const FLAT_HULL_THICKNESS = 0.001;

/** Whether Rapier can make the shape (it builds hulls only then, and fails on flat ones). */
function buildable(desc: RAPIER.ColliderDesc): boolean {
  // Typed as always made; undefined where Rapier could not make it.
  const raw = desc.shape.intoRaw() as ReturnType<RAPIER.Shape['intoRaw']> | undefined;
  if (!raw) return false;
  raw.free();
  return true;
}

/**
 * The convex hull of points (Havok units), grown by `radius`. Havok takes points that lie in
 * one plane (the Dragon Priest dagger's two shapes), its convex radius giving them thickness;
 * Rapier needs volume, so such points get a sliver of it along each axis.
 */
function hull(points: Float32Array, radius: number): RAPIER.ColliderDesc | undefined {
  const make = (from: Float32Array): RAPIER.ColliderDesc | null =>
    radius > 0
      ? RAPIER.ColliderDesc.roundConvexHull(from, radius)
      : RAPIER.ColliderDesc.convexHull(from);
  const desc = make(points);
  if (desc && buildable(desc)) return desc;
  const padded = new Float32Array(points.length * 4);
  padded.set(points);
  for (let axis = 0; axis < 3; axis++) {
    const offset = points.length * (axis + 1);
    for (let i = 0; i < points.length; i++) {
      padded[offset + i] = (points[i] ?? 0) + (i % 3 === axis ? FLAT_HULL_THICKNESS : 0);
    }
  }
  const thick = make(padded);
  return thick && buildable(thick) ? thick : undefined;
}

// --- World --------------------------------------------------------------------------------

export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly matrix: CollisionMatrix;
  /** Collision layer per collider handle. */
  readonly #layers = new Map<number, number>();
  readonly #owners = new Map<number, PhysicsOwner>();
  /** Material id (MATT) per collider handle. */
  readonly #materials = new Map<number, number>();
  /** The materials of all of an object's shapes, per collider of the object. */
  readonly #objectMaterials = new Map<number, ReadonlySet<number>>();
  readonly #hooks: RAPIER.PhysicsHooks;
  readonly #events = new RAPIER.EventQueue(true);
  #impacts: PhysicsImpact[] = [];
  /** Simulated bodies' velocities before the step (Havok units per second). */
  readonly #velocities = new Map<number, RAPIER.Vector>();
  /** Joints that break under too much force, while they hold. */
  readonly #breakable = new Set<PlacedJoint>();
  /**
   * The placed joints that have not broken, by the handles of their two bodies, and the scale
   * each one's frames are made at (Havok units per game unit of its placement).
   */
  readonly #jointsOf = new Map<number, PlacedJoint[]>();
  readonly #jointScales = new Map<PlacedJoint, number>();
  /** Bodies settling after being placed: silent until they first sleep (or this time). */
  readonly #settling = new Map<number, number>();
  /**
   * The system (one placed object of several bodies) of each of its colliders: its bodies do
   * not collide with one another (a hanging pheasant's body against the hook it hangs on).
   */
  readonly #systems = new Map<number, number>();
  #nextSystem = 1;
  /**
   * Hung objects placed to settle whose overlaps are looked for after the next step, with
   * where their bodies were placed (that step's push out of the overlap is undone).
   */
  readonly #hungToCheck: {
    readonly placed: PlacedCollision;
    readonly poses: readonly (readonly [RAPIER.Vector, RAPIER.Rotation])[];
  }[] = [];
  /** Collider pairs that never collide: a hung body and what it was placed into. */
  readonly #ignoredPairs = new Set<string>();
  /**
   * Simulated bodies placed to wait (until their cell settles, or for good: "Don't Havok
   * Settle", statics). Havok leaves a deactivated body where it is until an active one touches
   * it; Rapier wakes a sleeping body at its first contact, even with the wall it hangs on
   * (mounted antlers fell). So they are held as kinematic bodies, which meet nothing fixed,
   * and become simulated when something that moves touches them (the player, an object in
   * motion) or the player takes hold of them.
   */
  readonly #held = new Set<number>();
  /** Bodies just placed to settle, until when their overlaps only move them. */
  readonly #depenetrating = new Map<number, number>();
  /**
   * The simulated bodies' top speeds, as Havok's motions clamp them every step: the file's
   * maximum linear velocity (Havok units per second) and angular velocity (radians per second).
   */
  readonly #limits = new Map<number, { readonly linear: number; readonly angular: number }>();
  /** Simulated seconds. */
  #time = 0;
  /** Collision was placed or removed since the last step (queries do not see it yet). */
  #changed = false;
  #accumulator = 0;
  /**
   * Contacts below this speed (game units per second) make no sound and are not reported
   * (`[Audio] fMinSoundVel`); set before placing objects.
   */
  impactSpeed = 60;
  /**
   * How long bodies placed to settle (the engine's warm start, `[HAVOK] fWarmStartMaxTime`)
   * stay silent at most, if they do not fall asleep before.
   */
  settleSeconds = 4;
  /** At most this many steps per frame (`[HAVOK] uMaxNumPhysicsStepsPerUpdate`). */
  maxSteps = MAX_STEPS_PER_UPDATE;
  #step = PHYSICS_STEP;
  /**
   * Which simulated bodies are swept continuously (fDebrisMinExtent, fDebrisMaxVelocity:
   * DEBRIS_QUALITY); set before placing objects.
   */
  debris: DebrisQuality = DEBRIS_QUALITY;

  /** `gravity`: Havok units per second² (downwards). Call initPhysics() first. */
  constructor(matrix: CollisionMatrix, gravity: number) {
    this.matrix = matrix;
    this.world = new RAPIER.World({ x: 0, y: 0, z: -gravity });
    this.world.timestep = PHYSICS_STEP;
    this.world.integrationParameters.numSolverIterations = SOLVER_ITERATIONS;
    const layers = this.#layers;
    const systems = this.#systems;
    // Havok's group filter: layers that collide, and never two bodies of one object's system.
    const ignored = this.#ignoredPairs;
    const collides = (a: number, b: number): boolean => {
      const system = systems.get(a);
      if (system !== undefined && system === systems.get(b)) return false;
      if (ignored.size > 0 && ignored.has(pairKey(a, b))) return false;
      return matrix.collides(layers.get(a) ?? 0, layers.get(b) ?? 0);
    };
    this.#hooks = {
      filterContactPair: (a, b) => (collides(a, b) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null),
      filterIntersectionPair: collides,
    };
  }

  /** The fixed step (seconds; `[HAVOK] fMaxTime`); set before placing objects. */
  get stepSeconds(): number {
    return this.#step;
  }

  set stepSeconds(seconds: number) {
    if (!(seconds > 0)) return;
    this.#step = seconds;
    this.world.timestep = seconds;
  }

  /** The layer of a collider. */
  layerOf(collider: RAPIER.Collider): number {
    return this.#layers.get(collider.handle) ?? Layer.unidentified;
  }

  ownerOf(collider: RAPIER.Collider): PhysicsOwner | undefined {
    return this.#owners.get(collider.handle);
  }

  /** A filter for queries and the character controller: colliders `layer` collides with. */
  filterFor(layer: number): (collider: RAPIER.Collider) => boolean {
    return (collider) => this.matrix.collides(layer, this.layerOf(collider));
  }

  /** Gives a collider its layer, owner and material (colliders made outside this class). */
  register(collider: RAPIER.Collider, layer: number, owner: PhysicsOwner, material = 0): void {
    this.#layers.set(collider.handle, layer);
    this.#owners.set(collider.handle, owner);
    if (material !== 0) this.#materials.set(collider.handle, material);
  }

  unregister(collider: RAPIER.Collider): void {
    this.#layers.delete(collider.handle);
    this.#systems.delete(collider.handle);
    this.#owners.delete(collider.handle);
    this.#materials.delete(collider.handle);
    this.#objectMaterials.delete(collider.handle);
  }

  /** The material id (MATT) of a collider's surface; 0 if unknown. */
  materialOf(collider: RAPIER.Collider): number {
    return this.#materials.get(collider.handle) ?? 0;
  }

  /**
   * The materials of every shape of the object a collider belongs to (a staircase's steps and
   * its plain stone sides and risers are separate shapes).
   */
  objectMaterialsOf(collider: RAPIER.Collider): ReadonlySet<number> {
    return this.#objectMaterials.get(collider.handle) ?? new Set([this.materialOf(collider)]);
  }

  /** Builds the collider of one shape (body space, game units × `scale`). */
  #colliderDesc(
    shape: CollisionShape,
    scale: number,
    dynamic: boolean,
  ): RAPIER.ColliderDesc | undefined {
    const s = scale / HAVOK_SCALE;
    const point = (p: Vec3): RAPIER.Vector => ({ x: p[0] * s, y: p[1] * s, z: p[2] * s });
    const scaled = (values: Float32Array): Float32Array => {
      const out = new Float32Array(values.length);
      for (let i = 0; i < values.length; i++) out[i] = (values[i] ?? 0) * s;
      return out;
    };
    switch (shape.type) {
      case 'mesh': {
        // Simulated bodies get the hull of the mesh (Rapier does not collide two meshes).
        if (dynamic) return hull(scaled(shape.vertices), 0);
        if (shape.indices.length < 3) return undefined;
        return RAPIER.ColliderDesc.trimesh(scaled(shape.vertices), shape.indices);
      }
      case 'convex':
        return hull(scaled(shape.points), shape.radius * s);
      case 'box': {
        const [hx, hy, hz] = shape.halfExtents;
        const r = shape.radius * s;
        const desc =
          r > 0
            ? RAPIER.ColliderDesc.roundCuboid(hx * s, hy * s, hz * s, r)
            : RAPIER.ColliderDesc.cuboid(hx * s, hy * s, hz * s);
        desc.setTranslation(
          (shape.transform[12] ?? 0) * s,
          (shape.transform[13] ?? 0) * s,
          (shape.transform[14] ?? 0) * s,
        );
        desc.setRotation(matrixQuaternion(shape.transform));
        return desc;
      }
      case 'sphere':
        return RAPIER.ColliderDesc.ball(shape.radius * s).setTranslation(
          shape.center[0] * s,
          shape.center[1] * s,
          shape.center[2] * s,
        );
      case 'capsule':
      case 'cylinder': {
        const a = point(shape.a);
        const b = point(shape.b);
        const axis: Vec3 = [b.x - a.x, b.y - a.y, b.z - a.z];
        const half = Math.hypot(...axis) / 2;
        const radius = shape.radius * s;
        const desc =
          shape.type === 'capsule'
            ? RAPIER.ColliderDesc.capsule(half, radius)
            : shape.shell > 0
              ? RAPIER.ColliderDesc.roundCylinder(half, radius, shape.shell * s)
              : RAPIER.ColliderDesc.cylinder(half, radius);
        desc.setTranslation((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        if (half > 0) desc.setRotation(alignY(axis));
        return desc;
      }
    }
  }

  /**
   * Places a model's collision at `world` (game units; rotation, translation and uniform
   * scale). Simulated bodies settle under gravity as their cell loads (the engine's warm
   * start), or with `settle` false stay asleep where they were placed until something
   * touches them (REFR "Don't Havok Settle"). Fixed bodies on `animatedNodes` (lower-case
   * node names a behavior graph moves) are keyframed instead: they follow the pose (moveBody).
   */
  addObject(
    collision: CollisionData,
    world: Mat4,
    owner: PhysicsOwner,
    settle = true,
    animatedNodes?: ReadonlySet<string>,
  ): PlacedCollision {
    const scale = Math.hypot(world[0] ?? 0, world[1] ?? 0, world[2] ?? 0) || 1;
    const rigid = rigidPart(world);
    const bodies: PlacedBody[] = [];
    const colliders: RAPIER.Collider[] = [];
    for (const data of collision.bodies) {
      // The body's place in the model with the placement's scale applied to its offset.
      const local = new Float32Array(data.transform);
      local[12] = (local[12] ?? 0) * scale;
      local[13] = (local[13] ?? 0) * scale;
      local[14] = (local[14] ?? 0) * scale;
      const pose = new Float32Array(16);
      multiplyInto(rigid, local, pose);
      const rotation = matrixQuaternion(pose);
      const translation = {
        x: toHavok(pose[12] ?? 0),
        y: toHavok(pose[13] ?? 0),
        z: toHavok(pose[14] ?? 0),
      };
      const dynamic = data.motion === 'dynamic' && !data.phantom;
      const keyframed =
        data.motion === 'keyframed' ||
        (data.motion === 'fixed' && animatedNodes?.has(data.node.toLowerCase()) === true);
      const desc = dynamic
        ? RAPIER.RigidBodyDesc.dynamic()
            .setLinearDamping(data.linearDamping)
            .setAngularDamping(data.angularDamping)
            .setGravityScale(data.gravityFactor)
            .setSleeping(!settle)
            .setCcdEnabled(sweptBody(data, scale, this.debris))
        : keyframed
          ? RAPIER.RigidBodyDesc.kinematicPositionBased()
          : RAPIER.RigidBodyDesc.fixed();
      desc.setTranslation(translation.x, translation.y, translation.z).setRotation(rotation);
      const body = this.world.createRigidBody(desc);
      if (dynamic && data.maxLinearVelocity > 0 && data.maxAngularVelocity > 0) {
        this.#limits.set(body.handle, {
          linear: data.maxLinearVelocity,
          angular: data.maxAngularVelocity,
        });
      }
      if (dynamic && settle) {
        this.#settling.set(body.handle, this.#time + this.settleSeconds);
        this.#depenetrating.set(body.handle, this.#time + DEPENETRATE_SECONDS);
      }
      for (const shape of data.shapes) {
        const colliderDesc = this.#colliderDesc(shape, scale, dynamic);
        if (!colliderDesc) continue;
        // Havok combines friction and restitution as the square root of the product: with
        // each side's square root, Rapier's product rule gives the same.
        colliderDesc
          .setFriction(Math.sqrt(Math.max(0, data.friction)))
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setRestitution(Math.sqrt(Math.max(0, data.restitution)))
          .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setDensity(0)
          .setSensor(data.phantom);
        if (dynamic) {
          colliderDesc.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
          // Report contacts that take at least impactSpeed out of the body in one step.
          colliderDesc
            .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
            .setContactForceEventThreshold(
              (data.mass * toHavok(this.impactSpeed)) / this.stepSeconds,
            );
        }
        if (data.phantom) colliderDesc.setActiveHooks(RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS);
        const collider = this.world.createCollider(colliderDesc, body);
        this.register(collider, shape.layer, owner, shape.material);
        colliders.push(collider);
      }
      if (dynamic) {
        // The mass stays as authored; the shapes (and so the inertia) grow with the scale.
        const s = scale / HAVOK_SCALE;
        const [ix, iy, iz] = data.inertia;
        const inertiaScale = scale * scale;
        body.setAdditionalMassProperties(
          data.mass,
          {
            x: data.centerOfMass[0] * s,
            y: data.centerOfMass[1] * s,
            z: data.centerOfMass[2] * s,
          },
          { x: ix * inertiaScale, y: iy * inertiaScale, z: iz * inertiaScale },
          { x: 0, y: 0, z: 0, w: 1 },
          false,
        );
      }
      bodies.push({ body, data, bodyToModel: invertRigid(local) });
    }
    const materials = new Set(colliders.map((collider) => this.materialOf(collider)));
    for (const collider of colliders) this.#objectMaterials.set(collider.handle, materials);
    if (bodies.length > 1) {
      const system = this.#nextSystem++;
      for (const collider of colliders) this.#systems.set(collider.handle, system);
    }
    const joints: PlacedJoint[] = [];
    for (const constraint of collision.constraints ?? []) {
      const a = bodies[constraint.bodyA];
      const b = bodies[constraint.bodyB];
      if (!a || !b || a.body === b.body) continue;
      const placed: PlacedJoint = { joint: undefined, a, b, constraint };
      joints.push(placed);
      this.#jointScales.set(placed, scale / HAVOK_SCALE);
      for (const { body } of [a, b]) {
        const list = this.#jointsOf.get(body.handle);
        if (list) list.push(placed);
        else this.#jointsOf.set(body.handle, [placed]);
      }
      if (constraint.breakable) this.#breakable.add(placed);
    }
    this.#changed = true;
    const placed = new PlacedCollision(owner, bodies, colliders, scale, [], joints);
    if (settle && isHung(placed)) this.#checkHung(placed);
    // Placed to wait: held where they are until something that moves touches them.
    if (!settle) for (const { body, data } of bodies) if (dynamicBody(data)) this.#hold(body);
    this.#syncJoints(bodies.map(({ body }) => body));
    return placed;
  }

  /**
   * A Havok constraint as a Rapier joint (`toLocal`: game units of the body's space to Havok
   * units, the placement's scale applied). The frames carry over as they are: where the two
   * coincide the constraint is at its zero. Bodies held together do not collide with each
   * other. TODO(M13): Havok's ragdoll limits are a cone (twist axis within coneMaxAngle) and
   * two planes; here they are three angle ranges (twist, and the two swings each within the
   * cone, the one towards the plane axis also within the plane limits). Friction is a motor
   * towards no relative speed limited to the friction's maximum (in the file's units: the
   * placement's scale does not change it); the motors and malleable strength (softness) are not
   * applied: Rapier's joints are stiff (no vanilla constraint has a motor).
   */
  #createJoint(
    data: ConstraintData,
    bodyA: RAPIER.RigidBody,
    bodyB: RAPIER.RigidBody,
    toLocal: number,
  ): RAPIER.ImpulseJoint | undefined {
    const point = (v: Vec3): RAPIER.Vector => ({
      x: v[0] * toLocal,
      y: v[1] * toLocal,
      z: v[2] * toLocal,
    });
    const frame = (axes: readonly [Vec3, Vec3, Vec3]): RAPIER.Rotation => {
      const m = identity();
      const [x, y] = axes;
      // Orthonormal and right-handed (the files' axes are, to float precision).
      const z = cross(x, y);
      m.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0], 0);
      return matrixQuaternion(m);
    };
    const create = (joint: RAPIER.JointData): RAPIER.ImpulseJoint => {
      const made = this.world.createImpulseJoint(joint, bodyA, bodyB, false);
      made.setContactsEnabled(false);
      return made;
    };
    const limit = (
      joint: RAPIER.ImpulseJoint,
      axis: RAPIER.JointAxis,
      min: number,
      max: number,
    ) => {
      // Rapier keeps per-axis limits on every joint; the typed API exposes them only on
      // one-axis joints.
      const raw = joint as unknown as RawJointLimits;
      raw.rawSet.jointSetLimits(raw.handle, axis, Math.min(min, max), Math.max(min, max));
    };
    // A joint's friction: a motor towards no relative speed on its free axes, whose force is
    // the constraint's maximum friction (torque, kg·m²/s², or force; Havok units).
    const friction = (
      joint: RAPIER.ImpulseJoint,
      axes: readonly RAPIER.JointAxis[],
      max: number,
    ): void => {
      if (!(max > 0)) return;
      const raw = joint as unknown as RawJointLimits;
      for (const axis of axes) {
        raw.rawSet.jointConfigureMotorVelocity(raw.handle, axis, 0, JOINT_FRICTION_GAIN);
        raw.rawSet.jointSetMotorMaxForce(raw.handle, axis, max);
      }
    };
    switch (data.type) {
      case 'ball-and-socket':
        return create(RAPIER.JointData.spherical(point(data.pivotA), point(data.pivotB)));
      case 'stiff-spring':
        // TODO(M13): a stiff spring also pushes apart below its length; a rope only holds.
        return create(
          RAPIER.JointData.rope(data.length * toLocal, point(data.pivotA), point(data.pivotB)),
        );
      case 'hinge':
      case 'limited-hinge': {
        const joint = create(
          RAPIER.JointData.revolute(point(data.a.pivot), point(data.b.pivot), {
            x: 1,
            y: 0,
            z: 0,
          }),
        );
        joint.setLocalFrame1(point(data.a.pivot), frame(data.a.axes));
        joint.setLocalFrame2(point(data.b.pivot), frame(data.b.axes));
        if (data.type === 'limited-hinge') {
          limit(joint, RAPIER.JointAxis.AngX, data.minAngle, data.maxAngle);
          friction(joint, [RAPIER.JointAxis.AngX], data.maxFriction);
        }
        return joint;
      }
      case 'prismatic': {
        const joint = create(
          RAPIER.JointData.prismatic(point(data.a.pivot), point(data.b.pivot), {
            x: 1,
            y: 0,
            z: 0,
          }),
        );
        joint.setLocalFrame1(point(data.a.pivot), frame(data.a.axes));
        joint.setLocalFrame2(point(data.b.pivot), frame(data.b.axes));
        limit(joint, RAPIER.JointAxis.LinX, data.minDistance * toLocal, data.maxDistance * toLocal);
        friction(joint, [RAPIER.JointAxis.LinX], data.friction);
        return joint;
      }
      case 'ragdoll': {
        const joint = create(RAPIER.JointData.spherical(point(data.a.pivot), point(data.b.pivot)));
        joint.setLocalFrame1(point(data.a.pivot), frame(data.a.axes));
        joint.setLocalFrame2(point(data.b.pivot), frame(data.b.axes));
        const cone = Math.abs(data.coneMaxAngle);
        limit(joint, RAPIER.JointAxis.AngX, data.twistMinAngle, data.twistMaxAngle);
        limit(joint, RAPIER.JointAxis.AngY, -cone, cone);
        limit(
          joint,
          RAPIER.JointAxis.AngZ,
          Math.max(-cone, data.planeMinAngle),
          Math.min(cone, data.planeMaxAngle),
        );
        friction(
          joint,
          [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ],
          data.maxFriction,
        );
        return joint;
      }
      case 'malleable':
        return this.#createJoint(data.inner, bodyA, bodyB, toLocal);
    }
  }

  /**
   * The joints of the bodies are in the world while one of their two bodies is simulated, and out
   * of it while both are keyframed or held: Rapier solves a joint between two kinematic bodies
   * in every substep all the same, and the living actors' ragdolls (keyframed to their poses:
   * src/shell/actor-bodies.ts) took most of a step with their 17 joints each (Helgen's opening:
   * 3.5 of 4.8 ms a step, for 23 actors). A joint is made again from its constraint as a body
   * is let go (a death, a knock-down, a held body touched); a broken one is not.
   */
  #syncJoints(bodies: Iterable<RAPIER.RigidBody>): void {
    for (const body of bodies) {
      for (const placed of this.#jointsOf.get(body.handle) ?? []) {
        const a = placed.a.body;
        const b = placed.b.body;
        const needed = a.isValid() && b.isValid() && (a.isDynamic() || b.isDynamic());
        if (needed && !placed.joint) {
          const scale = this.#jointScales.get(placed) ?? 1 / HAVOK_SCALE;
          placed.joint = this.#createJoint(placed.constraint.data, a, b, scale);
        } else if (!needed && placed.joint) {
          if (placed.joint.isValid()) this.world.removeImpulseJoint(placed.joint, false);
          placed.joint = undefined;
        }
      }
    }
  }

  /** A joint is gone for good (broken, or its bodies removed). */
  #forgetJoint(placed: PlacedJoint): void {
    this.#breakable.delete(placed);
    this.#jointScales.delete(placed);
    for (const { body } of [placed.a, placed.b]) {
      const list = this.#jointsOf.get(body.handle);
      if (!list) continue;
      const left = list.filter((joint) => joint !== placed);
      if (left.length > 0) this.#jointsOf.set(body.handle, left);
      else this.#jointsOf.delete(body.handle);
    }
  }

  /**
   * Breakable constraints break when the impulse on them in a step exceeds their threshold
   * (Havok's units: kg·m/s, the beehive's 20 holding its 10 kg, a step taking 1.6). The joint's
   * impulse is not exposed: it is the change of momentum of its simulated body that gravity
   * does not explain (TODO(M13): contacts on the body count as well).
   */
  #breakJoints(): void {
    const gravity = this.world.gravity;
    for (const placed of this.#breakable) {
      const joint = placed.joint;
      const threshold = placed.constraint.breakable?.threshold ?? Infinity;
      // Out of the world while both its bodies are held (#syncJoints): nothing pulls on it.
      if (!joint) continue;
      if (!joint.isValid()) {
        this.#forgetJoint(placed);
        continue;
      }
      let impulse = 0;
      for (const { body, data } of [placed.a, placed.b]) {
        const before = this.#velocities.get(body.handle);
        if (!before || !body.isDynamic()) continue;
        const after = body.linvel();
        const g = data.gravityFactor * this.stepSeconds;
        impulse = Math.max(
          impulse,
          body.mass() *
            Math.hypot(
              after.x - before.x - gravity.x * g,
              after.y - before.y - gravity.y * g,
              after.z - before.z - gravity.z * g,
            ),
        );
      }
      if (impulse > threshold) {
        this.world.removeImpulseJoint(joint, true);
        placed.joint = undefined;
        this.#forgetJoint(placed);
      }
    }
  }

  /**
   * A collision primitive: a box (`bounds`: full size) or sphere (`bounds[0]`: radius) placed
   * at `world` (with its scale), on `layer`.
   */
  addPrimitive(
    shape: 'box' | 'sphere',
    bounds: Vec3,
    world: Mat4,
    layer: number,
    owner: PhysicsOwner,
  ): PlacedCollision {
    const scale = Math.hypot(world[0] ?? 0, world[1] ?? 0, world[2] ?? 0) || 1;
    const s = scale / HAVOK_SCALE;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(toHavok(world[12] ?? 0), toHavok(world[13] ?? 0), toHavok(world[14] ?? 0))
        .setRotation(matrixQuaternion(rigidPart(world))),
    );
    const desc =
      shape === 'box'
        ? RAPIER.ColliderDesc.cuboid((bounds[0] / 2) * s, (bounds[1] / 2) * s, (bounds[2] / 2) * s)
        : RAPIER.ColliderDesc.ball(bounds[0] * s);
    // A trigger's volume (a layer the data marks as one: L_TRIGGER) is felt, not solid.
    if ((this.matrix.flags(layer) & LayerFlag.triggerVolume) !== 0) desc.setSensor(true);
    const collider = this.world.createCollider(desc, body);
    this.register(collider, layer, owner);
    this.#changed = true;
    return new PlacedCollision(owner, [], [collider], scale, [body]);
  }

  /**
   * Moves a keyframed body of a placement to `modelPose` (its pose in the model, game units)
   * under the placement `world`, by the next step.
   */
  moveBody(placed: PlacedCollision, body: PlacedBody, modelPose: Mat4, world: Mat4): void {
    const local = rigidPart(modelPose);
    local[12] = (local[12] ?? 0) * placed.scale;
    local[13] = (local[13] ?? 0) * placed.scale;
    local[14] = (local[14] ?? 0) * placed.scale;
    const pose = new Float32Array(16);
    multiplyInto(rigidPart(world), local, pose);
    body.body.setNextKinematicTranslation({
      x: toHavok(pose[12] ?? 0),
      y: toHavok(pose[13] ?? 0),
      z: toHavok(pose[14] ?? 0),
    });
    body.body.setNextKinematicRotation(matrixQuaternion(pose));
  }

  /** Landscape (or any fixed triangle mesh) in game units, world space. */
  addMesh(
    vertices: Float32Array,
    indices: Uint32Array,
    layer: number,
    owner: PhysicsOwner,
  ): PlacedCollision {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const scaled = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i++) scaled[i] = (vertices[i] ?? 0) / HAVOK_SCALE;
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(scaled, indices)
        .setFriction(Math.sqrt(0.5))
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
      body,
    );
    this.register(collider, layer, owner);
    this.#changed = true;
    return new PlacedCollision(owner, [], [collider], 1, [body]);
  }

  remove(placed: PlacedCollision): void {
    // Removing a body removes its joints.
    for (const joint of placed.joints) this.#forgetJoint(joint);
    for (const collider of placed.colliders) this.unregister(collider);
    // Removing a body removes its colliders.
    for (const { body } of placed.bodies) {
      this.#held.delete(body.handle);
      this.#limits.delete(body.handle);
      this.world.removeRigidBody(body);
    }
    for (const body of placed.fixedBodies) this.world.removeRigidBody(body);
    this.#changed = true;
  }

  /**
   * Advances the simulation by `seconds` in fixed steps, calling `beforeStep` before each
   * (characters move there); returns the steps taken.
   */
  step(seconds: number, beforeStep?: (step: number) => void): number {
    this.#accumulator = Math.min(this.#accumulator + seconds, this.stepSeconds * this.maxSteps);
    let steps = 0;
    while (this.#accumulator >= this.stepSeconds) {
      beforeStep?.(this.stepSeconds);
      this.#recordVelocities();
      this.world.step(this.#events, this.#hooks);
      this.#changed = false;
      if (this.#limits.size > 0) this.#limitVelocities();
      this.#time += this.stepSeconds;
      if (this.#depenetrating.size > 0) this.#depenetrate();
      if (this.#held.size > 0) this.#releaseTouched();
      if (this.#hungToCheck.length > 0) this.#ignoreHungOverlaps();
      if (this.#breakable.size > 0) this.#breakJoints();
      this.#collectImpacts();
      this.#accumulator -= this.stepSeconds;
      steps++;
    }
    return steps;
  }

  /**
   * Lets a placed object's simulated bodies settle (the warm start): they wake, and make no
   * impact sounds until they first sleep (at most settleSeconds).
   */
  settle(placed: PlacedCollision): void {
    if (isHung(placed)) this.#checkHung(placed);
    for (const { body } of placed.bodies) this.release(body);
    for (const { body, data } of placed.bodies) {
      if (data.motion !== 'dynamic' || data.phantom) continue;
      body.wakeUp();
      this.#settling.set(body.handle, this.#time + this.settleSeconds);
      this.#depenetrating.set(body.handle, this.#time + DEPENETRATE_SECONDS);
    }
  }

  /** Looks for a hung object's overlaps after the next step (HUNG_OVERLAP). */
  #checkHung(placed: PlacedCollision): void {
    this.#hungToCheck.push({
      placed,
      poses: placed.bodies.map(({ body }) => [{ ...body.translation() }, { ...body.rotation() }]),
    });
  }

  /** Holds a simulated body where it is (see #held). */
  #hold(body: RAPIER.RigidBody): void {
    body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i);
      collider.setActiveEvents(collider.activeEvents() | RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
    this.#held.add(body.handle);
    this.#syncJoints([body]);
  }

  /**
   * A keyframed body that pulls a placed body by a joint (a cart's tether to its horse:
   * src/shell/actor-vehicles.ts): `at` is where it starts (game units), the frames are in game
   * units, `a` in the pulled body's space and `b` in the hitch's (axes: the slide, the
   * perpendicular); the pulled body slides along the axis between the limits and turns as the
   * hitch does (held, or springing back to it: `turnSpring`). It has no shape.
   */
  addHitch(
    pulled: PlacedBody,
    at: Mat4,
    joint: {
      readonly a: ConstraintFrame;
      readonly b: ConstraintFrame;
      readonly minDistance: number;
      readonly maxDistance: number;
      readonly turnSpring?: { readonly stiffness: number; readonly damping: number };
    },
  ): Hitch {
    const rigid = rigidPart(at);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(toHavok(rigid[12] ?? 0), toHavok(rigid[13] ?? 0), toHavok(rigid[14] ?? 0))
        .setRotation(matrixQuaternion(rigid)),
    );
    const point = (v: Vec3): RAPIER.Vector => ({
      x: toHavok(v[0]),
      y: toHavok(v[1]),
      z: toHavok(v[2]),
    });
    const frame = (axes: readonly [Vec3, Vec3, Vec3]): RAPIER.Rotation => {
      const m = identity();
      const [x, y] = axes;
      const z = cross(x, y);
      m.set([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0], 0);
      return matrixQuaternion(m);
    };
    // Along the slide (x) it slides between the limits, across it it is held; its turns spring
    // back to how the two were joined (turnSpring; without one they are held). TODO(M13): the
    // engine's joint (a prismatic one) holds them outright, and Havok's solver gives way to the
    // wheels' extra pull and to the horse's sharp turns; Rapier's joints are stiff, so held the
    // cart's rear wheels hung above the ground on any slope the horse did not share, and on
    // Helgen's road's hairpin the horse's turn on the spot threw the cart over.
    const turns = RAPIER.JointAxesMask.AngX | RAPIER.JointAxesMask.AngY | RAPIER.JointAxesMask.AngZ;
    const locked =
      RAPIER.JointAxesMask.LinY | RAPIER.JointAxesMask.LinZ | (joint.turnSpring ? 0 : turns);
    const made = this.world.createImpulseJoint(
      RAPIER.JointData.generic(
        point(joint.a.pivot),
        point(joint.b.pivot),
        { x: 1, y: 0, z: 0 },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- a mask of its flags
        locked,
      ),
      pulled.body,
      body,
      true,
    );
    made.setContactsEnabled(false);
    made.setLocalFrame1(point(joint.a.pivot), frame(joint.a.axes));
    made.setLocalFrame2(point(joint.b.pivot), frame(joint.b.axes));
    const raw = made as unknown as RawJointLimits;
    raw.rawSet.jointSetLimits(
      raw.handle,
      RAPIER.JointAxis.LinX,
      toHavok(joint.minDistance),
      toHavok(joint.maxDistance),
    );
    // The turns spring back (accelerations: stiffness in 1/s², damping in 1/s).
    const spring = joint.turnSpring;
    if (spring) {
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
        raw.rawSet.jointConfigureMotorPosition(
          raw.handle,
          axis,
          0,
          spring.stiffness,
          spring.damping,
        );
      }
    }
    pulled.body.wakeUp();
    const world = this.world;
    return {
      body,
      move(to: Mat4): void {
        const pose = rigidPart(to);
        body.setNextKinematicTranslation({
          x: toHavok(pose[12] ?? 0),
          y: toHavok(pose[13] ?? 0),
          z: toHavok(pose[14] ?? 0),
        });
        body.setNextKinematicRotation(matrixQuaternion(pose));
      },
      remove(): void {
        if (made.isValid()) world.removeImpulseJoint(made, true);
        if (body.isValid()) world.removeRigidBody(body);
      },
    };
  }

  /**
   * Gives a simulated body of a placement other physical properties (a tethered cart's:
   * src/shell/actor-vehicles.ts): its mass (the inertia scaled with it), its shapes' friction,
   * its damping and how much gravity pulls it.
   */
  tuneBody(
    placed: PlacedCollision,
    target: PlacedBody,
    tuning: {
      readonly mass?: number;
      readonly friction?: number;
      readonly linearDamping?: number;
      readonly angularDamping?: number;
      readonly gravityScale?: number;
    },
  ): void {
    const { body, data } = target;
    if (tuning.mass !== undefined && data.mass > 0) {
      const s = placed.scale / HAVOK_SCALE;
      const share = (tuning.mass / data.mass) * placed.scale * placed.scale;
      const [ix, iy, iz] = data.inertia;
      body.setAdditionalMassProperties(
        tuning.mass,
        { x: data.centerOfMass[0] * s, y: data.centerOfMass[1] * s, z: data.centerOfMass[2] * s },
        { x: ix * share, y: iy * share, z: iz * share },
        { x: 0, y: 0, z: 0, w: 1 },
        true,
      );
    }
    if (tuning.friction !== undefined) {
      for (let i = 0; i < body.numColliders(); i++) {
        body.collider(i).setFriction(Math.sqrt(Math.max(0, tuning.friction)));
      }
    }
    if (tuning.linearDamping !== undefined) body.setLinearDamping(tuning.linearDamping);
    if (tuning.angularDamping !== undefined) body.setAngularDamping(tuning.angularDamping);
    if (tuning.gravityScale !== undefined) body.setGravityScale(tuning.gravityScale, true);
  }

  /** Two sets of colliders do not touch each other (or do again: `ignored` false). */
  ignoreBetween(
    a: readonly RAPIER.Collider[],
    b: readonly RAPIER.Collider[],
    ignored = true,
  ): void {
    for (const first of a) {
      for (const second of b) {
        const key = pairKey(first.handle, second.handle);
        if (ignored) this.#ignoredPairs.add(key);
        else this.#ignoredPairs.delete(key);
      }
    }
  }

  /**
   * Keeps a placed object's simulated bodies keyframed (as a script's SetMotionType does): they
   * stay where they are whatever touches them.
   */
  keyframe(placed: PlacedCollision): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.#held.delete(body.handle);
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
    }
    this.#syncJoints(placed.bodies.map(({ body }) => body));
  }

  /**
   * A placement leaves the simulation or comes back (its reference disabled or enabled by a
   * script): its bodies and colliders stay, switched off, so it returns where it was.
   */
  setEnabled(placed: PlacedCollision, enabled: boolean): void {
    for (const { body } of placed.bodies) body.setEnabled(enabled);
    for (const body of placed.fixedBodies) body.setEnabled(enabled);
    for (const collider of placed.colliders) collider.setEnabled(enabled);
    this.#changed = true;
  }

  /**
   * A script moved the placement (MoveTo, SetPosition, SetAngle): every body follows the
   * model from `from` to `to` (placements, game units), at rest. Held bodies stay held.
   */
  teleport(placed: PlacedCollision, from: Mat4, to: Mat4): void {
    const delta = new Float32Array(16);
    multiplyInto(rigidPart(to), rigidInverse(rigidPart(from)), delta);
    const pose = new Float32Array(16);
    for (const { body } of [...placed.bodies, ...placed.fixedBodies.map((body) => ({ body }))]) {
      const t = body.translation();
      multiplyInto(
        delta,
        poseMatrix([t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE], body.rotation()),
        pose,
      );
      body.setTranslation(
        { x: toHavok(pose[12] ?? 0), y: toHavok(pose[13] ?? 0), z: toHavok(pose[14] ?? 0) },
        true,
      );
      body.setRotation(matrixQuaternion(pose), true);
      if (body.isDynamic()) {
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
    this.#changed = true;
  }

  /**
   * SetMotionType: keyframed bodies stay where they are; dynamic ones move from now on (a
   * held body no longer waits for the player's touch: a script's action wakes it).
   */
  setMotion(placed: PlacedCollision, keyframed: boolean): void {
    if (keyframed) {
      this.keyframe(placed);
      return;
    }
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.#held.delete(body.handle);
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    }
    this.#syncJoints(placed.bodies.map(({ body }) => body));
  }

  /**
   * Sets the velocity of a placement's simulated bodies: `linear` in game units a second (made
   * Havok's here), `angular` in radians a second (a cut head flung off: src/shell/actor-
   * dismemberment.ts).
   */
  setVelocity(placed: PlacedCollision, linear: Vec3, angular: Vec3): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.release(body);
      body.setLinvel({ x: toHavok(linear[0]), y: toHavok(linear[1]), z: toHavok(linear[2]) }, true);
      body.setAngvel({ x: angular[0], y: angular[1], z: angular[2] }, true);
    }
  }

  /**
   * Takes one body of a placement out of collision (its colliders off; it keeps its joints and
   * moves with them): the hidden head of a decapitated body.
   */
  disableBody(body: PlacedBody): void {
    for (let i = 0; i < body.body.numColliders(); i++) body.body.collider(i).setEnabled(false);
    this.#changed = true;
  }

  /** ApplyHavokImpulse: a push (direction and magnitude in Havok units) on its bodies. */
  impulse(placed: PlacedCollision, direction: Vec3, magnitude: number): void {
    const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.release(body);
      body.applyImpulse(
        {
          x: (direction[0] / length) * magnitude,
          y: (direction[1] / length) * magnitude,
          z: (direction[2] / length) * magnitude,
        },
        true,
      );
    }
  }

  /**
   * An explosion's push on an object's moving bodies (src/gameplay/magic/explosions.ts): each
   * along the way from `center` to it (lifted by its up bias), as `push` says for its layer and
   * mass (game units, made Havok's here), with a random spin of up to its angular impulse.
   */
  pushFrom(
    placed: PlacedCollision,
    center: Vec3,
    push: (layer: number, mass: number) => BodyPush,
  ): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      const t = body.translation();
      const way: Vec3 = [
        t.x * HAVOK_SCALE - center[0],
        t.y * HAVOK_SCALE - center[1],
        t.z * HAVOK_SCALE - center[2],
      ];
      const length = Math.hypot(...way);
      const unit: Vec3 =
        length > 1e-6 ? [way[0] / length, way[1] / length, way[2] / length] : [0, 0, 0];
      const { linear, upBias, angular } = push(data.layer, data.mass);
      if (linear <= 0 && angular <= 0) continue;
      this.release(body);
      const scale = linear / HAVOK_SCALE;
      body.applyImpulse(
        { x: unit[0] * scale, y: unit[1] * scale, z: (unit[2] + upBias) * scale },
        true,
      );
      const spin = (): number => (Math.random() * 2 - 1) * (angular / HAVOK_SCALE);
      body.applyTorqueImpulse({ x: spin(), y: spin(), z: spin() }, true);
    }
  }

  /**
   * A body's speed set toward a point (game units): `gain` × the way there a second, at most
   * `limit` units a second (a held ragdoll's root).
   */
  pullBody(placed: PlacedBody, point: Vec3, gain: number, limit: number): void {
    const body = placed.body;
    if (!body.isValid() || !body.isDynamic()) return;
    const t = body.translation();
    const way: Vec3 = [
      point[0] - t.x * HAVOK_SCALE,
      point[1] - t.y * HAVOK_SCALE,
      point[2] - t.z * HAVOK_SCALE,
    ];
    const distance = Math.hypot(...way);
    const speed = Math.min(limit, distance * gain);
    const scale = distance > 1e-6 ? speed / distance / HAVOK_SCALE : 0;
    body.setLinvel({ x: way[0] * scale, y: way[1] * scale, z: way[2] * scale }, true);
  }

  /**
   * A push that adds the same speed along `direction` to each of a placement's simulated bodies
   * (Havok units a second; set as velocity, so it holds for bodies just made dynamic, whose
   * masses the next step computes), so a ragdoll flies off as one.
   */
  kick(placed: PlacedCollision, direction: Vec3, speed: number): void {
    const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const scale = speed / length;
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.release(body);
      const v = body.linvel();
      body.setLinvel(
        {
          x: v.x + direction[0] * scale,
          y: v.y + direction[1] * scale,
          z: v.z + direction[2] * scale,
        },
        true,
      );
    }
  }

  /**
   * The trigger volumes (colliders on layers flagged "trigger volume") a collider overlaps now:
   * their owners' references (a trap's trigger, a quest's activator box).
   */
  triggersOverlapping(collider: RAPIER.Collider): Set<number> {
    return this.#triggersIn(collider.translation(), collider.rotation(), collider.shape, collider);
  }

  /**
   * The trigger volumes a ball overlaps (`center` and `radius` in game units): those an actor
   * without a controller reaches (a flier in the air: MQ101SetStage99 across Alduin's way).
   */
  triggersNear(center: Vec3, radius: number): Set<number> {
    return this.#triggersIn(
      { x: toHavok(center[0]), y: toHavok(center[1]), z: toHavok(center[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Ball(toHavok(radius)),
    );
  }

  #triggersIn(
    translation: RAPIER.Vector,
    rotation: RAPIER.Rotation,
    shape: RAPIER.Shape,
    exclude?: RAPIER.Collider,
  ): Set<number> {
    const found = new Set<number>();
    this.world.intersectionsWithShape(
      translation,
      rotation,
      shape,
      (other) => {
        if (!other.isEnabled()) return true;
        if ((this.matrix.flags(this.layerOf(other)) & LayerFlag.triggerVolume) === 0) return true;
        const reference = this.ownerOf(other)?.reference;
        if (reference !== undefined && reference !== 0) found.add(reference);
        return true;
      },
      undefined,
      undefined,
      exclude,
    );
    return found;
  }

  /** A held body moves from now on (settled, touched, taken hold of); others are left. */
  release(body: RAPIER.RigidBody): void {
    if (!this.#held.delete(body.handle)) return;
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.#syncJoints([body]);
  }

  /** Something moving (the player's shape) touched a collider: a held body under it moves. */
  touch(collider: RAPIER.Collider): void {
    const body = collider.parent();
    if (body) this.release(body);
  }

  /** Held bodies that something moving touched in the step move from now on. */
  #releaseTouched(): void {
    this.#events.drainCollisionEvents((a, b, started) => {
      if (!started) return;
      const one = this.world.getCollider(a).parent();
      const other = this.world.getCollider(b).parent();
      if (!one || !other) return;
      const moves = (body: RAPIER.RigidBody): boolean =>
        !this.#held.has(body.handle) && !body.isFixed();
      if (this.#held.has(one.handle) && moves(other)) this.release(one);
      if (this.#held.has(other.handle) && moves(one)) this.release(other);
    });
  }

  /**
   * Whether a body of a placement (of `nodes`, lower-case node names; all when undefined)
   * touches something not of the placement now (a contact point in the last step).
   */
  touching(placed: PlacedCollision, nodes?: ReadonlySet<string>): boolean {
    const narrow = this.world.narrowPhase;
    const own = new Set(placed.colliders.map((collider) => collider.handle));
    for (const { body, data } of placed.bodies) {
      if (nodes && !nodes.has(data.node.toLowerCase())) continue;
      for (let i = 0; i < body.numColliders(); i++) {
        const handle = body.collider(i).handle;
        const touches = { found: false };
        narrow.contactPairsWith(handle, (other) => {
          if (touches.found || own.has(other)) return;
          narrow.contactPair(handle, other, this.world.bodies, (manifold) => {
            if (manifold.numContacts() > 0) touches.found = true;
          });
        });
        if (touches.found) return true;
      }
    }
    return false;
  }

  /** Lets hung objects' bodies pass through what they were placed into (HUNG_OVERLAP). */
  #ignoreHungOverlaps(): void {
    const narrow = this.world.narrowPhase;
    for (const { placed, poses } of this.#hungToCheck.splice(0)) {
      const own = new Set(placed.colliders.map((collider) => collider.handle));
      const before = this.#ignoredPairs.size;
      for (const { body, data } of placed.bodies) {
        if (data.motion !== 'dynamic') continue;
        for (let i = 0; i < body.numColliders(); i++) {
          const handle = body.collider(i).handle;
          narrow.contactPairsWith(handle, (other) => {
            if (own.has(other)) return;
            narrow.contactPair(handle, other, this.world.bodies, (manifold) => {
              for (let k = 0; k < manifold.numContacts(); k++) {
                if (manifold.contactDist(k) < -HUNG_OVERLAP) {
                  this.#ignoredPairs.add(pairKey(handle, other));
                  return;
                }
              }
            });
          });
        }
      }
      // Pushed out of what it now passes through by that first step: back to its place.
      if (this.#ignoredPairs.size === before) continue;
      const still = { x: 0, y: 0, z: 0 };
      placed.bodies.forEach(({ body }, i) => {
        const pose = poses[i];
        if (!pose || !body.isDynamic()) return;
        body.setTranslation(pose[0], false);
        body.setRotation(pose[1], false);
        body.setLinvel(still, false);
        body.setAngvel(still, false);
      });
    }
  }

  /** Clamps the moving bodies' speeds to their top speeds (#limits). */
  #limitVelocities(): void {
    for (const [handle, limit] of this.#limits) {
      const body = this.world.getRigidBody(handle) as RAPIER.RigidBody | null;
      if (!body) {
        this.#limits.delete(handle);
        continue;
      }
      if (!body.isDynamic() || body.isSleeping()) continue;
      const v = body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > limit.linear) {
        const k = limit.linear / speed;
        body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false);
      }
      const w = body.angvel();
      const turn = Math.hypot(w.x, w.y, w.z);
      if (turn > limit.angular) {
        const k = limit.angular / turn;
        body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false);
      }
    }
  }

  /** Takes from bodies placed a moment ago the speed the step gave them (DEPENETRATE_SECONDS). */
  #depenetrate(): void {
    const still = { x: 0, y: 0, z: 0 };
    for (const [handle, until] of this.#depenetrating) {
      const body = this.world.getRigidBody(handle) as RAPIER.RigidBody | null;
      if (!body || this.#time >= until) {
        this.#depenetrating.delete(handle);
        // Held still, it may have fallen asleep in the air: it settles from now on.
        body?.wakeUp();
        continue;
      }
      body.setLinvel(still, false);
      body.setAngvel(still, false);
    }
  }

  /** The impacts since the last call. */
  drainImpacts(): PhysicsImpact[] {
    const impacts = this.#impacts;
    this.#impacts = [];
    return impacts;
  }

  /** Turns the step's contact force events into impacts of the simulated side. */
  #recordVelocities(): void {
    this.#velocities.clear();
    this.world.bodies.forEach((body) => {
      if (!body.isDynamic() || body.isSleeping()) return;
      this.#velocities.set(body.handle, body.linvel());
    });
    // A settling body is placed for good once it first sleeps.
    for (const [handle, until] of this.#settling) {
      const body = this.world.getRigidBody(handle) as RAPIER.RigidBody | null;
      if (!body || body.isSleeping() || this.#time >= until) this.#settling.delete(handle);
    }
  }

  /**
   * Turns the step's contact force events into impacts: the force (above each body's
   * threshold) only says something touched hard; how hard they met is the speed at which they
   * approached along the contact before the step (resting and pushing contacts approach at
   * about nothing, however hard they press).
   */
  #collectImpacts(): void {
    this.#events.drainContactForceEvents((event) => {
      const a = this.world.getCollider(event.collider1());
      const b = this.world.getCollider(event.collider2());
      const bodyA = a.parent();
      const bodyB = b.parent();
      const velocity = (body: RAPIER.RigidBody | null): RAPIER.Vector =>
        !body
          ? { x: 0, y: 0, z: 0 }
          : body.isDynamic()
            ? (this.#velocities.get(body.handle) ?? { x: 0, y: 0, z: 0 })
            : body.linvel();
      const n = event.maxForceDirection();
      const va = velocity(bodyA);
      const vb = velocity(bodyB);
      const speed =
        Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y + (va.z - vb.z) * n.z) * HAVOK_SCALE;
      if (speed < this.impactSpeed) return;
      // The simulated side hits the other (of two simulated bodies, the faster one).
      const speedOf = (v: RAPIER.Vector): number => Math.hypot(v.x, v.y, v.z);
      const aMoves =
        bodyA?.isDynamic() === true && (!bodyB?.isDynamic() || speedOf(va) >= speedOf(vb));
      const [mover, other] = aMoves ? [a, b] : [b, a];
      const body = mover.parent();
      if (!body?.isDynamic() || this.#settling.has(body.handle)) return;
      const at = body.translation();
      this.#impacts.push({
        position: [at.x * HAVOK_SCALE, at.y * HAVOK_SCALE, at.z * HAVOK_SCALE],
        speed,
        material: this.materialOf(mover),
        against: this.materialOf(other),
        againstKind: this.ownerOf(other)?.kind,
        body: body.handle,
      });
    });
  }

  /**
   * Whether ray and shape casts see all placed collision: Rapier updates what queries search
   * (its broad phase) in a step, so what was placed or removed since is not there yet.
   */
  get queriesCurrent(): boolean {
    return !this.#changed;
  }

  /** How far into the next step the clock is (0..1), for drawing between steps. */
  get alpha(): number {
    return this.#accumulator / this.stepSeconds;
  }

  /** The first collider along a ray (game units) that `layer` collides with. */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    layer: number,
    exclude?: RAPIER.Collider,
  ): RayHit | undefined {
    const length = Math.hypot(...direction) || 1;
    const ray = new RAPIER.Ray(
      { x: toHavok(origin[0]), y: toHavok(origin[1]), z: toHavok(origin[2]) },
      { x: direction[0] / length, y: direction[1] / length, z: direction[2] / length },
    );
    // Phantoms (trigger volumes) are not surfaces: the character controller passes them too.
    const hit = this.world.castRayAndGetNormal(
      ray,
      toHavok(maxDistance),
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      exclude,
      undefined,
      this.filterFor(layer),
    );
    if (!hit) return undefined;
    const distance = hit.timeOfImpact * HAVOK_SCALE;
    return {
      distance,
      point: [
        origin[0] + (direction[0] / length) * distance,
        origin[1] + (direction[1] / length) * distance,
        origin[2] + (direction[2] / length) * distance,
      ],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      layer: this.layerOf(hit.collider),
      owner: this.ownerOf(hit.collider),
      material: this.materialOf(hit.collider),
    };
  }

  /**
   * How far a sphere (game units) travels along a ray before it touches something `layer`
   * collides with; `distance` if nothing is in the way. `ignore`: owners passed through (the
   * dead player's camera passes their own ragdoll).
   */
  sphereCast(
    origin: Vec3,
    direction: Vec3,
    distance: number,
    radius: number,
    layer: number,
    exclude?: RAPIER.Collider,
    ignore?: (owner: PhysicsOwner | undefined) => boolean,
  ): number {
    return (
      this.pick(origin, direction, distance, radius, layer, exclude, ignore)?.distance ?? distance
    );
  }

  /** What a sphere (game units) moving along a ray touches first, of what `layer` hits. */
  pick(
    origin: Vec3,
    direction: Vec3,
    distance: number,
    radius: number,
    layer: number,
    exclude?: RAPIER.Collider,
    ignore?: (owner: PhysicsOwner | undefined) => boolean,
  ): PickHit | undefined {
    const filter = this.filterFor(layer);
    const length = Math.hypot(...direction) || 1;
    const hit = this.world.castShape(
      { x: toHavok(origin[0]), y: toHavok(origin[1]), z: toHavok(origin[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: direction[0] / length, y: direction[1] / length, z: direction[2] / length },
      new RAPIER.Ball(toHavok(radius)),
      0,
      toHavok(distance),
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      exclude,
      undefined,
      ignore
        ? (collider: RAPIER.Collider) => filter(collider) && !ignore(this.ownerOf(collider))
        : filter,
    );
    if (!hit) return undefined;
    const along = Math.min(distance, hit.time_of_impact * HAVOK_SCALE);
    return {
      distance: along,
      owner: this.ownerOf(hit.collider),
      layer: this.layerOf(hit.collider),
      collider: hit.collider,
      point: [
        origin[0] + (direction[0] / length) * along,
        origin[1] + (direction[1] / length) * along,
        origin[2] + (direction[2] / length) * along,
      ],
    };
  }

  /**
   * The simulated body of a placed object's collider, which the player can take hold of; with
   * `corpse`, a dead actor's ragdoll body (dragging it: bAllowHavokGrabTheLiving is 0, so never
   * a living one's; the caller knows which are dead).
   */
  grabbable(collider: RAPIER.Collider, corpse = false): RAPIER.RigidBody | undefined {
    const kind = this.ownerOf(collider)?.kind;
    if (kind !== 'object' && !(corpse && kind === 'actor')) return undefined;
    const body = collider.parent();
    return body && (body.isDynamic() || this.#held.has(body.handle)) ? body : undefined;
  }

  free(): void {
    this.world.free();
  }
}
