// What Scaleform's translator does as a menu shows text, done to the movie as it loads: a text
// field whose text is a translation key ("$NEW") shows the key's text ("NEW"). A Flash player
// has no translator, so every string of the menu's ActionScript that is a key, and every text
// field's initial text that is one, is replaced by its translation; a string that is no key
// (font names such as "$EverywhereFont", identifiers) stays. Text the engine sends is
// translated before it is sent. Platform-independent. Notes: docs/ui.md.

import { BinaryReader } from '../formats/binary-reader.ts';
import { rewriteAvm1Strings, type StringRewrite } from '../formats/swf/avm1-rewrite.ts';
import { rewriteClipActions } from '../formats/swf/place-object.ts';
import {
  readSwf,
  readSwfString,
  SwfTagCode,
  type SwfMovie,
  type SwfTag,
} from '../formats/swf/swf.ts';
import { concatBytes, encodeSwfString, encodeTag } from '../formats/swf/swf-writer.ts';

/** The movie with its translation keys replaced (uncompressed); the header kept. */
export function translateMovie(movieBytes: Uint8Array, translate: StringRewrite): Uint8Array {
  const movie = readSwf(movieBytes);
  const rectBits = 5 + 4 * ((movie.bytes[8] ?? 0) >> 3);
  const header = movie.bytes.subarray(0, 8 + Math.ceil(rectBits / 8) + 4);
  const out = concatBytes([
    header,
    ...movie.tags.map((tag) => encodeTag(tag.code, tagBody(movie, tag, translate))),
  ]);
  out.set([0x46, 0x57, 0x53], 0);
  new DataView(out.buffer).setUint32(4, out.length, true);
  return out;
}

function tagBody(movie: SwfMovie, tag: SwfTag, translate: StringRewrite): Uint8Array {
  const body = movie.bytes.subarray(tag.offset, tag.offset + tag.length);
  const version = movie.header.version;
  switch (tag.code) {
    case SwfTagCode.doAction:
      return rewriteAvm1Strings(body, version, translate);
    case SwfTagCode.doInitAction:
      return concatBytes([
        body.subarray(0, 2),
        rewriteAvm1Strings(body.subarray(2), version, translate),
      ]);
    case SwfTagCode.defineSprite:
      return concatBytes([
        body.subarray(0, 4),
        ...(tag.children ?? []).map((child) =>
          encodeTag(child.code, tagBody(movie, child, translate)),
        ),
      ]);
    case SwfTagCode.placeObject2:
    case SwfTagCode.placeObject3:
      // A placed instance's clip actions: how a component gets its inspector parameters.
      return rewriteClipActions(body, tag.code, version, translate);
    case SwfTagCode.defineEditText:
      return translatedEditText(body, version, translate);
    default:
      return body;
  }
}

/** DefineEditText flags (SWF 19): first byte, then second. */
const EditText = {
  hasText: 0x80,
  hasTextColor: 0x04,
  hasMaxLength: 0x02,
  hasFont: 0x01,
  hasFontClass: 0x80,
  hasLayout: 0x20,
  html: 0x02,
} as const;

/** A text field with its initial text translated when it is a key (or, as HTML, holds one). */
function translatedEditText(
  body: Uint8Array,
  version: number,
  translate: StringRewrite,
): Uint8Array {
  const reader = new BinaryReader(body, 2);
  // The bounds RECT.
  const bits = 5 + 4 * ((body[2] ?? 0) >> 3);
  reader.seek(2 + Math.ceil(bits / 8));
  const flags1 = reader.u8();
  const flags2 = reader.u8();
  if ((flags1 & EditText.hasText) === 0) return body;
  if (flags1 & EditText.hasFont) reader.skip(2);
  if (flags2 & EditText.hasFontClass) readSwfString(reader, version);
  // The font height, with either a font or a font class (as Ruffle reads it).
  if (flags1 & EditText.hasFont || flags2 & EditText.hasFontClass) reader.skip(2);
  if (flags1 & EditText.hasTextColor) reader.skip(4);
  if (flags1 & EditText.hasMaxLength) reader.skip(2);
  if (flags2 & EditText.hasLayout) reader.skip(9);
  readSwfString(reader, version); // the variable name
  const textStart = reader.offset;
  const text = readSwfString(reader, version);
  let translated: string | undefined;
  if (flags2 & EditText.html) {
    // A key as the text between tags: <p ...><font ...>$KEY</font></p>
    const html = text.replace(/>(\$[^<]+)</g, (whole, key: string) => {
      const value = translate(key);
      return value === undefined ? whole : `>${escapeHtml(value)}<`;
    });
    translated = html === text ? undefined : html;
  } else {
    translated = translate(text);
  }
  if (translated === undefined) return body;
  return concatBytes([
    body.subarray(0, textStart),
    encodeSwfString(translated),
    body.subarray(reader.offset),
  ]);
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
