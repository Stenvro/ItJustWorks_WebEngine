// The game's HUD in Play: interface\hudmenu.swf, driven as the engine drives it. It opens with
// HUDMovieBaseInstance.InitExtensions and the platform; every frame the engine sends what it
// shows (GameDelegate callbacks): the compass (SetCompassAngle: the heading, 0 north, 90 east,
// in degrees), the health, magicka and stamina meters (Set...MeterPercent, 0..100), what the
// crosshair is on (SetCrosshairTarget: whether it can be activated, the verb and name, the
// activate button), the messages scripts post (ShowMessage: Debug.Notification's list at the
// top left), quest updates (ShowNotification, one at a time as the HUD says it can show one),
// and help messages (ShowTutorialHintText, their "[Event]" keys as button art); a skill
// increase comes as a notification of its own (ShowNotification's SKILL_LEVEL_UPDATE: the
// text, UISkillIncreaseSD, the player's level and the level meter from and to its progress; the
// movie shows its own "level up" once the meter fills); the magicka and stamina meters blink as
// the player lacks them (StartMagickaMeterBlinking, StartStaminaMeterBlinking; health blinks
// of itself when low). The shout meter (SetShoutMeterPercent: 100 once the voice has recovered,
// the casting engine's voiceMeter) flashes as the player shouts before it has
// (FlashShoutMeter). The stealth meter and the sneaking HUD mode: hud-stealth.ts.
// Notes: docs/ui.md.
// The enemy health bar (enemy). The charge meters of the enchanted weapons in the player's hands
// (SetChargeMeterPercent(percent, force, left hand, shown): the crafting engine's charge).
// Riding: HorseMode, with the weapon drawn WarHorseMode (the movie's own element lists).
// The menus' modes come through the menu stack (src/ui/menu-stack.ts); quest notices wait while
// the HUD is hidden or in a mode that does not show them (hud-elements.ts). The meters show as
// they change and while they are not full (hud-elements.ts' MeterFade); a drawn bow or crossbow
// shows its ammo and count (ShowArrowCount); the floating quest marker stands over the nearest
// quest target near enough (FloatingQuestMarkerInstance). Notices of the game's own: a word of
// power learned (sShoutAdded over the word in the dragon letters), a dragon soul absorbed
// (sDragonSoulAcquired), a location cleared (its name, sCleared).

