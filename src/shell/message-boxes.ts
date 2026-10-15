// The game's message boxes: interface\messagebox.swf, for Debug.MessageBox and Message.Show
// (a message's text and its buttons). One shows at a time, the rest wait their turn. The engine
// opens the menu with its extensions and platform, then sends its text (setMessageText(text,
// html)), whether it may be cancelled (setIsCancellable(cancellable, cancelIndex): Esc or Tab
// press that button) and its buttons (setButtons(focusFirst, ...labels): the first takes the
// focus); the menu answers buttonPress(index) and closes. The game is in menu mode while one is
// open. Notes: docs/ui.md.

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { GameSettings } from '../world/game-settings.ts';

/** The message box's depth among the menus (over the HUD and the game's other menus). */
const MESSAGE_BOX_DEPTH = 8;
/** The movie's buttons, in order. */
const BUTTONS = '_root.MessageMenu.MessageButtons';

interface Pending {
  readonly text: string;
  readonly buttons: readonly string[];
  readonly resolve: (index: number) => void;
}

export class MessageBoxes {
  readonly #host: MenuHost;
  readonly #settings: Promise<GameSettings>;
  /** Called as a box opens; returns what ends its menu mode. */
  readonly #enterMenuMode: () => () => void;
  readonly #queue: Pending[] = [];
  #showing = false;
  #menu: Menu | undefined;

  constructor(host: MenuHost, settings: Promise<GameSettings>, enterMenuMode: () => () => void) {
    this.#host = host;
    this.#settings = settings;
    this.#enterMenuMode = enterMenuMode;
  }

  /**
   * Shows a message box; resolves to the button pressed (0 for a box without buttons of its
   * own, which shows the game's "Ok", sOk).
   */
  show(text: string, buttons: readonly string[] = []): Promise<number> {
    return new Promise((resolve) => {
      this.#queue.push({ text, buttons, resolve });
      if (!this.#showing) void this.#next();
    });
  }

  /** Closes the box showing (Play ends); those waiting resolve to their first button. */
  close(): void {
    for (const pending of this.#queue.splice(0)) pending.resolve(0);
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
  }

  async #next(): Promise<void> {
    const pending = this.#queue.shift();
    if (!pending) {
      this.#showing = false;
      return;
    }
    this.#showing = true;
    const settings = await this.#settings;
    const buttons = pending.buttons.length > 0 ? pending.buttons : [settings.string('sOk') ?? 'Ok'];
    const leaveMenuMode = this.#enterMenuMode();
    let answered = false;
    const answer = (index: number): void => {
      if (answered) return;
      answered = true;
      if (this.#menu) this.#host.close(this.#menu);
      this.#menu = undefined;
      leaveMenuMode();
      pending.resolve(index);
      void this.#next();
    };
    const cancellable = buttons.length === 1;
    this.#menu = await this.#host.open('messagebox.swf', {
      depth: MESSAGE_BOX_DEPTH,
      interactive: true,
      // The engine's keys (the movie's own CLIK input does not reach its buttons in Ruffle):
      // Enter and E press the focused button, the arrows move the focus, Esc and Tab cancel a
      // box that may be cancelled.
      onKey: (menu, event) => {
        if (event.repeat) return false;
        const focused = focusedButton(menu, buttons.length);
        if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'KeyE') {
          answer(focused);
          return true;
        }
        if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
          const step = event.code === 'ArrowLeft' ? -1 : 1;
          focusButton(menu, (focused + step + buttons.length) % buttons.length);
          return true;
        }
        if (event.code === 'Escape' || event.code === 'Tab') {
          if (cancellable) answer(0);
          return true;
        }
        return false;
      },
      handlers: {
        buttonPress: (_menu, args) => {
          answer(typeof args[1] === 'number' ? args[1] : 0);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        menu.call('setMessageText', pending.text, false);
        // A box with one button closes by Esc (or Tab) as by that button (inferred: the game's
        // single-button boxes close so).
        menu.call('setIsCancellable', cancellable, 0);
        menu.call('setButtons', true, ...buttons);
      },
    });
  }
}

/** The buttons (MessageMenu.MessageButtons): which has the focus (its `focused`), else the first. */
function focusedButton(menu: Menu, count: number): number {
  for (let i = 0; i < count; i++) {
    const focused = menu.get(`${BUTTONS}.${String(i)}.focused`);
    if (focused === true || (typeof focused === 'number' && focused > 0)) return i;
  }
  return 0;
}

/** Moves the focus to a button, as the movie's arrows would (its selection indicator follows). */
function focusButton(menu: Menu, index: number): void {
  const target = menu.get(`${BUTTONS}.${String(index)}._target`);
  if (typeof target !== 'string') return;
  // The button's focus plays its sound (UIMenuFocus) as the movie's own does.
  menu.invoke('Selection.setFocus', `_level0${target.replaceAll('/', '.')}`);
}
