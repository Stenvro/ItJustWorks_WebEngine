// The opening's title cards (interface\titles.swf): the movie holds four sequences
// (sequence1 .. sequence4: a card fading in and out, stopped on an empty first frame).
// Game.ShowTitleSequenceMenu opens it (MQ101's fragment, on the cart), StartTitleSequence(name)
// plays one ("Sequence1": the clip of that name), HideTitleSequenceMenu closes it.
// Notes: docs/ui.md ("Title cards").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { Terminal } from './terminal.ts';

/** Over the fader (the cards show on the opening's black), under the loading menu. */
const TITLES_DEPTH = 8;

export class TitleSequence {
  readonly #host: MenuHost;
  readonly #terminal: Terminal;
  #menu: Promise<Menu | undefined> | undefined;

  /** Whether a loading screen is up: the cards wait under it, hidden. */
  readonly #covered: () => boolean;
  #watch: ReturnType<typeof setInterval> | undefined;

  constructor(host: MenuHost, terminal: Terminal, covered: () => boolean) {
    this.#host = host;
    this.#terminal = terminal;
    this.#covered = covered;
  }

  show(): void {
    this.#watch ??= setInterval(() => {
      void this.#menu?.then((menu) => {
        if (menu) menu.shown = !this.#covered();
      });
    }, 100);
    this.#menu ??= this.#host
      .open('titles.swf', { depth: TITLES_DEPTH, interactive: false })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the titles do not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return undefined;
      });
  }

  /** Plays a sequence (its clip, by the name in lower case). */
  start(name: string): void {
    this.show();
    void this.#menu?.then((menu) => {
      menu?.invoke(`_root.${name.toLowerCase()}.gotoAndPlay`, 1);
    });
  }

  hide(): void {
    if (this.#watch !== undefined) clearInterval(this.#watch);
    this.#watch = undefined;
    const menu = this.#menu;
    this.#menu = undefined;
    void menu?.then((opened) => {
      if (opened) this.#host.close(opened);
    });
  }
}
