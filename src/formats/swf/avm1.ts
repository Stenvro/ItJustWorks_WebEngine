// ActionScript 2 bytecode (AVM1): the actions of DoAction and DoInitAction tags, decoded to a
// list for tools and for working out what a menu's scripts do (how they call the engine,
// which callbacks they register). Not a decompiler. Opcodes and their payloads after Adobe's
// SWF File Format Specification 19, chapter "Actions". Notes: docs/formats/swf.md.

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeUtf8, decodeWindows1252 } from '../text.ts';

/** A pushed value. */
export type Avm1Value =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'undefined' }
  | { readonly kind: 'register'; readonly register: number }
  | { readonly kind: 'constant'; readonly index: number };

export interface Avm1Action {
  /** Offset of the action within the decoded block. */
  readonly offset: number;
  readonly code: number;
  readonly name: string;
  /** Push: its values. */
  readonly values?: readonly Avm1Value[];
  /** ConstantPool: its strings. */
  readonly pool?: readonly string[];
  /** A string payload (GetURL url, GoToLabel, SetTarget, DefineFunction name). */
  readonly text?: string;
  /** Jump and If: the target offset. */
  readonly target?: number;
  /** DefineFunction(2): parameters and the body's end offset (its actions follow). */
  readonly params?: readonly string[];
  readonly bodyEnd?: number;
  /** Other small payloads (register numbers, frame numbers, flags). */
  readonly numbers?: readonly number[];
}

const NAMES: Record<number, string> = {
  0x00: 'End',
  0x04: 'NextFrame',
  0x05: 'PrevFrame',
  0x06: 'Play',
  0x07: 'Stop',
  0x08: 'ToggleQuality',
  0x09: 'StopSounds',
  0x0a: 'Add',
  0x0b: 'Subtract',
  0x0c: 'Multiply',
  0x0d: 'Divide',
  0x0e: 'Equals',
  0x0f: 'Less',
  0x10: 'And',
  0x11: 'Or',
  0x12: 'Not',
  0x13: 'StringEquals',
  0x14: 'StringLength',
  0x15: 'StringExtract',
  0x17: 'Pop',
  0x18: 'ToInteger',
  0x1c: 'GetVariable',
  0x1d: 'SetVariable',
  0x20: 'SetTarget2',
  0x21: 'StringAdd',
  0x22: 'GetProperty',
  0x23: 'SetProperty',
  0x24: 'CloneSprite',
  0x25: 'RemoveSprite',
  0x26: 'Trace',
  0x27: 'StartDrag',
  0x28: 'EndDrag',
  0x29: 'StringLess',
  0x2a: 'Throw',
  0x2b: 'CastOp',
  0x2c: 'ImplementsOp',
  0x30: 'RandomNumber',
  0x31: 'MBStringLength',
  0x32: 'CharToAscii',
  0x33: 'AsciiToChar',
  0x34: 'GetTime',
  0x35: 'MBStringExtract',
  0x36: 'MBCharToAscii',
  0x37: 'MBAsciiToChar',
  0x3a: 'Delete',
  0x3b: 'Delete2',
  0x3c: 'DefineLocal',
  0x3d: 'CallFunction',
  0x3e: 'Return',
  0x3f: 'Modulo',
  0x40: 'NewObject',
  0x41: 'DefineLocal2',
  0x42: 'InitArray',
  0x43: 'InitObject',
  0x44: 'TypeOf',
  0x45: 'TargetPath',
  0x46: 'Enumerate',
  0x47: 'Add2',
  0x48: 'Less2',
  0x49: 'Equals2',
  0x4a: 'ToNumber',
  0x4b: 'ToString',
  0x4c: 'PushDuplicate',
  0x4d: 'StackSwap',
  0x4e: 'GetMember',
  0x4f: 'SetMember',
  0x50: 'Increment',
  0x51: 'Decrement',
  0x52: 'CallMethod',
  0x53: 'NewMethod',
  0x54: 'InstanceOf',
  0x55: 'Enumerate2',
  0x60: 'BitAnd',
  0x61: 'BitOr',
  0x62: 'BitXor',
  0x63: 'BitLShift',
  0x64: 'BitRShift',
  0x65: 'BitURShift',
  0x66: 'StrictEquals',
  0x67: 'Greater',
  0x68: 'StringGreater',
  0x69: 'Extends',
  0x81: 'GotoFrame',
  0x83: 'GetURL',
  0x87: 'StoreRegister',
  0x88: 'ConstantPool',
  0x8a: 'WaitForFrame',
  0x8b: 'SetTarget',
  0x8c: 'GoToLabel',
  0x8d: 'WaitForFrame2',
  0x8e: 'DefineFunction2',
  0x8f: 'Try',
  0x94: 'With',
  0x96: 'Push',
  0x99: 'Jump',
  0x9a: 'GetURL2',
  0x9b: 'DefineFunction',
  0x9d: 'If',
  0x9e: 'Call',
  0x9f: 'GotoFrame2',
};

