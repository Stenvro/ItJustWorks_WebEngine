// Vehicles (docs/ai.md, "Followers, mounts and vehicles"): the carts a horse pulls and the
// actors that ride on them (Actor.SetVehicle). Platform-independent.
//
// A cart is tethered to its horse (ObjectReference.TetherToHorse) and pulled along behind it.
// The opening's prisoner carriage (PrisonerCarriage01.nif) is a wagon: its model's origin is
// the pivot of its front axle on the ground, where the FrontBar body (the shafts and the front
// wheels) turns about the vertical within its limited hinge (±40°); its rear wheels turn on an
// axle 214.85 units behind. Pulled, the front pivot trails the horse at the shafts' length and
// the rear axle trails the front pivot: the body turns towards the shafts as a trailer does.
// TODO(M13): the engine pulls the cart's simulated bodies by a constraint to the horse; here
// they are keyframed along this geometry.
//
// An actor riding a vehicle stands at the vehicle's root (its position and rotation): the
// riding idles are made in the vehicle's frame (IdleCartPrisonerASway seats the actor's pelvis
// 200 units behind and 139 above the cart's origin, the driver's 11 behind it), and an exit
// idle's root motion takes it from there (CartPrisonerAExit: 380 units out of the back).

type Vec3 = readonly [number, number, number];

/** A vehicle's place: its root, its compass heading and its pitch (radians, nose up). */
export interface VehiclePose {
  readonly position: Vec3;
  readonly heading: number;
  readonly pitch: number;
}

/** What towing needs of a wagon's model. */
export interface WagonGeometry {
  /** The horse's root ahead of the front pivot along the shafts (units). */
  readonly tether: number;
  /** The rear axle behind the front pivot (units). */
  readonly wheelbase: number;
  /** The front axle turns at most this far from the body (radians). */
  readonly maxSteer: number;
  /** The wheels' radii (units): they turn by the way they roll. */
  readonly frontWheelRadius: number;
  readonly rearWheelRadius: number;
}

/**
 * The opening's prisoner carriage: its rear axle 214.85 behind the pivot (the rear wheels'
 * nodes), the FrontBar's limited hinge ±0.698 rad, wheels of 49.5 and 59.4 units (their shapes'
 * bounds). The tether: the first cart's horse stands 210.6 units from its pivot in the editor
 * (MQ101Cart1HorseREF to MQ101Cart1Ref), hitched. TODO(M13): the engine's tether frame.
 */
export const PRISONER_CARRIAGE: WagonGeometry = {
  tether: 210.6,
  wheelbase: 214.85,
  maxSteer: 0.698,
  frontWheelRadius: 49.5,
  rearWheelRadius: 59.4,
};

/** A wagon being towed: where its axles are, how its front axle is turned, its wheels. */
export interface WagonState {
  /** The front pivot (the model's origin), on the ground. */
  readonly front: Vec3;
  /** The middle of the rear axle, on the ground. */
  readonly rear: Vec3;
  /** The front axle's turn from the body (radians, clockwise as the compass). */
  readonly steer: number;
  /** How far the wheels have turned (radians, forward positive). */
  readonly frontSpin: number;
  readonly rearSpin: number;
}

/** The ground's height under a point, if known (the shell's ray down). */
export type GroundAt = (x: number, y: number, z: number) => number | undefined;

const forwardOf = (heading: number): [number, number] => [Math.sin(heading), Math.cos(heading)];

const angleBetween = (from: number, to: number): number => {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
};

/** A wagon's state where it stands (its wheels as they are). */
export function wagonAt(pose: VehiclePose, geometry: WagonGeometry): WagonState {
  const [fx, fy] = forwardOf(pose.heading);
  const [x, y, z] = pose.position;
  const drop = Math.sin(pose.pitch) * geometry.wheelbase;
  return {
    front: [x, y, z],
    rear: [
      x - fx * geometry.wheelbase * Math.cos(pose.pitch),
      y - fy * geometry.wheelbase * Math.cos(pose.pitch),
      z - drop,
    ],
    steer: 0,
    frontSpin: 0,
    rearSpin: 0,
  };
}

