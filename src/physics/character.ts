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
 * The 18 points of the controller shape (game units, centred on the shape's middle): rings at
 * a radius's height above the bottom and below the top. The points are inset by the shell, so
 * that the shape with its shell is the bound's size (as Havok shapes are built: the convex
 * radius shrinks the vertices), in width as in height.
 */
export function controllerPoints(shape: CharacterShape): Float32Array {
  const half = shape.height / 2 - CONTROLLER_SHELL;
  const radius = Math.max(0, shape.radius - CONTROLLER_SHELL);
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
}

/** Gap the controller keeps to surfaces (Havok units). */
const SKIN = 0.01;

const toHavok = (v: number): number => v / HAVOK_SCALE;

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
  /**
   * Swimming: no gravity; the owner sets the vertical speed (floating at the surface,
   * diving and rising).
   */
  swimming = false;
  /** Standing on something too steep to walk on (sliding off). */
  #unsupported = false;
  /** Something below the shape touched it in the last step (ground, a slope, a step). */
  #below = false;

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
    controller.setApplyImpulsesToDynamicBodies(true);
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
    this.#body.setTranslation(this.#center(feet), true);
    this.#body.setNextKinematicTranslation(this.#center(feet));
  }

  /** Jumps with this upward speed (game units per second) at the next step, if grounded. */
  jump(speed: number): boolean {
    if (!this.#grounded) return false;
    this.#jumpSpeed = speed;
    return true;
  }

  /** One fixed step: gravity, the wanted movement, sliding and stepping. Before world.step. */
  step(seconds: number): void {
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
    const desired = {
      x: toHavok(this.velocity[0] * seconds),
      y: toHavok(this.velocity[1] * seconds),
      z: toHavok(this.verticalSpeed * seconds),
    };
    // On stairs (surfaces of a stair material) whole steps are climbed; elsewhere only what
    // the shape's lower cone rides over.
    const stairs = this.touched.some((collider) =>
      this.settings.stairMaterials.has(this.physics.materialOf(collider)),
    );
    if (stairs) {
      this.#controller.enableAutostep(
        toHavok(this.settings.stairHeight),
        toHavok(this.shape.radius / 2),
        false,
      );
    } else {
      this.#controller.disableAutostep();
    }
    const own = this.#collider;
    const filter = this.physics.filterFor(Layer.charController);
    this.#controller.computeColliderMovement(
      own,
      desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      (collider) => collider.handle !== own.handle && filter(collider),
    );
    const moved = this.#controller.computedMovement();
    const rising = this.verticalSpeed > 0;
    this.#grounded = !this.swimming && !rising && this.#controller.computedGrounded();
    // Touching something below that is not walkable ground: sliding off it.
    this.touched.length = 0;
    let below = false;
    for (let i = 0; i < this.#controller.numComputedCollisions(); i++) {
      const collision = this.#controller.computedCollision(i);
      if (!collision?.collider) continue;
      this.touched.push(collision.collider);
      // normal1: the surface touched, facing the character (up for ground below).
      if (collision.normal1.z > 0.05) below = true;
    }
    this.#unsupported = !this.#grounded && !this.swimming && below;
    this.#below = below;
    // A ceiling stops the rise; the ground stops the fall.
    if (rising && moved.z < desired.z * 0.5) this.verticalSpeed = 0;
    if (this.#grounded && this.verticalSpeed < 0) this.verticalSpeed = 0;
    const current = this.#body.translation();
    const next = { x: current.x + moved.x, y: current.y + moved.y, z: current.z + moved.z };
    this.#body.setNextKinematicTranslation(next);
    this.#previous = this.#feet;
    this.#feet = [
      next.x * HAVOK_SCALE,
      next.y * HAVOK_SCALE,
      next.z * HAVOK_SCALE - this.shape.height / 2,
    ];
  }

  free(): void {
    this.physics.unregister(this.#collider);
    this.physics.world.removeCharacterController(this.#controller);
    this.physics.world.removeRigidBody(this.#body);
  }
}
