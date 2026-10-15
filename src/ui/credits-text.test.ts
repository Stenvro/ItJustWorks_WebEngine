import { describe, expect, it } from 'vitest';
import { creditsHtml } from './credits-text.ts';

describe('credits', () => {
  it('keeps the lines and leaves the images out', () => {
    const text =
      String.fromCharCode(0xfeff) +
      `<img src='Logo' height="2">\r\nTITLE\r\n\r\nName\r\n<font size='20'>x</font>`;
    expect(creditsHtml(text)).toBe("\nTITLE\n\nName\n<font size='20'>x</font>");
  });
});
