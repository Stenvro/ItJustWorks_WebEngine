// Flash movies (SWF) and Scaleform's variant of them (GFX), the game's interface: the menus
// in interface\*.swf, their font libraries (fonts_en.swf, gfxfontlib.swf) and the exported
// interface\exported\*.gfx. A movie is a header and a list of tags; this reads the header,
// decompresses the body (zlib), and lists the tags, with what the engine needs to know of
// them: which symbols a movie exports and imports, its fonts and its Scaleform extension
// tags. Notes: docs/formats/swf.md.

import { BinaryReader, FormatError } from '../binary-reader.ts';
import { decodeUtf8, decodeWindows1252 } from '../text.ts';
import { inflateZlib } from '../zlib/inflate.ts';

/** Tag codes (Adobe's SWF File Format Specification 19, and Scaleform's extensions). */
export const SwfTagCode = {
  end: 0,
  showFrame: 1,
  defineShape: 2,
  setBackgroundColor: 9,
  doAction: 12,
  defineSprite: 39,
  defineEditText: 37,
  defineFont2: 48,
  exportAssets: 56,
  importAssets: 57,
  doInitAction: 59,
  fileAttributes: 69,
  importAssets2: 71,
  defineFontAlignZones: 73,
  defineFont3: 75,
  metadata: 77,
  defineFontName: 88,
  defineFont4: 91,
  // Scaleform (GFx) extension tags.
  gfxExporterInfo: 1000,
  gfxDefineExternalImage: 1001,
  gfxFontTextureInfo: 1002,
  gfxDefineExternalGradient: 1003,
  gfxDefineGradientMap: 1004,
  gfxDefineCompactedFont: 1005,
  gfxDefineExternalSound: 1006,
  gfxDefineExternalStreamSound: 1007,
  gfxDefineSubImage: 1008,
  gfxDefineExternalImage2: 1009,
} as const;

const TAG_NAMES = new Map<number, string>(
  Object.entries(SwfTagCode).map(([name, code]) => [code, name]),
);

/** A tag's name, or its code for tags this module does not name. */
export function swfTagName(code: number): string {
  return TAG_NAMES.get(code) ?? `tag${String(code)}`;
}

export interface SwfHeader {
  /** FWS / CWS / ZWS for Flash, GFX / CFX for Scaleform's exported movies. */
  readonly signature: string;
  readonly compressed: boolean;
  /** A Scaleform movie (GFX or CFX). */
  readonly gfx: boolean;
  readonly version: number;
  /** The whole movie's length uncompressed, header included. */
  readonly fileLength: number;
  /** The stage in twips (1/20 pixel). */
  readonly frameSize: {
    readonly xMin: number;
    readonly xMax: number;
    readonly yMin: number;
    readonly yMax: number;
  };
  /** Frames per second. */
  readonly frameRate: number;
  readonly frameCount: number;
}

export interface SwfTag {
  readonly code: number;
  /** Offset of the tag's body in the uncompressed movie. */
  readonly offset: number;
  readonly length: number;
  /** A sprite's own tags (DefineSprite). */
  readonly children?: readonly SwfTag[];
}

export interface SwfMovie {
  readonly header: SwfHeader;
  /** The whole movie uncompressed, header included (its signature as in the file). */
  readonly bytes: Uint8Array;
  readonly tags: readonly SwfTag[];
}

/** A symbol a movie exports, or one it imports from another movie by name. */
export interface SwfSymbol {
  readonly id: number;
  readonly name: string;
}

export interface SwfImport {
  /** The movie it imports from, as written ("gfxfontlib.swf"). */
  readonly url: string;
  readonly symbols: readonly SwfSymbol[];
}

export interface SwfFont {
  readonly id: number;
  readonly name: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Glyphs it carries (0: a device font, drawn from the system's or a library's). */
  readonly glyphs: number;
  readonly code: number;
}

/** Reads a movie's header and tags; a compressed body is inflated. */
export function readSwf(file: Uint8Array): SwfMovie {
  if (file.length < 8) throw new FormatError('SWF too short', 0);
  const signature = String.fromCharCode(file[0]!, file[1]!, file[2]!);
  const version = file[3]!;
  const fileLength = new DataView(file.buffer, file.byteOffset + 4, 4).getUint32(0, true);
  let bytes: Uint8Array;
  switch (signature) {
    case 'FWS':
    case 'GFX':
      bytes = file;
      break;
    case 'CWS':
    case 'CFX': {
      bytes = new Uint8Array(fileLength);
      bytes.set(file.subarray(0, 8));
      bytes.set(inflateZlib(file.subarray(8), fileLength - 8), 8);
      break;
    }
    case 'ZWS':
      throw new FormatError('LZMA-compressed SWF is not supported', 0);
    default:
      throw new FormatError(`not a SWF (signature ${JSON.stringify(signature)})`, 0);
  }
  const reader = new BinaryReader(bytes, 8);
  const frameSize = readRect(reader);
  const frameRate = reader.u16() / 256;
  const frameCount = reader.u16();
  const tags = readTags(bytes, reader.offset, bytes.length);
  return {
    header: {
      signature,
      compressed: signature === 'CWS' || signature === 'CFX',
      gfx: signature === 'GFX' || signature === 'CFX',
      version,
      fileLength,
      frameSize,
      frameRate,
      frameCount,
    },
    bytes,
    tags,
  };
}

/** A RECT record: a 5-bit field size, then four signed fields of that many bits. */
function readRect(reader: BinaryReader): SwfHeader['frameSize'] {
  const start = reader.offset;
  const bits = new BitCursor(reader);
  const size = bits.unsigned(5);
  const xMin = bits.signed(size);
  const xMax = bits.signed(size);
  const yMin = bits.signed(size);
  const yMax = bits.signed(size);
  reader.seek(start + Math.ceil((5 + size * 4) / 8));
  return { xMin, xMax, yMin, yMax };
}

