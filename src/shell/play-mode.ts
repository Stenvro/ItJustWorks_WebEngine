// Play: the game as the game is, from its own main menu (interface\startmenu.swf) on. The
// menus play in the menu host over the 3D view; what they ask of the engine is answered here.
// The main menu and the loading screens show over their 3D background (the mist menu,
// mist-menu.ts). New starts a new game: the loading menu (loadingmenu.swf) over a loading
// screen (LSCR) while the game's scripts start their new game, until the opening has placed the
// player (MQ101: the cart to Helgen) and the world there has loaded.
// In the game the HUD (hud-controller.ts) and the game's menus (game-menus.ts).

import { lockDifficulty, LOCKPICK, SKELETON_KEY } from '../gameplay/lockpicking.ts';
import type { Renderer } from '../render/renderer.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { CellObject } from '../world/cell-loader.ts';
import { parseItem } from '../world/item-records.ts';
import { itemSound } from '../gameplay/inventory.ts';
import { buttonArt, userEvent, withKeyLabels } from '../ui/button-art.ts';
import { menuKeys } from '../ui/menu-keys.ts';
import {
  parseLoadingScreen,
  pickLoadingScreen,
  type LoadingScreen,
} from '../world/loading-screens.ts';
import { InterfaceFiles } from '../ui/interface-files.ts';
import type { TweenCamera } from './tween-camera.ts';
import { introSequence, playVideo } from './video-player.ts';
import { MistMenu } from './mist-menu.ts';
import { FaderMenu } from './fader-menu.ts';
import { CreditsMenu } from './credits-menu.ts';
import { TitleSequence } from './title-sequence.ts';
import {
  CELL_NO_FAST_TRAVEL,
  fastTravelHours,
  noFastTravelReason,
  WORLD_NO_FAST_TRAVEL,
} from '../gameplay/fast-travel.ts';
import { ActorValue } from '../world/actor-values.ts';
import { carriedWeight } from './inventory-menu.ts';
import type { LocalMapContent } from './local-map.ts';
import { HudController } from './hud-controller.ts';
import { MessageBoxes } from './message-boxes.ts';
import { GameMenus } from './game-menus.ts';
import { DialogueMenu } from './dialogue-menu.ts';
import { cellPlacement, exteriorCells } from './cell-placement.ts';
import { ConsoleMenu, isConsoleKey, type ConsoleRunner } from './console-menu.ts';
import { ConsoleCommands, parseConsoleLine } from './console-commands.ts';
import { Compass } from './compass.ts';
import { MenuHost, type Menu } from '../ui/menu-host.ts';
import type { GameSession } from './game-session.ts';
import { headPosition, type PlacedActor } from './actors.ts';
import type { PlayerData } from './player.ts';
import type { PlayerView } from './race-menu.ts';
import type { Terminal } from './terminal.ts';
import { tellSwing } from './open-close.ts';

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
  properties[4] = false; // the Anniversary upgrade banner: a store's advert, never offline
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
/** The console's depth: over every other menu. */
const CONSOLE_DEPTH = 12;
/** Ownership read for the activation prompt is read again after this long (ms). */
const OWNERSHIP_MS = 5000;

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
  /** Fast travel riding a dragon: it flies the player there; false riding none. */
  flyMountTo(to: Vec3): boolean;
  /** The player's heading: radians, 0 north (+Y), π/2 east (+X); undefined out of the world. */
  heading(): number | undefined;
  /** The mouse looks around (the game) or moves a cursor (a menu). */
  capturePointer(on: boolean): void;
  /** The game ends (back to the main menu): the world on screen goes. */
  leave(): void;
  /** The player is off the ground (falling, jumping). */
  inAir(): boolean;
  /** Resolves once the place the player went to has loaded (they stand in it). */
  settled(): Promise<void>;
  /** What the map's local map shows where the player is (the viewer on screen's). */
  localMap(): LocalMapContent | undefined;
  /** The player's tween menu camera (undefined out of the world). */
  tweenCamera(): TweenCamera | undefined;
  /** The player being played, their session and body (the viewer on screen's). */
  player(): PlayerView | undefined;
  /** Whether living actors hostile to the player are near them (fast travel refuses then). */
  hostilesNear(): Promise<boolean>;
  /** Where the actors fighting the player are (the compass's enemies). */
  enemies?(): readonly (readonly number[])[];
}

