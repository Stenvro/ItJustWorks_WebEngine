// SKSE's custom menu (UI.OpenCustomMenu, UI.CloseCustomMenu): a mod's own movie, by its path
// under the interface folder without the extension ("mymod/menu" is interface\mymod\menu.swf),
// shown as the "CustomMenu" of the menu stack. As SKSE makes it: modal and pausing the game,
// at depth 10 in the menu-mode input context, the cursor shown while no gamepad is in use; the
// path is taken as the menu opens, so one open already stays as it is; the movie's PlaySound
// calls play the sound (the host's own handler); the scripts reach its movie by the name
// "CustomMenu" (UI.GetString, UI.Invoke, ...). Notes: docs/ui.md ("The menu stack").

import { CUSTOM_MENU, type MenuStack } from '../ui/menu-stack.ts';

/** What the custom menu asks of the menu host (MenuHost), and of the terminal. */
export interface CustomMenuHost<Movie> {
  open(
    movie: string,
    options: { depth: number; interactive: boolean; cursor: boolean },
  ): Promise<Movie>;
  close(movie: Movie): void;
}
interface Log {
  log(source: string, message: string, level: 'error'): void;
}

/** SKSE's depth for it: over the menus, under the console. */
export const CUSTOM_MENU_DEPTH = 10;

export class CustomMenu<Menu> {
  readonly #host: CustomMenuHost<Menu>;
  readonly #stack: MenuStack;
  readonly #terminal: Log;
  readonly #enterMenuMode: () => () => void;
  readonly #usesCursor: () => boolean;
  /** The menu open (its movie once loaded) and what ends its stack entry and menu mode. */
  #open: { menu: Menu | undefined; leave: () => void; closing: boolean } | undefined;

  constructor(
    host: CustomMenuHost<Menu>,
    stack: MenuStack,
    terminal: Log,
    enterMenuMode: () => () => void,
    usesCursor: () => boolean,
  ) {
    this.#host = host;
    this.#stack = stack;
    this.#terminal = terminal;
    this.#enterMenuMode = enterMenuMode;
    this.#usesCursor = usesCursor;
  }

  get isOpen(): boolean {
    return this.#open !== undefined;
  }

  /** The movie shown, once loaded. */
  get movie(): Menu | undefined {
    return this.#open?.menu;
  }

  /** Opens the movie at `path` (no extension); nothing while the custom menu is open. */
  open(path: string): void {
    if (this.#open || this.#stack.isOpen(CUSTOM_MENU)) return;
    const leaveMenuMode = this.#enterMenuMode();
    const unstack = this.#stack.hold(CUSTOM_MENU);
    const slot = {
      menu: undefined as Menu | undefined,
      closing: false,
      leave: () => {
        unstack();
        leaveMenuMode();
      },
    };
    this.#open = slot;
    const movie = `${path.replace(/\\/g, '/').replace(/^\/+/, '')}.swf`;
    this.#host
      .open(movie, {
        depth: CUSTOM_MENU_DEPTH,
        interactive: true,
        cursor: this.#usesCursor(),
      })
      .then((menu) => {
        slot.menu = menu;
        if (slot.closing) this.#host.close(menu);
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the custom menu ${movie} does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        if (this.#open === slot) this.close();
      });
  }

  /** Closes the custom menu, if open. */
  close(): void {
    const slot = this.#open;
    if (!slot) return;
    this.#open = undefined;
    slot.closing = true;
    if (slot.menu) this.#host.close(slot.menu);
    slot.leave();
  }
}
