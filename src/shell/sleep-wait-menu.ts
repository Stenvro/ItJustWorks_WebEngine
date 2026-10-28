// Waiting and sleeping (interface\sleepwaitmenu.swf: T, or a bed): how many hours, on a slider.
// The engine tells the menu whether the player sleeps (_root.SleepWaitMenu_mc.SetSleeping: "Rest
// how long?" or "Wait how long?") and the date and time (SetCurrentTime, as the tween menu
// shows it); OK(hours) passes the time iSecondsToSleepPerUpdate game seconds an update (900:
// a quarter hour; the menu's time and hours counting down) and closes the menu, Cancel closes it. A sleep tells the scripts registered for it
// (RegisterForSleep): OnSleepStart(start, desired end) and OnSleepStop(interrupted), in game
// days. Each hour health, magicka and stamina regenerate as over the real seconds it stands for
// (the progression engine's passTime). Where the player may not wait the menu does not open and
// the game's message says why (sNoWaitDefault while scripts disable waiting, SetInChargen;
// sNoWaitInAir; the sleep versions), while someone fights the player (sNoWaitHostileActorsNear)
// or an effect takes their health (sNoWaitTakingHealthDamage). After the hours the actors are
// where their packages had them meanwhile (src/shell/actor-stage.ts, timeSkipped); an attack
// breaks the wait off (a sleep is told it was interrupted).
// Nor while guards pursue the player (sNoWaitWhileAlarm) or they trespass (sNoWaitTrespass;
// the sleep versions); an owned bed is not slept in (sNoSleepInOwnedBed: play-mode.ts).
// The rested bonuses are the scripts': PlayerSleepQuest registers for sleep and its OnSleepStop
// gives Rested, Well Rested or Lover's Comfort (abilities: the magic system's lasting effects).

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { formatGameDate } from '../world/game-time.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

const ROOT = '_root.SleepWaitMenu_mc';

/**
 * The game's update rate the hours pass at (observed in the original: each update of a
 * wait or sleep passes iSecondsToSleepPerUpdate game seconds, 900: an hour in four updates).
 */
const UPDATE_MS = 1000 / 60;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class SleepWaitMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;

  /** The hours have passed (slept, or waited): Play's autosave. */
  onPassed: ((slept: boolean) => void) | undefined;

  constructor(host: MenuHost, session: GameSession, terminal: Terminal) {
    this.#host = host;
    this.#session = session;
    this.#terminal = terminal;
  }

  /** The date and time as the menus show them ("Sundas, 7:12 PM, 17th of Last Seed, 4E 201"). */
  async #now(): Promise<string> {
    const runtime = this.#session.scriptsReady;
    const settings = await this.#session.settings();
    return runtime
      ? formatGameDate(runtime.date, runtime.dayOfWeek, runtime.gameHour, (name) =>
          settings.string(name),
        )
      : '';
  }

  /** Opens the menu; `closed` once it has closed (after the hours have passed, or cancelled). */
  async open(sleeping: boolean, depth: number, closed: () => void): Promise<Menu> {
    let done = false;
    let passing = false;
    const close = (menu: Menu): void => {
      if (done) return;
      done = true;
      this.#host.close(menu);
      closed();
    };
    const now = await this.#now();
    return this.#host.open('sleepwaitmenu.swf', {
      depth,
      interactive: true,
      handlers: {
        OK: (menu, args) => {
          if (passing) return;
          passing = true;
          const hours = typeof args[1] === 'number' ? Math.max(0, Math.floor(args[1])) : 0;
          this.#pass(menu, hours, sleeping)
            .catch((error: unknown) => {
              this.#terminal.log(
                'ui',
                `the hours do not pass: ${error instanceof Error ? error.message : String(error)}`,
                'error',
              );
            })
            .finally(() => {
              close(menu);
            });
        },
        Cancel: (menu) => {
          if (!passing) close(menu);
        },
      },
      setup: async (menu) => {
        await menu.waitFor('_root.InitExtensions');
        menu.invoke('_root.InitExtensions');
        menu.tellPlatform('_root.SetPlatform');
        menu.invoke(`${ROOT}.SetSleeping`, sleeping);
        menu.invoke(`${ROOT}.SetCurrentTime`, now);
      },
    });
  }

  /**
   * The hours pass iSecondsToSleepPerUpdate game seconds an update, the scripts' timers with
   * them, the menu counting the hours left down; a sleep tells its listeners.
   */
  async #pass(menu: Menu, hours: number, sleeping: boolean): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const settings = await session.settings();
    const perUpdate = Math.max(1, settings.number('iSecondsToSleepPerUpdate') ?? 900) / 3600;
    const start = runtime.state.gameDaysPassed;
    // The hub tells it (TESSleepStartEvent / TESWaitStartEvent: OnSleepStart to those registered).
    if (sleeping) {
      await runtime.events.emitted('sleep', {
        started: true,
        interrupted: false,
        start,
        end: start + hours / 24,
      });
    } else runtime.events.emit('wait', { started: true, interrupted: false });
    let interrupted = false;
    for (let left = hours; left > 1e-6;) {
      await wait(UPDATE_MS);
      // Someone attacks: the hours stop there.
      if (session.combatWatch?.fightingPlayer === true) {
        interrupted = true;
        break;
      }
      const step = Math.min(perUpdate, left);
      left -= step;
      session.advanceClock(step);
      runtime.update(0, step / 24);
      // Health, magicka and stamina regenerate over the time (its real seconds).
      await runtime.progression.passTime(step);
      const shown = Math.ceil(left - 1e-6);
      menu.set(`${ROOT}.HoursSlider.value`, shown);
      menu.set(`${ROOT}.HoursText.text`, String(shown));
      menu.invoke(`${ROOT}.SetCurrentTime`, await this.#now());
    }
    await wait(UPDATE_MS);
    for (const listener of session.timeSkipped) listener();
    if (sleeping) await runtime.events.emitted('sleep', { started: false, interrupted });
    else runtime.events.emit('wait', { started: false, interrupted });
    // The autosave after resting or waiting (bSaveOnRest, bSaveOnWait).
    this.onPassed?.(sleeping);
  }
}
