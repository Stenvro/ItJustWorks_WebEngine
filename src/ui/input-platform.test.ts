import { afterEach, describe, expect, it } from 'vitest';
import { Platform, setInputPlatform } from './input-platform.ts';
import { Menu } from './menu-host.ts';

/** A menu that records its calls instead of playing a movie. */
class RecordingMenu extends Menu {
  readonly calls: unknown[][] = [];

  constructor() {
    super('test', 'test.swf', {}, () => undefined, { width: 1280, height: 720 });
  }

  override invoke(path: string, ...args: unknown[]): unknown {
    this.calls.push([path, ...args]);
    return undefined;
  }
}

describe('input platform', () => {
  afterEach(() => {
    setInputPlatform(Platform.pcKeyboardMouse);
  });

  it('tells an open menu the new platform as the device changes, until it closes', () => {
    const menu = new RecordingMenu();
    menu.tellPlatform('_root.SetPlatform');
    setInputPlatform(Platform.pcGamepad);
    setInputPlatform(Platform.pcKeyboardMouse);
    menu.close();
    setInputPlatform(Platform.pcGamepad);
    expect(menu.calls).toEqual([
      ['_root.SetPlatform', 0, false],
      ['_root.SetPlatform', 1, false],
      ['_root.SetPlatform', 0, false],
    ]);
  });
});
