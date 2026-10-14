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
    this.#menu = await this.#host.open('messagebox.swf', {
      depth: MESSAGE_BOX_DEPTH,
      interactive: true,
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
        menu.call('setIsCancellable', buttons.length === 1, 0);
        menu.call('setButtons', true, ...buttons);
      },
    });
  }
}
