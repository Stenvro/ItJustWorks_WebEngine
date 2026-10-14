// Play: the game as the game is, from its own main menu (interface\startmenu.swf) on. The
// menus play in the menu host over the 3D view; what they ask of the engine is answered here.
// TODO(M9): the main menu's 3D logo, New Game into the opening, the HUD and the in-game menus.

import { InterfaceFiles } from '../ui/interface-files.ts';
import { MenuHost, type Menu } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

/**
 * The main menu's properties, as its setupMainMenu reads them (sendMenuProperties' arguments
 * by index): the PC game's.
 */
function mainMenuProperties(hasSaves: boolean): unknown[] {
  const properties: unknown[] = [];
  properties[0] = true; // QUIT shown
  properties[1] = hasSaves; // CONTINUE shown, LOAD enabled
  properties[2] = undefined; // the version text ("v " + it); none: the engine reads no exe
  properties[3] = false; // PRESS START first (consoles)
  // TODO(M9): the Anniversary upgrade banner (shown only to some players; not decided yet).
  properties[4] = false;
  properties[5] = false; // DOWNLOADABLE CONTENT (consoles)
  properties[6] = false; // HELP (not on PC)
  properties[7] = false; // MOD MANAGER: merged into Creations since 1.6.1130 (UESP)
  properties[8] = true; // CREATIONS shown
  properties[9] = true; // logged in: no Bethesda.net login screen
  properties[10] = false;
  properties[11] = false; // PS5 data transfer
  properties[12] = false; // new Creations
  // Creations can be used: an online store, never reached from localhost (hard rule 4).
  properties[13] = false;
  properties[14] = false; // Switch data transfer
  return properties;
}

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
    // As the game opens it: its extensions, then its entries, then it fades in.
    const menu = this.#startMenu;
    await menu.waitFor('_root.MenuHolder.Menu_mc.InitExtensions');
    menu.invoke('_root.MenuHolder.Menu_mc.InitExtensions');
    // TODO(M12): saves (Continue, Load).
    menu.call('sendMenuProperties', ...mainMenuProperties(false));
    menu.call('FadeInMenu');
  }

  stop(): void {
    this.#host.dispose();
    this.#startMenu = undefined;
  }

  get session(): GameSession {
    return this.#session;
  }
}