class BitCursor {
  readonly #reader: BinaryReader;
  #byte = 0;
  #left = 0;

  constructor(reader: BinaryReader) {
    this.#reader = reader;
  }

  unsigned(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.#left === 0) {
        this.#byte = this.#reader.u8();
        this.#left = 8;
      }
      this.#left--;
      value = value * 2 + ((this.#byte >> this.#left) & 1);
    }
    return value;
  }

  signed(count: number): number {
    if (count === 0) return 0;
    const value = this.unsigned(count);
    const sign = 2 ** (count - 1);
    return value >= sign ? value - 2 * sign : value;
  }
}

/** The tags between `start` and `end`, with a sprite's own tags inside it. */
function readTags(bytes: Uint8Array, start: number, end: number): SwfTag[] {
  const reader = new BinaryReader(bytes, start);
  const tags: SwfTag[] = [];
  while (reader.offset < end) {
    if (end - reader.offset < 2) throw new FormatError('truncated tag header', reader.offset);
    const head = reader.u16();
    const code = head >> 6;
    let length = head & 0x3f;
    if (length === 0x3f) length = reader.u32();
    const offset = reader.offset;
    if (offset + length > end)
      throw new FormatError(`tag ${String(code)} runs past its end`, offset);
    if (code === SwfTagCode.defineSprite && length >= 4) {
      tags.push({ code, offset, length, children: readTags(bytes, offset + 4, offset + length) });
    } else {
      tags.push({ code, offset, length });
    }
    reader.seek(offset + length);
    if (code === SwfTagCode.end) break;
  }
  return tags;
}

/** A tag's body. */
export function tagBody(movie: SwfMovie, tag: SwfTag): Uint8Array {
  return movie.bytes.subarray(tag.offset, tag.offset + tag.length);
}

/** Every tag of a movie, those inside sprites too, in file order. */
export function* allTags(tags: readonly SwfTag[]): Iterable<SwfTag> {
  for (const tag of tags) {
    yield tag;
    if (tag.children) yield* allTags(tag.children);
  }
}

/** A null-terminated string (UTF-8 from SWF 6, the system code page before). */
export function readSwfString(reader: BinaryReader, version: number): string {
  const start = reader.offset;
  const rest = reader.bytes(reader.remaining);
  const end = rest.indexOf(0);
  if (end < 0) throw new FormatError('unterminated string', start);
  reader.seek(start + end + 1);
  const text = rest.subarray(0, end);
  return version >= 6 ? (decodeUtf8(text) ?? decodeWindows1252(text)) : decodeWindows1252(text);
}

/** The symbols a movie exports by name (ExportAssets). */
export function swfExports(movie: SwfMovie): SwfSymbol[] {
  const symbols: SwfSymbol[] = [];
  for (const tag of movie.tags) {
    if (tag.code !== SwfTagCode.exportAssets) continue;
    const reader = new BinaryReader(tagBody(movie, tag));
    const count = reader.u16();
    for (let i = 0; i < count; i++) {
      const id = reader.u16();
      symbols.push({ id, name: readSwfString(reader, movie.header.version) });
    }
  }
  return symbols;
}

/** The movies a movie imports symbols from, and which (ImportAssets, ImportAssets2). */
export function swfImports(movie: SwfMovie): SwfImport[] {
  const imports: SwfImport[] = [];
  for (const tag of movie.tags) {
    if (tag.code !== SwfTagCode.importAssets && tag.code !== SwfTagCode.importAssets2) continue;
    const reader = new BinaryReader(tagBody(movie, tag));
    const url = readSwfString(reader, movie.header.version);
    if (tag.code === SwfTagCode.importAssets2) reader.skip(2);
    const count = reader.u16();
    const symbols: SwfSymbol[] = [];
    for (let i = 0; i < count; i++) {
      const id = reader.u16();
      symbols.push({ id, name: readSwfString(reader, movie.header.version) });
    }
    imports.push({ url, symbols });
  }
  return imports;
}

/** The fonts a movie defines (DefineFont2, DefineFont3; DefineFont4 has no glyph count). */
export function swfFonts(movie: SwfMovie): SwfFont[] {
  const fonts: SwfFont[] = [];
  for (const tag of allTags(movie.tags)) {
    if (tag.code === SwfTagCode.defineFont2 || tag.code === SwfTagCode.defineFont3) {
      const reader = new BinaryReader(tagBody(movie, tag));
      const id = reader.u16();
      const flags = reader.u8();
      reader.skip(1); // language code
      const nameLength = reader.u8();
      const name = trimNull(decodeUtf8(reader.bytes(nameLength)) ?? '');
      const glyphs = reader.u16();
      fonts.push({
        id,
        name,
        bold: (flags & 0x01) !== 0,
        italic: (flags & 0x02) !== 0,
        glyphs,
        code: tag.code,
      });
    } else if (tag.code === SwfTagCode.defineFont4) {
      const reader = new BinaryReader(tagBody(movie, tag));
      const id = reader.u16();
      const flags = reader.u8();
      const name = readSwfString(reader, movie.header.version);
      fonts.push({
        id,
        name,
        bold: (flags & 0x01) !== 0,
        italic: (flags & 0x02) !== 0,
        glyphs: 0,
        code: tag.code,
      });
    }
  }
  return fonts;
}

const trimNull = (text: string): string => text.replace(/\0+$/, '');

/** How many tags of each kind a movie has, sprites' included, by name. */
export function swfTagCounts(movie: SwfMovie): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tag of allTags(movie.tags)) {
    const name = swfTagName(tag.code);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
