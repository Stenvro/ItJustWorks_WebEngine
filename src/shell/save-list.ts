// The save list both the main menu and the journal's system page show (the movies'
// SaveLoadPanel, the same class in startmenu.swf and quest_journal.swf): the characters first
// (PopulateCharacterList: one entry per character, onFillCharacterListComplete), then a
// character's saves (CharacterSelected) or the current character's (the journal's Save and Load),
// filled into the list the movie passes and told complete with onSaveLoadBatchComplete. A save is
// loaded (LoadGame), deleted (DeleteSave) or saved over (SaveGame) by its index in the list
// shown. Notes: docs/ui.md ("Saves in the menus").

import { characterKey } from '../save/character-id.ts';
import type { SaveHeader } from '../save/save-codec.ts';

/** Load's last entry: the import of an original save. */
export const IMPORT_ESS_TEXT = 'Import .ess (a save of the original game)';

/** The player's name in a save before the race menu has named them (src/save/game-save.ts). */
export const DEFAULT_PLAYER_NAME = 'Prisoner';

/** What the save list does with the movie (a Menu of src/ui/menu-host.ts). */
export interface SaveListMenu {
  reference(argument: unknown): string | undefined;
  set(path: string, value: unknown): void;
  invoke(path: string, ...args: unknown[]): unknown;
  call(name: string, ...args: unknown[]): unknown;
}

/** What the menus' save list reads and changes (Play's save manager). */
export interface SaveListSource {
  list(): Promise<SaveHeader[]>;
  delete(name: string): Promise<void>;
  /**
   * A save's screenshot (PNG; empty when it has none), or with no name the game playing now
   * (Save's new save).
   */
  screenshot?(name: string | undefined): Promise<Uint8Array | undefined>;
}

/** The picture the save list's screenshot loads (sSaveGameScreenshotName). */
export const SAVE_SCREENSHOT_IMAGE = 'BGSSaveLoadHeader_Screenshot';

/** An entry of the movie's character list. */
export interface CharacterEntry {
  /** The character's name, as the list shows it. */
  readonly text: string;
  /** What CharacterSelected sends back: its place in the list. */
  readonly id: number;
  readonly flags: number;
}

/**
 * The characters of a set of saves, the one saved last first, each named as its newest save
 * names the player. Saves are told apart by their character's id (src/save/character-id.ts, as
 * observed in the original), saves made before it was kept by the player's name.
 */
export function savedCharacters(headers: readonly SaveHeader[]): CharacterEntry[] {
  return characterGroups(headers).map(({ text }, id) => ({ text, id, flags: 0 }));
}

/** The characters of a set of saves (as savedCharacters) with the key their saves share. */
function characterGroups(headers: readonly SaveHeader[]): { text: string; key: string }[] {
  const groups: { text: string; key: string }[] = [];
  for (const header of [...headers].sort((a, b) => b.realTime - a.realTime)) {
    const key = characterKey(header);
    if (!groups.some((group) => group.key === key)) groups.push({ text: header.playerName, key });
  }
  return groups;
}

/** Game days passed as a time played ("12 days, 06:30"). */
export function gameDaysText(days: number): string {
  const whole = Math.floor(days);
  const minutes = Math.floor((days - whole) * 24 * 60);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return `${String(whole)} ${whole === 1 ? 'day' : 'days'}, ${time}`;
}

/** An entry of the movie's save list. */
export interface SaveEntry {
  readonly text: string;
  readonly name: string;
  readonly level: number;
  readonly raceName: string;
  readonly playTime: string;
  readonly index: number;
  readonly fileNum: number;
}

/** A save as the list shows it: its name and place, the player's name and level, game time. */
export function saveEntry(header: SaveHeader, index: number, playTime: string): SaveEntry {
  return {
    text: `${header.name}  ${header.location}`,
    name: header.playerName,
    level: header.playerLevel,
    raceName: '',
    playTime,
    index,
    fileNum: header.number,
  };
}

