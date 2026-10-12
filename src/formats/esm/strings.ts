// Localized string tables: strings\<plugin>_<language>.STRINGS / .DLSTRINGS / .ILSTRINGS.
// Localized plugins store u32 ids in text fields instead of the text itself.
// Format: docs/formats/esm.md

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeGameText } from '../text.ts';

/** `.STRINGS` holds null-terminated strings; DL/IL strings are length-prefixed. */
export type StringTableKind = 'strings' | 'dlstrings' | 'ilstrings';

export const STRING_TABLE_KINDS: readonly StringTableKind[] = ['strings', 'dlstrings', 'ilstrings'];

/** One string table file, decoded lazily (Skyrim's tables hold tens of thousands of entries). */
export class StringTable {
  readonly kind: StringTableKind;
  readonly #bytes: Uint8Array;
  readonly #dataStart: number;
  readonly #offsets = new Map<number, number>();

  constructor(bytes: Uint8Array, kind: StringTableKind) {
    const reader = new BinaryReader(bytes);
    const count = reader.u32();
    const dataSize = reader.u32();
    if (8 + count * 8 + dataSize > bytes.length) {
      throw new FormatError(`String table claims ${count} entries / ${dataSize} bytes`, 0);
    }
    for (let i = 0; i < count; i++) {
      const id = reader.u32();
      const offset = reader.u32();
      if (offset >= dataSize)
        throw new FormatError(`String ${id} offset outside data`, reader.offset - 4);
      this.#offsets.set(id, offset);
    }
    this.kind = kind;
    this.#bytes = bytes;
    this.#dataStart = reader.offset;
  }

  get size(): number {
    return this.#offsets.size;
  }

  has(id: number): boolean {
    return this.#offsets.has(id);
  }

  get(id: number): string | undefined {
    const offset = this.#offsets.get(id);
    if (offset === undefined) return undefined;
    const start = this.#dataStart + offset;
    if (this.kind === 'strings') {
      const end = this.#bytes.indexOf(0, start);
      if (end < 0) throw new FormatError(`String ${id} is not null-terminated`, start);
      return decodeGameText(this.#bytes, start, end);
    }
    const length = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + start, 4).getUint32(
      0,
      true,
    );
    // The length includes the terminating null.
    const end = start + 4 + Math.max(0, length - 1);
    if (end > this.#bytes.length) throw new FormatError(`String ${id} runs past the table`, start);
    return decodeGameText(this.#bytes, start + 4, end);
  }

  *ids(): IterableIterator<number> {
    yield* this.#offsets.keys();
  }
}

/** The three tables of one localized plugin; lookups try each. */
export class PluginStrings {
  readonly #tables: readonly StringTable[];

  constructor(tables: readonly StringTable[]) {
    this.#tables = tables;
  }

  get(id: number): string | undefined {
    if (id === 0) return '';
    for (const table of this.#tables) {
      const value = table.get(id);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}

/** Path of a string table in the VFS, e.g. `strings\skyrim_english.strings`. */
export function stringTablePath(plugin: string, language: string, kind: StringTableKind): string {
  const base = plugin.slice(0, plugin.lastIndexOf('.'));
  return `strings\\${base}_${language}.${kind}`.toLowerCase();
}
