import type { ByteSource } from '../formats/byte-source.ts';

/**
 * Toegang tot een Skyrim-installatie, los van het platform (browser of Node).
 * De installatiemap bevat `Data/` plus o.a. `Skyrim.ccc` en `Skyrim_Default.ini`.
 */
export interface GameFolder {
  /** Alle bestanden onder Data/, recursief, als relatieve paden (scheidingsteken `/` of `\`). */
  listDataFiles(): Promise<readonly string[]>;
  /** Opent een bestand onder Data/ met een pad uit `listDataFiles`. */
  openDataFile(relativePath: string): Promise<ByteSource>;
  /**
   * Leest een bestand uit de installatiemap zelf (hoofdletterongevoelig).
   * `undefined` als het ontbreekt of als alleen de Data-map bereikbaar is.
   */
  readRootFile(name: string): Promise<Uint8Array | undefined>;
}
