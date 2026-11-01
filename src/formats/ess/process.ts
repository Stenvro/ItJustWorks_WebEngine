// An actor's AI process as the original saves it (docs/formats/ess.md "AI process"): the part
// every process has (its current package with that package's running data, its timers and the
// references it keeps), then the middle-low, middle-high and high process's own parts by the
// actor's process level. Platform-independent.

import { readGraphState, type PathingStream } from './movement.ts';

/** A part of the process data whose layout is not known: where the read stopped, and why. */
export class ProcessUnknown extends Error {}

/** The kinds of a running package's own data, by the number the save writes for each. */
export const PackageDataKind = {
  escort: 2,
  sandbox: 12,
  patrol: 13,
  guard: 14,
  useWeapon: 16,
  custom: 18,
} as const;

/** A package parameter's value the running package changed (a custom package's data). */
export interface EssPackageValue {
  /** The parameter's index in the package's data. */
  readonly index: number;
  /** Its type name (Bool, Int, Float, SingleRef, Location, ...). */
  readonly type: string;
}

/** The package an actor runs and how far it got. */
export interface EssActorPackage {
  /** The package's form id (0: none). */
  readonly package: number;
  /** The kind of its running data (`PackageDataKind`), when it has one. */
  readonly dataKind?: number;
  /** Its target (a reference's form id, 0: none). */
  readonly target: number;
  /** Three values the running package keeps: a u32, a game time (a float) and a u32. */
  readonly values: readonly number[];
  /** A custom package's parameters that differ from the package's own. */
  readonly parameters?: readonly EssPackageValue[];
  /** A custom package's running procedure (its execution state's name; '' when none). */
  readonly procedure?: string;
  /** A custom package's procedure tree's running state, from its root (`procedure`) down. */
  readonly procedureState?: EssProcedureState;
  /** A sandbox's current activity's reference, a patrol's or guard's target (as read). */
  readonly dataTarget?: number;
}

/**
 * A procedure tree item's running state, as far as the import uses it: its kind's name and, for
 * a branch, the u32 it keeps with the child it runs (Sequence, Stacked, Random) or with each
 * child (Simultaneous), and that child's state.
 */
export interface EssProcedureState {
  readonly name: string;
  readonly index?: number;
  readonly child?: EssProcedureState;
  readonly children?: readonly { readonly index: number; readonly state?: EssProcedureState }[];
}

/** What the AI process's data says, as far as the engine has a use for it. */
export interface EssProcess {
  /** The package it runs. */
  readonly package?: EssActorPackage;
  /** The middle-high process's second package slot (the one a scene or dialogue pushes). */
  readonly pushedPackage?: EssActorPackage;
  /** The animation graph states the high process keeps for its extra graphs. */
  readonly graphStates: number;
}

/** A timer as the original writes it: a game time and a duration. */
const TIMER = 8;
/** A time stamp: a game time. */
const STAMP = 4;
/**
 * How many animation graphs a middle-high process keeps, as observed in the original: the
 * first three are its own (written elsewhere), the fourth and fifth are saved here.
 */
const PROCESS_GRAPHS = 5;

/**
 * Reads an actor's AI process (after its reference data), through the actor's pathing stream:
 * `level` is the process level the actor's change form starts with (0 high to 3 low).
 */
export function readProcess(stream: PathingStream, level: number): EssProcess {
  const reader = stream.reader;
  const ref = (): number => stream.form();
  reader.u32();
  reader.u32();
  // The values it caches for its actor (twelve numbers and two lists of actor value entries).
  if (reader.u8() !== 0) {
    reader.skip(12 * 4);
    for (let list = 0; list < 2; list++) {
      for (let n = reader.u32(), i = 0; i < n; i++) reader.skip(4 + 4 + 1);
    }
  }
  const current = readActorPackage(stream);
  reader.u8();
  reader.u32();
  ref();
  reader.skip(3 * 4);
  reader.u8();
  reader.u16();
  reader.skip(TIMER);
  ref();
  for (let n = reader.vsval(), i = 0; i < n; i++) ref();
  for (let n = reader.u32(), i = 0; i < n; i++) {
    ref();
    ref();
  }
  ref();
  ref();
  reader.u8();
  ref();
  const process: { -readonly [K in keyof EssProcess]: EssProcess[K] } = { graphStates: 0 };
  if (current) process.package = current;
  // Middle-low: a u32. Middle-high (levels 0 and 1) adds its own part, high (level 0) more.
  if (level <= 2) reader.u32();
  if (level <= 1) readMiddleHigh(stream, level === 0, process);
  return process;
}

