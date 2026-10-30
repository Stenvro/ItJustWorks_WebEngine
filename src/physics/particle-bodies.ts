// Mesh particles' rigid bodies in the physics world (BSPSysHavokUpdateModifier: the dragon
// crash's rocks). Observed in the original: as a mesh particle is born, the modifier puts a copy
// of its node, with the node's rigid body, into the scene's physics world at the particle's
// place, sets the body's linear velocity to the particle's (game units to Havok units) and its
// angular velocity to the particle's rotation axis times its rotation speed; from then on each
// update the node follows its body, which collides with the world's shapes and the other
// bodies by their layers like any simulated body. When the particle dies its node and body leave
// the world. Notes: docs/formats/nif.md ("Particles").

import type { CollisionData } from './collision-data.ts';
import type { PhysicsOwner, PhysicsWorld, PlacedCollision } from './physics-world.ts';
import type { Mat4, Vec3 } from '../render/math.ts';
import type { ParticleBodies } from '../render/particle-sim.ts';

/** The bodies belong to no reference (no activation, no script sees them). */
const OWNER: PhysicsOwner = { reference: 0, kind: 'object' };

/**
 * Seconds a body stays in the world without its system asking where it is: a system that
 * stopped updating (unloaded, out of range) leaves its bodies behind otherwise.
 */
export const PARTICLE_BODY_TIMEOUT = 2;

export class PhysicsParticleBodies implements ParticleBodies {
  readonly #physics: PhysicsWorld;
  readonly #clock: () => number;
  readonly #placed = new Map<number, { readonly placed: PlacedCollision; seen: number }>();
  #next = 1;
  #swept = 0;

  /** `clock`: seconds (real time), for the bodies left behind. */
  constructor(physics: PhysicsWorld, clock: () => number = () => performance.now() / 1000) {
    this.#physics = physics;
    this.#clock = clock;
  }

  /** Bodies in the world. */
  get size(): number {
    return this.#placed.size;
  }

  add(collision: CollisionData, world: Mat4, linear: Vec3, angular: Vec3): number | undefined {
    if (!collision.bodies.some((body) => body.motion === 'dynamic' && !body.phantom)) {
      return undefined;
    }
    this.#sweep();
    // Placed awake: not left to settle (the warm start) nor held until touched.
    const placed = this.#physics.addObject(collision, world, OWNER, false);
    this.#physics.setVelocity(placed, linear, angular);
    const handle = this.#next++;
    this.#placed.set(handle, { placed, seen: this.#clock() });
    return handle;
  }

  pose(handle: number, out: Mat4): boolean {
    const entry = this.#placed.get(handle);
    if (!entry) return false;
    entry.seen = this.#clock();
    this.#sweep();
    return entry.placed.placement(out);
  }

  remove(handle: number): void {
    const entry = this.#placed.get(handle);
    if (!entry) return;
    this.#placed.delete(handle);
    this.#physics.remove(entry.placed);
  }

  /** Takes every body out of the world (the world closes). */
  clear(): void {
    for (const handle of [...this.#placed.keys()]) this.remove(handle);
  }

  /** Bodies no system asked for in PARTICLE_BODY_TIMEOUT seconds leave the world. */
  #sweep(): void {
    const now = this.#clock();
    if (now - this.#swept < PARTICLE_BODY_TIMEOUT / 2) return;
    this.#swept = now;
    for (const [handle, entry] of this.#placed) {
      if (now - entry.seen > PARTICLE_BODY_TIMEOUT) this.remove(handle);
    }
  }
}
