// Play: the game as the game is, from its own main menu (interface\startmenu.swf) on. The
// menus play in the menu host over the 3D view; what they ask of the engine is answered here.
// The main menu and the loading screens show over their 3D background (the mist menu,
// mist-menu.ts). New starts a new game: the loading menu (loadingmenu.swf) over a loading
// screen (LSCR) while the game's scripts start their new game, until the opening has placed the
// player (MQ101: the cart to Helgen) and the world there has loaded.
// In the game the HUD shows (hud-controller.ts). TODO(M9): the in-game menus.

import type { Renderer } from '../render/renderer.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { IniSettings } from '../world/ini-settings.ts';
import type { CellObject } from '../world/cell-loader.ts';
import { parseItem } from '../world/item-records.ts';
import { itemSound } from '../gameplay/inventory.ts';
import type { ControlMap } from '../formats/controlmap/controlmap.ts';
import { buttonArt, userEvent } from '../ui/button-art.ts';
import {
  parseLoadingScreen,
  pickLoadingScreen,
  type LoadingScreen,
} from '../world/loading-screens.ts';
import { InterfaceFiles } from '../ui/interface-files.ts';
import { MistMenu } from './mist-menu.ts';
import { HudController } from './hud-controller.ts';
import { MessageBoxes } from './message-boxes.ts';
import { GameMenus } from './game-menus.ts';
import { DialogueMenu } from './dialogue-menu.ts';
import { MenuHost, type Menu } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import type { PlacedActor } from './actors.ts';
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
  loadingMenu: 9,
  startMenu: 10,
} as const;

/** A menu's fade before it closes (its FadeOutMenu animation), ms. */
const FADE_OUT_MS = 500;
/** How long a new game's opening may take to place the player, ms. */
const OPENING_TIMEOUT_MS = 30_000;