/**
 * A running package (an actor's current package or the middle-high process's other one): the
 * package, for a package the game made its own definition, its running data by kind, its
 * counters and its target.
 */
function readActorPackage(stream: PathingStream): EssActorPackage | undefined {
  const reader = stream.reader;
  const pkg = stream.form();
  if (pkg === 0) return undefined;
  if (pkg >>> 0 >= 0xff000000) {
    // A package the game made writes its procedure type (−1: none) and then its definition.
    const procedure = reader.i8();
    if (procedure !== -1) readCreatedPackage(stream, procedure);
  }
  const kind = reader.u8();
  const data = kind === 0xff ? {} : readPackageData(stream, kind);
  const values = [reader.u32(), reader.f32(), reader.u32()];
  reader.u16();
  reader.u8();
  reader.u8();
  return { package: pkg, ...data, values, target: stream.form() };
}

/** The procedure types of the packages the game makes, as their definitions save them. */
const CreatedProcedure = {
  dialogue: 15,
  inGameDialogue: 28,
  alarm: 21,
  flee: 22,
  trespass: 23,
  spectator: 24,
} as const;

/**
 * A package the game made (an alarm, a flee, a trespass warning, a spectator's, a dialogue's):
 * its PKDT, which of location, target and data follow (bits 1, 2, 4), those, a u32, then what
 * its kind adds, as observed in the original. Its kind is its PKDT's type (the byte after the
 * flags): the AI process writes it before the definition too, a PACK change form does not.
 * Returns the package's type.
 */
export function readCreatedPackage(stream: PathingStream, procedure?: number): number {
  const reader = stream.reader;
  const ref = (): void => {
    stream.form();
  };
  const type = reader.bytes(12)[4] ?? 0;
  const parts = reader.u8();
  if (parts & 1) readPackageLocation(stream);
  if (parts & 2) readPackageTarget(stream);
  if (parts & 4) readPackageDefinitionData(stream, type);
  reader.u32();
  switch (procedure ?? type) {
    case CreatedProcedure.alarm:
      // The crimes it is about: a type byte and its game hour (u16) each; a switch.
      reader.skip(3 * reader.vsval());
      reader.u8();
      return type;
    case CreatedProcedure.dialogue:
    case CreatedProcedure.inGameDialogue:
      ref();
      ref();
      ref();
      reader.skip(2);
      return type;
    case CreatedProcedure.flee:
      reader.skip(2 + 12 + 4 + 3);
      ref();
      ref();
      for (let n = reader.vsval(), i = 0; i < n; i++) ref();
      return type;
    case CreatedProcedure.trespass:
      reader.skip(5 * 4);
      ref();
      return type;
    case CreatedProcedure.spectator:
      reader.skip(4 * 4 + 1 + 12);
      // What it watches: values, times, two points, two switches, two references each.
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        reader.skip(3 * 4 + 12 + 12 + 2);
        ref();
        ref();
      }
      return type;
    default:
      return type;
  }
}

/** What a running package's own data says, as far as it is kept. */
export type EssPackageData = Pick<
  EssActorPackage,
  'dataKind' | 'dataTarget' | 'parameters' | 'procedure' | 'procedureState'
>;

/**
 * A running package's own data by its kind (`PackageDataKind`), as an actor's process and a
 * reference's PackageData extra write it.
 */
export function readPackageData(stream: PathingStream, kind: number): EssPackageData {
  const out: { -readonly [K in keyof EssPackageData]: EssPackageData[K] } = { dataKind: kind };
  readPackageDataInto(stream, kind, out);
  return out;
}

