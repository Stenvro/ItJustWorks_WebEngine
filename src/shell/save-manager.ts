// Saving and loading in Play (docs/formats/save.md): the saves' names and numbers as the
// original makes them (Save N, Quicksave, autosaves in turn), the save store in the browser,
// and the autosave rules of the INI ([SaveGame] bSaveOnTravel, bSaveOnWait, bSaveOnRest; [Main]
// bSaveOnPause with fAutosaveEveryXMins). Loading itself is Play's (play-mode.ts): the world
// is rebuilt from the plugins behind the loading screen, then the save is applied.

import { readEss } from '../formats/ess/ess.ts';
import { importEss, type EssWorld } from '../save/ess-import.ts';
import { readGameSave, saveGame, type GameSave } from '../save/game-save.ts';
import { writeSave, type SaveHeader } from '../save/save-codec.ts';
import { SaveStore } from '../save/save-store.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** How many autosaves the game keeps in turn ([SaveGame] iAutoSaveCount's default). */
const AUTOSAVE_COUNT = 3;

/** How often a script's save request looks again whether the game may save (ms). */
const REQUEST_RETRY_MS = 500;

export type AutosaveReason = 'travel' | 'wait' | 'rest' | 'pause';

export class SaveManager {
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  #store: Promise<SaveStore> | undefined;
  /** Real time (ms) of the last save made or loaded (Save on Pause waits fAutosaveEveryXMins). */
  #lastSave = performance.now();
  #saving = false;
  /** The kinds of save scripts asked for that are not made yet (Game.RequestSave). */
  readonly #requests = new Set<'save' | 'autosave'>();

  constructor(session: GameSession, terminal: Terminal) {
    this.#session = session;
    this.#terminal = terminal;
  }