/** What Play asks of the 3D view (the viewers, through main.ts). */
export interface PlayWorld {
  /** Takes the player to a place: its cell or worldspace loads; resolves once it has. */
  enter(at: Placement): Promise<void>;
  /** Whether the world follows the scripts' MoveTo of the player (Play: yes). */
  follow(on: boolean): void;
  /** The player's heading: radians, 0 north (+Y), π/2 east (+X); undefined out of the world. */
  heading(): number | undefined;
  /** The mouse looks around (the game) or moves a cursor (a menu). */
  capturePointer(on: boolean): void;
  /** The game ends (back to the main menu): the world on screen goes. */
  leave(): void;
  /** The player is off the ground (falling, jumping). */
  inAir(): boolean;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class PlayMode {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #world: PlayWorld;
  readonly #terminal: Terminal;
  readonly #host: MenuHost;
  #startMenu: Menu | undefined;
  #loadingMenu: Menu | undefined;
  #mist: MistMenu | undefined;
  #loadingScreens: Promise<LoadingScreen[]> | undefined;
  #hud: HudController | undefined;
  #messageBoxes: MessageBoxes | undefined;
  #menus: GameMenus | undefined;
  #dialogue: DialogueMenu | undefined;
  /** The menus open that pause the game (menu mode while there is one). */
  #pausing = 0;
  #starting = false;
  /** The input bindings (the menus show the keys of the events their texts name). */
  #controls: ControlMap | undefined;
  /** The loading menu's text (the loading screen's, once chosen). */
  #loadingText = '';
  /** Leaving Play (Quit to Desktop): back to the engine's own main menu. */
  onQuit: (() => void) | undefined;

  constructor(
    session: GameSession,
    renderer: Renderer,
    world: PlayWorld,
    layer: HTMLElement,
    terminal: Terminal,
  ) {
    this.#session = session;
    this.#renderer = renderer;
    this.#world = world;
    this.#terminal = terminal;
    const log = (message: string): void => {
      terminal.log('ui', message);
    };
    const ini = new IniSettings(session.vfs.defaultIni);
    void session.playerData().then((data) => {
      this.#controls = data.controls;
    });
    this.#host = new MenuHost(
      layer,
      new InterfaceFiles(session.vfs, log),
      log,
      {
        x: ini.number('Interface', 'fSafeZoneX'),
        y: ini.number('Interface', 'fSafeZoneY'),
        xWide: ini.number('Interface', 'fSafeZoneXWide'),
        yWide: ini.number('Interface', 'fSafeZoneYWide'),
      },
      {
        // The menus' own debug lines; the game drops them.
        myLog: () => undefined,
        // A UI sound by editor id ("UIMenuOK", "UIObjectiveNew"), at no place.
        PlaySound: (_menu, args) => {
          void session.sounds().then((sounds) => sounds.playNamed(String(args[1]), undefined));
        },
        // A text's "[Activate]": the art of the key bound to it, answered at once (the menu
        // reads it right after asking).
        GetButtonFromUserEvent: (menu, args) => {
          menu.respond(args[0], buttonArt(userEvent(this.#controls, String(args[1]))));
        },
      },
    );
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
    this.#world.follow(true);
    const mist = MistMenu.show(this.#session, this.#renderer).then((menu) => {
      this.#mist = menu;
    });
    this.#startMenu = await this.#host.open('startmenu.swf', {
      depth: DEPTH.startMenu,
      interactive: true,
      handlers: {
        QuitToDesktop: () => {
          this.onQuit?.();
        },
        NEW: () => {
          this.#newGame().catch((error: unknown) => {
            this.#terminal.log(
              'ui',
              `the new game does not start: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          });
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

  /**
   * New: the main menu fades out; a new game's scripts start (a clean game state) behind the
   * loading menu; once the opening has placed the player, the world there loads and the
   * loading menu goes.
   */
  async #newGame(): Promise<void> {
    if (this.#starting) return;
    this.#starting = true;
    const session = this.#session;
    const startMenu = this.#startMenu;
    startMenu?.call('FadeOutMenu');
    await wait(FADE_OUT_MS);
    if (startMenu) this.#host.close(startMenu);
    this.#startMenu = undefined;
    // A new game: everything any game before it did goes. The loading menu over the mist while
    // its scripts start; the loading screen is chosen once the opening runs (a new game's own,
    // ChargenLoadScreen, asks for MQ101 at stage 10).
    const ready = session.resetStates();
    this.#loadingText = '';
    this.#mist?.showMist();
    await this.#openLoadingMenu();
    const runtime = await this.#runtimeStarting();
    await ready;
    const at = await this.#openingPlacement(runtime);
    if (!at) throw new Error('the opening placed no player');
    const screen = await this.#pickLoadingScreen(runtime);
    if (screen) {
      this.#loadingText = screen.text;
      this.#loadingMenu?.invoke('_root.Menu_mc.refreshLoadingText');
      await this.#mist?.showLoadingScreen(screen);
    }
    await this.#world.enter(at);
    const loading = this.#loadingMenu;
    loading?.invoke('_root.Menu_mc.FadeOutMenu');
    await wait(FADE_OUT_MS);
    if (loading) this.#host.close(loading);
    this.#loadingMenu = undefined;
    this.#mist?.hide();
    this.#mist = undefined;
    // In the game: its HUD.
    const hud = new HudController(this.#host, session.hud, {
      heading: () => this.#world.heading(),
      runtime: () => session.scriptsReady,
      settings: session.settings(),
    });
    this.#hud = hud;
    await hud.open();
    const boxes = new MessageBoxes(this.#host, session.settings(), () => this.#enterMenuMode());
    this.#messageBoxes = boxes;
    const menus = new GameMenus(this.#host, session, this.#terminal, () => this.#enterMenuMode(), {
      inAir: () => this.#world.inAir(),
    });
    this.#menus = menus;
    menus.onQuit = (toDesktop) => {
      if (toDesktop) {
        this.onQuit?.();
        return;
      }
      this.#quitToMainMenu().catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the main menu does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      });
    };
    const dialogue = new DialogueMenu(this.#host, session, this.#terminal);
    this.#dialogue = dialogue;
    dialogue.prepare();
    session.hud.menus = {
      messageBox: (text, buttons) => boxes.show(text, buttons),
      userEvent: (name) => {
        if (!dialogue.isOpen) menus.userEvent(name);
      },
      talk: (speaker) => {
        this.#talk(dialogue, menus, speaker);
      },
      container: (reference, closed) => {
        if (dialogue.isOpen) closed();
        else menus.openContainer(reference, closed);
      },
      open: (request) => {
        if (request.name === 'Main Menu') {
          this.#quitToMainMenu().catch((error: unknown) => {
            this.#terminal.log(
              'ui',
              `the main menu does not open: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          });
          return Promise.resolve(0);
        }
        // A conversation's menu (barter, gift) shows in its place; it comes back after.
        const talking = dialogue.isOpen;
        if (talking) dialogue.shown = false;
        return menus.openScripted(request).finally(() => {
          if (talking) dialogue.shown = true;
        });
      },
    };
    const settings = await session.settings();
    session.hud.uses = {
      text: (setting) => settings.string(setting) ?? setting,
      openContainer: (reference, closed) => {
        session.hud.menus?.container(reference, closed);
      },
      sleep: () => {
        menus.sleep();
      },
      take: (object) => {
        this.#take(object).catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `${object.name} is not taken: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        });
      },
    };
    document.addEventListener('pointerlockchange', this.#pointerLockChanged);
  }

