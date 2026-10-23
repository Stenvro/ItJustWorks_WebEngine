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

/** How the actor moves in the frame. */
export interface LocomotionFrame {
  /**
   * Horizontal velocity it wants to move with now (game units per second): its movement
   * controller's, not what physics made of it (the engine's Speed and Direction are its movement
   * controller's wish; an actor walking into a wall walks on the spot).
   */
  readonly velocity: readonly [number, number];
  /** Its heading now (radians, compass). */
  readonly heading: number;
  /**
   * How fast it turns now (radians per second, compass: clockwise positive), as its movement
   * controller turns it; undefined: measured from its heading from frame to frame.
   */
  readonly turnRate?: number | undefined;
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
  /**
   * The player's controls freeze the direction of a large change (game settings
   * bFreezeDirectionOnLargeDelta, fFreezeDirectionDefaultAngleThreshold: radians here,
   * fFreezeDirectionDefaultSpeedThreshold): the cyclic blends hold their pose (CyclicFreeze) and
   * cross-fade to the new direction (CyclicCrossBlend). NPCs' movement has no such freeze.
   */
  readonly freezeDirection?: { readonly angle: number; readonly speed: number } | undefined;
}

/**
 * The engine's Speed channel: an actor wanting at least this speed moves (ActionMoveStart as
 * it reaches it, ActionMoveStop as it falls below; game units per second).
 */
const MOVING_SPEED = 5;

/** The engine's TurnDelta channel: turning faster than this turns (ActionTurnLeft / Right). */
const TURNING_RATE = Math.PI / 180;

/**
 * The movement actions the engine performs as its graph data channels cross their thresholds,
 * by the event their idles (IDLE under the AACT) send in every vanilla graph that has them:
 * ActionMoveStart moveStart (the characters' only while not riding: IsRidingHorse() == 0),
 * ActionTurnLeft turnLeft, ActionMoveForward moveForward, ... ActionMoveLeft and ActionMoveRight
 * have no idles. TODO(M13): resolve them through the idle tree (their conditions: a rider's
 * graph gets no moveStart, SprintStart only neither sneaking nor blocking).
 */
const ACTION_EVENTS = {
  moveStart: 'moveStart',
  moveStop: 'moveStop',
  turnLeft: 'turnLeft',
  turnRight: 'turnRight',
  turnStop: 'turnStop',
  moveForward: 'moveForward',
  moveBackward: 'moveBackward',
} as const;

/** iSyncTurnState as the engine sets it with each turn action. */
const TURN_STATE = { right: 0, stop: 1, left: 2 } as const;

/**
 * Drives an actor's behavior graphs from its movement, as the engine's graph data channels and
 * the actions they perform do (docs/animation.md, "Driving the graphs"; observed in the
 * original). Every update:
 *
 * - **Speed:** the speed its movement controller wants. Reaching 5 units per second it performs
 *   ActionMoveStart (moveStart), falling below ActionMoveStop (moveStop).
 * - **Direction:** the way it wants to go against its facing, the turn wrapped to 0..1 (0
 *   ahead, 0.25 right, 0.5 behind, 0.75 left), unsmoothed. Crossing between the front half
 *   (below 0.25 or from 0.75) and the back half it performs ActionMoveForward / Backward;
 *   between the right (0 to 0.5) and the left ActionMoveRight / Left.
 * - **TurnDelta:** its turn rate in degrees per second, left positive. Turning faster than 1°
 *   a second from slower it performs ActionTurnLeft or ActionTurnRight, slower again
 *   ActionTurnStop.
 * - Each action sets the sync variable the graphs' state machines start from as they are
 *   entered, whether or not the graph took its event: iSyncIdleLocomotion (moveStart 1,
 *   moveStop 0), iSyncTurnState (right 0, stop 1, left 2), iSyncForwardState (forward 0,
 *   backward 1), iSyncStrafeState (right 0, left 1), iSyncSprintState (SprintStart 1,
 *   SprintStop 0). A graph coming back to its locomotion (landing, an idle ended) so starts
 *   as the actor moves.
 *
 * Besides: IsSprinting, IsSneaking, SneakStart / Stop, SwimStart / Stop, JumpFall, JumpLand /
 * JumpLandDirectional; the player's CyclicFreeze and CyclicCrossBlend (`freezeDirection`).
 */
