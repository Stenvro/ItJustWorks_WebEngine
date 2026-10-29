// The spinner the original shows while its save manager works (interface\loadwaitspinner.swf,
// the LoadWaitSpinner menu: always open and saving allowed, depth 10; it listens to the save
// manager's events): the icon turns in the screen's bottom right corner while a save is
// written. The movie's root InitExtensions locks the icon to the corner; Menu_mc.FadeInMenu
// and FadeOutMenu play its fades. Notes: docs/ui.md ("The menu stack").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { MenuName, type MenuStack } from '../ui/menu-stack.ts';
import type { Terminal } from './terminal.ts';

/** The original's depth for it: over the loading menu. */
const SPINNER_DEPTH = 10;

/** The movie's fade out (its fadeOut frames), ms, before it closes. */
const FADE_OUT_MS = 500;

export class LoadWaitSpinner {
  readonly #host: MenuHost;
  readonly #stack: MenuStack;
  readonly #terminal: Terminal;
  /** How many waits are under way (each begin until its end). */
  #waiting = 0;
  #menu: Promise<Menu | undefined> | undefined;
  #unstack: (() => void) | undefined;
  #closing: ReturnType<typeof setTimeout> | undefined;

  constructor(host: MenuHost, stack: MenuStack, terminal: Terminal) {
    this.#host = host;
    this.#stack = stack;
    this.#terminal = terminal;
  }

  /** The spinner shows until the returned function is called (once per begin). */
  begin(): () => void {
    this.#waiting++;
    if (this.#closing !== undefined) {
      // Fading out still: it fades in again.
      clearTimeout(this.#closing);
      this.#closing = undefined;
      void this.#menu?.then((opened) => opened?.invoke('_root.Menu_mc.FadeInMenu'));
    }
    this.#unstack ??= this.#stack.hold(MenuName.loadWaitSpinner);
    this.#menu ??= this.#host
      .open('loadwaitspinner.swf', {
        depth: SPINNER_DEPTH,
        interactive: false,
        setup: async (menu) => {
          await menu.waitFor('_root.Menu_mc.InitExtensions');
          menu.invoke('_root.InitExtensions');
          menu.invoke('_root.Menu_mc.FadeInMenu');
        },
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the spinner does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return undefined;
      });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--this.#waiting > 0) return;
      this.#unstack?.();
      this.#unstack = undefined;
      const menu = this.#menu;
      void menu?.then((opened) => {
        if (this.#menu !== menu || this.#waiting > 0) return;
        opened?.invoke('_root.Menu_mc.FadeOutMenu');
        this.#closing = setTimeout(() => {
          this.#closing = undefined;
          if (this.#menu !== menu || this.#waiting > 0) return;
          this.#menu = undefined;
          if (opened) this.#host.close(opened);
        }, FADE_OUT_MS);
      });
    };
  }
}
