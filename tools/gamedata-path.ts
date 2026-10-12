import { existsSync } from 'node:fs';
import path from 'node:path';
import { NodeGameFolder } from './node-game-folder.ts';

/**
 * Lokale, alleen-lezen kopie van Skyrim SE's Data-map, buiten de repo.
 * Overschrijfbaar met de omgevingsvariabele SKYRIM_DATA.
 */
export const GAMEDATA_DIR = process.env.SKYRIM_DATA ?? 'F:\\skyrim-data\\Data';

/** Installatiemap (met Skyrim.ccc en Skyrim_Default.ini): de map boven Data. */
export const GAME_ROOT_DIR = path.dirname(GAMEDATA_DIR);

export function hasGamedata(): boolean {
  return existsSync(GAMEDATA_DIR);
}

export function openGameFolder(): NodeGameFolder {
  return new NodeGameFolder(GAMEDATA_DIR, GAME_ROOT_DIR);
}

/** Pad naar een archief: absoluut, of een naam in de Data-map. */
export function resolveDataFile(nameOrPath: string): string {
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(GAMEDATA_DIR, nameOrPath);
}
