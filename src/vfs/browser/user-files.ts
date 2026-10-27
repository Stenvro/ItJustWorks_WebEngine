// The player's own files the browser cannot reach where the original keeps them: Plugins.txt
// (%LOCALAPPDATA%) and Skyrim.ini / SkyrimPrefs.ini (Documents\My Games). The plugin screen
// writes the plugin list; the INI files are imported copies (the user's own files are only ever
// read). Kept in IndexedDB beside the stored folder handle.

import { decodeWindows1252 } from '../../formats/text.ts';
import { deleteHandle, loadText, saveText } from './handle-store.ts';

export interface UserFiles {
  readonly pluginsTxt?: string | undefined;
  readonly skyrimIni?: string | undefined;
  readonly skyrimPrefsIni?: string | undefined;
}

export type UserFileKey = keyof UserFiles;

const KEYS: Readonly<Record<UserFileKey, string>> = {
  pluginsTxt: 'plugins-txt',
  skyrimIni: 'skyrim-ini',
  skyrimPrefsIni: 'skyrim-prefs-ini',
};

export async function loadUserFiles(): Promise<UserFiles> {
  const [pluginsTxt, skyrimIni, skyrimPrefsIni] = await Promise.all([
    loadText(KEYS.pluginsTxt),
    loadText(KEYS.skyrimIni),
    loadText(KEYS.skyrimPrefsIni),
  ]);
  return { pluginsTxt, skyrimIni, skyrimPrefsIni };
}

/** Stores one file's text, or forgets it (`undefined`). */
export async function saveUserFile(key: UserFileKey, text: string | undefined): Promise<void> {
  if (text === undefined) await deleteHandle(KEYS[key]);
  else await saveText(KEYS[key], text);
}

/**
 * Lets the user pick a text file and reads it (Windows-1252, as the game writes its INI files and
 * Plugins.txt). `undefined` if they cancel. Must be called from a click.
 */
export function pickTextFile(accept: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(undefined);
        return;
      }
      file
        .arrayBuffer()
        .then((buffer) => {
          resolve(decodeWindows1252(new Uint8Array(buffer)));
        })
        .catch(reject);
    });
    input.addEventListener('cancel', () => {
      resolve(undefined);
    });
    input.click();
  });
}
