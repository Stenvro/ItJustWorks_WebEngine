/** Een item in een gekozen map (bestand of submap). */
export interface FolderEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

export interface DataFolderReport {
  /** Alle verplichte bestanden zijn aanwezig. */
  readonly ok: boolean;
  /** Ontbrekende verplichte bestanden. */
  readonly missing: readonly string[];
  /** Plugins (.esm/.esp/.esl), alfabetisch; dit is níet de laadvolgorde. */
  readonly plugins: readonly string[];
  /** BSA-archieven, alfabetisch. */
  readonly archives: readonly string[];
  /** De gekozen map is de installatiemap (Data plus SkyrimSE.exe of Skyrim.ccc). */
  readonly looksLikeGameRoot: boolean;
}

/** Masters die in elke Skyrim Special Edition-installatie zitten. */
export const REQUIRED_MASTERS = [
  'Skyrim.esm',
  'Update.esm',
  'Dawnguard.esm',
  'HearthFires.esm',
  'Dragonborn.esm',
] as const;

/** Basisarchieven van Skyrim SE (taalonafhankelijk). */
export const REQUIRED_ARCHIVES = [
  'Skyrim - Animations.bsa',
  'Skyrim - Interface.bsa',
  'Skyrim - Meshes0.bsa',
  'Skyrim - Meshes1.bsa',
  'Skyrim - Misc.bsa',
  'Skyrim - Shaders.bsa',
  'Skyrim - Sounds.bsa',
  ...Array.from({ length: 9 }, (_, i) => `Skyrim - Textures${i}.bsa`),
] as const;

/** Stemmen zijn taalafhankelijk: `Skyrim - Voices_en0.bsa`, `Skyrim - Voices_de0.bsa`, ... */
const VOICES_ARCHIVE = /^skyrim - voices_[a-z]+0\.bsa$/;
const PLUGIN = /\.(esm|esp|esl)$/;

function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Controleert of een map een bruikbare Skyrim SE Data-map is.
 * Bestandsnamen worden hoofdletterongevoelig vergeleken, zoals op Windows.
 */
export function checkDataFolder(entries: Iterable<FolderEntry>): DataFolderReport {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (entry.kind === 'file') files.set(lower, entry.name);
    else directories.add(lower);
  }

  const missing: string[] = [...REQUIRED_MASTERS, ...REQUIRED_ARCHIVES].filter(
    (name) => !files.has(name.toLowerCase()),
  );
  if (![...files.keys()].some((name) => VOICES_ARCHIVE.test(name))) {
    missing.push('Skyrim - Voices_*0.bsa');
  }

  const plugins = [...files].filter(([lower]) => PLUGIN.test(lower)).map(([, name]) => name);
  const archives = [...files].filter(([lower]) => lower.endsWith('.bsa')).map(([, name]) => name);

  return {
    ok: missing.length === 0,
    missing,
    plugins: plugins.sort(byName),
    archives: archives.sort(byName),
    looksLikeGameRoot:
      directories.has('data') && (files.has('skyrimse.exe') || files.has('skyrim.ccc')),
  };
}
