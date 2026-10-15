// The credits' text (Interface\Credits.txt, HTML) as the credits menu shows it: its lines, the
// images it places left out. TODO(M13): the logos (<img src='SkyrimLogo'>, a symbol of the
// movie's library): Ruffle lays out text with images wrongly (ruffle-rs/ruffle#16618), as with
// the books' illuminated letters. Platform-independent. Notes: docs/ui.md ("Credits").

/** The credits' HTML as the movie shows it (lines, without the images). */
export function creditsHtml(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.replace(/\r\n?/g, '\n').replace(/<img\b[^>]*>/gi, '');
}
