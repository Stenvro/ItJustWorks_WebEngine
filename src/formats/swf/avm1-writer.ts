// Writes ActionScript 2 bytecode (AVM1): the few actions the engine puts into a menu of its own
// (the bridge to the engine, src/ui/menu-bridge.ts). Opcodes as in avm1.ts; a function's body is
// assembled in place after its DefineFunction2. Notes: docs/formats/swf.md.

import { encodeUtf8 } from '../text.ts';

/** A value to push. Strings, numbers (int or double), booleans, null, registers. */
export type PushValue = string | number | boolean | null | { readonly register: number };

/** DefineFunction2 flags (SWF 19, "DefineFunction2"). */
export const Function2Flag = {
  preloadThis: 0x0001,
  suppressThis: 0x0002,
  preloadArguments: 0x0004,
  suppressArguments: 0x0008,
  preloadSuper: 0x0010,
  suppressSuper: 0x0020,
  preloadRoot: 0x0040,
  preloadParent: 0x0080,
  preloadGlobal: 0x0100,
} as const;

export const Op = {
  end: 0x00,
  subtract: 0x0b,
  multiply: 0x0c,
  divide: 0x0d,
  and: 0x10,
  or: 0x11,
  pop: 0x17,
  getVariable: 0x1c,
  setVariable: 0x1d,
  callFunction: 0x3d,
  return: 0x3e,
  newObject: 0x40,
  initArray: 0x42,
  initObject: 0x43,
  typeOf: 0x44,
  add2: 0x47,
  less2: 0x48,
  toNumber: 0x4a,
  toString: 0x4b,
  pushDuplicate: 0x4c,
  increment: 0x50,
  decrement: 0x51,
  newMethod: 0x53,
  strictEquals: 0x66,
  greater: 0x67,
  getMember: 0x4e,
  setMember: 0x4f,
  callMethod: 0x52,
  equals2: 0x49,
  not: 0x12,
} as const;

export class Avm1Writer {
  readonly #bytes: number[] = [];
  /** Labels by name: their offsets. */
  readonly #labels = new Map<string, number>();
  /** Jumps to labels: where their offset goes, and where it counts from (the action's end). */
  readonly #fixups: { label: string; at: number; from: number }[] = [];

  /** Names this point of the code, for jumpTo and ifTo (within this writer). */
  label(name: string): this {
    if (this.#labels.has(name)) throw new Error(`label ${name} placed twice`);
    this.#labels.set(name, this.#bytes.length);
    return this;
  }

  /** Jump to a label (before or after this). */
  jumpTo(name: string): this {
    return this.#jumpAction(0x99, name);
  }

  /** If: to a label when the popped value is true. */
  ifTo(name: string): this {
    return this.#jumpAction(0x9d, name);
  }

  #jumpAction(code: number, label: string): this {
    this.#bytes.push(code, 2, 0, 0, 0);
    this.#fixups.push({ label, at: this.#bytes.length - 2, from: this.#bytes.length });
    return this;
  }

  /** An action without payload. */
  op(code: number): this {
    this.#bytes.push(code);
    return this;
  }

  /** Push of one or more values. */
  push(...values: PushValue[]): this {
    const payload: number[] = [];
    for (const value of values) {
      if (typeof value === 'string') {
        payload.push(0, ...encodeUtf8(value), 0);
      } else if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
          payload.push(7, ...u32(value >>> 0));
        } else {
          payload.push(6, ...double(value));
        }
      } else if (typeof value === 'boolean') {
        payload.push(5, value ? 1 : 0);
      } else if (value === null) {
        payload.push(2);
      } else {
        payload.push(4, value.register);
      }
    }
    return this.#action(0x96, payload);
  }

  /** If: jumps `distance` bytes past itself when the popped value is true. */
  jumpIf(distance: number): this {
    return this.#action(0x9d, [distance & 0xff, (distance >> 8) & 0xff]);
  }

  /** Jump: goes `distance` bytes past itself. */
  jump(distance: number): this {
    return this.#action(0x99, [distance & 0xff, (distance >> 8) & 0xff]);
  }

  /** Already assembled actions, as they are. */
  append(code: Uint8Array): this {
    this.#bytes.push(...code);
    return this;
  }

  storeRegister(register: number): this {
    return this.#action(0x87, [register]);
  }

  /**
   * DefineFunction2: an anonymous function (pushed) unless named; `params` are put in
   * registers `firstParam`.. in order (after the preloaded ones: `this`, `arguments`, ... take
   * registers from 1 on), `registers` is how many it uses in all; `body` assembles it.
   */
  function2(
    name: string,
    params: readonly string[],
    registers: number,
    flags: number,
    body: (writer: Avm1Writer) => void,
    firstParam = 1,
  ): this {
    const inner = new Avm1Writer();
    body(inner);
    const code = inner.bytes();
    const payload = [
      ...encodeUtf8(name),
      0,
      ...u16(params.length),
      registers,
      ...u16(flags),
      ...params.flatMap((param, i) => [i + firstParam, ...encodeUtf8(param), 0]),
      ...u16(code.length),
    ];
    this.#action(0x8e, payload);
    this.#bytes.push(...code);
    return this;
  }

  /** `object.member` on the stack: pushes the object path (dotted members) and reads it. */
  getPath(path: string): this {
    const [first, ...rest] = path.split('.');
    this.push(first ?? '').op(Op.getVariable);
    for (const member of rest) this.push(member).op(Op.getMember);
    return this;
  }

  bytes(): Uint8Array {
    const bytes = Uint8Array.from(this.#bytes);
    for (const { label, at, from } of this.#fixups) {
      const to = this.#labels.get(label);
      if (to === undefined) throw new Error(`label ${label} is not placed`);
      const distance = to - from;
      bytes[at] = distance & 0xff;
      bytes[at + 1] = (distance >> 8) & 0xff;
    }
    return bytes;
  }

  #action(code: number, payload: readonly number[]): this {
    this.#bytes.push(code, ...u16(payload.length), ...payload);
    return this;
  }
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** A double as AVM1 stores it: the high 32-bit word first, each word little-endian. */
function double(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return [...u32(view.getUint32(4, true)), ...u32(view.getUint32(0, true))];
}
