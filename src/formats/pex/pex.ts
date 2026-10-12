// PEX: compiled Papyrus scripts (Skyrim: version 3.x, big-endian). Layout:
// docs/formats/pex.md (UESP "Skyrim Mod:Compiled Script File Format", Champollion).

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeGameText } from '../text.ts';

export const PEX_MAGIC = 0xfa57c0de;

/** A value in an instruction or a variable's initial value. */
export type PexValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean };

export interface PexTyped {
  readonly name: string;
  readonly type: string;
}

export interface PexInstruction {
  readonly op: PexOpcode;
  readonly args: readonly PexValue[];
}

export interface PexFunction {
  readonly returnType: string;
  readonly docString: string;
  readonly userFlags: number;
  readonly global: boolean;
  readonly native: boolean;
  readonly params: readonly PexTyped[];
  readonly locals: readonly PexTyped[];
  readonly code: readonly PexInstruction[];
}

export interface PexNamedFunction extends PexFunction {
  readonly name: string;
}

export interface PexState {
  /** Empty for the default ("") state. */
  readonly name: string;
  readonly functions: readonly PexNamedFunction[];
}

export interface PexVariable {
  readonly name: string;
  readonly type: string;
  readonly userFlags: number;
  readonly initial: PexValue;
}

export interface PexProperty {
  readonly name: string;
  readonly type: string;
  readonly docString: string;
  readonly userFlags: number;
  /** Variable behind an auto property. */
  readonly autoVariable: string | undefined;
  readonly getter: PexFunction | undefined;
  readonly setter: PexFunction | undefined;
}

export interface PexObject {
  readonly name: string;
  readonly parent: string;
  readonly docString: string;
  readonly userFlags: number;
  readonly autoState: string;
  readonly variables: readonly PexVariable[];
  readonly properties: readonly PexProperty[];
  readonly states: readonly PexState[];
}

export interface PexScript {
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly gameId: number;
  readonly sourceFile: string;
  readonly objects: readonly PexObject[];
}

/** Opcodes with their fixed argument count; `varargs` ones end with a count + values. */
export const PEX_OPCODES = [
  { name: 'nop', args: 0 },
  { name: 'iadd', args: 3 },
  { name: 'fadd', args: 3 },
  { name: 'isub', args: 3 },
  { name: 'fsub', args: 3 },
  { name: 'imul', args: 3 },
  { name: 'fmul', args: 3 },
  { name: 'idiv', args: 3 },
  { name: 'fdiv', args: 3 },
  { name: 'imod', args: 3 },
  { name: 'not', args: 2 },
  { name: 'ineg', args: 2 },
  { name: 'fneg', args: 2 },
  { name: 'assign', args: 2 },
  { name: 'cast', args: 2 },
  { name: 'cmp_eq', args: 3 },
  { name: 'cmp_lt', args: 3 },
  { name: 'cmp_le', args: 3 },
  { name: 'cmp_gt', args: 3 },
  { name: 'cmp_ge', args: 3 },
  { name: 'jmp', args: 1 },
  { name: 'jmpt', args: 2 },
  { name: 'jmpf', args: 2 },
  { name: 'callmethod', args: 3, varargs: true },
  { name: 'callparent', args: 2, varargs: true },
  { name: 'callstatic', args: 3, varargs: true },
  { name: 'return', args: 1 },
  { name: 'strcat', args: 3 },
  { name: 'propget', args: 3 },
  { name: 'propset', args: 3 },
  { name: 'array_create', args: 2 },
  { name: 'array_length', args: 2 },
  { name: 'array_getelement', args: 3 },
  { name: 'array_setelement', args: 3 },
  { name: 'array_findelement', args: 4 },
  { name: 'array_rfindelement', args: 4 },
] as const;

export type PexOpcode = (typeof PEX_OPCODES)[number]['name'];

class PexReader {
  readonly r: BinaryReader;
  strings: readonly string[] = [];

  constructor(bytes: Uint8Array) {
    this.r = new BinaryReader(bytes, 0, false);
  }

  wstring(): string {
    const length = this.r.u16();
    return decodeGameText(this.r.bytes(length));
  }

  /** A string table reference. */
  string(): string {
    const at = this.r.offset;
    const index = this.r.u16();
    const value = this.strings[index];
    if (value === undefined) throw new FormatError(`PEX string index ${index}`, at);
    return value;
  }

