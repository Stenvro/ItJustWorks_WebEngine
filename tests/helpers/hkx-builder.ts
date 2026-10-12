// Builds small Havok packfiles (64-bit, little-endian, Havok 2010.2.0-r1 layout) for unit
// tests: objects in a data section, with local fixups for strings and arrays, global fixups
// for object pointers and virtual fixups naming each object's class.

const HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 48;
const SECTIONS = ['__classnames__', '__types__', '__data__'] as const;

export class PackfileBuilder {
  #data = new Uint8Array(1024);
  #size = 0;
  readonly #local: [number, number][] = [];
  readonly #global: [number, number][] = [];
  readonly #objects: [number, string][] = [];

  /** Allocates an object of a class (16-byte aligned, zeroed); returns its offset. */
  object(className: string, size: number): number {
    const offset = this.#allocate(size);
    this.#objects.push([offset, className]);
    return offset;
  }

  u8(offset: number, value: number): this {
    this.#view().setUint8(offset, value);
    return this;
  }

  i16(offset: number, value: number): this {
    this.#view().setInt16(offset, value, true);
    return this;
  }

  i32(offset: number, value: number): this {
    this.#view().setInt32(offset, value, true);
    return this;
  }

  f32(offset: number, value: number): this {
    this.#view().setFloat32(offset, value, true);
    return this;
  }

  /** An hkStringPtr / char* member: the text goes after the objects, the member points to it. */
  string(offset: number, text: string): this {
    const at = this.#allocate(text.length + 1);
    for (let i = 0; i < text.length; i++) this.#data[at + i] = text.charCodeAt(i);
    this.#local.push([offset, at]);
    return this;
  }

  /** A pointer member to another object. */
  pointer(offset: number, target: number): this {
    this.#global.push([offset, target]);
    return this;
  }

  /** An hkArray member: allocates its elements; returns where they start. */
  array(offset: number, elementSize: number, count: number): number {
    const at = this.#allocate(Math.max(1, elementSize * count));
    this.#local.push([offset, at]);
    this.i32(offset + 8, count);
    this.i32(offset + 12, count | 0x80000000);
    return at;
  }

  /** The packfile, with `root` as its contents object. */
  build(root: number): Uint8Array {
    const encoder = new TextEncoder();
    // Class names: signature (u32), 0x09, name, NUL.
    const names: number[] = [];
    const nameOffsets = new Map<string, number>();
    for (const [, className] of this.#objects) {
      if (nameOffsets.has(className)) continue;
      names.push(0, 0, 0, 0, 0x09);
      nameOffsets.set(className, names.length);
      names.push(...encoder.encode(className), 0);
    }
    while (names.length % 16 !== 0) names.push(0xff);
    const data = this.#data.slice(0, align(this.#size, 16));
    const fixups = (entries: number[][], width: number): number[] => {
      const words = entries.flat();
      while ((words.length * 4) % 16 !== 0 || words.length % width !== 0) words.push(-1);
      return words;
    };
    const local = fixups(this.#local, 2);
    const global = fixups(
      this.#global.map(([source, target]) => [source, 2, target]),
      3,
    );
    const virtual = fixups(
      this.#objects.map(([offset, className]) => [offset, 0, nameOffsets.get(className) ?? 0]),
      3,
    );
    const classStart = HEADER_SIZE + SECTIONS.length * SECTION_HEADER_SIZE;
    const dataStart = classStart + names.length;
    const total = dataStart + data.length + (local.length + global.length + virtual.length) * 4;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x57e0e057, true);
    view.setUint32(4, 0x10c0c010, true);
    view.setInt32(12, 8, true);
    out.set([8, 1, 0, 1], 16);
    view.setInt32(20, SECTIONS.length, true);
    view.setInt32(24, 2, true);
    view.setInt32(28, root, true);
    view.setInt32(32, 0, true);
    view.setInt32(36, 0, true);
    out.set(encoder.encode('hk_2010.2.0-r1'), 40);
    view.setInt32(56, 0, true);
    const section = (index: number, start: number, size: number, ends: number[]): void => {
      const at = HEADER_SIZE + index * SECTION_HEADER_SIZE;
      out.set(encoder.encode(SECTIONS[index]), at);
      out[at + 19] = 0xff;
      view.setUint32(at + 20, start, true);
      // local, global, virtual, exports, imports, end
      ends.forEach((value, i) => {
        view.setUint32(at + 24 + i * 4, value, true);
      });
      if (ends.length === 0)
        for (let i = 0; i < 6; i++) view.setUint32(at + 24 + i * 4, size, true);
    };
    section(0, classStart, names.length, []);
    section(1, dataStart, 0, []);
    const localAt = data.length;
    const globalAt = localAt + local.length * 4;
    const virtualAt = globalAt + global.length * 4;
    const exportsAt = virtualAt + virtual.length * 4;
    section(2, dataStart, exportsAt, [
      localAt,
      globalAt,
      virtualAt,
      exportsAt,
      exportsAt,
      exportsAt,
    ]);
    out.set(names, classStart);
    out.set(data, dataStart);
    [...local, ...global, ...virtual].forEach((word, i) => {
      view.setInt32(dataStart + localAt + i * 4, word, true);
    });
    return out;
  }

  #allocate(size: number): number {
    const offset = align(this.#size, 16);
    const end = offset + size;
    if (end > this.#data.length) {
      const grown = new Uint8Array(Math.max(end, this.#data.length * 2));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#size = end;
    return offset;
  }

  #view(): DataView {
    return new DataView(this.#data.buffer);
  }
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}
