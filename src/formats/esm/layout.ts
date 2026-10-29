// A small layout language for subrecord data, and its decoder. Every (record type, subrecord)
// pair of the load order has a layout in record-layouts.ts (after xEdit's TES5 definitions and
// UESP); `decodeField` reads a subrecord by it, checks that the layout consumes the data exactly,
// and reports form ids and string ids that cannot be right. Format: docs/formats/esm.md,
// "Subrecord layouts".
//
// A layout is a sequence of items separated by spaces, each `name:type` or a bare `type`
// (unnamed items are read and checked, not returned):
//
//   u8 i8 u16 i16 u32 i32 u64 f32   numbers (little-endian)
//   fid                             a form id (file-local: its top byte indexes the masters)
//   z                               a NUL-terminated string (to its NUL)
//   lz                              a localized string: a string table id (u32) in a localized
//                                   plugin, a NUL-terminated string otherwise
//   ws, ls                          a string with a u16 (ws) or u32 (ls) length before it
//   cN                              N characters (a four-character code: c4)
//   xN                              N bytes kept as they are (unused or padding)
//   rest                            the bytes left, kept as they are
//   ( ... )                         a group of items
//   item[N] item[] item[name]       N times, to the end of the data, or as many times as the
//                                   earlier item `name` of the same group says
//   |                               the data may end here (the items after it are optional)
//
// Alternatives: `A || B` decodes with the first layout that consumes the data exactly and
// whose form ids and strings check out (else the first that consumes it exactly).
// A switch: `@CODE k1=layout; k2=layout; *=layout` picks the layout by the last CODE subrecord
// before this one in the record (its zstring, or its number when it is 1 to 4 bytes long); a
// key ending in `*` matches the strings that start with the rest.

import { decodeGameText } from '../text.ts';

/** A decoded value: numbers, strings, raw bytes, arrays and named groups. */
export type LayoutValue =
  | number
  | bigint
  | string
  | Uint8Array
  | readonly LayoutValue[]
  | { readonly [name: string]: LayoutValue };

export type LayoutProblemKind = 'size' | 'formId' | 'stringId' | 'string';

export interface LayoutContext {
  /** The plugin's string tables are used for `lz` (the TES4 localized flag). */
  readonly localized: boolean;
  /** The plugin's master count: a form id's top byte is at most this. */
  readonly masterCount: number;
  /** When set, every non-zero `lz` id must resolve in these tables (PluginStrings). */
  readonly strings?: { get(id: number): string | undefined };
  /** The record's earlier subrecords (for `@CODE` switches). */
  readonly previous?: (code: string) => Uint8Array | undefined;
}

export interface LayoutProblem {
  readonly kind: LayoutProblemKind;
  readonly detail: string;
}

type Prim =
  'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'f32' | 'fid' | 'z' | 'lz' | 'ws' | 'ls';

type Node =
  | { readonly kind: 'prim'; readonly prim: Prim }
  | { readonly kind: 'bytes'; readonly size: number }
  | { readonly kind: 'chars'; readonly size: number }
  | { readonly kind: 'rest' }
  | { readonly kind: 'group'; readonly items: readonly Item[] };

interface Item {
  readonly name: string | undefined;
  readonly node: Node;
  /** undefined: once; number: fixed; 'end': to the end; other strings: an earlier item. */
  readonly repeat: number | string | undefined;
  /** The data may end before this item. */
  readonly optional: boolean;
}

/** A compiled layout: alternatives, or a switch on an earlier subrecord. */
export type CompiledLayout =
  | { readonly kind: 'alternatives'; readonly options: readonly Node[] }
  | {
      readonly kind: 'switch';
      readonly code: string;
      readonly cases: ReadonlyMap<string, CompiledLayout>;
      readonly fallback: CompiledLayout | undefined;
    };

const PRIMS = new Set<string>([
  'u8',
  'i8',
  'u16',
  'i16',
  'u32',
  'i32',
  'u64',
  'f32',
  'fid',
  'z',
  'lz',
  'ws',
  'ls',
]);

const compiled = new Map<string, CompiledLayout>();

/** Compiles a layout string (cached). Throws on a malformed layout: a bug in the tables. */
export function compileLayout(source: string): CompiledLayout {
  const cached = compiled.get(source);
  if (cached) return cached;
  let result: CompiledLayout;
  const text = source.trim();
  if (text.startsWith('@')) {
    const space = text.indexOf(' ');
    const code = text.slice(1, space);
    const cases = new Map<string, CompiledLayout>();
    let fallback: CompiledLayout | undefined;
    for (const part of text.slice(space + 1).split(';')) {
      const eq = part.indexOf('=');
      const key = part.slice(0, eq).trim();
      const layout = compileLayout(part.slice(eq + 1));
      if (key === '*') fallback = layout;
      else for (const k of key.split(',')) cases.set(k.trim(), layout);
    }
    result = { kind: 'switch', code, cases, fallback };
  } else {
    result = { kind: 'alternatives', options: text.split('||').map(parseSequence) };
  }
  compiled.set(source, result);
  return result;
}

