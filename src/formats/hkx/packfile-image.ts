// Turns a binary tagfile into the 64-bit packfile Skyrim SE's own behaviors are: every object
// laid out as the class layouts say (layouts.ts), pointers, strings and arrays as fixups. The
// readers then take tagfiles and packfiles alike (Packfile.parse does this for a tagfile).
// Members a tagfile leaves out are zero, as the tagfile writer leaves out only zero values;
// members of classes without a known layout are reported, not placed. Platform-independent.

import { FormatError } from '../binary-reader.ts';
import {
  HAVOK_LAYOUTS,
  findMember,
  inlineSize,
  type InlineType,
  type MemberType,
} from './layouts.ts';
import type { TagObject, TagValue, Tagfile } from './tagfile.ts';

export interface PackfileImage {
  /** A complete packfile (header, class names, data with its fixups). */
  readonly bytes: Uint8Array;
  /** "Class.member" of every member left out: no known layout, or not of the expected kind. */
  readonly skipped: readonly string[];
}

const HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 48;
const DEFAULT_VERSION = 'hk_2010.2.0-r1';
/** hkArray's capacityAndFlags: the memory is not the array's to free. */
const DONT_DEALLOCATE = 0x80000000;

export function packfileFromTagfile(tagfile: Tagfile): PackfileImage {
  if (!tagfile.root) throw new FormatError('Tagfile without objects', 0);
  const data = new ImageWriter();
  data.object(tagfile.root);
  data.flush();
  return {
    bytes: assemble(data, tagfile.havokVersion || DEFAULT_VERSION),
    skipped: [...data.skipped].sort(),
  };
}

function isList(value: TagValue): value is readonly TagValue[] {
  return Array.isArray(value);
}

function isObject(value: TagValue): value is TagObject {
  return value !== null && typeof value === 'object' && 'fields' in value;
}

/** The data section being written: objects, then the arrays and strings they point to. */
class ImageWriter {
  bytes = new Uint8Array(4096);
  view = new DataView(this.bytes.buffer);
  length = 0;
  readonly local: [number, number][] = [];
  readonly global: [number, number][] = [];
  readonly virtual: [number, string][] = [];
  readonly skipped = new Set<string>();
  readonly #offsets = new Map<TagObject, number>();
  readonly #pending: TagObject[] = [];

  /** Where an object goes; it is placed now and written by flush(). */
  object(object: TagObject): number {
    const known = this.#offsets.get(object);
    if (known !== undefined) return known;
    const layout = layoutOf(object);
    const at = this.alloc(layout ? (HAVOK_LAYOUTS[layout]?.size ?? 16) : 16, 16);
    this.#offsets.set(object, at);
    this.virtual.push([at, object.classes[0] ?? '']);
    this.#pending.push(object);
    return at;
  }

  flush(): void {
    for (let object = this.#pending.shift(); object; object = this.#pending.shift()) {
      const at = this.#offsets.get(object) ?? 0;
      this.#fields(object, layoutOf(object), at);
    }
  }

  alloc(size: number, align: number): number {
    const at = Math.ceil(this.length / align) * align;
    const end = at + size;
    if (end > this.bytes.length) {
      const grown = new Uint8Array(Math.max(end, this.bytes.length * 2));
      grown.set(this.bytes);
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = end;
    return at;
  }

  #fields(object: TagObject, layout: string | undefined, at: number): void {
    const owner = object.classes[0] ?? '?';
    for (const [name, value] of object.fields) {
      const member = layout ? findMember(layout, name) : undefined;
      if (!member || !this.#member(at + member[0], member[1], value)) {
        this.skipped.add(`${owner}.${name}`);
      }
    }
  }

