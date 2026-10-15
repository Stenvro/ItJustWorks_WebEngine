// Links movies a movie imports symbols from (ImportAssets2) into it, as one movie: Scaleform
// loads a menu's imports before it plays (the item menus place their lists, card and bottom bar
// from "Inventory components/*.swf" in their first frame); a Flash player such as Ruffle loads
// them later, after the frame that places them has run. Each import of a linked movie is
// replaced, where it stands, by that movie's definitions (shapes, bitmaps, sprites, text
// fields, fonts and their imports, class code, exports), their character ids moved past the
// importing movie's own, the imported symbol taking the id the import gave it. What refers to
// a character by id is renumbered: definitions, placements (in sprites), text fields' fonts,
// shapes' bitmap fills, CSM text settings, scaling grids, init actions, exports and imports.
// A library whose symbols stand alone (the font library: each font one definition) may be
// linked by the symbols imported only, with what they use: a menu imports one to three of its
// fonts, and Ruffle loads an import slowly (seconds for the 1 MB library, every time a menu
// opens) where it reads definitions in the movie at once.
// Platform-independent. Notes: docs/formats/swf.md ("Linking imports").

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { readSwf, readSwfString, SwfTagCode, type SwfMovie, type SwfTag } from './swf.ts';
import { concatBytes, encodeSwfString, encodeTag, u16Bytes } from './swf-writer.ts';

/** Tag codes the linker handles beyond SwfTagCode's. */
const Tag = {
  defineShape2: 22,
  defineShape3: 32,
  defineShape4: 83,
  defineBits: 6,
  defineBitsJpeg2: 21,
  defineBitsJpeg3: 35,
  defineBitsJpeg4: 90,
  defineBitsLossless: 20,
  defineBitsLossless2: 36,
  defineFont: 10,
  defineFontInfo: 13,
  defineFontInfo2: 62,
  csmTextSettings: 74,
  defineScalingGrid: 78,
  frameLabel: 43,
  removeObject: 5,
  removeObject2: 28,
  placeObject: 4,
  protect: 24,
  enableDebugger2: 64,
  productInfo: 41,
  debugId: 63,
  defineSceneAndFrameLabelData: 86,
} as const;

/** Tags of a linked movie's own timeline, which are not definitions: left out. */
const TIMELINE_TAGS: ReadonlySet<number> = new Set([
  SwfTagCode.end,
  SwfTagCode.showFrame,
  SwfTagCode.setBackgroundColor,
  SwfTagCode.doAction,
  SwfTagCode.placeObject2,
  SwfTagCode.placeObject3,
  SwfTagCode.fileAttributes,
  SwfTagCode.metadata,
  SwfTagCode.scriptLimits,
  Tag.placeObject,
  Tag.removeObject,
  Tag.removeObject2,
  Tag.frameLabel,
  Tag.protect,
  Tag.enableDebugger2,
  Tag.productInfo,
  Tag.debugId,
  Tag.defineSceneAndFrameLabelData,
]);

/** Tags that are a definition with their id first (u16). */
const DEFINITIONS: ReadonlySet<number> = new Set([
  SwfTagCode.defineShape,
  Tag.defineShape2,
  Tag.defineShape3,
  Tag.defineShape4,
  Tag.defineBits,
  Tag.defineBitsJpeg2,
  Tag.defineBitsJpeg3,
  Tag.defineBitsJpeg4,
  Tag.defineBitsLossless,
  Tag.defineBitsLossless2,
  SwfTagCode.defineSprite,
  SwfTagCode.defineEditText,
  Tag.defineFont,
  SwfTagCode.defineFont2,
  SwfTagCode.defineFont3,
  SwfTagCode.defineFont4,
]);

/** Tags whose first u16 is the id of the character they belong to. */
const OF_CHARACTER: ReadonlySet<number> = new Set([
  SwfTagCode.doInitAction,
  SwfTagCode.defineFontAlignZones,
  SwfTagCode.defineFontName,
  Tag.defineFontInfo,
  Tag.defineFontInfo2,
  Tag.csmTextSettings,
  Tag.defineScalingGrid,
]);

