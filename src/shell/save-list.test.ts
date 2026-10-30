import { describe, expect, it } from 'vitest';
import type { SaveHeader } from '../save/save-codec.ts';
import {
  gameDaysText,
  savedCharacters,
  SaveList,
  type SaveListMenu,
  type SaveListSource,
} from './save-list.ts';

const header = (name: string, playerName: string, realTime: number): SaveHeader => ({
  version: 1,
  name,
  kind: 'save',
  number: realTime,
  playerName,
  playerLevel: 3,
  location: 'Whiterun',
  gameDays: 2.25,
  realTime,
  plugins: [],
});

/** A movie's side of the save list: its list's entries and the callbacks it heard. */
class FakeMenu implements SaveListMenu {
  readonly entries: Record<string, unknown>[] = [];
  readonly calls: unknown[][] = [];
  reference(argument: unknown): string | undefined {
    return argument === 'list' ? '_global.list' : undefined;
  }
  set(): void {
    this.entries.length = 0;
  }
  invoke(_path: string, ...args: unknown[]): void {
    this.entries.push(args[0] as Record<string, unknown>);
  }
  call(...args: unknown[]): void {
    this.calls.push(args);
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the menus’ save list', () => {
  const saves = [
    header('Save 3', 'Lydia', 300),
    header('Save 2', 'Ralof', 200),
    header('Save 1', 'Lydia', 100),
  ];

  it('lists each character once, the one saved last first', () => {
    expect(savedCharacters(saves)).toEqual([
      { text: 'Lydia', id: 0, flags: 0 },
      { text: 'Ralof', id: 1, flags: 0 },
    ]);
  });

  it('shows game days as a time played', () => {
    expect(gameDaysText(2.25)).toBe('2 days, 06:00');
    expect(gameDaysText(1.5)).toBe('1 day, 12:00');
  });

  it('fills the characters, then a character’s saves, and loads one by its index', async () => {
    const deleted: string[] = [];
    const loaded: string[] = [];
    const source: SaveListSource = {
      list: () => Promise.resolve(saves.filter((save) => !deleted.includes(save.name))),
      delete: (name) => {
        deleted.push(name);
        return Promise.resolve();
      },
    };
    const list = new SaveList<FakeMenu>({
      source: () => source,
      playTime: (save) => gameDaysText(save.gameDays),
      load: (_menu, name) => loaded.push(name),
      log: () => undefined,
    });
    const handlers = list.handlers();
    const menu = new FakeMenu();
    const fake = menu;

    handlers.PopulateCharacterList?.(menu, ['list', 10]);
    await settle();
    expect(fake.entries.map((entry) => entry.text)).toEqual(['Lydia', 'Ralof']);
    expect(fake.calls.at(-1)).toEqual(['onFillCharacterListComplete', true]);

    // CharacterSelected(id, flags, saving, list, batch size).
    handlers.CharacterSelected?.(menu, [1, 0, false, 'list', 10]);
    await settle();
    expect(fake.entries.map((entry) => entry.text)).toEqual(['Save 2  Whiterun']);
    expect(fake.calls.at(-1)).toEqual(['onSaveLoadBatchComplete', true, 1, 1]);

    handlers.CharacterSelected?.(menu, [0, 0, false, 'list', 10]);
    await settle();
    expect(fake.entries.map((entry) => entry.index)).toEqual([0, 1]);
    handlers.LoadGame?.(menu, [1]);
    expect(loaded).toEqual(['Save 1']);

    // A delete fills the character's list again without the save.
    handlers.DeleteSave?.(menu, [0]);
    await settle();
    await settle();
    expect(deleted).toEqual(['Save 3']);
    expect(fake.entries.map((entry) => entry.text)).toEqual(['Save 1  Whiterun']);
  });

  it('tells whether a delete went through (the journal: RefreshMenu or the device error)', async () => {
    const outcomes: string[] = [];
    let refuse = false;
    const source: SaveListSource = {
      list: () => Promise.resolve(saves),
      delete: () => (refuse ? Promise.reject(new Error('locked')) : Promise.resolve()),
    };
    const list = new SaveList<FakeMenu>({
      source: () => source,
      playTime: () => '',
      load: () => undefined,
      log: () => undefined,
      deleted: () => outcomes.push('deleted'),
      failed: () => outcomes.push('failed'),
    });
    const handlers = list.handlers();
    const menu = new FakeMenu();
    handlers.CharacterSelected?.(menu, [0, 0, false, 'list', 10]);
    await settle();
    handlers.DeleteSave?.(menu, [0]);
    await settle();
    refuse = true;
    handlers.DeleteSave?.(menu, [0]);
    await settle();
    expect(outcomes).toEqual(['deleted', 'failed']);
  });

  it('gives the highlighted save’s screenshot, then says ScreenshotReady', async () => {
    const asked: (string | undefined)[] = [];
    const shown: (number | undefined)[] = [];
    const source: SaveListSource = {
      list: () => Promise.resolve(saves),
      delete: () => Promise.resolve(),
      screenshot: (name) => {
        asked.push(name);
        return Promise.resolve(new Uint8Array([name === undefined ? 0 : 1]));
      },
    };
    const list = new SaveList<FakeMenu>({
      source: () => source,
      playTime: () => '',
      load: () => undefined,
      log: () => undefined,
      screenshotImage: (png) => shown.push(png?.[0]),
    });
    const handlers = list.handlers();
    const menu = new FakeMenu();
    // Save: index -1 is the new save (the frame drawn now), 1 the second save listed.
    handlers.SAVE?.(menu, ['list']);
    await settle();
    handlers.PrepSaveGameScreenshot?.(menu, [-1, {}]);
    await settle();
    handlers.PrepSaveGameScreenshot?.(menu, [1, {}]);
    await settle();
    expect(asked).toEqual([undefined, 'Save 2']);
    expect(shown).toEqual([0, 1]);
    expect(menu.calls.filter((call) => call[0] === 'ScreenshotReady')).toHaveLength(2);
  });

  it('asks for the import’s file when its entry is pressed, a save is confirmed', async () => {
    const picked: number[] = [];
    const list = new SaveList<FakeMenu>({
      source: () => ({ list: () => Promise.resolve(saves), delete: () => Promise.resolve() }),
      playTime: () => '',
      importText: () => 'Import',
      pickImport: (_menu, index) => picked.push(index),
      load: () => undefined,
      log: () => undefined,
    });
    const handlers = list.handlers();
    const menu = new FakeMenu();
    handlers.LOAD?.(menu, ['list']);
    await settle();
    handlers.IsOKtoLoad?.(menu, [0]);
    handlers.IsOKtoLoad?.(menu, [3]);
    expect(menu.calls.filter((call) => call[0] === 'ConfirmOKToLoad')).toHaveLength(1);
    expect(picked).toEqual([3]);
  });
});
