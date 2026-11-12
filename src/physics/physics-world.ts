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
  rigidPartInto,
  smallestExtent,
  type CollisionBody,
  type CollisionConstraint,
  type CollisionData,
  type CollisionShape,
} from './collision-data.ts';
import { Layer, LayerFlag, type CollisionMatrix } from './collision-layers.ts';
import { queryShape } from './query-shape.ts';
import type { BodyPush } from '../gameplay/magic/explosions.ts';
import { PENETRATION_DEFAULTS, type PenetrationSettings } from './ragdoll-penetration.ts';
import { integrate, type BodyFrame, type BodyMotion } from './keyframe-hierarchy.ts';
import {
  slowBodyFactor,
  HAVOK_TAU_RATIO,
  SOLVER_DEFAULTS,
  solverSettings,
  solveJoints,
  easedLimit,
  EASED_EXCESS,
  jointLimitGive,
  HINGE_LIMIT_TAU_FACTOR,
  RAGDOLL_LIMIT_TAU_FACTOR,
  type JointMotor,
  type SolverConstraint,
  type SolverJoint,
  type SolverSettings,
} from './constraint-solver.ts';
import {
  groupImpulses,
  solverResultSize,
  type GroupJoint,
  type ImpulseBody,
} from './joint-impulses.ts';

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
 * mode by fMaxTimeComplex, uMaxNumPhysicsStepsPerUpdateComplex times at most (observed in the
 * original). The mode is on in a complex scene (PhysicsWorld.complex: inferred, TODO(M13)).
 */
export const PHYSICS_STEP = 1 / 60;
/** Past this along any axis (Havok units) a simulated body is out of the world (#leaveBounds). */
export const WORLD_BOUNDS = 16384;
/** How often it is looked for (seconds). */
const BOUNDS_CHECK = 0.25;

/**
 * At most this many steps per frame ([HAVOK] uMaxNumPhysicsStepsPerUpdate's built-in value; the
 * sessions set PhysicsWorld.maxSteps from the INI): a longer frame's rest is made up in later
 * frames (PhysicsWorld.step).
 */
export const MAX_STEPS_PER_UPDATE = 3;
/** A frame shorter than this (seconds) steps nothing; its time is owed (observed in the original). */
export const MIN_FRAME_SECONDS = 0.001;

/** The shortest share of its step the world steps at (a time multiplier of 0 stops it). */
const MIN_TIME_SCALE = 0.01;
/** Rounding allowance of the step clock (seconds). */
const STEP_EPSILON = 1e-9;
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
  data: Pick<CollisionBody, 'quality' | 'maxLinearVelocity' | 'shapes' | 'penetrationDepth'>,
  scale: number,
  debris: DebrisQuality,
): boolean {
  const extent = (smallestExtent(data.shapes) * scale) / HAVOK_SCALE;
  if (extent > debris.minExtent || data.maxLinearVelocity * HAVOK_SCALE < debris.maxVelocity)
    return false;
  // Havok's time of impact steps in only where a body may go deeper into another in a step than
  // its allowed penetration depth (its own, Havok units): one whose top speed covers no more
  // than that in a step is never swept. TODO(M13): Havok also sweeps by it within the step (a
  // body's TOI only past that depth); Rapier's CCD has no per-body depth.
  const allowed = data.penetrationDepth ?? 0;
  if (allowed > 0 && data.maxLinearVelocity * PHYSICS_STEP <= allowed) return false;
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
 * The most point joints solved with a breakable one (#solveBreakable): the mace trap's pin and
 * chain are 13; a ragdoll's are under 30.
 */
const BREAKABLE_GROUP_JOINTS = 64;
/**
 * Placed bodies start with what overlaps their placement leaves (books whose corners reach
 * into a shelf's back panel, a cover into the board under it): for this long after they are
 * placed to settle, the solver's push out of those overlaps only moves them, without the speed
 * it would give them (Havok recovers penetrations slowly; Rapier's push sent books off their
 * shelves). TODO(M13): the original's warm start is plain stepping (docs/physics.md, "The warm
 * start"); Rapier's push out is the harder one.
 */
const DEPENETRATE_SECONDS = 0.5;
/**
 * Hung objects (a fixed body with simulated ones on it: hanging game, chains) placed into
 * other collision deeper than this (Havok units; one game unit) never collide with it: a
 * pheasant's hook set into a beam would push its body against its hinges for good, swinging.
 */
const HUNG_OVERLAP = 1 / HAVOK_SCALE;
/**
 * Havok's deactivation (PhysicsWorld.#deactivate): how far a body may wander from its reference
 * (Havok units: the deactivation reference distance, which the engine's world info leaves at
 * Havok's default; observed in the original), how far it may turn (radians), how often it is checked and
 * how long a system must stay so (seconds). TODO(M13): Havok checks within that distance (a turn
 * of twice it) often and within four times it (eight) rarely; how often, and for how many
 * frames, is not read.
 */
const DEACTIVATION_DISTANCE = 0.02;
/** The upward speed a ragdoll's still bodies are given as it is made dynamic (liftStill). */
const RAGDOLL_LIFT = 0.5;
const DEACTIVATION_TURN = 0.05;
const DEACTIVATION_CHECK = 0.25;
const DEACTIVATION_SECONDS = 1;

/** A body's deactivation reference (PhysicsWorld.#deactivate): Havok units and a rotation. */
interface DeactivationReference {
  x: number;
  y: number;
  z: number;
  rotation: RAPIER.Rotation;
  /** How long the body has stayed near it, as of the last check. */
  seconds: number;
}

/**
 * Whether a body has left its deactivation reference: moved farther than DEACTIVATION_DISTANCE
 * from it or turned farther than DEACTIVATION_TURN.
 */
function movedFrom(reference: DeactivationReference, body: RAPIER.RigidBody): boolean {
  const t = body.translation();
  if (Math.hypot(t.x - reference.x, t.y - reference.y, t.z - reference.z) > DEACTIVATION_DISTANCE) {
    return true;
  }
  const q = body.rotation();
  const r = reference.rotation;
  const turned =
    2 * Math.acos(Math.min(1, Math.abs(r.x * q.x + r.y * q.y + r.z * q.z + r.w * q.w)));
  return turned > DEACTIVATION_TURN;
}

/** A deactivation group (PhysicsWorld.#deactivate): one system's awake bodies. */
interface RestingGroup {
  readonly bodies: RAPIER.RigidBody[];
  resting: boolean;
}

/** The handles of the bodies a body touches (a contact point in the last step). */
function touchingBodies(world: RAPIER.World, body: RAPIER.RigidBody): Set<number> {
  const touching = new Set<number>();
  const narrow = world.narrowPhase;
  for (let i = 0; i < body.numColliders(); i++) {
    const handle = body.collider(i).handle;
    narrow.contactPairsWith(handle, (other) => {
      const otherBody = world.getCollider(other).parent();
      if (!otherBody || otherBody.handle === body.handle || touching.has(otherBody.handle)) return;
      narrow.contactPair(handle, other, world.bodies, (manifold) => {
        if (manifold.numContacts() > 0) touching.add(otherBody.handle);
      });
    });
  }
  return touching;
}

/**
 * The deactivation groups joined into Havok's simulation islands: groups whose awake bodies
 * touch (a contact point in the last step) belong to one island. Fixed and keyframed bodies join
 * none (Havok keeps them out of islands), nor do sleeping ones.
 */
function contactIslands(
  world: RAPIER.World,
  groups: ReadonlyMap<string, RestingGroup>,
): RestingGroup[][] {
  const groupOf = new Map<number, string>();
  for (const [key, group] of groups) for (const body of group.bodies) groupOf.set(body.handle, key);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root)) root = parent.get(root) ?? root;
    if (root !== key) parent.set(key, root);
    return root;
  };
  const narrow = world.narrowPhase;
  for (const [key, group] of groups) {
    for (const body of group.bodies) {
      for (let i = 0; i < body.numColliders(); i++) {
        const handle = body.collider(i).handle;
        narrow.contactPairsWith(handle, (other) => {
          const otherBody = world.getCollider(other).parent();
          const otherKey = otherBody ? groupOf.get(otherBody.handle) : undefined;
          if (otherKey === undefined || find(otherKey) === find(key)) return;
          const touches = { found: false };
          narrow.contactPair(handle, other, world.bodies, (manifold) => {
            if (manifold.numContacts() > 0) touches.found = true;
          });
          if (touches.found) parent.set(find(otherKey), find(key));
        });
      }
    }
  }
  const islands = new Map<string, RestingGroup[]>();
  for (const [key, group] of groups) {
    const root = find(key);
    const island = islands.get(root);
    if (island) island.push(group);
    else islands.set(root, [group]);
  }
  return [...islands.values()];
}

/** The layers of ragdolls' bodies: the living's (powered, hit) and the dead's. */
const RAGDOLL_LAYERS: ReadonlySet<number> = new Set([Layer.biped, Layer.bipedNoCc, Layer.deadBip]);

/**
 * How deep (Havok units) a settling body must be in a welded triangle, pushed towards its back,
 * before it is put out at the triangle's front instead (PhysicsWorld.#weld): below Rapier's
 * allowed error, contacts are resting ones.
 */
const WELD_DEPTH = 0.005;
/** How far in front of the triangle a body put out by #weld is left (Havok units). */
const WELD_MARGIN = 0.001;
/**
 * How squarely the push must point to the triangle's back (the cosine of its angle to the
 * back): a push off one of its edges or corners (a book on a table's top against the edge of
 * its side) is not one through it.
 */
const WELD_FACING = 0.7;
/**
 * How far up a welded triangle's front must face (the cosine of its slope) for a body sunk
 * into it to be put out on it (#weld): ground a body may rest on, at most 60° steep.
 */
const WELD_GROUND = 0.5;
/**
 * How far under a settling body's lowest point (Havok units: 2 game units) something it may
 * stand on still holds it up (PhysicsWorld.#supported).
 */
const WELD_SUPPORT_GAP = 2 / HAVOK_SCALE;

/**
 * How far a collider reaches along a world direction (Havok units, from the world's origin):
 * the largest `p · direction` over its shape. Undefined for shapes no simulated body has
 * (meshes, heightfields).
 */
function colliderReach(collider: RAPIER.Collider, direction: RAPIER.Vector): number | undefined {
  const at = collider.translation();
  const q = collider.rotation();
  // The direction in the collider's frame (the inverse rotation of a unit quaternion).
  const local = rotateVector({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, direction);
  const base = at.x * direction.x + at.y * direction.y + at.z * direction.z;
  const shape = collider.shape;
  let reach: number;
  switch (shape.type) {
    case RAPIER.ShapeType.Ball:
      reach = (shape as RAPIER.Ball).radius;
      break;
    case RAPIER.ShapeType.Cuboid:
    case RAPIER.ShapeType.RoundCuboid: {
      const box = shape as RAPIER.Cuboid | RAPIER.RoundCuboid;
      const h = box.halfExtents;
      reach = Math.abs(h.x * local.x) + Math.abs(h.y * local.y) + Math.abs(h.z * local.z);
      if (box instanceof RAPIER.RoundCuboid) reach += box.borderRadius;
      break;
    }
    case RAPIER.ShapeType.Capsule: {
      const capsule = shape as RAPIER.Capsule;
      reach = capsule.halfHeight * Math.abs(local.y) + capsule.radius;
      break;
    }
    case RAPIER.ShapeType.Cylinder:
    case RAPIER.ShapeType.RoundCylinder: {
      const cylinder = shape as RAPIER.Cylinder | RAPIER.RoundCylinder;
      reach =
        cylinder.halfHeight * Math.abs(local.y) + cylinder.radius * Math.hypot(local.x, local.z);
      if (cylinder instanceof RAPIER.RoundCylinder) reach += cylinder.borderRadius;
      break;
    }
    case RAPIER.ShapeType.ConvexPolyhedron:
    case RAPIER.ShapeType.RoundConvexPolyhedron: {
      const convex = shape as RAPIER.ConvexPolyhedron | RAPIER.RoundConvexPolyhedron;
      const v = convex.vertices;
      reach = -Infinity;
      for (let i = 0; i + 2 < v.length; i += 3) {
        const d = (v[i] ?? 0) * local.x + (v[i + 1] ?? 0) * local.y + (v[i + 2] ?? 0) * local.z;
        if (d > reach) reach = d;
      }
      if (convex instanceof RAPIER.RoundConvexPolyhedron) reach += convex.borderRadius;
      break;
    }
    default:
      return undefined;
  }
  return base + reach;
}

/**
 * How far behind a triangle's plane (Havok units) a collider's deepest point lies; undefined
 * for shapes no simulated body has.
 */
function behindFace(
  collider: RAPIER.Collider,
  face: { readonly normal: RAPIER.Vector; readonly offset: number },
): number | undefined {
  const reach = colliderReach(collider, {
    x: -face.normal.x,
    y: -face.normal.y,
    z: -face.normal.z,
  });
  return reach === undefined ? undefined : face.offset + reach;
}

/**
 * A welded (one-sided in the files) mesh's triangles as a two-sided collider has them: its
 * vertices (game units, the collider's frame) times `scale` are the collider's (Havok units).
 */
interface WeldedMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly scale: number;
}

/**
 * The front of a mesh collider's triangle in the world (unit; counter-clockwise, as the welded
 * meshes' fronts are: collision-data.ts) and its plane's offset along it (Havok units), or
 * undefined for a degenerate triangle. Read from our own collision data (`mesh`), not from the
 * collider's shape, which Rapier copies out whole on every read.
 */
function triangleFront(
  collider: RAPIER.Collider,
  mesh: WeldedMesh,
  triangle: number,
): { readonly normal: RAPIER.Vector; readonly offset: number } | undefined {
  const { vertices, indices, scale } = mesh;
  if (3 * triangle + 2 >= indices.length) return undefined;
  const a = (indices[3 * triangle] ?? 0) * 3;
  const b = (indices[3 * triangle + 1] ?? 0) * 3;
  const c = (indices[3 * triangle + 2] ?? 0) * 3;
  const ax = (vertices[a] ?? 0) * scale;
  const ay = (vertices[a + 1] ?? 0) * scale;
  const az = (vertices[a + 2] ?? 0) * scale;
  const ux = (vertices[b] ?? 0) * scale - ax;
  const uy = (vertices[b + 1] ?? 0) * scale - ay;
  const uz = (vertices[b + 2] ?? 0) * scale - az;
  const vx = (vertices[c] ?? 0) * scale - ax;
  const vy = (vertices[c + 1] ?? 0) * scale - ay;
  const vz = (vertices[c + 2] ?? 0) * scale - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0)) return undefined;
  const q = collider.rotation();
  const at = collider.translation();
  const normal = rotateVector(q, { x: nx / length, y: ny / length, z: nz / length });
  const corner = rotateVector(q, { x: ax, y: ay, z: az });
  const offset =
    (corner.x + at.x) * normal.x + (corner.y + at.y) * normal.y + (corner.z + at.z) * normal.z;
  return { normal, offset };
}

/**
 * Kinds of collider some queries want alone, as Rapier collision groups' memberships (bits):
 * the trigger volumes, the traps (L_TRAP, L_CLOUDTRAP) and the character controllers. No
 * collider's group filter goes by them (GROUP_RAGDOLL: its filter), so contacts and the other
 * queries are as without them; a query for one kind passes the others over inside Rapier, before
 * its predicate, which is a call back into JavaScript for every candidate (the layers stay ours:
 * layerOf).
 */
const QUERY_OTHER = 0x1;
const QUERY_TRIGGER = 0x2;
const QUERY_TRAP = 0x4;
const QUERY_CONTROLLER = 0x8;
/**
 * What a character controller meets: a collider whose layer collides with L_CHARCONTROLLER and
 * that is no ragdoll's one-sided copy of a mesh (filterFor's test, made inside Rapier), nor a
 * phantom: the controllers' sweeps and casts leave sensors out, so one is nothing they meet
 * (every humanoid skeleton has one on L_CHARCONTROLLER, its CharacterBumper).
 */
const QUERY_CONTROLLER_SOLID = 0x10;
/** Of those, the ones that are no actor's (its controller, its bodies): what holds one up. */
const QUERY_CONTROLLER_GROUND = 0x20;
/**
 * Every collider is one of two more: on a ragdoll's layer (RAGDOLL_LAYERS) or not. A collider's
 * group filter takes both, but a welded mesh's two halves: the two-sided original takes no
 * ragdoll's body, its one-sided copy only those (PhysicsWorld.#ragdollFaces). So Rapier itself
 * passes over the half of a mesh a body does not meet; the contact filter (a call back into
 * JavaScript for every pair of a moving body, every step) said so for each, half of its calls
 * for bodies on meshes.
 */
const GROUP_RAGDOLL = 0x40;
const GROUP_OTHER = 0x80;
const ALL_GROUPS = 0xffff;

/** Rapier's interaction groups: memberships in the upper 16 bits, the filter in the lower. */
const groups = (memberships: number, filter: number): number =>
  ((memberships << 16) | filter) >>> 0;

/** Query filters (interaction groups) by kind of collider, for the queries' `filterGroups`. */
export const QueryGroups = {
  triggers: groups(ALL_GROUPS, QUERY_TRIGGER),
  traps: groups(ALL_GROUPS, QUERY_TRAP),
  controllers: groups(ALL_GROUPS, QUERY_CONTROLLER),
  /**
   * What filterFor(L_CHARCONTROLLER) takes: a character controller's sweeps and queries pass
   * the rest over inside Rapier, and need no call back for the layers (character.ts).
   */
  controllerSolid: groups(ALL_GROUPS, QUERY_CONTROLLER_SOLID),
  /**
   * Of those, what no actor owns: the ground and the bodies a controller stands on or is
   * carried by. A controller's casts for them pass every actor's shapes over inside Rapier (its
   * own keyframed bodies lie all through its shape: a call back for each, every step).
   */
  controllerGround: groups(ALL_GROUPS, QUERY_CONTROLLER_GROUND),
} as const;

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

/**
 * The pivots of a joint the constraint solver does not take, whose error is clipped outside it,
 * and the distance they keep (game units in the bodies' spaces); undefined for the others.
 */
function linkPivots(data: ConstraintData): readonly [Vec3, Vec3, number] | undefined {
  switch (data.type) {
    case 'ball-and-socket':
      return [data.pivotA, data.pivotB, 0];
    case 'stiff-spring':
      return [data.pivotA, data.pivotB, data.length];
    case 'hinge':
      return [data.a.pivot, data.b.pivot, 0];
    case 'malleable':
      return linkPivots(data.inner);
    default:
      return undefined;
  }
}

/** A joint's error as Havok's solver would leave it (linear; about a hinge's two axes). */
interface GroupError {
  readonly linear: Vec3;
  readonly angular: readonly number[];
}

/**
 * A joint's error after a step of `step` seconds whose solve left its rows `left` of their
 * speed, its linear part at most `most` (Havok corrects at most a chain's maxErrorDistance).
 */
function openError(
  was: GroupError | undefined,
  left: GroupError,
  step: number,
  most: number,
): GroupError {
  const at = (i: 0 | 1 | 2): number => (was?.linear[i] ?? 0) + left.linear[i] * step;
  const linear: Vec3 = [at(0), at(1), at(2)];
  const size = Math.hypot(...linear);
  const k = size > most && size > 0 ? most / size : 1;
  return {
    linear: [linear[0] * k, linear[1] * k, linear[2] * k],
    angular: left.angular.map((x, i) => (was?.angular[i] ?? 0) + x * step),
  };
}

/** A keyframed body pulling a placed body by a joint (PhysicsWorld.addHitch). */
export interface Hitch {
  readonly body: RAPIER.RigidBody;
  /** Where the hitch is by the next step (game units). */
  move(world: Mat4): void;
  /** Puts the hitch there at once, at rest (what it pulls was moved with it). */
  place(world: Mat4): void;
  remove(): void;
}

/**
 * The body of a reference's placements a script names by its node (case aside; none: the
 * first simulated body, else the first).
 */