export interface SaveListOptions<M extends SaveListMenu> {
  readonly source: () => SaveListSource | undefined;
  /** A save's game time as the list shows it. */
  readonly playTime: (header: SaveHeader) => string;
  /**
   * The character playing now (the journal's Save and Load show only theirs), as its saves'
   * key (characterKey); none: all.
   */
  readonly character?: () => string | undefined;
  /** Load's last entry: the import of an original save (its text), when there is one. */
  readonly importText?: () => string | undefined;
  readonly load: (menu: M, name: string) => void;
  /** The import entry was loaded (LoadGame). */
  readonly importSave?: (menu: M) => void;
  /**
   * The import entry was pressed (IsOKtoLoad): when set, it is asked instead of the movie's
   * "Load this game?" (the file is picked first; the menu then asks LoadGame itself).
   */
  readonly pickImport?: (menu: M, index: number) => void;
  /** Gives the movie its screenshot picture (img://BGSSaveLoadHeader_Screenshot). */
  readonly screenshotImage?: (png: Uint8Array | undefined) => void;
  readonly log: (message: string) => void;
  /** A save was deleted (the journal hears the save system's result: RefreshMenu). */
  readonly deleted?: (menu: M) => void;
  /** A save could not be deleted (the journal: the device error, then Show Journal). */
  readonly failed?: (menu: M) => void;
}

/** The save list's requests, answered for one movie at a time. */
export class SaveList<M extends SaveListMenu = SaveListMenu> {
  readonly #options: SaveListOptions<M>;
  /** The saves the list shows now, and whether it saves (its first entry the new save). */
  #listed: { headers: SaveHeader[]; saving: boolean; list: string } | undefined;
  /** The characters the list showed last (CharacterSelected's id is a place among them). */
  #characters: { text: string; key: string }[] = [];

  constructor(options: SaveListOptions<M>) {
    this.#options = options;
  }

  /** The saves listed now (SaveGame's and LoadGame's indices are into these). */
  get listed(): { readonly headers: readonly SaveHeader[]; readonly saving: boolean } | undefined {
    return this.#listed;
  }

