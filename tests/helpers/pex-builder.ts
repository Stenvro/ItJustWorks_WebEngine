// Builds small compiled Papyrus scripts (PEX, big-endian) for unit tests (no game data).

import { PEX_OPCODES, type PexValue } from '../../src/formats/pex/pex.ts';

export interface BuildFunction {
  readonly name: string;
  readonly returnType?: string;
  readonly native?: boolean;
  readonly params?: readonly (readonly [string, string])[];
  readonly locals?: readonly (readonly [string, string])[];
  readonly code?: readonly (readonly [string, ...PexValue[]])[];
}

export interface BuildScript {
  readonly name: string;
  readonly parent?: string;
  readonly variables?: readonly (readonly [string, string, PexValue])[];
  /** Auto properties: name, type, backing variable. */
  readonly properties?: readonly (readonly [string, string, string])[];
  readonly functions?: readonly BuildFunction[];
  readonly states?: readonly {
    readonly name: string;
    readonly functions: readonly BuildFunction[];
  }[];
  /** Write a wrong object size. */
  readonly corruptSize?: boolean;
}

class Writer {
  readonly bytes: number[] = [];

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  u16(v: number): void {
    this.u8(v >> 8);
    this.u8(v);
  }

  u32(v: number): void {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }

  f32(v: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, v, false);
    for (let i = 0; i < 4; i++) this.u8(view.getUint8(i));
  }

  wstring(text: string): void {
    this.u16(text.length);
    for (const char of text) this.u8(char.charCodeAt(0));
  }
}

export function buildPex(script: BuildScript): Uint8Array {
  const strings: string[] = [];
  const index = (text: string): number => {
    let i = strings.indexOf(text);
    if (i < 0) i = strings.push(text) - 1;
    return i;
  };

  const body = new Writer();
  const value = (w: Writer, v: PexValue): void => {
    switch (v.kind) {
      case 'none':
        w.u8(0);
        break;
      case 'identifier':
        w.u8(1);
        w.u16(index(v.name));
        break;
      case 'string':
        w.u8(2);
        w.u16(index(v.value));
        break;
      case 'int':
        w.u8(3);
        w.u32(v.value >>> 0);
        break;
      case 'float':
        w.u8(4);
        w.f32(v.value);
        break;
      case 'bool':
        w.u8(5);
        w.u8(v.value ? 1 : 0);
        break;
    }
  };
  const fn = (w: Writer, f: BuildFunction): void => {
    w.u16(index(f.returnType ?? 'None'));
    w.u16(index(''));
    w.u32(0);
    w.u8(f.native ? 2 : 0);
    w.u16(f.params?.length ?? 0);
    for (const [name, type] of f.params ?? []) {
      w.u16(index(name));
      w.u16(index(type));
    }
    w.u16(f.locals?.length ?? 0);
    for (const [name, type] of f.locals ?? []) {
      w.u16(index(name));
      w.u16(index(type));
    }
    w.u16(f.code?.length ?? 0);
    for (const [op, ...args] of f.code ?? []) {
      const code = PEX_OPCODES.findIndex((o) => o.name === op);
      const opcode = PEX_OPCODES[code];
      if (!opcode) throw new Error(`unknown opcode ${op}`);
      w.u8(code);
      const fixed = args.slice(0, opcode.args);
      for (const arg of fixed) value(w, arg);
      if ('varargs' in opcode) {
        const rest = args.slice(opcode.args);
        value(w, { kind: 'int', value: rest.length });
        for (const arg of rest) value(w, arg);
      }
    }
  };

  // Object data (after name and size).
  const data = new Writer();
  data.u16(index(script.parent ?? ''));
  data.u16(index(''));
  data.u32(0);
  data.u16(index(''));
  data.u16(script.variables?.length ?? 0);
  for (const [name, type, initial] of script.variables ?? []) {
    data.u16(index(name));
    data.u16(index(type));
    data.u32(0);
    value(data, initial);
  }
  data.u16(script.properties?.length ?? 0);
  for (const [name, type, variable] of script.properties ?? []) {
    data.u16(index(name));
    data.u16(index(type));
    data.u16(index(''));
    data.u32(0);
    data.u8(7);
    data.u16(index(variable));
  }
  const states = [{ name: '', functions: script.functions ?? [] }, ...(script.states ?? [])];
  data.u16(states.length);
  for (const state of states) {
    data.u16(index(state.name));
    data.u16(state.functions.length);
    for (const f of state.functions) {
      data.u16(index(f.name));
      fn(data, f);
    }
  }
  body.u16(1); // objects
  body.u16(index(script.name));
  body.u32(data.bytes.length + 4 + (script.corruptSize ? 1 : 0));
  body.bytes.push(...data.bytes);

  const out = new Writer();
  out.u32(0xfa57c0de);
  out.u8(3);
  out.u8(2);
  out.u16(1);
  out.u32(0);
  out.u32(0);
  out.wstring(`${script.name}.psc`);
  out.wstring('user');
  out.wstring('machine');
  out.u16(strings.length);
  for (const s of strings) out.wstring(s);
  out.u8(0); // no debug info
  out.u16(0); // user flags
  out.bytes.push(...body.bytes);
  return Uint8Array.from(out.bytes);
}

export const id = (name: string): PexValue => ({ kind: 'identifier', name });
export const int = (value: number): PexValue => ({ kind: 'int', value });
export const float = (value: number): PexValue => ({ kind: 'float', value });
export const str = (value: string): PexValue => ({ kind: 'string', value });
export const bool = (value: boolean): PexValue => ({ kind: 'bool', value });
export const none: PexValue = { kind: 'none' };
