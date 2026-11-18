import { describe, expect, it } from 'vitest';
import { CUSTOM_MENU, MenuFlag, MenuStack } from '../ui/menu-stack.ts';
import { TextInputCount } from '../ui/text-input.ts';
import { CUSTOM_MENU_DEPTH, CustomMenu, type CustomMenuHost } from './custom-menu.ts';

interface Menu {
  readonly movie: string;
}
type MenuOptions = Parameters<CustomMenuHost<Menu>['open']>[1];

/** A custom menu over a host that records what it opens and closes. */
function setup(usesCursor = true) {
  const opened: { movie: string; options: MenuOptions }[] = [];
  const closed: string[] = [];
  let release: (() => void) | undefined;
  const host: CustomMenuHost<Menu> = {
    open: (movie, options) => {
      opened.push({ movie, options });
      const menu: Menu = { movie };
      return new Promise<Menu>((resolve) => {
        release = () => {
          resolve(menu);
        };
      });
    },
    close: (menu) => closed.push(menu.movie),
  };
  const stack = new MenuStack();
  let menuMode = 0;
  const menu = new CustomMenu(
    host,
    stack,
    { log: () => undefined },
    () => {
      menuMode++;
      return () => {
        menuMode--;
      };
    },
    () => usesCursor,
  );
  return {
    menu,
    stack,
    opened,
    closed,
    load: async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    menuMode: () => menuMode,
  };
}

describe("SKSE's custom menu", () => {
  it("opens the movie at its path under the interface folder as SKSE's CustomMenu", async () => {
    const { menu, stack, opened, load, menuMode } = setup();
    menu.open('mymod\\menu');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.movie).toBe('mymod/menu.swf');
    expect(opened[0]?.options.depth).toBe(CUSTOM_MENU_DEPTH);
    expect(opened[0]?.options.cursor).toBe(true);
    expect(stack.isOpen(CUSTOM_MENU)).toBe(true);
    expect(stack.pausesGame).toBe(true);
    expect(stack.any(MenuFlag.modal)).toBe(true);
    expect(menuMode()).toBe(1);
    await load();
    expect(menu.movie).toBeDefined();
    // One open already stays as it is.
    menu.open('other/menu');
    expect(opened).toHaveLength(1);
  });

  it('closes the movie, its stack entry and menu mode, also while it still loads', async () => {
    const loaded = setup();
    loaded.menu.open('mymod/menu');
    await loaded.load();
    loaded.menu.close();
    expect(loaded.closed).toEqual(['mymod/menu.swf']);
    expect(loaded.stack.isOpen(CUSTOM_MENU)).toBe(false);
    expect(loaded.menuMode()).toBe(0);

    const loading = setup(false);
    loading.menu.open('mymod/menu');
    expect(loading.opened[0]?.options.cursor).toBe(false);
    loading.menu.close();
    expect(loading.stack.isOpen(CUSTOM_MENU)).toBe(false);
    await loading.load();
    expect(loading.closed).toEqual(['mymod/menu.swf']);
  });
});

describe("the control map's text input count", () => {
  it('counts each allowing and taking back as a byte: wrapping past 255, never below 0', () => {
    const input = new TextInputCount();
    expect(input.allow(false)).toBe(0);
    const release = input.hold();
    expect(input.allow(true)).toBe(2);
    release();
    release();
    expect(input.count).toBe(1);
    for (let k = 0; k < 255; k++) input.allow(true);
    expect(input.count).toBe(0);
  });
});
