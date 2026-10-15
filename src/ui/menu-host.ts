// The menus on screen: each of the game's menu movies plays in a Ruffle player of its own (as
// each is a movie of its own under Scaleform), stacked in a layer over the 3D view by depth.
// The host routes what a menu asks of the engine (GameDelegate.call, ExternalInterface.call,
// tagged with the menu by the bridge, src/ui/menu-bridge.ts) to that menu's handlers, and
// lets the engine call into a menu: its GameDelegate callbacks, any function, any variable.
//
// A menu lays itself out for the screen once, as it opens (the game cannot change resolution
// with a menu open). When the window's size changes, each menu is loaded again and set up
// again by its owner (MenuOptions.setup), as the game would after a change of resolution.
// Notes: docs/ui.md.

import { INTERFACE_URL, type InterfaceFiles } from './interface-files.ts';
import {
  BRIDGE_CALL,
  BRIDGE_GET,
  BRIDGE_INVOKE,
  BRIDGE_REFERENCE,
  BRIDGE_REFERENCES,
  BRIDGE_SET,
  BRIDGE_TRANSLATE,
  withBridge,
} from './menu-bridge.ts';
import type { Translations } from '../formats/swf/translation.ts';
import { loadRuffle, type RuffleApi, type RufflePlayerElement } from './ruffle.ts';
import { readSwf } from '../formats/swf/swf.ts';
import { flashKeyCode } from './key-codes.ts';
import { SAFE_ZONE, safeRect, scaleMode, visibleRect, type SafeZone } from './stage-rects.ts';

/**
 * What answers a menu's call to the engine: `args` as the menu passed them (a GameDelegate
 * call's first is its request id, answered with Menu.respond). The return value goes back to
 * the menu as ExternalInterface.call's result.
 */
export type MenuCallHandler = (menu: Menu, args: readonly unknown[]) => unknown;

export interface MenuOptions {
  /** Higher depths are drawn over lower ones (the game's menu depths). */
  readonly depth: number;
  /** Takes mouse and keyboard (menus); the HUD does not. */
  readonly interactive: boolean;
  readonly handlers?: Readonly<Record<string, MenuCallHandler>>;
  /**
   * What the engine does as the menu opens, once its first frame has run (its extensions,
   * its data): run again whenever the menu is loaded again.
   */
  readonly setup?: (menu: Menu) => Promise<void> | void;
  /**
   * Keys the engine handles itself while this is the topmost menu (the item menus' favorite,
   * drop, charge): true takes the key from the movie.
   */
  readonly onKey?: (menu: Menu, event: KeyboardEvent) => boolean;
  /**
   * Keys the movie gets as other keys, by KeyboardEvent.code (the control map's menu mode:
   * Cancel is Tab and Esc, Accept is Enter and E, so Esc reaches a movie as Tab).
   */
  readonly keyAs?: Readonly<Record<string, string>>;
}

/** CLIK's input manager, which every menu built on CLIK reads its keys from. */
const INPUT_DELEGATE = 'gfx.managers.InputDelegate.instance';

/** The page function the bridge calls (checked against the bridge's name at compile time). */
const BRIDGE_GLOBAL: typeof BRIDGE_CALL = '__itjwMenuCall';

/** How long the window's size must rest before the menus are loaded again (ms). */
const RESIZE_SETTLE_MS = 250;

declare global {
  interface Window {
    /** The menus' calls to the engine (BRIDGE_GLOBAL). */
    [BRIDGE_GLOBAL]?: ((menu: string, name: string, ...args: unknown[]) => unknown) | undefined;
  }
}

