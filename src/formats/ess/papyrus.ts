// The Papyrus global data (type 1001) of an .ess save (docs/formats/ess.md; xEdit's "Papyrus
// Struct", UESP): the string table, the script types and their variables, the script
// instances (objects) and detached objects, the arrays, the active stacks' ids, then each
// object's variables and each array's elements, each running stack with its frames (the
// function's code included), the function messages and suspended stacks, and the game's own
// script registrations (waits, updates, sleep and stats events, inventory filters, animation
// events). Platform-independent.

import { FormatError } from '../binary-reader.ts';
import { PEX_OPCODES, type PexFunction, type PexInstruction, type PexValue } from '../pex/pex.ts';
import { EssReader, type RawRefId } from './ess-reader.ts';

/** A Papyrus value's type byte. */
export const PapyrusType = {
  Null: 0,
  Object: 1,
  String: 2,
  Int: 3,
  Float: 4,
  Bool: 5,
  ObjectArray: 11,
  StringArray: 12,
  IntArray: 13,
  FloatArray: 14,
  BoolArray: 15,
} as const;
export type PapyrusType = (typeof PapyrusType)[keyof typeof PapyrusType];

type T = typeof PapyrusType;

export type EssVariable =
  | { readonly type: T['Null'] }
  /** An object: its script type's name and its VM object handle (0: None). */
  | { readonly type: T['Object']; readonly script: string; readonly handle: number }
  | { readonly type: T['String']; readonly value: string }
  | { readonly type: T['Int'] | T['Float']; readonly value: number }
  | { readonly type: T['Bool']; readonly value: boolean }
  /** An array by its handle (in `arrays`); the element script for object arrays. */
  | {
      readonly type:
        T['ObjectArray'] | T['StringArray'] | T['IntArray'] | T['FloatArray'] | T['BoolArray'];
      readonly array: number;
      readonly script?: string;
    };

export interface EssScriptType {
  readonly name: string;
  /** Its parent script's name ('' for none). */
  readonly parent: string;
  readonly members: readonly { readonly name: string; readonly type: string }[];
}

/** A script instance: the VM's handle for it, its script, and the game object it is on. */
export interface EssObject {
  readonly handle: number;
  readonly script: string;
  /** The 16 bits before the reference id (UESP "unknown2bits"). */
  readonly flags: number;
  /** The game handle's high word: an alias's id (−1 on a form, in every save read). */
  readonly high: number;
  readonly refId: RawRefId;
  readonly unknown: number;
}

export interface EssArrayInfo {
  readonly handle: number;
  readonly type: PapyrusType;
  readonly script?: string;
  readonly length: number;
}

export interface EssObjectData {
  readonly handle: number;
  readonly flags: number;
  /** The state the script instance is in ('': the empty state). */
  readonly state: string;
  readonly unknown1: number;
  readonly unknown2?: number;
  readonly variables: readonly EssVariable[];
}

export interface EssPapyrus {
  readonly version: number;
  readonly strings: readonly string[];
  readonly types: readonly EssScriptType[];
  readonly objects: readonly EssObject[];
  readonly detached: readonly { readonly handle: number; readonly script: string }[];
  readonly arrays: readonly EssArrayInfo[];
  readonly nextActiveScriptId: number;
  readonly stacks: readonly { readonly id: number; readonly type: number }[];
  readonly objectData: readonly EssObjectData[];
  /** Each array's elements, by its handle. */
  readonly arrayData: ReadonlyMap<number, readonly EssVariable[]>;
  /** Each running stack's data, in the stack table's order. */
  readonly stackData: readonly EssStack[];
  readonly functionMessages: readonly EssFunctionMessage[];
  /** The VM's two suspended stack tables. */
  readonly suspendedStacks: readonly [readonly EssSuspendedStack[], readonly EssSuspendedStack[]];
  /** What follows the VM's own data: the game's script registrations. */
  readonly registrations: EssPapyrusRegistrations;
  /** Bytes after the registrations (none in a well-formed save). */
  readonly unread: number;
}

/**
 * A game object as the save names it outside the object table: the handle's type word and
 * high word (a form: −1; an alias: its id) and the reference id. The object table writes the
 * same seven bytes and one more.
 */
export interface EssGameHandle {
  readonly flags: number;
  readonly high: number;
  readonly refId: RawRefId;
}

