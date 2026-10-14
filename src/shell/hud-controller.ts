// The game's HUD in Play: interface\hudmenu.swf, driven as the engine drives it. It opens with
// HUDMovieBaseInstance.InitExtensions and the platform; every frame the engine sends what it
// shows (GameDelegate callbacks): the compass (SetCompassAngle: the heading, 0 north, 90 east,
// in degrees), the health, magicka and stamina meters (Set...MeterPercent, 0..100), what the
// crosshair is on (SetCrosshairTarget: whether it can be activated, the verb and name, the
// activate button), the messages scripts post (ShowMessage: Debug.Notification's list at the
// top left), quest updates (ShowNotification, one at a time as the HUD says it can show one),
// and help messages (ShowTutorialHintText, their "[Event]" keys as button art).
// Notes: docs/ui.md.
// TODO(M9): compass markers (quests, map markers), a map marker discovered (SetLocationName
// with sDiscoveredText), subtitles, enemy health, shout meter, HUD modes.

import type { ControlMap } from '../formats/controlmap/controlmap.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { QuestUpdate, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { buttonArt } from '../ui/button-art.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import type { HelpMessage, HudSignals, HudSink, HudTarget } from './hud-signals.ts';

/** What the HUD reads of the game every frame. */
export interface HudSource {
  /** The player's heading: radians, 0 north (+Y), π/2 east (+X). */
  heading(): number | undefined;
  runtime(): ScriptRuntime | undefined;
  /** The input bindings (help messages show the keys of the events they name). */
  readonly controls: Promise<ControlMap>;
  readonly settings: Promise<GameSettings>;
}

/** The HUD's depth among the menus. */
const HUD_DEPTH = 2;

const BASE = '_root.HUDMovieBaseInstance';
/** The quest notifications (the HUD's QuestNotification). */
const QUESTS = `${BASE}.QuestUpdateBaseInstance`;

/** QuestNotification's notification types. */
const NotificationType = { quest: 0 } as const;

/** Quest type: miscellaneous objectives (no quest of their own is announced). */
const MISC_QUEST = 6;

/** A quest notification waiting for the HUD. */
interface QuestNotice {
  readonly quest: number;
  /** The quest's name (empty: only objectives). */
  readonly text: string;
  readonly status: string;
  /** The UI sound it plays (SNDR/SOUN editor id; empty: none). */
  readonly sound: string;
  /** Pairs: an objective's text, its status ("" new, "Completed", "Failed"). */
  readonly objectives: string[];
}