/** A movie to link, by the URL an import names (relative to the importer). */
export type LinkSource = (url: string) => Promise<Uint8Array | undefined>;

/**
 * The movie with the imports `linked` accepts (by their URL) replaced by the imported movies'
 * definitions; other imports stay. Those `symbolsOnly` accepts bring only the symbols imported
 * and the definitions they use. The header is kept; the result is uncompressed (FWS).
 */
export async function linkImports(
  movieBytes: Uint8Array,
  linked: (url: string) => boolean,
  source: LinkSource,
  symbolsOnly: (url: string) => boolean = () => false,
): Promise<Uint8Array> {
  const movie = readSwf(movieBytes);
  let nextId = maxCharacterId(movie, movie.tags) + 1;
  const parts: Uint8Array[] = [];
  for (const tag of movie.tags) {
    const body = movie.bytes.subarray(tag.offset, tag.offset + tag.length);
    if (tag.code !== SwfTagCode.importAssets2) {
      parts.push(encodeTag(tag.code, body));
      continue;
    }
    const entry = readImport(body, movie.header.version);
    const bytes = linked(entry.url) ? await source(entry.url) : undefined;
    if (!bytes) {
      parts.push(encodeTag(tag.code, body));
      continue;
    }
    const imported = readSwf(bytes);
    const only = symbolsOnly(entry.url);
    const { tags, next } = linkedDefinitions(imported, entry.symbols, nextId, only);
    nextId = next;
    parts.push(...tags);
  }
  const rectBits = 5 + 4 * ((movie.bytes[8] ?? 0) >> 3);
  const header = movie.bytes.subarray(0, 8 + Math.ceil(rectBits / 8) + 4);
  const out = concatBytes([header, ...parts]);
  out.set([0x46, 0x57, 0x53], 0);
  new DataView(out.buffer).setUint32(4, out.length, true);
  return out;
}

interface ImportEntry {
  readonly url: string;
  readonly symbols: readonly { readonly id: number; readonly name: string }[];
}

function readImport(body: Uint8Array, version: number): ImportEntry {
  const reader = new BinaryReader(body);
  const url = readSwfString(reader, version);
  reader.skip(2); // reserved
  const count = reader.u16();
  const symbols: { id: number; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    symbols.push({ id: reader.u16(), name: readSwfString(reader, version) });
  }
  return { url, symbols };
}

/** The highest character id a movie's tags define or name. */
function maxCharacterId(movie: SwfMovie, tags: readonly SwfTag[]): number {
  let max = 0;
  for (const tag of tags) {
    const body = movie.bytes.subarray(tag.offset, tag.offset + tag.length);
    if ((DEFINITIONS.has(tag.code) || OF_CHARACTER.has(tag.code)) && body.length >= 2) {
      max = Math.max(max, (body[0] ?? 0) | ((body[1] ?? 0) << 8));
    }
    if (tag.code === SwfTagCode.importAssets2 || tag.code === SwfTagCode.exportAssets) {
      const reader = new BinaryReader(body);
      if (tag.code === SwfTagCode.importAssets2) {
        readSwfString(reader, movie.header.version);
        reader.skip(2);
      }
      const count = reader.u16();
      for (let i = 0; i < count; i++) {
        max = Math.max(max, reader.u16());
        readSwfString(reader, movie.header.version);
      }
    }
    if (tag.children) max = Math.max(max, maxCharacterId(movie, tag.children));
  }
  return max;
}

/**
 * A linked movie's definitions, renumbered: the symbols imported by name take the import's
 * ids, the others ids from `firstId` on. Its exports stay for the symbols imported (by their
 * import ids) and for those whose names the importer may attach. With `symbolsOnly` only the
 * symbols imported and the definitions they refer to come (with their exports and the tags of
 * those characters).
 */
