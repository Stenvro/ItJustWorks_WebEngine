// PlaceObject2 and PlaceObject3: where a placed instance's clip actions (onClipEvent code, and
// how a CLIK component gets the parameters set for it in Flash's component inspector, e.g. a
// button's label) lie in the tag, and rewriting them. Layout after Adobe's SWF File Format
// Specification 19 (PlaceObject2, PlaceObject3, MATRIX, CXFORMWITHALPHA, FILTERLIST,
// CLIPACTIONS). Notes: docs/formats/swf.md.

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { rewriteAvm1Strings, type StringRewrite } from './avm1-rewrite.ts';
import { SwfTagCode } from './swf.ts';

/** Reads bit fields from a byte position, most significant bit first. */
class Bits {
  #byte = 0;
  #left = 0;
  #at: number;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array, at: number) {
    this.#bytes = bytes;
    this.#at = at;
  }

  unsigned(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.#left === 0) {
        if (this.#at >= this.#bytes.length)
          throw new FormatError('bit field past the end', this.#at);
        this.#byte = this.#bytes[this.#at++] ?? 0;
        this.#left = 8;
      }
      this.#left--;
      value = value * 2 + ((this.#byte >> this.#left) & 1);
    }
    return value;
  }

  /** The byte after the last one read from. */
  get end(): number {
    return this.#at;
  }
}

function skipMatrix(bytes: Uint8Array, at: number): number {
  const bits = new Bits(bytes, at);
  if (bits.unsigned(1)) bits.unsigned(bits.unsigned(5) * 2);
  if (bits.unsigned(1)) bits.unsigned(bits.unsigned(5) * 2);
  bits.unsigned(bits.unsigned(5) * 2);
  return bits.end;
}

function skipColorTransform(bytes: Uint8Array, at: number): number {
  const bits = new Bits(bytes, at);
  const add = bits.unsigned(1);
  const mult = bits.unsigned(1);
  const size = bits.unsigned(4);
  bits.unsigned(size * 4 * (add + mult));
  return bits.end;
}

function skipString(bytes: Uint8Array, at: number): number {
  const end = bytes.indexOf(0, at);
  if (end < 0) throw new FormatError('unterminated string', at);
  return end + 1;
}

/** FILTERLIST: a count, then filters whose sizes depend on their kind. */
function skipFilters(bytes: Uint8Array, at: number): number {
  const reader = new BinaryReader(bytes, at);
  const count = reader.u8();
  for (let i = 0; i < count; i++) {
    const kind = reader.u8();
    switch (kind) {
      case 0: // DropShadow
        reader.skip(23);
        break;
      case 1: // Blur
        reader.skip(9);
        break;
      case 2: // Glow
        reader.skip(15);
        break;
      case 3: // Bevel
        reader.skip(27);
        break;
      case 4: // GradientGlow
      case 7: {
        // GradientBevel
        const colors = reader.u8();
        reader.skip(colors * 5 + 19);
        break;
      }
      case 5: {
        // Convolution
        const x = reader.u8();
        const y = reader.u8();
        reader.skip(8 + x * y * 4 + 4 + 1);
        break;
      }
      case 6: // ColorMatrix
        reader.skip(80);
        break;
      default:
        throw new FormatError(`unknown filter ${String(kind)}`, reader.offset - 1);
    }
  }
  return reader.offset;
}

/** Where a PlaceObject2/3's clip actions start, or undefined if it has none. */
export function clipActionsOffset(body: Uint8Array, code: number): number | undefined {
  const flags = body[0] ?? 0;
  if ((flags & 0x80) === 0) return undefined;
  const third = code === SwfTagCode.placeObject3;
  const flags2 = third ? (body[1] ?? 0) : 0;
  let at = third ? 2 : 1;
  at += 2; // depth
  if (third && (flags2 & 0x08 || (flags2 & 0x10 && flags & 0x02))) at = skipString(body, at);
  if (flags & 0x02) at += 2; // character id
  if (flags & 0x04) at = skipMatrix(body, at);
  if (flags & 0x08) at = skipColorTransform(body, at);
  if (flags & 0x10) at += 2; // ratio
  if (flags & 0x20) at = skipString(body, at); // name
  if (flags & 0x40) at += 2; // clip depth
  if (third) {
    if (flags2 & 0x01) at = skipFilters(body, at);
    if (flags2 & 0x02) at += 1; // blend mode
    if (flags2 & 0x04) at += 1; // cache as bitmap
    if (flags2 & 0x20) at += 5; // visible, background colour
  }
  return at;
}

/**
 * The tag body with the strings of its clip actions rewritten (each record's size moved
 * along); the same bytes when it has none or nothing changed. SWF 6+ (32-bit event flags).
 */
export function rewriteClipActions(
  body: Uint8Array,
  code: number,
  version: number,
  rewrite: StringRewrite,
): Uint8Array {
  const start = clipActionsOffset(body, code);
  if (start === undefined || version < 6) return body;
  const reader = new BinaryReader(body, start);
  reader.skip(2 + 4); // reserved, all event flags
  const out: number[] = [...body.subarray(0, reader.offset)];
  let changed = false;
  for (;;) {
    const events = reader.u32();
    out.push(events & 0xff, (events >>> 8) & 0xff, (events >>> 16) & 0xff, events >>> 24);
    if (events === 0) break;
    const size = reader.u32();
    const record = reader.bytes(size);
    // ClipEventKeyPress (bit 22 of the 32-bit flags, bit 6 of the third byte): a key code first.
    const keyPress = (events & (1 << 22)) !== 0 ? 1 : 0;
    const actions = record.subarray(keyPress);
    const rewritten = rewriteAvm1Strings(actions, version, rewrite);
    if (rewritten !== actions) changed = true;
    const length = keyPress + rewritten.length;
    out.push(length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, length >>> 24);
    if (keyPress) out.push(record[0] ?? 0);
    out.push(...rewritten);
  }
  out.push(...body.subarray(reader.offset));
  return changed ? Uint8Array.from(out) : body;
}
