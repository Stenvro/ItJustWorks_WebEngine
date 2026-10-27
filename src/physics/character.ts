// A character's collision and movement (the engine's character proxy): the controller shape
// on the CHARCONTROLLER layer, sliding along what that layer collides with, climbing steps and
// walkable slopes, falling under gravity and jumping. Moves in the physics world's fixed steps;
// `position` is interpolated between the last two steps for drawing.
// Platform-independent.

import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../render/math.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { Layer } from './collision-layers.ts';
import type { PhysicsOwner, PhysicsWorld } from './physics-world.ts';

/**
 * The controller shape, in game units: like the engine's hkCharControllerShape, two rings of
 * eight points with one point below and one above, grown by a convex shell. The cones between
 * the end points and the rings let it ride over small steps.
 */
export interface CharacterShape {
  /** Radius of the rings. */
  readonly radius: number;
  /** Total height, feet to top. */
  readonly height: number;
}

/** The convex shell around the controller shape (Havok's default convex radius, 0.05). */
export const CONTROLLER_SHELL = 0.05 * HAVOK_SCALE;

/**
 * The 18 points of the controller shape (game units, centred on the shape's middle): rings of
 * the bound's radius at a radius's height above the bottom and below the top, the end points
 * inset by the shell. The shell widens it by its 3.5 units: the first-person camera, in the
 * shape's middle, then stays beyond the near plane ([Display] fNearDistance 15) from a wall it
 * walks into; with the shell inside the ring (29 units across) it looked through walls.
 */
export function controllerPoints(shape: CharacterShape): Float32Array {
  const half = shape.height / 2 - CONTROLLER_SHELL;
  const radius = shape.radius;
  const ring = Math.max(0, Math.min(half, half - shape.radius));
  const points: number[] = [0, 0, -half, 0, 0, half];
  for (const z of [-ring, ring]) {
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      points.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    }
  }
  return Float32Array.from(points);
}

export interface CharacterSettings {
  /** Steepest walkable slope (degrees from flat). */
  readonly maxSlope: number;
  /** Gravity multiplier while falling ([HAVOK] fInAirFallingCharGravityMult). */
  readonly fallingGravity: number;
  /**
   * Gravity multiplier while standing on something too steep to walk on
   * ([HAVOK] fUnsupportedGravMult): the character slides off quickly.
   */
  readonly unsupportedGravity: number;
  /** Material ids of stairs (MATT flag): on them the controller steps up whole stairs. */
  readonly stairMaterials: ReadonlySet<number>;
  /** Highest stair it steps up (game units). */
  readonly stairHeight: number;
  /**
   * [HAVOK] fMoveLimitMass: bodies this heavy (kg) or heavier are not pushed by it (pushFactor);
   * MOVE_LIMIT_MASS when not given.
   */
  readonly moveLimitMass?: number;
}

/** [HAVOK] fMoveLimitMass's built-in default (kg). */
export const MOVE_LIMIT_MASS = 95;
/**
 * The most a push may change a body's speed (Havok units per second): a stronger push is scaled
 * down to it (observed in the original, as pushFactor).
 */
const PUSH_MAX_SPEED = 1000;

/**
 * How much of a character's push a simulated body it walks into takes, by its layer and mass
 * (the engine's character controller, observed in the original): nothing if it has no mass or weighs
 * fMoveLimitMass or more, nor a projectile; a prop (L_PROPS) three times if it weighs at most
 * half of that, else a tenth; a trap a tenth; anything else twice.
 */
export function pushFactor(layer: number, mass: number, moveLimitMass: number): number {
  if (!(mass > 0) || mass >= moveLimitMass) return 0;
  if (layer === Layer.projectile) return 0;
  if (layer === Layer.props) return mass <= moveLimitMass * 0.5 ? 3 : 0.1;
  if (layer === Layer.trap) return 0.1;
  return 2;
}

/**
 * The impulse (Havok units, kg·m/s) a character moving at `velocity` gives a body of `mass` it
 * pushes along `direction` (unit, into the body) at a point moving at `pointVelocity` (Havok
 * units per second): what takes the point up to the character's speed along the push (the
 * character as an immovable pusher; TODO(M13): Havok's character proxy's own impulse is not
 * known), its speed change held to PUSH_MAX_SPEED, times pushFactor.
 */
export function pushImpulse(
  velocity: Vec3,
  pointVelocity: Vec3,
  direction: Vec3,
  mass: number,
  factor: number,
): number {
  const closing =
    (velocity[0] - pointVelocity[0]) * direction[0] +
    (velocity[1] - pointVelocity[1]) * direction[1] +
    (velocity[2] - pointVelocity[2]) * direction[2];
  if (!(closing > 0) || !(factor > 0) || !(mass > 0)) return 0;
  return mass * Math.min(closing, PUSH_MAX_SPEED) * factor;
}

/** Gap the controller keeps to surfaces (Havok units). */
const SKIN = 0.01;
/** Rounds of penetration recovery (each pushes out of everything the shape overlaps). */
const RECOVERY_ROUNDS = 4;
/**
 * On stairs, a step is climbed when the controller's own movement got less than this share of
 * the way it was to go (measured along that way).
 */
const STEP_BLOCKED = 0.6;
const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
/** A step-up slides along what blocks it when that leaves this share of the way. */
const SLIDE_MIN = 0.2;
/** Coming down onto a step, away from a wall at the shape's side by this much (Havok units). */
const STEP_AWAY = 0.03;
const STEP_AWAY_TRIES = 3;
/**
 * A blocked actor tries these turns of its way (radians, nearest first, right and left) and
 * takes the first that gets it on: wedged in a crease between a wall and a slope (where the
 * navmesh and the collision part) or against a corner, it slides out instead of pressing on.
 */