function linkedDefinitions(
  movie: SwfMovie,
  symbols: readonly { readonly id: number; readonly name: string }[],
  firstId: number,
  symbolsOnly = false,
): { tags: Uint8Array[]; next: number } {
  const version = movie.header.version;
  const exported = new Map<string, number>();
  for (const tag of movie.tags) {
    if (tag.code !== SwfTagCode.exportAssets) continue;
    const reader = new BinaryReader(movie.bytes.subarray(tag.offset, tag.offset + tag.length));
    const count = reader.u16();
    for (let i = 0; i < count; i++) {
      const id = reader.u16();
      exported.set(readSwfString(reader, version), id);
    }
  }
  const ids = new Map<number, number>();
  for (const symbol of symbols) {
    const own = exported.get(symbol.name);
    if (own === undefined) throw new FormatError(`${symbol.name} is not exported`, 0);
    ids.set(own, symbol.id);
  }
  let next = firstId;
  const map = (id: number): number => {
    if (id === 0) return 0;
    let mapped = ids.get(id);
    if (mapped === undefined) {
      mapped = next++;
      ids.set(id, mapped);
    }
    return mapped;
  };
  const kept = symbolsOnly ? usedDefinitions(movie, [...ids.keys()]) : undefined;
  const tags: Uint8Array[] = [];
  for (const tag of movie.tags) {
    if (TIMELINE_TAGS.has(tag.code)) continue;
    const body = movie.bytes.subarray(tag.offset, tag.offset + tag.length);
    if (kept) {
      if (tag.code === SwfTagCode.exportAssets) {
        const exports = keptSymbols(body, version, kept);
        if (exports)
          tags.push(encodeTag(tag.code, renumberSymbols(exports, tag.code, version, map)));
        continue;
      }
      const own = (body[0] ?? 0) | ((body[1] ?? 0) << 8);
      const ofCharacter = DEFINITIONS.has(tag.code) || OF_CHARACTER.has(tag.code);
      if (!ofCharacter || body.length < 2 || !kept.has(own)) continue;
    }
    tags.push(encodeTag(tag.code, renumber(movie, tag, body, map)));
  }
  return { tags, next };
}

/** The ids of the definitions `roots` name, themselves and on (the movie's own ids). */
function usedDefinitions(movie: SwfMovie, roots: readonly number[]): Set<number> {
  const definers = new Map<number, SwfTag>();
  for (const tag of movie.tags) {
    if (!DEFINITIONS.has(tag.code) || tag.length < 2) continue;
    definers.set((movie.bytes[tag.offset] ?? 0) | ((movie.bytes[tag.offset + 1] ?? 0) << 8), tag);
  }
  const used = new Set<number>();
  const waiting = [...roots];
  for (let id = waiting.pop(); id !== undefined; id = waiting.pop()) {
    if (id === 0 || used.has(id)) continue;
    used.add(id);
    const tag = definers.get(id);
    if (!tag) continue;
    // The ids a definition names are those renumbering it would map.
    renumber(movie, tag, movie.bytes.subarray(tag.offset, tag.offset + tag.length), (named) => {
      if (!used.has(named)) waiting.push(named);
      return named;
    });
  }
  return used;
}

/** An ExportAssets body with only the symbols kept (undefined: none left). */
function keptSymbols(
  body: Uint8Array,
  version: number,
  kept: ReadonlySet<number>,
): Uint8Array | undefined {
  const reader = new BinaryReader(body);
  const count = reader.u16();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const id = reader.u16();
    const name = readSwfString(reader, version);
    if (kept.has(id)) parts.push(u16Bytes(id), encodeSwfString(name));
  }
  return parts.length === 0 ? undefined : concatBytes([u16Bytes(parts.length / 2), ...parts]);
}

