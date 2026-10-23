// Vehicles (docs/ai.md, "Vehicles"): the carts a horse pulls and the actors that ride them
// (Actor.SetVehicle). The rules as read from the engine; the shell applies them
// (src/shell/actor-vehicles.ts). Platform-independent.
//
// TetherToHorse puts the horse fHorseOffsetY:Cart ahead of the cart and joins the two: a
// keyframed body that follows the horse's spine (sHorseConnect:Cart) pulls the cart's FrontBar
// (its shafts and front axle) by a prismatic joint, turning it as the spine turns and letting it
// slide a little up and down (src/ai/cart-tether.ts; here its pitch and roll are the wheels').
// Everything else is simulated: the cart's body hangs on the FrontBar by its own limited hinge,
// the wheels on their hinges roll on the ground. The spine is followed smoothly: eased between
// the horse's animation updates and leaning as the horse leans, eased. The cart's pole turns to
// point at the horse, and the horse's harness bones hang on the pole, so the harness reaches
// from the horse to the cart.
//
// A rider's root is the vehicle's root body (where it is and how it is turned): its riding idles
// seat it in the vehicle's frame (CartPrisonerASway puts the pelvis 200 units behind and 139
// above the cart's origin). The animation's own movement does not move it there. Its exit idle
// lets go of the vehicle (ExitCartBegin) and moves it out by its root motion; ExitCartEnd ends
// the ride (SetVehicle None).

import { HAVOK_SCALE } from '../physics/collision-data.ts';

type Vec3 = readonly [number, number, number];

/** The [Cart] settings the tether reads (src/world/ini-settings.ts has their defaults). */
export interface CartSettings {
  /** The horse ahead of the cart's origin as it is hitched (game units, the cart's frame). */
  readonly horseOffset: Vec3;
  /** The joint's point on the FrontBar body and on the horse's spine (Havok units). */
  readonly cartPivot: Vec3;
  readonly horsePivot: Vec3;
  /** The slide axis's tilt from the FrontBar's up and from the spine's y (degrees). */
  readonly cartRot1: number;
  readonly cartRot2: number;
  /** How far the FrontBar slides along it (Havok units). */
  readonly limitMin: number;
  readonly limitMax: number;
  /** Every simulated body of the cart weighs this (kg). */
  readonly mass: number;
  /** The wheels' friction and angular damping; gravity pulls them this much more. */
  readonly wheelFriction: number;
  readonly wheelAngularDamping: number;
  readonly wheelGravity: number;
  /** The angular impulse that rights a cart tipping over (Havok units). */
  readonly tipImpulse: number;
  /** The harness bones on the pole: ±x, y, z (game units, the pole's frame). */
  readonly tetherOffset: Vec3;
  /** The pole points at the horse's spine this much higher (game units). */
  readonly poleZOffset: number;
}

/** A place and its turn (radians: x, y, z as a reference's angles). */
export interface Placement {
  readonly position: Vec3;
  readonly rotation: Vec3;
}

/**
 * TetherToHorse: where the horse goes. Turned as the cart is, its offset from the cart's origin
 * turned by the cart's heading; it keeps its own height (raised by the offset's z).
 */
export function hitchPlace(cart: Placement, horseZ: number, settings: CartSettings): Placement {
  const heading = cart.rotation[2];
  const [ox, oy, oz] = settings.horseOffset;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  return {
    position: [
      cart.position[0] + ox * cos + oy * sin,
      cart.position[1] - ox * sin + oy * cos,
      horseZ + oz,
    ],
    rotation: [...cart.rotation],
  };
}