  #open(): Promise<SaveStore> {
    this.#store ??= SaveStore.open();
    return this.#store;
  }

  /** The saves, newest first. */
  async list(): Promise<SaveHeader[]> {
    return (await this.#open()).list();
  }

  /**
   * Whether the game may be saved now: not in chargen, not while a place loads, and every menu
   * open allows saving (the menu stack's AllowSaving: F5 in an item menu, a book or the map
   * saves nothing; the journal, the tween and the wait menus allow it).
   */
  get canSave(): boolean {
    const runtime = this.#session.scriptsReady;
    return (
      !!runtime &&
      !runtime.chargen.noSaving &&
      !this.#session.loading &&
      !this.#saving &&
      this.#session.menuStack.savingAllowed
    );
  }

  /**
   * Saves the game: a new save (or over `overwrite`, a save's name), the quicksave, or the next
   * autosave in turn. Resolves to its header, or undefined when saving is not allowed now.
   */
  async save(kind: SaveHeader['kind'], overwrite?: string): Promise<SaveHeader | undefined> {
    const runtime = this.#session.scriptsReady;
    if (!runtime || !this.canSave) return undefined;
    this.#saving = true;
    try {
      const store = await this.#open();
      const saves = await store.list();
      const number = saves.reduce((most, save) => Math.max(most, save.number), 0) + 1;
      let name = overwrite ?? `Save ${String(number)}`;
      if (kind === 'quicksave') name = 'Quicksave';
      if (kind === 'autosave') {
        const autosaves = saves.filter((save) => save.kind === 'autosave');
        const free = Array.from(
          { length: AUTOSAVE_COUNT },
          (_, i) => `Autosave ${String(i + 1)}`,
        ).find((candidate) => !autosaves.some((save) => save.name === candidate));
        name = free ?? autosaves.at(-1)?.name ?? 'Autosave 1';
      }
      const { bytes, unsaved } = await saveGame(runtime, { name, kind, number, now: Date.now() });
      for (const what of unsaved) this.#terminal.log('save', `not saved: ${what}`, 'warn');
      const header = await store.write(bytes);
      this.#lastSave = performance.now();
      this.#terminal.log('save', `saved ${name} (${(bytes.length / 1024).toFixed(0)} KB)`, 'ok');
      return header;
    } finally {
      this.#saving = false;
    }
  }

  /** An autosave if the INI's rule for the reason says so. */
  async autosave(reason: AutosaveReason): Promise<void> {
    const ini = this.#session.ini;
    const on = (section: string, name: string): boolean =>
      (ini.lookup(section, name) ?? ini.lookup('Main', name) ?? 1) !== 0;
    switch (reason) {
      case 'travel':
        if (!on('SaveGame', 'bSaveOnTravel')) return;
        break;
      case 'wait':
        if (!on('SaveGame', 'bSaveOnWait')) return;
        break;
      case 'rest':
        if (!on('SaveGame', 'bSaveOnRest')) return;
        break;
      case 'pause': {
        if (!on('Main', 'bSaveOnPause')) return;
        const minutes = ini.lookup('SaveGame', 'fAutosaveEveryXMins') ?? 15;
        if (performance.now() - this.#lastSave < minutes * 60_000) return;
        break;
      }
    }
    try {
      // It waits for the menus open that do not allow saving (the map still on the stack as
      // its fast travel ends): the original autosaves once they have closed.
      await this.#session.menuStack.whenSavingAllowed();
      await this.save('autosave');
    } catch (error) {
      this.#terminal.log(
        'save',
        `the autosave failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }

  /**
   * Game.RequestSave / RequestAutoSave: the save manager keeps the request (one of each kind)
   * and makes the save once the game may save (menus that forbid saving closed, no place
   * loading, chargen's no-saving over), as the original queues it for its save manager. A game
   * replaced meanwhile drops it.
   */
  async requested(kind: 'save' | 'autosave'): Promise<void> {
    if (this.#requests.has(kind)) return;
    this.#requests.add(kind);
    const runtime = this.#session.scriptsReady;
    try {
      while (this.#session.scriptsReady === runtime && runtime && !runtime.retired) {
        await this.#session.menuStack.whenSavingAllowed();
        if (this.canSave) {
          await this.save(kind);
          return;
        }
        await new Promise((resume) => setTimeout(resume, REQUEST_RETRY_MS));
      }
    } catch (error) {
      this.#terminal.log(
        'save',
        `the requested ${kind} failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    } finally {
      this.#requests.delete(kind);
    }
  }

  /** A save read back for loading (undefined: no such save). */
  async read(name: string): Promise<{ header: SaveHeader; save: GameSave } | undefined> {
    const bytes = await (await this.#open()).read(name);
    if (!bytes) return undefined;
    const read = await readGameSave(bytes);
    this.#lastSave = performance.now();
    return read;
  }

  /**
   * Imports an original save (.ess) as a new save of ours (ess-import.ts): it is then listed
   * and loaded as any other. What could not be imported is logged. Resolves to its name.
   */
  async importEss(bytes: Uint8Array, world: EssWorld): Promise<string> {
    const store = await this.#open();
    const saves = await store.list();
    const number = saves.reduce((most, save) => Math.max(most, save.number), 0) + 1;
    const ess = readEss(bytes);
    const name = `Imported ${ess.header.playerName} ${String(ess.header.saveNumber)}`;
    const imported = importEss(ess, world, { name, number, now: Date.now() });
    for (const what of imported.skipped)
      this.#terminal.log('save', `not imported: ${what}`, 'warn');
    await store.write(
      await writeSave({
        header: imported.header,
        thumbnail: new Uint8Array(),
        body: imported.save,
      }),
    );
    this.#terminal.log('save', `imported ${name} from the original's save`, 'ok');
    return name;
  }

  /** The most recent save's name (Continue, the reload after death). */
  async latest(): Promise<string | undefined> {
    return (await this.list())[0]?.name;
  }

  async delete(name: string): Promise<void> {
    await (await this.#open()).delete(name);
  }
}