  /**
   * Esc in the game: the browser takes it to free the mouse (a page cannot keep it), so the
   * mouse let go while the game plays is the game's Pause (the journal's system page), as Esc
   * is in the game.
   */
  readonly #pointerLockChanged = (): void => {
    if (document.pointerLockElement || this.#session.menuMode || !this.#menus) return;
    if (this.#menus.isOpen) return;
    this.#menus.openMenu('Pause');
  };

  /**
   * A conversation: the dialogue menu over the game, which goes on (no menu mode); the HUD in
   * its dialogue mode and the mouse on the menu until it ends.
   */
  #talk(dialogue: DialogueMenu, menus: GameMenus, speaker: PlacedActor): void {
    if (dialogue.isOpen || menus.isOpen || this.#session.menuMode) return;
    const hud = this.#session.hud;
    hud.mode('DialogueMode', true);
    this.#world.capturePointer(false);
    dialogue
      .talk(speaker, () => {
        hud.mode('DialogueMode', false);
        this.#world.capturePointer(true);
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the conversation does not start: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        dialogue.close();
      });
  }

  /** The player takes an item lying in the world: it joins their items, its sound playing. */
  async #take(object: CellObject): Promise<void> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return;
    await runtime.pickUp(object.reference, PLAYER_REF);
    const record = await runtime.forms.record(object.base);
    const item = record && parseItem(record);
    const sounds = this.#session.soundSystem;
    const sound = item && sounds && itemSound(item, true, sounds.defaults);
    if (sound !== undefined)
      void sounds?.play(sound, [
        object.world[12] ?? 0,
        object.world[13] ?? 0,
        object.world[14] ?? 0,
      ]);
  }

