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
import { inventoryModel } from './inventory-menu.ts';
import { magicModel } from './magic-menu.ts';
import { ItemMenu, type ItemMenuModel } from './item-menu.ts';
import { FavoritesMenu } from './favorites-menu.ts';
import { noWaitReason, SleepWaitMenu } from './sleep-wait-menu.ts';
import { TrainingMenu } from './training-menu.ts';
import { LevelUpMenu } from './level-up-menu.ts';
import { containerModel } from './container-menu.ts';
import { barterModel } from './barter-menu.ts';
import { giftModel } from './gift-menu.ts';
import type { MenuRequest } from '../scripting/runtime/runtime.ts';
import { BookMenu, type BookToRead } from './book-menu.ts';
import { LockpickingMenu } from './lockpicking-menu.ts';
import { SkillsMenu } from './skills-menu.ts';
import { BookFlag, parseItem } from '../world/item-records.ts';
import { MapMenu } from './map-menu.ts';
import { TutorialMenu } from './tutorial-menu.ts';
import { CraftingMenu } from './crafting-menu.ts';
import type { TweenCamera } from './tween-camera.ts';
import type { CraftingMenuType } from '../gameplay/crafting.ts';
import type { LocalMapContent } from './local-map.ts';

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

/** What the menus ask of the world being played. */
export interface MenusWorld {
  /** The player is off the ground (falling, jumping). */
  inAir(): boolean;
  /** A message box with buttons; resolves with the button chosen. */
  confirm(text: string, buttons: readonly string[]): Promise<number>;
  /** The player's heading (radians, clockwise from north); undefined out of the world. */
  heading(): number | undefined;
  /** The player's tween menu camera (undefined out of the world). */
  tweenCamera(): TweenCamera | undefined;
  /** What the map's local map shows where the player is. */
  localMap(): LocalMapContent | undefined;
  /** Why the player may not fast travel now (a setting's name), if they may not. */
  noFastTravelReason(): Promise<string | undefined>;
  /** Fast travel to a reference, `distance` away on the map (the time it takes). */
  fastTravel(destination: number, distance: number | undefined): Promise<void>;
}

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
  readonly #items: ItemMenu;
  readonly #inventory: ItemMenuModel;
  readonly #magic: ItemMenuModel;
  readonly #favorites: FavoritesMenu;
  readonly #sleepWait: SleepWaitMenu;
  readonly #training: TrainingMenu;
  readonly #levelUp: LevelUpMenu;
  readonly #world: MenusWorld;
  readonly #books: BookMenu;
  readonly #lockpicking: LockpickingMenu;
  readonly #skills: SkillsMenu;
  readonly #map: MapMenu;
  /** The tutorials of the menus, the first time each opens. */
  readonly #tutorials: TutorialMenu;
  readonly #crafting: CraftingMenu;
  /** Show on Map chosen in the journal: the map opens on this reference as the journal closes. */
  #mapFocus: number | undefined;
  /** A book open (over the world, or over the inventory it was read from). */
  #reading: { close(): void } | undefined;

  constructor(
    host: MenuHost,
    session: GameSession,
    terminal: Terminal,
    enterMenuMode: () => () => void,
    world: MenusWorld,
  ) {
    this.#world = world;
    this.#tutorials = new TutorialMenu(host, session, terminal, enterMenuMode);
    this.#sleepWait = new SleepWaitMenu(host, session, terminal);
    this.#training = new TrainingMenu(host, session, terminal);
    this.#levelUp = new LevelUpMenu(host, session, terminal);
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#enterMenuMode = enterMenuMode;
    this.#journal = new JournalMenu(host, session, terminal);
    this.#journal.onShowOnMap = (reference) => {
      this.#mapFocus = reference;
    };
    this.#items = new ItemMenu(host, session, terminal);
    this.#books = new BookMenu(host, session, terminal);
    this.#lockpicking = new LockpickingMenu(host, session, terminal);
    this.#skills = new SkillsMenu(host, session, terminal, (text, buttons) =>
      world.confirm(text, buttons),
    );
    this.#map = new MapMenu(host, session, terminal, {
      heading: () => world.heading(),
      localMap: () => world.localMap(),
      confirm: (text, buttons) => world.confirm(text, buttons),
      noFastTravelReason: () => world.noFastTravelReason(),
      fastTravel: (marker, distance) => world.fastTravel(marker, distance),
      openJournal: () => {
        this.openMenu('Journal');
      },
    });
    this.#inventory = inventoryModel(session, terminal, (book) => this.#readFromInventory(book));
    this.#magic = magicModel(session, terminal);
    this.#favorites = new FavoritesMenu(host, session, this.#inventory, this.#magic);
    this.#crafting = new CraftingMenu(host, session, terminal, {
      confirm: (text, buttons) => world.confirm(text, buttons),
      notify: (text) => {
        session.hud.notification(text);
      },
    });
  }

  /** Quit to the main menu (false) or to the desktop (true), from the journal's system page. */
  set onQuit(quit: ((toDesktop: boolean) => void) | undefined) {
    this.#journal.onQuit = quit;
  }

  /** Whether one of these menus is open. */
  get isOpen(): boolean {
    return this.#open !== undefined;
  }

  /**
   * A gameplay user event the player pressed: the menu it opens, if any (none while open).
   * While scripts keep the menus from the player (DisablePlayerControls' abMenu) only the
   * journal opens (its tabs the scripts' too: abJournalTabs).
   */
  userEvent(name: string): void {
    const menu = EVENT_MENUS[name.toLowerCase()];
    if (menu === undefined || this.#open || this.#session.menuMode || this.#session.loading) return;
    const controls = this.#session.scriptsReady?.controls;
    if (controls?.menu === false && menu !== 'Pause' && menu !== 'Journal') return;
    this.openMenu(menu);
  }

  /** Opens one of the game's menus by name ("Tween", "Journal", "Inventory", ...). */
  openMenu(name: string): void {
    const opening =
      name === 'Tween'
        ? this.#openTween()
        : name === 'Journal' || name === 'Pause'
          ? this.#openJournal(name === 'Pause' ? JournalPage.system : undefined)
          : name === 'Inventory' || name === 'Magic'
            ? this.#openItems(name === 'Inventory' ? this.#inventory : this.#magic)
            : name === 'Favorites'
              ? this.#openFavorites()
              : name === 'Wait'
                ? this.#openSleepWait(false)
                : name === 'Skills' && (this.#session.scriptsReady?.state.levelUps ?? 0) > 0
                  ? this.#openLevelUp()
                  : name === 'Skills'
                    ? this.#openSkills(false)
                    : name === 'Map'
                      ? this.#openMap()
                      : (() => {
                          if (!this.#missing.has(name)) {
                            this.#missing.add(name);
                            this.#terminal.log('ui', `there is no ${name} menu`, 'warn');
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

  /**
   * A container's menu (a chest opened, a corpse searched); `closed` once it has closed (at
   * once if another menu is open).
   */
  openContainer(reference: number, closed: () => void): void {
    if (this.#open || this.#session.menuMode) {
      closed();
      return;
    }
    this.#openItems(containerModel(this.#session, reference, this.#inventory), closed).catch(
      (error: unknown) => {
        this.#terminal.log(
          'ui',
          `the container menu does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        this.#closeOpen();
      },
    );
  }

  /**
   * A menu a script opens (OpenInventory, ShowBarterMenu, ShowGiftMenu); resolves once it has
   * closed, with what it returns (ShowGiftMenu's favor points: TODO(M11), 0).
   */
  async openScripted(request: MenuRequest): Promise<number> {
    if (this.#open || this.#session.menuMode) return 0;
    const session = this.#session;
    if (request.name === 'Training Menu') {
      return request.actor === undefined ? 0 : this.#openTraining(request.actor);
    }
    let model: ItemMenuModel | undefined;
    switch (request.name) {
      case 'Container Menu':
        model = containerModel(session, request.actor, this.#inventory, true);
        break;
      case 'Barter Menu':
        model = await barterModel(session, this.#terminal, request.actor);
        this.#tutorial('HBBR');
        break;
      case 'Gift Menu':
        model = await giftModel(session, request.actor, request);
        break;
      default:
        // TODO(M9): the race menu.
        this.#terminal.log('ui', `the ${request.name} is not built yet`, 'warn');
        return 0;
    }
    const opened = model;
    return new Promise((resolve) => {
      this.#openItems(opened, () => {
        resolve(0);
      }).catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the ${request.name} does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        this.#closeOpen();
        resolve(0);
      });
    });
  }

  /** The training menu for a trainer; resolves once it has closed. */
  async #openTraining(trainer: number): Promise<number> {
    const open = { menu: undefined as Menu | undefined, leave: this.#enterMenuMode() };
    this.#open = open;
    return new Promise((resolve) => {
      const closed = (): void => {
        if (this.#open === open) {
          this.#open = undefined;
          open.leave();
        }
        resolve(0);
      };
      this.#training
        .open(trainer, MENU_DEPTH, closed)
        .then((menu) => {
          if (!menu) closed();
          else if (this.#open !== open) this.#host.close(menu);
          else open.menu = menu;
        })
        .catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `the training menu does not open: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
          closed();
        });
    });
  }

  /** A level-up waiting: the player picks an attribute, then the skills menu opens. */
  async #openLevelUp(): Promise<void> {
    const open = { menu: undefined as Menu | undefined, leave: this.#enterMenuMode() };
    this.#open = open;
    open.menu = await this.#levelUp.open(MENU_DEPTH, (chose) => {
      if (this.#open !== open) return;
      this.#open = undefined;
      open.leave();
      if (!chose) return;
      this.#openSkills(true).catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the skills menu does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        this.#closeOpen();
      });
    });
    if (this.#open !== open) this.#host.close(open.menu);
  }

  /**
   * The skills menu (after levelling up: `levelUp`), the HUD hidden; it closes after its
   * camera's outro.
   */
  async #openSkills(levelUp: boolean): Promise<void> {
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
    const opened = await this.#skills.open(levelUp, () => {
      if (this.#open !== open) return;
      this.#open = undefined;
      open.leave();
    });
    if (!opened) {
      if (this.#open === open) this.#closeOpen();
      return;
    }
    if (this.#open !== open) opened.close();
    else {
      open.menu = opened.menu;
      this.#tutorial(levelUp ? 'HBLU' : 'HBSK');
    }
  }

  /** The map, the HUD hidden; the world map's 3D in place of the world while it is open. */
  async #openMap(focus?: number): Promise<void> {
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
    const opened = await this.#map.open(
      MENU_DEPTH,
      () => {
        if (this.#open !== open) return;
        this.#open = undefined;
        open.leave();
      },
      focus,
    );
    if (!opened) {
      if (this.#open === open) this.#closeOpen();
      return;
    }
    if (this.#open !== open) opened.close();
    else {
      this.#tutorial('HBMM');
      open.menu = opened.menu;
      // Closed from outside (Play ends): the map gives the world back.
      open.leave = () => {
        opened.close();
        hud.shown(true);
        leaveMenuMode();
      };
    }
  }

  /** Sleeping in a bed: the sleep menu (rest how long?). */
  sleep(): void {
    if (this.#open || this.#session.menuMode) return;
    this.#openSleepWait(true).catch((error: unknown) => {
      this.#terminal.log(
        'ui',
        `the sleep menu does not open: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      this.#closeOpen();
    });
  }

  /**
   * The wait (or sleep) menu, unless the player may not wait now: then the game's message
   * says why.
   */
  async #openSleepWait(sleeping: boolean): Promise<void> {
    const session = this.#session;
    const reason = noWaitReason(sleeping, {
      waitingDisabled: session.scriptsReady?.chargen.noWaiting === true,
      inAir: this.#world.inAir(),
    });
    if (reason) {
      const settings = await session.settings();
      session.hud.notification(settings.string(reason) ?? '');
      return;
    }
    const open = { menu: undefined as Menu | undefined, leave: this.#enterMenuMode() };
    this.#open = open;
    open.menu = await this.#sleepWait.open(sleeping, MENU_DEPTH, () => {
      if (this.#open !== open) return;
      this.#open = undefined;
      open.leave();
    });
    if (this.#open !== open) this.#host.close(open.menu);
  }

  /**
   * A book lying in the world, read (its activation): the book menu, the HUD hidden. TODO(M10):
   * not in combat (sCanNotReadBook).
   */
  readBook(read: BookToRead): void {
    if (this.#open || this.#reading || this.#session.menuMode) return;
    const hud = this.#session.hud;
    hud.shown(false);
    this.#read(read, () => {
      hud.shown(true);
    });
  }

  /**
   * A book read from the inventory (its Read, or a spell tome's Learn): a spell tome teaches its
   * spell and is used up (UISpellLearned, sAddItemtoSpellList; sAlreadyKnown when it is
   * known); another book opens over the inventory, which comes back as it closes.
   */
  async #readFromInventory(book: number): Promise<void> {
    if (this.#reading) return;
    const session = this.#session;
    const runtime = session.scriptsReady;
    const record = runtime && (await runtime.forms.record(book));
    const item = record && parseItem(record);
    if (!runtime || !item?.book) return;
    if ((item.book.flags & BookFlag.teachesSpell) !== 0) {
      const settings = await session.settings();
      const spell = item.book.teaches;
      const name = (await runtime.forms.record(spell))?.text('FULL') ?? '';
      if (!(await runtime.actors.addSpell(PLAYER_REF, spell))) {
        session.hud.notification(`${settings.string('sAlreadyKnown') ?? ''} ${name}`);
        return;
      }
      await runtime.removeItem(PLAYER_REF, runtime.formHandle(book), 1, true, undefined);
      void session.sounds().then((sounds) => sounds.playNamed('UISpellLearned', undefined));
      session.hud.notification(`${name} ${settings.string('sAddItemtoSpellList') ?? ''}`);
      return;
    }
    const under = this.#open?.menu;
    if (under) under.shown = false;
    this.#read({ book }, () => {
      if (under) {
        under.shown = true;
        under.focus();
      }
    });
  }

  /** Opens the book menu, in menu mode while it is open. */
  #read(read: BookToRead, closed: () => void): void {
    const leave = this.#enterMenuMode();
    const reading: { close: () => void } = {
      close: () => {
        // Not open yet.
      },
    };
    this.#reading = reading;
    const done = (): void => {
      if (this.#reading === reading) this.#reading = undefined;
      leave();
      closed();
    };
    this.#books
      .open(read, done)
      .then((open) => {
        if (!open) done();
        else if (this.#reading === reading) {
          reading.close = () => {
            open.close();
          };
        } else open.close();
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the book menu does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        done();
      });
  }

  /** Picking a lock (the lockpicking menu), the HUD hidden. */
  pickLock(reference: number): void {
    if (this.#open || this.#reading || this.#session.menuMode) return;
    const hud = this.#session.hud;
    hud.shown(false);
    const leave = this.#enterMenuMode();
    const open = { menu: undefined as Menu | undefined, leave: () => undefined as unknown };
    const closed = (): void => {
      if (this.#open === open) this.#open = undefined;
      hud.shown(true);
      leave();
    };
    open.leave = closed;
    this.#open = open;
    this.#lockpicking
      .open(reference, closed)
      .then((picking) => {
        if (!picking) closed();
        else if (this.#open !== open) picking.close();
        else {
          open.menu = picking.menu;
          this.#tutorial('HBLK');
        }
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the lockpicking menu does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        closed();
      });
  }

  /**
   * A workbench used (the crafting menu), the HUD hidden. TODO(M10): the player sits at it
   * (its furniture markers) first and gets up after.
   */
  craft(reference: number, base: number): void {
    if (this.#open || this.#reading || this.#session.menuMode) return;
    const hud = this.#session.hud;
    hud.shown(false);
    const leave = this.#enterMenuMode();
    const open = { menu: undefined as Menu | undefined, leave: () => undefined as unknown };
    const closed = (): void => {
      if (this.#open === open) this.#open = undefined;
      hud.shown(true);
      leave();
    };
    open.leave = closed;
    this.#open = open;
    this.#crafting
      .open(reference, base, closed)
      .then(async (crafting) => {
        if (!crafting) closed();
        else if (this.#open !== open) this.#host.close(crafting.menu);
        else {
          open.menu = crafting.menu;
          const use = await this.#craftingTutorial(crafting.type, base);
          if (use) this.#tutorial(use);
        }
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the crafting menu does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        closed();
      });
  }

  /**
   * A workbench's first-use help (DOBJ): the grindstone HBSM, the armor workbench HBSA,
   * enchanting HBEC, alchemy HBAL; of the constructible ones by their keyword: forges HBFG,
   * cooking pots HBCO, smelters HBML, tanning racks HBTA.
   */
  async #craftingTutorial(type: CraftingMenuType, base: number): Promise<string | undefined> {
    if (type.kind === 'smithing') return type.improves === 'ARMO' ? 'HBSA' : 'HBSM';
    if (type.kind === 'enchanting') return 'HBEC';
    if (type.kind === 'alchemy') return 'HBAL';
    const bench = await this.#crafting.workbench(base);
    const runtime = this.#session.scriptsReady;
    if (!bench || !runtime) return undefined;
    for (const keyword of bench.bench.keywords) {
      const id = (await runtime.forms.record(keyword))?.editorId?.toLowerCase() ?? '';
      if (id.includes('forge')) return 'HBFG';
      if (id.includes('cookpot') || id.includes('cooking')) return 'HBCO';
      if (id.includes('smelter')) return 'HBML';
      if (id.includes('tanningrack')) return 'HBTA';
    }
    return undefined;
  }

  /** Closes the menu open (Play ends). */
  close(): void {
    this.#reading?.close();
    this.#closeOpen();
  }

  #closeOpen(): void {
    const open = this.#open;
    this.#open = undefined;
    if (open?.menu) this.#host.close(open.menu);
    open?.leave();
  }

  /**
   * An item menu (inventory, magic), the HUD aside; it closes itself after its fade (CloseMenu),
   * back to the tween menu if the player went there.
   */
  async #openItems(model: ItemMenuModel, closed?: () => void): Promise<void> {
    const leaveMenuMode = this.#enterMenuMode();
    const hud = this.#session.hud;
    hud.shown(false);
    const open = {
      menu: undefined as Menu | undefined,
      leave: () => {
        hud.shown(true);
        leaveMenuMode();
        closed?.();
      },
    };
    this.#open = open;
    open.menu = await this.#items.open(model, (toTween) => {
      if (this.#open !== open) return;
      this.#open = undefined;
      open.leave();
      if (toTween) this.openMenu('Tween');
    });
    if (this.#open !== open) this.#host.close(open.menu);
  }

  /** The favorites menu, over the game (the HUD stays); it closes after its fade (FadeDone). */
  async #openFavorites(): Promise<void> {
    const open = { menu: undefined as Menu | undefined, leave: this.#enterMenuMode() };
    this.#open = open;
    open.menu = await this.#favorites.open(() => {
      if (this.#open !== open) return;
      this.#open = undefined;
      open.leave();
    }, MENU_DEPTH);
    if (this.#open !== open) this.#host.close(open.menu);
    else this.#tutorial('HBFS');
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
        const focus = this.#mapFocus;
        this.#mapFocus = undefined;
        if (focus !== undefined) {
          this.#openMap(focus).catch((error: unknown) => {
            this.#terminal.log(
              'ui',
              `the map does not open: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
            this.#closeOpen();
          });
        }
      },
      MENU_DEPTH,
    );
    if (this.#open !== open) this.#host.close(open.menu);
    else this.#tutorial('HBJL');
  }

  /** A menu's tutorial over it, the first time (src/shell/tutorial-menu.ts). */
  #tutorial(use: string): void {
    void this.#tutorials.show(use);
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
    // The view leans and zooms while it is open (the tween camera), and goes back as it closes.
    const camera = this.#world.tweenCamera();
    camera?.open();
    const open = {
      menu: undefined as Menu | undefined,
      leave: () => {
        camera?.close();
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
    const levelUp = (runtime?.state.levelUps ?? 0) > 0;
    let chosen: TweenChoice | undefined;
    open.menu = await this.#host.open('tweenmenu.swf', {
      depth: MENU_DEPTH,
      interactive: true,
      handlers: {
        // The movie plays no sounds; highlighting has none of the engine's either.
        HighlightMenu: (_menu, args) => {
          camera?.highlight(typeof args[1] === 'number' ? args[1] : 0);
        },
        OpenAnimFinished: () => undefined,
        OpenHighlightedMenu: (_menu, args) => {
          chosen = TWEEN_CHOICES[typeof args[1] === 'number' ? args[1] : 0];
          if (chosen === 'None') chosen = undefined;
          // The engine's choosing sound (UITweenSelectSD: silence in the vanilla data).
          if (chosen) {
            void session.sounds().then((sounds) => sounds.playNamed('UITweenSelectSD', undefined));
          }
          // The tween goes at once; the menu chosen takes its place.
          this.#closeOpen();
          if (chosen) this.openMenu(chosen);
        },
        StartCloseMenu: (menu) => {
          camera?.close();
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
        // TODO(M11): the progress (the experience toward the next level).
        menu.call('StartOpenMenuAnim', levelUp, date, String(level), 0);
      },
    });
    if (this.#open !== open) this.#host.close(open.menu);
  }
}