/** A frame of a running stack: the function it runs (with its code) and where it stands. */
export interface EssFrame {
  readonly flags: number;
  /** 0: a function; else a property's getter or setter (no state name then). */
  readonly functionType: number;
  readonly script: string;
  /** The script the function was found on (a parent of `script` for an inherited one). */
  readonly baseScript: string;
  readonly functionName: string;
  /** The state the function belongs to (functions only, when flags bit 0 is clear). */
  readonly state?: string;
  readonly opcodeVersion: readonly [number, number];
  readonly function: PexFunction;
  /** The instruction to run next. */
  readonly instruction: number;
  /** The object the function runs on (Self). */
  readonly self: EssVariable;
  /** The parameters' and locals' values. */
  readonly variables: readonly EssVariable[];
}

/** What a stack started by the game reports back when it ends (a fragment's caller). */
export interface EssStackCallback {
  /** 'QuestStage', 'SceneResults', 'ScenePhaseResults', 'SceneActionResults', 'TopicInfo'. */
  readonly type: string;
  readonly refId?: RawRefId;
  readonly values: readonly number[];
}

export interface EssStack {
  readonly id: number;
  readonly majorVersion: number;
  readonly minorVersion: number;
  /** The value the stack returns (or None). */
  readonly returnValue: EssVariable;
  readonly flags: number;
  readonly unknown: number;
  readonly unknown2?: number;
  readonly callback?: EssStackCallback;
  readonly callbackValue?: EssVariable;
  readonly frames: readonly EssFrame[];
  readonly tail?: number;
}

/** A queued call: the script, the function and its arguments (function messages, suspended). */
export interface EssQueuedCall {
  readonly unknown: number;
  readonly script: string;
  readonly functionName: string;
  readonly self: EssVariable;
  readonly args: readonly EssVariable[];
}

export interface EssFunctionMessage {
  readonly unknown: number;
  readonly id: number;
  readonly call?: EssQueuedCall;
}

export interface EssSuspendedStack {
  readonly id: number;
  readonly call?: EssQueuedCall;
}

/** An OnUpdate or OnUpdateGameTime registration. */
export interface EssUpdateEvent {
  /** RegisterForSingleUpdate (true) or RegisterForUpdate's repeating one (false). */
  readonly single: boolean;
  /** When it is sent, in the VM's clock (ms of real time or game time × 1000). */
  readonly time: number;
  /** The interval it was registered with. */
  readonly interval: number;
  readonly handle: EssGameHandle;
}

/** A queued latent function's work (MoveTo, Enable, AddItem, ...): its type and its data. */
export interface EssFunctor {
  readonly type: number;
  readonly data: readonly (number | string)[];
}

/** The game's script registrations, in the order the original writes them. */
export interface EssPapyrusRegistrations {
  /** Before the queued unbinds: u32, and a second when the first is not 0. */
  readonly unknown: readonly number[];
  readonly unknownIds: readonly number[];
  readonly queuedUnbinds: readonly { readonly handle: number; readonly unknown: number }[];
  /** The registrations' own version (5 in Special Edition saves). */
  readonly version: number;
  /** Utility.Wait, WaitMenuMode and WaitGameTime calls: the stack and when it resumes. */
  readonly waits: readonly (readonly { readonly stack: number; readonly time: number }[])[];
  readonly updates: readonly EssUpdateEvent[];
  readonly gameTimeUpdates: readonly EssUpdateEvent[];
  /** Debug.OpenUserLog's open logs. */
  readonly userLogs: readonly string[];
  /** The four queues of latent functions' work (render-safe and post-render, two each). */
  readonly functors: readonly (readonly EssFunctor[])[];
  /** RegisterForLOS: viewer, target, the event type and the last check's result. */
  readonly losEvents: readonly {
    readonly viewer: RawRefId;
    readonly target: RawRefId;
    readonly type: number;
    readonly last: number;
  }[];
  readonly sleepEvents: readonly EssGameHandle[];
  readonly trackedStatsEvents: readonly EssGameHandle[];
  /** AddInventoryEventFilter: per handle, the items and the item lists that pass. */
  readonly inventoryFilters: readonly {
    readonly handle: EssGameHandle;
    readonly items: readonly RawRefId[];
    readonly lists: readonly RawRefId[];
  }[];
  readonly unknown06: readonly { readonly refId: RawRefId; readonly value: number }[];
  /** RegisterForAnimationEvent: per reference, each event and the handles waiting on it. */
  readonly animationEvents: readonly {
    readonly refId: RawRefId;
    readonly events: readonly {
      readonly name: string;
      readonly pairs: readonly (readonly [number, number])[];
      readonly handles: readonly EssGameHandle[];
    }[];
  }[];
  readonly unknown08: readonly (readonly [number, number])[];
  /** Three lists by reference whose meaning is not documented (empty in the saves seen). */
  readonly unknown09: readonly [
    readonly { readonly refId: RawRefId; readonly entries: readonly (readonly number[])[] }[],
    readonly {
      readonly refId: RawRefId;
      readonly entries: readonly {
        readonly id: number;
        readonly values: readonly number[];
        readonly flags: readonly (readonly [number, boolean])[];
        readonly last: number;
      }[];
    }[],
    readonly { readonly refId: RawRefId; readonly entries: readonly (readonly number[])[] }[],
  ];
  readonly unknown0A: readonly { readonly id: number; readonly values: readonly number[] }[];
}