  /**
   * A menu that pauses the game opens: the game is in menu mode (the world and its clocks stand
   * still, the sounds paused in menus go quiet, the mouse moves a cursor) until every such
   * menu has closed. Returns what ends this one's part.
   */
  #enterMenuMode(): () => void {
    if (this.#pausing++ === 0) this.#setMenuMode(true);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      if (--this.#pausing === 0) this.#setMenuMode(false);
    };
  }

  #setMenuMode(on: boolean, pointer = true): void {
    const session = this.#session;
    session.menuMode = on;
    session.soundSystem?.engine.setInMenu(on);
    // A conversation keeps the mouse on its menu.
    if (pointer && !(this.#dialogue?.isOpen === true && !on)) this.#world.capturePointer(!on);
  }

  /** The runtime the session's new game runs in, as soon as it exists. */
  async #runtimeStarting(): Promise<ScriptRuntime> {
    for (;;) {
      const runtime = this.#session.scriptsStarting ?? this.#session.scriptsReady;
      if (runtime) return runtime;
      await wait(16);
    }
  }

  /** Where the opening puts the player (MQ101 moves them as its first stages run). */
  async #openingPlacement(runtime: ScriptRuntime): Promise<Placement | undefined> {
    const until = performance.now() + OPENING_TIMEOUT_MS;
    while (performance.now() < until) {
      if (runtime.state.references.get(PLAYER_REF)?.position) {
        return runtime.placement(PLAYER_REF, false);
      }
      await wait(100);
    }
    return undefined;
  }

  /**
   * A loading screen whose conditions hold (run on the player): those with conditions first
   * (inferred: a new game always shows its own, ChargenLoadScreen), else one at random.
   */
  async #pickLoadingScreen(runtime: ScriptRuntime): Promise<LoadingScreen | undefined> {
    this.#loadingScreens ??= this.#session.db.then(async (db) => {
      const screens: LoadingScreen[] = [];
      for (const formId of db.formIdsOfType('LSCR')) {
        const record = await db.get(formId);
        if (record) screens.push(parseLoadingScreen(record));
      }
      return screens;
    });
    const screens = await this.#loadingScreens;
    const player = runtime.referenceHandle(PLAYER_REF);
    const holding = new Set<LoadingScreen>();
    for (const screen of screens) {
      if (screen.conditions.length === 0) continue;
      if (await runtime.conditionsHold(screen.conditions, player)) holding.add(screen);
    }
    return holding.size > 0
      ? pickLoadingScreen([...holding], () => true)
      : pickLoadingScreen(screens, (screen) => screen.conditions.length === 0);
  }

  /** The loading menu, its text the loading screen's. */
  async #openLoadingMenu(): Promise<void> {
    this.#loadingMenu = await this.#host.open('loadingmenu.swf', {
      depth: DEPTH.loadingMenu,
      interactive: false,
      handlers: {
        RequestLoadingText: (menu, args) => {
          menu.respond(args[0], this.#loadingText);
        },
        // A new game's player: level 1, no progress; the meter is not shown (no save yet).
        RequestPlayerInfo: (menu, args) => {
          menu.respond(args[0], 1, 0, false);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.invoke('_root.SetPlatform', 0);
        menu.invoke('_root.Menu_mc.FadeInMenu');
      },
    });
  }

  stop(): void {
    this.#endGame();
    this.#world.follow(false);
    this.#mist?.hide();
    this.#mist = undefined;
    this.#host.dispose();
    this.#startMenu = undefined;
    this.#loadingMenu = undefined;
  }

  /** The game's menus, HUD and menu mode go (Play ends, or the game goes back to its menu). */
  #endGame(): void {
    document.removeEventListener('pointerlockchange', this.#pointerLockChanged);
    this.#dialogue?.close();
    this.#dialogue = undefined;
    this.#menus?.close();
    this.#menus = undefined;
    this.#messageBoxes?.close();
    this.#messageBoxes = undefined;
    if (this.#session.hud.menus) this.#session.hud.menus = undefined;
    if (this.#session.hud.uses) this.#session.hud.uses = undefined;
    if (this.#pausing > 0) this.#setMenuMode(false, false);
    this.#pausing = 0;
    this.#hud?.close();
    this.#hud = undefined;
  }

  /** Quit to the main menu (the journal's system page): the game ends, its main menu opens. */
  async #quitToMainMenu(): Promise<void> {
    this.#endGame();
    this.#world.leave();
    this.#starting = false;
    await this.start();
  }

  get session(): GameSession {
    return this.#session;
  }
}
