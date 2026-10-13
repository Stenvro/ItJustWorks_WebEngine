import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NodeGameFolder } from './node-game-folder.ts';

/** The repository's root (tools/ is one level down). */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The game's Data folder for tools, tests and the dev server, outside the repo: the
 * SKYRIM_DATA environment variable, else the path on the first line of `.gamedata` in the
 * repository root (ignored by git); none: integration tests are skipped.
 */
export const GAMEDATA_DIR = process.env.SKYRIM_DATA ?? localGamedata() ?? '';

function localGamedata(): string | undefined {
  try {
    const line = readFileSync(path.join(REPO_ROOT, '.gamedata'), 'utf8').split(/\r?\n/)[0];
    const trimmed = line?.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/** Installation folder (with Skyrim.ccc and Skyrim_Default.ini): the folder above Data. */
export const GAME_ROOT_DIR = path.dirname(GAMEDATA_DIR);

export function hasGamedata(): boolean {
  return GAMEDATA_DIR !== '' && existsSync(GAMEDATA_DIR);
}

export function openGameFolder(): NodeGameFolder {
  return new NodeGameFolder(GAMEDATA_DIR, GAME_ROOT_DIR);
}

/** Path to an archive: absolute, or a name in the Data folder. */
export function resolveDataFile(nameOrPath: string): string {
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(GAMEDATA_DIR, nameOrPath);
}
