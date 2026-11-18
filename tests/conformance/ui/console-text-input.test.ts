// Conformance: the console allows text input while it is open (UI.IsTextInputEnabled true
// from its opening until it has slid away, as observed in the original); the console's menu
// with a stand-in menu host, no game data needed. The count's own rules: src/ui/text-input.ts.

import { describe, expect, it } from 'vitest';
import { ConsoleMenu } from '../../../src/shell/console-menu.ts';
import type { Terminal } from '../../../src/shell/terminal.ts';
import type { Menu, MenuHost, MenuOptions } from '../../../src/ui/menu-host.ts';
import { TextInputCount } from '../../../src/ui/text-input.ts';
import { IniSettings } from '../../../src/world/ini-settings.ts';

const terminal = { log: () => undefined } as unknown as Terminal;

describe('the console and text input', () => {
  it('allows text input from its opening until it has slid away, and once Play closes it', async () => {
    const count = new TextInputCount();
    let options: MenuOptions | undefined;
    const opened = { invoke: () => undefined } as unknown as Menu;
    const host = {
      open: (_movie: string, given: MenuOptions) => {
        options = given;
        return Promise.resolve(opened);
      },
      close: () => undefined,
    } as unknown as MenuHost;
    const console = new ConsoleMenu(host, terminal, new IniSettings(undefined), count);
    let closed = 0;
    await console.open(
      1,
      () => undefined,
      () => closed++,
    );
    expect(count.count).toBe(1);
    console.hide();
    // Still sliding away.
    expect(count.count).toBe(1);
    void options?.handlers?.HideComplete?.(opened, ['HideComplete']);
    expect(count.count).toBe(0);
    expect(closed).toBe(1);
    // Opened again and closed at once (Play ends).
    await console.open(
      1,
      () => undefined,
      () => closed++,
    );
    expect(count.count).toBe(1);
    console.close();
    expect(count.count).toBe(0);
  });

  it('gives text input back when the console does not open', async () => {
    const count = new TextInputCount();
    const host = {
      open: () => Promise.reject(new Error('no movie')),
      close: () => undefined,
    } as unknown as MenuHost;
    const console = new ConsoleMenu(host, terminal, new IniSettings(undefined), count);
    await expect(
      console.open(
        1,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('no movie');
    expect(count.count).toBe(0);
  });
});
