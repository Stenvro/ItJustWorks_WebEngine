// Play: the game as the game is, from its own main menu (interface\startmenu.swf) on. The
// menus play in the menu host over the 3D view; what they ask of the engine is answered here.
// TODO(M9): the main menu's 3D logo, New Game into the opening, the HUD and the in-game menus.

import { InterfaceFiles } from '../ui/interface-files.ts';
import { MenuHost, type Menu } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/** The game's menu depths (higher over lower). */
const DEPTH = {
  hud: 2,
  startMenu: 10,
} as const;

export class PlayMode {
  readonly #session: GameSession;
  readonly #host: MenuHost;
  #startMenu: Menu | undefined;
  /** Leaving Play (Quit to Desktop): back to the engine's own main menu. */
  onQuit: (() => void) | undefined;

  constructor(session: GameSession, layer: HTMLElement, terminal: Terminal) {
    this.#session = session;
    const log = (message: string): void => {
      terminal.log('ui', message);
    };
    this.#host = new MenuHost(layer, new InterfaceFiles(session.vfs, log), log);
  }

  /** The main menu while it is open (dev checks). */
  get startMenu(): Menu | undefined {
    return this.#startMenu;
  }

  get host(): MenuHost {
    return this.#host;
  }

  /** Opens the game's main menu. */
  async start(): Promise<void> {
    this.#startMenu = await this.#host.open('startmenu.swf', {
      depth: DEPTH.startMenu,
      interactive: true,
      handlers: {
        // The menus' own debug lines; the game drops them.
        myLog: () => undefined,
        QuitToDesktop: () => {
          this.onQuit?.();
        },
      },
    });
  }

  stop(): void {
    this.#host.dispose();
    this.#startMenu = undefined;
  }

  get session(): GameSession {
    return this.#session;
  }
}
