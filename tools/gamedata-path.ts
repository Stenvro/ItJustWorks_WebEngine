import { existsSync } from 'node:fs';
import path from 'node:path';
import { NodeGameFolder } from './node-game-folder.ts';

/**
 * Local, read-only copy of Skyrim SE's Data folder, outside the repo.
 * Can be overridden with the SKYRIM_DATA environment variable.
 */
export const GAMEDATA_DIR = process.env.SKYRIM_DATA ?? 'F:\\skyrim-data\\Data';

/** Installation folder (with Skyrim.ccc and Skyrim_Default.ini): the folder above Data. */
export const GAME_ROOT_DIR = path.dirname(GAMEDATA_DIR);

export function hasGamedata(): boolean {
  return existsSync(GAMEDATA_DIR);
}

export function openGameFolder(): NodeGameFolder {
  return new NodeGameFolder(GAMEDATA_DIR, GAME_ROOT_DIR);
}

/** Path to an archive: absolute, or a name in the Data folder. */
export function resolveDataFile(nameOrPath: string): string {
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(GAMEDATA_DIR, nameOrPath);
}
