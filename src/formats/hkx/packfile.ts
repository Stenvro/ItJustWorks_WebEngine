// Havok packfiles (.hkx, binary "packfile" format of Havok 2010.2.0-r1 as Skyrim SE ships them:
// 64-bit, little-endian). A packfile is the in-memory image of a set of C++ objects: the
// __data__ section holds the objects back to back, and three fixup tables turn it into live
// memory. Local fixups patch pointers to raw data (arrays, strings), global fixups pointers to
// other objects, virtual fixups name each object's class (the vtable). Layout:
// docs/formats/hkx.md (hkxcmd, HKX2 and serde-hkx).
//
// This module reads that image generically; the classes' member layouts live with the code
// that interprets them (behavior.ts).

import { FormatError } from '../binary-reader.ts';

const MAGIC_0 = 0x57e0e057;
const MAGIC_1 = 0x10c0c010;
const TAGFILE_0 = 0xcab00d1e;
const TAGFILE_1 = 0xd011face;
const HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 48;
/** hkArray's capacityAndFlags: the array does not own its memory (always set in packfiles). */
const ARRAY_SIZE_MASK = 0x3fffffff;

/** An object of the data section: its offset there and its class. */
export interface HkxObject {
  readonly offset: number;
  readonly className: string;
}

interface Section {
  readonly name: string;
  readonly start: number;
  readonly localFixups: number;
  readonly globalFixups: number;
  readonly virtualFixups: number;
  readonly exports: number;
  readonly end: number;
}

/**
 * A parsed packfile. Offsets passed to the readers are offsets in the data section (an
 * object's offset plus a member's offset in the class).
 */
export class Packfile {
  /** Havok version that wrote the file ("hk_2010.2.0-r1"). */
  readonly version: string;
  /** Every object in the data section, by offset. */
  readonly objects: ReadonlyMap<number, HkxObject>;
  /** The contents object (an hkRootLevelContainer). */
  readonly root: HkxObject | undefined;

  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  readonly #data: Section;
  readonly #pointers: ReadonlyMap<number, number>;
  readonly #objectPointers: ReadonlyMap<number, number>;

