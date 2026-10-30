// An actor's movement controller as the original saves it (docs/formats/ess.md "Movement"):
// its pending messages, its arbiters and agents (each by its save type), the shared objects
// they point at (pathing requests, paths), and while the actor is loaded its animation
// graph's state. Platform-independent.

import { readCombatObject, type CombatStream } from './combat.ts';
import type { EssReader } from './ess-reader.ts';
import type { RefIdResolver } from './global-data.ts';
import { pathingTypeId } from './pathing-type.ts';

export { pathingTypeId } from './pathing-type.ts';

/** A part of the movement data whose layout is not known: where the read stopped, and why. */
export class MovementUnknown extends Error {}

/** The pathing classes the movement data names by type id. */
const PATHING_TYPES = new Map(
  [
    'PathingRequest',
    'BSPathingRequest',
    ...[
      'ClosePoint',
      'ClosestGoal',
      'Cover',
      'Flee',
      'Fly',
      'FlyAction',
      'FlyHover',
      'FlyLand',
      'FlyOrbit',
      'FlyTakeOff',
      'Hide',
      'LOS',
      'OptimalLocation',
      'Rotate',
      'SafeStraightLine',
      'StopMoving',
    ].map((kind) => `PathingRequest${kind}`),
    'CombatPathingRequestStandard',
    'CombatPathingRequestMultiGoal',
    'CombatPathingRequestAdapter',
    'CombatCoverSearch',
    'PathingCell',
    'PathingLockData',
    'PathingDoor',
    'MovementParameters',
    'MovementParametersFixed',
    'CombatSearchLockData',
    'BSPathingSolution',
    'MovementMessageActivateDoor',
    'MovementMessageActorCollision',
    'MovementMessageApproachingDoor',
    'MovementMessageBlocked',
    'MovementMessageFreezeDirection',
    'MovementMessageJump',
    'MovementMessageMovementTypeChange',
    'MovementMessageNewPath',
    'MovementMessagePathCleared',
    'MovementMessagePathComplete',
    'MovementMessagePathFailed',
    'MovementMessagePlayIdle',
    'MovementMessageSetStaticPath',
    'MovementMessageWarpToLocation',
    'MovementMessageWarpToMultiple',
  ].map((name) => [pathingTypeId(name), name]),
);

/**
 * The combat pathing requests made from a goal and a search policy: their type is the generic
 * request's id with both policies' ids mixed in (exclusive or). By goal: what each writes
 * after the standard combat request (combat objects, positions, its search state).
 */
const COMBAT_GOALS: readonly (readonly [string, string, readonly CombatPart[]])[] = [
  ['ExitWater', 'Standard', ['search']],
  ['FindAttackLocation', 'Standard', ['object', 12, 4, 'search']],
  ['FindCover', 'Standard', ['object', 'search']],
  ['FindHideCover', 'Standard', ['object', 'search']],
  ['FindTargetLocation', 'Standard', ['object', 'search']],
  ['Flank', 'Flank', ['object', 'object', 'search', 'object', 'object']],
  ['FlankDistant', 'Standard', [12, 12, 4, 'search']],
  ['Flee', 'Standard', [12, 4, 'search']],
  ['Retreat', 'Standard', [12, 4, 'search']],
  ['ReturnToCombatArea', 'Standard', ['object', 12, 'search']],
  ['Search', 'Standard', ['form', 'points', 12, 'search']],
  ['SearchWander', 'Standard', ['form', 12, 'search']],
];

/** A part of a combat request: a combat object, its search state, a form, points, or bytes. */
type CombatPart = 'object' | 'search' | 'form' | 'points' | number;

const COMBAT_REQUESTS = new Map(
  COMBAT_GOALS.map(([goal, search, parts]) => [
    (pathingTypeId('CombatPathingRequestGeneric') ^
      pathingTypeId(`CombatPathingGoalPolicy${goal}`) ^
      pathingTypeId(`CombatPathingSearchPolicy${search}`)) >>>
      0,
    parts,
  ]),
);

