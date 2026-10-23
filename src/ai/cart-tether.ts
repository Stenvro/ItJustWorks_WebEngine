// A cart tethered to its horse in the physics world (docs/ai.md "Vehicles"): the engine's
// TetherToHorse as it sets up the cart's Havok bodies (observed in the original), the actions on its wheels
// and body, and the keyframed body on the horse's spine that pulls the FrontBar. The shell
// (src/shell/actor-vehicles.ts) moves the spine every physics step; tools/cart-ride.ts drives a
// cart over the opening's road in Node. Platform-independent (Rapier runs in Node too).

import type { Mat4, Vec3 } from '../render/math.ts';
import {
  GRAVITY,
  type Hitch,
  type PhysicsWorld,
  type PlacedBody,
  type PlacedCollision,
} from '../physics/physics-world.ts';
import { tetherJoint, tipImpulse, TETHER_TURN_SPRING, type CartSettings } from './vehicles.ts';

/** The bodies the engine treats as a cart's wheels. */
const CART_WHEELS = new Set([
  'wheelbackleft',
  'wheelbackright',
  'wheelfrontleft',
  'wheelfrontright',
]);
/** The body a cart's tether pulls (its shafts and front axle). */
const FRONT_BAR = 'frontbar';
/** The wheels' linear damping and the FrontBar's damping, as the engine sets them. */
const WHEEL_LINEAR_DAMPING = 0.005;
const FRONT_BAR_DAMPING = 0.01;
/** The wheel action pulls with this gravity (m/s²) times fGravMult:Cart. */
const WHEEL_ACTION_GRAVITY = 9.81;

/** A cart pulled by its horse: its bodies simulated, its FrontBar on the hitch. */
export class CartTether {
  readonly hitch: Hitch;
  /** The cart's body (the model's root: the tilt prevention acts on it). */
  readonly root: PlacedBody;
  readonly frontBar: PlacedBody;
  readonly #settings: CartSettings;

  private constructor(
    hitch: Hitch,
    root: PlacedBody,
    frontBar: PlacedBody,
    settings: CartSettings,
  ) {
    this.hitch = hitch;
    this.root = root;
    this.frontBar = frontBar;
    this.#settings = settings;
  }

  /**
   * TetherToHorse in the physics world: the cart's bodies simulated and set up as the engine
   * does, its FrontBar joined to a keyframed body at the horse's spine (`spine`: the spine's
   * world matrix now, game units; `spineRest`: its rest matrix in the horse's model, the joint's
   * frame). Undefined for a model without a FrontBar.
   */
  static tether(
    physics: PhysicsWorld,
    collision: PlacedCollision,
    root: PlacedBody,
    spine: Mat4,
    spineRest: Mat4,
    settings: CartSettings,
  ): CartTether | undefined {
    const frontBar = collision.bodies.find((body) => body.data.node.toLowerCase() === FRONT_BAR);
    if (!frontBar) return undefined;
    physics.setMotion(collision, false);
    // The cart stood settled on its wheels in the engine before its tether (its cell's warm
    // start); here it waited where it was placed, a little above or in the ground: for its first
    // half second it is only moved out of what it overlaps, not thrown (PhysicsWorld.settle).
    physics.settle(collision);
    // Every body weighs fMass:Cart. Havok's setMass leaves the inertia as authored (the
    // carriage's, for its 12,000 kg body); there the tether holds the body's pitch and roll to
    // the spine, here the wheels do (below), and a body that slow to turn followed them late (it
    // rocked 40% more on the opening's road): its inertia is scaled with its mass.
    for (const placed of collision.bodies) {
      const name = placed.data.node.toLowerCase();
      const wheel = CART_WHEELS.has(name);
      physics.tuneBody(collision, placed, {
        mass: settings.mass,
        ...(wheel && {
          friction: settings.wheelFriction,
          angularDamping: settings.wheelAngularDamping,
          linearDamping: WHEEL_LINEAR_DAMPING,
          // The wheel action: a force of fGravMult:Cart times 9.81 m/s² down on its mass.
          gravityScale: 1 + (settings.wheelGravity * WHEEL_ACTION_GRAVITY) / GRAVITY,
          // Its allowed penetration is 0.3 (21 units): it is swept only past that in a step.
          swept: false,
        }),
        ...(name === FRONT_BAR && {
          angularDamping: FRONT_BAR_DAMPING,
          linearDamping: FRONT_BAR_DAMPING,
        }),
      });
    }
    // The joint's frame on the spine: the FrontBar's axes as they stand when the cart is turned
    // as the horse and the spine is at rest (the horse is put in the shafts turned as the cart).
    // TODO(M13): the engine gives the spine's axis as its y turned by fCartRot2:Cart; read so
    // in our skeleton (the spine's y points down) the cart would be upside down.
    const joint = tetherJoint(settings);
    const fromRest = (v: Vec3): Vec3 => {
      const along = (k: number): number => {
        const length =
          Math.hypot(spineRest[k * 4] ?? 0, spineRest[k * 4 + 1] ?? 0, spineRest[k * 4 + 2] ?? 0) ||
          1;
        return (
          ((spineRest[k * 4] ?? 0) * v[0] +
            (spineRest[k * 4 + 1] ?? 0) * v[1] +
            (spineRest[k * 4 + 2] ?? 0) * v[2]) /
          length
        );
      };
      return [along(0), along(1), along(2)];
    };
    const axes = joint.a.axes;
    // The engine's prismatic joint holds all three turns. Held so in Rapier, whose joint does
    // not give way as Havok's solver does, the cart was pressed into the road or lifted off it
    // wherever the spine's lean and the road's differed (its frame, its animation, every slope)
    // and thrown off the road at the hairpin: its heading springs back to the frame
    // (TETHER_TURN_SPRING), its pitch and roll are its wheels' (docs/ai.md, "Vehicles").
    const hitch = physics.addHitch(frontBar, spine, {
      ...joint,
      turnSpring: TETHER_TURN_SPRING,
      b: { pivot: joint.b.pivot, axes: [fromRest(axes[0]), fromRest(axes[1]), fromRest(axes[2])] },
    });
    return new CartTether(hitch, root, frontBar, settings);
  }

  /**
   * Every physics step: the hitch follows the spine (`spine`: its world matrix by the end of the
   * step), and the tilt prevention rights a cart tipping over.
   */
  step(spine: Mat4): void {
    this.hitch.move(spine);
    const { x, y, z, w } = this.root.body.rotation();
    // The body's right and up axes' world z, and its forward axis.
    const rightZ = 2 * (x * z - y * w);
    const upZ = 1 - 2 * (x * x + y * y);
    const impulse = tipImpulse(rightZ, upZ, this.#settings);
    if (impulse === undefined) return;
    const forward = { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) };
    this.root.body.applyTorqueImpulse(
      { x: forward.x * impulse, y: forward.y * impulse, z: forward.z * impulse },
      true,
    );
  }

  remove(): void {
    this.hitch.remove();
  }
}