/** A help message being shown: its timers. */
interface ShownHelp {
  readonly message: HelpMessage;
  shown: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class HudController implements HudSink {
  readonly #host: MenuHost;
  readonly #signals: HudSignals;
  readonly #source: HudSource;
  #menu: Menu | undefined;
  #frame = 0;
  #shown = { heading: Number.NaN, health: -1, magicka: -1, stamina: -1 };
  /** The meters are read now and then (the runtime answers asynchronously). */
  #readingMeters = false;
  #controls: ControlMap | undefined;
  #settings: GameSettings | undefined;
  readonly #notices: QuestNotice[] = [];
  /** Help messages by their event (lower case). */
  readonly #help = new Map<string, ShownHelp>();
  /** Events whose help the player has done (they are not shown again until reset). */
  readonly #helpDone = new Set<string>();

  constructor(host: MenuHost, signals: HudSignals, source: HudSource) {
    this.#host = host;
    this.#signals = signals;
    this.#source = source;
  }

  async open(): Promise<void> {
    [this.#controls, this.#settings] = await Promise.all([
      this.#source.controls,
      this.#source.settings,
    ]);
    this.#menu = await this.#host.open('hudmenu.swf', {
      depth: HUD_DEPTH,
      interactive: false,
      handlers: {
        // TODO(M9): the HUD's components registered for SkyUI-like widgets (none in vanilla).
        RegisterHUDComponents: () => undefined,
        // A help text's "[Event]": the art of the key bound to it, answered at once (the HUD
        // reads it right after asking).
        GetButtonFromUserEvent: (menu, args) => {
          menu.respond(args[0], buttonArt(this.#userEvent(String(args[1]))));
        },
      },
      setup: async (menu) => {
        await menu.waitFor(`${BASE}.InitExtensions`);
        menu.invoke(`${BASE}.InitExtensions`);
        menu.invoke(`${BASE}.SetPlatform`, 0, false);
        // Everything the HUD shows anew after a reload.
        this.#shown = { heading: Number.NaN, health: -1, magicka: -1, stamina: -1 };
      },
    });
    this.#signals.sink = this;
    const tick = (): void => {
      this.#update();
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  close(): void {
    cancelAnimationFrame(this.#frame);
    for (const help of this.#help.values()) clearTimeout(help.timer);
    this.#help.clear();
    if (this.#signals.sink === this) this.#signals.sink = undefined;
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
  }

  target(target: HudTarget | undefined): void {
    const menu = this.#menu;
    if (!menu) return;
    // (abActivate, aName, abShowButton, abTextOnly, abFavorMode, abShowCrosshair, aWeight,
    // aCost, aFieldValue, aFieldText): the verb over the name, the activate button shown.
    menu.call(
      'SetCrosshairTarget',
      target !== undefined,
      target ? `${target.verb}\n${target.name}` : '',
      target !== undefined,
      false,
      false,
      true,
      0,
      0,
      0,
      '',
    );
  }

  notification(text: string): void {
    this.#menu?.call('ShowMessage', text);
  }

  /**
   * A quest's update, as the HUD announces it: a quest's first objective shown announces the
   * quest (its name, the UIQuestNew sound) with the objective under it; later objectives come
   * as lines of their own (sHUDCompleted / sHUDFailed before them once done); a quest
   * completed or failed is announced by name after sQuestCompletedText / sQuestFailed ("Quest
   * completed: ..."). Miscellaneous objectives and quests without a name show only their lines.
   */
  questUpdate(update: QuestUpdate): void {
    const setting = (name: string, fallback: string): string =>
      this.#settings?.string(name) ?? fallback;
    const status = (key: 'Completed' | 'Failed'): string => setting(`sHUD${key}`, key);
    const announced = update.name !== '' && update.type !== MISC_QUEST;
    const { objective } = update;
    if (!objective) {
      if (!announced) return;
      const completed = update.status === 'completed';
      this.#notices.push({
        quest: update.quest,
        text: update.name,
        status: completed
          ? setting('sQuestCompletedText', 'Quest completed')
          : setting('sQuestFailed', 'Quest FAILED'),
        // TODO(M9): a sound for a failed quest (the data has none named for it).
        sound: completed ? 'UIQuestComplete' : '',
        objectives: [],
      });
      return;
    }
    if (!objective.text) return;
    const line = [
      objective.text,
      update.status === 'shown'
        ? ''
        : status(update.status === 'completed' ? 'Completed' : 'Failed'),
    ];
    if (update.first && update.status === 'shown' && announced) {
      this.#notices.push({
        quest: update.quest,
        text: update.name,
        status: '',
        sound: 'UIQuestNew',
        objectives: line,
      });
      return;
    }
    // Lines that come together are shown together (a stage shows several objectives at once).
    const last = this.#notices[this.#notices.length - 1];
    if (last && (last.quest === update.quest || last.text === '')) last.objectives.push(...line);
    else
      this.#notices.push({
        quest: update.quest,
        text: '',
        status: '',
        sound: '',
        objectives: line,
      });
  }

  /**
   * A help message: shown for its seconds, again after its interval, at most its times (0: no
   * limit), until the player does its event; one done is not shown again until reset.
   */
  helpMessage(message: HelpMessage): void {
    const key = message.event.toLowerCase();
    if (this.#helpDone.has(key)) return;
    this.#hideHelp(key);
    const help: ShownHelp = { message, shown: 0, timer: undefined };
    this.#help.set(key, help);
    this.#showHelp(key, help);
  }

  resetHelpMessage(event: string): void {
    this.#helpDone.delete(event.toLowerCase());
  }

  userEvent(name: string): void {
    const key = name.toLowerCase();
    if (!this.#help.has(key)) return;
    this.#hideHelp(key);
    this.#helpDone.add(key);
  }

  #showHelp(key: string, help: ShownHelp): void {
    const { message } = help;
    help.shown++;
    this.#menu?.call('ShowTutorialHintText', message.text, true);
    help.timer = setTimeout(() => {
      this.#menu?.call('ShowTutorialHintText', message.text, false);
      if (message.times > 0 && help.shown >= message.times) {
        this.#help.delete(key);
        return;
      }
      help.timer = setTimeout(() => {
        if (this.#help.get(key) === help) this.#showHelp(key, help);
      }, message.interval * 1000);
    }, message.seconds * 1000);
  }

  #hideHelp(key: string): void {
    const help = this.#help.get(key);
    if (!help) return;
    clearTimeout(help.timer);
    this.#help.delete(key);
    this.#menu?.call('ShowTutorialHintText', help.message.text, false);
  }

  /** A user event by name, from the gameplay bindings first. */
  #userEvent(name: string): ControlMap['contexts'][number][number] | undefined {
    const wanted = name.toLowerCase();
    for (const events of this.#controls?.contexts ?? []) {
      const event = events.find((entry) => entry.name.toLowerCase() === wanted);
      if (event) return event;
    }
    return undefined;
  }

  #update(): void {
    const menu = this.#menu;
    if (!menu) return;
    const heading = this.#source.heading();
    if (heading !== undefined) {
      const degrees = ((((heading * 180) / Math.PI) % 360) + 360) % 360;
      if (Math.abs(degrees - this.#shown.heading) > 0.05) {
        this.#shown.heading = degrees;
        menu.call('SetCompassAngle', degrees, degrees, true);
      }
    }
    this.#showNotice(menu);
    if (!this.#readingMeters) {
      this.#readingMeters = true;
      void this.#updateMeters(menu).finally(() => {
        this.#readingMeters = false;
      });
    }
  }

  /** The next quest notification, once the HUD can show one (the last one has played out). */
  #showNotice(menu: Menu): void {
    const notice = this.#notices[0];
    if (!notice || menu.invoke(`${QUESTS}.CanShowNotification`) !== true) return;
    this.#notices.shift();
    menu.set(`${QUESTS}.ObjectivesA`, notice.objectives);
    // (aNotificationText, aStatus, aSoundID, aObjectiveCount, aNotificationType, aLevel,
    // aStartPercent, aEndPercent, aDragonText)
    menu.call(
      'ShowNotification',
      notice.text,
      notice.status,
      notice.sound,
      notice.objectives.length / 2,
      NotificationType.quest,
      0,
      0,
      0,
      '',
    );
  }

  async #updateMeters(menu: Menu): Promise<void> {
    const runtime = this.#source.runtime();
    if (!runtime) return;
    const percent = async (index: number): Promise<number> => {
      const value = await runtime.actors.value(PLAYER_REF, index);
      return value.max > 0 ? Math.max(0, Math.min(100, (value.current / value.max) * 100)) : 0;
    };
    const [health, magicka, stamina] = await Promise.all([
      percent(ActorValue.health),
      percent(ActorValue.magicka),
      percent(ActorValue.stamina),
    ]);
    if (menu !== this.#menu) return;
    if (health !== this.#shown.health) menu.call('SetHealthMeterPercent', health, false);
    if (magicka !== this.#shown.magicka) menu.call('SetMagickaMeterPercent', magicka, false);
    if (stamina !== this.#shown.stamina) menu.call('SetStaminaMeterPercent', stamina, false);
    this.#shown = { ...this.#shown, health, magicka, stamina };
  }
}
