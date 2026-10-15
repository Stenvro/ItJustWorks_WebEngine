// The game's fades to black or white over everything (interface\fadermenu.swf), as
// Game.FadeOutGame(abFadingOut, abBlackFade, afSecsBeforeFade, afFadeDuration) asks for them.
// The movie's FaderMenu (mc_FaderMenu, its callbacks registered by InitExtensions) takes
// InitFade(fading in: the rect starts opaque, black: unless false, white, duration, seconds
// before it starts) and then the seconds that pass,
// UpdateFade(seconds), every frame; it calls FadeDone at the end. Faded out it stays until a fade
// in, which closes it as it is done. Notes: docs/ui.md ("Fades").

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { Terminal } from './terminal.ts';

/** Over the HUD and the game's menus, under the title cards and the loading menu. */
const FADER_DEPTH = 7;

export class FaderMenu {
  readonly #host: MenuHost;
  readonly #terminal: Terminal;
  #menu: Promise<Menu> | undefined;
  /** The fade under way (its frame loop), and whether it fades out. */
  #fading: { out: boolean; last: number; frame: number } | undefined;

  /** Whether the game stands still under a loading screen: the fade waits for it. */
  readonly #paused: () => boolean;

  constructor(host: MenuHost, terminal: Terminal, paused: () => boolean) {
    this.#host = host;
    this.#terminal = terminal;
    this.#paused = paused;
  }

  /** Game.FadeOutGame: a fade out (it stays) or in (it goes), to black or white. */
  fade(out: boolean, black: boolean, secondsBefore: number, duration: number): void {
    const menu = this.#open();
    void menu.then((opened) => {
      opened.call('InitFade', !out, black, Math.max(0, duration), Math.max(0, secondsBefore));
      this.#run(opened, out);
    });
  }

  /** Takes the fade away at once (Play ends). */
  close(): void {
    if (this.#fading) cancelAnimationFrame(this.#fading.frame);
    this.#fading = undefined;
    const menu = this.#menu;
    this.#menu = undefined;
    void menu?.then((opened) => {
      this.#host.close(opened);
    });
  }

  #open(): Promise<Menu> {
    this.#menu ??= this.#host
      .open('fadermenu.swf', {
        depth: FADER_DEPTH,
        interactive: false,
        handlers: {
          FadeDone: (menu) => {
            const fading = this.#fading;
            if (!fading) return;
            cancelAnimationFrame(fading.frame);
            this.#fading = undefined;
            // Faded in: nothing is covered any more.
            if (!fading.out && this.#menu) {
              this.#menu = undefined;
              this.#host.close(menu);
            }
          },
        },
        setup: async (menu) => {
          await menu.waitFor('_root.InitExtensions');
          menu.invoke('_root.InitExtensions');
          // The fade covers the whole screen, whatever its shape (the movie's stage is 16:9).
          menu.set('Stage.scaleMode', 'exactFit');
        },
      })
      .catch((error: unknown) => {
        this.#terminal.log(
          'ui',
          `the fader does not open: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        this.#menu = undefined;
        throw error;
      });
    return this.#menu;
  }

  /** UpdateFade every frame with the real seconds that passed (the game may be paused). */
  #run(menu: Menu, out: boolean): void {
    if (this.#fading) cancelAnimationFrame(this.#fading.frame);
    const fading = { out, last: performance.now(), frame: 0 };
    this.#fading = fading;
    const step = (now: number): void => {
      if (this.#fading !== fading) return;
      // A fade asked for while the place loads plays once it is there (as the game's would),
      // hidden until then (the loading screen is on top).
      const paused = this.#paused();
      menu.shown = !paused;
      if (!paused) menu.call('UpdateFade', Math.max(0, (now - fading.last) / 1000));
      fading.last = now;
      fading.frame = requestAnimationFrame(step);
    };
    fading.frame = requestAnimationFrame(step);
  }
}