/** Vite reloads the page (development): leaving it is not asked about. */
let viteReloading = false;
import.meta.hot?.on('vite:beforeFullReload', () => {
  viteReloading = true;
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The main menu's music (mods replace this file). */
const MAIN_THEME = 'music\\special\\mus_maintheme.xwm';

export class PlayMode {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #world: PlayWorld;
  readonly #terminal: Terminal;
  readonly #host: MenuHost;
  /** Game.FadeOutGame's fades. */
  readonly #fader: FaderMenu;
  /** The opening's title cards. */
  readonly #titles: TitleSequence;
  #startMenu: Menu | undefined;
  /** The intro plays once (not on returning to the main menu). */
  #introPlayed = false;
  #loadingMenu: Menu | undefined;
  #mist: MistMenu | undefined;
  #loadingScreens: Promise<LoadingScreen[]> | undefined;
  #hud: HudController | undefined;
  #messageBoxes: MessageBoxes | undefined;
  #menus: GameMenus | undefined;
  #dialogue: DialogueMenu | undefined;
  /** The menus open that pause the game (menu mode while there is one). */
  #pausing = 0;
  /** The menus open that take the mouse without pausing the game (the crafting menu). */
  #cursorMenus = 0;
  #starting = false;
  /** The player's data: its bindings (the menus show the keys of the events their texts name). */
  #playerData: PlayerData | undefined;
  /** The loading menu's text (the loading screen's, once chosen). */
  #loadingText = '';
  /** Leaving Play (Quit to Desktop): back to the engine's own main menu. */
  onQuit: (() => void) | undefined;

  /**
   * The shell's way out (its brand clicked): in a game it asks as the journal's Quit to Desktop
   * does ("Quit to desktop?  Any unsaved progress will be lost.", Yes / No) before Play ends;
   * from the main menu Play ends at once. Not while a place loads.
   */
  quitFromShell(): void {
    const boxes = this.#messageBoxes;
    if (!boxes) {
      if (!this.#starting) this.onQuit?.();
      return;
    }
    if (this.#session.loading || this.#asking) return;
    this.#asking = true;
    void (async () => {
      const settings = await this.#session.settings();
      const key = '$Quit to desktop?  Any unsaved progress will be lost.';
      const text = this.#host.translate(key) ?? key.slice(1);
      const yes = settings.string('sYes') ?? 'Yes';
      const no = settings.string('sNo') ?? 'No';
      const choice = await boxes.show(text, [yes, no]);
      if (choice === 0) this.onQuit?.();
    })().finally(() => {
      this.#asking = false;
    });
  }

  /** The shell's quit question is showing. */
  #asking = false;

  /**
   * While a game runs the page asks before it is left: outside full screen the browser's own
   * shortcuts act on the game's keys (Ctrl+W, sneaking forward, closes the tab; F5, Quicksave,
   * reloads it) and the game would go with it. Vite reloading the page in development passes.
   */
  readonly #leaving = (event: BeforeUnloadEvent): void => {
    if (!viteReloading) event.preventDefault();
  };

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
    const ini = session.ini;
    void session.playerData().then((data) => {
      this.#playerData = data;
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
          menu.respond(args[0], buttonArt(userEvent(this.#playerData?.controls, String(args[1]))));
        },
      },
    );
    // The menus' navigation keys as the player's bindings say (W, A, S, D as the arrows).
    this.#host.menuKeys = () => menuKeys(this.#playerData?.controls);
    this.#host.passKey = isConsoleKey;
    // A held direction key repeats at the engine's pace.
    this.#host.keyRepeat = {
      long: ini.number('Interface', 'fMenuKeyRepeatLong'),
      short: ini.number('Interface', 'fMenuKeyRepeatShort'),
    };
    this.#console = new ConsoleMenu(this.#host, terminal, ini);
    this.#fader = new FaderMenu(this.#host, terminal, () => session.loading);
    this.#titles = new TitleSequence(this.#host, terminal, () => session.loading);
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
    // The fader and the title cards from here on: a new game's opening uses them.
    this.#session.hud.screen = {
      titles: (action, name) => {
        if (action === 'show') this.#titles.show();
        else if (action === 'hide') this.#titles.hide();
        else this.#titles.start(name ?? '');
      },
      fade: (out, black, secondsBefore, duration) => {
        this.#fader.fade(out, black, secondsBefore, duration);
      },
      video: (file) => {
        void playVideo(this.#session, this.#terminal, file, true);
      },
    };
    // The intro (sIntroSequence: the studio's logo) before the main menu, the first time.
    if (!this.#introPlayed) {
      this.#introPlayed = true;
      for (const file of introSequence(this.#session)) {
        await playVideo(this.#session, this.#terminal, file, true);
      }
    }
    const mist = MistMenu.show(this.#session, this.#renderer).then((menu) => {
      this.#mist = menu;
    });
    this.#playMainTheme();
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
        // The menu tells as its fade out starts (before it calls what comes after it).
        fadeOutStarted: () => undefined,
        // CREDITS, once the menu has faded out: the credits, then the menu fades in again.
        OpenCreditsMenu: (menu) => {
          new CreditsMenu(this.#host, this.#session, this.#terminal)
            .open(DEPTH.startMenu + 1, () => {
              menu.call('FadeInMenu');
            })
            .catch((error: unknown) => {
              this.#terminal.log(
                'ui',
                `the credits do not open: ${error instanceof Error ? error.message : String(error)}`,
                'error',
              );
              menu.call('FadeInMenu');
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
    // The console works at the main menu too (its coc starts a new game in that cell).
    document.addEventListener('keydown', this.#consoleKey);
    await mist;
  }

  /** The main menu's music (music\special\mus_maintheme.xwm), once, from its start. */
  #playMainTheme(): void {
    const playing = (this.#mainTheme = this.#session
      .sounds()
      .then((sounds) => sounds.playMusicFile(MAIN_THEME))
      .then((stop) => {
        // Stopped before it began: it goes at once.
        if (this.#mainTheme !== playing) stop?.(0);
        return stop;
      }));
  }

  #stopMainTheme(seconds: number): void {
    const playing = this.#mainTheme;
    this.#mainTheme = undefined;
    void playing?.then((stop) => stop?.(seconds));
  }

  /** The main menu's music while it plays (resolves to what stops it). */
  #mainTheme: Promise<((seconds: number) => void) | undefined> | undefined;

  /**
   * New: the main menu fades out; a new game's scripts start (a clean game state) behind the
   * loading menu; once the opening has placed the player, the world there loads and the
   * loading menu goes. With a place (the main menu's coc) the game starts there, without the
   * opening (UESP, "Skyrim:Console": coc from the main menu skips it).
   */
  async #newGame(place?: Placement): Promise<void> {
    if (this.#starting) return;
    this.#starting = true;
    const session = this.#session;
    const startMenu = this.#startMenu;
    startMenu?.call('FadeOutMenu');
    this.#stopMainTheme(FADE_OUT_MS / 1000);
    await wait(FADE_OUT_MS);
    if (startMenu) this.#host.close(startMenu);
    this.#startMenu = undefined;
    // A new game: everything any game before it did goes. The loading menu over the mist while
    // its scripts start; the loading screen is chosen once the opening runs (a new game's own,
    // ChargenLoadScreen, asks for MQ101 at stage 10).
    const ready = session.resetStates(place === undefined);
    this.#loadingText = '';
    this.#mist?.showMist();
    await this.#openLoadingMenu();
    const runtime = await this.#runtimeStarting();
    // The dialogue is read while the world loads: the first conversation need not wait for it.
    runtime.detach(runtime.dialogue.prepare());
    await ready;
    const at = place ?? (await this.#openingPlacement(runtime));
    if (!at) throw new Error('the opening placed no player');
    const screen = await this.#pickLoadingScreen(runtime);
    if (screen) {
      this.#loadingText = screen.text;
      this.#loadingMenu?.invoke('_root.Menu_mc.refreshLoadingText');
      await this.#mist?.showLoadingScreen(screen);
    }
    // The world loads with the scripts and the clock standing still (the opening goes on once
    // the player is in it), behind the loading screen (which hides it until it is there).
    this.#mist?.cover();
    session.loading = true;
    try {
      await this.#world.enter(at);
    } finally {
      session.loading = false;
    }
    const loading = this.#loadingMenu;
    loading?.invoke('_root.Menu_mc.FadeOutMenu');
    await wait(FADE_OUT_MS);
    if (loading) this.#host.close(loading);
    this.#loadingMenu = undefined;
    this.#mist?.hide();
    this.#mist = undefined;
    // In the game: its HUD, its compass.
    // Its enemies: those fighting the player on the actor stage (src/shell/actor-combat.ts).
    const compass = new Compass(session, () => this.#world.enemies?.() ?? []);
    const hud = new HudController(this.#host, session.hud, {
      heading: () => this.#world.heading(),
      runtime: () => session.scriptsReady,
      settings: session.settings(),
      ini: () => session.ini,
      onSettingsChange: (listener) => session.preferences.onChange(listener),
      compass: () => compass.targets(),
      keyLabels: (text) => withKeyLabels(text, this.#playerData?.controls),
    });
    this.#hud = hud;
    await hud.open();
    const boxes = new MessageBoxes(this.#host, session.settings(), () => this.#enterMenuMode());
    this.#messageBoxes = boxes;
    const menus = new GameMenus(
      this.#host,
      session,
      this.#terminal,
      (pauses) => this.#enterMenuMode(pauses),
      {
        inAir: () => this.#world.inAir(),
        confirm: (text, buttons) => boxes.show(text, buttons),
        heading: () => this.#world.heading(),
        localMap: () => this.#world.localMap(),
        tweenCamera: () => this.#world.tweenCamera(),
        noFastTravelReason: () => this.#noFastTravelReason(),
        fastTravel: (destination, distance) => this.#fastTravel(destination, distance),
        player: () => this.#world.player(),
      },
    );
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
      takesKeys: () => this.#host.takesKeys,
      userEvent: (name) => {
        if (!dialogue.isOpen) menus.userEvent(name);
      },
      talk: (speaker, opening) => {
        this.#talk(dialogue, menus, speaker, opening);
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
      fastTravel: (destination) => {
        this.#fastTravel(destination, undefined).catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `the fast travel failed: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        });
      },
      // Dying ends a conversation and a menu open meanwhile (a script's kill); the console and
      // the system page stay the player's (GameMenus.userEvent).
      playerDied: () => {
        dialogue.close();
        menus.close();
      },
      // fPlayerDeathReloadTime after the death the game loads its most recent save.
      // TODO(M12): load the most recent save (savegames); until then the game ends as Quit to
      // main menu does.
      reloadAfterDeath: () => {
        this.#quitToMainMenu().catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `the main menu does not open: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        });
      },
      tutorial: (use) => {
        menus.tutorial(use);
      },
    };
    const settings = await session.settings();
    session.hud.uses = {
      text: (setting) => settings.string(setting) ?? setting,
      openContainer: (reference, closed) => {
        session.hud.menus?.container(reference, closed);
      },
      // Its swing's end tells the scripts (OnOpen, OnClose: the player opened it).
      swung: (object, instance) => {
        if (instance.playback)
          tellSwing(
            session.scriptsReady,
            object.reference,
            instance.playback,
            instance.model.sequences,
            PLAYER_REF,
          );
      },
      // Not in another's bed (sNoSleepInOwnedBed).
      sleep: (object) => {
        const runtime = session.scriptsReady;
        if (!runtime) return;
        void runtime.crime.mayTake(PLAYER_REF, object.reference).then((may) => {
          if (may) menus.sleep();
          else session.hud.notification(settings.string('sNoSleepInOwnedBed') ?? '');
        });
      },
      owned: (object) => this.#owned(object.reference),
      sneaking: () => this.#world.player()?.play.player.sneaking === true,
      pickpocket: (actor) => {
        menus.pickpocket(actor);
      },
      craft: (object, closed) => {
        menus.craft(object.reference, object.base, closed);
      },
      loadDoor: (text) => {
        session.hud.loadDoor(text);
      },
      lockOf: (object) => {
        const state = session.scriptsReady?.state.references.get(object.reference);
        if (state?.locked === false) return undefined;
        if (state?.locked === true) {
          return { level: state.lockLevel ?? object.lock?.level ?? 1, key: object.lock?.key };
        }
        return object.lock;
      },
      unlock: (object, then) => {
        this.#unlock(object.reference, then).catch((error: unknown) => {
          this.#terminal.log(
            'ui',
            `${object.name} is not unlocked: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
        });
      },
      read: (object) => {
        menus.readBook({
          book: object.base,
          reference: object.reference,
          take: () => {
            session.hud.uses?.take(object);
          },
        });
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
    window.addEventListener('beforeunload', this.#leaving);
    document.addEventListener('keydown', this.#consoleKey);
  }

  /** Why the player may not fast travel now (src/gameplay/fast-travel.ts), if not. */
  async #noFastTravelReason(): Promise<string | undefined> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return 'sNoFastTravelDefault';
    const at = session.scriptWorld.livePlacement(PLAYER_REF);
    const db = runtime.forms.db;
    let placeForbids = false;
    if (at?.world !== undefined) {
      const world = await db.get(at.world);
      placeForbids = ((world?.fields.first('DATA')?.[0] ?? 0) & WORLD_NO_FAST_TRAVEL) !== 0;
    } else if (at?.cell !== undefined) {
      const data = (await db.get(at.cell))?.fields.first('DATA');
      const flags = (data?.[0] ?? 0) | ((data?.[1] ?? 0) << 8);
      placeForbids = (flags & CELL_NO_FAST_TRAVEL) !== 0;
    }
    return noFastTravelReason({
      enabled: runtime.fastTravelEnabled,
      placeForbids,
      inAir: this.#world.inAir(),
      carried: await carriedWeight(runtime, PLAYER_REF),
      carryWeight: (await runtime.actors.value(PLAYER_REF, ActorValue.carryWeight)).current,
      pursued: session.crimeWatch?.pursued === true,
      inCombat: session.combatWatch?.fightingPlayer === true,
      hostilesNear: await this.#world.hostilesNear(),
      takingHealthDamage: await runtime.magic.damagingHealth(PLAYER_REF),
    });
  }

  /**
   * Fast travel (the map, Game.FastTravel): the time the way takes passes, and the player goes
   * to the destination behind a loading screen, as through a load door.
   */
  async #fastTravel(destination: number, distance: number | undefined): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const at = await runtime.placement(destination);
    if (!at) {
      this.#terminal.log('ui', `fast travel: ${destination.toString(16)} is nowhere`, 'warn');
      return;
    }
    // Riding a dragon, it flies the player there (in the same worldspace: no loading).
    const here = session.scriptWorld.livePlacement(PLAYER_REF);
    if (here?.world !== undefined && here.world === at.world && this.#world.flyMountTo(at.position))
      return;
    let way = distance;
    if (way === undefined) {
      const from = session.scriptWorld.livePlacement(PLAYER_REF);
      way =
        from?.world !== undefined && from.world === at.world
          ? Math.hypot(at.position[0] - from.position[0], at.position[1] - from.position[1])
          : 0;
    }
    const player = await session.playerData();
    const settings = await session.settings();
    const hours = fastTravelHours(
      way,
      player.movement.normal.walk.forward,
      settings.number('fFastTravelSpeedMult') ?? 1,
      session.timeScale,
    );
    if (hours > 0) session.advanceClock(hours);
    // The sky takes the next weather at once, without a change.
    session.sky.fastTravel();
    await this.#loadInto(at);
    // Arrived: the hub tells the time it took (TESFastTravelEndEvent: OnPlayerFastTravelEnd).
    runtime.events.emit('fastTravelEnd', { hours });
  }

  /** Goes to a place behind the loading menu and a loading screen, the HUD away. */
  #loadInto(at: Placement): Promise<void> {
    return this.loadingScreen(() => this.#world.enter(at));
  }

  /**
   * A journey behind the loading menu and a loading screen (a load door, fast travel), the HUD
   * away: `go` takes the player there; the screen goes once the place has loaded.
   */
  async loadingScreen(go: () => Promise<void>): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    let leave: ((pointer?: boolean) => void) | undefined = this.#enterMenuMode();
    session.hud.shown(false);
    // The world goes at once (the loading screen's mist and model come as they load).
    const unblack = MistMenu.blackout(this.#renderer);
    let mist: MistMenu | undefined;
    try {
      mist = await MistMenu.show(session, this.#renderer, false, true);
      mist.showMist();
      const screen = runtime && (await this.#pickLoadingScreen(runtime));
      this.#loadingText = screen?.text ?? '';
      await this.#openLoadingMenu();
      if (screen) await mist.showLoadingScreen(screen);
      // The place loads behind the loading menu: the player is put down in it (physics runs),
      // the scripts and the clock stand still, and the player's controls wait (the mouse stays
      // free until the place is there).
      leave(false);
      leave = undefined;
      session.loading = true;
      await go();
      await this.#world.settled();
    } finally {
      session.loading = false;
      const loading = this.#loadingMenu;
      loading?.invoke('_root.Menu_mc.FadeOutMenu');
      await wait(FADE_OUT_MS);
      if (loading) this.#host.close(loading);
      this.#loadingMenu = undefined;
      mist?.hide();
      unblack();
      session.hud.shown(true);
      if (leave) leave();
      else if (!session.menuMode) this.#world.capturePointer(true);
    }
  }

  /** The console (~): over the game and its menus, in menu mode while open. */
  readonly #console: ConsoleMenu;
  #commands: { readonly runtime: ScriptRuntime; readonly commands: ConsoleCommands } | undefined;

  readonly #consoleKey = (event: KeyboardEvent): void => {
    if (!isConsoleKey(event) || event.repeat || this.#console.isOpen) return;
    // In the game, or at the main menu (not while a new game starts from it).
    const atMainMenu = !this.#menus && this.#startMenu !== undefined && !this.#starting;
    if (!this.#menus && !atMainMenu) return;
    // Not while a place loads.
    if (this.#session.loading) return;
    event.preventDefault();
    const leave = this.#enterMenuMode();
    this.#console
      .open(
        CONSOLE_DEPTH,
        () => (atMainMenu ? this.#mainMenuCommands : this.#consoleCommands()),
        () => {
          leave();
        },
      )
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the console does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        leave();
      });
  };

  /**
   * Runs a console line as the console would (at the main menu its own commands, else the
   * game's), without opening it: development checks (tools/qa-run.ts).
   */
  runConsole(line: string): Promise<string[]> {
    const atMainMenu = !this.#menus && this.#startMenu !== undefined && !this.#starting;
    const runner = atMainMenu ? this.#mainMenuCommands : this.#consoleCommands();
    return runner ? runner.run(line) : Promise.resolve(['no game is running']);
  }

  /** Every exterior cell by editor id, for the main menu's coc (read once). */
  #exteriorCells: Promise<Map<string, number>> | undefined;

  /**
   * The main menu's console: centeroncell (coc) starts a new game in that cell, without the
   * opening; quitquitquit (qqq) quits; the game's other commands want a game running.
   */
  readonly #mainMenuCommands: ConsoleRunner = {
    run: async (line) => {
      const { command, args } = parseConsoleLine(line);
      switch (command) {
        case '':
          return [];
        case 'coc':
        case 'centeroncell': {
          const db = await this.#session.db;
          const cells = await (this.#exteriorCells ??= exteriorCells(db));
          const at = await cellPlacement(db, args[0] ?? '', (name) =>
            Promise.resolve(cells.get(name)),
          );
          if (typeof at === 'string') return [at];
          this.#console.hide();
          this.#newGame(at).catch((error: unknown) => {
            this.#terminal.log(
              'ui',
              `the new game does not start: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          });
          return [];
        }
        case 'qqq':
        case 'quitquitquit':
          this.onQuit?.();
          return [];
        default:
          return [`${command}: no game is running`];
      }
    },
  };

  /** The commands for the game now running. */
  #consoleCommands(): ConsoleCommands | undefined {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return undefined;
    if (this.#commands?.runtime !== runtime) {
      this.#commands = {
        runtime,
        commands: new ConsoleCommands({
          runtime,
          db: runtime.forms.db,
          travel: (at) => this.#world.enter(at),
          toggleMenus: () => {
            this.#menusShown = !this.#menusShown;
            session.hud.shown(this.#menusShown);
          },
          forceWeather: (weather, override) => {
            session.sky.forceWeather(weather, override);
          },
          // From the console a change is not hurried (scripts' SetActive may hurry it).
          setWeather: (weather, override) => {
            session.sky.setWeather(weather, override, false);
          },
          releaseWeatherOverride: () => {
            session.sky.releaseOverride();
          },
          toggleSky: () => session.sky.toggleSky(),
          showRaceMenu: () => {
            this.#showRaceMenu();
          },
          controlsChanged: () => runtime.world.controlsChanged?.(),
          quit: () => this.onQuit?.(),
        }),
      };
    }
    return this.#commands.commands;
  }

  /** The HUD and menus shown (the console's tm hides them). */
  #menusShown = true;

  /** The console's showracemenu: the console slides away, then the race menu opens. */
  #showRaceMenu(): void {
    this.#console.hide();
    void (async () => {
      while (this.#console.isOpen) await wait(16);
      await this.#menus?.openScripted({ name: 'RaceSex Menu', limited: false });
    })();
  }

  /**
   * Esc in the game: the browser takes it to free the mouse (a page cannot keep it), so the
   * mouse let go while the game plays is the game's Pause (the journal's system page), as Esc
   * is in the game.
   */
  /** A conversation runs (from its start, while its menu loads, until it ends). */
  #talking = false;

  readonly #pointerLockChanged = (): void => {
    // A conversation lets go of the mouse itself (its menu takes it; it is in no menu mode and
    // its menu loads a moment): that is no pause.
    if (document.pointerLockElement || this.#session.menuMode || this.#talking || !this.#menus) {
      return;
    }
    if (this.#menus.isOpen) return;
    this.#menus.openMenu('Pause');
  };

  /**
   * A conversation: the dialogue menu over the game, which goes on (no menu mode); the HUD in
   * its dialogue mode and the mouse on the menu until it ends (an actor with nothing to talk
   * about only says its greeting: no menu, the mouse stays the game's).
   */
  #talk(dialogue: DialogueMenu, menus: GameMenus, speaker: PlacedActor, opening?: number): void {
    if (dialogue.isOpen || menus.isOpen || this.#session.menuMode) return;
    const hud = this.#session.hud;
    // The view turns to the speaker and zooms in while they talk (src/shell/dialogue-camera.ts).
    const camera = this.#world.player()?.play.player.dialogue;
    dialogue
      .talk(
        speaker,
        {
          opened: () => {
            hud.mode('DialogueMode', true);
            this.#talking = true;
            this.#world.capturePointer(false);
            camera?.open(() => headPosition(speaker));
          },
          closed: () => {
            this.#talking = false;
            camera?.close();
            hud.mode('DialogueMode', false);
            this.#world.capturePointer(true);
          },
        },
        opening,
      )
      .catch((error: unknown) => {
        this.#talking = false;
        camera?.close();
        this.#terminal.log(
          'ui',
          `the conversation does not start: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        dialogue.close();
      });
  }

  /**
   * A lock the player opens: with its key if they carry it (sOpenWithKey; then it opens), else
   * by picking it, unless only its key opens it (sImpossibleLock) or they have no lockpick
   * (sOutOfLockpicks; the Skeleton Key is one), nor while guards pursue the player
   * (sNoLockPickIfCrimeAlert).
   */
  async #unlock(reference: number, then: () => void): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const lock = await runtime.lock(reference);
    if (!lock.locked) {
      then();
      return;
    }
    const settings = await session.settings();
    const say = (setting: string): void => {
      session.hud.notification(settings.string(setting) ?? '');
    };
    if (lock.key !== undefined && (await runtime.itemCount(PLAYER_REF, lock.key)) > 0) {
      runtime.state.reference(reference).locked = false;
      runtime.events.emit('lockChanged', { reference });
      const key = (await runtime.forms.record(lock.key))?.text('FULL') ?? '';
      session.hud.notification((settings.string('sOpenWithKey') ?? '%s').replace('%s', key));
      then();
      return;
    }
    if (lockDifficulty(lock.level) === undefined) {
      say('sImpossibleLock');
      return;
    }
    if (session.crimeWatch?.pursued === true) {
      say('sNoLockPickIfCrimeAlert');
      return;
    }
    const picks =
      (await runtime.itemCount(PLAYER_REF, LOCKPICK)) +
      (await runtime.itemCount(PLAYER_REF, SKELETON_KEY));
    if (picks <= 0) {
      say('sOutOfLockpicks');
      return;
    }
    // Those near comment on the player at a lock (LockedObject).
    this.#world.player()?.play.player.onAction?.('LOOB');
    this.#menus?.pickLock(reference);
  }

  /** Whose objects are (stolen if taken): references → owned by another, and when read. */
  readonly #ownership = new Map<number, { owned: boolean; at: number }>();

  /**
   * Whether taking a reference is stealing (the crime engine's mayTake), as last read; read
   * again every few seconds (owners and the player's factions change). False until known.
   */
  #owned(reference: number): boolean {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return false;
    const kept = this.#ownership.get(reference);
    const now = performance.now();
    if (!kept || now - kept.at > OWNERSHIP_MS) {
      this.#ownership.set(reference, { owned: kept?.owned ?? false, at: now });
      void runtime.crime.mayTake(PLAYER_REF, reference).then((may) => {
        this.#ownership.set(reference, { owned: !may, at: performance.now() });
      });
    }
    return kept?.owned ?? false;
  }

  /**
   * The player takes an item lying in the world: it joins their items, its sound playing; one
   * another owns is stolen (crime-engine.ts steal: marked stolen, the theft reported if seen).
   */
  async #take(object: CellObject): Promise<void> {
    const runtime = this.#session.scriptsReady;
    if (!runtime) return;
    const stealing = !(await runtime.crime.mayTake(PLAYER_REF, object.reference));
    await runtime.pickUp(object.reference, PLAYER_REF);
    const taken = runtime.state.references.get(object.reference)?.container?.count ?? 1;
    if (stealing) await runtime.crime.steal(PLAYER_REF, object.base, taken, object.reference);
    runtime.detach(runtime.storyEvents.pickedUp(object.base, object.reference, stealing));
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
   * menu has closed. Returns what ends this one's part. A menu that does not pause it
   * (`pauses` false: the crafting menu, as the engine's flags have it) only takes the mouse
   * while the world goes on (docs/ui.md, "Menu mode").
   */
  #enterMenuMode(pauses = true): (pointer?: boolean) => void {
    if (!pauses) {
      if (this.#cursorMenus++ === 0) this.#world.capturePointer(false);
      let left = false;
      return (pointer = true) => {
        if (left) return;
        left = true;
        if (--this.#cursorMenus === 0 && pointer && !this.#session.menuMode) {
          if (this.#dialogue?.isOpen !== true) this.#world.capturePointer(true);
        }
      };
    }
    if (this.#pausing++ === 0) this.#setMenuMode(true);
    let left = false;
    return (pointer = true) => {
      if (left) return;
      left = true;
      if (--this.#pausing === 0) this.#setMenuMode(false, pointer);
    };
  }

  #setMenuMode(on: boolean, pointer = true): void {
    const session = this.#session;
    session.menuMode = on;
    session.soundSystem?.engine.setInMenu(on, {
      out: session.ini.number('Audio', 'fMenuModeFadeOutTime'),
      in: session.ini.number('Audio', 'fMenuModeFadeInTime'),
    });
    // A conversation, or a menu that does not pause the game, keeps the mouse on its menu.
    const kept = this.#dialogue?.isOpen === true || this.#cursorMenus > 0;
    if (pointer && !(kept && !on)) this.#world.capturePointer(!on);
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
    // The loading screen's mist whooshes in (UILoadscreenMist, the engine's).
    void this.#session.sounds().then((sounds) => sounds.playNamed('UILoadscreenMist', undefined));
    const runtime = this.#session.scriptsReady;
    const level = runtime ? await runtime.actors.level(PLAYER_REF) : 1;
    const progress = runtime ? (await runtime.progression.levelProgress()) * 100 : 0;
    this.#loadingMenu = await this.#host.open('loadingmenu.swf', {
      depth: DEPTH.loadingMenu,
      interactive: false,
      handlers: {
        RequestLoadingText: (menu, args) => {
          menu.respond(args[0], this.#loadingText);
        },
        // The player's level and progress to the next (0..100; a new game's: level 1); the
        // meter shows in a game (not before a new game's first save).
        RequestPlayerInfo: (menu, args) => {
          menu.respond(args[0], level, progress, this.#hud !== undefined);
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
    this.#stopMainTheme(0);
    this.#endGame();
    // The world the game played in goes with it (the shell shows no game behind it).
    this.#world.leave();
    this.#session.hud.screen = undefined;
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
    window.removeEventListener('beforeunload', this.#leaving);
    document.removeEventListener('keydown', this.#consoleKey);
    this.#console.close();
    this.#dialogue?.close();
    this.#dialogue = undefined;
    this.#menus?.close();
    this.#menus = undefined;
    this.#messageBoxes?.close();
    this.#messageBoxes = undefined;
    this.#fader.close();
    this.#titles.hide();
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
