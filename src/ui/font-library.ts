// The menus' font library, as Scaleform makes it from fontconfig.txt: every menu imports its
// fonts by name from "gfxfontlib.swf" ($EverywhereMediumFont, $DragonFont, ...), and
// Scaleform answers those imports from the font libraries fontconfig.txt loads (fonts_en.swf,
// ...), each name standing for the font its `map` line names. A Flash player knows nothing of
// fontconfig, so the engine builds that movie: for every mapped name a copy of the font it
// stands for, renamed to that name (so HTML text asking for `face="$EverywhereFont"` finds it
// too), exported under it. Names only the shipped gfxfontlib.swf exports keep its fonts.
// Platform-independent. Notes: docs/formats/swf.md.

import { BinaryReader } from '../formats/binary-reader.ts';
import { decodeGameText, encodeUtf8 } from '../formats/text.ts';
import { styleIsBold, styleIsItalic, type FontConfig } from '../formats/swf/fontconfig.ts';
import { SwfTagCode, swfExports, tagBody, type SwfMovie } from '../formats/swf/swf.ts';
import {
  concatBytes,
  encodeSwfString,
  u16Bytes,
  writeSwf,
  type SwfTagData,
} from '../formats/swf/swf-writer.ts';

/** A font of a library movie, with the tags that go with it. */
interface LibraryFont {
  readonly name: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: number;
  readonly body: Uint8Array;
  /** DefineFontAlignZones for it, if any (its body). */
  readonly zones: Uint8Array | undefined;
}

/** Name offset in DefineFont2/3: id u16, flags u8, language u8, then the name's length. */
const NAME_LENGTH_AT = 4;

function libraryFonts(movie: SwfMovie): Map<number, LibraryFont> {
  const fonts = new Map<number, LibraryFont>();
  const zones = new Map<number, Uint8Array>();
  for (const tag of movie.tags) {
    const body = tagBody(movie, tag);
    if (tag.code === SwfTagCode.defineFontAlignZones && body.length >= 2) {
      zones.set(new BinaryReader(body).u16(), body);
    }
  }
  for (const tag of movie.tags) {
    if (tag.code !== SwfTagCode.defineFont2 && tag.code !== SwfTagCode.defineFont3) continue;
    const body = tagBody(movie, tag);
    const reader = new BinaryReader(body);
    const id = reader.u16();
    const flags = reader.u8();
    reader.skip(1);
    const nameLength = reader.u8();
    const name = decodeGameText(reader.bytes(nameLength)).replace(/\0+$/, '');
    fonts.set(id, {
      name,
      bold: (flags & 0x01) !== 0,
      italic: (flags & 0x02) !== 0,
      code: tag.code,
      body,
      zones: zones.get(id),
    });
  }
  return fonts;
}

/** A font tag's body with a new id and name; its glyphs as they are. */
function renamedFont(font: LibraryFont, id: number, name: string): Uint8Array {
  const nameLength = font.body[NAME_LENGTH_AT] ?? 0;
  const rest = font.body.subarray(NAME_LENGTH_AT + 1 + nameLength);
  const encoded = encodeUtf8(name);
  return concatBytes([
    u16Bytes(id),
    font.body.subarray(2, NAME_LENGTH_AT),
    Uint8Array.of(encoded.length),
    encoded,
    rest,
  ]);
}

function withId(body: Uint8Array, id: number): Uint8Array {
  return concatBytes([u16Bytes(id), body.subarray(2)]);
}

export interface FontLibraryReport {
  readonly movie: Uint8Array;
  /** Each exported name and the font it got ("Futura Condensed bold"). */
  readonly fonts: ReadonlyMap<string, string>;
  /** Mapped names whose font no library has. */
  readonly missing: readonly string[];
}

/**
 * The font library movie: `libraries` are the movies fontconfig.txt loads, in its order;
 * `shipped` is the game's own gfxfontlib.swf, whose exports fill in names the config does
 * not map.
 */
export function buildFontLibrary(
  config: FontConfig,
  libraries: readonly SwfMovie[],
  shipped?: SwfMovie,
): FontLibraryReport {
  const available = libraries.flatMap((movie) => [...libraryFonts(movie).values()]);
  const tags: SwfTagData[] = [{ code: SwfTagCode.fileAttributes, body: new Uint8Array(4) }];
  const exports: { id: number; name: string }[] = [];
  const fonts = new Map<string, string>();
  const missing: string[] = [];
  let nextId = 1;
  const add = (font: LibraryFont, name: string): void => {
    const id = nextId++;
    tags.push({ code: font.code, body: renamedFont(font, id, name) });
    if (font.zones)
      tags.push({ code: SwfTagCode.defineFontAlignZones, body: withId(font.zones, id) });
    exports.push({ id, name });
    fonts.set(name, `${font.name}${font.bold ? ' bold' : ''}${font.italic ? ' italic' : ''}`);
  };
  for (const mapping of config.mappings) {
    const font = mapping.font.toLowerCase();
    const bold = styleIsBold(mapping.style);
    const italic = styleIsItalic(mapping.style);
    const named = available.filter((candidate) => candidate.name.toLowerCase() === font);
    const chosen =
      named.find((candidate) => candidate.bold === bold && candidate.italic === italic) ??
      named.find((candidate) => candidate.bold === bold) ??
      named[0];
    if (chosen) add(chosen, mapping.name);
    else missing.push(mapping.name);
  }
  if (shipped) {
    const own = libraryFonts(shipped);
    for (const symbol of swfExports(shipped)) {
      const font = own.get(symbol.id);
      if (font && !fonts.has(symbol.name)) add(font, symbol.name);
    }
  }
  tags.push({
    code: SwfTagCode.exportAssets,
    body: concatBytes([
      u16Bytes(exports.length),
      ...exports.flatMap(({ id, name }) => [u16Bytes(id), encodeSwfString(name)]),
    ]),
  });
  tags.push({ code: SwfTagCode.showFrame, body: new Uint8Array(0) });
  return { movie: writeSwf(tags), fonts, missing };
}
