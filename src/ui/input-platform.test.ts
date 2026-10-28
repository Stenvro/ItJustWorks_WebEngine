import { afterEach, describe, expect, it } from 'vitest';
import { followPlatform, Platform, setInputPlatform } from './input-platform.ts';

describe('input platform', () => {
  afterEach(() => {
    setInputPlatform(Platform.pcKeyboardMouse);
  });

  it('tells an open menu the new platform as the device changes, until it closes', () => {
    const calls: unknown[][] = [];
    const stop = followPlatform((...call) => calls.push(call), '_root.SetPlatform');
    setInputPlatform(Platform.pcGamepad);
    setInputPlatform(Platform.pcKeyboardMouse);
    stop();
    setInputPlatform(Platform.pcGamepad);
    expect(calls).toEqual([
      ['_root.SetPlatform', 0, false],
      ['_root.SetPlatform', 1, false],
      ['_root.SetPlatform', 0, false],
    ]);
  });
});
