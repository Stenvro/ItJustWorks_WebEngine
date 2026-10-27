// The plugin screen on the main menu: every plugin in Data, which ones are active and in what
// order (the original's Plugins.txt, which the browser cannot reach), plus the player's own
// Skyrim.ini and SkyrimPrefs.ini imported as copies. Applying stores the list and mounts the game
// again, so the load order, the archives and the settings follow it. The game's own plugins
// (implicit masters, Skyrim.ccc's Creations) are always active in their fixed places.
// See docs/formats/load-order.md.

import { formatModIndex } from '../vfs/load-order.ts';
import {
  formatPluginsTxt,
  movePlugin,
  parsePluginsTxt,
  pluginScreenList,
  type PluginScreenEntry,
} from '../vfs/plugin-list.ts';
import {
  pickTextFile,
  saveUserFile,
  type UserFileKey,
  type UserFiles,
} from '../vfs/browser/user-files.ts';
import { asciiLowerCase } from '../formats/text.ts';
import type { Vfs } from '../vfs/vfs.ts';
import type { Terminal } from './terminal.ts';

export interface PluginScreenElements {
  readonly title: HTMLElement;
  readonly list: HTMLOListElement;
  readonly apply: HTMLButtonElement;
  readonly importPlugins: HTMLButtonElement;
  readonly importIni: HTMLButtonElement;
  readonly importPrefs: HTMLButtonElement;
  readonly forgetIni: HTMLButtonElement;
  readonly note: HTMLElement;
}

export class PluginScreen {
  readonly #ui: PluginScreenElements;
  readonly #terminal: Terminal;
  /** Mounts the game again with the stored files. */
  readonly #remount: () => Promise<void>;
  #vfs: Vfs | undefined;
  #files: UserFiles = {};
  #list: readonly PluginScreenEntry[] = [];
  #dirty = false;

  constructor(ui: PluginScreenElements, terminal: Terminal, remount: () => Promise<void>) {
    this.#ui = ui;
    this.#terminal = terminal;
    this.#remount = remount;
    this.#onClick(ui.apply, () => this.#apply());
    this.#onClick(ui.importPlugins, async () => {
      const text = await pickTextFile('.txt');
      if (text === undefined) return;
      this.#list = this.#screenList(text);
      const active = parsePluginsTxt(text).filter((entry) => entry.active).length;
      this.#terminal.log('esm', `plugins.txt imported: ${String(active)} active`);
      this.#changed();
    });
    this.#onClick(ui.importIni, () => this.#importIni('skyrimIni', 'Skyrim.ini'));
    this.#onClick(ui.importPrefs, () => this.#importIni('skyrimPrefsIni', 'SkyrimPrefs.ini'));
    this.#onClick(ui.forgetIni, async () => {
      await saveUserFile('skyrimIni', undefined);
      await saveUserFile('skyrimPrefsIni', undefined);
      this.#files = { ...this.#files, skyrimIni: undefined, skyrimPrefsIni: undefined };
      this.#terminal.log('ini', 'imported INI files forgotten');
      this.#changed();
    });
  }

  /** Shows the mounted game's plugins with the files it was mounted with. */
  show(vfs: Vfs, files: UserFiles): void {
    this.#vfs = vfs;
    this.#files = files;
    this.#list = this.#screenList(files.pluginsTxt);
    this.#dirty = false;
    this.#render();
  }

  #screenList(pluginsTxt: string | undefined): readonly PluginScreenEntry[] {
    return pluginScreenList({
      present: this.#vfs?.plugins.map((plugin) => plugin.name) ?? [],
      ccc: this.#vfs?.creationClubList,
      pluginsTxt,
    });
  }

  #onClick(button: HTMLButtonElement, action: () => Promise<void> | void): void {
    button.addEventListener('click', () => {
      Promise.resolve(action()).catch((error: unknown) => {
        this.#terminal.log('err', error instanceof Error ? error.message : String(error), 'error');
      });
    });
  }

  async #importIni(key: UserFileKey, name: string): Promise<void> {
    const text = await pickTextFile('.ini');
    if (text === undefined) return;
    await saveUserFile(key, text);
    this.#files = { ...this.#files, [key]: text };
    this.#terminal.log('ini', `${name} imported (read only; the original file is not changed)`);
    this.#changed();
  }

  #changed(): void {
    this.#dirty = true;
    this.#render();
  }

  async #apply(): Promise<void> {
    const text = formatPluginsTxt(this.#list);
    await saveUserFile('pluginsTxt', text);
    this.#files = { ...this.#files, pluginsTxt: text };
    this.#dirty = false;
    this.#render();
    await this.#remount();
  }

  #render(): void {
    const vfs = this.#vfs;
    if (!vfs) return;
    const loaded = new Map(vfs.loadOrder.map((entry) => [asciiLowerCase(entry.name), entry]));
    const mastersOf = new Map(
      vfs.plugins.map((plugin) => [asciiLowerCase(plugin.name), plugin.masters ?? []]),
    );
    const active = this.#list.filter((entry) => entry.active).length;
    this.#ui.title.textContent = `plugins · ${String(active)} of ${String(this.#list.length)} active`;
    this.#ui.list.replaceChildren(
      ...this.#list.map((entry, index) => {
        const key = asciiLowerCase(entry.name);
        const li = document.createElement('li');
        li.className = 'plugin-row';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = entry.active;
        check.disabled = entry.fixed;
        check.title = entry.fixed ? 'loaded by the game itself' : 'active';
        check.addEventListener('change', () => {
          this.#list = this.#list.map((other, i) =>
            i === index ? { ...other, active: check.checked } : other,
          );
          this.#changed();
        });

        const loadedEntry = this.#dirty ? undefined : loaded.get(key);
        const modIndex = document.createElement('span');
        modIndex.className = 'key';
        modIndex.textContent = loadedEntry ? formatModIndex(loadedEntry) : '--';

        const name = document.createElement('span');
        name.className = 'value';
        name.textContent = entry.name;
        const masters = mastersOf.get(key) ?? [];
        if (masters.length > 0) name.title = `masters: ${masters.join(', ')}`;

        const meta = document.createElement('span');
        meta.className = 'meta';
        const refused = this.#dirty ? undefined : vfs.refused.get(key);
        meta.textContent = refused ?? (entry.fixed ? 'game' : '');
        if (refused !== undefined) li.classList.add('plugin-refused');

        const move = (delta: number, label: string): HTMLButtonElement => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plugin-move';
          button.textContent = label;
          button.disabled = movePlugin(this.#list, index, delta) === this.#list;
          button.addEventListener('click', () => {
            this.#list = movePlugin(this.#list, index, delta);
            this.#changed();
          });
          return button;
        };

        li.append(check, modIndex, name, meta, move(-1, '↑'), move(1, '↓'));
        return li;
      }),
    );
    this.#ui.apply.disabled = !this.#dirty;
    const inis = [
      this.#files.skyrimIni !== undefined ? 'Skyrim.ini' : undefined,
      this.#files.skyrimPrefsIni !== undefined ? 'SkyrimPrefs.ini' : undefined,
    ].filter((name) => name !== undefined);
    this.#ui.forgetIni.hidden = inis.length === 0;
    const settings = [
      'Skyrim_Default.ini',
      ...inis.map((name) => `your ${name}`),
      ...vfs.pluginInis,
    ].join(' < ');
    const pending = this.#dirty ? 'Changed: apply to load the game with them. ' : '';
    this.#ui.note.textContent = `${pending}INI: ${settings}`;
  }
}