function readPackageDataInto(
  stream: PathingStream,
  kind: number,
  out: { -readonly [K in keyof EssPackageData]: EssPackageData[K] },
): void {
  const reader = stream.reader;
  switch (kind) {
    case PackageDataKind.escort:
      out.dataTarget = stream.form();
      return;
    case PackageDataKind.sandbox: {
      // Its timers and switches, then three references (the activity it is at and what it
      // uses), then the places it found to go (a position and a reference each).
      reader.skip(8 * 4 + 4 + 4 + 1);
      reader.u32(); // a frame count kept relative to the save's
      reader.skip(4 * 4 + 7);
      stream.form();
      stream.form();
      stream.form();
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        reader.skip(12);
        stream.form();
      }
      return;
    }
    case PackageDataKind.patrol:
      readPatrolData(stream);
      return;
    case PackageDataKind.guard: {
      reader.skip(3 * 4);
      out.dataTarget = stream.form();
      reader.skip(3 * 4);
      reader.u8();
      if (reader.u8() !== 0) readPackageTarget(stream);
      return;
    }
    case PackageDataKind.useWeapon:
      return;
    case PackageDataKind.custom: {
      // The parameters whose value the running package changed (a package of a plugin writes
      // the ones that differ from the package's, one the game made all of them): an index,
      // the type's name and its value.
      const parameters: EssPackageValue[] = [];
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        const index = reader.u8();
        const type = reader.wstring();
        readPackageValue(stream, type);
        parameters.push({ index, type });
      }
      out.parameters = parameters;
      // The procedure tree's running state: its execution state's name, then its data.
      const name = reader.wstring();
      out.procedure = name;
      if (name !== '') out.procedureState = readExecState(stream, name);
      return;
    }
    default:
      throw new ProcessUnknown(`package data of kind ${String(kind)}`);
  }
}

/**
 * A package definition's own data (TESPackageData) as a package the game made writes it, by
 * the package's type, as observed in the original: the type gives the data its class when the
 * package is made, and each class writes its own fields; an optional location or target is a
 * byte that says it follows. The custom and template packages' (18, 19) write nothing; the
 * other types have none.
 */
function readPackageDefinitionData(stream: PathingStream, type: number): void {
  const reader = stream.reader;
  const location = (): void => {
    if (reader.u8() !== 0) readPackageLocation(stream);
  };
  switch (type) {
    case 1: // follow
    case 2: // escort
      reader.u32();
      location();
      return;
    case 3: // eat
    case 8: // use an item at
    case 9: // ambush
      location();
      return;
    case 13: // patrol: two switches
      reader.skip(2);
      return;
    case 15: // dialogue
    case 28: // in-game dialogue
      reader.u32();
      reader.skip(3);
      reader.u32();
      reader.u8();
      reader.u32();
      stream.form();
      location();
      return;
    case 16: // use a weapon: switches, three u16, two u32, a reference, a target, a location
      reader.skip(6 + 3 * 2 + 2 * 4);
      stream.form();
      if (reader.u8() !== 0) readPackageTarget(stream);
      location();
      return;
    case 18: // custom
    case 19: // template
      return;
    default:
      throw new ProcessUnknown(`package data of a package of type ${String(type)}`);
  }
}

/** A package target as its data writes it: a kind byte, a u32, then by kind. */
function readPackageTarget(stream: PathingStream): void {
  const reader = stream.reader;
  const kind = reader.u8();
  reader.u32();
  switch (kind) {
    case 0: // a reference
    case 1: // a base object
    case 3: // a form list
      stream.form();
      return;
    case 2: // an object type
    case 4: // an alias
    case 5: // a linked reference's keyword index
      reader.u32();
      return;
    default:
      throw new ProcessUnknown(`package target of kind ${String(kind)}`);
  }
}

/** A custom package parameter's running value by its type's name. */
function readPackageValue(stream: PathingStream, type: string): void {
  const reader = stream.reader;
  switch (type) {
    case 'Bool':
      reader.u8();
      return;
    case 'Int':
    case 'Float':
      reader.u32();
      return;
    case 'SingleRef':
      readPackageTarget(stream);
      return;
    case 'ObjectList':
      // Its items: the reference it found, the object, and four values (counts, distances).
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        stream.form();
        stream.form();
        reader.skip(4 * 4);
      }
      return;
    case 'Location':
      readPackageLocation(stream);
      return;
    case 'LocWrapper':
      readWorldLocation(stream);
      return;
    case 'TargetSelector':
    case 'Topic':
    case 'Ref':
      return;
    default:
      throw new ProcessUnknown(`package parameter of type ${type}`);
  }
}

