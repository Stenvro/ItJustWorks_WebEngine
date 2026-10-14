// The game's menus the player opens as they play (Play): the tween menu (Tab: the way to the
// skills, magic, items and map), and from it or by their own keys the menus behind it. The
// control map's gameplay events open them (Tween Menu, Journal, Pause, Quick Inventory, Quick
// Magic, Quick Stats, Quick Map, Favorites, Wait); each pauses the game (menu mode) while open.
// One of these is open at a time. Notes: docs/ui.md.

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { formatGameDate } from '../world/game-time.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';
import { JournalMenu, JournalPage } from './journal-menu.ts';
import { InventoryMenu } from './inventory-menu.ts';

/** The menus' depth among the game's menus (over the HUD, under message boxes). */
const MENU_DEPTH = 6;

/** The tween menu's choices (its FrameToLabelMap: 1 up, 2 left, 3 right, 4 down). */
const TWEEN_CHOICES = ['None', 'Skills', 'Magic', 'Inventory', 'Map'] as const;
type TweenChoice = (typeof TWEEN_CHOICES)[number];

/** The menus by the gameplay event that opens each. */
const EVENT_MENUS: Readonly<Record<string, string>> = {
  'tween menu': 'Tween',
  journal: 'Journal',
  pause: 'Pause',
  'quick inventory': 'Inventory',
  'quick magic': 'Magic',
  'quick stats': 'Skills',
  'quick map': 'Map',
  favorites: 'Favorites',
  wait: 'Wait',
};

export class GameMenus {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  /** Called as a menu opens; returns what ends its menu mode. */
  readonly #enterMenuMode: () => () => void;
  /** The menu open (or opening), if any. */
  #open: { menu: Menu | undefined; leave: () => void } | undefined;
  readonly #missing = new Set<string>();
  readonly #journal: JournalMenu;
  readonly #inventory: InventoryMenu;

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
    this.#journal = new JournalMenu(host, session, terminal);
    this.#inventory = new InventoryMenu(host, session, terminal);
    this.#inventory.onTween = () => {
      this.openMenu('Tween');
    };
  }

  /** Quit to the main menu (false) or to the desktop (true), from the journal's system page. */
  set onQuit(quit: ((toDesktop: boolean) => void) | undefined) {
    this.#journal.onQuit = quit;
  }

  /** Whether one of these menus is open. */
  get isOpen(): boolean {
    return this.#open !== undefined;
  }

  /** A gameplay user event the player pressed: the menu it opens, if any (none while open). */
  userEvent(name: string): void {
    const menu = EVENT_MENUS[name.toLowerCase()];
    if (menu === undefined || this.#open || this.#session.menuMode) return;
    this.openMenu(menu);
  }

  /** Opens one of the game's menus by name ("Tween", "Journal", "Inventory", ...). */
  openMenu(name: string): void {
    const opening =
      name === 'Tween'
        ? this.#openTween()
        : name === 'Journal' || name === 'Pause'
          ? this.#openJournal(name === 'Pause' ? JournalPage.system : undefined)
          : name === 'Inventory'
            ? this.#openInventory()
            : (() => {
                // TODO(M9): the inventory, magic, skills, map, favorites and wait menus.
                if (!this.#missing.has(name)) {
                  this.#missing.add(name);
                  this.#terminal.log('ui', `the ${name} menu is not built yet`, 'warn');
                }
                return Promise.resolve();
              })();
    opening.catch((error: unknown) => {
      this.#terminal.log(
        'ui',
        `the ${name} menu does not open: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      this.#closeOpen();
    });
  }

  /** Closes the menu open (Play ends). */
  close(): void {
    this.#closeOpen();
  }

  #closeOpen(): void {
    const open = this.#open;
    this.#open = undefined;
    if (open?.menu) this.#host.close(open.menu);
    open?.leave();
  }

  /** The inventory, the HUD aside; it closes itself after its fade (CloseMenu). */
  async #openInventory(): Promise<void> {
    const leaveMenuMode = this.#enterMenuMode();
    const hud = this.#session.hud;
    hud.shown(false);
    const open = {
      menu: undefined as Menu | undefined,
      leave: () => {
        hud.shown(true);
        leaveMenuMode();
      },
    };
    this.#open = open;
    open.menu = await this.#inventory.open(() => {
      if (this.#open !== open) return;
      this.#open = undefined;
      open.leave();
    });
    if (this.#open !== open) this.#host.close(open.menu);
  }

  /** The journal: on the system page for Pause, else on the page it was left on. */
  async #openJournal(page: number | undefined): Promise<void> {
    const leaveMenuMode = this.#enterMenuMode();
    const hud = this.#session.hud;
    hud.shown(false);
    const open = {
      menu: undefined as Menu | undefined,
      leave: () => {
        hud.shown(true);
        leaveMenuMode();
      },
    };
    this.#open = open;
    open.menu = await this.#journal.open(
      page,
      () => {
        if (this.#open !== open) return;
        // The journal closed itself (its menu is gone): only menu mode ends.
        this.#open = undefined;
        open.leave();
      },
      MENU_DEPTH,
    );
    if (this.#open !== open) this.#host.close(open.menu);
  }

  /**
   * The tween menu: it opens with its animation and the bottom bar (the date, the player's
   * level and progress); the player picks a menu (a direction, or a click) or closes it (Tab,
   * Esc: its close animation, then CloseMenu).
   */
  async #openTween(): Promise<void> {
    const leaveMenuMode = this.#enterMenuMode();
    const hud = this.#session.hud;
    hud.mode('TweenMode', true);
    const open = {
      menu: undefined as Menu | undefined,
      leave: () => {
        hud.mode('TweenMode', false);
        leaveMenuMode();
      },
    };
    this.#open = open;
    const session = this.#session;
    const runtime = session.scriptsReady;
    const settings = await session.settings();
    const date = runtime
      ? formatGameDate(runtime.date, runtime.dayOfWeek, runtime.gameHour, (name) =>
          settings.string(name),
        )
      : '';
    const level = runtime ? await runtime.actors.level(PLAYER_REF) : 1;
    let chosen: TweenChoice | undefined;
    open.menu = await this.#host.open('tweenmenu.swf', {
      depth: MENU_DEPTH,
      interactive: true,
      handlers: {
        // TODO(M9): the sounds of highlighting and choosing (UITweenSelect, ...).
        HighlightMenu: () => undefined,
        OpenAnimFinished: () => undefined,
        OpenHighlightedMenu: (_menu, args) => {
          chosen = TWEEN_CHOICES[typeof args[1] === 'number' ? args[1] : 0];
          if (chosen === 'None') chosen = undefined;
          // The tween goes at once; the menu chosen takes its place.
          this.#closeOpen();
          if (chosen) this.openMenu(chosen);
        },
        StartCloseMenu: (menu) => {
          menu.call('StartCloseMenuAnim');
        },
        CloseMenu: () => {
          if (this.#open === open) this.#closeOpen();
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0, false);
        // (abLevelUp, the date, the level, the progress to the next level 0..100).
        // TODO(M11): leveling up (its experience and the level-up prompt).
        menu.call('StartOpenMenuAnim', false, date, String(level), 0);
      },
    });
    if (this.#open !== open) this.#host.close(open.menu);
  }
}
