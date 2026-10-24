// How actors move (docs/ai.md, "Movement"): what an actor wants to do (a way to go, a gait, a
// heading to keep) becomes the velocity its character controller moves with and the way it
// turns, at the speeds and turn rates of its movement type (MOVT); and its movement drives its
// behavior graph as the engine's graph data channels do (CommonLibSSE: ActorSpeedChannel,
// ActorDirectionChannel, ActorTurnDeltaChannel, ...): Speed, Direction, TurnDelta, IsSprinting,
// IsSneaking and the movement events. The player's body drives its graphs the same way
// (src/shell/player-avatar.ts). Platform-independent.

import type { GraphChannels } from '../animation/behavior-runtime.ts';
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
  /** Its speed against its gait's (a follower matching its leader's); 1 without. */
  readonly speedMult?: number | undefined;
  /**
   * Its speed on the engine's normalized scale (1 its movement type's walk, 2 its run, each in
   * the way it goes; between them linear): the combat paths' speeds (fCombatSpeedValueWalk 1,
   * FastWalk 1.33, Jog 1.66, Run 2). Undefined: its gait's speed.
   */
  readonly pace?: number | undefined;
  /** How it turns (undefined: as any actor out of combat, DEFAULT_TURNING). */
  readonly turning?: TurnParameters | undefined;
  /**
   * Standing (no direction), its graph's root motion moves it (a melee attack's lunge) while
   * its controller turns it to `face`.
   */
  readonly rootMotion?: boolean | undefined;
}

/**
 * How an actor turns (observed in the original: its movement parameters and the facing its
 * planner keeps). Standing, it turns until it faces the heading it keeps within 1°, then holds
 * its facing until that heading is more than `tolerance` off; moving, it keeps turning to it.
 * Its turn rate is its movement type's × `rateMult`, reached and given up at its angular
 * acceleration: its race's (RACE DATA angular acceleration rate: 1 / that, in its movement
 * type's turn-while-moving rates a second) × `accelerationMult`.
 */
export interface TurnParameters {
  /** Radians (fDefaultAngleTolerance; fCombatAngleTolerance in combat). */
  readonly tolerance: number;
  /** At least its race's aim angle tolerance (RACE DATA; the combat facing's). */
  readonly raceTolerance?: boolean;
  readonly rateMult: number;
  readonly accelerationMult: number;
}

/** Out of combat: fDefaultAngleTolerance (5°), its movement type's rates. */
export const DEFAULT_TURNING: TurnParameters = {
  tolerance: (5 * Math.PI) / 180,
  rateMult: 1,
  accelerationMult: 1,
};

/** What an actor's turning keeps from step to step (its mover's). */
export class Turning {
  /** Its turn rate now (radians per second, clockwise). */
  rate = 0;
  /** Standing, it faces the heading it keeps (within 1°) and holds its facing. */
  settled = false;

  reset(): void {
    this.rate = 0;
    this.settled = false;
  }
}

/** The angle controller's dead band: nearer than this, turning slower than this a second, it stops. */
const TURN_DEAD_BAND = Math.PI / 180;

/**
 * One step of the engine's angle controller (observed in the original): the turn rate that brings the
 * heading onto its goal soonest without passing it, at most `maxRate`, the rate changing by at
 * most `acceleration` a second; within 1° of its goal and slower than 1° a second, none.
 * `delta` is the turn still to make (radians, clockwise positive).
 */
export function turnRate(
  delta: number,
  rate: number,
  maxRate: number,
  acceleration: number,
  seconds: number,
): number {
  if (!(seconds > 0)) return rate;
  if (Math.abs(delta) < TURN_DEAD_BAND && Math.abs(rate) < TURN_DEAD_BAND) return 0;
  if (!(acceleration > 0)) return Math.max(-maxRate, Math.min(maxRate, delta / seconds));
  // The fastest rate from which it still stops on the goal after this step, decelerating as
  // fast as it may (v·dt + v² / 2a = the turn left), and not past the goal in this step.
  const left = Math.abs(delta);
  const sign = Math.sign(delta);
  const stopping =
    acceleration * (-seconds + Math.sqrt(seconds * seconds + (2 * left) / acceleration));
  const wanted = Math.min(stopping, maxRate, left / seconds);
  // Faster than that the way it turns: it brakes to it; else it speeds up at most so much.
  if (Math.sign(rate) === sign && Math.abs(rate) > wanted) return sign * wanted;
  const change = acceleration * seconds;
  return rate + Math.max(-change, Math.min(change, sign * wanted - rate));
}