  /**
   * The handlers of the save list's calls, as the menus send them: GameDelegate.call's request
   * id first, then the call's own arguments (which the handlers below read from 0).
   */
  handlers(): Record<string, (menu: M, args: readonly unknown[]) => unknown> {
    return Object.fromEntries(
      Object.entries(this.#calls()).map(([name, handler]) => [
        name,
        (menu: M, args: readonly unknown[]) => handler(menu, args.slice(1)),
      ]),
    );
  }

  /** The save list's calls by their own arguments (without the request id). */
  #calls(): Record<string, (menu: M, args: readonly unknown[]) => unknown> {
    return {
      // Save and Load from the journal: the current character's saves.
      SAVE: (menu, args) => {
        void this.#fill(menu, args[0], true, this.#options.character?.());
      },
      LOAD: (menu, args) => {
        void this.#fill(menu, args[0], false, this.#options.character?.());
      },
      PopulateCharacterList: (menu, args) => {
        void this.#fillCharacters(menu, args[0]);
      },
      // CharacterSelected(id, flags, saving, list, batch size): that character's saves.
      CharacterSelected: (menu, args) => {
        const id = typeof args[0] === 'number' ? args[0] : -1;
        const character = this.#characters[id]?.key;
        void this.#fill(menu, args[3], args[2] === true, character);
      },
      // PrepSaveGameScreenshot(index, entry): the movie asks for the highlighted save's
      // screenshot (a moment after the highlight settles) and shows it, with the save's player,
      // level and time, once the engine says ScreenshotReady. Save's index is counted past its
      // new save (-1: the game playing now). It is answered even without a picture: the
      // movie's ShowScreenshot is what fills the save's text.
      PrepSaveGameScreenshot: (menu, args) => {
        void this.#screenshot(menu, typeof args[0] === 'number' ? args[0] : -1);
      },
      // The list is filled at once: there is no loading in batches to stop.
      ForceStopSaveListLoading: () => undefined,
      // The journal's Save keeps to the character playing (always so here).
      UseCurrentCharacterFilter: () => undefined,
      IsOKtoLoad: (menu, args) => {
        const index = typeof args[0] === 'number' ? args[0] : -1;
        const listed = this.#listed;
        const pick = this.#options.pickImport;
        if (pick && listed && !listed.saving && index === listed.headers.length) {
          pick(menu, index);
          return;
        }
        menu.call('ConfirmOKToLoad');
      },
      LoadGame: (menu, args) => {
        const index = typeof args[0] === 'number' ? args[0] : -1;
        const listed = this.#listed;
        const name = listed?.headers[index]?.name;
        if (name !== undefined) this.#options.load(menu, name);
        else if (index === listed?.headers.length) this.#options.importSave?.(menu);
      },
      // The movie asked "Delete this save?" itself and, the player having said yes, sends the
      // save's index among the saves (on Save past its [NEW SAVE], already counted off) and takes
      // the entry out of its list. The list is filled again once the save has gone.
      DeleteSave: (menu, args) => {
        const listed = this.#listed;
        const index = typeof args[0] === 'number' ? args[0] : -1;
        const name = listed?.headers[index]?.name;
        const source = this.#options.source();
        if (!listed || name === undefined || !source) return;
        const header = listed.headers[index];
        const character = header && characterKey(header);
        source
          .delete(name)
          .then(
            () => {
              this.#options.deleted?.(menu);
            },
            (error: unknown) => {
              this.#options.log(
                `${name} could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
              );
              this.#options.failed?.(menu);
            },
          )
          .then(() => this.#fill(menu, listed.list, listed.saving, character))
          .catch(() => undefined);
      },
    };
  }

  /** The screenshot of the save at `index` (or of the game playing now) given to the movie. */
  async #screenshot(menu: M, index: number): Promise<void> {
    const listed = this.#listed;
    const name = listed?.headers[index]?.name;
    // The import entry (past the saves) has no picture.
    const known = name !== undefined || (index < 0 && listed?.saving === true);
    const source = this.#options.source();
    const png = known ? await source?.screenshot?.(name).catch(() => undefined) : undefined;
    // The list was filled again meanwhile: the movie asks again.
    if (this.#listed !== listed) return;
    this.#options.screenshotImage?.(png);
    menu.call('ScreenshotReady');
  }

  /** Fills the movie's list with the characters, then tells it (onFillCharacterListComplete). */
  async #fillCharacters(menu: M, list: unknown): Promise<void> {
    const path = listPath(menu, list);
    if (!path) return;
    this.#characters = characterGroups((await this.#options.source()?.list()) ?? []);
    menu.set(`${path}.length`, 0);
    this.#characters.forEach(({ text }, id) => {
      menu.invoke(`${path}.push`, { text, id, flags: 0 });
    });
    menu.call('onFillCharacterListComplete', true);
  }

  /**
   * Fills the movie's list with the saves (a character's, or all), then tells the movie it is
   * complete (onSaveLoadBatchComplete: initial update, entries processed, entries in all).
   */
  async #fill(
    menu: M,
    list: unknown,
    saving: boolean,
    character: string | undefined,
  ): Promise<void> {
    const path = listPath(menu, list);
    if (!path) return;
    const all = (await this.#options.source()?.list()) ?? [];
    const headers =
      character === undefined || !all.some((header) => characterKey(header) === character)
        ? all
        : all.filter((header) => characterKey(header) === character);
    this.#listed = { headers, saving, list: path };
    menu.set(`${path}.length`, 0);
    headers.forEach((header, index) => {
      menu.invoke(`${path}.push`, { ...saveEntry(header, index, this.#options.playTime(header)) });
    });
    // Load ends with the import of an original save, where there is one.
    const importText = saving ? undefined : this.#options.importText?.();
    if (importText !== undefined) {
      menu.invoke(`${path}.push`, {
        text: importText,
        name: '',
        level: 0,
        raceName: '',
        playTime: '',
        index: headers.length,
        fileNum: 0,
      });
    }
    const entries = headers.length + (importText === undefined ? 0 : 1);
    menu.call('onSaveLoadBatchComplete', true, entries, entries);
  }
}

/** The path of a list the movie passed (a clip reference, or a path). */
function listPath(menu: SaveListMenu, list: unknown): string | undefined {
  // The movie's own list comes as a reference ("__itjwRef:N", which starts with "_" too); a
  // path ("_root....") is taken as it is.
  return (
    menu.reference(list) ?? (typeof list === 'string' && list.startsWith('_') ? list : undefined)
  );
}
