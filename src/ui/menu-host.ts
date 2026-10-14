// The menus on screen: each of the game's menu movies plays in a Ruffle player of its own (as
// each is a movie of its own under Scaleform), stacked in a layer over the 3D view by depth.
// The host routes what a menu asks of the engine (GameDelegate.call, ExternalInterface.call,
// tagged with the menu by the bridge, src/ui/menu-bridge.ts) to that menu's handlers, and
// lets the engine call into a menu: its GameDelegate callbacks, any function, any variable.
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
}

/** The page function the bridge calls (checked against the bridge's name at compile time). */
const BRIDGE_GLOBAL: typeof BRIDGE_CALL = '__itjwMenuCall';

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
  readonly element: RufflePlayerElement;
  /** The INI's safe zone margins. */
  safeZone: SafeZone = SAFE_ZONE;
  /** The movie's stage size in pixels. */
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly #api: RuffleApi;
  readonly #handlers: Map<string, MenuCallHandler>;
  readonly #unanswered: Set<string>;
  readonly #log: (message: string) => void;
  #closed = false;

  constructor(
    id: string,
    movie: string,
    element: RufflePlayerElement,
    handlers: Readonly<Record<string, MenuCallHandler>>,
    log: (message: string) => void,
    stage: { readonly width: number; readonly height: number },
  ) {
    this.id = id;
    this.movie = movie;
    this.element = element;
    this.stageWidth = stage.width;
    this.stageHeight = stage.height;
    this.#api = element.ruffle();
    this.#handlers = new Map(Object.entries(handlers));
    this.#unanswered = new Set();
    this.#log = log;
  }

  get api(): RuffleApi {
    return this.#api;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Answers a name the menu calls (adds or replaces its handler). */
  handle(name: string, handler: MenuCallHandler): void {
    this.#handlers.set(name, handler);
  }

  /** A call from the menu (through the bridge). */
  received(name: string, args: readonly unknown[]): unknown {
    const handler = this.#handlers.get(name);
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
    while (!this.#closed) {
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
    const { width, height } = this.element.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const align = this.get('Stage.align');
    const visible = visibleRect(
      this.stageWidth,
      this.stageHeight,
      width,
      height,
      scaleMode(this.get('Stage.scaleMode')),
      typeof align === 'string' ? align : '',
    );
    this.set('Stage.visibleRect', visible);
    this.set('Stage.safeRect', safeRect(visible, width / height > 4 / 3 + 0.01, this.safeZone));
  }

  /** Puts keyboard focus on the menu (an interactive menu as it opens). */
  focus(): void {
    this.element.focus();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Out of the page first: Ruffle ends a player that leaves the document. Pausing it as well
    // may fail on a player Ruffle has ended; that is no fault of the menu.
    this.element.remove();
    try {
      this.#api.pause();
    } catch {
      // Ended already.
    }
  }

  #external(name: string, ...args: unknown[]): unknown {
    if (this.#closed) return undefined;
    try {
      return this.#api.callExternalInterface(name, ...args);
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
  #next = 1;
  #stopServing: (() => void) | undefined;

  readonly #safeZone: SafeZone;

  constructor(
    layer: HTMLElement,
    files: InterfaceFiles,
    log: (message: string) => void,
    safeZone: SafeZone = SAFE_ZONE,
  ) {
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
    const source = await loadRuffle();
    const bytes = await this.#files.read(movie);
    if (!bytes) throw new Error(`interface\\${movie} is missing`);
    const id = `${movie.replace(/\.(swf|gfx)$/i, '')}#${String(this.#next++)}`;
    const element = source.createPlayer();
    element.classList.add('menu-movie');
    element.dataset.menu = id;
    element.style.zIndex = String(options.depth);
    element.style.pointerEvents = options.interactive ? 'auto' : 'none';
    element.tabIndex = options.interactive ? 0 : -1;
    this.#layer.append(element);
    const { frameSize } = readSwf(bytes).header;
    const stage = {
      width: (frameSize.xMax - frameSize.xMin) / 20,
      height: (frameSize.yMax - frameSize.yMin) / 20,
    };
    const menu = new Menu(id, movie, element, options.handlers ?? {}, this.#log, stage);
    menu.safeZone = this.#safeZone;
    // The rects the menu starts with: its stage shown whole (showAll, Ruffle's default) on
    // the layer; updateStage corrects them once the menu has set its own scale mode.
    const view = this.#layer.getBoundingClientRect();
    const visible = visibleRect(
      stage.width,
      stage.height,
      view.width || stage.width,
      view.height || stage.height,
      'showAll',
    );
    const rects = {
      visible,
      safe: safeRect(visible, view.width / view.height > 4 / 3 + 0.01, this.#safeZone),
    };
    this.#menus.set(id, menu);
    await menu.api.load({
      data: withBridge(bytes, id, rects),
      swfFileName: movie,
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
      this.#log(`${movie} did not start playing`);
    }
    menu.updateStage();
    if (options.interactive) menu.focus();
    return menu;
  }

  close(menu: Menu): void {
    menu.close();
    this.#menus.delete(menu.id);
  }

  closeAll(): void {
    for (const menu of [...this.#menus.values()]) this.close(menu);
  }

  dispose(): void {
    this.closeAll();
    this.#stopServing?.();
    this.#stopServing = undefined;
    window.removeEventListener('resize', this.#resized);
    if (window[BRIDGE_GLOBAL] === this.#dispatch) window[BRIDGE_GLOBAL] = undefined;
  }

  /** Serves the interface files and receives the menus' calls (once). */
  #start(): void {
    if (this.#stopServing) return;
    this.#stopServing = this.#files.serve();
    window.addEventListener('resize', this.#resized);
    window[BRIDGE_GLOBAL] = this.#dispatch;
  }

  readonly #resized = (): void => {
    for (const menu of this.#menus.values()) menu.updateStage();
  };

  readonly #dispatch = (menu: string, name: string, ...args: unknown[]): unknown =>
    this.#menus.get(menu)?.received(name, args);
}