/**
 * The movement types an actor moves by now (src/ai/movement-types.ts): walking (its walk
 * speeds), running (its run speeds) and sprinting (its run speeds; else running's).
 */
export interface MovementTypes {
  readonly walk: MovementType;
  readonly run: MovementType;
  readonly sprint?: MovementType | undefined;
  /**
   * Its race's angular acceleration (RACE DATA: 1 / its angular acceleration rate, in turn-
   * while-moving rates a second; 1 where the race gives none) and aim angle tolerance (radians).
   */
  readonly angularAcceleration?: number | undefined;
  readonly aimTolerance?: number | undefined;
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

/** [Animation] fMotionFeedback* and bFeedbackToGraphFromCharacterController (MotionFeedback). */
export interface MotionFeedbackSettings {
  readonly enabled: boolean;
  /** Units a second the wanted and the made movement may part by, at most, to agree. */
  readonly minSpeedDelta: number;
  /** Degrees their directions may part by, at most, to agree. */
  readonly minAngleDelta: number;
  /** Slower than this (units a second) the graph is told it stands. */
  readonly minSpeed: number;
  /** Seconds they agree before the graph is told the movement made. */
  readonly minTime: number;
}

/** The engine's built-in values. */
export const MOTION_FEEDBACK: MotionFeedbackSettings = {
  enabled: true,
  minSpeedDelta: 25,
  minAngleDelta: 20,
  minSpeed: 5,
  minTime: 0.5,
};

/**
 * What an actor's graph is told it moves (its Speed and Direction), the engine's feedback from
 * its character controller (observed in the original): once the movement the controller made has agreed with
 * the movement wanted (their speeds within fMotionFeedbackMinSpeedDelta a second, their
 * directions within fMotionFeedbackMinAngleDelta) for fMotionFeedbackMinTime, the movement made
 * (its direction only above fMotionFeedbackMinSpeed, else the one told before); until then the
 * movement wanted (none below fMotionFeedbackMinSpeed), its direction turning from the one told
 * before by at most a full turn a second. Without the feedback, the movement wanted as it is.
 */
export class MotionFeedback {
  readonly #settings: MotionFeedbackSettings;
  #agreed = 0;
  /** The direction told last, against the heading (radians, clockwise). */
  #direction = 0;

  constructor(settings: MotionFeedbackSettings = MOTION_FEEDBACK) {
    this.#settings = settings;
  }