/**
 * The fields each latent function's queued work holds, by its type (xEdit's layouts; no save
 * seen holds one: TODO(M13) check against one): u a u32 (the waiting stack), r a reference
 * id, b a byte, s a string with a u32 length. MoveTo has one byte more from registration
 * version 2.
 */
const FUNCTOR_FIELDS: readonly string[] = [
  'urruuuuuub', // 0 MoveTo
  'ur', // 1 MoveToOwnEditorLoc
  'uru', // 2 DamageObject
  'urb', // 3 Enable
  'urb', // 4 Disable
  'ur', // 5 Delete
  'uruuu', // 6 SetPosition
  'uruuu', // 7 SetAngle
  'urbbb', // 8 SetMotionType
  'ur', // 9 NonLatentDelete
  'ur', // 10 MoveToPackLoc
  'uru', // 11 SetScale
  'uru', // 12 DropObject
  'urr', // 13 Tether
  'urr', // 14 AttachAshPile
  'urrssb', // 15 AddRemoveConstraint
  'urb', // 16 ForceAddRemoveRagdoll
  'uru', // 17 ApplyHavokImpulse
  'urr', // 18 Reset
  'urb', // 19 SendPlayerToJail
  'urrb', // 20 AddItem
  'ur', // 21 Resurrect
  'urrrr', // 22 Cast
  'urrr', // 23 ScrollCast
  'urrrb', // 24 RemoveItem
];

/**
 * Reads the Papyrus data. `specialEdition` (header version 12): the string table's count and
 * every index into it are u32 rather than u16, and the VM's object and array handles are u64
 * rather than u32 (read as numbers: they stay below 2^53).
 */