export class Menu {
  readonly id: string;
  /** The movie, e.g. "hudmenu.swf". */
  readonly movie: string;
  readonly options: MenuOptions;
  /** The INI's safe zone margins. */
  safeZone: SafeZone = SAFE_ZONE;
  /** The movie's stage size in pixels. */
  readonly stageWidth: number;
  readonly stageHeight: number;
  /** The menu's size on screen when it was laid out. */
  laidOut = { width: 0, height: 0 };
  #element: RufflePlayerElement | undefined;
  #api: RuffleApi | undefined;
  readonly #handlers: Map<string, MenuCallHandler>;
  /** What every menu of the host asks (PlaySound, ...), unless the menu answers it itself. */
  readonly #common: ReadonlyMap<string, MenuCallHandler>;
  readonly #unanswered: Set<string>;
  readonly #log: (message: string) => void;
  #closed = false;

  constructor(
    id: string,
    movie: string,
    options: MenuOptions,
    log: (message: string) => void,
    stage: { readonly width: number; readonly height: number },
    common: ReadonlyMap<string, MenuCallHandler> = new Map(),
  ) {
    this.id = id;
    this.movie = movie;
    this.options = options;
    this.stageWidth = stage.width;
    this.stageHeight = stage.height;
    this.#handlers = new Map(Object.entries(options.handlers ?? {}));
    this.#common = common;
    this.#unanswered = new Set();
    this.#log = log;
  }

  get element(): RufflePlayerElement | undefined {
    return this.#element;
  }