/** What the movement data says, as far as the engine has a use for it. */
export interface EssMovement {
  /** The arbiters by save type (0 handler, 1 path manager, 2 planner, 3 post update, 4 tweener). */
  readonly arbiters: readonly number[];
  /** The agents by save type. */
  readonly agents: readonly number[];
  /** The actor was loaded (its animation graph's state follows). */
  readonly loaded: boolean;
}

/**
 * Reads one movement controller's data (after the byte that says it is there), through the
 * actor's pathing stream (which knows the shared objects the actor's save wrote before).
 */
export function readMovement(stream: PathingStream): EssMovement {
  const reader = stream.reader;
  // The messages waiting for the next update.
  for (let n = reader.u32(), i = 0; i < n; i++)
    stream.object((type) => {
      stream.message(type);
    });
  // The points of a path it was told to follow: a point, a direction and a speed.
  for (let n = reader.u32(), i = 0; i < n; i++) {
    stream.point();
    stream.floats(3);
    reader.u32();
  }
  reader.u32();
  reader.skip(7); // its switches (driven by AI or by controls, ...)
  const arbiters: number[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    const type = reader.u8();
    arbiters.push(type);
    stream.arbiter(type);
  }
  const agents: number[] = [];
  for (let n = reader.u32(), i = 0; i < n; i++) {
    const type = reader.u8();
    agents.push(type);
    stream.agent(type);
  }
  const loaded = reader.u8() !== 0;
  if (loaded) {
    readGraphState(reader);
    if (reader.u8() !== 0) throw new MovementUnknown("the loaded state's object");
  }
  return { arbiters, agents, loaded };
}

/**
 * The animation graphs' state a loaded actor keeps: whether there is one, then either its one
 * graph's (a byte, and its variables: 12 bytes each; 4 zero bytes when the graph was not
 * found) or every graph's of a list (a byte, a count, 12 bytes each).
 */
export function readGraphState(reader: EssReader): void {
  if (reader.u8() === 0) return;
  const many = reader.u8() !== 0;
  if (!many) {
    const at = reader.offset;
    if (reader.u32() === 0) return;
    reader.seek(at);
  }
  reader.u8();
  reader.skip(12 * reader.u32());
}

/**
 * The original's pathing stream, one per actor's save: values, forms, and shared objects
 * written once each (the AI process, the movement controller and the combat controller write
 * through the same one).
 */
export class PathingStream implements CombatStream {
  readonly reader: EssReader;
  readonly resolve: RefIdResolver;
  /** The shared objects already written (by the id the original gives them). */
  readonly #seen = new Set<bigint>();

  constructor(reader: EssReader, resolve: RefIdResolver) {
    this.reader = reader;
    this.resolve = resolve;
  }

  floats(count: number): void {
    this.reader.skip(4 * count);
  }

  form(): number {
    return this.resolve(this.reader.refId());
  }