function parseSequence(text: string): Node {
  const tokens = text.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
  let position = 0;
  const group = (): Node => {
    const items: Item[] = [];
    let optional = false;
    while (position < tokens.length && tokens[position] !== ')') {
      const token = tokens[position++] ?? '';
      if (token === '|') {
        optional = true;
        continue;
      }
      let name: string | undefined;
      let body = token;
      const colon = token.indexOf(':');
      if (colon > 0 && token !== '(') {
        name = token.slice(0, colon);
        body = token.slice(colon + 1);
        // `name:( ... )` splits into `name:` and `(`.
        if (body === '') body = tokens[position++] ?? '';
      }
      let node: Node;
      let suffix: string;
      if (body === '(' || body.startsWith('(')) {
        node = group();
        if (tokens[position] !== ')') throw new Error(`Layout "${text}": missing )`);
        position++;
        suffix = '';
        // A repeat right after the group: `( ... )[]`.
        if (tokens[position]?.startsWith('[')) suffix = tokens[position++] ?? '';
      } else {
        const bracket = body.indexOf('[');
        const base = bracket < 0 ? body : body.slice(0, bracket);
        suffix = bracket < 0 ? '' : body.slice(bracket);
        node = primitive(base, text);
      }
      items.push({ name, node, repeat: parseRepeat(suffix), optional });
    }
    return { kind: 'group', items };
  };
  const node = group();
  if (position !== tokens.length) throw new Error(`Layout "${text}": unexpected )`);
  return node;
}

function primitive(base: string, text: string): Node {
  if (PRIMS.has(base)) return { kind: 'prim', prim: base as Prim };
  if (base === 'rest') return { kind: 'rest' };
  const sized = /^([xc])(\d+)$/.exec(base);
  if (sized) {
    const size = Number(sized[2]);
    return sized[1] === 'x' ? { kind: 'bytes', size } : { kind: 'chars', size };
  }
  throw new Error(`Layout "${text}": unknown type "${base}"`);
}

function parseRepeat(suffix: string): number | string | undefined {
  if (suffix === '') return undefined;
  const inner = suffix.slice(1, -1);
  if (inner === '') return 'end';
  return /^\d+$/.test(inner) ? Number(inner) : inner;
}

class OutOfData extends Error {}

class Cursor {
  offset = 0;
  readonly data: Uint8Array;
  readonly view: DataView;
  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  get remaining(): number {
    return this.data.length - this.offset;
  }
  take(size: number): number {
    if (size > this.remaining) throw new OutOfData();
    const at = this.offset;
    this.offset += size;
    return at;
  }
}

/** Decodes `data` with a compiled layout; problems found go to `problems`. */
export function decodeLayout(
  layout: CompiledLayout,
  data: Uint8Array,
  context: LayoutContext,
  problems: LayoutProblem[],
): LayoutValue | undefined {
  if (layout.kind === 'switch') {
    const previous = context.previous?.(layout.code);
    const key = previous === undefined ? undefined : switchKeys(previous);
    const prefixed = (text: string): CompiledLayout | undefined =>
      [...layout.cases].find(([k]) => k.endsWith('*') && text.startsWith(k.slice(0, -1)))?.[1];
    const chosen =
      (key && (layout.cases.get(key.text) ?? layout.cases.get(key.number) ?? prefixed(key.text))) ??
      layout.fallback;
    if (!chosen) {
      problems.push({
        kind: 'size',
        detail: `no case for ${layout.code} ${key?.text ?? '(none)'}`,
      });
      return undefined;
    }
    return decodeLayout(chosen, data, context, problems);
  }
  let best: { value: LayoutValue; problems: LayoutProblem[] } | undefined;
  let exact: { value: LayoutValue; problems: LayoutProblem[] } | undefined;
  for (const option of layout.options) {
    const cursor = new Cursor(data);
    const found: LayoutProblem[] = [];
    try {
      const value = readNode(option, cursor, context, found);
      // The first option that fits exactly and checks out wins; then the first that fits.
      if (cursor.remaining === 0 && found.length === 0) return value;
      if (cursor.remaining === 0) {
        exact ??= { value, problems: found };
        continue;
      }
      best ??= {
        value,
        problems: [
          ...found,
          { kind: 'size', detail: `${cursor.remaining} bytes left of ${data.length}` },
        ],
      };
    } catch (error) {
      if (!(error instanceof OutOfData)) throw error;
      best ??= { value: 0, problems: [{ kind: 'size', detail: `runs past ${data.length} bytes` }] };
    }
  }
  if (exact) {
    problems.push(...exact.problems);
    return exact.value;
  }
  if (best) problems.push(...best.problems);
  return undefined;
}

