// Character creation: the race menu (interface\racesex_menu.swf, with TextEntry.swf's name box
// linked in), opened by Game.ShowRaceMenu (a new game's MQ101, TriggerRaceMenuScript, the
// console's showracemenu) and Game.ShowLimitedRaceMenu (the race cannot change, no name: the
// Dawnguard surgery). The world stays on screen under it, the game in menu mode; the camera
// stands in front of the player (src/shell/race-menu-camera.ts), who holds the menu's pose
// (sPosePlayerRaceSexMenu) and turns with the mouse's right button; two lights light them.
//
// The engine opens it with its extensions and platform (bLimitedMenu for the limited menu), its
// name box on screen (ShowTextEntry(true): the PC's), the categories (SetCategoriesList: text,
// filter flag), the sliders (SetOptionSliders: text, filter flag, callback, min, max, position,
// interval, id), the playable races (SetRaceList: name, description, equip state; the player's
// above 0) and the player's name (SetNameText). The movie calls the sliders' callbacks with
// (value, id): src/gameplay/chargen.ts applies them to the player's appearance, the player's 3D
// is made again (src/shell/player-look.ts; a tint only paints the face again), and the sliders
// are sent again where their ranges or positions moved. ChangeRace(index) starts the race's
// default look and answers HideLoadingIcon once the new body stands there; ZoomPC(bool) zooms
// the camera in on the face or out to the body. Done (its button, R) asks sRSMConfirm, then
// the name box asks for a name (ShowTextEntryField; while it is typed into, Enter accepts, Esc
// and Tab cancel) and sRSMNameWarning with it; the limited menu asks sRSMFinishedWarning. Then
// the menu fades (FadeOut: its root's frames 2..9) and closes.
// The race it finishes with brings its abilities (RACE SPLO, the magic system's lasting
// effects); after the opening a new race also resets the skills to the race's (UESP "Console").
// Notes: docs/ui.md ("Character creation").

import { inputPlatform } from '../ui/input-platform.ts';
import {
  applySlider,
  buildSliders,
  categoryArguments,
  defaultAppearance,
  playerNameOf,
  raceListArguments,
  sliderArguments,
  SliderCallback,
  type ChargenRaceData,
  type PlayerAppearance,
} from '../gameplay/chargen.ts';
import type { ChargenRaceEntry } from '../gameplay/chargen-catalog.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { flashKeyCode } from '../ui/key-codes.ts';
import { ActorValue, SKILL_COUNT } from '../world/actor-values.ts';
import type { Menu, MenuCallHandler, MenuHost } from '../ui/menu-host.ts';
import type { GameSettings } from '../world/game-settings.ts';
import type { GameSession } from './game-session.ts';
import type { PlaySession } from './play-session.ts';
import type { PlayerAvatar } from './player-avatar.ts';
import { RaceMenuCamera, raceMenuSettings } from './race-menu-camera.ts';
import type { Terminal } from './terminal.ts';

/** The menu's panels (RaceSexPanels): where bLimitedMenu is set. */
const PANELS = '_root.RaceSexMenuBaseInstance.RaceSexPanelsInstance';
/** The root's fade (FadeOut plays frames 2..9) has ended on this frame. */
const FADED_FRAME = 9;
/** How long the fade may take before the menu closes anyway (ms; it takes about 0.27 s). */
const FADE_TIMEOUT_MS = 1000;
/** How long the menu waits for the player's body to be there (ms). */
const AVATAR_TIMEOUT_MS = 10_000;
/** Radians the player turns per pixel the mouse moves with its right button held. */
const TURN_PER_PIXEL = 0.01;

/** The player in the world: their session (cameras, lights) and their body. */
export interface PlayerView {
  readonly play: PlaySession;
  readonly avatar: PlayerAvatar | undefined;
}

/** What the race menu asks of the world. */
export interface RaceMenuWorld {
  /** A message box with buttons; resolves with the button chosen. */
  confirm(text: string, buttons: readonly string[]): Promise<number>;
  /** The player being played, if they are in a world. */
  player(): PlayerView | undefined;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class RaceMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #world: RaceMenuWorld;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal, world: RaceMenuWorld) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#world = world;
  }

  /**
   * Opens the menu (`limited`: ShowLimitedRaceMenu's); `closed` once it has faded and closed.
   * Undefined if it cannot open (the player is in no world, they have no appearance).
   */
  async open(
    limited: boolean,
    depth: number,
    closed: () => void,
  ): Promise<{ readonly menu: Menu; close(): void } | undefined> {
    const session = this.#session;
    const look = session.playerLook;
    const appearance = await look.appearance();
    const view = await this.#playerView();
    if (!appearance || !view?.avatar) {
      this.#terminal.log('ui', 'the race menu needs the player in a world', 'warn');
      return undefined;
    }
    const [catalog, settings, data] = await Promise.all([
      look.catalog(),
      session.settings(),
      look.raceData(appearance.race, appearance.sex),
    ]);
    const editing = new Editing(this.#host, session, this.#terminal, this.#world, {
      limited,
      depth,
      view: { play: view.play, avatar: view.avatar },
      races: catalog.races,
      settings,
      appearance,
      data,
      closed,
    });
    const menu = await editing.start();
    return {
      menu,
      close: () => {
        editing.close();
      },
    };
  }

  /** The player in the world, once their body is there (it is made as a world opens). */
  async #playerView(): Promise<PlayerView | undefined> {
    const until = performance.now() + AVATAR_TIMEOUT_MS;
    for (;;) {
      const view = this.#world.player();
      if (!view || view.avatar || performance.now() > until) return view;
      await wait(50);
    }
  }
}

