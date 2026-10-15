// A book's text (BOOK DESC) as book.swf gets it here, for what the Flash player (Ruffle) does
// otherwise than GFx: GFx takes a CR LF for one line break, a Flash player for two; and Ruffle
// keeps an <img> tag but draws nothing and lays the text after it out wrongly (its lines run on
// past the field), so pagination fails. An illuminated letter
// (img://Textures/Interface/Books/Illuminated_Letters/<X>_letter.png, the first letter of a
// chapter) becomes its letter; other images are left out. TODO(M13): the images themselves,
// once Ruffle draws <img> in text fields (ruffle-rs/ruffle#16618). Platform-independent.

const IMAGE = /<img\b[^>]*>/gi;
const LETTER = /illuminated_letters[\\/]+([a-z])_letter\.[a-z]+/i;

export function bookText(text: string): string {
  return text.replaceAll('\r\n', '\n').replace(IMAGE, (tag) => {
    const letter = LETTER.exec(tag)?.[1];
    return letter === undefined ? '' : letter.toUpperCase();
  });
}