  /** Writes a member; false when the value is not of the member's kind. */
  #member(at: number, type: MemberType, value: TagValue): boolean {
    if (!type.startsWith('array:')) return this.#inline(at, type as InlineType, value);
    const element = type.slice('array:'.length) as InlineType;
    const items: readonly TagValue[] | Uint8Array | undefined =
      value instanceof Uint8Array ? value : isList(value) ? value : undefined;
    if (!items) return false;
    if (items.length === 0) return true;
    const stride = inlineSize(element);
    const block = this.alloc(items.length * stride, 16);
    this.local.push([at, block]);
    this.view.setInt32(at + 8, items.length, true);
    this.view.setUint32(at + 12, (items.length | DONT_DEALLOCATE) >>> 0, true);
    let ok = true;
    for (let i = 0; i < items.length; i++) {
      ok = this.#inline(block + i * stride, element, items[i] ?? null) && ok;
    }
    return ok;
  }

  #inline(at: number, type: InlineType, value: TagValue): boolean {
    switch (type) {
      case 'ptr':
        if (value === null) return true;
        if (!isObject(value)) return false;
        this.global.push([at, this.object(value)]);
        return true;
      case 'str': {
        if (value === null) return true;
        if (typeof value !== 'string') return false;
        const text = this.alloc(value.length + 1, 1);
        for (let i = 0; i < value.length; i++) this.bytes[text + i] = value.charCodeAt(i) & 0xff;
        this.local.push([at, text]);
        return true;
      }
      case 'vec4':
      case 'qs': {
        if (!(value instanceof Float32Array)) return false;
        const count = type === 'vec4' ? 4 : 12;
        for (let i = 0; i < count; i++) this.view.setFloat32(at + i * 4, value[i] ?? 0, true);
        return true;
      }
      case 'f32':
        if (typeof value !== 'number') return false;
        this.view.setFloat32(at, value, true);
        return true;
      default:
        break;
    }
    if (type.startsWith('struct:')) {
      if (!isObject(value)) return false;
      this.#fields(value, type.slice('struct:'.length), at);
      return true;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    switch (type) {
      case 'bool':
      case 'u8':
      case 'i8':
        this.view.setUint8(at, value & 0xff);
        return true;
      case 'u16':
      case 'i16':
        this.view.setUint16(at, value & 0xffff, true);
        return true;
      case 'u32':
      case 'i32':
        this.view.setUint32(at, value >>> 0, true);
        return true;
      case 'u64':
        this.view.setBigUint64(at, BigInt.asUintN(64, BigInt(value)), true);
        return true;
      default:
        return false;
    }
  }
}

/** The most derived class of an object with a known layout (its bases are known then too). */
function layoutOf(object: TagObject): string | undefined {
  return object.classes.find((name) => HAVOK_LAYOUTS[name] !== undefined);
}

/** Header, __classnames__, __types__ and __data__ with its fixup tables. */
function assemble(data: ImageWriter, version: string): Uint8Array {
  const pad = (n: number): number => Math.ceil(n / 16) * 16;
  // Class names: signature (unused here), 0x09, the name and its terminator.
  const names = new Map<string, number>();
  const nameBytes: number[] = [];
  for (const [, name] of data.virtual) {
    if (names.has(name)) continue;
    nameBytes.push(0, 0, 0, 0, 0x09);
    names.set(name, nameBytes.length);
    for (let i = 0; i < name.length; i++) nameBytes.push(name.charCodeAt(i) & 0xff);
    nameBytes.push(0);
  }
  const namesStart = HEADER_SIZE + 3 * SECTION_HEADER_SIZE;
  const namesSize = pad(nameBytes.length);
  const dataStart = namesStart + namesSize;
  const local = pad(data.length);
  const global = local + pad(data.local.length * 8);
  const virtual = global + pad(data.global.length * 12);
  const end = virtual + pad(data.virtual.length * 12);

  const bytes = new Uint8Array(dataStart + end);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x57e0e057, true);
  view.setUint32(4, 0x10c0c010, true);
  view.setInt32(12, 8, true);
  bytes.set([8, 1, 0, 1], 16);
  view.setInt32(20, 3, true);
  view.setInt32(24, 2, true);
  view.setInt32(28, 0, true);
  view.setInt32(32, 0, true);
  view.setInt32(36, names.get(data.virtual[0]?.[1] ?? '') ?? 0, true);
  for (let i = 0; i < Math.min(version.length, 15); i++) bytes[40 + i] = version.charCodeAt(i);
  view.setInt16(60, -1, true);
  view.setInt16(62, -1, true);

  const section = (index: number, name: string, start: number, ends: number[]): void => {
    const at = HEADER_SIZE + index * SECTION_HEADER_SIZE;
    for (let i = 0; i < name.length; i++) bytes[at + i] = name.charCodeAt(i);
    bytes[at + 19] = 0xff;
    view.setUint32(at + 20, start, true);
    ends.forEach((value, i) => {
      view.setUint32(at + 24 + i * 4, value, true);
    });
  };
  const flat = (size: number): number[] => [size, size, size, size, size, size];
  section(0, '__classnames__', namesStart, flat(namesSize));
  section(1, '__types__', dataStart, flat(0));
  section(2, '__data__', dataStart, [local, global, virtual, end, end, end]);

  bytes.set(nameBytes, namesStart);
  bytes.set(data.bytes.subarray(0, data.length), dataStart);
  bytes.fill(0xff, dataStart + local, dataStart + end);
  data.local.forEach(([source, target], i) => {
    view.setInt32(dataStart + local + i * 8, source, true);
    view.setInt32(dataStart + local + i * 8 + 4, target, true);
  });
  data.global.forEach(([source, target], i) => {
    const at = dataStart + global + i * 12;
    view.setInt32(at, source, true);
    view.setInt32(at + 4, 2, true);
    view.setInt32(at + 8, target, true);
  });
  data.virtual.forEach(([offset, name], i) => {
    const at = dataStart + virtual + i * 12;
    view.setInt32(at, offset, true);
    view.setInt32(at + 4, 0, true);
    view.setInt32(at + 8, names.get(name) ?? 0, true);
  });
  return bytes;
}