const SEEK_TURNS = [0.52, -0.52, 0.96, -0.96, 1.4, -1.4];
/** An NPC held up by another actor alone moves off it at least this fast (units a second). */
const OFF_ACTOR_SPEED = 100;
/** A turned way is taken when it gets this share of its own length. */
const SEEK_MADE = 0.3;
/**
 * Every turn failed: while it stays where it is (SEEK_STILL Havok units) and wants the same way
 * (SEEK_SAME_WAY, the cosine between them), the turns are tried again only every SEEK_RETRY
 * steps (each try is a sweep of the controller; an actor pressed into a wall it cannot get
 * round tried all six every step, as much as every other actor's movement together).
 */
const SEEK_RETRY = 8;
const SEEK_STILL = 0.01;
const SEEK_SAME_WAY = 0.999;

/** The way along a surface (its normal) that is left of a horizontal direction, if enough. */
function along(
  direction: RAPIER.Vector,
  normal: RAPIER.Vector,
): { direction: RAPIER.Vector; share: number } | undefined {
  const n = Math.hypot(normal.x, normal.y);
  if (n < 1e-6) return undefined;
  const nx = normal.x / n;
  const ny = normal.y / n;
  const into = direction.x * nx + direction.y * ny;
  const sx = direction.x - into * nx;
  const sy = direction.y - into * ny;
  const share = Math.hypot(sx, sy);
  return share > SLIDE_MIN
    ? { direction: { x: sx / share, y: sy / share, z: 0 }, share }
    : undefined;
}

const toHavok = (v: number): number => v / HAVOK_SCALE;

/**
 * The mass a character's controller pushes back with (kg), against a moving body's
 * (pushedSpeed). TODO(M13): the engine's character proxy mass is not documented.
 */
export const ACTOR_MASS = 100;
/** The most a moving body speeds a character it hits (game units per second). */
const PUSHED_MAX_SPEED = 400;
/** How fast a push dies away (per second: its speed falls by e every 1/PUSH_DAMPING seconds). */
const PUSH_DAMPING = 6;
/** A body pushes from contacts at most this far apart (Havok units: the narrow phase's margin). */
const PUSH_CONTACT = 0.02;
/** How far under its feet a moving body carries a character (game units). */
const CARRIER_REACH = 4;
/** A carrier moved less than this (Havok units, radians) since its last step did not move. */
const CARRIER_STILL = 1e-5;

/**
 * The speed (game units per second, along the push) a body closing on a character at `closing`
 * gives it: the character's share of an elastic blow between the two masses, never faster than
 * the body itself, held to PUSHED_MAX_SPEED. TODO(M13): Havok's proxy's own response is not known.
 */
export function pushedSpeed(closing: number, bodyMass: number, actorMass: number): number {
  if (!(closing > 0) || !(bodyMass > 0)) return 0;
  const share = Math.min(1, (2 * bodyMass) / (bodyMass + Math.max(1e-3, actorMass)));
  return Math.min(PUSHED_MAX_SPEED, closing * share);
}

/** A body's pose (Havok units). */
interface Pose {
  readonly at: RAPIER.Vector;
  readonly turn: RAPIER.Rotation;
}

function multiply(a: RAPIER.Rotation, b: RAPIER.Rotation): RAPIER.Rotation {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

const conjugate = (q: RAPIER.Rotation): RAPIER.Rotation => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

function rotate(q: RAPIER.Rotation, v: RAPIER.Vector): RAPIER.Vector {
  // v + 2w(q × v) + 2 q × (q × v)
  const cx = q.y * v.z - q.z * v.y;
  const cy = q.z * v.x - q.x * v.z;
  const cz = q.x * v.y - q.y * v.x;
  return {
    x: v.x + 2 * (q.w * cx + q.y * cz - q.z * cy),
    y: v.y + 2 * (q.w * cy + q.z * cx - q.x * cz),
    z: v.z + 2 * (q.w * cz + q.x * cy - q.y * cx),
  };
}

/** The turn about the up axis (radians, counter-clockwise seen from above) of a rotation. */
const yawOf = (q: RAPIER.Rotation): number =>
  Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));

/** Where a point on a body at `from` is once the body is at `to`. */
function carryPoint(from: Pose, to: Pose, point: RAPIER.Vector): RAPIER.Vector {
  const r = rotate(multiply(to.turn, conjugate(from.turn)), {
    x: point.x - from.at.x,
    y: point.y - from.at.y,
    z: point.z - from.at.z,
  });
  return { x: to.at.x + r.x, y: to.at.y + r.y, z: to.at.z + r.z };
}

/** The turn about the up axis from one pose to another (radians, counter-clockwise). */
const yawBetween = (from: Pose, to: Pose): number => yawOf(multiply(to.turn, conjugate(from.turn)));

/**
 * The pose a body has at the end of the coming step of `seconds`: a keyframed body its next
 * keyframe (where its animation or mover sets it), else where its velocity takes it.
 */
function poseAfter(body: RAPIER.RigidBody, seconds: number): Pose {
  if (body.bodyType() === RAPIER.RigidBodyType.KinematicPositionBased) {
    return { at: body.nextTranslation(), turn: body.nextRotation() };
  }
  const at = body.translation();
  const turn = body.rotation();
  const com = body.worldCom();
  const v = body.linvel();
  const w = body.angvel();
  const angle = Math.hypot(w.x, w.y, w.z) * seconds;
  const s = angle > 1e-9 ? Math.sin(angle / 2) / (angle / seconds) : 0;
  const spin = { x: w.x * s, y: w.y * s, z: w.z * s, w: Math.cos(angle / 2) };
  const r = rotate(spin, { x: at.x - com.x, y: at.y - com.y, z: at.z - com.z });
  return {
    at: {
      x: com.x + v.x * seconds + r.x,
      y: com.y + v.y * seconds + r.y,
      z: com.z + v.z * seconds + r.z,
    },
    turn: multiply(spin, turn),
  };
}

