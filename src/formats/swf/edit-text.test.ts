import { describe, expect, it } from 'vitest';
import { isPlaceholder, plainText, readEditText, textKey } from './edit-text.ts';

/** A DefineEditText body: id 7, a 5-bit RECT of zeros, flags, a font, a variable, its text. */
function editText(text: string, html: boolean): Uint8Array {
  const bytes = [
    7,
    0,
    // RECT: Nbits 0 (5 bits) and four empty fields: one byte.
    0,
    // HasText | HasFont; HTML.
    0x80 | 0x01,
    html ? 0x02 : 0,
    // Font id, font height.
    1,
    0,
    240,
    0,
    // Variable name: empty.
    0,
    ...new TextEncoder().encode(text),
    0,
  ];
  return new Uint8Array(bytes);
}

describe('readEditText', () => {
  it('reads an authored text and its HTML flag', () => {
    const field = readEditText(editText('<p>Dialogue Line 1</p><p>Dialogue Line 2</p>', true), 8);
    expect(field.id).toBe(7);
    expect(field.html).toBe(true);
    expect(plainText(field)).toBe('Dialogue Line 1\nDialogue Line 2');
  });
});

describe('isPlaceholder', () => {
  it("knows the designers' placeholders", () => {
    expect(isPlaceholder('Dialogue Line 1\nDialogue Line 2')).toBe(true);
    expect(isPlaceholder('Selected Item\n2nd line')).toBe(true);
    expect(isPlaceholder('TEXT')).toBe(true);
    expect(isPlaceholder('Effect 3')).toBe(true);
    expect(isPlaceholder('Lorem ipsum')).toBe(true);
  });

  it('leaves translated keys, numbers and real labels alone', () => {
    expect(isPlaceholder('$WEIGHT')).toBe(false);
    expect(isPlaceholder('000')).toBe(false);
    expect(isPlaceholder('100%')).toBe(false);
    expect(isPlaceholder('LEGENDARY SPELL REFLECT')).toBe(false);
    expect(isPlaceholder('')).toBe(false);
  });

  it('compares texts without their whitespace', () => {
    expect(textKey('Dialogue Line 1\rDialogue Line 2')).toBe(
      textKey('Dialogue Line 1\nDialogue Line 2'),
    );
  });
});