/**
 * The player's skills back to their race's (the record's, by the race now: the base the skill
 * increases set and their experience go). Level, perks and perk points stay.
 */
export function resetSkillsToRace(runtime: ScriptRuntime): void {
  const values = runtime.state.actors.get(PLAYER_REF)?.values;
  for (let skill = ActorValue.firstSkill; skill < ActorValue.firstSkill + SKILL_COUNT; skill++) {
    const value = values?.get(skill);
    if (value) delete value.base;
    runtime.state.skillExperience.delete(skill);
  }
}

interface EditingSetup {
  readonly limited: boolean;
  readonly depth: number;
  readonly view: { readonly play: PlaySession; readonly avatar: PlayerAvatar };
  readonly races: readonly ChargenRaceEntry[];
  readonly settings: GameSettings;
  readonly appearance: PlayerAppearance;
  readonly data: ChargenRaceData;
  readonly closed: () => void;
}

/** One opening of the menu: the player's look being edited. */
class Editing {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;
  readonly #world: RaceMenuWorld;
  readonly #setup: EditingSetup;
  readonly #camera: RaceMenuCamera;
  #menu: Menu | undefined;
  #appearance: PlayerAppearance;
  #data: ChargenRaceData;
  /** The menu's changes, one after another (a race's data loads before the next applies). */
  #queue: Promise<void> = Promise.resolve();
  /** Done asked: a message box is up. */
  #asking = false;
  /** The name box is out: ChangeName with a name is the player's answer. */
  #awaitingName = false;
  #closing = false;
  #closed = false;