export function avm1Name(code: number): string {
  return NAMES[code] ?? `Unknown0x${code.toString(16)}`;
}

function readString(reader: BinaryReader, end: number, version: number): string {
  const start = reader.offset;
  const rest = reader.bytes(end - start);
  const length = rest.indexOf(0);
  if (length < 0) throw new FormatError('unterminated string', start);
  reader.seek(start + length + 1);
  const bytes = rest.subarray(0, length);
  return version >= 6 ? (decodeUtf8(bytes) ?? decodeWindows1252(bytes)) : decodeWindows1252(bytes);
}

/**
 * Decodes a block of actions (a DoAction body, a DoInitAction body after its sprite id).
 * `version`: the movie's SWF version (how strings are encoded). Stops at the first End.
 */
export function decodeAvm1(bytes: Uint8Array, version: number): Avm1Action[] {
  const reader = new BinaryReader(bytes);
  const actions: Avm1Action[] = [];
  while (reader.remaining > 0) {
    const offset = reader.offset;
    const code = reader.u8();
    const name = avm1Name(code);
    if (code < 0x80) {
      actions.push({ offset, code, name });
      if (code === 0x00) break;
      continue;
    }
    const length = reader.u16();
    const start = reader.offset;
    const end = start + length;
    if (end > bytes.length) throw new FormatError(`${name} runs past its block`, offset);
    const action = decodePayload(reader, { offset, code, name }, end, version);
    actions.push(action);
    reader.seek(end);
  }
  return actions;
}

function decodePayload(
  reader: BinaryReader,
  base: Avm1Action,
  end: number,
  version: number,
): Avm1Action {
  switch (base.code) {
    case 0x88: {
      const count = reader.u16();
      const pool: string[] = [];
      for (let i = 0; i < count; i++) pool.push(readString(reader, end, version));
      return { ...base, pool };
    }
    case 0x96: {
      const values: Avm1Value[] = [];
      while (reader.offset < end) values.push(readPushValue(reader, end, version));
      return { ...base, values };
    }
    case 0x99:
    case 0x9d: {
      const jump = reader.i16();
      return { ...base, target: end + jump };
    }
    case 0x83: {
      const url = readString(reader, end, version);
      const window = readString(reader, end, version);
      return { ...base, text: `${url} ${window}` };
    }
    case 0x8b:
    case 0x8c:
      return { ...base, text: readString(reader, end, version) };
    case 0x9b: {
      const fnName = readString(reader, end, version);
      const count = reader.u16();
      const params: string[] = [];
      for (let i = 0; i < count; i++) params.push(readString(reader, end, version));
      const size = reader.u16();
      return { ...base, text: fnName, params, bodyEnd: end + size };
    }
    case 0x8e: {
      const fnName = readString(reader, end, version);
      const count = reader.u16();
      const registers = reader.u8();
      const flags = reader.u16();
      const params: string[] = [];
      for (let i = 0; i < count; i++) {
        const register = reader.u8();
        const param = readString(reader, end, version);
        params.push(register === 0 ? param : `${param}@r${String(register)}`);
      }
      const size = reader.u16();
      return { ...base, text: fnName, params, bodyEnd: end + size, numbers: [registers, flags] };
    }
    case 0x87:
    case 0x9a:
    case 0x8d:
      return { ...base, numbers: [reader.u8()] };
    case 0x81:
    case 0x94:
      return { ...base, numbers: [reader.u16()] };
    case 0x8a:
      return { ...base, numbers: [reader.u16(), reader.u8()] };
    case 0x9f: {
      const flags = reader.u8();
      return { ...base, numbers: (flags & 2) !== 0 ? [flags, reader.u16()] : [flags] };
    }
    case 0x8f: {
      const flags = reader.u8();
      const trySize = reader.u16();
      const catchSize = reader.u16();
      const finallySize = reader.u16();
      const catchName = (flags & 4) === 0 ? readString(reader, end, version) : undefined;
      const register = (flags & 4) !== 0 ? reader.u8() : undefined;
      return {
        ...base,
        numbers: [
          flags,
          trySize,
          catchSize,
          finallySize,
          ...(register === undefined ? [] : [register]),
        ],
        ...(catchName !== undefined && { text: catchName }),
      };
    }
    default:
      return base;
  }
}