/** A wagon's pose: its root at the front pivot, heading from the rear axle to it. */
export function wagonPose(state: WagonState): VehiclePose {
  const dx = state.front[0] - state.rear[0];
  const dy = state.front[1] - state.rear[1];
  const dz = state.front[2] - state.rear[2];
  return {
    position: state.front,
    heading: Math.atan2(dx, dy),
    pitch: Math.atan2(dz, Math.hypot(dx, dy)),
  };
}

/**
 * Where a tethered horse stands for a wagon: if it is already within the shafts' reach (its
 * root at most the tether from the pivot, within the front axle's turn), where it is; else the
 * tether ahead of the pivot on the wagon's heading, facing it. The opening's second cart stands
 * 411 units behind its horse in the editor: tethered, the horse comes to it (its passengers
 * were placed at the cart, not at the horse). TODO(M13): the engine's TetherToHorse.
 */
export function tetherPlace(
  wagon: VehiclePose,
  horse: { readonly position: Vec3; readonly heading: number },
  geometry: WagonGeometry,
): { position: Vec3; heading: number; moved: boolean } {
  const dx = horse.position[0] - wagon.position[0];
  const dy = horse.position[1] - wagon.position[1];
  const distance = Math.hypot(dx, dy);
  const turn = Math.abs(angleBetween(wagon.heading, Math.atan2(dx, dy)));
  if (Math.abs(distance - geometry.tether) <= geometry.tether * 0.1 && turn <= geometry.maxSteer) {
    return { position: horse.position, heading: horse.heading, moved: false };
  }
  const [fx, fy] = forwardOf(wagon.heading);
  return {
    position: [
      wagon.position[0] + fx * geometry.tether,
      wagon.position[1] + fy * geometry.tether,
      horse.position[2],
    ],
    heading: wagon.heading,
    moved: true,
  };
}

/**
 * A point trailing another at a length: on the line from where it was to the leader, on the
 * ground there (where no ground is known, at the leader's height).
 */
function trail(
  from: Vec3,
  leader: Vec3,
  length: number,
  ground: GroundAt | undefined,
): [number, number, number] {
  const dx = leader[0] - from[0];
  const dy = leader[1] - from[1];
  const distance = Math.hypot(dx, dy);
  const x = distance > 1e-6 ? leader[0] - (dx / distance) * length : from[0];
  const y = distance > 1e-6 ? leader[1] - (dy / distance) * length : from[1];
  return [x, y, ground?.(x, y, Math.max(from[2], leader[2])) ?? leader[2]];
}

/**
 * One step of towing: the horse's root is at `horse` now. The front pivot trails it at the
 * tether's length, the rear axle the front pivot at the wheelbase (each on the line from where
 * it was to what pulls it, on the ground there); the front axle turns towards the horse
 * (within its hinge's limit), the wheels by the way they rolled.
 */
export function tow(
  state: WagonState,
  horse: Vec3,
  geometry: WagonGeometry,
  ground?: GroundAt,
): WagonState {
  const front = trail(state.front, horse, geometry.tether, ground);
  const rear = trail(state.rear, front, geometry.wheelbase, ground);
  const body = Math.atan2(front[0] - rear[0], front[1] - rear[1]);
  const shafts = Math.atan2(horse[0] - front[0], horse[1] - front[1]);
  const steer = Math.max(
    -geometry.maxSteer,
    Math.min(geometry.maxSteer, angleBetween(body, shafts)),
  );
  // Rolled forward (along the body) or back.
  const [bx, by] = forwardOf(body);
  const rolled = (from: Vec3, to: Vec3): number => (to[0] - from[0]) * bx + (to[1] - from[1]) * by;
  return {
    front,
    rear,
    steer,
    frontSpin: state.frontSpin + rolled(state.front, front) / geometry.frontWheelRadius,
    rearSpin: state.rearSpin + rolled(state.rear, rear) / geometry.rearWheelRadius,
  };
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
