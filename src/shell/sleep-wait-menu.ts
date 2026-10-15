// Waiting and sleeping (interface\sleepwaitmenu.swf: T, or a bed): how many hours, on a slider.
// The engine tells the menu whether the player sleeps (_root.SleepWaitMenu_mc.SetSleeping: "Rest
// how long?" or "Wait how long?") and the date and time (SetCurrentTime, as the tween menu
// shows it); OK(hours) passes the time an hour at a time (the menu's time and hours counting
// down) and closes the menu, Cancel closes it. A sleep tells the scripts registered for it
// (RegisterForSleep): OnSleepStart(start, desired end) and OnSleepStop(interrupted), in game
// days. Where the player may not wait the menu does not open and the game's message says why
// (sNoWaitDefault while scripts disable waiting, SetInChargen; sNoWaitInAir; the sleep
// versions). TODO(M10): enemies near (sNoWaitHostileActorsNear) and actors' places after the
// hours (their packages), the wait broken off by an attack. TODO(M11): guards pursuing,
// trespassing, taking health damage, owned beds; health and magicka restored by the hours.

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import { formatGameDate } from '../world/game-time.ts';
import type { GameSession } from './game-session.ts';
import type { Terminal } from './terminal.ts';

const ROOT = '_root.SleepWaitMenu_mc';

/**
 * How long one game hour takes to pass on screen (ms): the game does not document its pace;
 * the hours count down visibly, a day in a few seconds.
 */
const HOUR_MS = 200;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Why the player may not wait (or sleep) now: the setting of the game's message, if any. */
export function noWaitReason(
  sleeping: boolean,
  state: { readonly waitingDisabled: boolean; readonly inAir: boolean },
): string | undefined {
  const kind = sleeping ? 'Sleep' : 'Wait';
  if (state.waitingDisabled) return `sNo${kind}Default`;
  if (state.inAir) return `sNo${kind}InAir`;
  return undefined;
}

export class SleepWaitMenu {
  readonly #host: MenuHost;
  readonly #session: GameSession;
  readonly #terminal: Terminal;

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
      keyAs: { Escape: 'Tab', KeyE: 'Enter' },
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
        menu.invoke('_root.SetPlatform', 0, false);
        menu.invoke(`${ROOT}.SetSleeping`, sleeping);
        menu.invoke(`${ROOT}.SetCurrentTime`, now);
      },
    });
  }

  /** The hours pass one at a time, the scripts' timers with them; a sleep tells its listeners. */
  async #pass(menu: Menu, hours: number, sleeping: boolean): Promise<void> {
    const session = this.#session;
    const runtime = session.scriptsReady;
    if (!runtime) return;
    const start = runtime.state.gameDaysPassed;
    if (sleeping) {
      await runtime.registeredEvent('sleep', 'OnSleepStart', [start, start + hours / 24]);
    }
    for (let left = hours; left > 0; left--) {
      await wait(HOUR_MS);
      session.advanceClock(1);
      runtime.update(0, 1 / 24);
      menu.set(`${ROOT}.HoursSlider.value`, left - 1);
      menu.set(`${ROOT}.HoursText.text`, String(left - 1));
      menu.invoke(`${ROOT}.SetCurrentTime`, await this.#now());
    }
    await wait(HOUR_MS);
    if (sleeping) await runtime.registeredEvent('sleep', 'OnSleepStop', [false]);
  }
}
