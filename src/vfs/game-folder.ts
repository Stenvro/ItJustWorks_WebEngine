import type { ByteSource } from '../formats/byte-source.ts';

/**
 * Access to a Skyrim installation, independent of the platform (browser or Node).
 * The install folder contains `Data/` plus e.g. `Skyrim.ccc` and `Skyrim_Default.ini`.
 */
export interface GameFolder {
  /** All files under Data/, recursively, as relative paths (separator `/` or `\`). */
  listDataFiles(): Promise<readonly string[]>;
  /** Opens a file under Data/ by a path from `listDataFiles`. */
  openDataFile(relativePath: string): Promise<ByteSource>;
  /**
   * Reads a file from the install folder itself (case-insensitive).
   * `undefined` if it is missing or if only the Data folder is reachable.
   */
  readRootFile(name: string): Promise<Uint8Array | undefined>;
}
