// The credits (the main menu's CREDITS: it fades out and calls OpenCreditsMenu). The movie
// (interface\creditsmenu.swf) scrolls a text up the screen; it asks a code object the engine
// fills (_root.CodeObj, then _root.onCodeObjectInit) for the text (requestCredits(text field,
// second text field): the file [Interface] sCreditsFile names, Interface\Credits.txt, as HTML),
// the speed (getScrollSpeed: pixels a frame) and to close (closeMenu: at the end, a click,
// Tab or Esc). The second field takes text the first has no room for; here the first holds it
// all; its logos are left out (src/ui/credits-text.ts). Notes: docs/ui.md ("Credits").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { decodeGameText } from '../formats/text.ts';
import { creditsHtml } from '../ui/credits-text.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** [Interface] sCreditsFile. */
const CREDITS_FILE = 'interface\\credits.txt';
/**
 * The scroll speed (pixels of the 720-high stage a frame at the movie's 30 frames a second):
 * not among the settings. TODO(M13): the engine's.
 */
const SCROLL_SPEED = 1;

export class CreditsMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /** Opens the credits; `closed` once they have closed. */
  async open(depth: number, closed: () => void): Promise<Menu> {
    const vfs = this.#session.vfs;
    let text = '';
    if (vfs.has(CREDITS_FILE)) text = creditsHtml(decodeGameText(await vfs.read(CREDITS_FILE)));
    else this.#terminal.log('ui', `${CREDITS_FILE} is missing`, 'warn');
    let done = false;
    return this.#host.open('creditsmenu.swf', {
      depth,
      interactive: true,
      handlers: {
        requestCredits: (menu, args) => {
          const first = menu.reference(args[0]);
          if (first) menu.set(`${first}.htmlText`, text);
        },
        getScrollSpeed: () => SCROLL_SPEED,
        closeMenu: (menu) => {
          if (done) return;
          done = true;
          this.#host.close(menu);
          closed();
        },
      },
      setup: async (menu) => {
        if (!(await menu.waitFor('_root.onCodeObjectInit'))) return;
        menu.tellPlatform('_root.SetPlatform');
        menu.native('_root.CodeObj', ['requestCredits', 'getScrollSpeed', 'closeMenu']);
        menu.invoke('_root.onCodeObjectInit');
      },
    });
  }
}
