// A movie's text fields (DefineEditText, SWF File Format Specification 19): what each holds as
// authored (its initial text, the text a movie shows until code sets another), and where the
// named ones are from _root (the instance names of the placements that lead to them, through
// the sprites they are placed in). Menus fill most of their fields as they open; an authored
// text left showing (the HUD's "Dialogue Line 1") is a placeholder the engine should have set.
// Platform-independent. Notes: docs/formats/swf.md.

import { BinaryReader } from '../binary-reader.ts';
import { readPlacement } from './place-object.ts';
import { readSwfString, SwfTagCode, tagBody, type SwfMovie, type SwfTag } from './swf.ts';

/** DefineEditText's flag bytes. */
const HAS_TEXT = 0x80;
const HAS_TEXT_COLOR = 0x04;
const HAS_MAX_LENGTH = 0x02;
const HAS_FONT = 0x01;
const HAS_FONT_CLASS = 0x80;
const HAS_LAYOUT = 0x20;
const HTML = 0x02;

export interface EditText {
  readonly id: number;
  /** The variable its text is bound to (empty: none). */
  readonly variable: string;
  /** Its text as authored (HTML when `html`). */
  readonly initialText: string;
  readonly html: boolean;
}

export function readEditText(body: Uint8Array, version: number): EditText {
  const reader = new BinaryReader(body);
  const id = reader.u16();
  // Bounds: a RECT (5 bits of field size, four fields), byte-aligned after.
  const bits = 5 + 4 * ((body[reader.offset] ?? 0) >> 3);
  reader.skip(Math.ceil(bits / 8));
  const flags1 = reader.u8();
  const flags2 = reader.u8();
  if (flags1 & HAS_FONT) reader.skip(2);
  if (flags2 & HAS_FONT_CLASS) readSwfString(reader, version);
  if (flags1 & HAS_FONT) reader.skip(2);
  if (flags1 & HAS_TEXT_COLOR) reader.skip(4);
  if (flags1 & HAS_MAX_LENGTH) reader.skip(2);
  if (flags2 & HAS_LAYOUT) reader.skip(9);
  const variable = readSwfString(reader, version);
  const initialText = flags1 & HAS_TEXT ? readSwfString(reader, version) : '';
  return { id, variable, initialText, html: (flags2 & HTML) !== 0 };
}

/** A named text field of a movie and its path from _root ("_root.Holder.SubtitleText"). */
export interface TextFieldPath {
  readonly path: string;
  readonly field: EditText;
}

/** How deep sprites are followed (the menus nest a few levels). */
const MAX_DEPTH = 12;

/**
 * The named text fields a movie places (in any frame of _root and of the sprites placed in
 * it), with their paths from _root; a sprite placed under several names gives each its own.
 */
export function textFieldPaths(movie: SwfMovie): TextFieldPath[] {
  const version = movie.header.version;
  const fields = new Map<number, EditText>();
  const sprites = new Map<number, readonly SwfTag[]>();
  const visit = (tags: readonly SwfTag[]): void => {
    for (const tag of tags) {
      if (tag.code === SwfTagCode.defineEditText) {
        const field = readEditText(tagBody(movie, tag), version);
        fields.set(field.id, field);
      } else if (tag.code === SwfTagCode.defineSprite && tag.children) {
        const body = tagBody(movie, tag);
        sprites.set((body[0] ?? 0) | ((body[1] ?? 0) << 8), tag.children);
        visit(tag.children);
      }
    }
  };
  visit(movie.tags);
  const out: TextFieldPath[] = [];
  const seen = new Set<string>();
  const walk = (tags: readonly SwfTag[], prefix: string, depth: number): void => {
    for (const tag of tags) {
      if (tag.code !== SwfTagCode.placeObject2 && tag.code !== SwfTagCode.placeObject3) continue;
      const placement = readPlacement(tagBody(movie, tag), tag.code);
      if (placement.character === undefined || placement.name === undefined) continue;
      const path = `${prefix}.${placement.name}`;
      if (seen.has(path)) continue;
      seen.add(path);
      const field = fields.get(placement.character);
      if (field) out.push({ path, field });
      const children = sprites.get(placement.character);
      if (children && depth < MAX_DEPTH) walk(children, path, depth + 1);
    }
  };
  walk(movie.tags, '_root', 0);
  return out;
}

/** An authored text's words without its HTML (paragraphs, breaks as new lines; entities read). */
export function plainText(field: EditText): string {
  const text = field.html
    ? field.initialText.replace(/<\/p>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    : field.initialText;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** The words designers left in fields the engine or the menu's code fills ("Selected Item"). */
const DUMMY =
  /^(text|item|topic|location|objective|skill|selected (item|topic)|menu name|enemy name|creation name|item info|reference text|credits text|additional description|confirm message text|descriptions? go(es)? in here)$/i;

/**
 * Whether an authored text is a designer's placeholder, shown only until the engine sets the
 * field: "Dialogue Line 1", "Effect 2", "Lorem ipsum", "Sample Text", "Selected Item", "TEXT",
 * "Menu Name", "XXX". Translated keys ("$Health"), numbers and real labels are not.
 */
export function isPlaceholder(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0 || text.trim().startsWith('$')) return false;
  return lines.some(
    (line) =>
      DUMMY.test(line) ||
      /\b(lorem|ipsum|placeholder|dummy)\b/i.test(line) ||
      /\b(line|text|name|title|label|sample|test|item|entry|quest|objective|effects?|description)\s*#?\d+\b/i.test(
        line,
      ) ||
      /\b(sample|test|your|enter)\s+(text|name|string)\b/i.test(line) ||
      /\b(text|name)\s+here\b/i.test(line) ||
      /^\d+(st|nd|rd|th)( line)?$/i.test(line) ||
      /^x{3,}$/i.test(line),
  );
}

/** A field's text as the comparison sees it: its words, whitespace and line breaks dropped. */
export function textKey(text: string): string {
  return text.replace(/\s+/g, '');
}