export function bodyOfNode(
  placements: Iterable<PlacedCollision>,
  node: string,
): PlacedBody | undefined {
  const name = node.trim().toLowerCase();
  let first: PlacedBody | undefined;
  let simulated: PlacedBody | undefined;
  for (const placed of placements) {
    for (const entry of placed.bodies) {
      if (name !== '' && entry.data.node.toLowerCase() === name) return entry;
      first ??= entry;
      if (entry.data.motion !== 'fixed') simulated ??= entry;
    }
  }
  return name === '' ? (simulated ?? first) : undefined;
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
  /** The collider hit (PhysicsWorld.knock pushes its body). */
  readonly collider: RAPIER.Collider;
}

// --- Small math helpers -------------------------------------------------------------------

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** a⁻¹ b: the turn `b` is from `a` (unit quaternions). */
function relativeTurn(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y,
    y: a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x,
    z: a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w,
    w: a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z,
  };
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
/**
 * One step of Rapier's pipeline, as World.step takes it. World.step then wraps what the engine
 * made or removed on its own during the step (the pieces soft bodies tear off): a walk over
 * every rigid body and collider of the world with a call back into JavaScript for each, every
 * step (over the opening's Helgen, about 2 ms a frame at three steps). Without soft bodies (the
 * engine has none) a step makes and removes nothing, and the walk is left out.
 */
export function stepWorld(
  world: RAPIER.World,
  events: RAPIER.EventQueue | undefined,
  hooks: RAPIER.PhysicsHooks | undefined,
): void {
  if (world.softBodies.len() > 0) {
    world.step(events, hooks);
    return;
  }
  world.physicsPipeline.step(
    world.gravity,
    world.integrationParameters,
    world.islands,
    world.broadPhase,
    world.narrowPhase,
    world.bodies,
    world.colliders,
    world.softBodies,
    world.impulseJoints,
    world.multibodyJoints,
    world.ccdSolver,
    events,
    hooks,
  );
}

/**
 * Pairs of collider handles, in either order. Asked by the contact filter for every pair of
 * every step: looked up by number (a string key made per pair was 1 ms of a Helgen frame).
 */
export class HandlePairs {
  readonly #pairs = new Map<number, Set<number>>();
  #size = 0;

  get size(): number {
    return this.#size;
  }

  has(a: number, b: number): boolean {
    return this.#pairs.get(a)?.has(b) === true;
  }

  add(a: number, b: number): void {
    if (this.has(a, b)) return;
    this.#link(a, b);
    this.#link(b, a);
    this.#size++;
  }

  delete(a: number, b: number): void {
    if (!this.has(a, b)) return;
    this.#unlink(a, b);
    this.#unlink(b, a);
    this.#size--;
  }

  #link(a: number, b: number): void {
    let set = this.#pairs.get(a);
    if (!set) {
      set = new Set();
      this.#pairs.set(a, set);
    }
    set.add(b);
  }

  #unlink(a: number, b: number): void {
    const set = this.#pairs.get(a);
    if (!set) return;
    set.delete(b);
    if (set.size === 0) this.#pairs.delete(a);
  }
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

/** multiplyInto's product before it is copied out (`out` may be `a` or `b`). */
const PRODUCT = new Float32Array(16);

function multiplyInto(a: Mat4, b: Mat4, out: Mat4): void {
  const r = PRODUCT;
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

/** Papyrus's motion types (ObjectReference.SetMotionType, OnTrapHit's aeMotionType). */
export const MotionType = { dynamic: 1, keyframed: 4, fixed: 5 } as const;

/** One side of a hard contact: who it is, and its body's mass (0: fixed or keyframed). */
export interface ContactSide {
  readonly owner: PhysicsOwner | undefined;
  readonly mass: number;
}

/** A contact at fPhysicsDamageSpeedMin or more (speed in Havok units a second). */
export interface HardContact {
  readonly a: ContactSide;
  readonly b: ContactSide;
  readonly speed: number;
}

/** A trap an actor touches (trapsTouching): where (game units), its body's velocity, its motion. */
export interface TrapTouch {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly motionType: number;
  /** The material (MATT id) of the trap's shape it touches. */
  readonly material: number;
}

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
    jointConfigureMotorModel(handle: number, axis: number, model: number): void;
    jointSetMotorMaxForce(handle: number, axis: number, maxForce: number): void;
  };
  readonly handle: number;
}

/**
 * How firmly a prismatic joint's friction holds its axis still (the motor's gain towards no
 * relative speed, per second). TODO(M13): Rapier's velocity motor does not hold a force below its
 * maximum (a damper at best), so a prismatic's friction does little; the ragdolls' and limited
 * hinges' friction is the constraint solver's (constraint-solver.ts).
 */
const JOINT_FRICTION_GAIN = 1000;

/**
 * The world's maximum constraint violation (Havok units; observed in the original: its
 * world info sets 0.05, Havok's own default is unbounded): PhysicsWorld.#clipViolation.
 */
const MAX_CONSTRAINT_VIOLATION = 0.05;
/** A clipped pivot is moved again only when it moves by more than this (Havok units). */
const CLIP_CHANGE = 1e-3;
/**
 * A chain link's anchor held at its chain's damped error (#dampChains) is moved again only when
 * it moves by more than this (Havok units): a tenth of what a vanilla chain (damping 0.6) leaves
 * a link at rest under gravity, so that what hangs still can sleep.
 */
const DAMP_CHANGE = 1e-5;

