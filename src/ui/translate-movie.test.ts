import { describe, expect, it } from 'vitest';
import { decodeAvm1 } from '../formats/swf/avm1.ts';
import { Avm1Writer } from '../formats/swf/avm1-writer.ts';
import { parseTranslations } from '../formats/swf/translation.ts';
import { readSwf, readSwfString, SwfTagCode, tagBody } from '../formats/swf/swf.ts';
import {
  concatBytes,
  encodeRect,
  encodeSwfString,
  u16Bytes,
  writeSwf,
} from '../formats/swf/swf-writer.ts';
import { BinaryReader } from '../formats/binary-reader.ts';
import { translateMovie } from './translate-movie.ts';

const table = parseTranslations(
  ['﻿', '$NEW\tNEW', '$Load this game?\tLoad this game?', '$CONTINUE\tCONTINUE', ''].join('\r\n'),
);

/** A DefineEditText with a font and initial text (plain or HTML). */
function editText(id: number, text: string, html: boolean): Uint8Array {
  return concatBytes([
    u16Bytes(id),
    encodeRect(100, 20),
    Uint8Array.of(0x80 | 0x01, html ? 0x02 : 0),
    u16Bytes(1),
    u16Bytes(240),
    encodeSwfString(''),
    encodeSwfString(text),
  ]);
}

/** The layout's alignment (if it has one) and the initial text of a field from editText. */
function fieldText(body: Uint8Array): { align: number | undefined; text: string } {
  const flagsAt = 2 + encodeRect(100, 20).length + 1;
  const reader = new BinaryReader(body, flagsAt + 1 + 4);
  const align = ((body[flagsAt] ?? 0) & 0x20) !== 0 ? body[reader.offset] : undefined;
  if (align !== undefined) reader.skip(9);
  readSwfString(reader, 15);
  return { align, text: readSwfString(reader, 15) };
}
const initialText = (body: Uint8Array): string => fieldText(body).text;

describe('parseTranslations', () => {
  it('reads keys and texts, matching as written then ignoring case', () => {
    expect(table.size).toBe(3);
    expect(table.translate('$NEW')).toBe('NEW');
    expect(table.translate('$continue')).toBe('CONTINUE');
    expect(table.translate('$EverywhereFont')).toBeUndefined();
    expect(table.translate('NEW')).toBeUndefined();
  });
});

describe('translateMovie', () => {
  const movie = writeSwf([
    { code: SwfTagCode.defineEditText, body: editText(2, '$NEW', false) },
    {
      code: SwfTagCode.defineEditText,
      body: editText(3, '<p align="left"><font face="$EverywhereFont">$CONTINUE</font></p>', true),
    },
    {
      code: SwfTagCode.defineEditText,
      body: editText(5, '<p align="right">$NEW</p><p>$CONTINUE</p>', true),
    },
    {
      code: SwfTagCode.defineSprite,
      body: concatBytes([
        u16Bytes(4),
        u16Bytes(1),
        Uint8Array.of(...[(SwfTagCode.doAction << 6) | 0x3f].flatMap((h) => [h & 0xff, h >> 8])),
        (() => {
          const code = concatBytes([
            new Avm1Writer().push('$Load this game?', '$EverywhereFont').bytes(),
            Uint8Array.of(0),
          ]);
          return concatBytes([Uint8Array.of(code.length & 0xff, code.length >> 8, 0, 0), code]);
        })(),
        u16Bytes(0),
      ]),
    },
  ]);
  const translated = readSwf(translateMovie(movie, (text) => table.translate(text)));

  it('translates text fields, plain and HTML, font names kept', () => {
    const [plain, html, paragraphs] = translated.tags;
    expect(plain && initialText(tagBody(translated, plain))).toBe('NEW');
    expect(html && initialText(tagBody(translated, html))).toBe(
      '<font face="$EverywhereFont">CONTINUE</font>',
    );
    expect(paragraphs && fieldText(tagBody(translated, paragraphs))).toEqual({
      align: undefined,
      text: '<p align="right">NEW</p><p>CONTINUE</p>',
    });
  });

  it('makes a one-paragraph HTML field’s paragraph its own alignment (no paragraph end)', () => {
    const one = writeSwf([
      { code: SwfTagCode.defineEditText, body: editText(2, '<p align="right">$NEW</p>', true) },
    ]);
    const tag = readSwf(translateMovie(one, (text) => table.translate(text)));
    const field = tag.tags[0];
    expect(field && fieldText(tagBody(tag, field))).toEqual({ align: 1, text: 'NEW' });
  });

  it('translates the scripts inside sprites', () => {
    const sprite = translated.tags[3];
    const action = sprite?.children?.[0];
    expect(action?.code).toBe(SwfTagCode.doAction);
    const values = action && decodeAvm1(tagBody(translated, action), 15)[0]?.values;
    expect(values).toEqual([
      { kind: 'string', value: 'Load this game?' },
      { kind: 'string', value: '$EverywhereFont' },
    ]);
  });
});
