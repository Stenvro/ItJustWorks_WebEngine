// The original's save files (docs/formats/ess.md): the reader's own value types on top of the
// binary reader. Platform-independent.

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeWindows1252 } from '../text.ts';

/** A reference id as the save writes it: 3 bytes, big-endian; the top 2 bits say its kind. */
export type RawRefId = number;

/** What a raw reference id's top two bits say. */
export const RefIdKind = {
  /** An index (1-based) into the save's form id array; 0 is no form. */
  Indexed: 0,
  /** A form of the first master (Skyrim.esm): the value is its form id. */
  Default: 1,
  /** A form the game made (0xFF000000 and up). */
  Created: 2,
  Unknown: 3,
} as const;

export class EssReader extends BinaryReader {
  /** A string with a u16 length (no terminator), Windows-1252. */
  wstring(): string {
    const bytes = this.bytes(this.u16());
    return decodeWindows1252(bytes, 0, bytes.length);
  }

  /**
   * A variable-size count: the low 2 bits of the first byte give the size (0: 1 byte, 1: 2
   * bytes, 2: 4 bytes), the rest is the value (6, 14 or 30 bits).
   */
  vsval(): number {
    const first = this.u8();
    switch (first & 3) {
      case 0:
        return first >>> 2;
      case 1:
        return (first | (this.u8() << 8)) >>> 2;
      case 2: {
        const rest = this.u8() | (this.u8() << 8) | (this.u8() << 16);
        return ((first | (rest << 8)) >>> 2) >>> 0;
      }
      default:
        throw new FormatError(`Invalid variable-size value ${String(first)}`, this.offset - 1);
    }
  }

  /** A raw reference id (resolve it with the form id array: resolveRefId). */
  refId(): RawRefId {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8();
  }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }
}

/**
 * A raw reference id as a form id in the save's load order: by the save's form id array, a
 * Skyrim.esm form, or one the game made. Undefined for a kind the format leaves unknown.
 */
export function resolveRefId(raw: RawRefId, formIds: ArrayLike<number>): number | undefined {
  const kind = raw >>> 22;
  const value = raw & 0x3fffff;
  switch (kind) {
    case RefIdKind.Indexed:
      return value === 0 ? 0 : formIds[value - 1];
    case RefIdKind.Default:
      return value;
    case RefIdKind.Created:
      return (0xff000000 | value) >>> 0;
    default:
      return undefined;
  }
}