  /** A shared object: its id, and the first time it is written (not null) its type and data. */
  shared(read: (type: number) => void): void {
    const reader = this.reader;
    const id = reader.u64();
    if (id === 0n || this.#seen.has(id)) return;
    this.#seen.add(id);
    this.object(read);
  }

  /** A reference to a shared object written elsewhere: its id alone. */
  link(): void {
    this.reader.u64();
  }

  /** An object written in place: its type (0: none) and its data. */
  object(read: (type: number) => void): void {
    const type = this.reader.u32();
    if (type !== 0) read(type);
  }

  /** A shared pathing request (or another object of the request's kind). */
  request(): void {
    this.shared((type) => {
      const name = PATHING_TYPES.get(type);
      if (name === 'PathingRequest' || name === 'BSPathingRequest') this.pathingRequest();
      else if (name?.startsWith('PathingRequest')) {
        this.pathingRequest();
        this.requestKind(name);
      } else if (
        name === 'CombatPathingRequestStandard' ||
        name === 'CombatPathingRequestMultiGoal' ||
        name === 'CombatPathingRequestAdapter' ||
        COMBAT_REQUESTS.has(type)
      ) {
        this.combatRequest(type);
      } else throw new MovementUnknown(`shared object ${typeName(type)}`);
    });
  }

  /** A shared path (a pathing solution). */
  path(): void {
    this.shared((type) => {
      if (PATHING_TYPES.get(type) !== 'BSPathingSolution') {
        throw new MovementUnknown(`path ${typeName(type)}`);
      }
      const reader = this.reader;
      for (let n = reader.u32(), i = 0; i < n; i++) {
        this.point();
        this.object((kind) => {
          this.message(kind);
        }); // what to do there (a door)
      }
      reader.i32();
      reader.i32();
      const smoothed = (): void => {
        for (let n = reader.u32(), i = 0; i < n; i++) {
          this.point();
          this.floats(3);
          this.object((kind) => {
            this.message(kind);
          }); // what to do there (a door)
        }
      };
      smoothed();
      reader.u8();
      reader.u8();
      smoothed();
    });
  }

  /** A point of a path: its position, the navmesh it is on, a form, and flags. */
  point(): void {
    const reader = this.reader;
    this.floats(3);
    this.object((type) => {
      if (PATHING_TYPES.get(type) !== 'PathingCell') {
        throw new MovementUnknown(`path point's cell ${typeName(type)}`);
      }
      // The cell: an interior's form, or a worldspace's with the exterior cell's grid.
      if (this.form() !== 0) reader.i32();
      else this.form();
    });
    this.form();
    reader.u16();
    reader.u8();
    reader.u8();
  }

  pathingRequest(): void {
    const reader = this.reader;
    // Start and goal.
    this.point();
    this.floats(1);
    this.point();
    this.floats(7);
    // The spaces to avoid.
    for (let n = reader.u32(), i = 0; i < n; i++) {
      this.floats(8);
      reader.u32();
    }
    this.floats(4);
    this.floats(2);
    reader.u16();
    reader.u16();
    this.floats(2);
    reader.u32();
    // What it holds locked (a door, a furniture marker): the reference, and whether it has it.
    this.object((type) => {
      this.lock(type);
    });
    this.form();
    // The movement parameters it asks for (five speeds and rates).
    this.object((type) => {
      const name = PATHING_TYPES.get(type);
      if (name !== 'MovementParameters' && name !== 'MovementParametersFixed') {
        throw new MovementUnknown(`pathing request's parameters ${typeName(type)}`);
      }
      this.floats(5);
    });
    for (let n = reader.u32(), i = 0; i < n; i++) this.form();
    reader.u32();
  }

  /** What a kind of pathing request adds after the base request. */
  requestKind(name: string): void {
    const reader = this.reader;
    const maybeForm = (): void => {
      if (reader.u8() !== 0) this.form();
    };
    // A flying request: the target and another reference (each when there is one), then its
    // heights and switches.
    const fly = (): void => {
      maybeForm();
      maybeForm();
      this.floats(1);
      reader.u8();
      this.floats(2);
      reader.u8();
    };
    switch (name) {
      case 'PathingRequestCover':
      case 'PathingRequestRotate':
      case 'PathingRequestStopMoving':
      case 'PathingRequestSafeStraightLine':
        return;
      case 'PathingRequestClosePoint':
        this.floats(2);
        reader.u8();
        this.point();
        reader.u8();
        reader.u8();
        return;
      case 'PathingRequestClosestGoal':
        for (let n = reader.u32(), i = 0; i < n; i++) this.point();
        reader.u32();
        return;
      case 'PathingRequestFlee':
        this.floats(1);
        return;
      case 'PathingRequestFly':
      case 'PathingRequestFlyTakeOff':
        fly();
        return;
      case 'PathingRequestFlyAction':
        fly();
        reader.u32();
        maybeForm();
        this.floats(3);
        maybeForm();
        maybeForm();
        maybeForm();
        reader.u8();
        reader.u32();
        return;
      case 'PathingRequestFlyHover':
        fly();
        this.floats(3);
        for (let n = reader.u32(), i = 0; i < n; i++) {
          this.point();
          this.floats(7);
        }
        return;
      case 'PathingRequestFlyLand':
        fly();
        this.floats(3);
        reader.u32();
        this.floats(1);
        reader.u8();
        this.form();
        return;
      case 'PathingRequestFlyOrbit':
        fly();
        this.floats(1);
        reader.u32();
        this.floats(3);
        return;
      case 'PathingRequestHide':
        this.point();
        this.floats(1);
        return;
      case 'PathingRequestLOS':
        for (let n = reader.u32(), i = 0; i < n; i++) this.floats(3);
        this.floats(5);
        return;
      case 'PathingRequestOptimalLocation':
        this.floats(4);
        return;
      default:
        throw new MovementUnknown(`pathing request ${name}`);
    }
  }

  /**
   * A combat request: the base request, its actor, two words, its path and a combat object
   * (none here), then what its kind adds.
   */
  combatRequest(type: number): void {
    const reader = this.reader;
    this.pathingRequest();
    this.form();
    reader.u32();
    reader.u32();
    this.path();
    this.combatObject();
    const name = PATHING_TYPES.get(type);
    if (name === 'CombatPathingRequestMultiGoal') {
      // Its goals: a point and two words each, then a word.
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        this.point();
        reader.u32();
        reader.u32();
      }
      reader.u32();
      return;
    }
    if (name === 'CombatPathingRequestAdapter') {
      this.request();
      return;
    }
    for (const part of COMBAT_REQUESTS.get(type) ?? []) {
      if (part === 'object') this.combatObject();
      else if (part === 'search') {
        // The search policy's state: its shared request, and four flags.
        this.request();
        reader.skip(4);
      } else if (part === 'form') this.form();
      else if (part === 'points') {
        for (let n = reader.vsval(), i = 0; i < n; i++) reader.skip(12);
      } else reader.skip(part);
    }
  }