/** `v` turned by the unit quaternion `q`. */
function rotateVector(q: RAPIER.Rotation, v: RAPIER.Vector): RAPIER.Vector {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** An eased limit is set again only when it moves by more than this (radians: #easeLimits). */
const EASED_CHANGE = 1e-3;

/**
 * How far past a limit that gives (#giveLimits) Rapier's own limit stands, and so the most a
 * joint goes further past it in a step (radians): what swings a joint over its limit is
 * stopped there and the limit's spring takes it up from the next step, as Havok's limit takes
 * the speed into it out and yields to the load only. TODO(M13): inferred (Havok's limit lets
 * the share of the speed through that its iterations leave).
 */
const GIVE_STEP = 0.02;
/**
 * How far past its limit (radians) a joint lies before the limit's spring comes on; it goes
 * off again when the joint is back at the limit: a limit only pushes back. (A joint resting
 * at its limit would turn a spring that came on at the limit itself on and off, and each
 * change wakes its bodies; one that stayed on a little within the limit held the joint there:
 * a limb swung up against its cone hung on it against its weight.)
 */
const GIVE_ON = 1e-3;
/**
 * How far back within its limit (radians) a joint whose spring was on keeps the spring's
 * damping (GIVE_DAMPING; no spring): a joint bouncing on its limit comes to rest on it. With
 * none within the limit a light weight coming back to its cone bounced off it and was sent to
 * sleep a little within it (0.04° to 0.08°), and of the race skeletons' ragdolls 5 fewer of
 * 156 came to rest (`node tools/ragdoll-info.ts`, pushed, --still and --lift). TODO(M13):
 * ours, as the damping.
 */
const GIVE_SLACK = 0.005;
/**
 * The spring's damping, as the share of its stiffness × the step: a little, so that a limb on
 * its limit comes to rest (Havok's limit takes out all the speed into it; with more damping
 * than this Rapier's motor, solved once a substep, holds less than its spring's torque, and the
 * race skeletons' ragdolls settle worse: `node tools/ragdoll-info.ts`, 44 of 52 at rest within
 * 20 s at 0.2, 41 at 0, 39 at 0.5, 34 at 1, measured before the cone had its spring; with
 * it, twice the damping left 40 of 52 at rest let go still, against 41).
 */
const GIVE_DAMPING = 0.2;
/** A limit narrower than this (radians) holds one angle and stays Rapier's own (stiff). */
const POINT_LIMIT = 0.02;
/** A joint axis's motor's force when it is on (Rapier's own default: unbounded). */
const MOTOR_FORCE = 3e38;

/**
 * A spring is set again when its stiffness changes by more than this share of it (it follows
 * the step and how the bodies lie: constraint-solver.ts, limitGive).
 */
const GIVE_STIFFNESS_CHANGE = 0.02;
/**
 * The least share of a cone's push that an axis's spring takes (the square of the share of the
 * cone's direction along it): below it the axis is left to the other.
 */
const CONE_SHARE = 1e-3;
/**
 * How much of the cone's stiffness a swing's motor holds its share of the cone's torque with:
 * this × the square of the share of the cone's direction along it, the whole of it at the
 * most. Rapier's motor is a spring about the joint's own axis, solved within the step: the two
 * swings' motors together hold the joint along the cone's direction with the cone's whole
 * stiffness where each has a quarter of the direction or more (within 30° of the middle
 * between them), and with 93 % of it at the least nearer one of them. Held with less (each
 * its share squared: half the stiffness between the two), the rest of the torque stood still
 * over the step while the joint moved, and a weight on the cone bounced on it without end
 * (±0.5° about where it should rest, 4 s on). What the motors hold along the cone's direction
 * they also hold across it for the step (none on a swing's own axis, the whole stiffness
 * between the two): TODO(M13), a joint pressed past its cone slides along it slower than
 * Havok's, whose cone is one row about its own axis.
 */
const CONE_HOLD = 4;

/** An axis of a joint whose limit gives under a load (PhysicsWorld.#giveLimits). */
interface GivingAxis {
  /** The axis of the first body's frame (constraint-solver.ts, jointLimitGive). */
  readonly index: 0 | 1 | 2;
  readonly axis: RAPIER.JointAxis;
  /** Where Rapier's own limits stand while the joint is within them (axisLimits). */
  readonly min: number;
  readonly max: number;
  /**
   * The limit of its own that its spring pushes back from (a hinge's angle, a ragdoll's twist
   * and plane); a ragdoll's other swing has none: what limits it is the cone.
   */
  readonly own: { readonly min: number; readonly max: number } | undefined;
  /**
   * The limit of its own its spring pushes back from now, or did and the joint is still near
   * (GIVE_SLACK): 1 the upper, −1 the lower, 0 neither.
   */
  side: number;
  /**
   * Its spring now (Rapier's motor on the axis): its stiffness (0: none), where it pulls to
   * and its damping (0 with no stiffness: off).
   */
  stiffness: number;
  target: number;
  damping: number;
  /** Rapier's limits on it now. */
  lo: number;
  hi: number;
}

/** A joint whose limits give under a load (PhysicsWorld.#giveLimits). */
interface GivingJoint {
  readonly axes: GivingAxis[];
  /** A ragdoll's cone (radians) where it gives (its two swings both do). */
  readonly cone: number | undefined;
  /** Whether the cone's spring is on, or was and the joint is still near (GIVE_SLACK). */
  coned: boolean;
}

/** What the springs of a giving joint ask of one of its axes in a step. */
interface AxisPush {
  /** The torque wanted about it (Havok's units), the stiffness it is held with, the damping. */
  torque: number;
  stiffness: number;
  damping: number;
  /** The stiffest of the springs on it. */
  most: number;
  /** How far back along it the limits lie (radians, signed), and whether any lies far. */
  move: number;
  far: boolean;
}

/** A ragdoll's or limited hinge's inner data (a malleable one's). */
function articulated(
  data: ConstraintData,
): Extract<ConstraintData, { type: 'ragdoll' | 'limited-hinge' }> | undefined {
  if (data.type === 'malleable') return articulated(data.inner);
  return data.type === 'ragdoll' || data.type === 'limited-hinge' ? data : undefined;
}

/**
 * What the constraint solver (constraint-solver.ts) keeps of a ragdoll or limited hinge
 * constraint (its friction), its frames scaled by `toLocal`; undefined for the other kinds. A
 * malleable one's strength softens its rows (Havok's virtual mass factor). TODO(M13): Rapier's
 * joint that keeps its pivot and limits stays stiff (Rapier has no per-joint softness); no
 * vanilla model has a malleable constraint.
 */
function solverConstraint(data: ConstraintData, toLocal: number): SolverConstraint | undefined {
  const inner = articulated(data);
  if (!inner) return undefined;
  const strength = data.type === 'malleable' ? data.strength : undefined;
  const frame = (f: ConstraintFrame) => ({
    pivot: [f.pivot[0] * toLocal, f.pivot[1] * toLocal, f.pivot[2] * toLocal] as Vec3,
    axes: [f.axes[0], f.axes[1]] as const,
  });
  return {
    type: inner.type,
    a: frame(inner.a),
    b: frame(inner.b),
    maxFriction: inner.maxFriction,
    ...(inner.type === 'ragdoll' && { cone: Math.abs(inner.coneMaxAngle) }),
    ...(strength !== undefined && { strength }),
  };
}

/** A limit of a Rapier joint on one of its axes. */
interface AxisLimit {
  readonly axis: RAPIER.JointAxis;
  readonly min: number;
  readonly max: number;
}

/**
 * A ragdoll's or limited hinge's limits on its Rapier joint's axes (the hinge's angle; the
 * ragdoll's twist, and the two swings each within the cone, the one towards the plane axis also
 * within the plane limits), the angles mirrored (ANGLES_MIRRORED). TODO(M13): Havok's ragdoll
 * limits are a cone (the twist axis within coneMaxAngle) and two planes.
 */
function axisLimits(data: ConstraintData): readonly AxisLimit[] {
  const inner = articulated(data);
  if (!inner) return [];
  if (inner.type === 'limited-hinge') {
    return [{ axis: RAPIER.JointAxis.AngX, min: -inner.maxAngle, max: -inner.minAngle }];
  }
  const cone = Math.abs(inner.coneMaxAngle);
  return [
    { axis: RAPIER.JointAxis.AngX, min: -inner.twistMaxAngle, max: -inner.twistMinAngle },
    { axis: RAPIER.JointAxis.AngY, min: -cone, max: cone },
    {
      axis: RAPIER.JointAxis.AngZ,
      min: Math.max(-cone, -inner.planeMaxAngle),
      max: Math.min(cone, -inner.planeMinAngle),
    },
  ];
}

/*
 * ANGLES_MIRRORED: Rapier measures a joint's angles as its second body's frame turned from its
 * first's; the files' limits are of the opposite turn. Read from the data (node
 * tools/ragdoll-info.ts --limits): of 12,149 limited hinges in the 1,257 complete placed ragdoll
 * poses (XRGD: the Creation Kit's settled Havok state), 60 % lie within their limits as Rapier
 * measures them, 97 % mirrored; of the ragdoll joints' plane angles 90 % against 97 % (twists
 * are about symmetric). Unmirrored, knees and elbows bent only the wrong way, and a dying pose's
 * bent knee started past its limit and snapped back.
 */

/**
 * A joint's angle on a Rapier axis as Rapier measures it for its limits: twice the arcsine of
 * that component of the turn from the first body's frame to the second's.
 */
function jointAngle(joint: RAPIER.ImpulseJoint, axis: RAPIER.JointAxis): number {
  const qa = joint.body1().rotation();
  const qb = joint.body2().rotation();
  const fa = joint.frameX1();
  const fb = joint.frameX2();
  const conj = (q: RAPIER.Rotation): RAPIER.Rotation => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
  const r = quatMultiply(conj(quatMultiply(qa, fa)), quatMultiply(qb, fb));
  const sign = r.w < 0 ? -1 : 1;
  const component =
    axis === RAPIER.JointAxis.AngX ? r.x : axis === RAPIER.JointAxis.AngY ? r.y : r.z;
  return 2 * Math.asin(Math.max(-1, Math.min(1, component * sign)));
}

function quatMultiply(a: RAPIER.Rotation, b: RAPIER.Rotation): RAPIER.Rotation {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function setJointLimits(
  joint: RAPIER.ImpulseJoint,
  axis: RAPIER.JointAxis,
  min: number,
  max: number,
): void {
  // Rapier keeps per-axis limits on every joint; the typed API exposes them only on one-axis
  // joints.
  const raw = joint as unknown as RawJointLimits;
  raw.rawSet.jointSetLimits(raw.handle, axis, Math.min(min, max), Math.max(min, max));
}

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
  /** The colliders on L_TRAP, by handle (movingInTriggers looks at the keyframed ones). */
  readonly #trapColliders = new Map<number, RAPIER.Collider>();
  /** Where each trap's body was when last looked at, by body handle. */
  readonly #trapPoses = new Map<number, number[]>();
  /** See takeGone. */
  #gone = new Set<number>();
  /** Material id (MATT) per collider handle. */
  readonly #materials = new Map<number, number>();
  /** Simulated colliders' nodes (water-physics.ts: a ragdoll's trunk floats, its limbs hang). */
  readonly #nodes = new Map<number, string>();
  /** The materials of all of an object's shapes, per collider of the object. */
  readonly #objectMaterials = new Map<number, ReadonlySet<number>>();
  readonly #hooks: RAPIER.PhysicsHooks;
  readonly #events = new RAPIER.EventQueue(true);
  #impacts: PhysicsImpact[] = [];
  /** Simulated bodies' velocities before the step (Havok units per second). */
  readonly #velocities = new Map<number, RAPIER.Vector>();
  /** Their angular velocities before the step (#holdAwake). */
  readonly #spins = new Map<number, RAPIER.Vector>();
  /** Joints that break under too much force, while they hold. */
  readonly #breakable = new Set<PlacedJoint>();
  /**
   * The solver results of each breakable joint solved with its group in the step under way
   * (#solveBreakable): what it weighs against its threshold.
   */
  readonly #breakableLoads = new Map<PlacedJoint, number>();
  /**
   * The error of each joint of those groups as Havok's solver would leave it (#solveBreakable):
   * what its iterations left of the pivots' speed, over the steps (linear: Havok units; angular:
   * radians about a hinge's axes across its axle). Rapier's own joints drift apart a little every
   * step, which Havok's do not: that is no load.
   */
  readonly #groupErrors = new Map<PlacedJoint, GroupError>();
  /** The last solver results of each breakable joint solved with its group (breakableLoad). */
  readonly #lastLoads = new WeakMap<PlacedJoint, number>();
  /** The order joints were made in: Havok solves an island's constraints so. */
  readonly #jointOrder = new WeakMap<PlacedJoint, number>();
  #nextJoint = 0;
  /**
   * The velocities the bodies of those joints' groups had after the last step (linear, then
   * angular): what moved them since (a push, gravity) is what their joints take.
   */
  #groupVelocities = new Map<number, readonly [RAPIER.Vector, RAPIER.Vector]>();
  readonly #groupBodies = new Map<number, RAPIER.RigidBody>();
  /**
   * The placed joints that have not broken, by the handles of their two bodies, and the scale
   * each one's frames are made at (Havok units per game unit of its placement).
   */
  readonly #jointsOf = new Map<number, PlacedJoint[]>();
  readonly #jointScales = new Map<PlacedJoint, number>();
  /** The placed ragdoll and limited hinge joints whose friction the constraint solver gives. */
  readonly #solverJoints = new Map<PlacedJoint, SolverJoint>();
  /** The ragdolls held in one pose (stiffen): the fixed joints that hold them. */
  readonly #stiff = new Map<PlacedCollision, RAPIER.ImpulseJoint[]>();
  /** Contacts at this speed or more are told (Havok units a second: fPhysicsDamageSpeedMin). */
  hardContactSpeed = 500;
  /** A contact at hardContactSpeed or more: the world's collision listener's physics damage. */
  onHardContact: ((contact: HardContact) => void) | undefined;
  /** The joints whose second pivot is moved in for a step (#clipViolation). */
  readonly #clipped = new Map<PlacedJoint, RAPIER.Vector>();
  /**
   * The joints outside the constraint solver: a chain's links, hinges, balls and sockets and
   * stiff springs, with their pivots (Havok units), their largest error and the distance kept
   * between their pivots (#clipLinks).
   */
  readonly #linksClipped = new Map<
    PlacedJoint,
    {
      readonly pivotA: Vec3;
      readonly pivotB: Vec3;
      readonly most: number;
      readonly rest: number;
    }
  >();
  /**
   * The links of each placed chain (bhkBallSocketConstraintChain), by link: one array a placed
   * chain, in its links' order (#dampChains).
   */
  readonly #chainLinks = new Map<PlacedJoint, PlacedJoint[]>();
  /** A chain link's second anchor as #dampChains last set it, and the joint it was set on. */
  readonly #damped = new Map<
    PlacedJoint,
    { readonly joint: RAPIER.ImpulseJoint; readonly anchor: RAPIER.Vector }
  >();
  /** The joints whose limits are eased back to them, with their bounds now (#easeLimits). */
  readonly #easing = new Map<PlacedJoint, readonly number[]>();
  /** The joints in the world whose limits give under a load, by axis (#giveLimits). */
  readonly #giving = new Map<PlacedJoint, GivingJoint>();
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
  readonly #ignoredPairs = new HandlePairs();
  /** Colliders that collide with nothing for now (setPassThrough). */
  readonly #passing = new Set<number>();
  /**
   * One-sided copies of fixed triangle meshes (Havok's one-sided welding, collision-data.ts:
   * the landscape and every vanilla compressed mesh), which only ragdolls meet; their two-sided
   * originals (#twoSided) meet everything else. Rapier's fixed internal edges keep a ragdoll's
   * contacts on the triangles' fronts and smooth across their edges (a limb that got behind a
   * rock's face was pushed through it and back, and shook), but they drop the contacts of many
   * convex hulls lying on a face (Mistwatch's bear traps fell 850 units through the tower's
   * floor; of the 69,455 loose objects of the interiors, 3,591 ended more than their size below
   * where they were placed as their cells settled, against 1,091 with two-sided meshes, most of
   * those rolled off what they lay on: tools/settle-audit.ts).
   */
  readonly #ragdollFaces = new Set<number>();
  /**
   * The two-sided originals of the welded meshes, with their triangles as our collision data
   * has them (#weld reads a triangle's front there: Rapier's `collider.shape` copies a mesh's
   * whole vertex and index buffers out of the physics engine on every read).
   */
  readonly #twoSided = new Map<number, WeldedMesh>();
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
   * maximum linear velocity (Havok units per second) and angular velocity (radians per second);
   * and their solver deactivation class (how Havok's solver slows them when slow:
   * constraint-solver.ts, slowBodyFactor).
   */
  readonly #limits = new Map<
    number,
    {
      readonly body: RAPIER.RigidBody;
      readonly linear: number;
      readonly angular: number;
      readonly solverDeactivation: number;
    }
  >();
  /**
   * Where each awake simulated body was when it last moved (its deactivation reference: the
   * position in Havok units and the rotation), and for how long it has stayed near it.
   */
  readonly #still = new Map<number, DeactivationReference>();
  /** Simulated seconds since the deactivation was last checked. */
  #sinceDeactivation = 0;
  /** Simulated seconds. */
  #time = 0;
  /** Collision was placed or removed since the last step (queries do not see it yet). */
  #changed = false;
  /** Time handed to the steps not yet stepped (negative: the last step went past it). */
  #accumulator = 0;
  /** Frame time not yet handed to the steps (PhysicsWorld.step). */
  #owed = 0;
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
  /**
   * The engine's complex mode: the world steps `complexStep` ([HAVOK] fMaxTimeComplex), at most
   * `complexSteps` (uMaxNumPhysicsStepsPerUpdateComplex) times a frame: with the built-in values
   * one step of 1/30 s, so a crowd's frame takes one step where it took up to three, and no long
   * frame makes the next one longer by its steps. The play turns it on while the scene is
   * complex (src/shell/actor-stage.ts: as many living actors in the high process as
   * iAINumberActorsComplexScene, counted by sceneActors in src/ai/ambient-idles.ts, the count the
   * idles and detection go by, which never takes in the disabled or those placed or reloaded
   * dead). TODO(M13): inferred from the settings' names (the engine's step is handed the mode;
   * what hands it was not read).
   */
  complex = false;
  complexStep = 1 / 30;
  complexSteps = 1;
  /**
   * The constraint solver's settings at the complex step (solverSettings at fMaxTimeComplex:
   * with the built-in values twice the iterations and a larger tau).
   */
  complexSolver: SolverSettings = solverSettings(1 / 30, PHYSICS_STEP, HAVOK_TAU_RATIO);
  #step = PHYSICS_STEP;
  /** The step being taken (#step × the time multiplier). */
  #size = PHYSICS_STEP;
  /**
   * Which simulated bodies are swept continuously (fDebrisMinExtent, fDebrisMaxVelocity:
   * DEBRIS_QUALITY); set before placing objects.
   */
  debris: DebrisQuality = DEBRIS_QUALITY;
  /**
   * How the dead's ragdolls are watched for limbs through the world ([RagdollAnim]
   * fDetectionUpdateTimeSec, fDesiredVel, fImpulseLimit: src/physics/ragdoll-penetration.ts).
   */
  penetration: PenetrationSettings = PENETRATION_DEFAULTS;
  /**
   * The constraint solver's tau, damping and iterations (constraint-solver.ts, solverSettings:
   * the engine's at its step, from [HAVOK] fMaxTime and fHavokTauRatio).
   */
  solver: SolverSettings = SOLVER_DEFAULTS;

  /** The solver's settings for the step being taken (the complex mode's in that mode). */
  get #stepSolver(): SolverSettings {
    return this.complex ? this.complexSolver : this.solver;
  }

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
    const passing = this.#passing;
    const ragdollFaces = this.#ragdollFaces;
    const twoSided = this.#twoSided;
    const ragdoll = (handle: number): boolean => RAGDOLL_LAYERS.has(layers.get(handle) ?? 0);
    const collides = (a: number, b: number): boolean => {
      const system = systems.get(a);
      if (system !== undefined && system === systems.get(b)) return false;
      if (ignored.size > 0 && ignored.has(a, b)) return false;
      if (passing.size > 0 && (passing.has(a) || passing.has(b))) return false;
      if (twoSided.size > 0) {
        if (ragdollFaces.has(a) || ragdollFaces.has(b)) {
          if (!ragdoll(ragdollFaces.has(a) ? b : a)) return false;
        } else if ((twoSided.has(a) && ragdoll(b)) || (twoSided.has(b) && ragdoll(a))) {
          return false;
        }
      }
      return matrix.collides(layers.get(a) ?? 0, layers.get(b) ?? 0);
    };
    this.#hooks = {
      filterContactPair: (a, b) => (collides(a, b) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null),
      filterIntersectionPair: collides,
    };
  }

  /**
   * The bodies that can be simulated: those made simulated (the files' simulated bodies, held
   * or keyframed meanwhile or not; some 700 of Helgen's 3,000), by handle, as their first
   * collider is registered. The others (fixed, keyframed) never become so.
   */
  readonly #simulated = new Map<number, RAPIER.RigidBody>();

  /**
   * Every simulated body awake now (not held, asleep or out of the world). The passes that
   * look for the awake ones each step walk the bodies that can be simulated, not every body of
   * the world (three walks a step over Helgen's 3,000, two calls into Rapier for each).
   */
  forEachAwake(each: (body: RAPIER.RigidBody) => void): void {
    for (const [handle, body] of this.#simulated) {
      if (!body.isValid()) this.#simulated.delete(handle);
      else if (body.isDynamic() && !body.isSleeping() && body.isEnabled()) each(body);
    }
  }

  /** The fixed step (seconds; `[HAVOK] fMaxTime`); set before placing objects. */
  get stepSeconds(): number {
    return this.#step;
  }

  set stepSeconds(seconds: number) {
    if (!(seconds > 0)) return;
    this.#step = seconds;
    this.#size = seconds;
    this.world.timestep = seconds;
  }

  /** The step being taken now (seconds): the fixed step × the world's time multiplier. */
  get currentStep(): number {
    return this.#size;
  }

  /**
   * The world's time multiplier (Slow Time; undefined: 1), asked each frame: the step is made
   * as much shorter (PhysicsWorld.step).
   */
  timeScale: (() => number) | undefined;

  /** The layer of a collider. */
  layerOf(collider: RAPIER.Collider): number {
    return this.#layers.get(collider.handle) ?? Layer.unidentified;
  }

  ownerOf(collider: RAPIER.Collider): PhysicsOwner | undefined {
    return this.#owners.get(collider.handle);
  }

  /**
   * A simulated body's linear velocity before the last step (Havok units per second): how it came
   * at what it touched in that step, before the contacts' response; else its velocity now.
   */
  velocityBefore(body: RAPIER.RigidBody): RAPIER.Vector {
    return this.#velocities.get(body.handle) ?? body.linvel();
  }

  /** A filter for queries and the character controller: colliders `layer` collides with. */
  filterFor(layer: number): (collider: RAPIER.Collider) => boolean {
    // The ragdolls' one-sided copies of meshes are not surfaces of their own.
    return (collider) =>
      !this.#ragdollFaces.has(collider.handle) &&
      this.matrix.collides(layer, this.layerOf(collider));
  }

  /** A two-sided mesh and its one-sided copy for ragdolls (#ragdollFaces). */
  #pairFaces(twoSided: RAPIER.Collider, faces: RAPIER.Collider, mesh: WeldedMesh): void {
    this.#twoSided.set(twoSided.handle, mesh);
    this.#ragdollFaces.add(faces.handle);
    // No surface of its own: out of the controllers' group. Each half meets its own bodies.
    this.#setLayer(faces, this.layerOf(faces));
    this.#setLayer(twoSided, this.layerOf(twoSided));
  }

  /** Gives a collider its layer, owner and material (colliders made outside this class). */
  register(collider: RAPIER.Collider, layer: number, owner: PhysicsOwner, material = 0): void {
    this.#owners.set(collider.handle, owner);
    this.#setLayer(collider, layer);
    if (material !== 0) this.#materials.set(collider.handle, material);
    // Made simulated: one of those the awake are looked for among (forEachAwake).
    const body = collider.parent();
    if (body?.isDynamic() === true) this.#simulated.set(body.handle, body);
  }

  /**
   * How many colliders an actor owns that a character controller meets (QueryGroups
   * .controllerSolid), but `except` (its controller): whether its controller's sweeps must leave
   * out bodies of its own by a call back (character.ts), or the groups say all.
   */
  controllerSolidOf(reference: number, except?: RAPIER.Collider): number {
    const count = this.#solidCount.get(reference) ?? 0;
    return except && this.#solidOwner.get(except.handle) === reference ? count - 1 : count;
  }

  /** The actor each collider counted in #solidCount counts for. */
  readonly #solidOwner = new Map<number, number>();
  readonly #solidCount = new Map<number, number>();

  /** A collider's owner or layer changed: the actors' counts of what controllers meet. */
  #countSolid(handle: number, gone = false): void {
    const owner = this.#owners.get(handle);
    const layer = this.#layers.get(handle);
    const now =
      !gone &&
      owner?.kind === 'actor' &&
      layer !== undefined &&
      this.#controllerSolid(this.world.getCollider(handle), layer)
        ? owner.reference
        : undefined;
    const was = this.#solidOwner.get(handle);
    if (was === now) return;
    if (was !== undefined) {
      const left = (this.#solidCount.get(was) ?? 1) - 1;
      if (left > 0) this.#solidCount.set(was, left);
      else this.#solidCount.delete(was);
      this.#solidOwner.delete(handle);
    }
    if (now !== undefined) {
      this.#solidCount.set(now, (this.#solidCount.get(now) ?? 0) + 1);
      this.#solidOwner.set(handle, now);
    }
  }

  /**
   * filterFor(L_CHARCONTROLLER)'s test of a collider on `layer`, and that it is no sensor (a
   * phantom, a trigger volume): no controller's sweep or cast meets one.
   */
  #controllerSolid(collider: RAPIER.Collider, layer: number): boolean {
    return (
      !collider.isSensor() &&
      !this.#ragdollFaces.has(collider.handle) &&
      this.matrix.collides(Layer.charController, layer)
    );
  }

  /** A collider's layer, and the kinds of query that find it (QueryGroups). */
  #setLayer(collider: RAPIER.Collider, layer: number): void {
    this.#layers.set(collider.handle, layer);
    let kinds = QUERY_OTHER;
    if ((this.matrix.flags(layer) & LayerFlag.triggerVolume) !== 0) kinds |= QUERY_TRIGGER;
    if (layer === Layer.trap || layer === Layer.cloudTrap) kinds |= QUERY_TRAP;
    if (layer === Layer.charController) kinds |= QUERY_CONTROLLER;
    if (this.#controllerSolid(collider, layer)) {
      kinds |= QUERY_CONTROLLER_SOLID;
      if (this.#owners.get(collider.handle)?.kind !== 'actor') kinds |= QUERY_CONTROLLER_GROUND;
    }
    // Which bodies it meets at all: a welded mesh's halves each their own (GROUP_RAGDOLL).
    const meets = this.#ragdollFaces.has(collider.handle)
      ? GROUP_RAGDOLL
      : this.#twoSided.has(collider.handle)
        ? GROUP_OTHER
        : GROUP_RAGDOLL | GROUP_OTHER;
    collider.setCollisionGroups(
      groups(kinds | (RAGDOLL_LAYERS.has(layer) ? GROUP_RAGDOLL : GROUP_OTHER), meets),
    );
    this.#countSolid(collider.handle);
    if (layer === Layer.trap) this.#trapColliders.set(collider.handle, collider);
    else this.#trapColliders.delete(collider.handle);
  }

  unregister(collider: RAPIER.Collider): void {
    this.#countSolid(collider.handle, true);
    this.#trapColliders.delete(collider.handle);
    const body = collider.parent();
    if (body) this.#trapPoses.delete(body.handle);
    this.#layers.delete(collider.handle);
    this.#systems.delete(collider.handle);
    this.#owners.delete(collider.handle);
    this.#materials.delete(collider.handle);
    this.#objectMaterials.delete(collider.handle);
    this.#passing.delete(collider.handle);
    this.#twoSided.delete(collider.handle);
    this.#ragdollFaces.delete(collider.handle);
    this.#nodes.delete(collider.handle);
  }

  /** The node of its model a body's collider hangs on (its collision object's), if known. */
  nodeOf(collider: RAPIER.Collider): string | undefined {
    return this.#nodes.get(collider.handle);
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
        // Two-sided, as Havok's triangles meet what touches them (#ragdollFaces: the one-sided
        // copy that ragdolls meet).
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
      if (dynamic) {
        this.#simulated.set(body.handle, body);
        this.#limits.set(body.handle, {
          body,
          linear: data.maxLinearVelocity > 0 ? data.maxLinearVelocity : Infinity,
          angular: data.maxAngularVelocity > 0 ? data.maxAngularVelocity : Infinity,
          solverDeactivation: data.solverDeactivation,
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
              // Over the longest step the world takes: a contact's force is its impulse over
              // the step, half as much over the complex mode's step (#collectImpacts then
              // goes by the speed).
              (data.mass * toHavok(this.impactSpeed)) / Math.max(this.#step, this.complexStep),
            );
        }
        if (data.phantom) colliderDesc.setActiveHooks(RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS);
        const collider = this.world.createCollider(colliderDesc, body);
        this.register(collider, shape.layer, owner, shape.material);
        this.#nodes.set(collider.handle, data.node);
        colliders.push(collider);
        if (shape.type === 'mesh' && shape.oneSided === true && !dynamic) {
          const s = scale / HAVOK_SCALE;
          const faces = RAPIER.ColliderDesc.trimesh(
            shape.vertices.map((v) => v * s),
            shape.indices,
            RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
          )
            .setFriction(Math.sqrt(Math.max(0, data.friction)))
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
            .setRestitution(Math.sqrt(Math.max(0, data.restitution)))
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply);
          const twin = this.world.createCollider(faces, body);
          this.register(twin, shape.layer, owner, shape.material);
          this.#pairFaces(collider, twin, {
            vertices: shape.vertices,
            indices: shape.indices,
            scale: s,
          });
          colliders.push(twin);
        }
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
      this.#jointOrder.set(placed, this.#nextJoint++);
      this.#jointScales.set(placed, scale / HAVOK_SCALE);
      const solved = solverConstraint(constraint.data, scale / HAVOK_SCALE);
      if (solved) this.#solverJoints.set(placed, { a: a.body, b: b.body, constraint: solved });
      const pivots = linkPivots(constraint.data);
      if (pivots) {
        const toLocal = scale / HAVOK_SCALE;
        const [pivotA, pivotB, rest] = pivots;
        this.#linksClipped.set(placed, {
          pivotA: [pivotA[0] * toLocal, pivotA[1] * toLocal, pivotA[2] * toLocal],
          pivotB: [pivotB[0] * toLocal, pivotB[1] * toLocal, pivotB[2] * toLocal],
          most: constraint.maxError ?? MAX_CONSTRAINT_VIOLATION,
          rest: rest * toLocal,
        });
      }
      for (const { body } of [a, b]) {
        const list = this.#jointsOf.get(body.handle);
        if (list) list.push(placed);
        else this.#jointsOf.set(body.handle, [placed]);
      }
      if (constraint.breakable) this.#breakable.add(placed);
    }
    // A chain's links, solved as one (#dampChains).
    const chains = new Map<NonNullable<CollisionConstraint['chain']>, PlacedJoint[]>();
    for (const joint of joints) {
      const chain = joint.constraint.chain;
      if (!chain) continue;
      let links = chains.get(chain);
      if (!links) chains.set(chain, (links = []));
      links.push(joint);
      this.#chainLinks.set(joint, links);
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
   * other. A ragdoll is a ball and socket here and a limited hinge a hinge: their limits and
   * friction are the constraint solver's (constraint-solver.ts, #solverJoints). A prismatic's
   * friction is a motor towards no relative speed limited to the friction's maximum (in the
   * file's units: the placement's scale does not change it). The constraints' motors are not
   * applied (no vanilla constraint has one).
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
    // The ragdoll's and limited hinge's limits (axisLimits); their friction is the constraint
    // solver's.
    const limited = (joint: RAPIER.ImpulseJoint): RAPIER.ImpulseJoint => {
      for (const { axis, min, max } of axisLimits(data)) setJointLimits(joint, axis, min, max);
      return joint;
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
        return limited(joint);
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
        setJointLimits(
          joint,
          RAPIER.JointAxis.LinX,
          data.minDistance * toLocal,
          data.maxDistance * toLocal,
        );
        // Its friction: a motor towards no relative speed whose force is the constraint's
        // maximum friction force (Havok units).
        if (data.friction > 0) {
          const raw = joint as unknown as RawJointLimits;
          const axis = RAPIER.JointAxis.LinX;
          raw.rawSet.jointConfigureMotorVelocity(raw.handle, axis, 0, JOINT_FRICTION_GAIN);
          raw.rawSet.jointSetMotorMaxForce(raw.handle, axis, data.friction);
        }
        return joint;
      }
      case 'ragdoll': {
        const joint = create(RAPIER.JointData.spherical(point(data.a.pivot), point(data.b.pivot)));
        joint.setLocalFrame1(point(data.a.pivot), frame(data.a.axes));
        joint.setLocalFrame2(point(data.b.pivot), frame(data.b.axes));
        return limited(joint);
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
          this.#giving.delete(placed);
          this.#giveLimits(placed);
          this.#easeLimits(placed);
        } else if (!needed && placed.joint) {
          if (placed.joint.isValid()) this.world.removeImpulseJoint(placed.joint, false);
          placed.joint = undefined;
          this.#giving.delete(placed);
        }
      }
    }
  }

  /**
   * A limit's give (constraint-solver.ts, limitGive): Havok's solver leaves a ragdoll's or a
   * limited hinge's angular limit as stiff as its iterations make it, so a load pressing a joint
   * on its limit holds it past it in proportion (a light link under a heavy load most of all: a
   * foot under a standing body), where Rapier's limit does not yield at all and a body let go
   * standing stayed standing on its locked ankles and knees. A joint past such a limit is
   * pushed back by a spring of the limit's stiffness (the joint's motor on that axis, toward the
   * limit, solved with the contacts in Rapier's step), and Rapier's own limit stands GIVE_STEP
   * past where the joint is: what swings into the limit is stopped, what presses on it moves it
   * on a step at a time until the spring holds the load. A joint far past its limit (let go so:
   * a dying actor's animated pose) comes back by tau of its excess a step at most, as Havok
   * brings it back. A limit of one angle stays Rapier's own and is eased (#easeLimits).
   *
   * A ragdoll's limits are its twist's, its plane's (the swing toward its plane axis) and its
   * cone (its twist axes within an angle of each other, whichever way they swing). The cone is
   * one spring about the axis the two twist axes turn about (the swing of the joint's turn
   * taken apart into a swing and then a twist), straight back toward the cone however far the
   * joint is twisted: its torque goes to the two swings' motors by the share of that axis
   * along each (each holding it with CONE_HOLD of the stiffness), so a joint swung along one
   * of them is held by that one alone and the other is free, and between the two the springs'
   * torques add up to the cone's. (Rapier's own two swing parts of the turn lie turned by half
   * the twist from that axis: shared by them, the push on a twisted joint went aside too.)
   * The swing toward the plane axis has the plane's spring too where it lies past
   * the plane's limits. Rapier's limits on the two swings (the box about the cone) stand as
   * for the others, and what swings a joint past the cone between them is stopped by the
   * constraint solver: it takes out the speed the bodies have further past a cone that gives,
   * without the step's gravity, and does not push it back (SolverJoint.coneGives).
   *
   * A spring is on from GIVE_ON past its limit until the joint is back at it, and for
   * GIVE_SLACK within the limit its damping stays. The springs follow the step and how the
   * bodies lie: each step they are measured again, and set where they changed.
   */
  #giveLimits(placed: PlacedJoint): void {
    const joint = placed.joint;
    const solved = this.#solverJoints.get(placed);
    const inner = articulated(placed.constraint.data);
    if (!joint?.isValid() || !solved || !inner) {
      this.#giving.delete(placed);
      if (solved) solved.coneGives = false;
      return;
    }
    const raw = joint as unknown as RawJointLimits;
    const factor = inner.type === 'ragdoll' ? RAGDOLL_LIMIT_TAU_FACTOR : HINGE_LIMIT_TAU_FACTOR;
    const give = (index: 0 | 1 | 2 | 'cone') =>
      jointLimitGive(solved, index, factor, this.#size, this.solver);
    let giving = this.#giving.get(placed);
    if (!giving) {
      const axes: GivingAxis[] = [];
      const limits = axisLimits(placed.constraint.data);
      for (let i = 0; i < limits.length && i < 3; i++) {
        const limit = limits[i];
        const index = i as 0 | 1 | 2;
        if (!limit || limit.max - limit.min < POINT_LIMIT) continue;
        const { axis, min, max } = limit;
        // Its own limit: the hinge's, the twist's, the plane's (not cut to the cone, which
        // has its own spring).
        let own: GivingAxis['own'];
        if (inner.type === 'limited-hinge' || index === 0) own = { min, max };
        else if (index === 2) {
          own = {
            min: Math.min(-inner.planeMaxAngle, -inner.planeMinAngle),
            max: Math.max(-inner.planeMaxAngle, -inner.planeMinAngle),
          };
        }
        // A spring of the stiffness as it is (Rapier's own model scales it by the bodies'
        // masses); off until the joint lies past a limit.
        raw.rawSet.jointConfigureMotorModel(raw.handle, axis, RAPIER.MotorModel.ForceBased);
        raw.rawSet.jointSetMotorMaxForce(raw.handle, axis, 0);
        axes.push({
          index,
          axis,
          min,
          max,
          own,
          side: 0,
          stiffness: 0,
          target: 0,
          damping: 0,
          lo: min,
          hi: max,
        });
      }
      // The cone gives where the swing it alone limits does.
      const cone =
        inner.type === 'ragdoll' && axes.some((axis) => axis.index === 1)
          ? Math.abs(inner.coneMaxAngle)
          : undefined;
      giving = { axes, cone, coned: false };
      this.#giving.set(placed, giving);
    } else if (placed.a.body.isSleeping() && placed.b.body.isSleeping()) {
      // Asleep, it stays as it is (a joint changed wakes its bodies).
      return;
    }
    const { axes } = giving;
    const angles = axes.map((axis) => jointAngle(joint, axis.axis));
    const pushes: AxisPush[] = axes.map(() => ({
      torque: 0,
      stiffness: 0,
      damping: 0,
      most: 0,
      move: 0,
      far: false,
    }));
    // A spring's share on an axis: its torque for how far past the limit the joint lies along
    // it, held with `share` of its stiffness, and that share of its damping.
    const add = (push: AxisPush, stiffness: number, past: number, share: number): void => {
      push.torque -= stiffness * past;
      push.stiffness += stiffness * share;
      push.damping += stiffness * share * this.#size * GIVE_DAMPING;
      push.most = Math.max(push.most, stiffness);
      push.move -= past;
    };
    // Each axis's own limit.
    for (let i = 0; i < axes.length; i++) {
      const axis = axes[i];
      const push = pushes[i];
      const own = axis?.own;
      if (!axis || !push || !own) continue;
      const angle = angles[i] ?? 0;
      const excess = angle > own.max ? angle - own.max : angle < own.min ? angle - own.min : 0;
      // The spring comes on GIVE_ON past the limit and stays on while the joint is past it at
      // all; back within it, only its damping stays, for GIVE_SLACK.
      const side = Math.abs(excess) > GIVE_ON || axis.side !== 0 ? Math.sign(excess) : 0;
      const near =
        side === 0 &&
        (axis.side > 0
          ? angle > own.max - GIVE_SLACK
          : axis.side < 0 && angle < own.min + GIVE_SLACK);
      const spring = side !== 0 || near ? give(axis.index) : undefined;
      if (!spring) {
        axis.side = 0;
      } else if (side !== 0) {
        axis.side = side;
        add(push, spring.stiffness, angle - (side > 0 ? own.max : own.min), 1);
        if (Math.abs(excess) > EASED_EXCESS) push.far = true;
      } else {
        push.damping += spring.stiffness * this.#size * GIVE_DAMPING;
      }
    }
    // The cone: Rapier's two swing angles are 2 asin of the turn's parts about the plane axis
    // and the third, and the sine of half the angle between the twist axes is the two's length.
    // (The solver takes out what swings the joint further past it: SolverJoint.coneGives.)
    solved.coneGives = giving.cone !== undefined;
    if (giving.cone !== undefined) {
      const parts = [
        Math.sin(jointAngle(joint, RAPIER.JointAxis.AngY) / 2),
        Math.sin(jointAngle(joint, RAPIER.JointAxis.AngZ) / 2),
      ] as const;
      const half = Math.min(1, Math.hypot(parts[0], parts[1]));
      const excess = 2 * Math.asin(half) - giving.cone;
      // On and off as an axis's own (above).
      const on = excess > GIVE_ON || (giving.coned && excess > 0);
      const near = !on && giving.coned && excess > -GIVE_SLACK;
      const spring = (on || near) && half > 1e-6 ? give('cone') : undefined;
      if (spring) {
        // The axis the twist axes turn about. The turn (w, x, y, z), x about the twist axis, is a
        // swing s about an axis across it, then a twist t about it: w = cos s/2 cos t/2,
        // x = cos s/2 sin t/2, and (y, z) is the swing's own sin s/2 × axis turned back by t/2.
        // So (w y - x z, w z + x y) is that axis × sin s/2 cos s/2. Shared by Rapier's (y, z),
        // the push on a twisted joint went aside too: a 10 kg weight on a cone of 0.5 rad came
        // to rest 2.3, 5.4 and 7.2 units beside its lowest point at 0.2, 0.45 and 0.7 rad of
        // twist ("lets a twisted ragdoll joint's cone give …").
        const twist = Math.sin(jointAngle(joint, RAPIER.JointAxis.AngX) / 2);
        const w = Math.sqrt(Math.max(0, 1 - twist * twist - half * half));
        const swing = [w * parts[0] - twist * parts[1], w * parts[1] + twist * parts[0]] as const;
        const length = Math.hypot(swing[0], swing[1]);
        for (let i = 0; i < axes.length; i++) {
          const axis = axes[i];
          const push = pushes[i];
          if (!axis || !push || axis.index === 0 || length < 1e-9) continue;
          const along = swing[axis.index === 1 ? 0 : 1] / length;
          if (along * along < CONE_SHARE) continue;
          const share = Math.min(1, CONE_HOLD * along * along);
          if (on) add(push, spring.stiffness, excess * along, share);
          else push.damping += spring.stiffness * share * this.#size * GIVE_DAMPING;
          if (excess > EASED_EXCESS) push.far = true;
        }
      }
      giving.coned = spring !== undefined;
    }
    const back = Math.min(1, this.solver.tau * factor);
    const differs = (now: number, before: number): boolean =>
      Math.abs(now - before) > GIVE_STIFFNESS_CHANGE * Math.max(now, before);
    for (let i = 0; i < axes.length; i++) {
      const axis = axes[i];
      const push = pushes[i];
      if (!axis || !push) continue;
      const angle = angles[i] ?? 0;
      if (push.stiffness > 0 || push.damping > 0) {
        // Set where it changed: its stiffness or its damping, or its torque by what a
        // thousandth of a radian is to its stiffest spring (setting a joint wakes its bodies).
        const target = push.stiffness > 0 ? angle + push.torque / push.stiffness : angle;
        const held = axis.stiffness * (axis.target - angle);
        const off = axis.stiffness === 0 && axis.damping === 0;
        if (
          off ||
          differs(push.stiffness, axis.stiffness) ||
          differs(push.damping, axis.damping) ||
          Math.abs(push.torque - held) > push.most * EASED_CHANGE
        ) {
          raw.rawSet.jointConfigureMotorPosition(
            raw.handle,
            axis.axis,
            target,
            push.stiffness,
            push.damping,
          );
          if (off) raw.rawSet.jointSetMotorMaxForce(raw.handle, axis.axis, MOTOR_FORCE);
          axis.stiffness = push.stiffness;
          axis.damping = push.damping;
          axis.target = target;
        }
      } else if (axis.stiffness !== 0 || axis.damping !== 0) {
        raw.rawSet.jointSetMotorMaxForce(raw.handle, axis.axis, 0);
        axis.stiffness = 0;
        axis.damping = 0;
      }
      // Past Rapier's limit with no spring (nothing of the two turns yet): the limit as it is,
      // until there is one.
      const excess = angle > axis.max ? angle - axis.max : angle < axis.min ? angle - axis.min : 0;
      const sprung = axis.stiffness > 0 || Math.abs(excess) <= GIVE_ON;
      const low = Math.min(axis.min, angle);
      const high = Math.max(axis.max, angle);
      let lo = sprung ? low - GIVE_STEP : axis.min;
      let hi = sprung ? high + GIVE_STEP : axis.max;
      // Rapier's limit follows a joint past it only once the joint has moved half a step's
      // give (a joint creeping to rest is not woken by every hair it moves).
      if (sprung && axis.lo <= low - GIVE_STEP / 2 && axis.lo >= lo - GIVE_STEP / 2) lo = axis.lo;
      if (sprung && axis.hi >= high + GIVE_STEP / 2 && axis.hi <= hi + GIVE_STEP / 2) hi = axis.hi;
      // Far past a limit: back by tau of the way a step at most.
      if (sprung && push.far && push.move < -EASED_CHANGE) lo = angle + back * push.move;
      else if (sprung && push.far && push.move > EASED_CHANGE) hi = angle + back * push.move;
      // Only a change is set (setting a joint wakes its bodies).
      if (Math.abs(lo - axis.lo) > EASED_CHANGE || Math.abs(hi - axis.hi) > EASED_CHANGE) {
        setJointLimits(joint, axis.axis, lo, hi);
        axis.lo = lo;
        axis.hi = hi;
      }
    }
  }

  /**
   * Soft limits (constraint-solver.ts, easedLimit): a ragdoll or limited hinge joint whose
   * bodies lie past its limits (made in a dying actor's animated pose, or let go so) has those
   * limits moved to tau (× the limit's tau factor) of the way from its angles back to them,
   * every step until its angles are within them, as Havok's solver brings a violated limit back
   * by tau of its error a step; Rapier's stiff limits snapped such a joint back within a step
   * and flung its body off. Returns whether it still is past them.
   */
  #easeLimits(placed: PlacedJoint): boolean {
    const joint = placed.joint;
    const data = placed.constraint.data;
    const inner = articulated(data);
    if (!joint?.isValid() || !inner) {
      this.#easing.delete(placed);
      return false;
    }
    // Asleep, it stays as it is (a joint changed wakes its bodies, and they fell through the
    // ground they lay on).
    const { a, b } = placed;
    if (this.#easing.has(placed) && a.body.isSleeping() && b.body.isSleeping()) return true;
    const factor = inner.type === 'ragdoll' ? RAGDOLL_LIMIT_TAU_FACTOR : HINGE_LIMIT_TAU_FACTOR;
    const tau = this.#stepSolver.tau * factor;
    let past = false;
    const before = this.#easing.get(placed);
    const bounds: number[] = [];
    const limits = axisLimits(data);
    const giving = this.#giving.get(placed);
    for (let i = 0; i < limits.length; i++) {
      const limit = limits[i];
      if (!limit) continue;
      const { axis, min, max } = limit;
      // A limit that gives comes back by its spring (#giveLimits).
      if (giving?.axes.some((given) => given.axis === axis)) {
        bounds.push(min, max);
        continue;
      }
      const wasLo = before?.[2 * i];
      const wasHi = before?.[2 * i + 1];
      const eased = easedLimit(jointAngle(joint, axis), min, max, tau);
      if (eased) past = true;
      let [lo, hi] = eased ?? [min, max];
      // The bounds only close in (Havok's limit takes out the speed away from it: what pushes
      // the joint further past it does not widen it).
      if (eased && wasLo !== undefined && wasHi !== undefined) {
        lo = Math.max(lo, wasLo);
        hi = Math.min(hi, wasHi);
      }
      // Only a change is set (setting a joint wakes its bodies: a ragdoll held past a limit by
      // the ground never slept).
      if (
        wasLo !== undefined &&
        wasHi !== undefined &&
        Math.abs(wasLo - lo) < EASED_CHANGE &&
        Math.abs(wasHi - hi) < EASED_CHANGE
      ) {
        bounds.push(wasLo, wasHi);
        continue;
      }
      bounds.push(lo, hi);
      setJointLimits(joint, axis, lo, hi);
    }
    if (past) this.#easing.set(placed, bounds);
    else this.#easing.delete(placed);
    return past;
  }

  /** A joint is gone for good (broken, or its bodies removed). */
  #forgetJoint(placed: PlacedJoint): void {
    this.#breakable.delete(placed);
    this.#groupErrors.delete(placed);
    this.#jointScales.delete(placed);
    this.#easing.delete(placed);
    this.#giving.delete(placed);
    this.#clipped.delete(placed);
    this.#linksClipped.delete(placed);
    this.#chainLinks.delete(placed);
    this.#damped.delete(placed);
    this.#solverJoints.delete(placed);
    for (const { body } of [placed.a, placed.b]) {
      const list = this.#jointsOf.get(body.handle);
      if (!list) continue;
      const left = list.filter((joint) => joint !== placed);
      if (left.length > 0) this.#jointsOf.set(body.handle, left);
      else this.#jointsOf.delete(body.handle);
    }
  }

  /**
   * What a breakable joint weighed against its threshold in the last step it was solved with its
   * group (Havok's solver results: #solveBreakable), also in the step it broke; undefined for one
   * never solved so.
   */
  breakableLoad(joint: PlacedJoint): number | undefined {
    return this.#lastLoads.get(joint);
  }

  /**
   * Before the step: the solver results each breakable joint (a ball and socket, a hinge) takes
   * in it, solved as Havok solves it with every point joint that holds the bodies it reaches
   * through simulated bodies (src/physics/joint-impulses.ts: the step's iterations, the world's
   * tau and damping, a chain's own, a hinge's angular rows): the mace trap's pin holds its mace
   * against the mace's weight and the pull of the chain it hangs by. Rapier does not expose its
   * joints' impulses.
   */
  #solveBreakable(): void {
    this.#breakableLoads.clear();
    this.#groupBodies.clear();
    const sub = (a: RAPIER.Vector, b: RAPIER.Vector): RAPIER.Vector => ({
      x: a.x - b.x,
      y: a.y - b.y,
      z: a.z - b.z,
    });
    const gravity = this.world.gravity;
    for (const placed of this.#breakable) {
      if (!placed.joint?.isValid() || !this.#linksClipped.has(placed)) continue;
      const { a, b } = placed;
      if (
        !(a.body.isDynamic() && !a.body.isSleeping()) &&
        !(b.body.isDynamic() && !b.body.isSleeping())
      )
        continue;
      // The group: the point joints reached through simulated bodies.
      const group: PlacedJoint[] = [];
      const seen = new Set<PlacedJoint>();
      const visited = new Set<number>();
      const queue: PlacedBody[] = [];
      const add = (joint: PlacedJoint): void => {
        if (seen.has(joint) || group.length >= BREAKABLE_GROUP_JOINTS) return;
        seen.add(joint);
        const link = this.#linksClipped.get(joint);
        if (!joint.joint?.isValid() || link?.rest !== 0) return;
        group.push(joint);
        queue.push(joint.a, joint.b);
      };
      add(placed);
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next || visited.has(next.body.handle) || !next.body.isDynamic()) continue;
        visited.add(next.body.handle);
        for (const joint of this.#jointsOf.get(next.body.handle) ?? []) add(joint);
      }
      // A body made a moment ago has no mass yet (Rapier computes it as it steps).
      const unweighed = ({ body }: PlacedBody): boolean =>
        body.isDynamic() && !(body.invMass() > 0);
      if (group.some((joint) => unweighed(joint.a) || unweighed(joint.b))) continue;
      const index = new Map<number, number>();
      const bodies: ImpulseBody[] = [];
      const indexOf = ({ body, data }: PlacedBody): number => {
        const known = index.get(body.handle);
        if (known !== undefined) return known;
        this.#groupBodies.set(body.handle, body);
        // What moved it since the last step: Rapier's joints leave a chain's links drifting apart
        // a little every step (a stiff chain does not), and that drift is no load.
        const was = this.#groupVelocities.get(body.handle);
        const now = [body.linvel(), body.angvel()] as const;
        const lin = was ? sub(now[0], was[0]) : now[0];
        const ang = was ? sub(now[1], was[1]) : now[1];
        let entry: ImpulseBody;
        if (body.isDynamic()) {
          const m = body.effectiveWorldInvInertia();
          const g = data.gravityFactor * this.#size;
          entry = {
            invMass: body.invMass(),
            invInertia: [m.m11, m.m12, m.m13, m.m22, m.m23, m.m33],
            linear: [lin.x + gravity.x * g, lin.y + gravity.y * g, lin.z + gravity.z * g],
            angular: [ang.x, ang.y, ang.z],
          };
        } else {
          entry = {
            invMass: 0,
            invInertia: [0, 0, 0, 0, 0, 0],
            linear: [lin.x, lin.y, lin.z],
            angular: [ang.x, ang.y, ang.z],
          };
        }
        bodies.push(entry);
        index.set(body.handle, bodies.length - 1);
        return bodies.length - 1;
      };
      // Havok solves the island's constraints in the order they were added.
      group.sort((x, y) => (this.#jointOrder.get(x) ?? 0) - (this.#jointOrder.get(y) ?? 0));
      const joints: GroupJoint[] = [];
      for (const joint of group) {
        const link = this.#linksClipped.get(joint);
        if (link) joints.push(this.#groupJoint(joint, link, indexOf(joint.a), indexOf(joint.b)));
      }
      const results = groupImpulses(bodies, joints, {
        step: this.#size,
        iterations: this.#stepSolver.iterations,
      });
      const own = results[group.indexOf(placed)];
      if (own) {
        this.#breakableLoads.set(placed, solverResultSize(own));
        this.#lastLoads.set(placed, solverResultSize(own));
      }
      // What the iterations left of the pivots' speed opens their error over the step.
      group.forEach((joint, i) => {
        const left = results[i]?.left;
        const most = this.#linksClipped.get(joint)?.most ?? MAX_CONSTRAINT_VIOLATION;
        if (left)
          this.#groupErrors.set(
            joint,
            openError(this.#groupErrors.get(joint), left, this.#size, most),
          );
      });
    }
  }

  /**
   * A joint of a breakable joint's group as Havok's solver takes it (joint-impulses.ts): its
   * pivots from its bodies' centres of mass and their error, a hinge's two angular rows across
   * its axle with their error; a chain's link with its chain's tau, damping and constraint force
   * mixing (solved as one block), the others with the world solver's tau and damping; a
   * malleable constraint's strength as its virtual mass factor.
   */
  #groupJoint(
    joint: PlacedJoint,
    link: { readonly pivotA: Vec3; readonly pivotB: Vec3; readonly most: number },
    a: number,
    b: number,
  ): GroupJoint {
    const bodyA = joint.a.body;
    const bodyB = joint.b.body;
    const world = (body: RAPIER.RigidBody, pivot: Vec3): RAPIER.Vector => {
      const t = body.translation();
      const p = rotateVector(body.rotation(), { x: pivot[0], y: pivot[1], z: pivot[2] });
      return { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z };
    };
    const fromCom = (body: RAPIER.RigidBody, point: RAPIER.Vector): Vec3 => {
      const c = body.worldCom();
      return [point.x - c.x, point.y - c.y, point.z - c.z];
    };
    const pa = world(bodyA, link.pivotA);
    const pb = world(bodyB, link.pivotB);
    const error = this.#groupErrors.get(joint);
    const { chain, data } = joint.constraint;
    const strength = data.type === 'malleable' ? Math.max(0, data.strength) : 1;
    const inner = data.type === 'malleable' ? data.inner : data;
    let angular: [Vec3, number][] | undefined;
    if (inner.type === 'hinge') {
      const axis = (body: RAPIER.RigidBody, v: Vec3): Vec3 => {
        const r = rotateVector(body.rotation(), { x: v[0], y: v[1], z: v[2] });
        return [r.x, r.y, r.z];
      };
      // About the two axes across its axle (as body A holds it), each with its error.
      const [axle, across] = inner.a.axes;
      angular = [across, cross(axle, across)].map((v, i) => [
        axis(bodyA, v),
        error?.angular[i] ?? 0,
      ]);
    }
    return {
      a,
      b,
      ra: fromCom(bodyA, pa),
      rb: fromCom(bodyB, pb),
      ...(error && { error: error.linear }),
      ...(angular && { angular }),
      tau: chain ? chain.tau : this.#stepSolver.tau,
      damping: chain ? chain.damping : this.#stepSolver.damping,
      ...(chain && { softness: chain.constraintForceMixing, block: chain.index }),
      ...(strength !== 1 && { strength }),
    };
  }

  /**
   * Breakable constraints break when the impulse on them in a step exceeds their threshold
   * (Havok's units: kg·m/s, the beehive's 20 holding its 10 kg, a step taking 1.6). A ball and
   * socket or hinge takes its solver results in the step's solve of its group (#solveBreakable:
   * the root of the sum of their squares, Havok's hkpBreakableConstraintData measure); the others
   * (stiff springs: the beehives) the change of momentum of their simulated body that gravity
   * does not explain. TODO(M13): inferred; contacts on the bodies count as well.
   */
  #breakJoints(): void {
    const gravity = this.world.gravity;
    // Where the step left the groups' bodies (#solveBreakable's next step starts from them).
    const after = new Map<number, readonly [RAPIER.Vector, RAPIER.Vector]>();
    for (const [handle, body] of this.#groupBodies) {
      if (body.isValid()) after.set(handle, [body.linvel(), body.angvel()]);
    }
    this.#groupVelocities = after;
    for (const placed of this.#breakable) {
      const joint = placed.joint;
      const threshold = placed.constraint.breakable?.threshold ?? Infinity;
      // Out of the world while both its bodies are held (#syncJoints): nothing pulls on it.
      if (!joint) continue;
      if (!joint.isValid()) {
        this.#forgetJoint(placed);
        continue;
      }
      // Solved with its group: its solver results (#solveBreakable).
      let impulse = this.#breakableLoads.get(placed) ?? 0;
      if (!this.#breakableLoads.has(placed))
        for (const { body, data } of [placed.a, placed.b]) {
          const before = this.#velocities.get(body.handle);
          if (!before || !body.isDynamic()) continue;
          const after = body.linvel();
          const g = data.gravityFactor * this.#size;
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
   * A collision primitive: a box (`bounds`: its half extents, as XPRM stores them) or sphere
   * (`bounds[0]`: radius) placed at `world` (with its scale), on `layer`.
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
        ? RAPIER.ColliderDesc.cuboid(bounds[0] * s, bounds[1] * s, bounds[2] * s)
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
    const { position, rotation } = this.bodyTarget(placed, modelPose, world);
    body.body.setNextKinematicTranslation({ x: position[0], y: position[1], z: position[2] });
    body.body.setNextKinematicRotation(rotation);
  }

  /**
   * Where a body of a placement is with `modelPose` (its pose in the model, game units) under
   * the placement `world`: Havok units, world space (as moveBody puts it).
   */
  bodyTarget(placed: PlacedCollision, modelPose: Mat4, world: Mat4): BodyFrame {
    return this.bodyTargets(placed, world)(modelPose);
  }

  /**
   * bodyTarget for any number of bodies of a placement under one `world` (an actor's bodies
   * each frame): the world's rotation and translation taken once, no matrix made per body.
   */
  bodyTargets(placed: PlacedCollision, world: Mat4): (modelPose: Mat4) => BodyFrame {
    const parent = rigidPart(world);
    const local = new Float32Array(16);
    const pose = new Float32Array(16);
    return (modelPose) => {
      rigidPartInto(modelPose, local);
      local[12] = (local[12] ?? 0) * placed.scale;
      local[13] = (local[13] ?? 0) * placed.scale;
      local[14] = (local[14] ?? 0) * placed.scale;
      multiplyInto(parent, local, pose);
      return {
        position: [toHavok(pose[12] ?? 0), toHavok(pose[13] ?? 0), toHavok(pose[14] ?? 0)],
        rotation: matrixQuaternion(pose),
      };
    };
  }

  /**
   * A simulated body's velocities set (Havok units a second), at most its own maximum speeds
   * (a body let go moving as its animation moved it).
   */
  setBodyVelocity(body: PlacedBody, linear: Vec3, angular: Vec3): void {
    const most = (v: Vec3, limit: number): Vec3 => {
      const length = Math.hypot(v[0], v[1], v[2]);
      return length > limit && length > 0
        ? [v[0] * (limit / length), v[1] * (limit / length), v[2] * (limit / length)]
        : v;
    };
    const v = most(linear, body.data.maxLinearVelocity);
    const w = most(angular, body.data.maxAngularVelocity);
    body.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
    body.body.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
  }

  /**
   * A ragdoll made dynamic (observed in the original: its driver's motion type set to dynamic):
   * each of its simulated bodies moving slower than RAGDOLL_LIFT (Havok units a second) has
   * that much added upward to its speed, so that no body let go still stays as it was placed.
   */
  liftStill(placed: PlacedCollision): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data) || !body.isDynamic()) continue;
      const v = body.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z >= RAGDOLL_LIFT * RAGDOLL_LIFT) continue;
      body.setLinvel({ x: v.x, y: v.y, z: v.z + RAGDOLL_LIFT }, true);
    }
  }

  /** A body's place (Havok units, world space). */
  bodyFrame(body: PlacedBody): BodyFrame {
    const t = body.body.translation();
    const r = body.body.rotation();
    return { position: [t.x, t.y, t.z], rotation: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  /** A body's place and velocities (Havok units, world space). */
  bodyMotion(body: PlacedBody): BodyMotion {
    const t = body.body.translation();
    const r = body.body.rotation();
    const v = body.body.linvel();
    const w = body.body.angvel();
    return {
      position: [t.x, t.y, t.z],
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      linear: [v.x, v.y, v.z],
      angular: [w.x, w.y, w.z],
    };
  }

  /**
   * Drives a body by velocities (Havok units a second; the hierarchy controller's,
   * keyframe-hierarchy.ts): a simulated body moves at them from now on, a keyframed one goes
   * where they take it in `seconds` (its place `from`, else where it is), by the next step.
   */
  driveBody(
    body: PlacedBody,
    linear: Vec3,
    angular: Vec3,
    seconds: number,
    from?: BodyFrame,
  ): void {
    const rapier = body.body;
    if (rapier.isDynamic()) {
      this.setBodyVelocity(body, linear, angular);
      return;
    }
    const next = integrate(from ?? this.bodyMotion(body), linear, angular, seconds);
    rapier.setNextKinematicTranslation({
      x: next.position[0],
      y: next.position[1],
      z: next.position[2],
    });
    rapier.setNextKinematicRotation(next.rotation);
  }

  /**
   * Landscape (or any fixed triangle mesh) in game units, world space. With `ground`: a landscape,
   * its triangles facing up (counter-clockwise seen from above): ragdolls meet it from above only,
   * as Havok's landscape is (#ragdollFaces), so a limb that went under it is not held there (its
   * contacts from below are dropped and its joints bring it back up), and catches on no edge
   * between its triangles.
   */
  addMesh(
    vertices: Float32Array,
    indices: Uint32Array,
    layer: number,
    owner: PhysicsOwner,
    ground = false,
  ): PlacedCollision {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const scaled = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i++) scaled[i] = (vertices[i] ?? 0) / HAVOK_SCALE;
    const made = (flags: RAPIER.TriMeshFlags | undefined): RAPIER.Collider => {
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.trimesh(scaled, indices, flags)
          .setFriction(Math.sqrt(0.5))
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply),
        body,
      );
      this.register(collider, layer, owner);
      return collider;
    };
    const collider = made(undefined);
    const colliders = [collider];
    if (ground) {
      const twin = made(RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
      this.#pairFaces(collider, twin, { vertices, indices, scale: 1 / HAVOK_SCALE });
      colliders.push(twin);
    }
    this.#changed = true;
    return new PlacedCollision(owner, [], colliders, 1, [body]);
  }

  /**
   * A script joins two bodies by a ball and socket (Game.AddHavokBallAndSocketConstraint: a
   * hanged corpse's neck to its noose, a key to its hook): `pivotA` and `pivotB` in each body's
   * own frame (game units; the node's local offsets). The two do not collide with each other;
   * held bodies move from now on. Returns whether they were joined. TODO(M13): the offsets are
   * taken in the body's frame, which is its node's for the vanilla bodies the calls name.
   */
  joinBallAndSocket(a: PlacedBody, pivotA: Vec3, b: PlacedBody, pivotB: Vec3): boolean {
    const bodyA = a.body;
    const bodyB = b.body;
    if (!bodyA.isValid() || !bodyB.isValid() || bodyA.handle === bodyB.handle) return false;
    // Joined already (made again as their cells load: a script's own OnLoad may ask too).
    if (this.#joined(bodyA, bodyB)) return true;
    if (!bodyA.isDynamic() && !bodyB.isDynamic() && !this.#held.has(bodyA.handle)) {
      if (!this.#held.has(bodyB.handle)) return false;
    }
    for (const body of [bodyA, bodyB]) this.release(body);
    const havok = (v: Vec3): RAPIER.Vector => ({
      x: toHavok(v[0]),
      y: toHavok(v[1]),
      z: toHavok(v[2]),
    });
    const joint = this.world.createImpulseJoint(
      RAPIER.JointData.spherical(havok(pivotA), havok(pivotB)),
      bodyA,
      bodyB,
      true,
    );
    joint.setContactsEnabled(false);
    this.#scriptJoints.push({ joint, a: bodyA.handle, b: bodyB.handle });
    this.#changed = true;
    return true;
  }

  /** Whether a script's joint holds these two bodies together now. */
  #joined(a: RAPIER.RigidBody, b: RAPIER.RigidBody): boolean {
    return this.#scriptJoints.some(
      (entry) =>
        entry.joint.isValid() &&
        ((entry.a === a.handle && entry.b === b.handle) ||
          (entry.a === b.handle && entry.b === a.handle)),
    );
  }

  /** How many joints scripts made hold two bodies now (the cases'). */
  get scriptJointCount(): number {
    return this.#scriptJoints.filter((entry) => entry.joint.isValid()).length;
  }

  /**
   * Game.RemoveHavokConstraints: the joints scripts made between two bodies go (they fall
   * free). Returns how many went.
   */
  removeScriptJoints(a: PlacedBody, b: PlacedBody): number {
    const handles = new Set([a.body.handle, b.body.handle]);
    let removed = 0;
    for (const entry of [...this.#scriptJoints]) {
      if (!entry.joint.isValid()) {
        this.#scriptJoints.splice(this.#scriptJoints.indexOf(entry), 1);
        continue;
      }
      if (!handles.has(entry.a) || !handles.has(entry.b)) continue;
      this.world.removeImpulseJoint(entry.joint, true);
      this.#scriptJoints.splice(this.#scriptJoints.indexOf(entry), 1);
      removed++;
    }
    return removed;
  }

  #sinceBounds = 0;

  /** The joints scripts made (joinBallAndSocket), with their bodies' handles. */
  readonly #scriptJoints: { joint: RAPIER.ImpulseJoint; a: number; b: number }[] = [];

  remove(placed: PlacedCollision): void {
    this.#gone.add(placed.owner.reference);
    this.#stiff.delete(placed);
    // Removing a body removes its joints.
    for (const joint of placed.joints) this.#forgetJoint(joint);
    for (const collider of placed.colliders) this.unregister(collider);
    // Removing a body removes its colliders.
    for (const { body } of placed.bodies) {
      this.#held.delete(body.handle);
      this.#limits.delete(body.handle);
      this.#simulated.delete(body.handle);
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
    // The engine's rule (observed in the original): a frame hands Havok its time and the time still owed,
    // at most uMaxNumPhysicsStepsPerUpdate steps of it (the rest stays owed: a slow frame is
    // made up later), and nothing under a millisecond (it is owed too). Havok then steps its
    // fixed step until its time reaches what it was handed. The step and its cap scale with the
    // world's time multiplier (Slow Time: `seconds` is the slowed frame's), so it steps as often
    // as at full speed, each step shorter.
    const scale = Math.min(1, Math.max(MIN_TIME_SCALE, this.timeScale?.() ?? 1));
    const whole = this.complex ? this.complexStep : this.#step;
    const size = whole * scale;
    if (size !== this.#size) {
      this.#size = size;
      this.world.timestep = size;
      // A longer step takes as many more of Rapier's iterations, as the engine's solver does
      // (solverSettings: its iterations times the step over fMaxTime): what is stacked and
      // hinged is solved as often a second in the complex mode as out of it.
      this.world.integrationParameters.numSolverIterations =
        SOLVER_ITERATIONS * Math.max(1, Math.round(whole / this.#step));
    }
    const owed = this.#owed + seconds;
    const most = size * (this.complex ? this.complexSteps : this.maxSteps);
    const handed = Math.min(owed, most);
    if (handed < MIN_FRAME_SECONDS * scale) {
      this.#owed = owed;
      return 0;
    }
    // What a long frame could not hand stays owed and is made up in the frames after it, but
    // no more than one frame hands at most: frames that stay long (below 20 a second; below 30
    // in the complex mode) owed more each, without end, and once they were short again every
    // frame took its most steps until minutes of it were made up, the world and everyone walking
    // in it at up to three times their speed. TODO(M13): ours; what bounds the original's (its
    // own frame time's clamp, perhaps) was not read.
    this.#owed = Math.min(owed - handed, most);
    this.#accumulator += handed;
    let steps = 0;
    while (this.#accumulator > STEP_EPSILON) {
      beforeStep?.(size);
      // Before the solver's changes: the joints' impulses (#breakJoints) include its own.
      this.#recordVelocities();
      if (this.#solverJoints.size > 0) this.#solveJoints();
      if (this.#linksClipped.size > 0) this.#clipLinks();
      if (this.#chainLinks.size > 0) this.#dampChains();
      if (this.#breakable.size > 0) this.#solveBreakable();
      stepWorld(this.world, this.#events, this.#hooks);
      this.#changed = false;
      if (this.#settling.size > 0 && this.#twoSided.size > 0) this.#weld();
      this.#holdAwake();
      if (this.#limits.size > 0) this.#limitVelocities();
      this.#time += size;
      if (this.#depenetrating.size > 0) this.#depenetrate();
      if (this.#held.size > 0) this.#releaseTouched();
      if (this.#hungToCheck.length > 0) this.#ignoreHungOverlaps();
      if (this.#breakable.size > 0) this.#breakJoints();
      this.#leaveBounds();
      this.#deactivate();
      this.#collectImpacts();
      this.#accumulator -= size;
      steps++;
    }
    return steps;
  }

  /**
   * A simulated body that left the world's bounds goes out of the simulation (Havok's broad phase
   * border, set to remove what leaves it): one that fell through everything does not fall on for
   * good, nor is it stepped. Looked at a few times a second. TODO(M13): the original's bounds and
   * what its border does with an entity were not read: WORLD_BOUNDS is ours, past every
   * worldspace's cells, and it is taken out and left as it is, its reference where it was last.
   */
  #leaveBounds(): void {
    this.#sinceBounds += this.#size;
    if (this.#sinceBounds < BOUNDS_CHECK) return;
    this.#sinceBounds = 0;
    this.forEachAwake((body) => {
      const at = body.translation();
      if (
        Math.abs(at.x) > WORLD_BOUNDS ||
        Math.abs(at.y) > WORLD_BOUNDS ||
        Math.abs(at.z) > WORLD_BOUNDS
      ) {
        body.setEnabled(false);
      }
    });
  }

  /**
   * The ragdoll and limited hinge joints in the world (constraint-solver.ts): their friction for
   * the step, and their limits eased where they lie past them (#easeLimits).
   */
  #solveJoints(): void {
    for (const placed of [...this.#easing.keys()]) this.#easeLimits(placed);
    const active: SolverJoint[] = [];
    for (const [placed, joint] of this.#solverJoints) {
      const made = placed.joint;
      if (!made?.isValid()) continue;
      this.#giveLimits(placed);
      active.push(joint);
      this.#clipViolation(placed, made, joint, joint.constraint.a.pivot, joint.constraint.b.pivot);
    }
    solveJoints(
      active,
      this.#size,
      this.world.gravity,
      this.world.integrationParameters.numSolverIterations,
      this.#stepSolver,
    );
  }

  /**
   * The joints the constraint solver does not take clip their error as those it takes do
   * (#clipViolation): a chain's links (bhkBallSocketConstraintChain) to the chain's own
   * maxErrorDistance (0.1 Havok units in every chain of the data: the traps' ropes and chains),
   * hinges, balls and sockets and stiff springs to the world's.
   */
  #clipLinks(): void {
    for (const [placed, { pivotA, pivotB, most, rest }] of this.#linksClipped) {
      const made = placed.joint;
      if (!made?.isValid()) continue;
      this.#clipViolation(
        placed,
        made,
        { a: placed.a.body, b: placed.b.body },
        pivotA,
        pivotB,
        most,
        rest,
      );
    }
  }

  /**
   * A chain's damping (bhkBallSocketConstraintChain damping, 0.6 in every chain of the data):
   * Havok solves a chain's links as one block, each iteration taking `damping` of the way from
   * their pivots' relative velocity to the one that closes `tau` of their error, so the step's
   * iterations leave (1 − damping)^iterations of it, and their pivots end the step that far apart
   * (joint-impulses.ts, groupImpulses). Rapier's joints close all of it. Before the step, each
   * link's error by the end of the step is solved as Havok's solver leaves it, from the bodies'
   * velocities (gravity's of the step added) and the error the link has now, and the link's
   * second anchor is moved by it, so that Rapier holds the pivots that far apart: a vanilla
   * chain's links hanging still keep about 7e-5 Havok units (0.005 game units) between their
   * pivots, more as it swings. A link past its maxErrorDistance is clipped instead
   * (#clipViolation). TODO(M13): inferred from Havok's documented solver; the chain is solved
   * on its own here, not with the other constraints of its island.
   */
  #dampChains(): void {
    const gravity = this.world.gravity;
    const done = new Set<PlacedJoint[]>();
    const awake = (body: RAPIER.RigidBody): boolean => body.isDynamic() && !body.isSleeping();
    for (const links of this.#chainLinks.values()) {
      if (done.has(links)) continue;
      done.add(links);
      const live: PlacedJoint[] = [];
      for (const link of links) {
        if (!this.#chainLinks.has(link) || !link.joint?.isValid()) continue;
        if (this.#clipped.has(link)) this.#damped.delete(link);
        else live.push(link);
      }
      if (!live.some(({ a, b }) => awake(a.body) || awake(b.body))) continue;
      // A body made a moment ago has no mass yet (Rapier computes it as it steps).
      if (
        live.some(({ a, b }) =>
          [a, b].some(({ body }) => body.isDynamic() && !(body.invMass() > 0)),
        )
      )
        continue;
      const index = new Map<number, number>();
      const bodies: ImpulseBody[] = [];
      const indexOf = ({ body, data }: PlacedBody): number => {
        const known = index.get(body.handle);
        if (known !== undefined) return known;
        const v = body.linvel();
        const w = body.angvel();
        if (body.isDynamic()) {
          const m = body.effectiveWorldInvInertia();
          const g = data.gravityFactor * this.#size;
          bodies.push({
            invMass: body.invMass(),
            invInertia: [m.m11, m.m12, m.m13, m.m22, m.m23, m.m33],
            linear: [v.x + gravity.x * g, v.y + gravity.y * g, v.z + gravity.z * g],
            angular: [w.x, w.y, w.z],
          });
        } else {
          bodies.push({
            invMass: 0,
            invInertia: [0, 0, 0, 0, 0, 0],
            linear: [v.x, v.y, v.z],
            angular: [w.x, w.y, w.z],
          });
        }
        index.set(body.handle, bodies.length - 1);
        return bodies.length - 1;
      };
      const world = (body: RAPIER.RigidBody, pivot: Vec3): RAPIER.Vector => {
        const t = body.translation();
        const p = rotateVector(body.rotation(), { x: pivot[0], y: pivot[1], z: pivot[2] });
        return { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z };
      };
      const fromCom = (body: RAPIER.RigidBody, point: RAPIER.Vector): Vec3 => {
        const c = body.worldCom();
        return [point.x - c.x, point.y - c.y, point.z - c.z];
      };
      const errors: Vec3[] = [];
      const joints: GroupJoint[] = [];
      const solved: PlacedJoint[] = [];
      for (const link of live) {
        const pivots = this.#linksClipped.get(link);
        const chain = link.constraint.chain;
        if (!pivots || !chain) continue;
        const pa = world(link.a.body, pivots.pivotA);
        const pb = world(link.b.body, pivots.pivotB);
        const error: Vec3 = [pb.x - pa.x, pb.y - pa.y, pb.z - pa.z];
        errors.push(error);
        solved.push(link);
        joints.push({
          a: indexOf(link.a),
          b: indexOf(link.b),
          ra: fromCom(link.a.body, pa),
          rb: fromCom(link.b.body, pb),
          error,
          tau: chain.tau,
          damping: chain.damping,
          softness: chain.constraintForceMixing,
          block: 0,
        });
      }
      const results = groupImpulses(bodies, joints, {
        step: this.#size,
        iterations: this.#stepSolver.iterations,
      });
      solved.forEach((link, i) => {
        const left = results[i]?.left.linear;
        const error = errors[i];
        const pivots = this.#linksClipped.get(link);
        const made = link.joint;
        if (!left || !error || !pivots || !made) return;
        // Where the step leaves the pivots: the error and what the iterations left of its speed.
        const next = openError(
          { linear: error, angular: [] },
          { linear: left, angular: [] },
          this.#size,
          pivots.most,
        ).linear;
        // B's anchor where Rapier holds it to A's pivot: its true pivot less that error.
        const q = link.b.body.rotation();
        const local = rotateVector(
          { x: -q.x, y: -q.y, z: -q.z, w: q.w },
          { x: next[0], y: next[1], z: next[2] },
        );
        const anchor = {
          x: pivots.pivotB[0] - local.x,
          y: pivots.pivotB[1] - local.y,
          z: pivots.pivotB[2] - local.z,
        };
        // Only a change is set (setting a joint wakes its bodies).
        const last = this.#damped.get(link);
        if (
          last?.joint !== made ||
          Math.hypot(last.anchor.x - anchor.x, last.anchor.y - anchor.y, last.anchor.z - anchor.z) >
            DAMP_CHANGE
        ) {
          made.setAnchor2(anchor);
          this.#damped.set(link, { joint: made, anchor });
        }
      });
    }
  }

  /**
   * Havok's maximum constraint violation (observed in the original: its world clips a
   * constraint's positional error to MAX_CONSTRAINT_VIOLATION): a joint whose two pivots lie
   * farther apart (a ragdoll pulled apart: a limb pushed out of a rock the rest lies in, a body
   * caught under an object) has its second pivot moved, for the step, to that distance from the
   * first along the way between them, so that it comes back by at most that much a step. Rapier
   * corrects all of the error at once: Lokir's corpse, half under a rock as Alduin's landing
   * woke it, was flung about for five minutes. The true pivot is set back once within.
   */
  #clipViolation(
    placed: PlacedJoint,
    made: RAPIER.ImpulseJoint,
    { a, b }: { readonly a: RAPIER.RigidBody; readonly b: RAPIER.RigidBody },
    pivotA: Vec3,
    pivotB: Vec3,
    most = MAX_CONSTRAINT_VIOLATION,
    /** What the pivots keep between them (a stiff spring's length); the error is past it. */
    rest = 0,
  ): void {
    if (a.isSleeping() && b.isSleeping()) return;
    const ta = a.translation();
    const tb = b.translation();
    const pa = rotateVector(a.rotation(), { x: pivotA[0], y: pivotA[1], z: pivotA[2] });
    const pb = rotateVector(b.rotation(), { x: pivotB[0], y: pivotB[1], z: pivotB[2] });
    const dx = tb.x + pb.x - (ta.x + pa.x);
    const dy = tb.y + pb.y - (ta.y + pa.y);
    const dz = tb.z + pb.z - (ta.z + pa.z);
    const gap = Math.hypot(dx, dy, dz);
    if (gap - rest > most) {
      // The second body's anchor where the first's pivot plus the clipped error lies.
      const k = (rest + most) / gap;
      const q = b.rotation();
      const local = rotateVector(
        { x: -q.x, y: -q.y, z: -q.z, w: q.w },
        {
          x: ta.x + pa.x + dx * k - tb.x,
          y: ta.y + pa.y + dy * k - tb.y,
          z: ta.z + pa.z + dz * k - tb.z,
        },
      );
      // Only a change is set (setting a joint wakes its bodies: one held stretched by what it
      // lies against would never sleep).
      const last = this.#clipped.get(placed);
      if (!last || Math.hypot(last.x - local.x, last.y - local.y, last.z - local.z) > CLIP_CHANGE) {
        made.setAnchor2(local);
        this.#clipped.set(placed, local);
      }
    } else if (this.#clipped.delete(placed)) {
      made.setAnchor2({ x: pivotB[0], y: pivotB[1], z: pivotB[2] });
    }
  }

  /**
   * Holds a ragdoll in the pose it has now, as one piece (`on`), or lets it move on its joints
   * again: the paralysed fall stiff. Each of its joints gets a fixed joint at the two bodies'
   * places as they are. Asking again for what it is does nothing.
   */
  stiffen(placed: PlacedCollision, on: boolean): void {
    const made = this.#stiff.get(placed);
    if (on === (made !== undefined)) return;
    if (made) {
      for (const joint of made) if (joint.isValid()) this.world.removeImpulseJoint(joint, true);
      this.#stiff.delete(placed);
      return;
    }
    const joints: RAPIER.ImpulseJoint[] = [];
    for (const { a, b } of placed.joints) {
      const ta = a.body.translation();
      const tb = b.body.translation();
      const qa = a.body.rotation();
      const qb = b.body.rotation();
      const inverse = { x: -qa.x, y: -qa.y, z: -qa.z, w: qa.w };
      const anchor = rotateVector(inverse, { x: tb.x - ta.x, y: tb.y - ta.y, z: tb.z - ta.z });
      // The second body's turn in the first's frame (its anchor at its own origin, unturned).
      const frame = {
        w: inverse.w * qb.w - inverse.x * qb.x - inverse.y * qb.y - inverse.z * qb.z,
        x: inverse.w * qb.x + inverse.x * qb.w + inverse.y * qb.z - inverse.z * qb.y,
        y: inverse.w * qb.y - inverse.x * qb.z + inverse.y * qb.w + inverse.z * qb.x,
        z: inverse.w * qb.z + inverse.x * qb.y - inverse.y * qb.x + inverse.z * qb.w,
      };
      joints.push(
        this.world.createImpulseJoint(
          RAPIER.JointData.fixed(anchor, frame, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }),
          a.body,
          b.body,
          true,
        ),
      );
    }
    this.#stiff.set(placed, joints);
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
   * perpendicular); the pulled body slides along the axis between the limits, is held across it,
   * and turns about it as the hitch does (held, or springing back to it: `turnSpring`); its
   * other two turns are free (src/ai/cart-tether.ts). It has no shape.
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
    // Along the slide (x) it slides between the limits, across it it is held; its turn about
    // the slide springs back to how the frames meet (turnSpring; without one it is held), the
    // other two turns are free. The engine's prismatic joint holds all three: see
    // src/ai/cart-tether.ts for why the cart's pitch and roll are left to its wheels here.
    const locked =
      RAPIER.JointAxesMask.LinY |
      RAPIER.JointAxesMask.LinZ |
      (joint.turnSpring ? 0 : RAPIER.JointAxesMask.AngX);
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
    // The turn about the slide springs back (accelerations: stiffness in 1/s², damping in 1/s).
    const spring = joint.turnSpring;
    if (spring) {
      raw.rawSet.jointConfigureMotorPosition(
        raw.handle,
        RAPIER.JointAxis.AngX,
        0,
        spring.stiffness,
        spring.damping,
      );
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
      place(to: Mat4): void {
        const pose = rigidPart(to);
        const at = {
          x: toHavok(pose[12] ?? 0),
          y: toHavok(pose[13] ?? 0),
          z: toHavok(pose[14] ?? 0),
        };
        const turn = matrixQuaternion(pose);
        body.setTranslation(at, true);
        body.setRotation(turn, true);
        body.setNextKinematicTranslation(at);
        body.setNextKinematicRotation(turn);
      },
      remove(): void {
        if (made.isValid()) world.removeImpulseJoint(made, true);
        if (body.isValid()) world.removeRigidBody(body);
      },
    };
  }

  /**
   * Gives a simulated body of a placement other physical properties (a tethered cart's:
   * src/ai/cart-tether.ts): its mass (the inertia scaled with it), its shapes' friction, its
   * damping, how much gravity pulls it and whether it is swept (continuous collision).
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
      readonly swept?: boolean;
    },
  ): void {
    const { body, data } = target;
    if (tuning.swept !== undefined) body.enableCcd(tuning.swept);
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
        if (ignored) this.#ignoredPairs.add(first.handle, second.handle);
        else this.#ignoredPairs.delete(first.handle, second.handle);
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
   * Powers a ragdoll (the behavior graph's hkbPoweredRagdollControlsModifier: Havok's powered
   * ragdoll controller): each of its ragdoll and limited hinge joints whose second body has a
   * pose in `poses` (its pose in the model, game units, under the placement `world`, as
   * moveBody takes it) gets a motor pulling that body's turn relative to the first toward the
   * two poses' (constraint-solver.ts, JointMotor), with the graph's control data; `only`: just
   * the joints whose second body is one of these. The others, and all of them without `motor`
   * (or with no force), go limp again (their friction holds them). Powered bodies are kept
   * awake: the pose they are pulled toward moves.
   */
  power(
    placed: PlacedCollision,
    poses: ReadonlyMap<PlacedBody, Mat4>,
    world: Mat4,
    motor: Omit<JointMotor, 'target'> | undefined,
    only?: ReadonlySet<PlacedBody>,
  ): void {
    const turns = new Map<PlacedBody, Quaternion>();
    const turnOf = (body: PlacedBody): Quaternion | undefined => {
      let turn = turns.get(body);
      const pose = poses.get(body);
      if (!turn && pose) {
        const m = new Float32Array(16);
        multiplyInto(rigidPart(world), rigidPart(pose), m);
        turn = matrixQuaternion(m);
        turns.set(body, turn);
      }
      return turn;
    };
    let powered = false;
    for (const joint of placed.joints) {
      const solver = this.#solverJoints.get(joint);
      if (!solver) continue;
      const on = motor !== undefined && motor.maxForce > 0 && (!only || only.has(joint.b));
      const a = on ? turnOf(joint.a) : undefined;
      const b = a && turnOf(joint.b);
      if (!motor || !a || !b) {
        solver.motor = undefined;
        continue;
      }
      // qA⁻¹ qB: the second body's turn relative to the first's.
      const target = relativeTurn(a, b);
      solver.motor = { ...motor, target };
      powered = true;
    }
    if (!powered) return;
    for (const { body } of placed.bodies) {
      if (body.isDynamic() && body.isSleeping()) body.wakeUp();
    }
  }

  /**
   * A placement leaves the simulation or comes back (its reference disabled or enabled by a
   * script): its bodies and colliders stay, switched off, so it returns where it was. Coming
   * back, its simulated bodies are only moved out of what they overlap there for
   * DEPENETRATE_SECONDS, as placed ones are (Havok recovers penetrations slowly): MQ101's dead
   * horse, enabled with the dragon's attack against the second cart's back in Helgen's square,
   * was thrown at 14,000 units a second.
   */
  setEnabled(placed: PlacedCollision, enabled: boolean): void {
    if (!enabled) this.#gone.add(placed.owner.reference);
    for (const { body, data } of placed.bodies) {
      // Only one that comes back (asked again while enabled, it moves on as it was).
      if (enabled && !body.isEnabled() && data.motion === 'dynamic' && !data.phantom)
        this.#depenetrating.set(body.handle, this.#time + DEPENETRATE_SECONDS);
      body.setEnabled(enabled);
    }
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
   * Makes a placement's simulated bodies fixed: nothing moves them (a static's, as it is
   * placed: observed in the original). SetMotionType can make them move again.
   */
  fix(placed: PlacedCollision): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.#held.delete(body.handle);
      body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    }
    this.#syncJoints(placed.bodies.map(({ body }) => body));
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
   * dismemberment.ts). A body placed a moment ago is launched, no longer settling: its warm
   * start took the speed every step (DEPENETRATE_SECONDS), so a cut head hung at the neck for
   * half a second and then dropped straight down, never flung (off the block, past the basket).
   */
  setVelocity(placed: PlacedCollision, linear: Vec3, angular: Vec3): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.release(body);
      this.#depenetrating.delete(body.handle);
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

  /**
   * A push on a placement's moving bodies: along `direction` (made unit) by `magnitude` (Havok
   * units); with `share` (ApplyHavokImpulse, observed in the original), each body takes
   * `direction` as given × `magnitude` × share(its layer), game units made Havok's.
   */
  impulse(
    placed: PlacedCollision,
    direction: Vec3,
    magnitude: number,
    share?: (layer: number) => number,
  ): void {
    const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      this.release(body);
      const layer = body.numColliders() > 0 ? this.layerOf(body.collider(0)) : data.layer;
      const k = share ? (magnitude * share(layer)) / HAVOK_SCALE : magnitude / length;
      body.applyImpulse({ x: direction[0] * k, y: direction[1] * k, z: direction[2] * k }, true);
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

  /** A body's mass (Havok kg; 1 where Rapier has none yet). */
  #massOf(body: RAPIER.RigidBody): number {
    const mass = body.mass();
    return mass > 0 ? mass : 1;
  }

  /** Whether a body can be pushed: simulated, or held until something moves it. */
  #pushable(body: RAPIER.RigidBody | null): body is RAPIER.RigidBody {
    return body !== null && body.isValid() && (body.isDynamic() || this.#held.has(body.handle));
  }

  /**
   * A hit pushes the body of the collider it met (src/gameplay/impulses.ts: a projectile's
   * impact, a weapon's blow) at `point` (game units) along `direction`, by `impulse` for its
   * layer and mass (Havok units, kg·m/s); a held body moves from now on. Fixed and keyframed
   * bodies (a living actor's, an animated object's) are not moved. Returns whether it pushed.
   */
  /**
   * The pose (game units) of the moving body a collider belongs to (a dynamic or keyframed
   * one); undefined for the fixed world, or once the body is gone.
   */
  movingPose(
    collider: RAPIER.Collider,
  ): { position: Vec3; rotation: [number, number, number, number] } | undefined {
    if (!collider.isValid()) return undefined;
    const body = collider.parent();
    if (!body?.isValid() || body.isFixed()) return undefined;
    const t = body.translation();
    const r = body.rotation();
    return {
      position: [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE],
      rotation: [r.x, r.y, r.z, r.w],
    };
  }

  knock(
    collider: RAPIER.Collider,
    point: Vec3,
    direction: Vec3,
    impulse: (layer: number, mass: number) => number,
  ): boolean {
    const body = collider.parent();
    if (!this.#pushable(body) || this.#passing.has(collider.handle)) return false;
    const magnitude = impulse(this.layerOf(collider), this.#massOf(body));
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(magnitude > 0) || length < 1e-6) return false;
    this.release(body);
    const k = magnitude / length;
    body.applyImpulseAtPoint(
      { x: direction[0] * k, y: direction[1] * k, z: direction[2] * k },
      { x: toHavok(point[0]), y: toHavok(point[1]), z: toHavok(point[2]) },
      true,
    );
    return true;
  }

  /**
   * A cone's push (Unrelenting Force: src/gameplay/impulses.ts conePush) on every moving body
   * within `range` of `apex` and `spread` degrees of `direction` that the apex sees (the first
   * surface a ray on `layer` meets on the way is its own): each along the way from the apex by
   * `push` for its layer, mass and distance (game units, made Havok's here), with a random spin
   * of up to its angular impulse. Bodies of the actor `ignore` (the caster) are passed over.
   * Returns the bodies pushed.
   */
  pushCone(
    apex: Vec3,
    direction: Vec3,
    range: number,
    spread: number,
    layer: number,
    push: (layer: number, mass: number, distance: number) => BodyPush,
    ignore?: number,
    /** The bodies this wave pushed already, and takes those it pushes: each goes once. */
    pushedBefore?: Set<number>,
  ): number {
    const d = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(range > 0) || d < 1e-6) return 0;
    const unit: Vec3 = [direction[0] / d, direction[1] / d, direction[2] / d];
    const cosSpread = Math.cos((Math.max(0, spread) * Math.PI) / 180);
    const bodies = new Map<number, { body: RAPIER.RigidBody; collider: RAPIER.Collider }>();
    this.world.intersectionsWithShape(
      { x: toHavok(apex[0]), y: toHavok(apex[1]), z: toHavok(apex[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Ball(toHavok(range)),
      (other) => {
        if (!other.isEnabled() || !this.matrix.collides(this.layerOf(other), layer)) return true;
        const owner = this.ownerOf(other);
        if (owner?.kind === 'actor' && owner.reference === ignore) return true;
        const body = other.parent();
        if (!this.#pushable(body) || bodies.has(body.handle)) return true;
        if (pushedBefore?.has(body.handle)) return true;
        bodies.set(body.handle, { body, collider: other });
        return true;
      },
      // Fixed bodies are never pushed: left out before Rapier tests the ball against their
      // shapes (the town's meshes and land round a dragon's breath, every frame of its wave).
      RAPIER.QueryFilterFlags.EXCLUDE_FIXED,
    );
    let pushed = 0;
    for (const { body, collider } of bodies.values()) {
      const t = body.translation();
      const way: Vec3 = [
        t.x * HAVOK_SCALE - apex[0],
        t.y * HAVOK_SCALE - apex[1],
        t.z * HAVOK_SCALE - apex[2],
      ];
      const distance = Math.hypot(...way);
      if (distance > range) continue;
      const toward: Vec3 =
        distance > 1e-6 ? [way[0] / distance, way[1] / distance, way[2] / distance] : unit;
      if (
        distance > 1e-6 &&
        toward[0] * unit[0] + toward[1] * unit[1] + toward[2] * unit[2] < cosSpread
      )
        continue;
      // Seen from the apex: nothing but its own system (or the caster) first on the way.
      if (distance > 1e-6) {
        const first = this.raycast(apex, way, distance, layer, undefined, ignore);
        if (first && first.collider.parent()?.handle !== body.handle) {
          const system = this.#systems.get(collider.handle);
          if (system === undefined || this.#systems.get(first.collider.handle) !== system) continue;
        }
      }
      const { linear, upBias, angular } = push(
        this.layerOf(collider),
        this.#massOf(body),
        distance,
      );
      if (!(linear > 0) && !(angular > 0)) continue;
      pushedBefore?.add(body.handle);
      this.release(body);
      const scale = linear / HAVOK_SCALE;
      body.applyImpulse(
        { x: toward[0] * scale, y: toward[1] * scale, z: (toward[2] + upBias) * scale },
        true,
      );
      const spin = (): number => (Math.random() * 2 - 1) * (angular / HAVOK_SCALE);
      body.applyTorqueImpulse({ x: spin(), y: spin(), z: spin() }, true);
      pushed++;
    }
    return pushed;
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
   * masses the next step computes), so a ragdoll flies off as one; `factor`: a share of it per
   * body (a death's push by biped part).
   */
  kick(
    placed: PlacedCollision,
    direction: Vec3,
    speed: number,
    factor?: (body: CollisionBody) => number,
  ): void {
    const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      const scale = (speed * (factor ? factor(data) : 1)) / length;
      if (scale === 0) continue;
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
   * Moves a placement's simulated bodies to another layer (a death: the ragdoll's bodies go to
   * L_DEADBIP, which corpses lie on: they meet clutter, weapons, projectiles and one another,
   * and no character controller). Phantoms keep theirs.
   */
  setLayer(placed: PlacedCollision, layer: number): void {
    for (const { body, data } of placed.bodies) {
      if (!dynamicBody(data)) continue;
      for (let i = 0; i < body.numColliders(); i++) this.#setLayer(body.collider(i), layer);
    }
    this.#changed = true;
  }

  /**
   * Places a placement's bodies at once at poses of their own (`modelPose`: a body's pose in the
   * model, game units, rotation and translation; undefined: it stays) under the placement
   * `world`: a placed ragdoll pose's bodies where its nodes are. Simulated bodies keep still.
   */
  poseBodies(
    placed: PlacedCollision,
    world: Mat4,
    modelPose: (body: PlacedBody) => Mat4 | undefined,
  ): void {
    const pose = new Float32Array(16);
    for (const entry of placed.bodies) {
      const model = modelPose(entry);
      if (!model) continue;
      const local = rigidPart(model);
      local[12] = (local[12] ?? 0) * placed.scale;
      local[13] = (local[13] ?? 0) * placed.scale;
      local[14] = (local[14] ?? 0) * placed.scale;
      multiplyInto(rigidPart(world), local, pose);
      const body = entry.body;
      body.setTranslation(
        { x: toHavok(pose[12] ?? 0), y: toHavok(pose[13] ?? 0), z: toHavok(pose[14] ?? 0) },
        false,
      );
      body.setRotation(matrixQuaternion(pose), false);
    }
    this.#changed = true;
  }

  /**
   * A placement's bodies find their contacts with fixed bodies while they are keyframed too (an
   * actor's ragdoll following its death animation: its graph waits for a body to touch the
   * ground, BSRagdollContactListenerModifier; Havok reports such contacts, Rapier computes none
   * between kinematic and fixed bodies unless asked).
   */
  findFixedContacts(placed: PlacedCollision): void {
    const types = RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED;
    for (const { body, data } of placed.bodies) {
      if (data.phantom) continue;
      for (let i = 0; i < body.numColliders(); i++) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- a mask of its flags
        body.collider(i).setActiveCollisionTypes(types);
      }
    }
  }

  /**
   * Takes a simulated body out of collision with anything, or puts it back (its joints hold
   * on): a ragdoll's limb that went through the ground passes back through it
   * (src/physics/ragdoll-penetration.ts).
   */
  setPassThrough(placed: PlacedBody, through: boolean): void {
    const body = placed.body;
    for (let i = 0; i < body.numColliders(); i++) {
      const handle = body.collider(i).handle;
      if (through) this.#passing.add(handle);
      else this.#passing.delete(handle);
    }
  }

  /** Whether a body passes through everything (setPassThrough). */
  passesThrough(placed: PlacedBody): boolean {
    const body = placed.body;
    return body.numColliders() > 0 && this.#passing.has(body.collider(0).handle);
  }

  /**
   * An impulse (Havok units, kg·m/s) on one body at a point (game units): it turns as well as
   * moves.
   */
  pointImpulse(placed: PlacedBody, impulse: Vec3, point: Vec3): void {
    const body = placed.body;
    if (!body.isValid() || !body.isDynamic()) return;
    body.applyImpulseAtPoint(
      { x: impulse[0], y: impulse[1], z: impulse[2] },
      { x: toHavok(point[0]), y: toHavok(point[1]), z: toHavok(point[2]) },
      true,
    );
  }

  /**
   * The trigger volumes (colliders on layers flagged "trigger volume") a collider overlaps now
   * whose layers collide with its own: their owners' references (a trap's trigger, a quest's
   * activator box). The layer matrix decides who is in what: L_PROJECTILEZONE takes in no
   * controller, L_DEADACTORZONE only the dead.
   */
  triggersOverlapping(collider: RAPIER.Collider): Set<number> {
    return this.#triggersIn(
      collider.translation(),
      collider.rotation(),
      queryShape(collider.shape),
      collider,
      this.layerOf(collider),
    );
  }

  /**
   * The trigger volumes a ball overlaps (`center` and `radius` in game units): those an actor
   * without a controller reaches (a flier in the air: MQ101SetStage99 across Alduin's way). With
   * a `layer`: only those whose layer collides with it.
   */
  triggersNear(center: Vec3, radius: number, layer?: number): Set<number> {
    return this.#triggersIn(
      { x: toHavok(center[0]), y: toHavok(center[1]), z: toHavok(center[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Ball(toHavok(radius)),
      undefined,
      layer,
    );
  }

  /**
   * The trigger volumes a way passes through (game units) whose layers collide with `layer`
   * (a projectile's in flight): their owners' references.
   */
  triggersAlong(from: Vec3, to: Vec3, layer: number): Set<number> {
    const found = new Set<number>();
    const way = [to[0] - from[0], to[1] - from[1], to[2] - from[2]] as const;
    const length = Math.hypot(way[0], way[1], way[2]);
    if (length === 0) return found;
    this.world.intersectionsWithRay(
      new RAPIER.Ray(
        { x: toHavok(from[0]), y: toHavok(from[1]), z: toHavok(from[2]) },
        { x: way[0] / length, y: way[1] / length, z: way[2] / length },
      ),
      toHavok(length),
      true,
      (hit) => {
        const reference = this.ownerOf(hit.collider)?.reference;
        if (hit.collider.isEnabled() && reference) found.add(reference);
        return true;
      },
      undefined,
      QueryGroups.triggers,
      undefined,
      undefined,
      (other) => this.#isTriggerVolume(other) && this.matrix.collides(this.layerOf(other), layer),
    );
    return found;
  }

  /**
   * The trigger volumes a cone projectile's wave is in (game units): the sector from `apex` out to
   * `front` along `direction`, `spread` degrees either side of it, whose layers collide with
   * `layer` (L_CONEPROJECTILE: Unrelenting Force, Fire Breath). A volume off the wave's middle
   * line that its spread reaches is in it as much as one on the line. The sector is a convex hull
   * inscribed in it (three rings of 12 points out at the front, the apex and the front's middle);
   * a spread past 90° (none in the data: 89° at most) is taken as 90°. TODO(M13): the shape the
   * original's wave tests the volumes with is inferred (the sector its actors are met in:
   * projectile-flight.ts inCone).
   */
  triggersInCone(
    apex: Vec3,
    direction: Vec3,
    front: number,
    spread: number,
    layer: number,
  ): Set<number> {
    const d = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(front > 0) || d < 1e-6) return new Set();
    const u: Vec3 = [direction[0] / d, direction[1] / d, direction[2] / d];
    const middle: Vec3 = [apex[0] + u[0] * front, apex[1] + u[1] * front, apex[2] + u[2] * front];
    const found = this.triggersAlong(apex, middle, layer);
    const half = (Math.min(90, Math.max(0, spread)) * Math.PI) / 180;
    if (half < 1e-4) return found;
    // Two axes across the direction.
    const side: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cross: Vec3 = [
      u[1] * side[2] - u[2] * side[1],
      u[2] * side[0] - u[0] * side[2],
      u[0] * side[1] - u[1] * side[0],
    ];
    const cl = Math.hypot(cross[0], cross[1], cross[2]);
    const a: Vec3 = [cross[0] / cl, cross[1] / cl, cross[2] / cl];
    const b: Vec3 = [
      u[1] * a[2] - u[2] * a[1],
      u[2] * a[0] - u[0] * a[2],
      u[0] * a[1] - u[1] * a[0],
    ];
    const r = toHavok(front);
    const points: number[] = [0, 0, 0, u[0] * r, u[1] * r, u[2] * r];
    const RINGS = 3;
    const AROUND = 12;
    for (let ring = 1; ring <= RINGS; ring++) {
      const polar = (half * ring) / RINGS;
      const along = Math.cos(polar) * r;
      const across = Math.sin(polar) * r;
      for (let k = 0; k < AROUND; k++) {
        const turn = (2 * Math.PI * k) / AROUND;
        const c = Math.cos(turn) * across;
        const s = Math.sin(turn) * across;
        points.push(
          u[0] * along + a[0] * c + b[0] * s,
          u[1] * along + a[1] * c + b[1] * s,
          u[2] * along + a[2] * c + b[2] * s,
        );
      }
    }
    const sector = new RAPIER.ConvexPolyhedron(Float32Array.from(points), null);
    for (const trigger of this.#triggersIn(
      { x: toHavok(apex[0]), y: toHavok(apex[1]), z: toHavok(apex[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      sector,
      undefined,
      layer,
    ))
      found.add(trigger);
    return found;
  }

  /**
   * The placed objects whose collision a ball overlaps (`center`, `radius` in game units) on
   * bodies that collide with `layer` (a cone's: L_CONEPROJECTILE): each reference once, with
   * the point of its body nearest `toward` (game units; inside the body: that point itself). A
   * body as wide as a mountain path (a trigger's volume) is reached where it begins, not only
   * where its middle lies.
   */
  objectsNear(center: Vec3, radius: number, layer: number, toward: Vec3): Map<number, Vec3> {
    const found = new Map<number, { point: Vec3; distance: number }>();
    const to = { x: toHavok(toward[0]), y: toHavok(toward[1]), z: toHavok(toward[2]) };
    // A placed object's body that collides with the layer: asked before Rapier tests the ball
    // against the shape (the land's and the actors' are never wanted, and the ball reaches as
    // far as a dragon's breath).
    const wanted = (other: RAPIER.Collider): boolean => {
      if (!other.isEnabled() || !this.matrix.collides(this.layerOf(other), layer)) return false;
      const owner = this.ownerOf(other);
      return owner?.kind === 'object' && owner.reference !== 0;
    };
    this.world.intersectionsWithShape(
      { x: toHavok(center[0]), y: toHavok(center[1]), z: toHavok(center[2]) },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Ball(toHavok(radius)),
      (other) => {
        const owner = this.ownerOf(other);
        if (!owner || !wanted(other)) return true;
        const t = other.projectPoint(to, true)?.point ?? other.translation();
        const point: Vec3 = [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE];
        const distance = Math.hypot(
          point[0] - toward[0],
          point[1] - toward[1],
          point[2] - toward[2],
        );
        const known = found.get(owner.reference);
        if (!known || distance < known.distance) found.set(owner.reference, { point, distance });
        return true;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      wanted,
    );
    return new Map([...found].map(([reference, { point }]) => [reference, point]));
  }

  /**
   * The traps an actor's collider touches: bodies on L_TRAP and L_CLOUDTRAP (the layers the
   * engine's trap listener takes as traps, observed in the original) within `margin` game units of it, by
   * their owners' references, with where it touches (the contact point on the trap, as a Havok
   * contact point event tells it) and how the trap's body moves.
   */
  trapsTouching(collider: RAPIER.Collider, margin: number): Map<number, TrapTouch> {
    const found = new Map<number, TrapTouch>();
    const shape = queryShape(collider.shape);
    const reach =
      shape instanceof RAPIER.Capsule
        ? new RAPIER.Capsule(shape.halfHeight, shape.radius + toHavok(margin))
        : shape instanceof RAPIER.Ball
          ? new RAPIER.Ball(shape.radius + toHavok(margin))
          : shape;
    const at = collider.translation();
    this.world.intersectionsWithShape(
      at,
      collider.rotation(),
      reach,
      (other) => {
        if (!other.isEnabled()) return true;
        const reference = this.ownerOf(other)?.reference;
        if (reference === undefined || reference === 0 || found.has(reference)) return true;
        const body = other.parent();
        const velocity = body?.linvel() ?? { x: 0, y: 0, z: 0 };
        // Where it touches: the contact's point on the trap (the actor's centre when none).
        const contact = other.contactShape(reach, at, collider.rotation(), 0);
        const point = contact?.point1 ?? at;
        found.set(reference, {
          position: [point.x * HAVOK_SCALE, point.y * HAVOK_SCALE, point.z * HAVOK_SCALE],
          velocity: [velocity.x * HAVOK_SCALE, velocity.y * HAVOK_SCALE, velocity.z * HAVOK_SCALE],
          motionType:
            !body || body.isFixed()
              ? MotionType.fixed
              : body.isDynamic()
                ? MotionType.dynamic
                : MotionType.keyframed,
          material: this.materialOf(other),
        });
        return true;
      },
      undefined,
      QueryGroups.traps,
      collider,
      undefined,
      this.#isTrap,
    );
    return found;
  }

  /**
   * Query filters by layer alone (the layers are ours: no call into Rapier): given as a query's
   * predicate, the colliders of other layers are passed over before their shapes are tested
   * (each actor's capsule against the landscape's and the buildings' meshes, every frame, was
   * most of the cost of the trigger and trap queries). The query's groups (QueryGroups) pass
   * most of those over before Rapier calls back; these still answer for colliders made without
   * a layer.
   */
  readonly #isTrap = (other: RAPIER.Collider): boolean => {
    const layer = this.layerOf(other);
    return layer === Layer.trap || layer === Layer.cloudTrap;
  };

  readonly #isTriggerVolume = (other: RAPIER.Collider): boolean =>
    (this.matrix.flags(this.layerOf(other)) & LayerFlag.triggerVolume) !== 0;

  /**
   * The trigger volumes the moving objects are in (a bucket kicked onto a pressure plate, a
   * corpse's ragdoll, a dropped weapon): for each simulated body awake now, by its reference,
   * the triggers its colliders overlap whose layer collides with its own (the layer matrix:
   * L_TRIGGER meets clutter, weapons, projectiles, dead bodies, ...). Sleeping bodies are not
   * looked at (they stay where they were). The player's character is not among them.
   *
   * Nor are bodies settling after their cell placed them (the warm start): the game's placed
   * clutter lies inactive until something disturbs it (an object left floating in the editor
   * floats until touched), and its trigger volumes (hkpTriggerVolume) hear of a body only from
   * the contacts the simulation of an active one makes, so what a cell places inside a trigger
   * does not enter it as the cell loads (Whiterun's clutter told
   * CWDisableHoldPositionMarkerTrigger, whose script takes what enters for an actor). Disturbed
   * later, it enters as it moves. A trap's body on L_TRAP moves by its animation (keyframed), and
   * is looked at as it moves too: a swinging blade passes through the volumes it meets.
   */
  movingInTriggers(): Map<number, Set<number>> {
    const found = new Map<number, Set<number>>();
    const look = (collider: RAPIER.Collider): void => {
      const owner = this.ownerOf(collider);
      if (!collider.isEnabled() || owner === undefined || owner.reference === 0) return;
      const layer = this.layerOf(collider);
      let inside = found.get(owner.reference);
      if (!inside) {
        inside = new Set();
        found.set(owner.reference, inside);
      }
      for (const trigger of this.#triggersIn(
        collider.translation(),
        collider.rotation(),
        queryShape(collider.shape),
        collider,
        layer,
      )) {
        if (trigger !== owner.reference) inside.add(trigger);
      }
    };
    this.world.forEachActiveRigidBody((body) => {
      if (!body.isDynamic() || this.#settling.has(body.handle)) return;
      for (let i = 0; i < body.numColliders(); i++) look(body.collider(i));
    });
    for (const collider of this.#trapColliders.values()) {
      const body = collider.parent();
      if (body?.isKinematic() !== true) continue;
      const t = body.translation();
      const r = body.rotation();
      const pose = [t.x, t.y, t.z, r.x, r.y, r.z, r.w];
      const before = this.#trapPoses.get(body.handle);
      this.#trapPoses.set(body.handle, pose);
      if (before && pose.some((value, index) => value !== before[index])) look(collider);
    }
    return found;
  }

  /**
   * The references whose collision went or was disabled since last asked: what was in a trigger
   * volume and is gone has left it (nothing moves to tell so), as has what was in one that is gone.
   */
  takeGone(): ReadonlySet<number> {
    const gone = this.#gone;
    this.#gone = new Set();
    return gone;
  }

  #triggersIn(
    translation: RAPIER.Vector,
    rotation: RAPIER.Rotation,
    shape: RAPIER.Shape,
    exclude?: RAPIER.Collider,
    layer?: number,
  ): Set<number> {
    const found = new Set<number>();
    this.world.intersectionsWithShape(
      translation,
      rotation,
      shape,
      (other) => {
        if (!other.isEnabled()) return true;
        // With a layer: only triggers whose own layer collides with it (the layer matrix).
        if (layer !== undefined && !this.matrix.collides(this.layerOf(other), layer)) return true;
        const reference = this.ownerOf(other)?.reference;
        if (reference !== undefined && reference !== 0) found.add(reference);
        return true;
      },
      undefined,
      QueryGroups.triggers,
      exclude,
      undefined,
      this.#isTriggerVolume,
    );
    return found;
  }

  /**
   * A held body moves from now on (settled, touched, taken hold of), and so do the other held
   * bodies of its system (a ragdoll, a hinged object: one of its bodies let go alone hung,
   * simulated, on its still-held neighbours' joints and shook there for good); others are left.
   */
  release(body: RAPIER.RigidBody): void {
    if (!this.#held.delete(body.handle)) return;
    const released = [body];
    const system = body.numColliders() > 0 ? this.#systems.get(body.collider(0).handle) : undefined;
    if (system !== undefined) {
      for (const handle of [...this.#held]) {
        const other = this.world.getRigidBody(handle) as RAPIER.RigidBody | null;
        if (!other || other.numColliders() === 0) continue;
        if (this.#systems.get(other.collider(0).handle) !== system) continue;
        this.#held.delete(handle);
        released.push(other);
      }
    }
    for (const each of released) each.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.#syncJoints(released);
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
                  this.#ignoredPairs.add(handle, other);
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
      // Moved after the step: queries see it back in its place after the next one.
      this.#changed = true;
    }
  }

  /** Clamps the moving bodies' speeds to their top speeds (#limits). */
  #limitVelocities(): void {
    const gravity = this.world.gravity;
    const g = Math.hypot(gravity.x, gravity.y, gravity.z);
    const iterations = this.#stepSolver.iterations;
    for (const [handle, limit] of this.#limits) {
      const body = limit.body;
      if (!body.isValid()) {
        this.#limits.delete(handle);
        continue;
      }
      if (!body.isDynamic() || body.isSleeping()) continue;
      const v = body.linvel();
      const w = body.angvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const turn = Math.hypot(w.x, w.y, w.z);
      // Havok's solver slows slow bodies down (its solver deactivation).
      const slow = slowBodyFactor(limit.solverDeactivation, g, speed, turn, iterations);
      const linear = Math.min(slow, speed > limit.linear ? limit.linear / speed : 1);
      const angular = Math.min(slow, turn > limit.angular ? limit.angular / turn : 1);
      if (linear < 1) body.setLinvel({ x: v.x * linear, y: v.y * linear, z: v.z * linear }, false);
      if (angular < 1) {
        body.setAngvel({ x: w.x * angular, y: w.y * angular, z: w.z * angular }, false);
      }
    }
  }

  /**
   * Rapier's own sleeping held to Havok's rule (#deactivate). Rapier puts a body, with all it
   * touches, to sleep once it has moved slower than 0.1 units a second (and turned slower than
   * about 0.1 radians a second) for half a second, and stops it dead: a box sliding or turning
   * slowly came to a halt in mid-slide. #deactivate starts Rapier's timer over for every body
   * not yet inactive long enough, so Rapier rarely gets there; when it does (a body woken
   * between checks), a body Rapier put to sleep in the step that has not stayed near its
   * deactivation reference for DEACTIVATION_SECONDS is woken with the speed it had before the
   * step, and so is what it touches that Rapier put to sleep with it (Havok's island stays
   * active as a whole). What Rapier puts to sleep by the rule stays asleep, settling or not (a
   * settling body #deactivate leaves alone). TODO(M13): inferred, as the rule itself; a body
   * woken so has not moved in that step.
   */
  #holdAwake(): void {
    let slept: Map<number, RAPIER.RigidBody> | undefined;
    for (const handle of this.#velocities.keys()) {
      const body = this.world.getRigidBody(handle) as RAPIER.RigidBody | null;
      if (!body?.isSleeping() || !body.isDynamic() || !body.isEnabled()) continue;
      (slept ??= new Map()).set(handle, body);
    }
    if (!slept) return;
    const elapsed = this.#sinceDeactivation + this.#size;
    const waking: RAPIER.RigidBody[] = [];
    for (const body of slept.values()) {
      const reference = this.#still.get(body.handle);
      const resting =
        reference !== undefined &&
        !movedFrom(reference, body) &&
        reference.seconds + elapsed >= DEACTIVATION_SECONDS;
      if (!resting) waking.push(body);
    }
    for (const body of waking) slept.delete(body.handle);
    // What a woken body touches or is joined to, and what touches that, wakes with it.
    for (let i = 0; i < waking.length && slept.size > 0; i++) {
      const body = waking[i];
      if (!body) continue;
      const system = this.#systemOf(body);
      const touching = touchingBodies(this.world, body);
      for (const [handle, other] of slept) {
        if (!touching.has(handle) && (system === undefined || this.#systemOf(other) !== system)) {
          continue;
        }
        slept.delete(handle);
        waking.push(other);
      }
    }
    // Asleep by the rule: woken, it is inactive only after DEACTIVATION_SECONDS again (as
    // #deactivate leaves what it puts to sleep).
    for (const handle of slept.keys()) this.#still.delete(handle);
    for (const body of waking) {
      body.wakeUp();
      const v = this.#velocities.get(body.handle);
      const w = this.#spins.get(body.handle);
      if (v) body.setLinvel(v, false);
      if (w) body.setAngvel(w, false);
    }
  }

  /** The system (an object's bodies, a ragdoll) a body belongs to, if any. */
  #systemOf(body: RAPIER.RigidBody): number | undefined {
    return body.numColliders() > 0 ? this.#systems.get(body.collider(0).handle) : undefined;
  }

  /**
   * Havok's deactivation (DEACTIVATION_DISTANCE: the distance observed in the original, the rest
   * inferred from Havok's documented behaviour): a body is inactive while it stays within
   * DEACTIVATION_DISTANCE (and DEACTIVATION_TURN) of where it was when it last moved, however
   * it shakes there, and a system of bodies (a ragdoll, a hinged object) that has been inactive
   * for DEACTIVATION_SECONDS as a whole goes to sleep, until something wakes it. Rapier sends
   * bodies to sleep by their speed alone: a ragdoll whose limbs tremble on a slope or against
   * a rock (stacked joints and contacts never quite at rest) never slept, and a body moving
   * slowly slept while still moving (#holdAwake keeps it awake).
   */
  #deactivate(): void {
    this.#sinceDeactivation += this.#size;
    if (this.#sinceDeactivation < DEACTIVATION_CHECK) return;
    const elapsed = this.#sinceDeactivation;
    this.#sinceDeactivation = 0;
    const still = this.#still;
    const seen = new Set<number>();
    // Per system (its colliders' system; a lone body is its own): awake bodies and whether all
    // of them have stayed still long enough.
    const systems = new Map<string, RestingGroup>();
    this.forEachAwake((body) => {
      const handle = body.handle;
      seen.add(handle);
      let entry = still.get(handle);
      if (!entry || movedFrom(entry, body)) {
        const t = body.translation();
        entry = { x: t.x, y: t.y, z: t.z, rotation: body.rotation(), seconds: 0 };
        still.set(handle, entry);
      } else {
        entry.seconds += elapsed;
      }
      // Not inactive long enough: Rapier's own sleep timer starts over (it sleeps a body after
      // half a second, these checks come every quarter), so Rapier does not stop it (#holdAwake).
      if (entry.seconds < DEACTIVATION_SECONDS) body.wakeUp();
      const collider = body.numColliders() > 0 ? body.collider(0) : undefined;
      const system = collider ? this.#systems.get(collider.handle) : undefined;
      const key = system === undefined ? 'b' + String(handle) : 's' + String(system);
      let group = systems.get(key);
      if (!group) {
        group = { bodies: [], resting: true };
        systems.set(key, group);
      }
      group.bodies.push(body);
      if (entry.seconds < DEACTIVATION_SECONDS || this.#settling.has(handle)) group.resting = false;
    });
    for (const handle of still.keys()) if (!seen.has(handle)) still.delete(handle);
    // Havok deactivates a simulation island as a whole: the awake bodies joined by contacts
    // (and their systems' constraints) rest together or not at all. One put to sleep while
    // something still moving lay on it (the crate under a severed head rocking in it) dropped
    // its own contacts with what held it up and fell through the ground.
    for (const group of contactIslands(this.world, systems)) {
      if (group.some(({ resting }) => !resting)) for (const each of group) each.resting = false;
    }
    for (const { bodies, resting } of systems.values()) {
      if (!resting) continue;
      for (const body of bodies) {
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        body.sleep();
        still.delete(body.handle);
      }
    }
  }

  /**
   * Havok's one-sided welding for the warm start: a settling body that the step pushed
   * towards the back of a welded triangle it lies in (the meshes of statics and the landscape
   * are two-sided here, #twoSided) is put out at that triangle's front instead, with no speed
   * towards its back. The plugins place clutter sunk into what it lies on (berries into a
   * table's top, a book into a floor under a rubble pile, a bone into a cave's floor); out of
   * the deeper side, Rapier pushed it through to the far side (`tools/settle-audit.ts`: 92 of
   * the 69,455 loose objects of the interiors). Of the welded triangles a body is pushed to the
   * back of, the deepest one puts it out, each step. Not a body that stands on something under
   * it, within the push to the triangle's back (#supported): the triangle passes over it, it is not
   * sunk into it (a chaurus egg on a cave's floor under the edge of a mound's slope, put out on
   * the slope, rolled 230 units off; the Blue Palace's bucket 000CC306 a little over the floor
   * under a bed, put out on the bed's frame, was set 28 units up). Ragdolls meet the one-sided
   * copies instead.
   * TODO(M13): inferred from the files' welding type (one-sided: objects are put out on the
   * triangles' front); that Havok does so for a body placed deeper than half into a triangle
   * was not observed, nor whether it also does so after the warm start (here only while the
   * body settles).
   */
  #weld(): void {
    const world = this.world;
    let moved = false;
    for (const handle of this.#settling.keys()) {
      const body = world.getRigidBody(handle) as RAPIER.RigidBody | null;
      if (!body?.isDynamic() || body.isSleeping() || !body.isEnabled()) continue;
      let deepest = -WELD_DEPTH;
      let front: RAPIER.Vector | undefined;
      let lift = 0;
      // The welded triangles that push the body out at their front (a table's top, under a
      // dagger lying in it): one that pushes against the way out of another (the same table's
      // underside, which the dagger reaches into from above) is not gone through.
      const fronts: RAPIER.Vector[] = [];
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i);
        if (RAGDOLL_LAYERS.has(this.layerOf(collider))) continue;
        world.contactPairsWith(collider, (other) => {
          const mesh = this.#twoSided.get(other.handle);
          if (!mesh) return;
          world.contactPair(collider, other, (manifold, flipped) => {
            const contacts = manifold.numContacts();
            let depth = 0;
            for (let c = 0; c < contacts; c++) depth = Math.min(depth, manifold.contactDist(c));
            if (!(depth < -WELD_DEPTH)) return;
            const triangle = flipped ? manifold.subshape1() : manifold.subshape2();
            const face = triangleFront(other, mesh, triangle);
            if (!face) return;
            // The push on the body: away from the mesh, along the manifold's normal.
            const n = manifold.normal();
            const sign = flipped ? 1 : -1;
            const along = sign * (n.x * face.normal.x + n.y * face.normal.y + n.z * face.normal.z);
            if (along >= WELD_FACING) fronts.push(face.normal);
            if (along > -WELD_FACING || !(depth < deepest)) return;
            // Only what a body may rest on (a floor, a table's top, a slope it can lie on)
            // puts it out at its front: a fork stuck up into a cairn's underside is not put
            // out below the floor.
            if (face.normal.z < WELD_GROUND) return;
            // How far the body's deepest point lies behind the triangle's plane.
            const behind = behindFace(collider, face);
            if (behind === undefined || !(behind > 0)) return;
            deepest = depth;
            front = face.normal;
            lift = behind + WELD_MARGIN;
          });
        });
      }
      const out = front;
      if (!out) continue;
      if (fronts.some((f) => f.x * out.x + f.y * out.y + f.z * out.z < 0)) continue;
      // It stands on something under the triangle (a floor under a mound's edge, under a
      // counter it reaches up into): the triangle passes over it, it is not sunk into it.
      if (this.#supported(body, lift, -deepest)) continue;
      const at = body.translation();
      body.setTranslation(
        { x: at.x + out.x * lift, y: at.y + out.y * lift, z: at.z + out.z * lift },
        true,
      );
      moved = true;
      const v = body.linvel();
      const towards = v.x * out.x + v.y * out.y + v.z * out.z;
      if (towards < 0) {
        body.setLinvel(
          { x: v.x - out.x * towards, y: v.y - out.y * towards, z: v.z - out.z * towards },
          true,
        );
      }
    }
    // Moved after the step: ray and shape casts see the new places only after the next one.
    if (moved) this.#changed = true;
  }

  /**
   * Whether a settling body stands on something (#weld) rather than being sunk into the welded
   * triangle that would put it out at its front by `lift`, the solver pushing it towards the
   * triangle's back by `depth` (Havok units): straight under its centre of mass, a surface that
   * does not move and that it may rest on (facing up, at most 60° steep; a welded triangle by its
   * front), that the push towards the back takes its lowest point onto (no farther below it than
   * `depth` and WELD_SUPPORT_GAP), and that it is not sunk into deeper than the triangle's front
   * is above it (`lift`, at least WELD_SUPPORT_GAP).
   * - The Blue Palace's bucket [000CC306], 3 units over the floor under a bed, its rim 2.5 units
   *   up into the bed's frame, stands over the floor (put out on the frame, it was set 28 units
   *   up and ended 12 over its placed spot).
   * - A buried skull in Dustman's Cairn [000F051B], 5 units out of a dirt mound's top, the cave's
   *   floor some 9 units under it inside the hollow mound, is in the mound: pushed down out of it,
   *   it fell to that floor and rolled 125 units off; so too a mote effect's sphere in Yngol
   *   Barrow [000434FA], 5 units up into a surface with the hall's floor 21 units under it.
   * - A linen pile on Frostmere Crypt's stairs [000B314E], sunk 4 units into the linen sheet under
   *   its centre, lies in the stair's tread, not on the sheet: taken to stand on the sheet, it slid
   *   off it through the hall's wall and fell 3,184 units.
   * TODO(M13): inferred, all of it: the one ray straight down from the centre of mass, the two
   * bounds, the gap of 2 units (chosen by the settle audit), and reading a trimesh hit's side from
   * Rapier's featureId (0 the triangle's front, 1 its back: probed, not documented).
   */
  #supported(body: RAPIER.RigidBody, lift: number, depth: number): boolean {
    const down = { x: 0, y: 0, z: -1 };
    let reach = -Infinity;
    for (let i = 0; i < body.numColliders(); i++) {
      reach = Math.max(reach, colliderReach(body.collider(i), down) ?? -Infinity);
    }
    if (!Number.isFinite(reach)) return false;
    const com = body.worldCom();
    // reach is the lowest point's depth below the world's origin (-z); lowest its depth below
    // the centre of mass.
    const lowest = reach + com.z;
    // How far under its lowest point (the solver pushes it down by depth) and how far up into
    // what it is sunk into a surface may lie and still hold it up.
    const below = WELD_SUPPORT_GAP + depth;
    const above = Math.max(WELD_SUPPORT_GAP, lift);
    const length = lowest + below;
    if (!(length > 0)) return false;
    const collides = this.filterFor(this.layerOf(body.collider(0)));
    let found = false;
    this.world.intersectionsWithRay(
      new RAPIER.Ray(com, down),
      length,
      true,
      (hit) => {
        // The hit's normal faces the ray; on a triangle mesh Rapier's feature is the side hit
        // (0: the triangle's front, counter-clockwise; 1: its back). A welded triangle met at
        // its back (a table's underside, from inside the table) holds nothing up.
        // A ray from inside a solid shape (a rubble pile's hull pressing a book into the floor)
        // meets it at once: nothing the body stands on. Nor does a surface the body is sunk
        // into deeper than `above`: it lies in the triangle, not on that surface.
        const back = this.#twoSided.has(hit.collider.handle) && hit.featureId !== 0;
        found =
          !back &&
          hit.timeOfImpact > 0 &&
          hit.timeOfImpact >= lowest - above &&
          hit.normal.z >= WELD_GROUND;
        return !found;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
      undefined,
      undefined,
      body,
      (collider) => !this.#passing.has(collider.handle) && collides(collider),
    );
    return found;
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
    this.#spins.clear();
    this.forEachAwake((body) => {
      this.#velocities.set(body.handle, body.linvel());
      this.#spins.set(body.handle, body.angvel());
    });
    // A settling body is placed for good once it first sleeps (our deactivation leaves it be
    // until then, at most fWarmStartMaxTime: bAllowDeactivationWhileWarmStarting 0).
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
      if (this.onHardContact && speed / HAVOK_SCALE >= this.hardContactSpeed) {
        const side = (collider: RAPIER.Collider, body: RAPIER.RigidBody | null): ContactSide => ({
          owner: this.ownerOf(collider),
          mass: body?.isDynamic() === true ? body.mass() : 0,
        });
        this.onHardContact({ a: side(a, bodyA), b: side(b, bodyB), speed: speed / HAVOK_SCALE });
      }
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

  /**
   * Where the frame's clock lies between the last two steps (0: the one before, 1: the last),
   * for drawing between them: Havok steps until its time reaches the frame's, so its last step
   * is at or ahead of it (as Havok draws bodies at the frame's time between their steps).
   */
  get alpha(): number {
    return Math.min(1, Math.max(0, 1 + this.#accumulator / this.#size));
  }

  /** A shape of an actor (its controller, its bodies): what rays for a floor leave out. */
  isActor(collider: RAPIER.Collider): boolean {
    return this.ownerOf(collider)?.kind === 'actor';
  }

  /**
   * A living actor's character controller (the dead have none: their ragdoll's bodies are on
   * L_DEADBIP): what the ray for an actor's ground leaves out (actorGround, src/shell/actors.ts).
   */
  isActorController(collider: RAPIER.Collider): boolean {
    return this.layerOf(collider) === Layer.charController && this.isActor(collider);
  }

  /**
   * The first collider along a ray (game units) that `layer` collides with; not `exclude`, nor
   * any of the actor `ignore` (a reference: its own bodies, as an actor's sight passes its own
   * head; Havok keeps an actor's bodies in one system group that does not collide with itself),
   * nor any collider `skip` says to pass. Not `solid`, a ray that starts inside a shape meets it
   * only where it leaves it (as Havok's ray casts pass what they start inside).
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    layer: number,
    exclude?: RAPIER.Collider,
    ignore?: number,
    skip?: (collider: RAPIER.Collider) => boolean,
    solid = true,
  ): RayHit | undefined {
    const length = Math.hypot(...direction) || 1;
    const ray = new RAPIER.Ray(
      { x: toHavok(origin[0]), y: toHavok(origin[1]), z: toHavok(origin[2]) },
      { x: direction[0] / length, y: direction[1] / length, z: direction[2] / length },
    );
    const collides = this.filterFor(layer);
    const filter =
      ignore === undefined && skip === undefined
        ? collides
        : (collider: RAPIER.Collider): boolean => {
            const owner = this.ownerOf(collider);
            if (owner?.kind === 'actor' && owner.reference === ignore) return false;
            if (skip?.(collider) === true) return false;
            return collides(collider);
          };
    // Phantoms (trigger volumes) are not surfaces: the character controller passes them too.
    const hit = this.world.castRayAndGetNormal(
      ray,
      toHavok(maxDistance),
      solid,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      exclude,
      undefined,
      filter,
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
      collider: hit.collider,
    };
  }

  /**
   * Where a ray (game units) meets one of `bodies` first within `maxDistance` (`met`), and
   * which; missing them all, the point on them nearest the ray (each body's shapes asked for
   * their point nearest the ray's point nearest the shape's centre). Whatever layers they are
   * on: a shot that hit an actor's stand-in shape (a flier's controller) lies on its BIPED
   * bodies. Undefined: no bodies with shapes.
   */
  bodiesAlong(
    bodies: readonly PlacedBody[],
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
  ): { readonly body: PlacedBody; readonly point: Vec3; readonly met: boolean } | undefined {
    const length = Math.hypot(...direction) || 1;
    const unit: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
    const ray = new RAPIER.Ray(
      { x: toHavok(origin[0]), y: toHavok(origin[1]), z: toHavok(origin[2]) },
      { x: unit[0], y: unit[1], z: unit[2] },
    );
    const along = (t: number): Vec3 => [
      origin[0] + unit[0] * t,
      origin[1] + unit[1] * t,
      origin[2] + unit[2] * t,
    ];
    let first: { body: PlacedBody; distance: number } | undefined;
    let nearest: { body: PlacedBody; point: Vec3; gap: number } | undefined;
    for (const placed of bodies) {
      for (let i = 0; i < placed.body.numColliders(); i++) {
        const collider = placed.body.collider(i);
        const toi = collider.castRay(ray, toHavok(maxDistance), true);
        if (toi >= 0) {
          const distance = toi * HAVOK_SCALE;
          if (!first || distance < first.distance) first = { body: placed, distance };
          continue;
        }
        if (first) continue;
        const centre = collider.translation();
        const c: Vec3 = [centre.x * HAVOK_SCALE, centre.y * HAVOK_SCALE, centre.z * HAVOK_SCALE];
        const t = Math.min(
          maxDistance,
          Math.max(
            0,
            (c[0] - origin[0]) * unit[0] +
              (c[1] - origin[1]) * unit[1] +
              (c[2] - origin[2]) * unit[2],
          ),
        );
        const p = along(t);
        const projection = collider.projectPoint(
          { x: toHavok(p[0]), y: toHavok(p[1]), z: toHavok(p[2]) },
          false,
        );
        if (!projection) continue;
        const q: Vec3 = [
          projection.point.x * HAVOK_SCALE,
          projection.point.y * HAVOK_SCALE,
          projection.point.z * HAVOK_SCALE,
        ];
        const gap = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        if (!nearest || gap < nearest.gap) nearest = { body: placed, point: q, gap };
      }
    }
    if (first) return { body: first.body, point: along(first.distance), met: true };
    return nearest && { body: nearest.body, point: nearest.point, met: false };
  }

  /**
   * Whether a surface that `layer` collides with lies between two points (game units), not of
   * the actor `ignore`: the ray from `from` to `to`, and if it meets nothing the ray back (a
   * surface met from behind); where, and the surface's normal as the ray met it. Rays start on
   * surfaces, not in solids (a point inside a rock is no hit).
   */
  segmentHit(
    from: Vec3,
    to: Vec3,
    layer: number,
    ignore?: number,
  ): { readonly point: Vec3; readonly normal: Vec3 } | undefined {
    const collides = this.filterFor(layer);
    const filter = (collider: RAPIER.Collider): boolean => {
      const owner = this.ownerOf(collider);
      if (ignore !== undefined && owner?.kind === 'actor' && owner.reference === ignore) {
        return false;
      }
      return collides(collider);
    };
    const cast = (a: Vec3, b: Vec3): { point: Vec3; normal: Vec3 } | undefined => {
      const way: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const length = Math.hypot(...way);
      if (length < 1e-6) return undefined;
      const ray = new RAPIER.Ray(
        { x: toHavok(a[0]), y: toHavok(a[1]), z: toHavok(a[2]) },
        { x: way[0] / length, y: way[1] / length, z: way[2] / length },
      );
      const hit = this.world.castRayAndGetNormal(
        ray,
        toHavok(length),
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        filter,
      );
      if (!hit) return undefined;
      const along = hit.timeOfImpact * HAVOK_SCALE;
      return {
        point: [
          a[0] + (way[0] / length) * along,
          a[1] + (way[1] / length) * along,
          a[2] + (way[2] / length) * along,
        ],
        normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      };
    };
    return cast(from, to) ?? cast(to, from);
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