import { inputPlatform, onInputPlatform } from '../ui/input-platform.ts';
import type { CastEvent } from '../scripting/runtime/casting-engine.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { SkillIncrease } from '../scripting/runtime/progression-engine.ts';
import type { QuestUpdate, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import {
  HudModes,
  METER_PAUSE_FRAME,
  MeterFade,
  type FloatingMarker,
  type MeterStep,
} from './hud-elements.ts';
import type { HelpMessage, HudSignals, HudSink, HudTarget } from './hud-signals.ts';
import { StealthMeter } from './hud-stealth.ts';

/** What the HUD reads of the game every frame. */
export interface HudSource {
  /** The player's heading: radians, 0 north (+Y), π/2 east (+X). */
  heading(): number | undefined;
  runtime(): ScriptRuntime | undefined;
  readonly settings: Promise<GameSettings>;
  /** The player's settings (Crosshair, HUD Opacity), and their changes. */
  readonly ini: () => IniSettings;
  readonly onSettingsChange: (listener: () => void) => () => void;
  /** The compass's markers now (CompassTargetDataA: 4 numbers a marker), src/shell/compass.ts. */
  readonly compass?: () => Promise<number[]>;
  /** A text's "[Event]"s as the keys bound to them (the help messages). */
  readonly keyLabels?: (text: string) => string;
  /** The floating quest marker now (hud-elements.ts' floatingMarker), if it shows. */
  readonly floating?: () => FloatingMarker | undefined;
}

/** The image the engine writes before a prompt's third line (InterfaceStrings). */
const DIAMOND_MARKER =
  "<img src='DiamondMarker' width='10' height='15' align='baseline' vspace='5'>";

/** The HUD's depth among the menus. */
const HUD_DEPTH = 2;

const BASE = '_root.HUDMovieBaseInstance';
/** How often the compass's markers are read (ms). */
const COMPASS_INTERVAL_MS = 250;
/** The quest notifications (the HUD's QuestNotification). */
const QUESTS = `${BASE}.QuestUpdateBaseInstance`;

/** QuestNotification's notification types (QUEST_UPDATE, SKILL_LEVEL_UPDATE, ...). */
const NotificationType = { quest: 0, skill: 1, playerLevel: 2, shout: 3 } as const;

/** EquippedItemType of a bow and a crossbow (GetEquippedItemType). */
const BOW = 7;
const CROSSBOW = 12;
/** WEAPON_STATE drawn. */
const WEAPON_DRAWN = 3;

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
  /** A skill increase: the player's level and the level meter's progress from and to (0..1). */
  readonly skill?: { readonly level: number; readonly from: number; readonly to: number };
  /** A word of power: the word in the dragon letters (SHOUT_UPDATE's aDragonText). */
  readonly dragon?: string;
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
  #shown = { heading: Number.NaN };
  /** The meters' showing (hud-elements.ts). */
  readonly #meters = {
    health: new MeterFade(),
    magicka: new MeterFade(),
    stamina: new MeterFade(),
  };
  /** The movie's modes on (ShowElements), and whether the HUD is hidden. */
  readonly #modes = new HudModes();
  #hidden = false;
  /** The player's dragon souls last read (undefined: not yet, for this runtime). */
  #souls: number | undefined;
  /** The arrow info shown ('' hidden; undefined: not sent yet), and the floating marker's. */
  #arrowsShown: string | undefined;
  #floatShown = '';
  /** The runtime whose events the HUD hears (word learned, location cleared). */
  #events: { runtime: ScriptRuntime; stop: () => void } | undefined;
  /** The charge meters shown, by hand (−1: hidden; undefined: not yet). */
  #chargeShown: { left?: number; right?: number } = {};
  /** The shout meter shown (−1: not yet), and the runtime whose casts it hears. */
  #shoutShown = -1;
  #heard: { runtime: ScriptRuntime; stop: () => void } | undefined;
  /** The meters are read now and then (the runtime answers asynchronously). */
  #readingMeters = false;
  #settings: GameSettings | undefined;
  readonly #notices: QuestNotice[] = [];
  /** Help messages by their event (lower case). */
  readonly #help = new Map<string, ShownHelp>();
  /** Events whose help the player has done (they are not shown again until reset). */
  readonly #helpDone = new Set<string>();
  /** The stealth meter (hud-stealth.ts). */
  readonly #stealth = new StealthMeter();

  constructor(host: MenuHost, signals: HudSignals, source: HudSource) {
    this.#host = host;
    this.#signals = signals;
    this.#source = source;
  }

  async open(): Promise<void> {
    this.#settings = await this.#source.settings;
    this.#menu = await this.#host.open('hudmenu.swf', {
      depth: HUD_DEPTH,
      interactive: false,
      handlers: {
        // The HUD hands the engine its sneak text, stealth eye, enemy health and quest update
        // clips, which the engine drives itself by their paths (the stealth meter:
        // hud-stealth.ts; the enemy health bar: enemy).
        RegisterHUDComponents: () => undefined,
      },
      setup: async (menu) => {
        await menu.waitFor(`${BASE}.InitExtensions`);
        menu.invoke(`${BASE}.InitExtensions`);
        menu.invoke(`${BASE}.SetPlatform`, inputPlatform(), false);
        // The button prompts follow the device last used (a gamepad picked up mid-game).
        onInputPlatform((platform) => {
          if (!menu.closed) menu.invoke(`${BASE}.SetPlatform`, platform, false);
        });
        // The engine's HUD reset (observed in the original): the subtitle is set to a blank (" ") before
        // subtitles are enabled, so the movie's placeholder ("Dialogue Line 1 / 2", which its
        // own constructor fails to clear) never shows; only spoken lines replace it.
        menu.call('ShowSubtitle', ' ');
        // Everything the HUD shows anew after a reload.
        this.#shown = { heading: Number.NaN };
        for (const meter of Object.values(this.#meters)) meter.reset();
        this.#modes.reset();
        this.#arrowsShown = undefined;
        this.#floatShown = '';
        this.#shoutShown = -1;
        this.#chargeShown = {};
        this.#cartMode = false;
        this.#stealth.reset();
        // (The HUD is not this.#menu yet as it first opens.)
        this.#applySettings(menu);
      },
    });
    this.#stopSettings = this.#source.onSettingsChange(() => {
      this.#applySettings();
    });
    this.#signals.sink = this;
    const tick = (): void => {
      this.#update();
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  /** The settings Crosshair (SetCrosshairEnabled) and HUD Opacity (the whole HUD's). */
  #applySettings(menu = this.#menu): void {
    if (!menu) return;
    const ini = this.#source.ini();
    menu.call('SetCrosshairEnabled', ini.bool('Main', 'bCrosshairEnabled'));
    menu.call('SetSubtitlesEnabled', ini.bool('Interface', 'bGeneralSubtitles'));
    const element = menu.element;
    if (element) element.style.opacity = String(ini.number('Main', 'fHUDOpacity'));
    // The compass is sent again (bShowCompass rides on SetCompassAngle).
    this.#shown.heading = Number.NaN;
  }

  #stopSettings: (() => void) | undefined;
  /** The CartMode shown (Game.SetHudCartMode). */
  #cartMode = false;
  /** The riding mode shown (HorseMode, WarHorseMode), if any. */
  #horseMode: string | undefined;

  /** The compass's markers: read four times a second, sent when they changed. */
  #compassBusy = false;
  #compassNext = 0;
  #compassShown = '';

  #updateCompass(menu: Menu): void {
    const now = performance.now();
    const read = this.#source.compass;
    if (!read || this.#compassBusy || now < this.#compassNext) return;
    this.#compassBusy = true;
    this.#compassNext = now + COMPASS_INTERVAL_MS;
    read()
      .then((data) => {
        const key = data.map((value) => Math.round(value)).join(',');
        if (key === this.#compassShown || this.#menu !== menu) return;
        this.#compassShown = key;
        menu.set(`${BASE}.CompassTargetDataA`, data);
        menu.call('SetCompassMarkers');
        // The markers take their places as the compass turns: it is turned again.
        this.#shown.heading = Number.NaN;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#compassBusy = false;
      });
  }

  close(): void {
    this.#heard?.stop();
    this.#heard = undefined;
    this.#events?.stop();
    this.#events = undefined;
    this.#stopSettings?.();
    this.#stopSettings = undefined;
    cancelAnimationFrame(this.#frame);
    for (const help of this.#help.values()) clearTimeout(help.timer);
    this.#help.clear();
    if (this.#signals.sink === this) this.#signals.sink = undefined;
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
  }

  target(target: HudTarget | undefined, favor = false): void {
    const menu = this.#menu;
    if (!menu) return;
    // (abActivate, aName, abShowButton, abTextOnly, abFavorMode, abShowCrosshair, aWeight,
    // aCost, aFieldValue, aFieldText): the verb over the name, the activate button shown; a
    // third line (a lock's level, "Empty") after the HUD's diamond marker, as the engine writes
    // it; an item's weight and value under them (the HUD leaves out those that are undefined).
    // In a follower's command mode the crosshair is its Favor frame.
    const lines = target ? [target.verb, target.name] : [];
    if (target?.detail !== undefined) lines.push(`${DIAMOND_MARKER}${target.detail}`);
    menu.call(
      'SetCrosshairTarget',
      target !== undefined,
      lines.join('\n').trim(),
      target !== undefined,
      false,
      favor,
      true,
      target?.item?.weight ?? null,
      target?.item?.value ?? null,
      null,
      null,
    );
  }

  /** A message at the top left, unless the setting bShowHUDMessages turns them off. */
  notification(text: string): void {
    if (!this.#source.ini().bool('Interface', 'bShowHUDMessages')) return;
    this.#menu?.call('ShowMessage', text);
  }

  loadDoor(text: string | undefined): void {
    this.#menu?.call('SetLoadDoorInfo', text !== undefined, text ?? '');
  }

  /** A place discovered: announced as a quest is, its name and the status. */
  discovered(name: string, status: string): void {
    this.#notices.push({ quest: -1, text: name, status, sound: '', objectives: [] });
  }

  location(name: string): void {
    this.#menu?.call('SetLocationName', name);
  }

  subtitle(text: string | undefined): void {
    const menu = this.#menu;
    if (!menu) return;
    if (text === undefined) menu.call('HideSubtitle');
    else menu.call('ShowSubtitle', text);
  }

  shown(on: boolean): void {
    this.#hidden = !on;
    const element = this.#menu?.element;
    if (element) element.style.visibility = on ? '' : 'hidden';
  }

  /** ShowElements(mode, show): the HUD's modes, a stack whose last one says what shows. */
  mode(name: string, on: boolean): void {
    this.#modes.set(name, on);
    this.#menu?.call('ShowElements', name, on);
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
        // A failed quest has no sound: the data has UIQuestNew, UIQuestUpdate and
        // UIQuestComplete only (and the HUD movie plays none for it).
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

  /** A help message's text with its keys written out (Ruffle draws no key art in text). */
  #helpText(message: HelpMessage): string {
    return this.#source.keyLabels?.(message.text) ?? message.text;
  }

  #showHelp(key: string, help: ShownHelp): void {
    const { message } = help;
    help.shown++;
    this.#menu?.call('ShowTutorialHintText', this.#helpText(message), true);
    help.timer = setTimeout(() => {
      this.#menu?.call('ShowTutorialHintText', this.#helpText(message), false);
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
    this.#menu?.call('ShowTutorialHintText', this.#helpText(help.message), false);
  }

  #update(): void {
    const menu = this.#menu;
    if (!menu) return;
    const heading = this.#source.heading();
    if (heading !== undefined) {
      const degrees = ((((heading * 180) / Math.PI) % 360) + 360) % 360;
      // (Not "> 0.05": a heading not shown yet is NaN, which compares false.)
      if (!(Math.abs(degrees - this.#shown.heading) <= 0.05)) {
        this.#shown.heading = degrees;
        // The third: whether the compass shows (bShowCompass).
        const compass = this.#source.ini().bool('Interface', 'bShowCompass');
        menu.call('SetCompassAngle', degrees, degrees, compass);
      }
    }
    // Game.SetHudCartMode (the opening's cart): the HUD's CartMode (only the compass's frame).
    const cart = this.#source.runtime()?.hudCartMode === true;
    if (cart !== this.#cartMode) {
      this.#cartMode = cart;
      this.mode('CartMode', cart);
    }
    // On a horse: HorseMode (the meters, the compass, messages: no crosshair, no stamina), with
    // the weapon drawn WarHorseMode (the crosshair, stamina, the charge and arrow info too).
    const world = this.#source.runtime()?.world;
    const riding = world?.mountOf?.(PLAYER_REF) !== undefined;
    const drawn = riding && (world.combat?.(PLAYER_REF)?.weaponState ?? 0) !== 0;
    const horse = !riding ? undefined : drawn ? 'WarHorseMode' : 'HorseMode';
    if (horse !== this.#horseMode) {
      if (this.#horseMode) this.mode(this.#horseMode, false);
      this.#horseMode = horse;
      if (horse) this.mode(horse, true);
    }
    this.#hear(this.#source.runtime());
    this.#showNotice(menu);
    this.#updateFloating(menu);
    this.#updateCompass(menu);
    this.#updateShoutMeter(menu);
    this.#stealth.update(menu, this.#signals.stealth?.(), performance.now(), {
      detected: this.#settings?.string('sSneakDetected') ?? '[DETECTED]',
      hidden: this.#settings?.string('sSneakHidden') ?? '[HIDDEN]',
    });
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
    // Not while the HUD is hidden or in a mode without its notices (the map, the journal).
    if (!notice || this.#hidden || !this.#modes.showsNotices) return;
    if (menu.invoke(`${QUESTS}.CanShowNotification`) !== true) return;
    this.#notices.shift();
    menu.set(`${QUESTS}.ObjectivesA`, notice.objectives);
    // (aNotificationText, aStatus, aSoundID, aObjectiveCount, aNotificationType, aLevel,
    // aStartPercent, aEndPercent, aDragonText); the percents 0..1.
    menu.call(
      'ShowNotification',
      notice.text,
      notice.status,
      notice.sound,
      notice.objectives.length / 2,
      notice.skill
        ? NotificationType.skill
        : notice.dragon !== undefined
          ? NotificationType.shout
          : NotificationType.quest,
      notice.skill?.level ?? 0,
      notice.skill?.from ?? 0,
      notice.skill?.to ?? 0,
      notice.dragon ?? '',
    );
  }

  /** A skill increase, after the notices before it: "<Skill> Increased to <n>" and the meter. */
  skillIncreased(increase: SkillIncrease): void {
    this.#notices.push({
      quest: -1,
      text: increase.text,
      status: '',
      sound: 'UISkillIncreaseSD',
      objectives: [],
      skill: { level: increase.playerLevel, from: increase.from, to: increase.to },
    });
  }

  /**
   * The shout meter: the voice's recovery as it counts down (whole percents); it flashes as the
   * player shouts before it has recovered (the casting engine's refusal).
   */
  #updateShoutMeter(menu: Menu): void {
    const runtime = this.#source.runtime();
    if (this.#heard?.runtime !== runtime) {
      this.#heard?.stop();
      this.#heard = undefined;
      if (runtime) {
        const listener = (event: CastEvent): void => {
          if (event.actor === PLAYER_REF && event.kind === 'refused' && event.reason === 'voice')
            this.#menu?.call('FlashShoutMeter');
        };
        runtime.casting.listeners.add(listener);
        this.#heard = { runtime, stop: () => runtime.casting.listeners.delete(listener) };
      }
    }
    if (!runtime) return;
    const percent = Math.round(runtime.casting.voiceMeter(PLAYER_REF));
    if (percent === this.#shoutShown) return;
    this.#shoutShown = percent;
    menu.call('SetShoutMeterPercent', percent, false);
  }

  meterBlink(meter: 'magicka' | 'stamina'): void {
    this.#menu?.call(
      meter === 'magicka' ? 'StartMagickaMeterBlinking' : 'StartStaminaMeterBlinking',
    );
  }

  /**
   * The enemy's health (src/shell/actor-combat.ts): the clips the HUD hands the engine
   * (RegisterHUDComponents): EnemyHealth_mc shown, its brackets' RolloverNameInstance named,
   * its meter set through SetEnemyHealthPercent / SetEnemyHealthTargetPercent (0..100).
   * TODO(M13): how the engine fades the bar in and out is not documented: it is shown or not.
   */
  enemy(enemy: { readonly name: string; readonly health: number } | undefined): void {
    const menu = this.#menu;
    if (!menu) return;
    const clip = `${BASE}.EnemyHealth_mc`;
    if (!enemy) {
      menu.set(`${clip}._alpha`, 0);
      return;
    }
    menu.set(`${clip}._alpha`, 100);
    menu.set(`${clip}.BracketsInstance.RolloverNameInstance.text`, enemy.name);
    const percent = Math.max(0, Math.min(100, enemy.health));
    menu.call('SetEnemyHealthPercent', percent);
    menu.call('SetEnemyHealthTargetPercent', percent);
  }

  /**
   * A meter: its percent sent as it changes (the movie plays its fade-in on), or, kept while not
   * full, its clip played on from where it is (the movie's RunMeterAnim) so it does not fade.
   */
  #sendMeter(
    menu: Menu,
    name: 'Health' | 'Magicka' | 'Stamina',
    percent: number,
    step: MeterStep,
  ): void {
    if (step.set) menu.call(`Set${name}MeterPercent`, percent, false);
    else if (step.keep) {
      const clip = `${BASE}.${name}MeterAnim`;
      const frame = menu.get(`${clip}._currentframe`);
      const at = typeof frame === 'number' ? frame : 1;
      // Fading out (played back from its end) or faded: played forward again.
      if (at !== METER_PAUSE_FRAME) menu.invoke(`${clip}.PlayForward`, at);
    }
  }

  /** The events whose notices the HUD shows (the runtime's hub), heard once per runtime. */
  #hear(runtime: ScriptRuntime | undefined): void {
    if (this.#events?.runtime === runtime) return;
    this.#events?.stop();
    this.#events = undefined;
    this.#souls = undefined;
    if (!runtime) return;
    const setting = (name: string, fallback: string): string =>
      this.#settings?.string(name) ?? fallback;
    const stops = [
      // Game.TeachWord: "Word of Power Learned" over the word in the dragon letters.
      runtime.events.on('wordLearned', async ({ word }) => {
        const name = (await runtime.forms.record(word))?.text('FULL') ?? '';
        this.#notices.push({
          quest: -1,
          text: setting('sShoutAdded', 'Word of Power Learned'),
          status: '',
          sound: '',
          objectives: [],
          dragon: name,
        });
      }),
      // A location cleared: its name and "Cleared", as a place discovered is announced.
      runtime.events.on('locationCleared', async ({ location }) => {
        const name = (await runtime.forms.record(location))?.text('FULL') ?? '';
        if (name !== '') this.discovered(name, setting('sCleared', 'Cleared'));
      }),
    ];
    this.#events = {
      runtime,
      stop: () => {
        for (const stop of stops) stop();
      },
    };
  }

  /**
   * A dragon soul absorbed: the player's DragonSouls rose (the absorption adds one;
   * DragonSoulsGained). TODO(M13): the engine raises the notice from the event the absorb
   * sends; the value rising is read here, the first reading of a runtime only noted.
   */
  async #updateSouls(runtime: ScriptRuntime): Promise<void> {
    const souls = (await runtime.actors.value(PLAYER_REF, ActorValue.dragonSouls)).current;
    if (this.#events?.runtime !== runtime) return;
    const before = this.#souls;
    this.#souls = souls;
    if (before === undefined || souls <= before) return;
    this.#notices.push({
      quest: -1,
      text: this.#settings?.string('sDragonSoulAcquired') ?? 'Dragon Soul Absorbed',
      status: '',
      sound: '',
      objectives: [],
    });
  }

  /**
   * The arrow info: a bow or crossbow drawn shows the ammo equipped and how many the player
   * carries (ShowArrowCount(count, hide, name): "Iron Arrow (24)"); hidden otherwise.
   */
  async #updateArrows(menu: Menu, runtime: ScriptRuntime): Promise<void> {
    const drawn = (runtime.world.combat?.(PLAYER_REF)?.weaponState ?? 0) === WEAPON_DRAWN;
    const type = drawn ? await runtime.equipment.itemType(PLAYER_REF, 'right') : 0;
    const ammo =
      type === BOW || type === CROSSBOW ? await runtime.equipment.ammo(PLAYER_REF) : undefined;
    let shown = '';
    let count = 0;
    let name = '';
    if (ammo !== undefined) {
      count = await runtime.itemCount(PLAYER_REF, ammo);
      name = (await runtime.forms.record(ammo))?.text('FULL') ?? '';
      shown = `${name}|${String(count)}`;
    }
    if (menu !== this.#menu || shown === this.#arrowsShown) return;
    this.#arrowsShown = shown;
    menu.call('ShowArrowCount', count, shown === '', name);
  }

  /** The floating quest marker over its target (its clip moved; hidden by its alpha). */
  #updateFloating(menu: Menu): void {
    const ini = this.#source.ini();
    const marker = ini.bool('GamePlay', 'bShowFloatingQuestMarkers')
      ? this.#source.floating?.()
      : undefined;
    const clip = `${BASE}.FloatingQuestMarkerInstance`;
    if (!marker) {
      if (this.#floatShown !== '') menu.set(`${clip}._alpha`, 0);
      this.#floatShown = '';
      return;
    }
    // Screen to stage: the part of the stage the screen shows (Stage.visibleRect).
    const rect = (field: string, fallback: number): number => {
      const value = menu.get(`Stage.visibleRect.${field}`);
      return typeof value === 'number' ? value : fallback;
    };
    const x = rect('x', 0) + marker.screen[0] * rect('width', menu.stageWidth);
    const y = rect('y', 0) + marker.screen[1] * rect('height', menu.stageHeight);
    const key = `${String(Math.round(x))},${String(Math.round(y))},${String(marker.alpha)}`;
    if (key === this.#floatShown) return;
    this.#floatShown = key;
    menu.set(`${clip}._x`, x);
    menu.set(`${clip}._y`, y);
    menu.set(`${clip}._alpha`, marker.alpha);
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
    const now = performance.now();
    const meters = this.#meters;
    this.#sendMeter(menu, 'Health', health, meters.health.step(health, now));
    this.#sendMeter(menu, 'Magicka', magicka, meters.magicka.step(magicka, now));
    const staminaStep = meters.stamina.step(stamina, now);
    this.#sendMeter(menu, 'Stamina', stamina, staminaStep);
    // Stamina filled up: the engine fades it at once (FadeOutStamina); the others fade themselves.
    if (staminaStep.filled) menu.call('FadeOutStamina', stamina);
    await this.#updateSouls(runtime);
    await this.#updateArrows(menu, runtime);
    // Each hand's enchanted weapon: its charge (shown while it holds one).
    for (const hand of ['left', 'right'] as const) {
      const weapon = await runtime.equipment.weapon(PLAYER_REF, hand);
      const charge =
        weapon === undefined ? undefined : await runtime.crafting.chargePercent(PLAYER_REF, weapon);
      const shown = charge === undefined ? -1 : Math.round(charge);
      if (menu !== this.#menu || shown === this.#chargeShown[hand]) continue;
      this.#chargeShown[hand] = shown;
      menu.call('SetChargeMeterPercent', Math.max(0, shown), false, hand === 'left', shown >= 0);
    }
  }
}
