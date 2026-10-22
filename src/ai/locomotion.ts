// How actors move (docs/ai.md, "Movement"): what an actor wants to do (a way to go, a gait, a
// heading to keep) becomes the velocity its character controller moves with and the way it
// turns, at the speeds and turn rates of its movement type (MOVT); and its movement drives its
// behavior graph as the engine's graph data channels do (CommonLibSSE: ActorSpeedChannel,
// ActorDirectionChannel, ActorTurnDeltaChannel, ...): Speed, Direction, TurnDelta, IsSprinting,
// IsSneaking and the movement events. The player's body drives its graphs the same way
// (src/shell/player-avatar.ts). Platform-independent.

import { directionalSpeed, type MovementType } from '../world/movement.ts';

export type Gait = 'walk' | 'run' | 'sprint';

/** What an actor wants to do now. */
export interface MoveRequest {
  /** The way to go (world, horizontal, any length); undefined: it stands. */
  readonly direction?: readonly [number, number] | undefined;
  readonly gait: Gait;
  /**
   * A heading to face (radians, compass: 0 along +Y, π/2 along +X): moving, it keeps facing it
   * (strafing); standing, it turns to it. Undefined: it faces the way it goes.
   */
  readonly face?: number | undefined;
}

/**
 * The movement types an actor moves by now (src/ai/movement-types.ts): walking (its walk
 * speeds), running (its run speeds) and sprinting (its run speeds; else running's).
 */
export interface MovementTypes {
  readonly walk: MovementType;
  readonly run: MovementType;
  readonly sprint?: MovementType | undefined;
}

/** One step of steering: the velocity to move with and the heading after the step. */
export interface Steering {
  readonly velocity: readonly [number, number];
  readonly heading: number;
}

