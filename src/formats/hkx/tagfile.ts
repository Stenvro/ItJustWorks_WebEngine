// Havok binary tagfiles (hk_2010 tag stream, magic 0xCAB00D1E 0xD011FACE), as the Creation
// Club and resource-pack behaviors ship them (.hkt). A stream of tags: file info (version and
// the Havok version), class definitions (name, version, parent, members with their types),
// and objects (a class, a bitmap of the members present, their values; objects refer to each
// other by number). Unlike packfiles they carry their own type information and leave out
// members at their defaults. Layout: hkxparse (exyorha, MIT) read as documentation; notes in
// docs/formats/hkx.md ("Tagfiles"). Platform-independent.

import { FormatError } from '../binary-reader.ts';

export const TAGFILE_MAGIC = [0xcab00d1e, 0xd011face] as const;

const TAG_FILE_INFO = 1;
const TAG_METADATA = 2;
const TAG_OBJECT = 3;
const TAG_OBJECT_REMEMBER = 4;
const TAG_OBJECT_BACKREF = 5;
const TAG_OBJECT_NULL = 6;
const TAG_FILE_END = 7;

/** A member's basic type (the low four bits of its type). */
export const TagType = {
  void: 0,
  byte: 1,
  int: 2,
  real: 3,
  vec4: 4,
  vec8: 5,
  vec12: 6,
  vec16: 7,
  object: 8,
  struct: 9,
  cstring: 10,
} as const;
const BASIC_MASK = 0x0f;
const ARRAY_FLAG = 0x10;
const TUPLE_FLAG = 0x20;

/** A class as the tagfile defines it. */
export interface TagClass {
  readonly name: string;
  readonly version: number;
  /** Index of the parent class (0: none). */
  readonly parent: number;
  readonly members: readonly TagMember[];
}

export interface TagMember {
  readonly name: string;
  /** Basic type, ARRAY_FLAG and TUPLE_FLAG (TagType). */
  readonly type: number;
  readonly tupleSize: number;
  /** The class of an object or struct member. */
  readonly className: string | undefined;
}

/** A member's value. */
export type TagValue =
  number | string | Uint8Array | Float32Array | TagObject | null | readonly TagValue[];

/** An object or struct: its class and the values of the members it has. */
export interface TagObject {
  /** The class and its bases, most derived first. */
  readonly classes: string[];
  readonly fields: Map<string, TagValue>;
}

export interface Tagfile {
  readonly version: number;
  /** The Havok version that wrote it ("hk_2010.2.0-r1"). */
  readonly havokVersion: string;
  readonly classes: readonly TagClass[];
  /** The root object (the first one). */
  readonly root: TagObject | undefined;
}

export function isTagfile(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(0, true) === TAGFILE_MAGIC[0] && view.getUint32(4, true) === TAGFILE_MAGIC[1]
  );
}

export function parseTagfile(bytes: Uint8Array): Tagfile {
  if (!isTagfile(bytes)) throw new FormatError('Not a Havok tagfile', 0);
  return new TagReader(bytes).read();
}

class TagReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #at = 8;
  #strings: string[] = ['', ''];
  readonly #classes: TagClass[] = [{ name: '', version: 0, parent: 0, members: [] }];
  readonly #byName = new Map<string, number>();
  readonly #objects = new Map<number, TagObject>();
  #nextObject = 1;
  #version = 0;
  #havokVersion = '';

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  read(): Tagfile {
    let root: TagObject | null = null;
    for (;;) {
      // Version 0 files (the fishing rod's) end after their object, without an end tag.
      if (this.#version < 3 && root !== null && this.#at === this.#bytes.length) break;
      const tag = this.#int();
      if (tag === TAG_FILE_END) break;
      switch (tag) {
        case TAG_FILE_INFO: {
          this.#version = this.#int();
          if (this.#version < 0 || this.#version > 4) {
            throw new FormatError(`tagfile version ${String(this.#version)}`, this.#at);
          }
          // Remembered objects count from 1 from version 3 on, from 0 before.
          this.#nextObject = this.#version < 3 ? 0 : 1;
          this.#strings = ['', ''];
          if (this.#version === 4) this.#havokVersion = this.#string();
          break;
        }
        case TAG_METADATA: {
          const type = this.#classDefinition();
          this.#byName.set(type.name, this.#classes.length);
          this.#classes.push(type);
          break;
        }
        case TAG_OBJECT:
        case TAG_OBJECT_REMEMBER:
        case TAG_OBJECT_BACKREF:
        case TAG_OBJECT_NULL: {
          if (this.#version < 3) {
            // Before version 3 the root holds every other object in place.
            const object = this.#inline(tag);
            root ??= object;
          } else if (tag === TAG_OBJECT_REMEMBER) {
            // From version 3 objects come one after the other, numbered as they come.
            this.#struct(this.#placeholder(this.#nextObject++), 0);
          } else {
            throw new FormatError(`tagfile tag ${String(tag)}`, this.#at);
          }
          break;
        }
        default:
          throw new FormatError(`tagfile tag ${String(tag)}`, this.#at);
      }
    }
    return {
      version: this.#version,
      havokVersion: this.#havokVersion,
      classes: this.#classes,
      root: root ?? this.#objects.get(1),
    };
  }

  /** The object of a number, made empty when it is referred to before it comes. */
  #placeholder(id: number): TagObject {
    let object = this.#objects.get(id);
    if (!object) {
      object = { classes: [], fields: new Map() };
      this.#objects.set(id, object);
    }
    return object;
  }

  /**
   * An object written in place (versions before 3): a new one, remembered for later references
   * or not, a reference to a remembered one, or null.
   */
  #inline(tag: number): TagObject | null {
    switch (tag) {
      case TAG_OBJECT: {
        const object: TagObject = { classes: [], fields: new Map() };
        this.#struct(object, 0);
        return object;
      }
      case TAG_OBJECT_REMEMBER: {
        const object = this.#placeholder(this.#nextObject++);
        this.#struct(object, 0);
        return object;
      }
      case TAG_OBJECT_BACKREF: {
        const object = this.#objects.get(this.#int());
        if (!object) throw new FormatError('tagfile reference to an unknown object', this.#at);
        return object;
      }
      case TAG_OBJECT_NULL:
        return null;
      default:
        throw new FormatError(`tagfile object tag ${String(tag)}`, this.#at);
    }
  }

  /** A signed variable-length integer: sign in bit 0 of the first byte, 6 then 7 bits each. */
  #int(): number {
    let byte = this.#byte();
    const negative = (byte & 1) !== 0;
    let value = (byte & 0x7e) >>> 1;
    let shift = 6;
    while ((byte & 0x80) !== 0) {
      byte = this.#byte();
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 49) throw new FormatError('tagfile integer too long', this.#at);
    }
    return negative ? -value : value;
  }

  #byte(): number {
    if (this.#at >= this.#bytes.length) throw new FormatError('tagfile cut off', this.#at);
    return this.#bytes[this.#at++] ?? 0;
  }

  #raw(count: number): Uint8Array {
    if (count < 0 || this.#at + count > this.#bytes.length) {
      throw new FormatError('tagfile cut off', this.#at);
    }
    const out = this.#bytes.slice(this.#at, this.#at + count);
    this.#at += count;
    return out;
  }

  #float(): number {
    if (this.#at + 4 > this.#bytes.length) throw new FormatError('tagfile cut off', this.#at);
    const value = this.#view.getFloat32(this.#at, true);
    this.#at += 4;
    return value;
  }

  /** A string: new (its length, then its bytes), or one seen before (minus its index). */
  #string(): string {
    const length = this.#int();
    if (length <= 0) {
      const known = this.#strings[-length];
      if (known === undefined) throw new FormatError('tagfile string index', this.#at);
      return known;
    }
    let text = '';
    for (const byte of this.#raw(length)) text += String.fromCharCode(byte);
    this.#strings.push(text);
    return text;
  }

  #classDefinition(): TagClass {
    const name = this.#string();
    const version = this.#int();
    const parent = this.#int();
    const count = this.#int();
    const members: TagMember[] = [];
    for (let i = 0; i < count; i++) {
      const memberName = this.#string();
      const type = this.#int();
      const tupleSize = (type & TUPLE_FLAG) !== 0 ? this.#int() : 0;
      const basic = type & BASIC_MASK;
      const className =
        basic === TagType.object || basic === TagType.struct ? this.#string() : undefined;
      members.push({
        name: memberName,
        type,
        tupleSize,
        className: className === '' ? undefined : className,
      });
    }
    return { name, version, parent, members };
  }

  /** The class chain from the base down. */
  #chain(index: number): TagClass[] {
    const chain: TagClass[] = [];
    for (let i = index, depth = 0; i > 0 && depth < 64; depth++) {
      const type = this.#classes[i];
      if (!type) throw new FormatError(`tagfile class ${String(i)}`, this.#at);
      chain.unshift(type);
      i = type.parent;
    }
    return chain;
  }

  #presence(count: number): Uint8Array {
    return this.#raw((count + 7) >> 3);
  }

  #struct(object: TagObject, classIndex: number): void {
    const index = classIndex === 0 ? this.#int() : classIndex;
    const chain = this.#chain(index);
    const members = chain.flatMap((type) => type.members);
    const present = this.#presence(members.length);
    for (let i = chain.length - 1; i >= 0; i--) object.classes.push(chain[i]?.name ?? '');
    members.forEach((member, i) => {
      if (((present[i >> 3] ?? 0) & (1 << (i & 7))) === 0) return;
      object.fields.set(member.name, this.#member(member));
    });
  }

  #member(member: TagMember): TagValue {
    const basic = member.type & BASIC_MASK;
    const array = (member.type & ARRAY_FLAG) !== 0;
    const tuple = (member.type & TUPLE_FLAG) !== 0;
    if ((member.type & ~(BASIC_MASK | ARRAY_FLAG | TUPLE_FLAG)) !== 0) {
      throw new FormatError(`tagfile member type ${String(member.type)}`, this.#at);
    }
    if (basic === TagType.byte && (array || tuple)) {
      return this.#raw(tuple ? member.tupleSize : this.#int());
    }
    if (array || tuple) {
      const count = tuple ? member.tupleSize : this.#int();
      return this.#array(member, count);
    }
    return this.#value(basic, member.className, -1);
  }

  #array(member: TagMember, count: number): TagValue {
    const basic = member.type & BASIC_MASK;
    // From version 3 integers and vectors give their element width first.
    const prefix =
      this.#version >= 3 && (basic === TagType.int || basic === TagType.vec4) ? this.#int() : -1;
    if (basic === TagType.struct) return this.#structArray(member, count);
    const values: TagValue[] = [];
    for (let i = 0; i < count; i++) values.push(this.#value(basic, member.className, prefix));
    return values;
  }

  /**
   * Struct arrays come member by member: each present member's values for all elements, read
   * as one array of the member's basic type (its own count or tuple size is not repeated).
   */
  #structArray(member: TagMember, count: number): TagValue {
    const index =
      member.className !== undefined ? (this.#byName.get(member.className) ?? 0) : this.#int();
    if (index === 0) throw new FormatError('tagfile struct array without a class', this.#at);
    const chain = this.#chain(index);
    const members = chain.flatMap((type) => type.members);
    const present = this.#presence(members.length);
    const elements: TagObject[] = [];
    for (let i = 0; i < count; i++) {
      elements.push({ classes: chain.map((type) => type.name).reverse(), fields: new Map() });
    }
    members.forEach((field, i) => {
      if (((present[i >> 3] ?? 0) & (1 << (i & 7))) === 0) return;
      const column = this.#array(field, count);
      const values: readonly TagValue[] = Array.isArray(column) ? column : [];
      elements.forEach((element, k) => element.fields.set(field.name, values[k] ?? null));
    });
    return elements;
  }

  #value(basic: number, className: string | undefined, prefix: number): TagValue {
    switch (basic) {
      case TagType.byte:
        return this.#byte();
      case TagType.int:
        return this.#int();
      case TagType.real:
        return this.#float();
      case TagType.vec4: {
        const n = prefix < 0 ? 4 : prefix;
        if (n < 1 || n > 4) throw new FormatError(`tagfile vector of ${String(n)}`, this.#at);
        const out = new Float32Array(4);
        for (let i = 0; i < n; i++) out[i] = this.#float();
        return out;
      }
      case TagType.vec8:
        return Float32Array.from({ length: 8 }, () => this.#float());
      case TagType.vec12:
        return Float32Array.from({ length: 12 }, () => this.#float());
      case TagType.vec16:
        return Float32Array.from({ length: 16 }, () => this.#float());
      case TagType.object: {
        if (this.#version < 3) return this.#inline(this.#int());
        const id = this.#int();
        return id === 0 ? null : this.#placeholder(id);
      }
      case TagType.struct: {
        const index = className !== undefined ? (this.#byName.get(className) ?? 0) : 0;
        const struct: TagObject = { classes: [], fields: new Map() };
        this.#struct(struct, index);
        return struct;
      }
      case TagType.cstring:
        return this.#string();
      default:
        throw new FormatError(`tagfile value type ${String(basic)}`, this.#at);
    }
  }
}
