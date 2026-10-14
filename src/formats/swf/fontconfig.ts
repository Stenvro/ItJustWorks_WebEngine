// Scaleform's font configuration: interface\fontconfig.txt (and fontconfig_<language>.txt).
// `fontlib "Interface\fonts_en.swf"` names a movie whose fonts are used; `map "$Name" =
// "Font Name" Style` makes a font name the menus use stand for one of those fonts. Lines that
// configure other things (validNameChars) are kept as they are. Notes: docs/formats/swf.md.

export interface FontMapping {
  /** The name the menus use, e.g. "$EverywhereMediumFont". */
  readonly name: string;
  /** The font it stands for, e.g. "Futura Condensed". */
  readonly font: string;
  /** Normal, Bold, Italic, BoldItalic, or a foundry's own (Roman, Demi). */
  readonly style: string;
}

export interface FontConfig {
  /** The font libraries, as written ("Interface\fonts_en.swf"). */
  readonly libraries: readonly string[];
  readonly mappings: readonly FontMapping[];
  /** Other settings by keyword (validNameChars → its text). */
  readonly settings: ReadonlyMap<string, string>;
}

const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

export function parseFontConfig(text: string): FontConfig {
  const libraries: string[] = [];
  const mappings: FontMapping[] = [];
  const settings = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//') || line.startsWith(';')) continue;
    const keyword = /^(\w+)/.exec(line)?.[1];
    if (!keyword) continue;
    const quoted = [...line.matchAll(QUOTED)].map((match) => match[1] ?? '');
    switch (keyword.toLowerCase()) {
      case 'fontlib':
        if (quoted[0] !== undefined) libraries.push(quoted[0]);
        break;
      case 'map': {
        const [name, font] = quoted;
        if (name === undefined || font === undefined) break;
        const style = line.slice(line.lastIndexOf('"') + 1).trim() || 'Normal';
        mappings.push({ name, font, style });
        break;
      }
      default:
        settings.set(keyword, line.slice(keyword.length).trim());
    }
  }
  return { libraries, mappings, settings };
}

/** Whether a mapping's style asks for a bold face (Bold, BoldItalic, a foundry's Demi). */
export function styleIsBold(style: string): boolean {
  return /bold|demi|heavy|black/i.test(style);
}

/** Whether a mapping's style asks for an italic face. */
export function styleIsItalic(style: string): boolean {
  return /italic|oblique/i.test(style);
}