function samePose(a: Pose, b: Pose): boolean {
  return (
    Math.abs(a.at.x - b.at.x) < CARRIER_STILL &&
    Math.abs(a.at.y - b.at.y) < CARRIER_STILL &&
    Math.abs(a.at.z - b.at.z) < CARRIER_STILL &&
    Math.abs(
      a.turn.x * b.turn.x + a.turn.y * b.turn.y + a.turn.z * b.turn.z + a.turn.w * b.turn.w,
    ) >
      1 - CARRIER_STILL
  );
}

export class CharacterBody {
  readonly physics: PhysicsWorld;
  readonly shape: CharacterShape;
  readonly settings: CharacterSettings;
  readonly owner: PhysicsOwner;
  readonly #controller: RAPIER.KinematicCharacterController;
  readonly #body: RAPIER.RigidBody;
  readonly #collider: RAPIER.Collider;
  /** Feet (bottom of the capsule) after the last step and the one before, game units. */
  #feet: [number, number, number];
  #previous: [number, number, number];
  /** Vertical speed, game units per second (up positive). */
  verticalSpeed = 0;
  #grounded = false;
  /** Horizontal velocity to move with (game units per second), set by the owner. */
  velocity: [number, number] = [0, 0];
  #jumpSpeed = 0;
  /** Contacts of the last step: what the shape touched (for pushing objects). */
  readonly touched: RAPIER.Collider[] = [];
  /** Colliders it moves through (a horse its own cart: they are hitched, never in its way). */
  ignored: ReadonlySet<number> = new Set();
  /**
   * Swimming: no gravity; the owner sets the vertical speed (floating at the surface,
   * diving and rising).
   */
  swimming = false;
  /**
   * Whether actors walk at a point (game units: the feet), for steps off the stairs: the
   * navigation meshes' surface. Undefined: steps are climbed on stairs only.
   * TODO(M13): how far the engine's TryStep goes off the stairs is not documented.
   */
  walkable: ((x: number, y: number, z: number) => boolean) | undefined;
  /**
   * Blocked, it seeks a way round (SEEK_TURNS): actors on their paths. The player's controller
   * goes only where it is steered. TODO(M13): the engine's own controller for NPCs.
   */
  seeksAround = false;
  /**
   * Whether another actor's shape is ground to it. Off (an NPC's), what holds it up only by
   * another actor (it walked up the slope of one's lower shape, or stepped onto it) is no
   * support: it slides off as from too steep a slope. The player stands on actors' heads.
   * TODO(M13): Havok's character proxy's own rule for standing on other characters was not
   * read; NPCs are not seen standing on one another in the game.
   */
  standsOnActors = true;
  /**
   * How far it fell before landing in the last step (game units: from the highest point since it
   * left the ground), else undefined; a landing in water is none (falling damage:
   * src/gameplay/falling.ts).
   */
  landedFrom: number | undefined;
  /** The highest point of its feet since it left the ground, while in the air. */
  #fallTop: number | undefined;
  /** Standing on something too steep to walk on (sliding off). */
  #unsupported = false;
  /** Held up by another actor alone: the way off it (unit, horizontal), until it lands. */
  #offActor: [number, number] | undefined;
  /** Where every turn of its way failed, the way, and the steps since (SEEK_RETRY). */
  #seekFailed: { at: RAPIER.Vector; x: number; y: number; steps: number } | undefined;
  /** Something below the shape touched it in the last step (ground, a slope, a step). */
  #below = false;
  /**
   * The moving body it stands on (keyframed: a lift, a turning platform, a cart's bed; or
   * simulated) and the pose of it that it was carried to so far: the engine's character proxy
   * moves with the velocity of the surface under it.
   */
  #carrier: { body: RAPIER.RigidBody; collider: RAPIER.Collider; pose: Pose } | undefined;
  /**
   * How much the body it stands on turned it in the last step (radians, as the game's headings
   * go: clockwise seen from above): its owner adds it to the actor's heading.
   */
  carriedTurn = 0;
  /** The speed a moving body that hit it gave it, dying away (game units per second). */
  #pushed: [number, number] = [0, 0];
  /** The mass it pushes back with against moving bodies (kg; pushedSpeed). */
  mass = ACTOR_MASS;

