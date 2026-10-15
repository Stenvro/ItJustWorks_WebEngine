// The tutorials (interface\tutorialmenu.swf): the first time the player does something the game
// explains (picks a lock, opens the map or the journal, barters, uses a forge ...), a box with
// its help message, until they close it (its Exit button: CloseMenu; Esc, Tab, Enter or E, which
// the engine takes). The messages
// are default objects (DOBJ: HBLK lockpicking, HBMM the world map, HBJL the journal, HBSK the
// skills, HBBR bartering, HBFS favorites, HBFG the forge, ... CommonLib's
// TutorialMenu::OpenTutorialMenu takes such a default object): the message's name is the
// box's title (Menu_mc.HelpTitle), its text the help (Menu_mc.HelpScrollingText.textField),
// whose "[Event]"s become key art (ApplyButtonArt, through GetButtonFromUserEvent). Each shows
// once in a game, and only with [Interface] bShowTutorials. TODO(M12): which were shown, in the
// save. Notes: docs/ui.md ("Tutorials").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** Over the game's menus (the one that brought it), under the message boxes. */
const TUTORIAL_DEPTH = 9;
const ROOT = '_root.Menu_mc';

export class TutorialMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #enterMenuMode: () => () => void;
  #open: Promise<void> | undefined;

  constructor(
    host: MenuHost,
    session: GameSession,
    terminal: Terminal,
    enterMenuMode: () => () => void,
  ) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#enterMenuMode = enterMenuMode;
  }

  /**
   * The tutorial of a default object's use (DOBJ "HBLK", ...), if it has not shown in this game
   * and tutorials are on; resolves once it has closed (at once if it does not show).
   */
  async show(use: string): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime || !session.ini.bool('Interface', 'bShowTutorials')) return;
    const shown = runtime.state.tutorialsShown;
    if (shown.has(use)) return;
    const message = (await session.defaultObjects()).get(use);
    const record = message === undefined ? undefined : await runtime.forms.record(message);
    if (record?.type !== 'MESG') return;
    shown.add(use);
    await this.#open;
    const title = record.text('FULL') ?? '';
    const text = record.text('DESC') ?? '';
    this.#open = this.#show(title, text).catch((error: unknown) => {
      this.#terminal.log(
        'ui',
        `the tutorial does not open: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    });
    return this.#open;
  }

  #show(title: string, text: string): Promise<void> {
    const leave = this.#enterMenuMode();
    return new Promise((resolve, reject) => {
      let done = false;
      const close = (menu: Menu): void => {
        if (done) return;
        done = true;
        this.#host.close(menu);
        // The menu it was over takes the keys again.
        this.#host.focusTop();
        leave();
        resolve();
      };
      this.#host
        .open('tutorialmenu.swf', {
          depth: TUTORIAL_DEPTH,
          interactive: true,
          // The movie takes the Exit button's click; Cancel and Accept (Esc, Tab, Enter, E) are
          // the engine's.
          onKey: (menu, event) => {
            if (!['Escape', 'Tab', 'Enter', 'KeyE'].includes(event.code)) return false;
            if (!event.repeat) close(menu);
            return true;
          },
          handlers: {
            CloseMenu: (menu) => {
              close(menu);
            },
          },
          setup: async (menu) => {
            if (!(await menu.waitFor('_root.InitExtensions'))) return;
            menu.invoke('_root.InitExtensions');
            menu.invoke('_root.SetPlatform', 0, false);
            menu.set(`${ROOT}.HelpTitle.text`, title);
            menu.set(`${ROOT}.HelpScrollingText.textField.text`, text);
            menu.invoke(`${ROOT}.ApplyButtonArt`);
          },
        })
        .catch((error: unknown) => {
          leave();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}