  private constructor(
    bytes: Uint8Array,
    version: string,
    data: Section,
    objects: Map<number, HkxObject>,
    pointers: Map<number, number>,
    objectPointers: Map<number, number>,
    root: HkxObject | undefined,
  ) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.version = version;
    this.#data = data;
    this.objects = objects;
    this.#pointers = pointers;
    this.#objectPointers = objectPointers;
    this.root = root;
  }

  /** Parses a packfile; throws FormatError for anything else (tagfiles, 32-bit packfiles). */
  static parse(bytes: Uint8Array): Packfile {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < HEADER_SIZE) throw new FormatError('HKX file too short', 0);
    if (view.getUint32(0, true) === TAGFILE_0 && view.getUint32(4, true) === TAGFILE_1) {
      // Creation Club and resource-pack behaviors ship binary tagfiles (.hkt).
      throw new FormatError('Havok binary tagfiles are not read yet: TODO(M7)', 0);
    }
    if (view.getUint32(0, true) !== MAGIC_0 || view.getUint32(4, true) !== MAGIC_1) {
      throw new FormatError('Not a Havok packfile', 0);
    }
    const pointerSize = bytes[16] ?? 0;
    const littleEndian = bytes[17] === 1;
    if (pointerSize !== 8 || !littleEndian) {
      // Skyrim SE loads only 64-bit packfiles; 32-bit ones are Skyrim LE files.
      throw new FormatError(`Unsupported packfile layout: ${String(pointerSize * 8)}-bit`, 16);
    }
    const sectionCount = view.getInt32(20, true);
    const contentsSection = view.getInt32(24, true);
    const contentsOffset = view.getInt32(28, true);
    const version = cString(bytes, 40, 56);
    const sectionsEnd = HEADER_SIZE + sectionCount * SECTION_HEADER_SIZE;
    if (sectionCount < 1 || sectionsEnd > bytes.byteLength) {
      throw new FormatError(`Invalid packfile section count ${String(sectionCount)}`, 20);
    }
    const sections: Section[] = [];
    for (let i = 0; i < sectionCount; i++) {
      const at = HEADER_SIZE + i * SECTION_HEADER_SIZE;
      const start = view.getUint32(at + 20, true);
      const section: Section = {
        name: cString(bytes, at, at + 19),
        start,
        localFixups: view.getUint32(at + 24, true),
        globalFixups: view.getUint32(at + 28, true),
        virtualFixups: view.getUint32(at + 32, true),
        exports: view.getUint32(at + 36, true),
        end: view.getUint32(at + 44, true),
      };
      if (start + section.end > bytes.byteLength) {
        throw new FormatError(`Packfile section ${section.name} runs past the end`, at);
      }
      sections.push(section);
    }
    const data = sections.find((section) => section.name === '__data__');
    const classNames = sections.find((section) => section.name === '__classnames__');
    if (!data || !classNames) throw new FormatError('Packfile without data or class names', 64);

    // Local fixups: (source, target) pairs, both offsets in the data section; -1 pads.
    const pointers = new Map<number, number>();
    for (
      let at = data.start + data.localFixups;
      at + 8 <= data.start + data.globalFixups;
      at += 8
    ) {
      const source = view.getInt32(at, true);
      if (source !== -1) pointers.set(source, view.getUint32(at + 4, true));
    }
    // Global fixups: (source, target section, target offset); objects are in the data section.
    const objectPointers = new Map<number, number>();
    for (
      let at = data.start + data.globalFixups;
      at + 12 <= data.start + data.virtualFixups;
      at += 12
    ) {
      const source = view.getInt32(at, true);
      if (source === -1) continue;
      if (sections[view.getInt32(at + 4, true)] !== data) continue;
      objectPointers.set(source, view.getUint32(at + 8, true));
    }
    // Virtual fixups: (object offset, class name section, class name offset).
    const objects = new Map<number, HkxObject>();
    for (let at = data.start + data.virtualFixups; at + 12 <= data.start + data.exports; at += 12) {
      const offset = view.getInt32(at, true);
      if (offset === -1) continue;
      const nameAt = classNames.start + view.getUint32(at + 8, true);
      objects.set(offset, {
        offset,
        className: cString(bytes, nameAt, classNames.start + classNames.end),
      });
    }
    const root = sections[contentsSection] === data ? objects.get(contentsOffset) : undefined;
    return new Packfile(bytes, version, data, objects, pointers, objectPointers, root);
  }

  /** Objects of a class, in file order. */
  objectsOf(className: string): HkxObject[] {
    return [...this.objects.values()].filter((object) => object.className === className);
  }

  u8(offset: number): number {
    return this.#view.getUint8(this.#at(offset, 1));
  }

  i8(offset: number): number {
    return this.#view.getInt8(this.#at(offset, 1));
  }

  i16(offset: number): number {
    return this.#view.getInt16(this.#at(offset, 2), true);
  }

  u16(offset: number): number {
    return this.#view.getUint16(this.#at(offset, 2), true);
  }

  i32(offset: number): number {
    return this.#view.getInt32(this.#at(offset, 4), true);
  }

  u32(offset: number): number {
    return this.#view.getUint32(this.#at(offset, 4), true);
  }

  f32(offset: number): number {
    return this.#view.getFloat32(this.#at(offset, 4), true);
  }

  bool(offset: number): boolean {
    return this.u8(offset) !== 0;
  }

  /** Raw bytes of the data section (array contents: an animation's compressed data). */
  bytes(offset: number, length: number): Uint8Array {
    const start = this.#at(offset, length);
    return this.#bytes.subarray(start, start + length);
  }

  /** The object a pointer member points to (undefined for null). */
  object(offset: number): HkxObject | undefined {
    const target = this.#objectPointers.get(offset);
    return target === undefined ? undefined : this.objects.get(target);
  }

  /** Where a pointer to raw data (array contents, strings) points, or undefined for null. */
  pointer(offset: number): number | undefined {
    return this.#pointers.get(offset);
  }

  /** An hkStringPtr or char* member (undefined for null). */
  string(offset: number): string | undefined {
    const target = this.#pointers.get(offset);
    if (target === undefined) return undefined;
    const start = this.#data.start + target;
    return cString(this.#bytes, start, this.#data.start + this.#data.end);
  }

  /** An hkArray member: where its elements are and how many there are. */
  array(offset: number): { readonly data: number; readonly size: number } {
    const size = this.i32(offset + 8);
    const data = this.#pointers.get(offset);
    if (size < 0 || (size & ~ARRAY_SIZE_MASK) !== 0) {
      throw new FormatError(`Invalid hkArray size ${String(size)}`, this.#data.start + offset);
    }
    return { data: data ?? 0, size: data === undefined ? 0 : size };
  }

  /** An hkArray of object pointers. */
  objectArray(offset: number): (HkxObject | undefined)[] {
    const { data, size } = this.array(offset);
    return Array.from({ length: size }, (_, i) => this.object(data + i * 8));
  }

  /** An hkArray of hkStringPtr. */
  stringArray(offset: number): string[] {
    const { data, size } = this.array(offset);
    return Array.from({ length: size }, (_, i) => this.string(data + i * 8) ?? '');
  }

  #at(offset: number, size: number): number {
    if (offset < 0 || offset + size > this.#data.end) {
      throw new FormatError(`Read outside the packfile data section`, this.#data.start + offset);
    }
    return this.#data.start + offset;
  }
}

/** A null-terminated ASCII string starting at `start`, read no further than `limit`. */
function cString(bytes: Uint8Array, start: number, limit: number): string {
  let end = start;
  while (end < limit && end < bytes.byteLength && bytes[end] !== 0) end++;
  let text = '';
  for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}
