// The console (interface\console.swf, ~): the engine sizes it from the INI ([Menu]
// iConsoleSizeScreenPercent, iConsoleTextSize, iConsoleHistoryCharBufferSize), shows it
// (Console.Show(), its slide-in) and hides it (Console.Hide(), then the menu calls
// HideComplete); the player types into its command field, which the player itself (Ruffle)
// takes keys for; Enter makes it call ExecuteCommand(line), and what the command prints goes into
// its history (Console.AddHistory(text)). The game is in menu mode while it is open. Commands:
// src/shell/console-commands.ts.

import type { Menu, MenuHost } from '../ui/menu-host.ts';
import type { IniSettings } from '../world/ini-settings.ts';
import type { Terminal } from './terminal.ts';

/** The console's key: the one left of 1 (Backquote; by its character where none is given). */
export function isConsoleKey(event: KeyboardEvent): boolean {
  return event.code === 'Backquote' || (event.code === '' && event.key === '`');
}

/** What runs the lines typed: the game's commands, or the main menu's few. */
export interface ConsoleRunner {
  run(line: string): Promise<string[]>;
  /**
   * A click on the world below the console (x, y from -1 to 1 across the frame, up positive;
   * `aspect` its width over its height): the reference there becomes the selected one, as
   * prid selects it. Resolves to what it prints.
   */
  click?(x: number, y: number, aspect: number): Promise<string[]>;
}

export class ConsoleMenu {
  readonly #host: MenuHost;
  readonly #terminal: Terminal;
  readonly #ini: IniSettings;
  #menu: Menu | undefined;
  #hiding = false;
  /** The history the console showed, kept between openings (the game keeps it). */
  readonly #history: string[] = [];

  constructor(host: MenuHost, terminal: Terminal, ini: IniSettings) {
    this.#host = host;
    this.#terminal = terminal;
    this.#ini = ini;
  }

  get isOpen(): boolean {
    return this.#menu !== undefined;
  }

  /** Opens the console; `closed` once it has slid away. */
  async open(
    depth: number,
    commands: () => ConsoleRunner | undefined,
    closed: () => void,
  ): Promise<Menu> {
    this.#hiding = false;
    const add = (menu: Menu, line: string): void => {
      menu.invoke('Console.AddHistory', `${line}\n`);
    };
    const print = (menu: Menu, lines: readonly string[]): void => {
      for (const line of lines) {
        this.#history.push(line);
        add(menu, line);
      }
    };
    const menu = await this.#host.open('console.swf', {
      depth,
      interactive: true,
      onKey: (_menu, event) => {
        if (!isConsoleKey(event) || event.repeat) return false;
        this.hide();
        return true;
      },
      // A click on the world below the console picks the reference there (the console's own
      // part of the screen is its iConsoleSizeScreenPercent at the top).
      onPointer: (opened, event) => {
        const box = opened.element?.getBoundingClientRect();
        const run = commands();
        if (event.button !== 0 || !box || box.width <= 0 || box.height <= 0 || !run?.click) return;
        const down = (event.clientY - box.top) / box.height;
        if (down * 100 < this.#ini.number('Menu', 'iConsoleSizeScreenPercent')) return;
        const x = ((event.clientX - box.left) / box.width) * 2 - 1;
        run
          .click(x, 1 - down * 2, box.width / box.height)
          .then((lines) => {
            print(opened, lines);
          })
          .catch((error: unknown) => {
            this.#terminal.log(
              'ui',
              `console: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          });
      },
      handlers: {
        ExecuteCommand: (opened, args) => {
          const line = typeof args[1] === 'string' ? args[1] : '';
          const run = commands();
          if (!run) return;
          run
            .run(line)
            .then((lines) => {
              print(opened, lines);
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              this.#terminal.log('ui', `console: ${message}`, 'error');
              print(opened, [message]);
            });
        },
        HideComplete: (opened) => {
          this.#host.close(opened);
          this.#menu = undefined;
          closed();
        },
      },
      setup: async (opened) => {
        await opened.waitFor('Console.Show');
        const ini = this.#ini;
        opened.invoke('Console.SetSize', ini.number('Menu', 'iConsoleSizeScreenPercent'));
        opened.invoke('Console.SetTextSize', ini.number('Menu', 'iConsoleTextSize'));
        opened.invoke(
          'Console.SetHistoryCharBufferSize',
          ini.number('Menu', 'iConsoleHistoryCharBufferSize'),
        );
        for (const line of this.#history) add(opened, line);
        opened.invoke('Console.Show');
      },
    });
    this.#menu = menu;
    return menu;
  }

  /** Slides the console away (it closes once its animation has played). */
  hide(): void {
    if (!this.#menu || this.#hiding) return;
    this.#hiding = true;
    this.#menu.invoke('Console.Hide');
  }

  /** Closes it at once (Play ends). */
  close(): void {
    if (this.#menu) this.#host.close(this.#menu);
    this.#menu = undefined;
  }
}