  /** A combat object (the combat AI's: a cover search, a path, ...; combat.ts). */
  combatObject(): void {
    readCombatObject(this);
  }

  /** What a request holds locked (a door, a furniture marker): the reference, if it has one. */
  lock(type: number): void {
    const name = PATHING_TYPES.get(type);
    if (name !== 'PathingLockData' && name !== 'CombatSearchLockData') {
      throw new MovementUnknown(`lock data ${typeName(type)}`);
    }
    if (this.reader.u8() !== 0) {
      this.form();
      this.reader.u8();
    }
  }

  message(type: number): void {
    const reader = this.reader;
    switch (PATHING_TYPES.get(type)) {
      case 'MovementMessageActivateDoor':
      case 'MovementMessageApproachingDoor':
        if (reader.u8() !== 0) {
          this.object((kind) => {
            if (PATHING_TYPES.get(kind) !== 'PathingDoor') {
              throw new MovementUnknown(`door message's door ${typeName(kind)}`);
            }
            this.form(); // the door reference
          });
        }
        return;
      case 'MovementMessageActorCollision':
      case 'MovementMessageBlocked':
        return;
      case 'MovementMessageFreezeDirection':
        reader.u32();
        return;
      case 'MovementMessageJump':
        this.floats(1);
        return;
      case 'MovementMessageMovementTypeChange':
        for (let i = 0; i < 2; i++) {
          reader.wstring();
          this.floats(10 + 4);
        }
        return;
      case 'MovementMessageNewPath':
      case 'MovementMessagePathCleared':
      case 'MovementMessagePathComplete':
      case 'MovementMessagePathFailed':
        this.request();
        return;
      case 'MovementMessagePlayIdle':
        reader.wstring();
        this.tweenerTarget();
        this.link();
        return;
      case 'MovementMessageSetStaticPath':
        reader.u8();
        return;
      case 'MovementMessageWarpToLocation':
        this.point();
        this.floats(3);
        return;
      default:
        throw new MovementUnknown(`movement message ${typeName(type)}`);
    }
  }

  /** A tweener's target: a u32, ten points (30 floats) and three floats. */
  tweenerTarget(): void {
    this.reader.u32();
    this.floats(30 + 3);
  }

  arbiter(type: number): void {
    const reader = this.reader;
    switch (type) {
      case 0: // handler
        return;
      case 1: // path manager: its state, the request and the path
        reader.u32();
        this.request();
        this.path();
        return;
      case 2: // planner
        reader.u8();
        return;
      case 3: // post update
        this.floats(14);
        return;
      case 4: // tweener: its keys, target, three transforms and four floats
        for (let n = reader.u32(), i = 0; i < n; i++) this.floats(13);
        this.tweenerTarget();
        this.floats(13 * 3);
        this.floats(4);
        return;
      default:
        throw new MovementUnknown(`movement arbiter ${String(type)}`);
    }
  }