/** A joint's frame on one body: its point and its axes (slide axis, a perpendicular, their cross). */
export interface TetherFrame {
  readonly pivot: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * The tether's prismatic joint in game units: on the FrontBar body its pivot and the slide axis
 * (its up, tilted forward by fCartRot1:Cart about its x), on the hitch (the horse's spine) its
 * pivot and the same axis (the spine's y, tilted by fCartRot2:Cart about its x); x is
 * perpendicular to both. The limits are the slide's.
 */
export function tetherJoint(settings: CartSettings): {
  readonly a: TetherFrame;
  readonly b: TetherFrame;
  readonly minDistance: number;
  readonly maxDistance: number;
} {
  const r1 = (settings.cartRot1 * Math.PI) / 180;
  const r2 = (settings.cartRot2 * Math.PI) / 180;
  const perp: Vec3 = [1, 0, 0];
  const axisA: Vec3 = [0, -Math.sin(r1), Math.cos(r1)];
  const axisB: Vec3 = [0, Math.cos(r2), Math.sin(r2)];
  const game = (v: Vec3): Vec3 => [v[0] * HAVOK_SCALE, v[1] * HAVOK_SCALE, v[2] * HAVOK_SCALE];
  return {
    a: { pivot: game(settings.cartPivot), axes: [axisA, perp, cross(axisA, perp)] },
    b: { pivot: game(settings.horsePivot), axes: [axisB, perp, cross(axisB, perp)] },
    minDistance: settings.limitMin * HAVOK_SCALE,
    maxDistance: settings.limitMax * HAVOK_SCALE,
  };
}

/**
 * How the tether holds the FrontBar's turn about the slide axis (the cart's heading) against the
 * spine: a spring back to the joint's frame (accelerations: stiffness 1/s², damping 1/s; about 3
 * a second, nearly critically damped). The engine's prismatic joint holds all three turns
 * outright; held so here (Rapier's joints do not give way as Havok's solver does) the cart was
 * thrown when the horse turned on the spot at the hairpin of Helgen's road, and the FrontBar's
 * pitch and roll are left to the wheels (src/ai/cart-tether.ts). TODO(M13): how far Havok's
 * solver lets the held turn give is not known.
 */
export const TETHER_TURN_SPRING = { stiffness: 400, damping: 32 } as const;

/**
 * How fast the tether's frame leans with the horse (seconds: the time constant of its easing
 * towards the horse's drawn lean). The engine's tether follows the spine node of the horse's
 * 3D, which leans with the ground (RACE "tilt front/back"); the horse here leans with the
 * ground's normal under it at once (a triangle's: it jumps from one to the next), which, held
 * by the tether, shook the cart. TODO(M13): the engine's character controller eases its pitch
 * and roll (bhkCharacterController's pitch timer and angles); its rate is not read.
 */
export const TETHER_LEAN_EASE = 0.3;

/** `previous` (a unit vector) eased towards `target` over `seconds` (time constant `ease`). */
export function easeTowards(
  previous: Vec3 | undefined,
  target: Vec3,
  seconds: number,
  ease: number,
): Vec3 {
  if (!previous) return target;
  const share = 1 - Math.exp(-seconds / ease);
  const v: Vec3 = [
    previous[0] + (target[0] - previous[0]) * share,
    previous[1] + (target[1] - previous[1]) * share,
    previous[2] + (target[2] - previous[2]) * share,
  ];
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * An actor's root as it leans: at its feet, its up `lean` (a unit vector), its forward its
 * heading's made square to that, scaled (column-major).
 */
export function leaningRoot(feet: Vec3, heading: number, lean: Vec3, scale: number): Float32Array {
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  const along = fx * lean[0] + fy * lean[1];
  const f: Vec3 = [fx - lean[0] * along, fy - lean[1] * along, -lean[2] * along];
  const length = Math.hypot(f[0], f[1], f[2]) || 1;
  const forward: Vec3 = [f[0] / length, f[1] / length, f[2] / length];
  const right = cross(forward, lean);
  return Float32Array.of(
    right[0] * scale,
    right[1] * scale,
    right[2] * scale,
    0,
    forward[0] * scale,
    forward[1] * scale,
    forward[2] * scale,
    0,
    lean[0] * scale,
    lean[1] * scale,
    lean[2] * scale,
    0,
    feet[0],
    feet[1],
    feet[2],
    1,
  );
}

/** A pose's matrix (column-major, 16 numbers). */
type Matrix = ArrayLike<number>;

/**
 * Between two rigid poses: the translation lerped, each axis lerped and made orthonormal again
 * (the poses are close: a step, an animation update).
 */
export function blendPose(a: Matrix, b: Matrix, t: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = (a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t;
  const scaleOf = (m: Matrix): number => Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0);
  const scale = scaleOf(a) + (scaleOf(b) - scaleOf(a)) * t || 1;
  const axis = (k: number): Vec3 => [out[k * 4] ?? 0, out[k * 4 + 1] ?? 0, out[k * 4 + 2] ?? 0];
  const norm = (v: Vec3): Vec3 => {
    const length = Math.hypot(...v) || 1;
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const y = norm(axis(1));
  const z0 = axis(2);
  const along = z0[0] * y[0] + z0[1] * y[1] + z0[2] * y[2];
  const z = norm([z0[0] - along * y[0], z0[1] - along * y[1], z0[2] - along * y[2]]);
  const x = cross(y, z);
  out.set([x[0] * scale, x[1] * scale, x[2] * scale, 0], 0);
  out.set([y[0] * scale, y[1] * scale, y[2] * scale, 0], 4);
  out.set([z[0] * scale, z[1] * scale, z[2] * scale, 0], 8);
  out[15] = 1;
  return out;
}

/** The longest an animation update is eased over (seconds; the slowest actors' interval). */
const POSE_EASE_MAX = 0.25;

/**
 * A node of an actor's pose followed smoothly: each new pose (the animation moved the skeleton:
 * every frame near the camera, less often far away or unseen) is eased into over the time the
 * last one took, from where it was shown, as the engine interpolates an actor's pose between
 * its graph's updates (src/animation/animated-skeleton.ts animationInterval); also over the
 * physics steps of one frame. The tether's keyframed body follows the horse's spine so: it
 * jumped at every update (ten a second for a horse behind the camera) and shook the cart.
 */
export class PoseEasing {
  #from: Float32Array | undefined;
  #to: Float32Array | undefined;
  #shown: Float32Array | undefined;
  /** Since the last new pose, and the time it is eased over (seconds). */
  #since = 0;
  #over = 0;

  /** The node as shown after `seconds` more, its pose now `target` (model space). */
  step(target: Matrix, seconds: number): Float32Array {
    const to = this.#to;
    let changed = !to;
    for (let i = 0; i < 16 && !changed; i++) changed = (to?.[i] ?? 0) !== (target[i] ?? 0);
    if (changed) {
      this.#from = this.#shown ?? Float32Array.from(target);
      this.#to = Float32Array.from(target);
      this.#over = Math.min(POSE_EASE_MAX, Math.max(seconds, this.#since));
      this.#since = 0;
    }
    this.#since += seconds;
    const t = this.#over > 0 ? Math.min(1, this.#since / this.#over) : 1;
    this.#shown = blendPose(this.#from ?? target, this.#to ?? target, t);
    return this.#shown;
  }
}

/**
 * The pole's turn in its parent's frame: the shortest turn that takes its length (+y) to point
 * from where it hangs (`origin`) at `target` (both in its parent's frame), as a 3x3 matrix
 * (column-major: the turned x, y and z axes).
 */
export function poleTurn(origin: Vec3, target: Vec3): number[] {
  let dx = target[0] - origin[0];
  let dy = target[1] - origin[1];
  let dz = target[2] - origin[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  dx /= length;
  dy /= length;
  dz /= length;
  // The quaternion from +y to d: axis y × d, angle between them.
  let qx = dz;
  let qy = 0;
  let qz = -dx;
  let qw = 1 + dy;
  if (qw < 1e-6) {
    // Straight back: half a turn about z.
    qx = 0;
    qy = 0;
    qz = 1;
    qw = 0;
  }
  const n = Math.hypot(qx, qy, qz, qw);
  qx /= n;
  qy /= n;
  qz /= n;
  qw /= n;
  return [
    1 - 2 * (qy * qy + qz * qz),
    2 * (qx * qy + qz * qw),
    2 * (qx * qz - qy * qw),
    2 * (qx * qy - qz * qw),
    1 - 2 * (qx * qx + qz * qz),
    2 * (qy * qz + qx * qw),
    2 * (qx * qz + qy * qw),
    2 * (qy * qz - qx * qw),
    1 - 2 * (qx * qx + qy * qy),
  ];
}

/** A cart's body leans over this far sideways (its up's sideways share) before it is righted. */
const TIP_LEAN = 0.71;

/**
 * The tilt prevention on a tethered cart's body (the engine's action, observed in the original): the
 * world's up seen from the body; where it leans more than TIP_LEAN towards the body's side (the
 * body's right axis rises or sinks that far: `rightZ`, its world z) or the body's up points
 * down (`upZ`), an angular impulse of fTipImpulse:Cart about the body's forward axis (Havok
 * units), positive while its right side is up: it turns that side down. Undefined while it
 * stands.
 */
export function tipImpulse(
  rightZ: number,
  upZ: number,
  settings: CartSettings,
): number | undefined {
  if (Math.abs(rightZ) <= TIP_LEAN && upZ >= 0) return undefined;
  return rightZ > 0 ? settings.tipImpulse : -settings.tipImpulse;
}

/** A vehicle's place: its root, its compass heading and its pitch (radians, nose up). */
export interface VehiclePose {
  readonly position: Vec3;
  readonly heading: number;
  readonly pitch: number;
}

/** A place in a vehicle's frame: an offset (x right, y forward, z up) and a heading against it. */
export interface VehicleOffset {
  readonly position: Vec3;
  readonly heading: number;
}

/** At the vehicle's root (a rider as SetVehicle puts it there). */
export const AT_ROOT: VehicleOffset = { position: [0, 0, 0], heading: 0 };

/**
 * Where something at an offset in a vehicle's frame is in the world: the offset turned by the
 * vehicle's pitch (about its right) and heading, from its root; its heading the vehicle's plus
 * its own.
 */
export function inVehicle(
  pose: VehiclePose,
  offset: VehicleOffset,
): { position: [number, number, number]; heading: number } {
  const [ox, oy, oz] = offset.position;
  // Pitched about the right axis: forward rises, up leans back.
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const forward = oy * cp - oz * sp;
  const up = oy * sp + oz * cp;
  const sin = Math.sin(pose.heading);
  const cos = Math.cos(pose.heading);
  // Right is (cos, −sin), forward (sin, cos) of the compass heading.
  return {
    position: [
      pose.position[0] + ox * cos + forward * sin,
      pose.position[1] - ox * sin + forward * cos,
      pose.position[2] + up,
    ],
    heading: pose.heading + offset.heading,
  };
}

/**
 * An offset moved by an animation's root motion (in the rider's own frame: x right, y forward;
 * the turn counter-clockwise), as an exit idle takes a rider out of the cart.
 */
export function movedBy(
  offset: VehicleOffset,
  motion: { readonly translation: readonly [number, number, number]; readonly yaw: number },
): VehicleOffset {
  const [mx, my, mz] = motion.translation;
  const sin = Math.sin(offset.heading);
  const cos = Math.cos(offset.heading);
  return {
    position: [
      offset.position[0] + mx * cos + my * sin,
      offset.position[1] - mx * sin + my * cos,
      offset.position[2] + mz,
    ],
    heading: offset.heading - motion.yaw,
  };
}

/**
 * What a rider's graph event does to its ride: ExitCartBegin lets go of the vehicle (its exit's
 * root motion moves it from there), NPCDetach too; ExitCartEnd ends the ride.
 */
export function riderEvent(event: string): 'detach' | 'end' | undefined {
  switch (event.toLowerCase()) {
    case 'exitcartbegin':
    case 'npcdetach':
      return 'detach';
    case 'exitcartend':
      return 'end';
    default:
      return undefined;
  }
}