/** The angle from `from` to `to`, in −π..π. */
export function angleBetween(from: number, to: number): number {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

/** A compass heading of a horizontal direction (0 along +Y, π/2 along +X). */
export function headingOf(x: number, y: number): number {
  return Math.atan2(x, y);
}

/**
 * One step of an actor that wants `request`, from `heading`: it turns towards the heading it
 * keeps (or the way it goes) at its movement type's rate (while moving, else in place: walking
 * or running), and goes the way it wants at the speed of that direction against its facing (the
 * ellipse through the four directional speeds). Not strafing, it goes where it faces: the speed
 * falls with the cosine of the turn still to make, so a turn of a right angle or more is made
 * standing (the engine's NPCs do not walk sideways out of combat).
 */
export function steer(
  request: MoveRequest,
  heading: number,
  types: MovementTypes,
  seconds: number,
): Steering {
  const type =
    request.gait === 'walk'
      ? types.walk
      : request.gait === 'sprint'
        ? (types.sprint ?? types.run)
        : types.run;
  const direction = request.direction;
  const length = direction ? Math.hypot(direction[0], direction[1]) : 0;
  const moving = direction !== undefined && length > 1e-6;
  const way = moving ? headingOf(direction[0], direction[1]) : heading;
  const target = request.face ?? (moving ? way : heading);
  const rate = moving
    ? type.rotateWhileMoving
    : request.gait === 'walk'
      ? type.rotateInPlace.walk
      : type.rotateInPlace.run;
  const turn = angleBetween(heading, target);
  const step = Math.max(0, rate) * seconds;
  const next = heading + (Math.abs(turn) <= step ? turn : Math.sign(turn) * step);
  if (!moving) return { velocity: [0, 0], heading: next };
  const speeds = request.gait === 'walk' ? type.walk : type.run;
  // The way against the facing: x right, y forward.
  const against = angleBetween(next, way);
  let speed = directionalSpeed(speeds, Math.sin(against), Math.cos(against));
  if (request.face === undefined) speed *= Math.max(0, Math.cos(against));
  return {
    velocity: [(direction[0] / length) * speed, (direction[1] / length) * speed],
    heading: next,
  };
}

/** A graph the movement drives (BehaviorRuntime). */
export interface LocomotionGraph {
  setVariable(name: string, value: number): void;
  sendEvent(name: string): boolean;
}

/** How the actor moved over the frame. */
export interface LocomotionFrame {
  /** Horizontal velocity it moved with (game units per second): its measured speed. */
  readonly velocity: readonly [number, number];
  /** Its heading now (radians, compass). */
  readonly heading: number;
  readonly seconds: number;
  readonly grounded: boolean;
  readonly swimming: boolean;
  /** Vertical speed (game units per second, up positive). */
  readonly verticalSpeed: number;
  readonly sprinting: boolean;
  readonly sneaking: boolean;
  /**
   * It wants to move, though its graph holds it where it is (an animation-driven idle): it is
   * told it moves (moveStart), which ends such an idle.
   */
  readonly settingOut?: boolean;
}

/** Speeds below this are standing (game units per second). */
const MOVING_SPEED = 5;

/**
 * A change of Direction by more than this (of the whole turn, 0..1) went the short way round
 * across 0: the cyclic blends cross-fade it. TODO(M13): the engine's own test is not
 * documented.
 */
const DIRECTION_WRAP = 0.5;

/**
 * Movement this near the facing (of the whole turn: 7.2°) is straight ahead, Direction 0. A
 * controller's steps stray a little from its heading as it goes (sliding along what it touches,
 * steering): read as they are, they flip Direction between 0.999 and 0.001, and every flip froze
 * and cross-blended the cyclic blends (a horse pulling a cart stumbled along). TODO(M13): the
 * engine's own smoothing of Direction is not documented.
 */
const DIRECTION_AHEAD = 0.02;

/**
 * Drives an actor's behavior graphs from its movement, frame by frame: the variables the
 * engine keeps (Speed: the measured speed; Direction: the movement against the facing, 0 ahead,
 * 0.25 right, 0.5 behind, 0.75 left; TurnDelta: the turn rate, degrees per second, left
 * positive; IsSprinting, IsSneaking; iSyncIdleLocomotion with the movement) and its events
 * (moveStart, moveStop, SprintStart / Stop, SneakStart / Stop, SwimStart / Stop, JumpFall,
 * JumpLand / JumpLandDirectional; CyclicFreeze and CyclicCrossBlend as Direction wraps). iSyncIdleLocomotion: its name is in the executable and no
 * vanilla graph writes it outside blocking, while 38 state machines start from it and leave
 * state 0 on moveStart and state 1 on moveStop; a graph that comes back (landing from a jump)
 * then starts moving while the actor moves. TurnDelta's unit is inferred from the graphs:
 * bleedoutTurnMult = |TurnDelta| / 20.5, the horse's turnSpeedMult = |TurnDelta / 112.5|; its
 * sign from the graphs that read it: the dragon's, the Falmer's, the dwarven spheres' and
 * centurions' turn left on TurnDelta > 0.1 ("turnLeft if (TurnDelta > 0.1)"), and
 * hkbRotateCharacterModifier's degreesPerSecond bound to it turns counter-clockwise about z
 * (TODO(M13): the engine's smoothing).
 */
export class Locomotion {
  #told = {
    moving: false,
    sprinting: false,
    sneaking: false,
    swimming: false,
    airborne: false,
    falling: false,
  };
  #heading: number | undefined;
  /** The Direction last given while it moved (undefined standing). */
  #direction: number | undefined;

  /** Drives the graphs; returns whether it landed from the air in this frame. */
  drive(graphs: Iterable<LocomotionGraph>, frame: LocomotionFrame): boolean {
    // Gone through once (a generator's graphs are there for the first round only: the player's
    // body would get its Speed and none of its events, and stand still while it moves).
    const list = [...graphs];
    const set = (name: string, value: number): void => {
      for (const graph of list) graph.setVariable(name, value);
    };
    const send = (event: string): void => {
      for (const graph of list) graph.sendEvent(event);
    };
    const [vx, vy] = frame.velocity;
    const speed = Math.hypot(vx, vy);
    const airborne = !frame.grounded && !frame.swimming;
    const relative = headingOf(vx, vy) - frame.heading;
    const turn = speed > 1 ? (((relative / (2 * Math.PI)) % 1) + 1) % 1 : 0;
    const direction = turn < DIRECTION_AHEAD || turn > 1 - DIRECTION_AHEAD ? 0 : turn;
    const turned =
      this.#heading === undefined || frame.seconds <= 0
        ? 0
        : angleBetween(this.#heading, frame.heading) / frame.seconds;
    this.#heading = frame.heading;
    set('Speed', speed);
    // Across the wrap (ahead-left to ahead-right: 0.95 to 0.05) a directional blend would sweep
    // through every direction between: the graphs' BSCyclicBlendTransitionGenerators hold the
    // pose they had (CyclicFreeze, sent before the new direction) and cross-fade to the new
    // one (CyclicCrossBlend, after it). Every vanilla one names these two events.
    const wrapped =
      this.#direction !== undefined &&
      speed > MOVING_SPEED &&
      Math.abs(direction - this.#direction) > DIRECTION_WRAP;
    if (wrapped) send('CyclicFreeze');
    set('Direction', direction);
    if (wrapped) send('CyclicCrossBlend');
    this.#direction = speed > MOVING_SPEED ? direction : undefined;
    // Compass headings turn clockwise; TurnDelta is left (counter-clockwise) positive.
    set('TurnDelta', (-turned * 180) / Math.PI);
    set('IsSprinting', frame.sprinting ? 1 : 0);
    set('IsSneaking', frame.sneaking ? 1 : 0);
    const told = this.#told;
    const moving = speed > MOVING_SPEED || frame.settingOut === true;
    set('iSyncIdleLocomotion', moving ? 1 : 0);
    if (moving !== told.moving) send(moving ? 'moveStart' : 'moveStop');
    if (frame.sprinting !== told.sprinting) send(frame.sprinting ? 'SprintStart' : 'SprintStop');
    if (frame.sneaking !== told.sneaking) send(frame.sneaking ? 'SneakStart' : 'SneakStop');
    if (frame.swimming !== told.swimming) send(frame.swimming ? 'SwimStart' : 'SwimStop');
    // In the air: falling once it comes down; landing when it stands again.
    const falling = airborne && frame.verticalSpeed < 0;
    if (falling && !told.falling) send('JumpFall');
    const landed = !airborne && told.airborne;
    if (landed) send(moving ? 'JumpLandDirectional' : 'JumpLand');
    this.#told = {
      moving,
      sprinting: frame.sprinting,
      sneaking: frame.sneaking,
      swimming: frame.swimming,
      airborne,
      falling,
    };
    return landed;
  }

  /** Forgets what the graphs were told (a body made again starts from its graphs' start). */
  reset(): void {
    this.#told = {
      moving: false,
      sprinting: false,
      sneaking: false,
      swimming: false,
      airborne: false,
      falling: false,
    };
    this.#heading = undefined;
    this.#direction = undefined;
  }
}

/** A behavior graph that tags the actor's state (BehaviorRuntime). */
export interface TaggingGraph {
  taggedState(): number | undefined;
  variablesNamed(prefix: string): readonly { readonly name: string; readonly value: number }[];
}

/**
 * The name of the movement type the graph has the actor in (MOVT MNAM): the state its active
 * BSiStateTaggingGenerators tag is the value of a variable iState_<name> (sneaking locomotion
 * tags iState_NPCSneaking's 2); undefined when nothing is tagged (standing: the actor's
 * default movement type).
 */
export function taggedMovementType(graph: TaggingGraph): string | undefined {
  const tagged = graph.taggedState();
  if (tagged === undefined) return undefined;
  const found = graph.variablesNamed('iState_').find((variable) => variable.value === tagged);
  return found?.name.slice('iState_'.length);
}