function switchKeys(data: Uint8Array): { text: string; number: string } {
  const end = data.indexOf(0);
  const text = decodeGameText(data, 0, end < 0 ? data.length : end);
  let number = 0;
  for (let i = Math.min(data.length, 4) - 1; i >= 0; i--) number = number * 256 + (data[i] ?? 0);
  return { text, number: data.length >= 1 && data.length <= 4 ? String(number) : text };
}

function readNode(
  node: Node,
  cursor: Cursor,
  context: LayoutContext,
  problems: LayoutProblem[],
): LayoutValue {
  switch (node.kind) {
    case 'prim':
      return readPrim(node.prim, cursor, context, problems);
    case 'bytes':
      return cursor.data.subarray(cursor.take(node.size), cursor.offset);
    case 'chars': {
      const at = cursor.take(node.size);
      const end = cursor.data.subarray(at, cursor.offset).indexOf(0);
      return decodeGameText(cursor.data, at, end < 0 ? cursor.offset : at + end);
    }
    case 'rest':
      return cursor.data.subarray(cursor.take(cursor.remaining), cursor.offset);
    case 'group': {
      const values: Record<string, LayoutValue> = {};
      for (const item of node.items) {
        if (item.optional && cursor.remaining === 0) break;
        let value: LayoutValue;
        if (item.repeat === undefined) {
          value = readNode(item.node, cursor, context, problems);
        } else {
          const list: LayoutValue[] = [];
          const count =
            item.repeat === 'end'
              ? Infinity
              : typeof item.repeat === 'number'
                ? item.repeat
                : Number(values[item.repeat] ?? 0);
          while (list.length < count && (item.repeat !== 'end' || cursor.remaining > 0)) {
            list.push(readNode(item.node, cursor, context, problems));
          }
          value = list;
        }
        if (item.name !== undefined) values[item.name] = value;
      }
      return values;
    }
  }
}

function readPrim(
  prim: Prim,
  cursor: Cursor,
  context: LayoutContext,
  problems: LayoutProblem[],
): LayoutValue {
  const view = cursor.view;
  switch (prim) {
    case 'u8':
      return view.getUint8(cursor.take(1));
    case 'i8':
      return view.getInt8(cursor.take(1));
    case 'u16':
      return view.getUint16(cursor.take(2), true);
    case 'i16':
      return view.getInt16(cursor.take(2), true);
    case 'u32':
      return view.getUint32(cursor.take(4), true);
    case 'i32':
      return view.getInt32(cursor.take(4), true);
    case 'u64':
      return view.getBigUint64(cursor.take(8), true);
    case 'f32':
      return view.getFloat32(cursor.take(4), true);
    case 'fid': {
      const id = view.getUint32(cursor.take(4), true);
      if (id !== 0 && id !== 0xffffffff && id >>> 24 > context.masterCount) {
        problems.push({ kind: 'formId', detail: id.toString(16).padStart(8, '0') });
      }
      return id;
    }
    case 'ws':
    case 'ls': {
      const length =
        prim === 'ws' ? view.getUint16(cursor.take(2), true) : view.getUint32(cursor.take(4), true);
      const at = cursor.take(length);
      return decodeGameText(cursor.data, at, at + length);
    }
    case 'lz':
      if (context.localized) {
        const id = view.getUint32(cursor.take(4), true);
        if (id !== 0 && context.strings && context.strings.get(id) === undefined) {
          problems.push({ kind: 'stringId', detail: String(id) });
        }
        return id;
      }
      return readZString(cursor, problems);
    case 'z':
      return readZString(cursor, problems);
  }
}

function readZString(cursor: Cursor, problems: LayoutProblem[]): string {
  const start = cursor.offset;
  const end = cursor.data.indexOf(0, start);
  if (end < 0) {
    // Some strings fill their subrecord without a NUL: read to the end, but say so.
    problems.push({ kind: 'string', detail: 'no NUL' });
    cursor.take(cursor.remaining);
    return decodeGameText(cursor.data, start, cursor.offset);
  }
  cursor.take(end + 1 - start);
  return decodeGameText(cursor.data, start, end);
}