  constructor(
    physics: PhysicsWorld,
    shape: CharacterShape,
    settings: CharacterSettings,
    feet: Vec3,
    owner: PhysicsOwner,
  ) {
    this.physics = physics;
    this.shape = shape;
    this.settings = settings;
    this.owner = owner;
    this.#feet = [...feet];
    this.#previous = [...feet];
    const world = physics.world;
    const controller = world.createCharacterController(SKIN);
    controller.setUp({ x: 0, y: 0, z: 1 });
    controller.setMaxSlopeClimbAngle((settings.maxSlope * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((settings.maxSlope * Math.PI) / 180);
    // Steps are climbed by the shape's lower cone, as the engine's shape does; walking down
    // slopes and stairs it stays on the ground for as far as that cone reaches.
    controller.enableSnapToGround(toHavok(shape.radius));
    // What it walks into it pushes by the engine's rule (#push), not by Rapier's.
    controller.setApplyImpulsesToDynamicBodies(false);
    this.#controller = controller;
    const center = this.#center(feet);
    this.#body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z),
    );
    const points = controllerPoints(shape).map(toHavok);
    const desc =
      RAPIER.ColliderDesc.roundConvexHull(points, toHavok(CONTROLLER_SHELL)) ??
      RAPIER.ColliderDesc.capsule(
        toHavok(shape.height / 2 - shape.radius),
        toHavok(shape.radius),
      ).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
    this.#collider = world.createCollider(desc, this.#body);
    physics.register(this.#collider, Layer.charController, owner);
  }

  /**
   * A body of its own actor (its ragdoll's bones, what it holds or wears that has collision):
   * the engine's character and its bodies share a collision system group, which does not
   * collide with itself, so they never block or push its controller. (A kinematic shape of an
   * archer's own, inside its capsule, pushed it out every step: it slid about at up to 600
   * units a second while it stood.)
   */
  #ownBody(collider: RAPIER.Collider): boolean {
    const owner = this.physics.ownerOf(collider);
    return (
      this.owner.kind === 'actor' &&
      owner?.kind === 'actor' &&
      owner.reference === this.owner.reference
    );
  }

  /**
   * What holds it up once it moved by `moved` (Havok units): 'ground' when something that is not
   * another actor lies within a stair's height under its feet (a ray down from its middle meets
   * it, else its shape cast down meets it: brushing past another, its lower shape a little up the
   * other's, it still stands on the floor), else the other actor's shape just under it, if any.
   */
  #support(
    moved: RAPIER.Vector,
    predicate: (collider: RAPIER.Collider) => boolean,
  ): 'ground' | RAPIER.Collider | undefined {
    const at = this.#body.translation();
    const from = { x: at.x + moved.x, y: at.y + moved.y, z: at.z + moved.z };
    const notActor = (collider: RAPIER.Collider): boolean =>
      predicate(collider) && !this.#otherActor(collider);
    const reach = this.settings.stairHeight + CONTROLLER_SHELL + 1;
    const ray = this.physics.world.castRay(
      new RAPIER.Ray(from, { x: 0, y: 0, z: -1 }),
      toHavok(this.shape.height / 2 + reach),
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.#collider,
      undefined,
      notActor,
    );
    if (ray) return 'ground';
    const cast = (keep: (collider: RAPIER.Collider) => boolean, distance: number) =>
      this.physics.world.castShape(
        from,
        NO_ROTATION,
        { x: 0, y: 0, z: -1 },
        this.#collider.shape,
        SKIN,
        toHavok(distance),
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.#collider,
        undefined,
        keep,
      );
    if (cast(notActor, reach)) return 'ground';
    // As far as it snaps to the ground (the radius) and its shell.
    return cast(
      (collider) => predicate(collider) && this.#otherActor(collider),
      this.shape.radius + CONTROLLER_SHELL + 1,
    )?.collider;
  }

  /** Another actor's shape its own overlaps where it is now (placed into it), if any. */
  #overlappedActor(predicate: (collider: RAPIER.Collider) => boolean): RAPIER.Collider | undefined {
    let found: RAPIER.Collider | undefined;
    this.physics.world.intersectionsWithShape(
      this.#body.translation(),
      NO_ROTATION,
      this.#collider.shape,
      (other) => {
        found = other;
        return false;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.#collider,
      undefined,
      (collider) => predicate(collider) && this.#otherActor(collider),
    );
    return found;
  }