export class Locomotion {
  #told = {
    moving: false,
    sprinting: false,
    sneaking: false,
    swimming: false,
    airborne: false,
    falling: false,
    /** ActionTurnLeft (1), ActionTurnRight (−1) or ActionTurnStop (0) last. */
    turning: 0,
    forward: true,
    right: false,
  };
  #heading: number | undefined;
  /** The direction (0..1) last given while it moved faster than the freeze speed. */
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
    const direction = speed > 0 ? (((relative / (2 * Math.PI)) % 1) + 1) % 1 : 0;
    const turnRate =
      frame.turnRate ??
      (this.#heading === undefined || frame.seconds <= 0
        ? 0
        : angleBetween(this.#heading, frame.heading) / frame.seconds);
    this.#heading = frame.heading;
    set('Speed', speed);
    // The player's controls: a large change of direction at speed is frozen and cross-faded
    // (a directional blend would otherwise sweep through every direction between).
    const freeze = frame.freezeDirection;
    const fast = freeze !== undefined && speed > freeze.speed;
    const last = this.#direction;
    const frozen =
      fast &&
      last !== undefined &&
      Math.abs(angleBetween(last * 2 * Math.PI, direction * 2 * Math.PI)) > freeze.angle;
    if (frozen) send('CyclicFreeze');
    set('Direction', direction);
    if (frozen) send('CyclicCrossBlend');
    this.#direction = fast ? direction : undefined;
    // Compass headings turn clockwise; TurnDelta is left (counter-clockwise) positive.
    set('TurnDelta', (-turnRate * 180) / Math.PI);
    set('IsSprinting', frame.sprinting ? 1 : 0);
    set('IsSneaking', frame.sneaking ? 1 : 0);
    const told = this.#told;
    const moving = speed >= MOVING_SPEED || frame.settingOut === true;
    // A sprint ends before the movement does: the locomotion machine leaves its sprint state
    // only while it runs (SprintStop after moveStop finds it gone).
    const sprintStop = !frame.sprinting && told.sprinting;
    const sneakStop = !frame.sneaking && told.sneaking;
    if (sprintStop) {
      set('iSyncSprintState', 0);
      send('SprintStop');
    }
    if (sneakStop) send('SneakStop');
    // The channels in the engine's order: Speed, Direction, TurnDelta.
    if (moving !== told.moving) {
      set('iSyncIdleLocomotion', moving ? 1 : 0);
      send(moving ? ACTION_EVENTS.moveStart : ACTION_EVENTS.moveStop);
    }
    const forward = direction < 0.25 || direction >= 0.75;
    if (forward !== told.forward) {
      set('iSyncForwardState', forward ? 0 : 1);
      send(forward ? ACTION_EVENTS.moveForward : ACTION_EVENTS.moveBackward);
    }
    const right = direction > 0 && direction <= 0.5;
    if (right !== told.right) set('iSyncStrafeState', right ? 0 : 1);
    const wasTurning = told.turning !== 0;
    const turnsNow = Math.abs(turnRate) > TURNING_RATE;
    let turning = told.turning;
    if (!wasTurning && turnsNow) {
      // Left (counter-clockwise) is a falling compass heading.
      turning = turnRate < 0 ? 1 : -1;
      set('iSyncTurnState', turning > 0 ? TURN_STATE.left : TURN_STATE.right);
      send(turning > 0 ? ACTION_EVENTS.turnLeft : ACTION_EVENTS.turnRight);
    } else if (wasTurning && !turnsNow) {
      turning = 0;
      set('iSyncTurnState', TURN_STATE.stop);
      send(ACTION_EVENTS.turnStop);
    }
    if (frame.sprinting && !told.sprinting) {
      set('iSyncSprintState', 1);
      send('SprintStart');
    }
    if (frame.sneaking && !told.sneaking) send('SneakStart');
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
      turning,
      forward,
      right,
    };
    return landed;
  }

  /**
   * Its graph left an idle (or another state that took no movement events) while the actor
   * still moves or turns: the engine, stopping an idle, performs the movement action again
   * (ActionMoveStart while iSyncIdleLocomotion says it moves, else ActionTurnRight / Left while
   * iSyncTurnState says it turns), so that the graph goes on as the actor does.
   */
  resume(graphs: Iterable<LocomotionGraph>): void {
    const told = this.#told;
    const event = told.moving
      ? ACTION_EVENTS.moveStart
      : told.turning > 0
        ? ACTION_EVENTS.turnLeft
        : told.turning < 0
          ? ACTION_EVENTS.turnRight
          : undefined;
    if (event === undefined) return;
    for (const graph of graphs) graph.sendEvent(event);
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
      turning: 0,
      forward: true,
      right: false,
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
