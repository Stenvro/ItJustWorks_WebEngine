// The interface's translations: interface\translate_<language>.txt, UTF-16 lines of
// "$KEY<tab>text". Scaleform shows a text field whose text is such a key as its translation;
// keys are matched as written, then ignoring case. Notes: docs/formats/swf.md.

export class Translations {
  readonly #exact = new Map<string, string>();
  readonly #folded = new Map<string, string>();

  constructor(entries: Iterable<readonly [string, string]>) {
    for (const [key, text] of entries) {
      this.#exact.set(key, text);
      const folded = key.toLowerCase();
      if (!this.#folded.has(folded)) this.#folded.set(folded, text);
    }
  }

  get size(): number {
    return this.#exact.size;
  }

  /** The text of a key ("$NEW" → "NEW"); undefined for anything else. */
  translate(text: string): string | undefined {
    if (!text.startsWith('$')) return undefined;
    return this.#exact.get(text) ?? this.#folded.get(text.toLowerCase());
  }
}

export function parseTranslations(text: string): Translations {
  const entries: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('$')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    entries.push([line.slice(0, tab), line.slice(tab + 1)]);
  }
  return new Translations(entries);
}