  /**
   * The velocity (world, horizontal; units a second) to tell the graph, from the velocity
   * wanted and the one made over `seconds`, facing `heading`.
   */
  feed(
    wanted: readonly [number, number],
    made: readonly [number, number],
    heading: number,
    seconds: number,
  ): [number, number] {
    const s = this.#settings;
    if (!s.enabled || !(seconds > 0)) return [wanted[0], wanted[1]];
    const wantedSpeed = Math.hypot(wanted[0], wanted[1]);
    const madeSpeed = Math.hypot(made[0], made[1]);
    const apart = Math.hypot(wanted[0] - made[0], wanted[1] - made[1]);
    // Directions are compared only when both move (more than a tenth of a unit a step).
    const both = wantedSpeed * seconds > 0.1 && madeSpeed * seconds > 0.1;
    const turned = both
      ? Math.abs(angleBetween(headingOf(made[0], made[1]), headingOf(wanted[0], wanted[1])))
      : 0;
    this.#agreed += seconds;
    if (apart > s.minSpeedDelta || turned > (s.minAngleDelta * Math.PI) / 180) this.#agreed = 0;
    let speed: number;
    if (this.#agreed >= s.minTime) {
      speed = madeSpeed;
      if (madeSpeed > s.minSpeed)
        this.#direction = angleBetween(heading, headingOf(made[0], made[1]));
    } else if (wantedSpeed >= s.minSpeed) {
      speed = wantedSpeed;
      const toward = angleBetween(
        this.#direction,
        angleBetween(heading, headingOf(wanted[0], wanted[1])),
      );
      const most = 2 * Math.PI * seconds;
      this.#direction += Math.max(-most, Math.min(most, toward));
    } else {
      speed = 0;
    }
    const way = heading + this.#direction;
    return [Math.sin(way) * speed, Math.cos(way) * speed];
  }
}

/**
 * One step of an actor that wants `request`, from `heading`: it turns towards the heading it
 * keeps (or the way it goes) at its movement type's rate (while moving, else in place: walking
 * or running), and goes the way it wants at the speed of that direction against its facing (the
 * ellipse through the four directional speeds). Not strafing, it goes where it faces: the speed
 * falls with the cosine of the turn still to make, so a turn of a right angle or more is made
 * standing (the engine's NPCs do not walk sideways out of combat).
 *
 * With `turning` (its mover's state) it turns as the engine's movement controller does
 * (TurnParameters): at an angular acceleration, holding its facing within its tolerance while
 * it stands (`carried`: its graph moves it, a lunge: it does not stand); without, it turns at
 * its full rate from the first step (walkers beyond the high process, the tests).
 */
export function steer(
  request: MoveRequest,
  heading: number,
  types: MovementTypes,
  seconds: number,
  turning?: Turning,
  carried = false,
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
  const parameters = request.turning ?? DEFAULT_TURNING;
  const rate =
    (moving
      ? type.rotateWhileMoving
      : request.gait === 'walk'
        ? type.rotateInPlace.walk
        : type.rotateInPlace.run) * (turning ? parameters.rateMult : 1);
  let turn = angleBetween(heading, target);
  let next: number;
  if (turning) {
    // Standing it settles on the heading within 1° and holds its facing until that heading is
    // more than its tolerance off (the engine's planner; moving, it follows the heading).
    if (!moving && !carried) {
      const tolerance = Math.max(
        parameters.tolerance,
        parameters.raceTolerance === true ? (types.aimTolerance ?? 0) : 0,
      );
      if (turning.settled) {
        if (Math.abs(turn) > tolerance) turning.settled = false;
        else turn = 0;
      } else if (Math.abs(turn) <= TURN_DEAD_BAND) {
        turning.settled = true;
      }
    }
    const acceleration =
      (types.angularAcceleration ?? 1) * parameters.accelerationMult * type.rotateWhileMoving;
    turning.rate = turnRate(turn, turning.rate, Math.max(0, rate), acceleration, seconds);
    next = heading + turning.rate * seconds;
  } else {
    const step = Math.max(0, rate) * seconds;
    next = heading + (Math.abs(turn) <= step ? turn : Math.sign(turn) * step);
  }
  if (!moving) return { velocity: [0, 0], heading: next };
  // The way against the facing: x right, y forward.
  const against = angleBetween(next, way);
  const across = Math.sin(against);
  const ahead = Math.cos(against);
  const walkSpeed = directionalSpeed(type.walk, across, ahead);
  const runSpeed = directionalSpeed(type.run, across, ahead);
  const pace = request.pace;
  const gaitSpeed =
    pace === undefined
      ? request.gait === 'walk'
        ? walkSpeed
        : runSpeed
      : pace <= 1
        ? walkSpeed * Math.max(0, pace)
        : walkSpeed + (runSpeed - walkSpeed) * (pace - 1);
  let speed = gaitSpeed * (request.speedMult ?? 1);
  if (request.face === undefined) {
    // Not strafing it goes ahead, the way it faces (its graph's Direction is 0: a sideways
    // remainder of the turn it still makes swayed walkers into their walk-left and walk-right
    // blends, and a horse's Direction flipped between 0 and 1).
    speed *= Math.max(0, Math.cos(against));
    return { velocity: [Math.sin(next) * speed, Math.cos(next) * speed], heading: next };
  }
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

/** A graph whose data channels read the movement right before each of its updates. */
export interface ChannelGraph extends LocomotionGraph {
  channels: GraphChannels | undefined;
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
  /**
   * Its scale (the reference's times its base's height, the race's by sex times the NPC's: the
   * engine's GetScale): its Speed channel gives the graph its speed divided by it (observed in the original),
   * so that a small or large actor's clips, scaled with its skeleton, step as fast as it goes.
   * The thresholds (moveStart at 5) read the speed itself. 1 without.
   */
  readonly scale?: number | undefined;
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

/** Actions performed through the actor's idle tree (its conditions run on the actor). */
export interface LocomotionActions {
  /** Performs an action; resolves whether its graph took one of its idles. */
  perform(action: string): Promise<boolean>;
}

/** A fall its idle tree did not take is asked for again this often while it falls (seconds). */
const FALL_RETRY_SECONDS = 0.1;

/** iSyncTurnState as the engine sets it with each turn action. */
const TURN_STATE = { right: 0, stop: 1, left: 2 } as const;

/**
 * Drives an actor's behavior graphs from its movement, as the engine's graph data channels and
 * the actions they perform do (docs/animation.md, "Driving the graphs"; observed in the
 * original). Every update:
 *
 * - **Speed:** the speed its movement controller wants, over the actor's scale. Reaching 5 units per second it performs
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
 * Besides: IsSprinting, IsSneaking, SneakStart / Stop, SwimStart / Stop, falls and landings
 * (with `actions`: ActionFall and ActionLand through the actor's idle tree, else JumpFall,
 * JumpLand / JumpLandDirectional); the player's CyclicFreeze and CyclicCrossBlend
 * (`freezeDirection`).
 */
export class Locomotion {
  readonly #actions: LocomotionActions | undefined;
  /** Its fall: not asked for, asked (the idle tree resolving), taken by its graph. */
  #fall: 'none' | 'asking' | 'taken' = 'none';
  /** When its fall may be asked for again (its seconds driven). */
  #fallRetry = 0;
  #driven = 0;
  /** Its vertical speed in the air last, and as it landed (while its landing resolves). */
  #impact = 0;
  #landing: number | undefined;

  /**
   * `actions`: the movement actions the idle tree resolves (an NPC's falls and landings: the
   * engine performs ActionFall and ActionLand, whose idles' conditions decide: 0_master's
   * JumpFall only falling faster than 350 units a second, its landing only in its jump state).
   */
  constructor(actions?: LocomotionActions) {
    this.#actions = actions;
  }

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
  /** The movement latched for the graph's channels (latch), and the graph. */
  #latched: { readonly graph: ChannelGraph; frame: LocomotionFrame } | undefined;
  /** Its graph's channels: they drive the graph with the latched movement as it updates. */
  readonly #channels: GraphChannels = {
    read: (dt) => {
      const latched = this.#latched;
      if (!latched) return;
      // Measured over the graph's own step (a graph updated less often than every frame).
      const seconds = dt > 0 ? dt : latched.frame.seconds;
      this.drive([latched.graph], { ...latched.frame, seconds });
    },
  };

  /**
   * The movement now, for the graph's data channels to read as the graph next updates (the
   * engine reads its channels right before every graph update): an actor whose graph updates
   * less often than every frame is driven by its movement at its updates, not by every frame's
   * (a speed that dipped below 5 for a frame between two updates sends no moveStop and
   * moveStart; each queued, its graph left its locomotion and came back in one update,
   * restarting its walk). The graph's channels are this Locomotion's from now on.
   */
  latch(graph: ChannelGraph, frame: LocomotionFrame): void {
    if (this.#latched?.graph !== graph) this.#latched = { graph, frame };
    else this.#latched.frame = frame;
    graph.channels = this.#channels;
  }

  /** Its graph's channels no longer read this movement (another drives the graph now). */
  release(): void {
    const latched = this.#latched;
    if (latched?.graph.channels === this.#channels) latched.graph.channels = undefined;
    this.#latched = undefined;
  }

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
    // The graph's Speed: the speed over the actor's scale (its clips' strides scale with it).
    const scale = frame.scale !== undefined && frame.scale > 1e-6 ? frame.scale : 1;
    set('Speed', speed / scale);
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
    const landed = !airborne && told.airborne;
    const actions = this.#actions;
    if (actions) {
      // The engine's actions (its character's fall and landing are ActionFall and ActionLand):
      // its idle tree decides by their conditions (falling fast enough, in its jump state), so
      // a stumble off a kerb or a step without ground under it plays nothing. VelocityZ, which
      // the landing idles read, is its vertical speed (inferred: what feeds it is not known).
      this.#driven += frame.seconds;
      // Landed, the speed it came down with holds until its landing is resolved.
      if (airborne) this.#impact = frame.verticalSpeed;
      set('VelocityZ', this.#landing ?? frame.verticalSpeed);
      if (falling && this.#fall === 'none' && this.#driven >= this.#fallRetry) {
        this.#fall = 'asking';
        this.#fallRetry = this.#driven + FALL_RETRY_SECONDS;
        void actions
          .perform('ActionFall')
          .catch(() => false)
          .then((took) => {
            if (this.#fall === 'asking') this.#fall = took ? 'taken' : 'none';
          });
      }
      if (landed) {
        this.#fall = 'none';
        const landing = this.#impact;
        this.#landing = landing;
        set('VelocityZ', landing);
        void actions
          .perform('ActionLand')
          .catch(() => false)
          .then(() => {
            if (this.#landing === landing) this.#landing = undefined;
          });
      }
    } else {
      if (falling && !told.falling) send('JumpFall');
      if (landed) send(moving ? 'JumpLandDirectional' : 'JumpLand');
    }
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
    this.release();
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
    this.#fall = 'none';
    this.#fallRetry = 0;
    this.#impact = 0;
    this.#landing = undefined;
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
