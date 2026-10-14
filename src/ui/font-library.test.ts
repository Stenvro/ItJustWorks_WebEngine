import { describe, expect, it } from 'vitest';
import { parseFontConfig } from '../formats/swf/fontconfig.ts';
import { readSwf, swfExports, swfFonts, SwfTagCode } from '../formats/swf/swf.ts';
import { concatBytes, encodeSwfString, u16Bytes, writeSwf } from '../formats/swf/swf-writer.ts';
import { buildFontLibrary } from './font-library.ts';

/** A DefineFont3 with no glyphs: id, flags, language, name, glyph count 0, code table end. */
function font(id: number, name: string, bold: boolean): { code: number; body: Uint8Array } {
  const encoded = new TextEncoder().encode(name);
  return {
    code: SwfTagCode.defineFont3,
    body: concatBytes([
      u16Bytes(id),
      Uint8Array.of(bold ? 0x01 : 0, 1, encoded.length),
      encoded,
      u16Bytes(0),
      u16Bytes(0),
    ]),
  };
}

const fontsEn = readSwf(
  writeSwf([
    font(5, 'Futura CondensedLight', false),
    font(7, 'Futura Condensed', false),
    font(9, 'Futura Condensed', true),
    {
      code: SwfTagCode.defineFontAlignZones,
      body: concatBytes([u16Bytes(7), Uint8Array.of(0x40)]),
    },
  ]),
);

const shipped = readSwf(
  writeSwf([
    font(1, 'Arial', true),
    {
      code: SwfTagCode.exportAssets,
      body: concatBytes([u16Bytes(1), u16Bytes(1), encodeSwfString('$DialogueTextFont')]),
    },
  ]),
);

describe('buildFontLibrary', () => {
  const config = parseFontConfig(
    [
      'map "$EverywhereFont" = "Futura CondensedLight" Normal',
      'map "$EverywhereMediumFont" = "Futura Condensed" Normal',
      'map "$EverywhereBoldFont" = "Futura Condensed" Bold',
      'map "$DragonFont" = "Dragon_script" Normal',
    ].join('\n'),
  );
  const library = buildFontLibrary(config, [fontsEn], shipped);
  const movie = readSwf(library.movie);

  it('exports every mapped name the libraries have, and the shipped names besides', () => {
    expect(swfExports(movie).map((symbol) => symbol.name)).toEqual([
      '$EverywhereFont',
      '$EverywhereMediumFont',
      '$EverywhereBoldFont',
      '$DialogueTextFont',
    ]);
    expect(library.missing).toEqual(['$DragonFont']);
  });

  it('picks the face by style and renames it to the mapped name', () => {
    expect(library.fonts.get('$EverywhereMediumFont')).toBe('Futura Condensed');
    expect(library.fonts.get('$EverywhereBoldFont')).toBe('Futura Condensed bold');
    expect(swfFonts(movie).map((f) => [f.name, f.bold])).toEqual([
      ['$EverywhereFont', false],
      ['$EverywhereMediumFont', false],
      ['$EverywhereBoldFont', true],
      ['$DialogueTextFont', true],
    ]);
  });

  it("carries a font's align zones over to its copy", () => {
    const zones = movie.tags.filter((tag) => tag.code === SwfTagCode.defineFontAlignZones);
    expect(zones).toHaveLength(1);
    const body = movie.bytes.subarray(zones[0]?.offset ?? 0, (zones[0]?.offset ?? 0) + 2);
    expect(body[0]).toBe(2);
  });
});
