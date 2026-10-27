// The Papyrus global data (type 1001) of an .ess save (docs/formats/ess.md; xEdit's "Papyrus
// Struct", UESP): the string table, the script types and their variables, the script
// instances (objects) and detached objects, the arrays, the active stacks' ids, then each
// object's variables and each array's elements. The stacks' frames, function messages,
// suspended stacks and the registrations after them are not read yet (TODO(M12): resumable
// frames). Platform-independent.

import { FormatError } from '../binary-reader.ts';
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
  /** The game handle's high word (a form's type; an alias's id). */
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
  readonly script: string;
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
  /** Bytes after the arrays not read yet (the stacks' frames and on: TODO(M12)). */
  readonly unread: number;
}

export function readPapyrus(data: Uint8Array): EssPapyrus {
  const reader = new EssReader(data);
  const version = reader.u16();
  if (version === 0xffff) throw new FormatError('The save marks its Papyrus data invalid', 0);
  const strings: string[] = [];
  const stringCount = reader.u16();
  for (let i = 0; i < stringCount; i++) strings.push(reader.wstring());
  const string = (): string => {
    const at = reader.offset;
    const index = reader.u16();
    const value = strings[index];
    if (value === undefined)
      throw new FormatError(`String ${String(index)} is not in the table`, at);
    return value;
  };
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
    const handle = reader.u32();
    const script = string();
    const flags = reader.u16();
    const high = reader.i16();
    objects.push({ handle, script, flags, high, refId: reader.refId(), unknown: reader.u8() });
  }
  const detached: { handle: number; script: string }[] = [];
  const detachedCount = reader.u32();
  for (let i = 0; i < detachedCount; i++) detached.push({ handle: reader.u32(), script: string() });
  const arrays: EssArrayInfo[] = [];
  const arrayCount = reader.u32();
  for (let i = 0; i < arrayCount; i++) {
    const handle = reader.u32();
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
        return { type, script: string(), handle: reader.u32() };
      case PapyrusType.String:
        return { type, value: string() };
      case PapyrusType.Int:
        return { type, value: reader.i32() };
      case PapyrusType.Float:
        return { type, value: reader.f32() };
      case PapyrusType.Bool:
        return { type, value: reader.u32() !== 0 };
      case PapyrusType.ObjectArray:
        return { type, script: string(), array: reader.u32() };
      case PapyrusType.StringArray:
      case PapyrusType.IntArray:
      case PapyrusType.FloatArray:
      case PapyrusType.BoolArray:
        return { type, array: reader.u32() };
      default:
        throw new FormatError(`Unknown Papyrus value type ${String(type)}`, at);
    }
  };

  const objectData: EssObjectData[] = [];
  for (let i = 0; i < objectCount + detachedCount; i++) {
    const handle = reader.u32();
    const flags = reader.u8();
    const script = string();
    const unknown1 = reader.u32();
    const unknown2 = (flags & 4) !== 0 ? reader.u32() : undefined;
    const memberCount = reader.u32();
    const variables: EssVariable[] = [];
    for (let j = 0; j < memberCount; j++) variables.push(variable());
    objectData.push({
      handle,
      flags,
      script,
      unknown1,
      ...(unknown2 !== undefined && { unknown2 }),
      variables,
    });
  }
  const lengths = new Map(arrays.map((array) => [array.handle, array.length]));
  const arrayData = new Map<number, EssVariable[]>();
  for (let i = 0; i < arrayCount; i++) {
    const handle = reader.u32();
    const length = lengths.get(handle);
    if (length === undefined) {
      throw new FormatError(`Array ${String(handle)} is not in the array table`, reader.offset - 4);
    }
    const elements: EssVariable[] = [];
    for (let j = 0; j < length; j++) elements.push(variable());
    arrayData.set(handle, elements);
  }
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
    unread: reader.remaining,
  };
}
