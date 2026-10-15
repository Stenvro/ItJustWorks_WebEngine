import { describe, expect, it } from 'vitest';
import { bookText } from './book-text.ts';

describe('bookText', () => {
  it('takes CR LF as one line break', () => {
    expect(bookText('[pagebreak]\r\n<p align="center">\r\nTitle\r\n</p>')).toBe(
      '[pagebreak]\n<p align="center">\nTitle\n</p>',
    );
  });

  it('puts an illuminated letter as its letter and leaves other images out', () => {
    expect(
      bookText(
        "<p><img src='img://Textures/Interface/Books/Illuminated_Letters/L_letter.png'>ate in the Second Era</p>",
      ),
    ).toBe('<p>Late in the Second Era</p>');
    expect(bookText('<IMG SRC="img://Textures/Interface/Books/Map.png" width=\'300\'>Map')).toBe(
      'Map',
    );
  });
});