/** A package location (PLDT): its kind, radius, then by kind a reference, a form or a value. */
function readPackageLocation(stream: PathingStream): void {
  const reader = stream.reader;
  const kind = reader.u8();
  reader.u32();
  if (kind <= 4) stream.form();
  else if (kind === 5 || (kind >= 8 && kind <= 10)) reader.u32();
  else if (kind === 11) reader.u8();
}

/**
 * A place a procedure goes to (when the byte before it says there is one): its kind's name,
 * then a reference with a radius (LocRef), a point with its cell and radius (LocPt) or an
 * interior cell with a point (LocCell).
 */
function readWorldLocation(stream: PathingStream): void {
  const reader = stream.reader;
  if (reader.u8() === 0) return;
  const name = reader.wstring();
  switch (name) {
    case 'LocRef':
      stream.form();
      reader.skip(3 * 4 + 1);
      return;
    case 'LocPt':
      reader.skip(12);
      stream.form();
      stream.form();
      reader.skip(4 + 4 + 1 + 1);
      return;
    case 'LocCell':
      stream.form();
      reader.skip(12);
      return;
    default:
      throw new ProcessUnknown(`world location ${name}`);
  }
}

/** A dialogue target: a kind u32, then a reference (kind 0) or a value. */
function readDialogueTarget(stream: PathingStream): void {
  if (stream.reader.u32() === 0) stream.form();
  else stream.reader.u32();
}

/** A procedure's running state the one around it always has (no name: its kind is fixed). */
function readNested(stream: PathingStream, name: string): void {
  if (stream.reader.u8() !== 0) readExecState(stream, name);
}

/** A child procedure's state: its name ('' when none), then its state. */
function readChild(stream: PathingStream): EssProcedureState | undefined {
  const name = stream.reader.wstring();
  return name === '' ? undefined : readExecState(stream, name);
}

/**
 * A procedure tree item's running state by its name, as observed in the original: the tree's
 * branches (Sequence, Stacked, Simultaneous, Random) hold their children's states, each
 * procedure keeps its own (where it goes, what it uses, the pathing request it waits on).
 */
function readExecState(stream: PathingStream, name: string): EssProcedureState {
  const reader = stream.reader;
  switch (name) {
    case 'Sequence':
    case 'Stacked':
    case 'Random': {
      const child = readChild(stream);
      const index = reader.u32();
      if (name === 'Random') reader.skip(4 * reader.vsval());
      return { name, index, ...(child && { child }) };
    }
    case 'Simultaneous': {
      const children: { index: number; state?: EssProcedureState }[] = [];
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        const index = reader.u32();
        const state = readChild(stream);
        children.push({ index, ...(state && { state }) });
      }
      return { name, children };
    }
    default:
      readProcedureState(stream, name);
      return { name };
  }
}

