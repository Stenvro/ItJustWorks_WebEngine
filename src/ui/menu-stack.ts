// The engine's menu manager (the UI singleton): the menus open now, by name, bottom to top, each
// with its menu flags, as every IMenu carries them (CommonLibSSE's IMenu::Flag, the flags each
// vanilla menu's constructor sets). What the flags say is asked of the stack as a whole: whether
// the game is paused (a menu that pauses it is open), the frame frozen, the cursor used, the
// pause menu kept shut, and whether the game may be saved now. The HUD's part: each menu has the
// HUD mode it puts hudmenu.swf in (ShowElements: the movie's own element lists say what shows in
// it; BookMode and WorldMapMode keep the messages and notices, JournalMode shows nothing), or
// hides the HUD outright (the skills, the race menu, lockpicking).
//
// Menus opening and closing are told to the stack's listeners (MenuOpenCloseEvent), and a mod
// registers its own menus by name with their flags (UI::Register), so scripts may ask for them
// (SKSE's UI.IsMenuOpen). Platform-independent. Notes: docs/ui.md.

/** IMenu::Flag (CommonLibSSE). */
export const MenuFlag = {
  pausesGame: 1 << 0,
  alwaysOpen: 1 << 1,
  usesCursor: 1 << 2,
  usesMenuContext: 1 << 3,
  /** Keeps the menus under it from advancing. */
  modal: 1 << 4,
  freezeFrameBackground: 1 << 5,
  onStack: 1 << 6,
  disablePauseMenu: 1 << 7,
  requiresUpdate: 1 << 8,
  topmostRenderedMenu: 1 << 9,
  updateUsesCursor: 1 << 10,
  allowSaving: 1 << 11,
  rendersOffscreenTargets: 1 << 12,
  inventoryItemMenu: 1 << 13,
  dontHideCursorWhenTopmost: 1 << 14,
  customRendering: 1 << 15,
  assignCursorToRenderer: 1 << 16,
  applicationMenu: 1 << 17,
  hasButtonBar: 1 << 18,
  isTopButtonBar: 1 << 19,
  advancesUnderPauseMenu: 1 << 20,
  rendersUnderPauseMenu: 1 << 21,
  usesBlurredBackground: 1 << 22,
  companionAppAllowed: 1 << 23,
  freezeFramePause: 1 << 24,
  skipRenderDuringFreezeFrameScreenshot: 1 << 25,
  largeScaleformRenderCacheMode: 1 << 26,
  usesMovementToDirection: 1 << 27,
} as const;

/** The vanilla menus' names (each menu's MENU_NAME). */
export const MenuName = {
  barter: 'BarterMenu',
  book: 'Book Menu',
  console: 'Console',
  container: 'ContainerMenu',
  crafting: 'Crafting Menu',
  credits: 'Credits Menu',
  cursor: 'Cursor Menu',
  dialogue: 'Dialogue Menu',
  fader: 'Fader Menu',
  favorites: 'FavoritesMenu',
  gift: 'GiftMenu',
  hud: 'HUD Menu',
  inventory: 'InventoryMenu',
  journal: 'Journal Menu',
  levelUp: 'LevelUp Menu',
  loading: 'Loading Menu',
  lockpicking: 'Lockpicking Menu',
  magic: 'MagicMenu',
  main: 'Main Menu',
  map: 'MapMenu',
  messageBox: 'MessageBoxMenu',
  mist: 'Mist Menu',
  raceSex: 'RaceSex Menu',
  sleepWait: 'Sleep/Wait Menu',
  stats: 'StatsMenu',
  training: 'Training Menu',
  tutorial: 'Tutorial Menu',
  tween: 'TweenMenu',
} as const;

/** What a kind of menu is: its flags and what it does to the HUD. */
export interface MenuKind {
  readonly flags: number;
  /** The HUD mode it puts hudmenu.swf in while open (ShowElements). */
  readonly hudMode?: string;
  /** The HUD steps aside entirely while it is open. */
  readonly hidesHud?: boolean;
}

const F = MenuFlag;

/**
 * The vanilla menus. The flags are CommonLibSSE's records of each constructor's. The HUD modes
 * are the movie's (hudmenu.swf's mode names); which menu takes which is the engine's.
 * TODO(M13): the crafting menu's HUD mode is not recorded: InventoryMode, whose elements (the
 * messages and notices) the skill increases of crafting need.
 */
