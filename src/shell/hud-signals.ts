// What the game tells its HUD as it plays: the activation target under the crosshair, the
// notifications scripts post (Debug.Notification), quest updates, help messages, skill
// increases and the meters blinking (the progression engine's listener), and the user
// events the player presses (a help message waits for one); and the message boxes scripts
// show. The play session and the scripts' world send here; in Play the HUD (the game's
// hudmenu.swf, hud-controller.ts) and the message boxes (message-boxes.ts) listen, and the
// sandbox shows them its own way (the prompt, the terminal).

import type {
  ProgressionListener,
  SkillIncrease,
} from '../scripting/runtime/progression-engine.ts';
import type { MenuRequest, QuestUpdate } from '../scripting/runtime/runtime.ts';
import type { PlacedActor } from './actors.ts';
import type { StealthReading } from './hud-stealth.ts';
import type { ObjectUses } from './play-session.ts';

export interface HudTarget {
  /** "Open", "Take", ... */
  readonly verb: string;
  /** What it is (a door's destination, an item's name). */
  readonly name: string;
  /** A third line under the name (a lock's level, "Empty"), if any. */
  readonly detail?: string;
  /** An item's weight and value (shown under its name). */
  readonly item?: { readonly weight: number; readonly value: number };
}

/** Message.ShowAsHelpMessage's: shown for `seconds` every `interval`, at most `times` times. */
export interface HelpMessage {
  readonly text: string;
  /** The user event that ends it ("Activate", "Jump", ...). */
  readonly event: string;
  readonly seconds: number;
  readonly interval: number;
  readonly times: number;
}

export interface HudSink {
  /** What the crosshair rests on; `favor`: a follower's command mode (its own crosshair). */
  target(target: HudTarget | undefined, favor?: boolean): void;
  notification(text: string): void;
  questUpdate(update: QuestUpdate): void;
  helpMessage(message: HelpMessage): void;
  resetHelpMessage(event: string): void;
  userEvent(name: string): void;
  /**
   * A HUD mode on or off (the HUD shows the elements of its last mode: "TweenMode",
   * "InventoryMode", "DialogueMode", "BookMode", "BarterMode", "WorldMapMode", ...).
   */
  mode(name: string, on: boolean): void;
  /** The HUD shows or steps aside (behind a menu that covers the game: the journal, ...). */
  shown(on: boolean): void;
  /** A subtitle of speech around the player (undefined: none). */
  subtitle(text: string | undefined): void;
  /** The player entered a location: its name. */
  location(name: string): void;
  /** A place discovered (a map marker reached): its name and the status ("discovered"). */
  discovered(name: string, status: string): void;
  /** A load door's prompt kept while its place loads (undefined: the load is done). */
  loadDoor(text: string | undefined): void;
  /** A skill of the player rose: its notice with the level meter. */
  skillIncreased?(increase: SkillIncrease): void;
  /** The magicka or stamina meter blinks (the player lacked it). */
  meterBlink?(meter: 'magicka' | 'stamina'): void;
  /** The enemy the player fights: its name and health (0..100); undefined: none shown. */
  enemy?(enemy: { readonly name: string; readonly health: number } | undefined): void;
}

/** What shows the game's menus that scripts open (Play). */
export interface MenuSink {
  /** A message box; resolves to the button pressed. */
  messageBox(text: string, buttons: readonly string[]): Promise<number>;
  /** A gameplay user event the player pressed (the tween menu's Tab, the journal's J). */
  userEvent(name: string): void;
  /** The player talks to an actor (the dialogue menu). */
  /**
   * A conversation with an actor; `opening`: it begins with that topic's line (a package's
   * ForceGreet) instead of its greeting.
   */
  talk(speaker: PlacedActor, opening?: number): void;
  /** A container's menu (a chest, a corpse searched); `closed` once it has closed. */
  container(reference: number, closed: () => void): void;
  /** A menu a script opens; resolves once it has closed, with what it returns. */
  open(request: MenuRequest): Promise<number>;
  /** Game.FastTravel: the player fast travels to a reference. */
  fastTravel(destination: number): void;
  /** The player died (src/shell/player-death.ts): the menus dying ends close. */
  playerDied?(): void;
  /** fPlayerDeathReloadTime after the death: the game loads its most recent save. */
  reloadAfterDeath?(): void;
  /** A tutorial (a default object's help message: HBFT), the first time. */
  tutorial?(use: string): void;
  /** Whether a menu takes the keys now: the player's controls get none of them. */
  takesKeys?(): boolean;
}

/** What covers the screen (Play, from its main menu on: a new game's opening uses them). */
export interface ScreenSink {
  /** The opening's title cards: shown, one played, hidden. */
  titles(action: 'show' | 'hide' | 'start', name?: string): void;
  /** Game.FadeOutGame: the game fades out (and stays so) or in, to black or white. */
  fade(out: boolean, black: boolean, secondsBefore: number, duration: number): void;
  /** Game.PlayBink: a video over the game (DataVideo). */
  video(file: string): void;
}

export class HudSignals implements ProgressionListener {
  /** The HUD listening (Play), if any. */
  sink: HudSink | undefined;
  /** The menus (Play), if any. */
  menus: MenuSink | undefined;
  /** The fader and the title cards (Play), if any. */
  screen: ScreenSink | undefined;
  /** What activating containers and items does (Play), if anything. */
  uses: ObjectUses | undefined;
  /** A follower's command mode (src/shell/actor-favors.ts): Tab leaves it (true: it was on). */
  favors: { cancel(): boolean } | undefined;
  /**
   * The stealth meter's reading (the play's senses: src/shell/actor-senses.ts), read by the HUD
   * every frame; undefined: no play.
   */
  stealth: (() => StealthReading) | undefined;

  /** Whether a HUD shows these (the sandbox's own prompt and notices then stay quiet). */
  get listening(): boolean {
    return this.sink !== undefined;
  }

  target(target: HudTarget | undefined, favor = false): void {
    this.sink?.target(target, favor);
  }

  notification(text: string): void {
    this.sink?.notification(text);
  }

  questUpdate(update: QuestUpdate): void {
    this.sink?.questUpdate(update);
  }

  helpMessage(message: HelpMessage): void {
    this.sink?.helpMessage(message);
  }

  resetHelpMessage(event: string): void {
    this.sink?.resetHelpMessage(event);
  }

  mode(name: string, on: boolean): void {
    this.sink?.mode(name, on);
  }

  shown(on: boolean): void {
    this.sink?.shown(on);
  }

  subtitle(text: string | undefined): void {
    this.sink?.subtitle(text);
  }

  location(name: string): void {
    this.sink?.location(name);
  }

  discovered(name: string, status: string): void {
    this.sink?.discovered(name, status);
  }

  loadDoor(text: string | undefined): void {
    this.sink?.loadDoor(text);
  }

  skillIncreased(increase: SkillIncrease): void {
    this.sink?.skillIncreased?.(increase);
  }

  meterBlink(meter: 'magicka' | 'stamina'): void {
    this.sink?.meterBlink?.(meter);
  }

  enemy(enemy: { readonly name: string; readonly health: number } | undefined): void {
    this.sink?.enemy?.(enemy);
  }

  userEvent(name: string): void {
    this.sink?.userEvent(name);
    // Tab in a follower's command mode leaves it (actor-favors.ts) instead of opening a menu.
    if (name.toLowerCase() === 'tween menu' && this.favors?.cancel() === true) return;
    this.menus?.userEvent(name);
  }
}