/** A procedure's own running state (not a branch's), by its name. */
function readProcedureState(stream: PathingStream, name: string): void {
  const reader = stream.reader;
  const ref = (): void => {
    stream.form();
  };
  switch (name) {
    case 'Acquire':
      reader.u32();
      ref();
      reader.u32();
      ref();
      readNested(stream, 'Activate');
      return;
    case 'Activate':
      reader.u8(); // the package parameter it uses (0xFF: none)
      ref();
      readWorldLocation(stream);
      reader.skip(4 + 4 + 1 + 1);
      stream.request();
      return;
    case 'DialogueActivate':
      readWorldLocation(stream);
      readWorldLocation(stream);
      ref();
      readDialogueTarget(stream);
      readNested(stream, 'Dialogue');
      reader.u8();
      stream.request();
      return;
    case 'Dialogue':
      reader.u32();
      ref();
      ref();
      readDialogueTarget(stream);
      reader.u8();
      return;
    case 'Done':
      return;
    case 'Eat':
      ref();
      reader.skip(4 + 1 + 1);
      return;
    case 'Escort':
      readWorldLocation(stream);
      for (let n = reader.vsval(), i = 0; i < n; i++) ref();
      reader.skip(2);
      stream.request();
      reader.skip(4 + 1 + 4 + 4);
      return;
    case 'Find':
      readWorldLocation(stream);
      reader.u32();
      return;
    case 'Flee':
      readWorldLocation(stream);
      readNested(stream, 'Travel');
      reader.skip(12 + 6 * 4);
      for (let n = reader.vsval(), i = 0; i < n; i++) ref();
      ref();
      ref();
      reader.skip(4);
      stream.request();
      return;
    case 'FlightGrab':
      ref();
      stream.request();
      reader.skip(2);
      return;
    case 'Follow':
      ref();
      readWorldLocation(stream);
      readWorldLocation(stream);
      readWorldLocation(stream);
      reader.skip(3 * 4);
      stream.request();
      reader.skip(5);
      return;
    case 'Guard':
    case 'HoldPosition':
      readWorldLocation(stream);
      return;
    case 'Hover':
      readWorldLocation(stream);
      reader.u8();
      return;
    case 'KeepAnEyeOn':
      readWorldLocation(stream);
      readWorldLocation(stream);
      return;
    case 'LockUnlock':
      readWorldLocation(stream);
      reader.skip(2);
      return;
    case 'Orbit':
      reader.u8();
      readWorldLocation(stream);
      reader.u8();
      return;
    case 'Patrol': {
      reader.u32();
      // The patrol's running data (as a patrol package's own), then its idle marker's and
      // furniture's procedures.
      readPatrolData(stream);
      readNested(stream, 'UseIdleMarker');
      readNested(stream, 'SitSleep');
      stream.request();
      reader.skip(3);
      return;
    }
    case 'Sandbox':
      reader.skip(4 * 4 + 1 + STAMP + 4 + STAMP + 4 + 4 + 1 + 4 * 4 + 4 + 7);
      ref();
      ref();
      ref();
      for (let n = reader.vsval(), i = 0; i < n; i++) {
        reader.skip(12);
        ref();
      }
      readWorldLocation(stream);
      readChild(stream);
      reader.u32();
      stream.request();
      reader.skip(4 + 1);
      return;
    case 'Say':
      reader.u8();
      return;
    case 'Shout':
      readWorldLocation(stream);
      readNested(stream, 'Travel');
      ref();
      reader.u32();
      ref();
      reader.skip(3 * 4);
      ref();
      return;
    case 'SitSleep':
      reader.u8(); // the package parameter it uses (0xFF: none)
      reader.u8();
      readNested(stream, 'Activate');
      return;
    case 'Travel':
      reader.skip(3);
      readWorldLocation(stream);
      reader.u8(); // the package parameter it uses (0xFF: none)
      stream.request();
      return;
    case 'UseIdleMarker':
      reader.u8();
      ref();
      ref();
      reader.u32();
      stream.request();
      reader.u8();
      return;
    case 'UseMagic':
      readWorldLocation(stream);
      readWorldLocation(stream);
      readNested(stream, 'Travel');
      ref();
      reader.skip(2 * 4);
      ref();
      ref();
      reader.skip(2 + 4 * 4);
      return;
    case 'UseWeapon':
      readWorldLocation(stream);
      readWorldLocation(stream);
      readNested(stream, 'Travel');
      ref();
      reader.u32();
      ref();
      reader.skip(3 * 2 + 4);
      return;
    case 'Wait':
      reader.u32();
      return;
    case 'Wander':
      readWorldLocation(stream);
      reader.skip(4 + 1 + 4);
      stream.request();
      return;
    default:
      throw new ProcessUnknown(`procedure state ${name}`);
  }
}

/** A patrol's running data: switches, then its points in order. */
function readPatrolData(stream: PathingStream): void {
  const reader = stream.reader;
  reader.skip(3 * 4 + 1 + 1 + 4);
  for (let n = reader.vsval(), i = 0; i < n; i++) stream.form();
}