  get api(): RuffleApi | undefined {
    return this.#api;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The player the menu plays in now (the host gives it one, and a new one on reloads). */
  attach(element: RufflePlayerElement): void {
    this.#detachPlayer();
    this.#inputDelegate = undefined;
    this.#element = element;
    this.#api = element.ruffle();
  }

  /** Answers a name the menu calls (adds or replaces its handler). */
  handle(name: string, handler: MenuCallHandler): void {
    this.#handlers.set(name, handler);
  }

  /** A call from the menu (through the bridge). */
  received(name: string, args: readonly unknown[]): unknown {
    const handler = this.#handlers.get(name) ?? this.#common.get(name);
    if (handler) return handler(this, args);
    if (!this.#unanswered.has(name)) {
      this.#unanswered.add(name);
      this.#log(`${this.movie} asks ${name}: not answered yet`);
    }
    return undefined;
  }

  /** Whether the movie reads its keys through CLIK's InputDelegate (found once per load). */
  #inputDelegate: boolean | undefined;

  /**
   * A key for the movie as GFx gives it one: through CLIK's InputDelegate ("keyDown",
   * "keyHold", "keyUp" with the Flash key code), which turns it into the menus' input events.
   * False if the movie has no InputDelegate (the page's key then goes to the player itself).
   */
  pressKey(type: 'keyDown' | 'keyHold' | 'keyUp', code: number): boolean {
    this.#inputDelegate ??= this.get(`${INPUT_DELEGATE}.keyRepeatStateLookup`) !== undefined;
    if (!this.#inputDelegate) return false;
    this.invoke(`${INPUT_DELEGATE}.handleKeyPress`, type, code);
    return true;
  }

  /** Whether the movie's focus is on a text field the player types into. */
  get typing(): boolean {
    const focus = this.invoke('Selection.getFocus');
    return typeof focus === 'string' && this.get(`${focus}.type`) === 'input';
  }

  /** Calls a GameDelegate callback of the menu (GameDelegate.addCallBack). */
  call(name: string, ...args: unknown[]): unknown {
    return this.#external('call', name, ...args);
  }

  /** Answers a GameDelegate.call request of the menu. */
  respond(request: unknown, ...values: unknown[]): void {
    this.#external('respond', request, ...values);
  }

  /** Calls a function by its path ("_root.HUDMovieBaseInstance.InitExtensions"). */
  invoke(path: string, ...args: unknown[]): unknown {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return this.#external(BRIDGE_INVOKE, '_root', path, args);
    return this.#external(BRIDGE_INVOKE, path.slice(0, dot), path.slice(dot + 1), args);
  }

  /**
   * The path of an object the menu passed in a call (GFx gives the engine the object itself,
   * e.g. the list RequestQuestsData is to fill); undefined if the argument is no object.
   */
  reference(argument: unknown): string | undefined {
    if (typeof argument !== 'string' || !argument.startsWith(BRIDGE_REFERENCE)) return undefined;
    const index = Number(argument.slice(BRIDGE_REFERENCE.length));
    return Number.isInteger(index) ? `${BRIDGE_REFERENCES}.${String(index)}` : undefined;
  }

  /** An argument's value: an object the menu passed, read through its reference. */
  value(argument: unknown): unknown {
    const path = this.reference(argument);
    return path === undefined ? argument : this.get(path);
  }

  set(path: string, value: unknown): void {
    this.#external(BRIDGE_SET, path, value);
  }

  get(path: string): unknown {
    return this.#external(BRIDGE_GET, path);
  }

  /**
   * Waits until a path exists in the movie (its frames have run that far): true, or false
   * after `timeout` ms or once the menu closed.
   */
  async waitFor(path: string, timeout = 10_000): Promise<boolean> {
    const until = performance.now() + timeout;
    const element = this.#element;
    while (!this.#closed && this.#element === element) {
      const value = this.get(path);
      if (value !== undefined && value !== null) return true;
      if (performance.now() > until) return false;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return false;
  }

  /**
   * Sets Stage.visibleRect and Stage.safeRect for the menu's size on screen, as GFx keeps
   * them (src/ui/stage-rects.ts).
   */
  updateStage(): void {
    const box = this.#element?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const align = this.get('Stage.align');
    const visible = visibleRect(
      this.stageWidth,
      this.stageHeight,
      box.width,
      box.height,
      scaleMode(this.get('Stage.scaleMode')),
      typeof align === 'string' ? align : '',
    );
    this.set('Stage.visibleRect', visible);
    this.set(
      'Stage.safeRect',
      safeRect(visible, box.width / box.height > 4 / 3 + 0.01, this.safeZone),
    );
  }

  /**
   * Puts keyboard focus on the menu (an interactive menu as it opens). The player takes keys
   * only after focus comes to it from outside (Ruffle: a focusin from elsewhere): a menu
   * focused while its player was still starting gets it again.
   */
  focus(): void {
    const element = this.#element;
    if (!element) return;
    if (document.activeElement === element) element.blur();
    element.focus();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachPlayer();
  }

  #detachPlayer(): void {
    const element = this.#element;
    const api = this.#api;
    this.#element = undefined;
    this.#api = undefined;
    // Out of the page first: Ruffle ends a player that leaves the document. Pausing it as well
    // may fail on a player Ruffle has ended; that is no fault of the menu.
    element?.remove();
    try {
      api?.pause();
    } catch {
      // Ended already.
    }
  }

  #external(name: string, ...args: unknown[]): unknown {
    const api = this.#api;
    if (this.#closed || !api) return undefined;
    try {
      return api.callExternalInterface(name, ...args);
    } catch (error) {
      this.#log(
        `${this.movie}: ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}

export class MenuHost {
  readonly #layer: HTMLElement;
  readonly #files: InterfaceFiles;
  readonly #log: (message: string) => void;
  readonly #menus = new Map<string, Menu>();
  readonly #safeZone: SafeZone;
  readonly #common: ReadonlyMap<string, MenuCallHandler>;
  #next = 1;
  /** The interface's translations, for keys the menus set at run time (loaded with the first). */
  #translations: Translations | undefined;
  #stopServing: (() => void) | undefined;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Watches the layer's size (window resizes and full screen alike). */
  readonly #sizeWatch = new ResizeObserver(() => {
    this.#resized();
  });

  constructor(
    layer: HTMLElement,
    files: InterfaceFiles,
    log: (message: string) => void,
    safeZone: SafeZone = SAFE_ZONE,
    /** What every menu may ask (a menu's own handlers come first). */
    common: Readonly<Record<string, MenuCallHandler>> = {},
  ) {
    this.#common = new Map(Object.entries(common));
    this.#layer = layer;
    this.#files = files;
    this.#log = log;
    this.#safeZone = safeZone;
  }

  /** The open menus. */
  get menus(): Iterable<Menu> {
    return this.#menus.values();
  }

  /** Opens a menu movie of the interface folder ("hudmenu.swf"). */
  async open(movie: string, options: MenuOptions): Promise<Menu> {
    this.#start();
    const bytes = await this.#files.read(movie);
    if (!bytes) throw new Error(`interface\\${movie} is missing`);
    const id = `${movie.replace(/\.(swf|gfx)$/i, '')}#${String(this.#next++)}`;
    const { frameSize } = readSwf(bytes).header;
    const menu = new Menu(
      id,
      movie,
      options,
      this.#log,
      {
        width: (frameSize.xMax - frameSize.xMin) / 20,
        height: (frameSize.yMax - frameSize.yMin) / 20,
      },
      this.#common,
    );
    menu.safeZone = this.#safeZone;
    this.#menus.set(id, menu);
    await this.#mount(menu, bytes);
    return menu;
  }

  close(menu: Menu): void {
    menu.close();
    this.#menus.delete(menu.id);
  }

  closeAll(): void {
    for (const menu of [...this.#menus.values()]) this.close(menu);
  }

  /** Puts keyboard focus on the topmost interactive menu. */
  focusTop(): void {
    this.#topInteractive()?.focus();
  }

  dispose(): void {
    this.closeAll();
    this.#stopServing?.();
    this.#stopServing = undefined;
    this.#sizeWatch.disconnect();
    this.#layer.removeEventListener('pointerdown', this.#pointed);
    this.#layer.removeEventListener('keydown', this.#keyed, { capture: true });
    this.#layer.removeEventListener('keyup', this.#keyed, { capture: true });
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    if (window[BRIDGE_GLOBAL] === this.#dispatch) window[BRIDGE_GLOBAL] = undefined;
  }

  /** Loads the menu's movie into a new player in the layer and sets it up. */
  async #mount(menu: Menu, bytes: Uint8Array): Promise<void> {
    const source = await loadRuffle();
    if (menu.closed) return;
    const { options } = menu;
    const element = source.createPlayer();
    element.classList.add('menu-movie');
    element.dataset.menu = menu.id;
    element.style.zIndex = String(options.depth);
    element.style.pointerEvents = options.interactive ? 'auto' : 'none';
    element.tabIndex = options.interactive ? 0 : -1;
    this.#layer.append(element);
    menu.attach(element);
    // The rects the menu starts with: its stage shown whole (showAll, Ruffle's default) on the
    // layer; updateStage corrects them once the menu has set its own scale mode.
    const view = this.#layer.getBoundingClientRect();
    const visible = visibleRect(
      menu.stageWidth,
      menu.stageHeight,
      view.width || menu.stageWidth,
      view.height || menu.stageHeight,
      'showAll',
    );
    const rects = {
      visible,
      safe: safeRect(visible, view.width / view.height > 4 / 3 + 0.01, this.#safeZone),
    };
    menu.laidOut = { width: view.width, height: view.height };
    await element.ruffle().load({
      data: withBridge(bytes, menu.id, rects),
      swfFileName: menu.movie,
      base: INTERFACE_URL,
      allowScriptAccess: true,
      backgroundColor: null,
      wmode: 'transparent',
      letterbox: 'off',
      autoplay: 'on',
      unmuteOverlay: 'hidden',
      splashScreen: false,
      contextMenu: 'off',
      preloader: false,
      openUrlMode: 'deny',
      logLevel: 'warn',
    });
    // Its first frame has run once the bridge has (it runs first in it).
    if (!(await menu.waitFor('_global.gfxExtensions'))) {
      if (menu.element === element) this.#log(`${menu.movie} did not start playing`);
      return;
    }
    menu.updateStage();
    // The player has the page's focus before the menu's setup runs: a movie's
    // Selection.setFocus (a message box's first button) holds only in a player with focus.
    if (options.interactive) menu.focus();
    await options.setup?.(menu);
    if (options.interactive && menu.element === element) menu.focus();
  }

  /** Serves the interface files and receives the menus' calls (once). */
  #start(): void {
    if (this.#stopServing) return;
    this.#stopServing = this.#files.serve();
    void this.#files.translations().then((translations) => {
      this.#translations = translations;
    });
    this.#sizeWatch.observe(this.#layer);
    this.#layer.addEventListener('pointerdown', this.#pointed);
    this.#layer.addEventListener('keydown', this.#keyed, { capture: true });
    this.#layer.addEventListener('keyup', this.#keyed, { capture: true });
    window[BRIDGE_GLOBAL] = this.#dispatch;
  }

  readonly #resized = (): void => {
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      this.relayout();
    }, RESIZE_SETTLE_MS);
  };

  /** Loads again every menu laid out for another size than the layer's now. */
  relayout(): void {
    const view = this.#layer.getBoundingClientRect();
    if (view.width <= 0 || view.height <= 0) return;
    for (const menu of this.#menus.values()) {
      const { width, height } = menu.laidOut;
      if (Math.abs(width - view.width) < 1 && Math.abs(height - view.height) < 1) continue;
      this.#files
        .read(menu.movie)
        .then((bytes) => (bytes ? this.#mount(menu, bytes) : undefined))
        .catch((error: unknown) => {
          this.#log(
            `${menu.movie} could not be loaded again: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  /** Keys the engine took (onKey) while down: their release is the engine's too. */
  readonly #taken = new Set<string>();

  /**
   * The topmost menu's keys: the engine's own first (onKey), then the movie's as GFx gives
   * them (Menu.pressKey: a Flash player takes keys only once it has been clicked, a menu
   * opened by a key must take keys at once), as other keys where the menu says (keyAs). Tab
   * is the menus' (closing the tween menu, the next field), not the page's focus. A text
   * field being typed into gets the keys from the player itself.
   */
  readonly #keyed = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') event.preventDefault();
    if (!event.isTrusted) return;
    const top = this.#topInteractive();
    if (!top) return;
    const down = event.type === 'keydown';
    if (down && top.options.onKey?.(top, event)) {
      this.#taken.add(event.code);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!down && this.#taken.delete(event.code)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const as = top.options.keyAs?.[event.code];
    const code = flashKeyCode(as ?? event.code);
    if (code === undefined || top.typing) return;
    const type = !down ? 'keyUp' : event.repeat ? 'keyHold' : 'keyDown';
    if (top.pressKey(type, code)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const element = top.element;
    if (as === undefined || !element || !down) return;
    event.preventDefault();
    event.stopPropagation();
    // The key the player takes instead, down and up.
    for (const kind of ['keydown', 'keyup']) {
      element.dispatchEvent(new KeyboardEvent(kind, { key: as, code: as, bubbles: true }));
    }
  };

  #topInteractive(): Menu | undefined {
    let top: Menu | undefined;
    for (const menu of this.#menus.values()) {
      if (menu.options.interactive && (!top || menu.options.depth >= top.options.depth)) top = menu;
    }
    return top;
  }

  /** A click in the game: the keys go to the topmost menu again. */
  readonly #pointed = (): void => {
    this.focusTop();
  };

  readonly #dispatch = (menu: string, name: string, ...args: unknown[]): unknown => {
    // GFx's translator: a key a menu sets at run time (SetText("$Locations Discovered")).
    if (name === BRIDGE_TRANSLATE) return this.#translations?.translate(String(args[0]));
    return this.#menus.get(menu)?.received(name, args);
  };
}