  agent(type: number): void {
    const reader = this.reader;
    switch (type) {
      case 0x00: // follow path (a state)
      case 0x01: // tweener (a state)
      case 0x02: // angle controller
      case 0x03: // angle gain
      case 0x04: // angle pass-through
      case 0x05: // direction pass-through
      case 0x07: // speed pass-through
      case 0x08: // strafing
      case 0x80: // direct control
      case 0x82: // player controls' action trigger
      case 0x84: // stairs helper
      case 0x85: // planner direct control
      case 0x86: // horse controls
      case 0x8a: // node follower
        return;
      case 0x06: // large delta idle
      case 0x89: // animation driven tweener
        reader.u32();
        return;
      case 0x09: // translation controller
        reader.u8();
        reader.u32();
        return;
      case 0x0a: // actor state
        reader.u32();
        this.floats(5 + 2);
        reader.u32();
        reader.u32();
        return;
      case 0x0b: // actor avoider: the actors it avoids
        this.request();
        for (let n = reader.u32(), i = 0; i < n; i++) {
          this.form();
          this.floats(12);
          reader.u32();
          reader.u32();
          reader.u8();
        }
        reader.u32();
        reader.u32();
        reader.u32();
        return;
      case 0x0c: // flight path follower
        reader.u32();
        this.floats(5);
        this.request();
        this.path();
        this.floats(1);
        reader.u32();
        reader.u32();
        for (let n = reader.u32(), i = 0; i < n; i++) this.floats(3);
        reader.u32();
        for (let n = reader.u32(), i = 0; i < n; i++) this.floats(3);
        reader.u32();
        return;
      case 0x0d: // standard path follower
        reader.u32();
        this.request();
        this.path();
        this.floats(7);
        this.link(); // its movement state
        this.floats(3);
        reader.u32();
        reader.u32();
        this.floats(1); // when the parameter is reached
        this.floats(1); // when the goal is reached
        // Its states: playing an idle (the idle's name), turning to an angle, following the
        // path to a parameter, keeping its last direction.
        if (reader.u8() !== 0) reader.wstring();
        reader.u32();
        this.floats(3);
        reader.u32();
        reader.u32();
        this.floats(5);
        this.floats(4);
        reader.u32();
        return;
      case 0x0e: // virtual path follower
        reader.u32();
        this.request();
        this.path();
        return;
      case 0x0f: // navmesh bounds
        reader.u32();
        this.floats(2);
        for (let n = reader.u32(), i = 0; i < n; i++) {
          this.floats(6);
          for (let m = reader.u32(), j = 0; j < m; j++) this.floats(3);
          reader.u32();
        }
        this.path();
        return;
      case 0x10: // avoid box: its box (a point and extents) and the two sides' objects
        reader.u32();
        this.floats(1);
        this.point();
        this.floats(3);
        reader.u8();
        this.object((kind) => {
          throw new MovementUnknown(`avoid box's first object ${typeName(kind)}`);
        });
        this.object((kind) => {
          this.lock(kind);
        });
        return;
      case 0x11: // loaded area monitor
        this.path();
        return;
      case 0x12: // static avoider
        this.floats(1);
        for (let n = reader.u32(), i = 0; i < n; i++) this.floats(13);
        this.floats(5);
        for (let n = reader.u32(), i = 0; i < n; i++) {
          this.floats(8);
          reader.u32();
        }
        this.request();
        this.floats(2);
        reader.u32();
        return;
      case 0x13: // fixed delta tweener
        this.floats(31);
        return;
      case 0x81: // player controls
        reader.u32();
        this.floats(1);
        reader.u8();
        return;
      case 0x83: // sprint action trigger
        reader.u32();
        reader.u8();
        reader.u8();
        return;
      case 0x87: // keep offset
        this.form();
        this.floats(8);
        return;
      case 0x88: // warp
        this.point();
        this.point();
        this.floats(1);
        this.form();
        reader.u32();
        reader.u32();
        return;
      default:
        throw new MovementUnknown(`movement agent 0x${type.toString(16)}`);
    }
  }
}

const typeName = (type: number): string => PATHING_TYPES.get(type) ?? `0x${type.toString(16)}`;