/** The middle-high process's part (and, when `high`, the high process's inside it). */
function readMiddleHigh(
  stream: PathingStream,
  high: boolean,
  process: { -readonly [K in keyof EssProcess]: EssProcess[K] },
): void {
  const reader = stream.reader;
  const ref = (): number => stream.form();
  // Switches, timers, positions.
  reader.skip(3 * 4 + 1 + 12 + 4 + 4 + 3 + 4 + 1 + 4 + 4 + 2 + 2 + 4 + 1 + 4 + 4 + 3);
  ref();
  ref();
  ref();
  ref();
  ref();
  reader.skip(12 + 4 + 1 + 4);
  reader.u32(); // a form id as is
  for (let n = reader.vsval(), i = 0; i < n; i++) ref();
  const pushed = readActorPackage(stream);
  if (pushed) process.pushedPackage = pushed;
  // The objects it knows (each: the reference, a byte, a vsval, then its data sized in bytes).
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    ref();
    reader.u8();
    reader.vsval();
    reader.skip(reader.vsval());
  }
  ref();
  // The items it has equipped by hand: the item, its slot, a byte, then its extra data.
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    ref();
    reader.u32();
    reader.u8();
    reader.u32();
    ref();
    ref();
    reader.skip(5);
  }
  reader.skip(3 * 4);
  ref();
  reader.skip(4 + 4 + 1 + 4 + 7);
  if (high) readHigh(stream, process);
  reader.u8();
}

/** The high process's part. */
function readHigh(
  stream: PathingStream,
  process: { -readonly [K in keyof EssProcess]: EssProcess[K] },
): void {
  const reader = stream.reader;
  const ref = (): number => stream.form();
  reader.skip(3 + 2 + 9 * 4 + 3 * 2 + 1 + 12 + 12 + 6 * 4);
  reader.skip(1 + 4 + 1 + 4 + 1 + 4 + 4 + 1 + 4 + 3 * 4 + 1 + 1 + 4 + 4 + 1 + 1 + 4 + 4 + 1);
  reader.skip(4 * 4 + 3 + 4 + 1 + 1 + 4 + 1 + 1);
  for (let i = 0; i < 8; i++) ref();
  // Six held objects with a byte each.
  for (let i = 0; i < 6; i++) {
    ref();
    reader.u8();
  }
  // The dialogue it is in: its lines (two names, numbers, three references), a position and
  // four references.
  if (reader.u8() !== 0) {
    for (let n = reader.vsval(), i = 0; i < n; i++) {
      reader.wstring();
      reader.wstring();
      reader.skip(4 + 4 + 1);
      ref();
      ref();
      ref();
      reader.u8();
    }
    reader.u16();
    for (let i = 0; i < 4; i++) ref();
  }
  // Points it was told to go through, through the pathing stream.
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    stream.floats(8);
    reader.u32();
    reader.u32();
    ref();
  }
  if (reader.u8() !== 0) {
    reader.u32();
    reader.skip(12);
    reader.skip(STAMP);
    ref();
  }
  // The character controller's state, sized in bytes.
  reader.skip(reader.vsval());
  reader.u8();
  reader.u8();
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    reader.u32();
    reader.u32();
    ref();
    ref();
  }
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    ref();
    ref();
    ref();
    reader.u32();
    reader.skip(STAMP);
    if (reader.u8() !== 0) reader.skip(4 + 3 + 3 * 12 + 3 * STAMP);
  }
  reader.u32();
  ref();
  reader.skip(6 * 4 + 1 + 4 + 4 + 2 * STAMP);
  ref();
  ref();
  reader.wstring();
  if (reader.u8() !== 0) {
    // Loaded: its animation callbacks and the extra graphs' states.
    reader.u8();
    reader.u8();
    if (reader.u8() !== 0) {
      reader.wstring();
      reader.u32();
    }
    if (reader.u8() !== 0) reader.wstring();
    for (let i = 3; i < PROCESS_GRAPHS; i++) {
      readGraphState(reader);
      process.graphStates++;
    }
    reader.skip(2 + 2 + 4 + 1);
  }
  reader.skip(5 + 4 + 1 + 1 + 4);
  ref();
  ref();
  reader.skip(TIMER + 1 + 1);
  ref();
  reader.skip(1 + 1 + 4 + STAMP + 1 + 1);
}
