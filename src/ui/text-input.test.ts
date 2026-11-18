import { describe, expect, it } from 'vitest';
import { editItemName, endItemRename, nameBoxHandlers, TextInputCount } from './text-input.ts';

describe('what allows text input', () => {
  it("counts the race menu's name box: SetAllowTextInput raises it each call, ChangeName lowers it", () => {
    const count = new TextInputCount();
    const names: unknown[] = [];
    const handlers = nameBoxHandlers<string>(count, (_menu, name) => {
      names.push(name);
    });
    const call = (name: string, ...args: unknown[]): void => {
      handlers[name]?.('racesex_menu', [name, ...args]);
    };
    call('SetAllowTextInput', false);
    call('SetAllowTextInput', true);
    expect(count.count).toBe(2);
    call('ChangeName', 'Lydia');
    expect(count.count).toBe(1);
    expect(names).toEqual(['Lydia']);
    call('ShowVirtualKeyboard');
    expect(count.count).toBe(1);
  });

  it("counts the crafting menu's name field from EditItemName until EndItemRename", () => {
    const count = new TextInputCount();
    const invoked: unknown[][] = [];
    const movie = {
      invoke: (...args: unknown[]) => {
        invoked.push(args);
        return undefined;
      },
    };
    editItemName(movie, count, 'Iron Sword', 32);
    expect(count.count).toBe(1);
    expect(invoked).toEqual([['_root.Menu.EditItemName', 'Iron Sword', 32]]);
    const renamed: (string | undefined)[] = [];
    const rename = (name: string | undefined): void => {
      renamed.push(name);
    };
    endItemRename(count, rename, ['EndItemRename', true, 'Dawn']);
    expect(count.count).toBe(0);
    endItemRename(count, rename, ['EndItemRename', false]);
    expect(renamed).toEqual(['Dawn', undefined]);
    // Never below none.
    expect(count.count).toBe(0);
  });

  it('holds text input while something is open (the console), once, until it closes', () => {
    const count = new TextInputCount();
    const console = count.whileOpen();
    console.closed();
    expect(count.count).toBe(0);
    console.opened();
    console.opened();
    expect(count.count).toBe(1);
    // Another holder meanwhile (the race menu's name box).
    count.allow(true);
    console.closed();
    expect(count.count).toBe(1);
    console.closed();
    expect(count.count).toBe(1);
  });

  it('wraps past 255 and stops at none', () => {
    const count = new TextInputCount();
    for (let k = 0; k < 256; k++) count.allow(true);
    expect(count.count).toBe(0);
    expect(count.allow(false)).toBe(0);
  });
});