export function readPapyrus(data: Uint8Array, specialEdition = true): EssPapyrus {
  const reader = new EssReader(data);
  const version = reader.u16();
  if (version === 0xffff) throw new FormatError('The save marks its Papyrus data invalid', 0);
  const strings: string[] = [];
  const stringCount = specialEdition ? reader.u32() : reader.u16();
  for (let i = 0; i < stringCount; i++) strings.push(reader.wstring());
  const string = (): string => {
    const at = reader.offset;
    const index = specialEdition ? reader.u32() : reader.u16();
    const value = strings[index];
    if (value === undefined)
      throw new FormatError(`String ${String(index)} is not in the table`, at);
    return value;
  };
  const vmId = (): number =>
    specialEdition ? reader.u32() + reader.u32() * 2 ** 32 : reader.u32();
  const types: EssScriptType[] = [];
  const typeCount = reader.u32();
  for (let i = 0; i < typeCount; i++) {
    const name = string();
    const parent = string();
    const memberCount = reader.u32();
    const members: { name: string; type: string }[] = [];
    for (let j = 0; j < memberCount; j++) members.push({ name: string(), type: string() });
    types.push({ name, parent, members });
  }
  const objects: EssObject[] = [];
  const objectCount = reader.u32();
  for (let i = 0; i < objectCount; i++) {
    const handle = vmId();
    const script = string();
    const flags = reader.u16();
    const high = reader.i16();
    objects.push({ handle, script, flags, high, refId: reader.refId(), unknown: reader.u8() });
  }
  const detached: { handle: number; script: string }[] = [];
  const detachedCount = reader.u32();
  for (let i = 0; i < detachedCount; i++) detached.push({ handle: vmId(), script: string() });
  const arrays: EssArrayInfo[] = [];
  const arrayCount = reader.u32();
  for (let i = 0; i < arrayCount; i++) {
    const handle = vmId();
    const type = reader.u8() as PapyrusType;
    const script = type === PapyrusType.Object ? string() : undefined;
    arrays.push({ handle, type, ...(script !== undefined && { script }), length: reader.u32() });
  }
  const nextActiveScriptId = reader.u32();
  const stacks: { id: number; type: number }[] = [];
  const stackCount = reader.u32();
  for (let i = 0; i < stackCount; i++) stacks.push({ id: reader.u32(), type: reader.u8() });

  const variable = (): EssVariable => {
    const at = reader.offset;
    const type = reader.u8() as PapyrusType;
    switch (type) {
      case PapyrusType.Null:
        reader.u32();
        return { type };
      case PapyrusType.Object:
        return { type, script: string(), handle: vmId() };
      case PapyrusType.String:
        return { type, value: string() };
      case PapyrusType.Int:
        return { type, value: reader.i32() };
      case PapyrusType.Float:
        return { type, value: reader.f32() };
      case PapyrusType.Bool:
        return { type, value: reader.u32() !== 0 };
      case PapyrusType.ObjectArray:
        return { type, script: string(), array: vmId() };
      case PapyrusType.StringArray:
      case PapyrusType.IntArray:
      case PapyrusType.FloatArray:
      case PapyrusType.BoolArray:
        return { type, array: vmId() };
      default:
        throw new FormatError(`Unknown Papyrus value type ${String(type)}`, at);
    }
  };

  const objectData: EssObjectData[] = [];
  for (let i = 0; i < objectCount + detachedCount; i++) {
    const handle = vmId();
    const flags = reader.u8();
    const state = string();
    const unknown1 = reader.u32();
    const unknown2 = (flags & 4) !== 0 ? reader.u32() : undefined;
    const memberCount = reader.u32();
    const variables: EssVariable[] = [];
    for (let j = 0; j < memberCount; j++) variables.push(variable());
    objectData.push({
      handle,
      flags,
      state,
      unknown1,
      ...(unknown2 !== undefined && { unknown2 }),
      variables,
    });
  }
  const lengths = new Map(arrays.map((array) => [array.handle, array.length]));
  const arrayData = new Map<number, EssVariable[]>();
  for (let i = 0; i < arrayCount; i++) {
    const handle = vmId();
    const length = lengths.get(handle);
    if (length === undefined) {
      throw new FormatError(`Array ${String(handle)} is not in the array table`, reader.offset - 4);
    }
    const elements: EssVariable[] = [];
    for (let j = 0; j < length; j++) elements.push(variable());
    arrayData.set(handle, elements);
  }

  const list = <V>(item: () => V): V[] => {
    const count = reader.u32();
    const items: V[] = [];
    for (let i = 0; i < count; i++) items.push(item());
    return items;
  };
  const lengthString = (): string => {
    const bytes = reader.bytes(reader.u32());
    return String.fromCharCode(...bytes);
  };
  const gameHandle = (): EssGameHandle => ({
    flags: reader.u16(),
    high: reader.i16(),
    refId: reader.refId(),
  });
  // A frame's function: as a compiled script writes it, with the save's string indices.
  const codeValue = (): PexValue => {
    const at = reader.offset;
    const type = reader.u8();
    switch (type) {
      case 0:
        return { kind: 'none' };
      case 1:
        return { kind: 'identifier', name: string() };
      case 2:
        return { kind: 'string', value: string() };
      case 3:
        return { kind: 'int', value: reader.i32() };
      case 4:
        return { kind: 'float', value: reader.f32() };
      case 5:
        return { kind: 'bool', value: reader.u8() !== 0 };
      default:
        throw new FormatError(`Unknown code value type ${String(type)}`, at);
    }
  };
  const typedList = (): { name: string; type: string }[] => {
    const count = reader.u16();
    const items: { name: string; type: string }[] = [];
    for (let i = 0; i < count; i++) items.push({ name: string(), type: string() });
    return items;
  };
  const readFunction = (): PexFunction => {
    const returnType = string();
    const docString = string();
    const userFlags = reader.u32();
    const flags = reader.u8();
    const params = typedList();
    const locals = typedList();
    const code: PexInstruction[] = [];
    const codeCount = reader.u16();
    for (let i = 0; i < codeCount; i++) {
      const at = reader.offset;
      const opcode = PEX_OPCODES[reader.u8()];
      if (!opcode) throw new FormatError('Unknown opcode in a stack frame', at);
      const args: PexValue[] = [];
      for (let j = 0; j < opcode.args; j++) args.push(codeValue());
      if ('varargs' in opcode) {
        const count = codeValue();
        if (count.kind !== 'int') throw new FormatError('Argument count is not an int', at);
        for (let j = 0; j < count.value; j++) args.push(codeValue());
      }
      code.push({ op: opcode.name, args });
    }
    return {
      returnType,
      docString,
      userFlags,
      global: (flags & 1) !== 0,
      native: (flags & 2) !== 0,
      params,
      locals,
      code,
    };
  };
  const frame = (): EssFrame => {
    const variableCount = reader.u32();
    const flags = reader.u8();
    const functionType = reader.u8();
    const script = string();
    const baseScript = string();
    const functionName = string();
    const state = (flags & 1) === 0 && functionType === 0 ? string() : undefined;
    const opcodeVersion = [reader.u8(), reader.u8()] as const;
    const fn = readFunction();
    const instruction = reader.u32();
    const self = variable();
    const values: EssVariable[] = [];
    for (let i = 0; i < variableCount; i++) values.push(variable());
    return {
      flags,
      functionType,
      script,
      baseScript,
      functionName,
      ...(state !== undefined && { state }),
      opcodeVersion,
      function: fn,
      instruction,
      self,
      variables: values,
    };
  };
  const callback = (): EssStackCallback => {
    const type = lengthString();
    switch (type) {
      case 'QuestStage':
        return { type, refId: reader.refId(), values: [reader.u16(), reader.u8()] };
      case 'ScenePhaseResults':
      case 'SceneActionResults':
        return { type, refId: reader.refId(), values: [reader.u32()] };
      case 'SceneResults':
        return { type, refId: reader.refId(), values: [] };
      case 'TopicInfo':
        return { type, values: [] };
      default:
        throw new FormatError(`Unknown stack callback ${type}`, reader.offset);
    }
  };
  const stackData: EssStack[] = [];
  for (let i = 0; i < stackCount; i++) {
    const id = reader.u32();
    const majorVersion = reader.u8();
    const minorVersion = reader.u8();
    const returnValue = variable();
    const flags = reader.u8();
    const unknown = reader.u8();
    const unknown2 = (flags & 1) !== 0 ? reader.u32() : undefined;
    const kind = reader.u8();
    const call = kind === 1 || kind === 3 ? callback() : undefined;
    const callbackValue = kind === 2 || kind === 3 ? variable() : undefined;
    const frames = list(frame);
    // The trailing byte: only with flags bit 1 and not bit 0 (xEdit's rule).
    const tail = (flags & 1) === 0 && (flags & 2) !== 0 ? reader.u8() : undefined;
    stackData.push({
      id,
      majorVersion,
      minorVersion,
      returnValue,
      flags,
      unknown,
      ...(unknown2 !== undefined && { unknown2 }),
      ...(call && { callback: call }),
      ...(callbackValue && { callbackValue }),
      frames,
      ...(tail !== undefined && { tail }),
    });
  }
  const queuedCall = (): EssQueuedCall | undefined => {
    if (reader.u8() === 0) return undefined;
    return {
      unknown: reader.u8(),
      script: string(),
      functionName: string(),
      self: variable(),
      args: list(variable),
    };
  };
  const functionMessages = list((): EssFunctionMessage => {
    const unknown = reader.u8();
    const id = reader.u32();
    const call = queuedCall();
    return { unknown, id, ...(call && { call }) };
  });
  const suspended = (): EssSuspendedStack => {
    const id = reader.u32();
    const call = queuedCall();
    return { id, ...(call && { call }) };
  };
  const suspendedStacks = [list(suspended), list(suspended)] as const;

  // The game's registrations after the VM's data. The queued unbinds and the unknown ids, the
  // functors and the LOS events are empty in every save seen (TODO(M13): check their sizes
  // against a save that holds them; handles are 64-bit here as everywhere in these saves).
  const readRegistrations = (): EssPapyrusRegistrations => {
    const first = reader.u32();
    const unknown = first !== 0 ? [first, reader.u32()] : [first];
    const unknownIds = list(() => reader.u32());
    const queuedUnbinds = list(() => ({ handle: vmId(), unknown: reader.u32() }));
    const registrationVersion = reader.i16();
    const waits = [0, 1, 2].map(() => list(() => ({ stack: reader.u32(), time: reader.i32() })));
    const update = (): EssUpdateEvent => ({
      single: reader.u8() !== 0,
      time: reader.u32(),
      interval: reader.i32(),
      handle: gameHandle(),
    });
    const updates = list(update);
    const gameTimeUpdates = list(update);
    const userLogs = list(lengthString);
    const functor = (): EssFunctor => {
      const at = reader.offset;
      const type = reader.u8();
      const fields = FUNCTOR_FIELDS[type];
      if (fields === undefined) throw new FormatError(`Unknown functor type ${String(type)}`, at);
      const data: (number | string)[] = [];
      for (const field of fields) {
        if (field === 'u') data.push(reader.u32());
        else if (field === 'r') data.push(reader.refId());
        else if (field === 'b') data.push(reader.u8());
        else data.push(lengthString());
      }
      if (type === 0 && registrationVersion > 1) data.push(reader.u8());
      return { type, data };
    };
    const functors = [0, 1, 2, 3].map(() => list(functor));
    const losEvents = list(() => ({
      viewer: reader.refId(),
      target: reader.refId(),
      type: reader.u8(),
      last: reader.u8(),
    }));
    const sleepEvents = list(gameHandle);
    const trackedStatsEvents = registrationVersion > 3 ? list(gameHandle) : [];
    const inventoryFilters =
      registrationVersion > 4
        ? list(() => {
            const handle = gameHandle();
            const itemCount = reader.u32();
            const listCount = reader.u32();
            const items: RawRefId[] = [];
            for (let i = 0; i < itemCount; i++) items.push(reader.refId());
            const lists: RawRefId[] = [];
            for (let i = 0; i < listCount; i++) lists.push(reader.refId());
            return { handle, items, lists };
          })
        : [];
    const unknown06 = list(() => ({ refId: reader.refId(), value: reader.u8() }));
    const animationEvents = list(() => ({
      refId: reader.refId(),
      events: list(() => ({
        name: lengthString(),
        pairs: list(() => [reader.u32(), reader.u32()] as const),
        handles: list(gameHandle),
      })),
    }));
    const unknown08 = list(() => [reader.u32(), reader.u32()] as const);
    const flagged = (): number[] => [reader.u8(), reader.u32(), reader.u32()];
    const unknown09 = [
      list(() => ({ refId: reader.refId(), entries: list(flagged) })),
      list(() => ({
        refId: reader.refId(),
        entries: list(() => ({
          id: reader.u32(),
          values: list(() => reader.u32()),
          flags: list(() => [reader.u32(), reader.u8() !== 0] as const),
          last: reader.u32(),
        })),
      })),
      list(() => ({ refId: reader.refId(), entries: list(flagged) })),
    ] as const;
    const unknown0A = list(() => ({ id: reader.u32(), values: list(() => reader.u32()) }));
    return {
      unknown,
      unknownIds,
      queuedUnbinds,
      version: registrationVersion,
      waits,
      updates,
      gameTimeUpdates,
      userLogs,
      functors,
      losEvents,
      sleepEvents,
      trackedStatsEvents,
      inventoryFilters,
      unknown06,
      animationEvents,
      unknown08,
      unknown09,
      unknown0A,
    };
  };
  const registrations = readRegistrations();
  return {
    version,
    strings,
    types,
    objects,
    detached,
    arrays,
    nextActiveScriptId,
    stacks,
    objectData,
    arrayData,
    stackData,
    functionMessages,
    suspendedStacks,
    registrations,
    unread: reader.remaining,
  };
}