function readPushValue(reader: BinaryReader, end: number, version: number): Avm1Value {
  const type = reader.u8();
  switch (type) {
    case 0:
      return { kind: 'string', value: readString(reader, end, version) };
    case 1:
      return { kind: 'number', value: reader.f32() };
    case 2:
      return { kind: 'null' };
    case 3:
      return { kind: 'undefined' };
    case 4:
      return { kind: 'register', register: reader.u8() };
    case 5:
      return { kind: 'boolean', value: reader.u8() !== 0 };
    case 6: {
      // The two 32-bit halves are stored high word first, each little-endian.
      const high = reader.u32();
      const low = reader.u32();
      return { kind: 'number', value: swapped(high, low) };
    }
    case 7:
      return { kind: 'number', value: reader.i32() };
    case 8:
      return { kind: 'constant', index: reader.u8() };
    case 9:
      return { kind: 'constant', index: reader.u16() };
    default:
      throw new FormatError(`unknown push type ${String(type)}`, reader.offset - 1);
  }
}

/** A double from the halves as AVM1 stores them (high word first). */
function swapped(high: number, low: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, low, true);
  view.setUint32(4, high, true);
  return view.getFloat64(0, true);
}

/** A pushed value as text (constants resolved through the pool when given). */
export function formatAvm1Value(value: Avm1Value, pool: readonly string[] = []): string {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return String(value.value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'register':
      return `r${String(value.register)}`;
    case 'constant': {
      const text = pool[value.index];
      return text === undefined ? `c${String(value.index)}` : JSON.stringify(text);
    }
  }
}

/** One line per action; constants resolved through the latest ConstantPool. */
export function disassembleAvm1(actions: readonly Avm1Action[]): string[] {
  let pool: readonly string[] = [];
  const lines: string[] = [];
  const ends: number[] = [];
  for (const action of actions) {
    while (ends.length > 0 && action.offset >= (ends[ends.length - 1] ?? 0)) ends.pop();
    const indent = '  '.repeat(ends.length);
    let text = action.name;
    if (action.pool) {
      pool = action.pool;
      text += ` (${String(action.pool.length)} strings)`;
    } else if (action.values) {
      text += ` ${action.values.map((value) => formatAvm1Value(value, pool)).join(', ')}`;
    } else if (action.params) {
      text += ` ${action.text ?? ''}(${action.params.join(', ')})`;
    } else if (action.target !== undefined) {
      text += ` -> ${String(action.target)}`;
    } else if (action.text !== undefined) {
      text += ` ${action.text}`;
    } else if (action.numbers) {
      text += ` ${action.numbers.join(' ')}`;
    }
    lines.push(`${String(action.offset).padStart(6)}  ${indent}${text}`);
    if (action.bodyEnd !== undefined) ends.push(action.bodyEnd);
  }
  return lines;
}