  constructor(
    host: MenuHost,
    session: GameSession,
    terminal: Terminal,
    world: RaceMenuWorld,
    setup: EditingSetup,
  ) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
    this.#world = world;
    this.#setup = setup;
    this.#appearance = setup.appearance;
    this.#data = setup.data;
    const { play, avatar } = setup.view;
    // The race opens zoomed in on the face; the limited menu opens on the body.
    this.#camera = new RaceMenuCamera(
      play.player.drawnFeet,
      avatar.bodyYaw,
      play.player.bodyHeight,
      raceMenuSettings(session.ini),
      !setup.limited,
    );
  }

  async start(): Promise<Menu> {
    const { play, avatar } = this.#setup.view;
    play.cameraOverride = this.#camera;
    play.extraLights = this.#camera.lights;
    avatar.animatesInMenus = true;
    avatar.hold(this.#session.ini.text('Interface', 'sPosePlayerRaceSexMenu'));
    window.addEventListener('pointermove', this.#turned, { capture: true });
    window.addEventListener('contextmenu', this.#noContextMenu, { capture: true });
    const slider: MenuCallHandler = (menu, args) => {
      const value = Number(args[1]);
      const id = Number(args[2]);
      this.#enqueue(() => this.#slider(menu, id, value));
    };
    const handlers: Record<string, MenuCallHandler> = {
      ChangeRace: (menu, args) => {
        const index = Number(args[1]);
        this.#enqueue(() => this.#changeRace(menu, index));
      },
      ChangeName: (menu, args) => {
        void this.#changeName(menu, args[1]);
      },
      ConfirmDone: (menu) => {
        void this.#confirmDone(menu);
      },
      ZoomPC: (_menu, args) => {
        this.#camera.zoom(args[1] === true);
      },
      // The name field took the focus: the menu host gives a focused text field the keys.
      SetAllowTextInput: () => undefined,
      // Consoles' on-screen keyboard; the PC types into the name box.
      ShowVirtualKeyboard: () => undefined,
    };
    for (const callback of Object.values(SliderCallback)) handlers[callback] = slider;
    let menu: Menu;
    try {
      menu = await this.#open(handlers);
    } catch (error) {
      this.close();
      throw error;
    }
    this.#menu = menu;
    if (this.#closed) this.#host.close(menu);
    return menu;
  }

  /**
   * The movie, set up as the engine opens it: extensions, platform, the limited menu's flag,
   * the name box, then the categories, the sliders, the races (after the categories) and the
   * name.
   */
  #open(handlers: Readonly<Record<string, MenuCallHandler>>): Promise<Menu> {
    return this.#host.open('racesex_menu.swf', {
      depth: this.#setup.depth,
      interactive: true,
      cursor: true,
      handlers,
      onKey: (opened, event) => this.#key(opened, event),
      setup: async (opened) => {
        if (!(await opened.waitFor('_root.InitExtensions'))) return;
        opened.invoke('_root.InitExtensions');
        opened.invoke('_root.SetPlatform', inputPlatform(), false);
        if (this.#setup.limited) opened.set(`${PANELS}.bLimitedMenu`, true);
        opened.call('ShowTextEntry', true);
        opened.call('SetCategoriesList', ...categoryArguments((label) => this.#text(label)));
        this.#sendSliders(opened);
        opened.call('SetRaceList', ...raceListArguments(this.#setup.races, this.#appearance.race));
        opened.call('SetNameText', await this.#playerName());
      },
    });
  }

  /** A game setting's text (a label's GMST), else its name. */
  #text(setting: string): string {
    return this.#setup.settings.string(setting) ?? setting;
  }

  async #playerName(): Promise<string> {
    const runtime = this.#session.scriptsReady;
    return runtime ? runtime.actors.playerName() : '';
  }

  #enqueue(task: () => Promise<void> | void): void {
    this.#queue = this.#queue.then(task).catch((error: unknown) => {
      this.#terminal.log(
        'ui',
        `the race menu: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    });
  }

  /** The sliders for the appearance now (SetOptionSliders replaces the list). */
  #sendSliders(menu: Menu): void {
    const sliders = buildSliders(this.#data, this.#appearance);
    menu.call('SetOptionSliders', ...sliderArguments(sliders, (label) => this.#text(label)));
  }

  /** The appearance changed: it is the player's; their 3D shows it (the face's tint alone). */
  #apply(appearance: PlayerAppearance, paintOnly: boolean): Promise<void> {
    this.#appearance = appearance;
    const look = this.#session.playerLook;
    look.setAppearance(appearance);
    if (paintOnly) return look.paint(appearance);
    return this.#session.scriptWorld.lookChanged(PLAYER_REF);
  }

  /**
   * Another race or sex: the new body stands there, the camera and its lights at its height.
   */
  async #newBody(appearance: PlayerAppearance): Promise<void> {
    await this.#apply(appearance, false);
    if (this.#closed) return;
    const { play } = this.#setup.view;
    this.#camera.retarget(play.player.bodyHeight);
    play.extraLights = this.#camera.lights;
  }

  /** A slider's callback (value, id). */
  async #slider(menu: Menu, id: number, value: number): Promise<void> {
    const result = applySlider(this.#data, this.#appearance, id, value);
    if (result.changes.length === 0) return;
    if (result.changes.includes('sex')) {
      // A new sex starts from the race's default look for it.
      const sex = result.appearance.sex;
      const data = await this.#session.playerLook.raceData(this.#appearance.race, sex);
      this.#data = data;
      const changed = this.#newBody(defaultAppearance(data, this.#appearance.weight));
      this.#sendSliders(menu);
      await changed;
      return;
    }
    const paintOnly = result.changes.every((change) => change === 'tints');
    // Not awaited: the body is made again while the slider moves on (the latest look wins).
    void this.#apply(result.appearance, paintOnly);
    if (result.resendSliders) this.#sendSliders(menu);
  }

  /**
   * ChangeRace(index): the race's default look (sex and weight kept), the actor's own race
   * (Actor.SetRace's) given up; the loading icon goes once the new body stands there.
   */
  async #changeRace(menu: Menu, index: number): Promise<void> {
    const race = this.#setup.races[index];
    if (race && race.formId !== this.#appearance.race) {
      const data = await this.#session.playerLook.raceData(race.formId, this.#appearance.sex);
      this.#data = data;
      const actor = this.#session.scriptsReady?.state.actors.get(PLAYER_REF);
      if (actor) actor.race = undefined;
      const changed = this.#newBody(defaultAppearance(data, this.#appearance.weight));
      menu.call('SetRaceText', race.name);
      this.#sendSliders(menu);
      await changed;
    }
    menu.call('HideLoadingIcon');
  }

  /** Done (its button, R): the name next, or (the limited menu) finished. */
  async #confirmDone(menu: Menu): Promise<void> {
    if (this.#asking || this.#closing || this.#awaitingName) return;
    this.#asking = true;
    try {
      if (this.#setup.limited) {
        if ((await this.#confirm(this.#text('sRSMFinishedWarning'))) === 0) this.#finish(menu);
        return;
      }
      if ((await this.#confirm(this.#text('sRSMConfirm'))) !== 0) return;
      this.#awaitingName = true;
      menu.call('ShowTextEntryField');
    } finally {
      this.#asking = false;
    }
  }

  /**
   * ChangeName: the movie sends it as the name box accepts (with the name) and again as the box
   * fades (every category change fades it too), with the name or none: only a name while the
   * engine waits for one counts; none then is the box cancelled.
   */
  async #changeName(menu: Menu, text: unknown): Promise<void> {
    if (!this.#awaitingName || this.#asking || this.#closing) return;
    const name = playerNameOf(text);
    if (name === undefined) {
      this.#awaitingName = false;
      return;
    }
    this.#asking = true;
    try {
      const warning = this.#text('sRSMNameWarning').replace('%s', name);
      if ((await this.#confirm(warning)) !== 0) {
        menu.call('ShowTextEntryField');
        return;
      }
      this.#awaitingName = false;
      const runtime = this.#session.scriptsReady;
      if (runtime) runtime.state.playerName = name;
      menu.call('SetNameText', name);
      this.#finish(menu);
    } finally {
      this.#asking = false;
    }
  }

  /**
   * A Yes / No box over the menu; the menu takes the keys again once it has gone (before the
   * name box takes the focus: focusing the player later would take it from the field).
   */
  async #confirm(text: string): Promise<number> {
    const choice = await this.#world.confirm(text, [this.#text('sYes'), this.#text('sNo')]);
    this.#host.focusTop();
    return choice;
  }

  /**
   * The menu's keys: R is Done (the ItemMenu context's XButton); while the name box is typed
   * into, Enter accepts it and Esc or Tab cancels it (the movie's handleInput reads them
   * through CLIK's InputDelegate), the field takes the rest.
   */
  #key(menu: Menu, event: KeyboardEvent): boolean {
    if (menu.typing) {
      const as =
        event.code === 'Enter' || event.code === 'NumpadEnter'
          ? 'Enter'
          : event.code === 'Escape' || event.code === 'Tab'
            ? 'Tab'
            : undefined;
      if (as === undefined) return false;
      const code = flashKeyCode(as);
      if (code !== undefined && !event.repeat) {
        menu.pressKey('keyDown', code);
        menu.pressKey('keyUp', code);
      }
      return true;
    }
    if (event.code !== 'KeyR') return false;
    if (!event.repeat) void this.#confirmDone(menu);
    return true;
  }

  /** The mouse moved: with its right button held, the player turns (TODO(M13): verify). */
  readonly #turned = (event: PointerEvent): void => {
    if ((event.buttons & 2) === 0) return;
    const avatar = this.#setup.view.avatar;
    avatar.bodyYaw -= event.movementX * TURN_PER_PIXEL;
  };

  readonly #noContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  /**
   * The race the menu finished with: its abilities (RACE SPLO) take the old race's place on the
   * player (the magic system's lasting effects). After the opening's race menu (any finished
   * before) a new race also resets the skills to its own (UESP "Console": showracemenu; the
   * level and perks stay). The limited menu keeps the race.
   */
  async #raceSettled(): Promise<void> {
    const runtime = this.#session.scriptsReady;
    if (!runtime || this.#setup.limited) return;
    const changed = this.#appearance.race !== this.#setup.appearance.race;
    if (changed && runtime.state.raceChosen) resetSkillsToRace(runtime);
    runtime.state.raceChosen = true;
    if (changed) await runtime.magic.syncLasting(PLAYER_REF);
  }

  /** Fades the menu out (its root's frames 2..9), then it closes. */
  #finish(menu: Menu): void {
    if (this.#closing) return;
    this.#closing = true;
    menu.call('FadeOut');
    void (async () => {
      const until = performance.now() + FADE_TIMEOUT_MS;
      while (performance.now() < until && menu.get('_root._currentframe') !== FADED_FRAME) {
        await wait(16);
      }
      // The look's last changes are in place before the game goes on.
      await this.#queue;
      await this.#raceSettled().catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the new race: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      });
      this.close();
    })();
  }

  /** Closes the menu: the player's camera, controls and pose come back. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#menu) this.#host.close(this.#menu);
    window.removeEventListener('pointermove', this.#turned, { capture: true });
    window.removeEventListener('contextmenu', this.#noContextMenu, { capture: true });
    const { play, avatar } = this.#setup.view;
    if (play.cameraOverride === this.#camera) play.cameraOverride = undefined;
    play.extraLights = [];
    avatar.animatesInMenus = false;
    avatar.hold(undefined);
    this.#session.playerLook.release();
    this.#setup.closed();
  }
}