export const VANILLA_MENUS: Readonly<Record<string, MenuKind>> = {
  [MenuName.barter]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.disablePauseMenu |
      F.updateUsesCursor |
      F.inventoryItemMenu |
      F.customRendering,
    hudMode: 'BarterMode',
  },
  [MenuName.book]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.disablePauseMenu |
      F.requiresUpdate |
      F.topmostRenderedMenu |
      F.rendersOffscreenTargets,
    hudMode: 'BookMode',
  },
  [MenuName.console]: { flags: F.pausesGame | F.alwaysOpen | F.usesCursor | F.allowSaving },
  [MenuName.container]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.disablePauseMenu |
      F.updateUsesCursor |
      F.inventoryItemMenu |
      F.customRendering,
    hudMode: 'InventoryMode',
  },
  [MenuName.crafting]: {
    flags:
      F.usesMenuContext |
      F.disablePauseMenu |
      F.updateUsesCursor |
      F.inventoryItemMenu |
      F.dontHideCursorWhenTopmost,
    hudMode: 'InventoryMode',
  },
  [MenuName.credits]: { flags: F.pausesGame, hidesHud: true },
  [MenuName.cursor]: { flags: F.allowSaving | F.customRendering },
  [MenuName.dialogue]: {
    flags: F.updateUsesCursor | F.dontHideCursorWhenTopmost,
    hudMode: 'DialogueMode',
  },
  [MenuName.fader]: { flags: F.alwaysOpen | F.allowSaving | F.customRendering },
  [MenuName.favorites]: {
    flags: F.pausesGame | F.updateUsesCursor | F.inventoryItemMenu | F.customRendering,
  },
  [MenuName.gift]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.disablePauseMenu |
      F.updateUsesCursor |
      F.inventoryItemMenu |
      F.customRendering,
    hudMode: 'BarterMode',
  },
  [MenuName.hud]: {
    flags:
      F.alwaysOpen |
      F.requiresUpdate |
      F.allowSaving |
      F.customRendering |
      F.assignCursorToRenderer,
  },
  [MenuName.inventory]: {
    flags:
      F.pausesGame |
      F.disablePauseMenu |
      F.updateUsesCursor |
      F.inventoryItemMenu |
      F.customRendering,
    hudMode: 'InventoryMode',
  },
  [MenuName.journal]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.freezeFrameBackground |
      F.requiresUpdate |
      F.topmostRenderedMenu |
      F.updateUsesCursor |
      F.allowSaving,
    hudMode: 'JournalMode',
  },
  [MenuName.levelUp]: { flags: F.pausesGame | F.modal | F.disablePauseMenu },
  [MenuName.loading]: {
    flags: F.pausesGame | F.alwaysOpen | F.allowSaving | F.applicationMenu,
    hidesHud: true,
  },
  [MenuName.lockpicking]: {
    flags: F.pausesGame | F.disablePauseMenu | F.requiresUpdate,
    hidesHud: true,
  },
  [MenuName.magic]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.disablePauseMenu |
      F.updateUsesCursor |
      F.inventoryItemMenu |
      F.customRendering,
    hudMode: 'InventoryMode',
  },
  [MenuName.main]: {
    flags:
      F.pausesGame | F.disablePauseMenu | F.requiresUpdate | F.updateUsesCursor | F.applicationMenu,
    hidesHud: true,
  },
  [MenuName.map]: {
    flags: F.pausesGame | F.usesCursor | F.rendersOffscreenTargets | F.customRendering,
    hudMode: 'WorldMapMode',
  },
  [MenuName.messageBox]: { flags: F.pausesGame | F.alwaysOpen | F.usesCursor | F.modal },
  [MenuName.mist]: { flags: F.disablePauseMenu | F.allowSaving | F.dontHideCursorWhenTopmost },
  [MenuName.raceSex]: {
    flags:
      F.pausesGame |
      F.usesMenuContext |
      F.requiresUpdate |
      F.topmostRenderedMenu |
      F.updateUsesCursor,
    hidesHud: true,
  },
  [MenuName.sleepWait]: {
    flags: F.pausesGame | F.requiresUpdate | F.allowSaving | F.applicationMenu,
  },
  [MenuName.stats]: {
    flags:
      F.pausesGame | F.usesMenuContext | F.disablePauseMenu | F.requiresUpdate | F.customRendering,
    hidesHud: true,
  },
  [MenuName.training]: { flags: F.pausesGame | F.usesMenuContext | F.updateUsesCursor },
  [MenuName.tutorial]: { flags: F.pausesGame | F.modal | F.updateUsesCursor },
  [MenuName.tween]: {
    flags:
      F.pausesGame |
      F.updateUsesCursor |
      F.allowSaving |
      F.dontHideCursorWhenTopmost |
      F.customRendering,
    hudMode: 'TweenMode',
  },
};

/** A menu opened or closed (MenuOpenCloseEvent). */
export interface MenuOpenClose {
  readonly name: string;
  readonly opening: boolean;
  readonly kind: MenuKind;
}

