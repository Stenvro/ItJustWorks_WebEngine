// The game's launcher, as SkyrimSELauncher.exe stands before the game: Play, Options, Exit.
// Options keeps what the launcher writes to SkyrimPrefs.ini: whether the game runs in a window
// or full screen, and the detail preset. The prefs live in the browser's storage (per player,
// as the INI lives in the player's documents); storage that is unavailable leaves the
// defaults. TODO(M13): the detail presets and the Advanced settings (detail, view distance,
// water) applied by the renderer; it draws at Ultra for now.

import { iniValue, type Ini } from '../formats/ini/ini.ts';

/** What the launcher's Options keep (SkyrimPrefs.ini). */
export interface LauncherPrefs {
  /** [Display] bFull Screen off: a window (the page as it is) instead of full screen. */
  readonly windowed: boolean;
  /** The detail preset the Options' Detail buttons choose. */
  readonly detail: 'low' | 'medium' | 'high' | 'ultra';
}

const STORAGE_KEY = 'itjw.SkyrimPrefs';
const DEFAULT_PREFS: LauncherPrefs = { windowed: false, detail: 'ultra' };

function hasStoredPrefs(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function loadPrefs(): LauncherPrefs {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return DEFAULT_PREFS;
    const value = JSON.parse(text) as Partial<LauncherPrefs>;
    return {
      windowed: typeof value.windowed === 'boolean' ? value.windowed : DEFAULT_PREFS.windowed,
      detail:
        value.detail === 'low' ||
        value.detail === 'medium' ||
        value.detail === 'high' ||
        value.detail === 'ultra'
          ? value.detail
          : DEFAULT_PREFS.detail,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: LauncherPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not kept: the game still runs with them this time.
  }
}

export interface LauncherUi {
  readonly panel: HTMLElement;
  readonly play: HTMLButtonElement;
  readonly options: HTMLButtonElement;
  readonly exit: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  readonly windowed: HTMLInputElement;
  readonly detail: HTMLElement;
  readonly adapter: HTMLElement;
  readonly ok: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

export class Launcher {
  readonly #ui: LauncherUi;
  #prefs = loadPrefs();
  /** Play pressed (a user gesture: full screen may be asked for here). */
  onPlay: ((prefs: LauncherPrefs) => void) | undefined;
  onExit: (() => void) | undefined;

  constructor(ui: LauncherUi, adapter: string) {
    this.#ui = ui;
    ui.adapter.textContent = adapter;
    ui.play.addEventListener('click', () => {
      this.onPlay?.(this.#prefs);
    });
    ui.exit.addEventListener('click', () => {
      this.onExit?.();
    });
    ui.options.addEventListener('click', () => {
      this.#showOptions();
    });
    ui.cancel.addEventListener('click', () => {
      ui.dialog.close();
    });
    ui.ok.addEventListener('click', () => {
      this.#prefs = {
        windowed: ui.windowed.checked,
        detail: this.#chosenDetail(),
      };
      savePrefs(this.#prefs);
      ui.dialog.close();
    });
    for (const button of ui.detail.querySelectorAll<HTMLButtonElement>('button[data-detail]')) {
      button.addEventListener('click', () => {
        for (const other of ui.detail.querySelectorAll('button[data-detail]')) {
          other.classList.toggle('chosen', other === button);
        }
      });
    }
  }

  /**
   * The player's INI settings (an imported SkyrimPrefs.ini) where the launcher's Options were
   * never saved here: [Display] bFull Screen 0 runs the game in a window.
   */
  useIni(ini: Ini): void {
    if (hasStoredPrefs()) return;
    const fullScreen = iniValue(ini, 'Display', 'bFull Screen');
    if (fullScreen === undefined) return;
    this.#prefs = { ...this.#prefs, windowed: Number.parseInt(fullScreen, 10) === 0 };
  }

  get prefs(): LauncherPrefs {
    return this.#prefs;
  }

  show(): void {
    this.#ui.panel.hidden = false;
    this.#ui.play.focus();
  }

  hide(): void {
    this.#ui.panel.hidden = true;
    if (this.#ui.dialog.open) this.#ui.dialog.close();
  }

  #showOptions(): void {
    this.#ui.windowed.checked = this.#prefs.windowed;
    for (const button of this.#ui.detail.querySelectorAll<HTMLButtonElement>(
      'button[data-detail]',
    )) {
      button.classList.toggle('chosen', button.dataset.detail === this.#prefs.detail);
    }
    this.#ui.dialog.showModal();
  }

  #chosenDetail(): LauncherPrefs['detail'] {
    const chosen =
      this.#ui.detail.querySelector<HTMLButtonElement>('button.chosen')?.dataset.detail;
    return chosen === 'low' || chosen === 'medium' || chosen === 'high' || chosen === 'ultra'
      ? chosen
      : this.#prefs.detail;
  }
}
