// The help messages scripts show (Message.ShowAsHelpMessage) while they wait for the player's
// input event. The original keeps those waiting in its save (the interface's global data, 102:
// docs/formats/ess.md) as observed there: each its input event, text, seconds shown (none or
// less: for ever), interval, times left (−1: no limit) and seconds since last shown, and which
// one shows now. Each counts its seconds; past its interval its text shows (one at a time) and
// its times left go down; the one showing goes once its seconds are up. Ours keeps the same in
// the game state (GameState.helpWaiting), so a save holds them and a loaded game shows them on
// from where they were.

/** A help message waiting for its event (keyed by the event, lower case). */
export interface WaitingHelp {
  readonly text: string;
  /** The user event that ends it ("Activate", "Jump", ...). */
  readonly event: string;
  /** Seconds it shows (0 or less: until its event). */
  readonly seconds: number;
  /** Seconds from one showing to the next. */
  readonly interval: number;
  /** The times it may still show (−1: no limit). */
  timesLeft: number;
  /** Seconds since it last showed. */
  since: number;
  /** Showing now (at most one does). */
  showing: boolean;
}

/** What the HUD is to do with a frame's passing: texts to hide, then to show. */
export interface HelpChanges {
  readonly show: WaitingHelp[];
  readonly hide: WaitingHelp[];
}

export class HelpMessages {
  readonly #waiting: Map<string, WaitingHelp>;
  readonly #done: Set<string>;

  /** Over the game state's lists (GameState.helpWaiting, helpDone). */
  constructor(waiting: Map<string, WaitingHelp>, done: Set<string>) {
    this.#waiting = waiting;
    this.#done = done;
  }

  /**
   * ShowAsHelpMessage (times 0: no limit): shown at once, in place of the one showing and of
   * one of its event; nothing for an event the player has done. Returns those to hide and the
   * new one. TODO(M13): inferred that a new message takes the place of the one showing.
   */
  start(message: {
    readonly text: string;
    readonly event: string;
    readonly seconds: number;
    readonly interval: number;
    readonly times: number;
  }): { hide: WaitingHelp[]; started?: WaitingHelp } {
    const key = message.event.toLowerCase();
    if (this.#done.has(key)) return { hide: [] };
    const hide = [...this.#waiting.values()].filter((help) => help.showing);
    for (const help of hide) help.showing = false;
    const started: WaitingHelp = {
      text: message.text,
      event: message.event,
      seconds: message.seconds,
      interval: message.interval,
      timesLeft: message.times > 0 ? message.times - 1 : -1,
      since: 0,
      showing: true,
    };
    this.#waiting.delete(key);
    this.#waiting.set(key, started);
    return { hide, started };
  }

  /** The player did an event: its help ends and is not shown again until reset. */
  done(event: string): WaitingHelp | undefined {
    const key = event.toLowerCase();
    const help = this.#waiting.get(key);
    if (!help) return undefined;
    this.#waiting.delete(key);
    this.#done.add(key);
    return help;
  }

  /** ResetHelpMessage: the help for the event may show again. */
  reset(event: string): void {
    this.#done.delete(event.toLowerCase());
  }

  /** The one showing now (to show again on a HUD that opened anew, or after a load). */
  showing(): WaitingHelp | undefined {
    for (const help of this.#waiting.values()) if (help.showing) return help;
    return undefined;
  }

  /**
   * Seconds pass: the one showing goes once its seconds are up (and is dropped with no times
   * left); then, with none showing, the first past its interval shows.
   */
  advance(seconds: number): HelpChanges {
    const show: WaitingHelp[] = [];
    const hide: WaitingHelp[] = [];
    let current: WaitingHelp | undefined;
    for (const help of this.#waiting.values()) {
      help.since += seconds;
      if (help.showing) current = help;
    }
    if (current && current.seconds > 0 && current.since >= current.seconds) {
      current.showing = false;
      hide.push(current);
      if (current.timesLeft === 0) this.#waiting.delete(current.event.toLowerCase());
      current = undefined;
    }
    if (!current) {
      for (const help of this.#waiting.values()) {
        if (help.showing || help.timesLeft === 0 || help.since < help.interval) continue;
        help.showing = true;
        help.since = 0;
        if (help.timesLeft > 0) help.timesLeft--;
        show.push(help);
        break;
      }
    }
    return { show, hide };
  }
}