interface OpenMenu {
  readonly name: string;
  readonly kind: MenuKind;
}

export class MenuStack {
  /** The kinds of menu by name (lower case): the vanilla ones and those registered. */
  readonly #kinds = new Map<string, OpenMenu>();
  /** The menus open, bottom to top. */
  readonly #open: OpenMenu[] = [];
  /** Told as each menu opens and closes, after the stack changed. */
  readonly listeners = new Set<(event: MenuOpenClose) => void>();

  constructor() {
    for (const [name, kind] of Object.entries(VANILLA_MENUS)) this.register(name, kind);
  }

  /** A kind of menu by name (a mod's own: UI::Register); replaces one of the same name. */
  register(name: string, kind: MenuKind): void {
    this.#kinds.set(name.toLowerCase(), { name, kind });
  }

  /** The kind of a menu, if one of that name is known. */
  kind(name: string): MenuKind | undefined {
    return this.#kinds.get(name.toLowerCase())?.kind;
  }

  /** A menu opens on top (false: no such menu, or it is open already). */
  open(name: string): boolean {
    const known = this.#kinds.get(name.toLowerCase());
    if (!known || this.isOpen(name)) return false;
    this.#open.push(known);
    this.#tell({ name: known.name, opening: true, kind: known.kind });
    return true;
  }

  /** A menu closes, wherever it is in the stack (false: it was not open). */
  close(name: string): boolean {
    const key = name.toLowerCase();
    const at = this.#open.findIndex((menu) => menu.name.toLowerCase() === key);
    if (at < 0) return false;
    const [menu] = this.#open.splice(at, 1);
    if (menu) this.#tell({ name: menu.name, opening: false, kind: menu.kind });
    return true;
  }

  /** Opens a menu; returns what closes it again (once; nothing if it did not open). */
  hold(name: string): () => void {
    if (!this.open(name)) return () => undefined;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.close(name);
    };
  }

  isOpen(name: string): boolean {
    const key = name.toLowerCase();
    return this.#open.some((menu) => menu.name.toLowerCase() === key);
  }

  /** The menus open, bottom to top. */
  get names(): string[] {
    return this.#open.map((menu) => menu.name);
  }

  /** The menu on top, if any. */
  get top(): string | undefined {
    return this.#open.at(-1)?.name;
  }

  /** Whether an open menu has every flag of `flags`. */
  any(flags: number): boolean {
    return this.#open.some((menu) => (menu.kind.flags & flags) === flags);
  }

  /** A menu that pauses the game is open (the world stands still: menu mode). */
  get pausesGame(): boolean {
    return this.any(MenuFlag.pausesGame);
  }

  /** The world's last frame is kept behind a menu (the journal). */
  get freezesFrame(): boolean {
    return this.any(MenuFlag.freezeFrameBackground);
  }

  /** The cursor shows: a menu uses it. */
  get usesCursor(): boolean {
    return this.any(MenuFlag.usesCursor) || this.any(MenuFlag.updateUsesCursor);
  }

  /** The pause menu does not open over these (Esc closes them instead). */
  get pauseMenuDisabled(): boolean {
    return this.any(MenuFlag.disablePauseMenu);
  }

  /**
   * Whether the game may be saved now: every menu open allows saving (the journal's system page,
   * the tween menu, the sleep and wait menu; not an item menu, a book, the map, a conversation).
   * TODO(M13): the engine counts the open menus that allow saving (UI::IsSavingAllowed); how it
   * weighs those that do not is not recorded.
   */
  get savingAllowed(): boolean {
    return this.#open.every((menu) => (menu.kind.flags & MenuFlag.allowSaving) !== 0);
  }

  /** An open menu hides the HUD entirely. */
  get hidesHud(): boolean {
    return this.#open.some((menu) => menu.kind.hidesHud === true);
  }

  #tell(event: MenuOpenClose): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** What the HUD is told as a menu opens or closes: its mode, and whether it shows at all. */
export interface HudMenuSink {
  mode(name: string, on: boolean): void;
  shown(on: boolean): void;
}

/** The HUD follows the stack: each menu's mode on and off with it; hidden while one hides it. */
export function followWithHud(stack: MenuStack, hud: HudMenuSink): () => void {
  let hidden = false;
  const listener = (event: MenuOpenClose): void => {
    if (event.kind.hudMode !== undefined) hud.mode(event.kind.hudMode, event.opening);
    if (stack.hidesHud !== hidden) {
      hidden = stack.hidesHud;
      hud.shown(!hidden);
    }
  };
  stack.listeners.add(listener);
  return () => stack.listeners.delete(listener);
}
