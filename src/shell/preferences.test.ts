// The player's settings as the engine reads them (by section and key), kept and changed.

import { describe, expect, it } from 'vitest';
import { Preferences } from './preferences.ts';

function storage(saved: Record<string, number>): {
  getItem: () => string;
  setItem: (key: string, value: string) => void;
  written: () => string | undefined;
} {
  let written: string | undefined;
  return {
    getItem: () => JSON.stringify(saved),
    setItem: (_key, value) => {
      written = value;
    },
    written: () => written,
  };
}

describe("the player's settings", () => {
  it('reads what was kept, under the section the original gives it now', () => {
    const preferences = new Preferences(
      storage({ 'Interface:bDialogueSubtitles': 0, 'Interface:fHUDOpacity': 0.5 }),
    );
    expect(preferences.number('Interface', 'bDialogueSubtitles')).toBe(0);
    expect(preferences.number('Main', 'fHUDOpacity')).toBe(0.5);
    expect(preferences.number('Interface', 'fHUDOpacity')).toBeUndefined();
    expect(preferences.number('Audio', 'bDialogueSubtitles')).toBeUndefined();
  });

  it('reads a change at once, tells of it, and keeps it', () => {
    const kept = storage({});
    const preferences = new Preferences(kept);
    const heard: [string, number][] = [];
    preferences.onChange((key, value) => heard.push([key, value]));
    preferences.set('Audio:0001ABCD', 0.25);
    preferences.set('Audio:0001ABCD', 0.25);
    expect(preferences.number('Audio', '0001ABCD')).toBe(0.25);
    expect(heard).toEqual([['Audio:0001ABCD', 0.25]]);
    preferences.save();
    expect(JSON.parse(kept.written() ?? '{}')).toEqual({ 'Audio:0001ABCD': 0.25 });
  });
});