  value(): PexValue {
    const at = this.r.offset;
    const type = this.r.u8();
    switch (type) {
      case 0:
        return { kind: 'none' };
      case 1:
        return { kind: 'identifier', name: this.string() };
      case 2:
        return { kind: 'string', value: this.string() };
      case 3:
        return { kind: 'int', value: this.r.i32() };
      case 4:
        return { kind: 'float', value: this.r.f32() };
      case 5:
        return { kind: 'bool', value: this.r.u8() !== 0 };
      default:
        throw new FormatError(`PEX value type ${type}`, at);
    }
  }

  typed(): PexTyped {
    return { name: this.string(), type: this.string() };
  }

  list<T>(read: () => T): T[] {
    const count = this.r.u16();
    return Array.from({ length: count }, read);
  }

  instruction(): PexInstruction {
    const at = this.r.offset;
    const code = this.r.u8();
    const opcode = PEX_OPCODES[code];
    if (!opcode) throw new FormatError(`PEX opcode ${code}`, at);
    const args = Array.from({ length: opcode.args }, () => this.value());
    if ('varargs' in opcode) {
      const count = this.value();
      if (count.kind !== 'int' || count.value < 0) {
        throw new FormatError(`PEX ${opcode.name} argument count`, this.r.offset);
      }
      for (let i = 0; i < count.value; i++) args.push(this.value());
    }
    return { op: opcode.name, args };
  }

  function(): PexFunction {
    const returnType = this.string();
    const docString = this.string();
    const userFlags = this.r.u32();
    const flags = this.r.u8();
    const params = this.list(() => this.typed());
    const locals = this.list(() => this.typed());
    const code = this.list(() => this.instruction());
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
  }

  object(): PexObject {
    const name = this.string();
    const size = this.r.u32();
    const start = this.r.offset;
    const parent = this.string();
    const docString = this.string();
    const userFlags = this.r.u32();
    const autoState = this.string();
    const variables = this.list((): PexVariable => ({
      name: this.string(),
      type: this.string(),
      userFlags: this.r.u32(),
      initial: this.value(),
    }));
    const properties = this.list((): PexProperty => {
      const propertyName = this.string();
      const type = this.string();
      const propertyDoc = this.string();
      const propertyFlags = this.r.u32();
      const flags = this.r.u8();
      const auto = (flags & 4) !== 0;
      const autoVariable = auto ? this.string() : undefined;
      const getter = !auto && (flags & 1) !== 0 ? this.function() : undefined;
      const setter = !auto && (flags & 2) !== 0 ? this.function() : undefined;
      return {
        name: propertyName,
        type,
        docString: propertyDoc,
        userFlags: propertyFlags,
        autoVariable,
        getter,
        setter,
      };
    });
    const states = this.list((): PexState => ({
      name: this.string(),
      functions: this.list((): PexNamedFunction => {
        const functionName = this.string();
        return { name: functionName, ...this.function() };
      }),
    }));
    // The size counts itself (4 bytes) and the object data.
    if (this.r.offset - start !== size - 4) {
      throw new FormatError(
        `PEX object ${name}: size ${size}, read ${this.r.offset - start + 4}`,
        start,
      );
    }
    return { name, parent, docString, userFlags, autoState, variables, properties, states };
  }
}

export function parsePex(bytes: Uint8Array): PexScript {
  const reader = new PexReader(bytes);
  const r = reader.r;
  const magic = r.u32();
  if (magic !== PEX_MAGIC) {
    throw new FormatError(`Not a PEX file (magic 0x${magic.toString(16)})`, 0);
  }
  const majorVersion = r.u8();
  const minorVersion = r.u8();
  if (majorVersion !== 3) throw new FormatError(`PEX version ${majorVersion}.${minorVersion}`, 4);
  const gameId = r.u16();
  r.skip(8); // compilation time
  const sourceFile = reader.wstring();
  reader.wstring(); // user name
  reader.wstring(); // machine name
  const stringCount = r.u16();
  reader.strings = Array.from({ length: stringCount }, () => reader.wstring());

  if (r.u8() !== 0) {
    r.skip(8); // modification time
    reader.list(() => {
      r.skip(2 + 2 + 2 + 1); // object, state, function name; function type
      const lines = r.u16();
      r.skip(lines * 2);
    });
  }
  reader.list(() => {
    reader.string(); // user flag name
    r.u8(); // bit index
  });
  const objects = reader.list(() => reader.object());
  return { majorVersion, minorVersion, gameId, sourceFile, objects };
}
