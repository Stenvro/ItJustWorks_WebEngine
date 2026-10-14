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
import { BRIDGE_CALL, BRIDGE_GET, BRIDGE_INVOKE, BRIDGE_SET, withBridge } from './menu-bridge.ts';
import { loadRuffle, type RuffleApi, type RufflePlayerElement } from './ruffle.ts';
import { readSwf } from '../formats/swf/swf.ts';
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
}

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

  /** Puts keyboard focus on the menu (an interactive menu as it opens). */
  focus(): void {
    this.#element?.focus();
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
    let top: Menu | undefined;
    for (const menu of this.#menus.values()) {
      if (menu.options.interactive && (!top || menu.options.depth >= top.options.depth)) top = menu;
    }
    top?.focus();
  }

  dispose(): void {
    this.closeAll();
    this.#stopServing?.();
    this.#stopServing = undefined;
    this.#sizeWatch.disconnect();
    this.#layer.removeEventListener('pointerdown', this.#pointed);
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
    await options.setup?.(menu);
    if (options.interactive && menu.element === element) menu.focus();
  }

  /** Serves the interface files and receives the menus' calls (once). */
  #start(): void {
    if (this.#stopServing) return;
    this.#stopServing = this.#files.serve();
    this.#sizeWatch.observe(this.#layer);
    this.#layer.addEventListener('pointerdown', this.#pointed);
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

  /** A click in the game: the keys go to the topmost menu again. */
  readonly #pointed = (): void => {
    this.focusTop();
  };

  readonly #dispatch = (menu: string, name: string, ...args: unknown[]): unknown =>
    this.#menus.get(menu)?.received(name, args);
}
