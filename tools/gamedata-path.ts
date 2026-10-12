import { existsSync } from 'node:fs';

/**
 * Lokale, alleen-lezen kopie van Skyrim SE's Data-map, buiten de repo.
 * Overschrijfbaar met de omgevingsvariabele SKYRIM_DATA.
 */
export const GAMEDATA_DIR = process.env.SKYRIM_DATA ?? 'F:\\skyrim-data\\Data';

export function hasGamedata(): boolean {
  return existsSync(GAMEDATA_DIR);
}
