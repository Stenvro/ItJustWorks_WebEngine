// Bethesda-INI: [Sectie], sleutel=waarde, commentaar met ; of #. Hoofdletterongevoelig.

export type Ini = ReadonlyMap<string, ReadonlyMap<string, string>>;

export function parseIni(text: string): Ini {
  const sections = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  sections.set('', current);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const section = /^\[(.*)\]$/.exec(line);
    if (section) {
      const name = (section[1] ?? '').trim().toLowerCase();
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    current.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
  }
  return sections;
}

export function iniValue(ini: Ini, section: string, key: string): string | undefined {
  return ini.get(section.toLowerCase())?.get(key.toLowerCase());
}

/** Komma-gescheiden lijst, zoals `sResourceArchiveList`. */
export function splitIniList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}