/** A tag with the character ids in it mapped. */
function renumber(
  movie: SwfMovie,
  tag: SwfTag,
  body: Uint8Array,
  map: (id: number) => number,
): Uint8Array {
  const version = movie.header.version;
  const withId = (): Uint8Array => {
    const out = body.slice();
    if (out.length >= 2) out.set(u16Bytes(map((body[0] ?? 0) | ((body[1] ?? 0) << 8))), 0);
    return out;
  };
  switch (tag.code) {
    case SwfTagCode.defineSprite: {
      const head = withId().subarray(0, 4);
      const children = (tag.children ?? []).map((child) =>
        encodeTag(
          child.code,
          renumberChild(
            child.code,
            movie.bytes.subarray(child.offset, child.offset + child.length),
            map,
          ),
        ),
      );
      return concatBytes([head, ...children]);
    }
    case SwfTagCode.defineEditText:
      return renumberEditText(withId(), map);
    case SwfTagCode.defineShape:
    case Tag.defineShape2:
    case Tag.defineShape3:
    case Tag.defineShape4: {
      const out = withId();
      renumberShapeBitmaps(out, tag.code, map);
      return out;
    }
    case SwfTagCode.exportAssets:
    case SwfTagCode.importAssets2:
      return renumberSymbols(body, tag.code, version, map);
    case SwfTagCode.importAssets:
      throw new FormatError('ImportAssets (v1) in a linked movie', tag.offset);
    default:
      if (DEFINITIONS.has(tag.code) || OF_CHARACTER.has(tag.code)) return withId();
      // Text with glyph records, buttons, morph shapes: not in the movies linked so far.
      if ([11, 33, 7, 34, 46, 84].includes(tag.code)) {
        throw new FormatError(`tag ${String(tag.code)} in a linked movie`, tag.offset);
      }
      return body;
  }
}

/** A sprite's own tag: its placements' characters mapped. */
function renumberChild(code: number, body: Uint8Array, map: (id: number) => number): Uint8Array {
  if (code === SwfTagCode.placeObject2 && ((body[0] ?? 0) & 0x02) !== 0) {
    const out = body.slice();
    out.set(u16Bytes(map((body[3] ?? 0) | ((body[4] ?? 0) << 8))), 3);
    return out;
  }
  if (code === SwfTagCode.placeObject3 && ((body[0] ?? 0) & 0x02) !== 0) {
    let at = 4;
    // A class name comes before the character (flags2 0x08, or an image with a character).
    const flags2 = body[1] ?? 0;
    if ((flags2 & 0x08) !== 0 || (flags2 & 0x10) !== 0) {
      while (at < body.length && body[at] !== 0) at++;
      at++;
    }
    const out = body.slice();
    out.set(u16Bytes(map((body[at] ?? 0) | ((body[at + 1] ?? 0) << 8))), at);
    return out;
  }
  if (code === Tag.placeObject) {
    const out = body.slice();
    out.set(u16Bytes(map((body[0] ?? 0) | ((body[1] ?? 0) << 8))), 0);
    return out;
  }
  return body;
}

/** DefineEditText: its font (after the bounds and flags, when it has one). */
function renumberEditText(body: Uint8Array, map: (id: number) => number): Uint8Array {
  const rectBits = 5 + 4 * ((body[2] ?? 0) >> 3);
  const flagsAt = 2 + Math.ceil(rectBits / 8);
  if (((body[flagsAt] ?? 0) & 0x01) === 0) return body;
  const at = flagsAt + 2;
  body.set(u16Bytes(map((body[at] ?? 0) | ((body[at + 1] ?? 0) << 8))), at);
  return body;
}

function renumberSymbols(
  body: Uint8Array,
  code: number,
  version: number,
  map: (id: number) => number,
): Uint8Array {
  const reader = new BinaryReader(body);
  const parts: Uint8Array[] = [];
  if (code === SwfTagCode.importAssets2) {
    const url = readSwfString(reader, version);
    parts.push(encodeSwfString(url), body.subarray(reader.offset, reader.offset + 2));
    reader.skip(2);
  }
  const count = reader.u16();
  parts.push(u16Bytes(count));
  for (let i = 0; i < count; i++) {
    const id = reader.u16();
    const name = readSwfString(reader, version);
    parts.push(u16Bytes(map(id)), encodeSwfString(name));
  }
  return concatBytes(parts);
}

/** Bits of a shape, read and patched in place (bitmap fill ids are byte-aligned u16). */
class Bits {
  readonly bytes: Uint8Array;
  at: number;
  #bit = 0;

  constructor(bytes: Uint8Array, at: number) {
    this.bytes = bytes;
    this.at = at;
  }

