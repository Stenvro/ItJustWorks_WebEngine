// Play: the game as the game is, from its own main menu (interface\startmenu.swf) on. The
// menus play in the menu host over the 3D view; what they ask of the engine is answered here.
// The main menu shows over its 3D background (the mist menu, mist-menu.ts).
// TODO(M9): New Game into the opening, the HUD and the in-game menus.

import type { Renderer } from '../render/renderer.ts';
import { IniSettings } from '../world/ini-settings.ts';
import { InterfaceFiles } from '../ui/interface-files.ts';
import { MistMenu } from './mist-menu.ts';
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
  properties[3] = false; // PRESS ANY BUTTON first: not here, the menu opens on its list
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

  readonly #renderer: Renderer;
  #mist: MistMenu | undefined;

  constructor(session: GameSession, renderer: Renderer, layer: HTMLElement, terminal: Terminal) {
    this.#renderer = renderer;
    this.#session = session;
    const log = (message: string): void => {
      terminal.log('ui', message);
    };
    const ini = new IniSettings(session.vfs.defaultIni);
    this.#host = new MenuHost(layer, new InterfaceFiles(session.vfs, log), log, {
      x: ini.number('Interface', 'fSafeZoneX'),
      y: ini.number('Interface', 'fSafeZoneY'),
      xWide: ini.number('Interface', 'fSafeZoneXWide'),
      yWide: ini.number('Interface', 'fSafeZoneYWide'),
    });
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
    const mist = MistMenu.show(this.#session, this.#renderer).then((menu) => {
      this.#mist = menu;
    });
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
      // As the game opens it: its extensions, its entries, its platform, then it fades in.
      setup: async (menu) => {
        await menu.waitFor('_root.MenuHolder.Menu_mc.InitExtensions');
        menu.invoke('_root.MenuHolder.Menu_mc.InitExtensions');
        // TODO(M12): saves (Continue, Load).
        menu.call('sendMenuProperties', ...mainMenuProperties(false));
        // The platform: PC with keyboard and mouse (PLATFORM_PC_KBMOUSE 0; no PS3 button swap).
        menu.invoke('_root.MenuHolder.Menu_mc.SetPlatform', 0, false);
        // The delete-save hint (and the version beside it) only with saves to delete.
        menu.invoke('_root.MenuHolder.Menu_mc.ShowDeleteButtonHelp', false);
        menu.call('FadeInMenu');
      },
    });
    await mist;
  }

  stop(): void {
    this.#mist?.hide();
    this.#mist = undefined;
    this.#host.dispose();
    this.#startMenu = undefined;
  }

  get session(): GameSession {
    return this.#session;
  }
}