  /** A shape of another actor (its controller, its bodies). */
  #otherActor(collider: RAPIER.Collider): boolean {
    const owner = this.physics.ownerOf(collider);
    return owner?.kind === 'actor' && owner.reference !== this.owner.reference;
  }

  /** Centre of the capsule (Havok units) for feet at `feet` (game units). */
  #center(feet: Vec3): RAPIER.Vector {
    return {
      x: toHavok(feet[0]),
      y: toHavok(feet[1]),
      z: toHavok(feet[2] + this.shape.height / 2),
    };
  }

  get collider(): RAPIER.Collider {
    return this.#collider;
  }

  /** Whether something below touched the shape in the last step (also while swimming). */
  get supported(): boolean {
    return this.#below || this.#grounded;
  }

  get grounded(): boolean {
    return this.#grounded;
  }

  /** Feet after the last physics step. */
  get feet(): Vec3 {
    return this.#feet;
  }

  /** Feet interpolated between the last two steps (`alpha` 0..1 into the next step). */
  feetAt(alpha: number): Vec3 {
    const a = Math.min(1, Math.max(0, alpha));
    return [
      this.#previous[0] + (this.#feet[0] - this.#previous[0]) * a,
      this.#previous[1] + (this.#feet[1] - this.#previous[1]) * a,
      this.#previous[2] + (this.#feet[2] - this.#previous[2]) * a,
    ];
  }

  /** Places the character (no sliding, no interpolation). */
  teleport(feet: Vec3): void {
    this.#feet = [...feet];
    this.#previous = [...feet];
    this.verticalSpeed = 0;
    this.#fallTop = undefined;
    this.landedFrom = undefined;
    this.#carrier = undefined;
    this.#pushed = [0, 0];
    this.#body.setTranslation(this.#center(feet), true);
    this.#body.setNextKinematicTranslation(this.#center(feet));
  }

  /**
   * Carries the character along (a rider on its horse, a passenger on a cart): its feet after
   * this step and the one before, as what carries it moved them (it is drawn between them).
   */
  carry(previous: Vec3, feet: Vec3): void {
    this.#previous = [...previous];
    this.#feet = [...feet];
    this.verticalSpeed = 0;
    this.#fallTop = undefined;
    this.landedFrom = undefined;
    this.#carrier = undefined;
    this.carriedTurn = 0;
    this.#body.setNextKinematicTranslation(this.#center(feet));
  }

  /**
   * Whether the shape is in the world (it collides, is touched, blocks): off while riding, so
   * the horse's own shape is not stopped by its rider's.
   */
  set solid(on: boolean) {
    this.#collider.setEnabled(on);
  }

  /**
   * Moves the character out of what its shape overlaps, as Havok's character proxy recovers
   * from penetration: along each contact's normal by its depth, for a few rounds. A door's
   * arrival point may lie in the door (KatariahWorld's balcony door: 25 units in front of it,
   * where the shape reaches 32). Ray and shape casts must see the world (after a step).
   */
  recover(): void {
    const own = this.#collider;
    const filter = this.physics.filterFor(Layer.charController);
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    for (let round = 0; round < RECOVERY_ROUNDS; round++) {
      const at = this.#body.translation();
      const push = { x: 0, y: 0, z: 0 };
      let contacts = 0;
      this.physics.world.intersectionsWithShape(
        at,
        rotation,
        own.shape,
        (other) => {
          const contact = own.shape.contactShape(
            at,
            rotation,
            other.shape,
            other.translation(),
            other.rotation(),
            0,
          );
          if (contact && contact.distance < -SKIN) {
            // normal2 points out of the other shape: the way out.
            const depth = -contact.distance + SKIN;
            push.x += contact.normal2.x * depth;
            push.y += contact.normal2.y * depth;
            push.z += contact.normal2.z * depth;
            contacts++;
          }
          return true;
        },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        own,
        undefined,
        (collider) => filter(collider) && !this.#ownBody(collider),
      );
      if (contacts === 0) return;
      const next = { x: at.x + push.x, y: at.y + push.y, z: at.z + push.z };
      this.#body.setTranslation(next, true);
      this.#body.setNextKinematicTranslation(next);
      this.#feet = [
        next.x * HAVOK_SCALE,
        next.y * HAVOK_SCALE,
        next.z * HAVOK_SCALE - this.shape.height / 2,
      ];
      this.#previous = this.#feet;
    }
    this.physics.world.propagateModifiedBodyPositionsToColliders();
  }

  /**
   * Climbs a step of a staircase that the controller's own movement stopped at: the shape
   * rises by up to the stair height (as far as there is room above it), moves on (the way it
   * was to go, else along what blocks it: a wall beside the stairs), and comes down onto the
   * step, if that is walkable ground higher than where it stood. Coming down, a wall the shape
   * touches at its side is stepped away from first (it is met before the step). Returns the
   * movement (Havok units), or undefined if no step is climbed. Rapier's own autostep, tried
   * first, stopped on the Volkihar courtyard's stairs at random treads (24 units high, like the
   * ones climbed before them) whatever its minimum step width.
   */
  #stepUp(
    desired: RAPIER.Vector,
    predicate: (collider: RAPIER.Collider) => boolean,
  ): RAPIER.Vector | undefined {
    const world = this.physics.world;
    const shape = this.#collider.shape;
    const cast = (from: RAPIER.Vector, direction: RAPIER.Vector, distance: number) =>
      world.castShape(
        from,
        NO_ROTATION,
        direction,
        shape,
        SKIN,
        distance,
        // What the shape touches already (the step it stands on) is no hit moving away from it.
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.#collider,
        undefined,
        predicate,
      );
    const at = this.#body.translation();
    const length = Math.hypot(desired.x, desired.y);
    if (length < 1e-6) return undefined;
    const rise = toHavok(this.settings.stairHeight);
    const up = cast(at, { x: 0, y: 0, z: 1 }, rise)?.time_of_impact ?? rise;
    if (up <= SKIN) return undefined;
    const raised = { x: at.x, y: at.y, z: at.z + up };
    let direction = { x: desired.x / length, y: desired.y / length, z: 0 };
    const ahead = cast(raised, direction, length);
    let on = ahead?.time_of_impact ?? length;
    const slide = ahead && on < length / 2 ? along(direction, ahead.normal1) : undefined;
    if (slide) {
      const room = length * slide.share;
      const slid = cast(raised, slide.direction, room)?.time_of_impact ?? room;
      if (slid > on) {
        direction = slide.direction;
        on = slid;
      }
    }
    if (on <= SKIN) return undefined;
    const over = { x: raised.x + direction.x * on, y: raised.y + direction.y * on, z: raised.z };
    const walkable = Math.cos((this.settings.maxSlope * Math.PI) / 180);
    const reach = up + toHavok(this.shape.radius);
    let down = cast(over, { x: 0, y: 0, z: -1 }, reach);
    for (let away = 0; away < STEP_AWAY_TRIES && down && down.normal1.z < walkable; away++) {
      // A steep wall met first, touching the shape's side: a little away from it, and again.
      const n = Math.hypot(down.normal1.x, down.normal1.y);
      if (n < 1e-6 || down.time_of_impact > SKIN * 2) break;
      over.x += (down.normal1.x / n) * STEP_AWAY;
      over.y += (down.normal1.y / n) * STEP_AWAY;
      down = cast(over, { x: 0, y: 0, z: -1 }, reach);
    }
    // Nothing below: a drop, not a step. Too steep: not ground. Another actor: not ground to one
    // that does not stand on actors.
    if (!down || down.normal1.z < walkable) return undefined;
    if (!this.standsOnActors && this.#otherActor(down.collider)) return undefined;
    const landed = over.z - down.time_of_impact;
    if (landed <= at.z + SKIN) return undefined;
    return { x: over.x - at.x, y: over.y - at.y, z: landed - at.z };
  }

  /** The first turn of a blocked way that gets on (SEEK_TURNS), its movement and grounding. */
  #seekAround(
    desired: RAPIER.Vector,
    predicate: (collider: RAPIER.Collider) => boolean,
  ): { moved: RAPIER.Vector; grounded: boolean } | undefined {
    const at = this.#body.translation();
    const failed = this.#seekFailed;
    if (failed && failed.steps < SEEK_RETRY) {
      const length = Math.hypot(desired.x, desired.y) * Math.hypot(failed.x, failed.y);
      const same =
        length > 0 && (desired.x * failed.x + desired.y * failed.y) / length >= SEEK_SAME_WAY;
      const still =
        Math.abs(at.x - failed.at.x) <= SEEK_STILL &&
        Math.abs(at.y - failed.at.y) <= SEEK_STILL &&
        Math.abs(at.z - failed.at.z) <= SEEK_STILL;
      if (same && still) {
        failed.steps++;
        return undefined;
      }
    }
    this.#seekFailed = undefined;
    for (const turn of SEEK_TURNS) {
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const way = {
        x: desired.x * cos - desired.y * sin,
        y: desired.x * sin + desired.y * cos,
        z: desired.z,
      };
      this.#controller.computeColliderMovement(
        this.#collider,
        way,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        predicate,
      );
      const moved = this.#controller.computedMovement();
      const made = moved.x * way.x + moved.y * way.y;
      // On along the turned way, and still forward on the way it wanted.
      if (
        made >= (way.x * way.x + way.y * way.y) * SEEK_MADE &&
        moved.x * desired.x + moved.y * desired.y > 0
      ) {
        return {
          moved: { x: moved.x, y: moved.y, z: moved.z },
          grounded: this.#controller.computedGrounded(),
        };
      }
    }
    this.#seekFailed = { at, x: desired.x, y: desired.y, steps: 0 };
    return undefined;
  }

  /** Jumps with this upward speed (game units per second) at the next step, if grounded. */
  jump(speed: number): boolean {
    if (!this.#grounded) return false;
    this.#jumpSpeed = speed;
    return true;
  }

  /** One fixed step: gravity, the wanted movement, sliding and stepping. Before world.step. */
  step(seconds: number): void {
    // Coming off another actor it is pressed into (placed into it: the player set at a coc
    // marker where an NPC stands), first out of what it overlaps, as the character proxy
    // recovers from penetration: the controller does not move a shape out of one it is in.
    if (this.#offActor) this.recover();
    // Carried by what it stands on (#carrier): first by what that moved since its last step (a
    // script set it there: TranslateTo, SetPosition), so the shape stands on it again.
    this.carriedTurn = 0;
    const carrier =
      this.#carrier?.body.isValid() === true && !this.swimming ? this.#carrier : undefined;
    this.#carrier = undefined;
    const carrierNow: Pose | undefined = carrier && {
      at: carrier.body.translation(),
      turn: carrier.body.rotation(),
    };
    if (carrier && carrierNow && !samePose(carrier.pose, carrierNow)) {
      const to = carryPoint(carrier.pose, carrierNow, this.#body.translation());
      this.#body.setTranslation(to, true);
      this.#body.setNextKinematicTranslation(to);
      this.physics.world.propagateModifiedBodyPositionsToColliders();
      this.carriedTurn -= yawBetween(carrier.pose, carrierNow);
    }
    // Moving bodies that hit it push it (#takePushes).
    this.#takePushes(carrier?.body, seconds);
    const gravity = -this.physics.world.gravity.z * HAVOK_SCALE;
    if (this.swimming) {
      this.#jumpSpeed = 0;
    } else if (this.#jumpSpeed > 0) {
      this.verticalSpeed = this.#jumpSpeed;
      this.#jumpSpeed = 0;
      this.#grounded = false;
    } else if (this.#grounded) {
      // On the ground it only moves along; snapping to the ground keeps it on slopes and down
      // steps. Pressing down as well makes Rapier's controller hit the floor at the start of
      // the step, and now and then it drops the rest of the step's movement there: the
      // character stutters and sticks on flat floors.
      this.verticalSpeed = 0;
    } else {
      const multiplier = this.#unsupported
        ? this.settings.unsupportedGravity
        : this.verticalSpeed < 0
          ? this.settings.fallingGravity
          : 1;
      this.verticalSpeed -= gravity * multiplier * seconds;
    }
    // Off another actor it stood on: away from it at least as fast as it falls (as off a slope).
    const off = this.#offActor;
    const slide = off ? Math.max(OFF_ACTOR_SPEED, -this.verticalSpeed) : 0;
    const desired = {
      x: toHavok((this.velocity[0] + this.#pushed[0] + (off ? off[0] * slide : 0)) * seconds),
      y: toHavok((this.velocity[1] + this.#pushed[1] + (off ? off[1] * slide : 0)) * seconds),
      z: toHavok(this.verticalSpeed * seconds),
    };
    // On stairs (surfaces of a stair material) whole steps are climbed; elsewhere only what
    // the shape's lower cone rides over.
    // A staircase is a staircase from any of its shapes: its steps have a stair material, its
    // risers and sides often plain stone, and walking into a riser must climb it too.
    const stairs = this.touched.some((collider) =>
      [...this.physics.objectMaterialsOf(collider)].some((material) =>
        this.settings.stairMaterials.has(material),
      ),
    );
    const own = this.#collider;
    const filter = this.physics.filterFor(Layer.charController);
    const ignored = this.ignored;
    const predicate = (collider: RAPIER.Collider): boolean =>
      collider.handle !== own.handle &&
      !ignored.has(collider.handle) &&
      filter(collider) &&
      !this.#ownBody(collider);
    const wasGrounded = this.#grounded;
    this.#controller.computeColliderMovement(
      own,
      desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      predicate,
    );
    let moved: RAPIER.Vector = this.#controller.computedMovement();
    const rising = this.verticalSpeed > 0;
    this.#grounded = !this.swimming && !rising && this.#controller.computedGrounded();
    // How far it got the way it was to go (sliding along a riser is no way up the stairs).
    const wanted = desired.x * desired.x + desired.y * desired.y;
    const made = moved.x * desired.x + moved.y * desired.y;
    // Off the stairs a step is tried too (the engine's controller has a TryStep), but only onto
    // ground actors walk (`walkable`): rubble, rocks, raised floor pieces, not benches.
    const walkable = this.walkable;
    if (
      (stairs || walkable) &&
      wasGrounded &&
      !rising &&
      !this.swimming &&
      made < wanted * STEP_BLOCKED
    ) {
      const step = this.#stepUp(desired, predicate);
      const at = this.#body.translation();
      if (
        step &&
        (stairs ||
          walkable?.(
            (at.x + step.x) * HAVOK_SCALE,
            (at.y + step.y) * HAVOK_SCALE,
            (at.z + step.z) * HAVOK_SCALE - this.shape.height / 2,
          ))
      ) {
        moved = step;
        this.#grounded = true;
      }
    }
    // Touching something below that is not walkable ground: sliding off it.
    this.touched.length = 0;
    let below = false;
    // Another actor touched below it (standsOnActors).
    let onActor: RAPIER.Collider | undefined;
    // Another actor touched at all (its side too).
    let byActor: RAPIER.Collider | undefined;
    for (let i = 0; i < this.#controller.numComputedCollisions(); i++) {
      const collision = this.#controller.computedCollision(i);
      if (!collision?.collider) continue;
      this.touched.push(collision.collider);
      if (this.#otherActor(collision.collider)) byActor = collision.collider;
      // normal1: the surface touched, facing the character (up for ground below).
      if (collision.normal1.z > 0.05) {
        below = true;
        if (this.#otherActor(collision.collider)) onActor = collision.collider;
      }
      if (seconds > 0) this.#push(collision, desired, seconds);
    }
    // Still blocked: an actor seeks a way round, its way turned a little, then more.
    if (
      this.seeksAround &&
      wasGrounded &&
      !rising &&
      !this.swimming &&
      wanted > 0 &&
      moved.x * desired.x + moved.y * desired.y < wanted * STEP_BLOCKED
    ) {
      const round = this.#seekAround(desired, predicate);
      if (round) {
        moved = round.moved;
        this.#grounded = round.grounded;
      }
    }
    // Held up by another actor alone (nothing else just under its shape where it goes): no
    // ground; it slides off that actor, falling at the unsupported gravity.
    // In the air, its fall stopped by another actor it is in or on: as held up by it.
    const stopped = !this.#grounded && desired.z < 0 && moved.z > desired.z * 0.5;
    const caught =
      !this.standsOnActors && stopped
        ? (onActor ?? byActor ?? this.#overlappedActor(predicate))
        : undefined;
    // In one: out of it at once.
    if (caught !== undefined && !this.swimming && this.#overlappedActor(predicate)) {
      this.recover();
      moved = { x: 0, y: 0, z: 0 };
    }
    if (
      !this.standsOnActors &&
      (this.#grounded || (caught !== undefined && this.#support(moved, predicate) !== 'ground')) &&
      !this.swimming
    ) {
      const support = this.#support(moved, predicate) ?? onActor ?? caught;
      // Coming off one, nothing under it yet (it leans on that actor's side): still off it.
      if (support === undefined && this.#offActor) this.#grounded = false;
      if (support !== 'ground' && support !== undefined) {
        this.#grounded = false;
        const at = this.#body.translation();
        const other = support.translation();
        const dx = at.x - other.x;
        const dy = at.y - other.y;
        const length = Math.hypot(dx, dy);
        this.#offActor = length > 1e-6 ? [dx / length, dy / length] : [1, 0];
      }
    }
    if (this.#grounded || this.swimming) this.#offActor = undefined;
    this.#unsupported = !this.#grounded && !this.swimming && below;
    this.#below = below;
    // A ceiling stops the rise; the ground stops the fall.
    if (rising && moved.z < desired.z * 0.5) this.verticalSpeed = 0;
    if (this.#grounded && this.verticalSpeed < 0) this.verticalSpeed = 0;
    const current = this.#body.translation();
    const next = { x: current.x + moved.x, y: current.y + moved.y, z: current.z + moved.z };
    // What it stands on, where everything is now (before this step moves the bodies).
    const standing =
      this.#grounded && !this.swimming ? this.#findCarrier(next, predicate, seconds) : undefined;
    // Then by what the body it stands on does in this step (its next keyframe, its velocity),
    // as far as nothing else stops the shape.
    // TODO(M13): leaving it (a jump, a step off) the actor does not keep its velocity.
    if (standing) {
      const now = { at: standing.body.translation(), turn: standing.body.rotation() };
      const to = carryPoint(now, standing.pose, next);
      const carried = this.#carryBlocked(
        next,
        { x: to.x - next.x, y: to.y - next.y, z: to.z - next.z },
        standing.collider,
        predicate,
      );
      next.x += carried.x;
      next.y += carried.y;
      next.z += carried.z;
      this.carriedTurn -= yawBetween(now, standing.pose);
    }
    this.#carrier = standing;
    this.#body.setNextKinematicTranslation(next);
    this.#previous = this.#feet;
    this.#feet = [
      next.x * HAVOK_SCALE,
      next.y * HAVOK_SCALE,
      next.z * HAVOK_SCALE - this.shape.height / 2,
    ];
    this.#watchFall();
  }

  /**
   * Falling: the highest point of the feet since leaving the ground; landing (not in water)
   * sets landedFrom to how far it fell, for this step.
   */
  #watchFall(): void {
    const z = this.#feet[2];
    this.landedFrom = undefined;
    if (this.swimming) {
      this.#fallTop = undefined;
    } else if (!this.#grounded) {
      this.#fallTop = Math.max(this.#fallTop ?? z, z);
    } else if (this.#fallTop !== undefined) {
      this.landedFrom = Math.max(0, this.#fallTop - z);
      this.#fallTop = undefined;
    }
  }

  /**
   * The moving body (keyframed or simulated; not fixed, not an actor's) the shape stands on with
   * its centre at `center` (Havok units), if any, and the pose that body has by the end of the
   * coming step (poseAfter).
   */
  #findCarrier(
    center: RAPIER.Vector,
    predicate: (collider: RAPIER.Collider) => boolean,
    seconds: number,
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider; pose: Pose } | undefined {
    const hit = this.physics.world.castShape(
      center,
      NO_ROTATION,
      { x: 0, y: 0, z: -1 },
      this.#collider.shape,
      SKIN,
      toHavok(CARRIER_REACH),
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_FIXED,
      undefined,
      this.#collider,
      undefined,
      (collider) => predicate(collider) && !this.#otherActor(collider),
    );
    const body = hit?.collider.parent();
    if (!hit || !body || hit.normal1.z <= 0.05) return undefined;
    return { body, collider: hit.collider, pose: poseAfter(body, seconds) };
  }

  /**
   * How much of `move` (Havok units) the shape at `center` gets being carried, before something
   * other than its carrier (and the placement's other moving bodies: a lift's cage), and other
   * actors (carried as well) stops it: a lift's shaft, a wall a turning platform passes. Ground it
   * slides over (facing up) does not stop it.
   */
  #carryBlocked(
    center: RAPIER.Vector,
    move: RAPIER.Vector,
    carrier: RAPIER.Collider,
    predicate: (collider: RAPIER.Collider) => boolean,
  ): RAPIER.Vector {
    const length = Math.hypot(move.x, move.y, move.z);
    if (length < 1e-9) return move;
    const parent = carrier.parent();
    const placement = this.physics.ownerOf(carrier);
    const carried = (collider: RAPIER.Collider): boolean => {
      const body = collider.parent();
      if (!body || body.isFixed()) return false;
      if (body.handle === parent?.handle) return true;
      const owner = this.physics.ownerOf(collider);
      return (
        placement !== undefined &&
        owner?.kind === placement.kind &&
        owner.reference === placement.reference
      );
    };
    const hit = this.physics.world.castShape(
      center,
      NO_ROTATION,
      { x: move.x / length, y: move.y / length, z: move.z / length },
      this.#collider.shape,
      SKIN,
      length,
      false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.#collider,
      undefined,
      (collider) => predicate(collider) && !carried(collider) && !this.#otherActor(collider),
    );
    if (!hit || hit.normal1.z > 0.7) return move;
    const share = Math.max(0, hit.time_of_impact) / length;
    return { x: move.x * share, y: move.y * share, z: move.z * share };
  }

  /**
   * Simulated bodies that came at it in the last step (a rolling barrel, a swinging log trap)
   * push it along their way, by their speed and mass against its own (pushedSpeed); what pushed
   * it dies away (PUSH_DAMPING). Not the body it stands on, its own bodies or projectiles.
   */
  #takePushes(support: RAPIER.RigidBody | undefined, seconds: number): void {
    const decay = Math.exp(-PUSH_DAMPING * seconds);
    const pushed = this.#pushed;
    pushed[0] *= decay;
    pushed[1] *= decay;
    if (Math.hypot(pushed[0], pushed[1]) < 1) pushed.fill(0);
    if (!this.#collider.isEnabled()) return;
    const world = this.physics.world;
    const narrow = world.narrowPhase;
    const own = this.#collider.handle;
    const center = this.#body.translation();
    narrow.contactPairsWith(own, (handle) => {
      const other = world.getCollider(handle) as RAPIER.Collider | null;
      const body = other?.parent();
      if (!other || !body?.isDynamic() || body.handle === support?.handle) return;
      if (this.#ownBody(other) || this.physics.layerOf(other) === Layer.projectile) return;
      const contact: { touching: boolean; point: RAPIER.Vector | undefined } = {
        touching: false,
        point: undefined,
      };
      narrow.contactPair(own, handle, world.bodies, (manifold) => {
        for (let k = 0; k < manifold.numContacts(); k++) {
          if (manifold.contactDist(k) < PUSH_CONTACT) contact.touching = true;
        }
        if (manifold.numSolverContacts() > 0) {
          contact.point = manifold.solverContactPoint(0) ?? contact.point;
        }
      });
      if (!contact.touching) return;
      const com = body.worldCom();
      const dx = center.x - com.x;
      const dy = center.y - com.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) return;
      const nx = dx / length;
      const ny = dy / length;
      const at = contact.point ?? center;
      const v = this.physics.velocityBefore(body);
      const w = body.angvel();
      const rx = at.x - com.x;
      const ry = at.y - com.y;
      const rz = at.z - com.z;
      const closing =
        ((v.x + w.y * rz - w.z * ry) * nx + (v.y + w.z * rx - w.x * rz) * ny) * HAVOK_SCALE;
      const speed = pushedSpeed(closing, body.mass(), this.mass);
      const along = pushed[0] * nx + pushed[1] * ny;
      if (speed > along) {
        pushed[0] += (speed - along) * nx;
        pushed[1] += (speed - along) * ny;
      }
    });
  }

  /**
   * A simulated body it walks into is pushed along its way into it, at the contact, by the
   * engine's rule (pushFactor, pushImpulse); bodies held still, fixed or keyframed are not.
   */
  #push(collision: RAPIER.CharacterCollision, desired: RAPIER.Vector, seconds: number): void {
    const collider = collision.collider;
    const body = collider?.parent();
    if (!collider || !body?.isDynamic()) return;
    const factor = pushFactor(
      this.physics.layerOf(collider),
      body.mass(),
      this.settings.moveLimitMass ?? MOVE_LIMIT_MASS,
    );
    if (factor <= 0) return;
    const n = collision.normal1;
    const direction: Vec3 = [-n.x, -n.y, -n.z];
    const at = collision.witness1;
    const com = body.worldCom();
    const v = body.linvel();
    const w = body.angvel();
    const r = [at.x - com.x, at.y - com.y, at.z - com.z] as const;
    const pointVelocity: Vec3 = [
      v.x + w.y * r[2] - w.z * r[1],
      v.y + w.z * r[0] - w.x * r[2],
      v.z + w.x * r[1] - w.y * r[0],
    ];
    const impulse = pushImpulse(
      [desired.x / seconds, desired.y / seconds, desired.z / seconds],
      pointVelocity,
      direction,
      body.mass(),
      factor,
    );
    if (impulse <= 0) return;
    body.applyImpulseAtPoint(
      { x: direction[0] * impulse, y: direction[1] * impulse, z: direction[2] * impulse },
      at,
      true,
    );
  }

  free(): void {
    this.physics.unregister(this.#collider);
    this.physics.world.removeCharacterController(this.#controller);
    this.physics.world.removeRigidBody(this.#body);
  }
}