  ub(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.at] ?? 0;
      value = (value << 1) | ((byte >> (7 - this.#bit)) & 1);
      if (++this.#bit === 8) {
        this.#bit = 0;
        this.at++;
      }
    }
    return value >>> 0;
  }

  align(): void {
    if (this.#bit !== 0) {
      this.#bit = 0;
      this.at++;
    }
  }

  u8(): number {
    this.align();
    return this.bytes[this.at++] ?? 0;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  skipBytes(count: number): void {
    this.align();
    this.at += count;
  }

  rect(): void {
    this.align();
    const bits = this.ub(5);
    this.ub(bits * 4);
    this.align();
  }

  matrix(): void {
    this.align();
    if (this.ub(1)) this.ub(this.ub(5) * 2);
    if (this.ub(1)) this.ub(this.ub(5) * 2);
    this.ub(this.ub(5) * 2);
    this.align();
  }
}

/** DefineShape 1..4: the bitmap ids of its fill styles (the first and every new set). */
function renumberShapeBitmaps(body: Uint8Array, code: number, map: (id: number) => number): void {
  const shape = code === SwfTagCode.defineShape ? 1 : code === 22 ? 2 : code === 32 ? 3 : 4;
  const bits = new Bits(body, 2);
  bits.rect();
  if (shape === 4) {
    bits.rect();
    bits.u8();
  }
  const fillStyles = (): void => {
    let count = bits.u8();
    if (count === 0xff && shape >= 2) count = bits.u16();
    for (let i = 0; i < count; i++) fillStyle();
  };
  const fillStyle = (): void => {
    const type = bits.u8();
    if (type === 0x00) {
      bits.skipBytes(shape >= 3 ? 4 : 3);
    } else if (type === 0x10 || type === 0x12 || type === 0x13) {
      bits.matrix();
      bits.align();
      const head = bits.u8();
      const records = head & 0x0f;
      bits.skipBytes(records * (shape >= 3 ? 5 : 4));
      if (type === 0x13) bits.skipBytes(2);
    } else if (type >= 0x40 && type <= 0x43) {
      const at = bits.at;
      const id = bits.u16();
      body.set(u16Bytes(map(id)), at);
      bits.matrix();
    } else {
      throw new FormatError(`fill style ${String(type)}`, bits.at);
    }
  };
  const lineStyles = (): void => {
    let count = bits.u8();
    if (count === 0xff) count = bits.u16();
    for (let i = 0; i < count; i++) {
      bits.u16(); // width
      if (shape < 4) {
        bits.skipBytes(shape === 3 ? 4 : 3);
        continue;
      }
      // LINESTYLE2's flags, bits: start cap 2, join 2, has fill 1, no h-scale 1, no v-scale 1,
      // pixel hinting 1, reserved 5, no close 1, end cap 2.
      bits.ub(2);
      const join = bits.ub(2);
      const hasFill = bits.ub(1) === 1;
      bits.ub(3 + 5 + 1 + 2);
      if (join === 2) bits.u16();
      if (hasFill) fillStyle();
      else bits.skipBytes(4);
    }
  };
  fillStyles();
  lineStyles();
  bits.align();
  let fillBits = bits.ub(4);
  let lineBits = bits.ub(4);
  for (;;) {
    if (bits.ub(1) === 1) {
      // An edge: straight or curved.
      const straight = bits.ub(1) === 1;
      const n = bits.ub(4) + 2;
      if (straight) {
        if (bits.ub(1) === 1) bits.ub(n * 2);
        else bits.ub(1 + n);
      } else {
        bits.ub(n * 4);
      }
      continue;
    }
    const flags = bits.ub(5);
    if (flags === 0) break;
    if (flags & 0x01) bits.ub(bits.ub(5) * 2);
    if (flags & 0x02) bits.ub(fillBits);
    if (flags & 0x04) bits.ub(fillBits);
    if (flags & 0x08) bits.ub(lineBits);
    if (flags & 0x10) {
      fillStyles();
      lineStyles();
      bits.align();
      fillBits = bits.ub(4);
      lineBits = bits.ub(4);
    }
  }
}
