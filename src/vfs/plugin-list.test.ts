import { describe, expect, it } from 'vitest';
import { formatPluginsTxt, movePlugin, parsePluginsTxt, pluginScreenList } from './plugin-list.ts';

describe('plugin list', () => {
  const list = pluginScreenList({
    present: ['B.esp', 'Skyrim.esm', 'ccFish.esm', 'A.esp', 'New.esp', 'Update.esm'],
    ccc: 'ccFish.esm\r\nccMissing.esl\r\n',
    pluginsTxt: '# comment\r\n*b.esp\r\nA.esp\r\n*Gone.esp\r\n*Skyrim.esm\r\n',
  });

  it("puts the game's own first, then Plugins.txt's order, then new plugins inactive", () => {
    expect(list).toEqual([
      { name: 'Skyrim.esm', active: true, fixed: true },
      { name: 'Update.esm', active: true, fixed: true },
      { name: 'ccFish.esm', active: true, fixed: true },
      { name: 'B.esp', active: true, fixed: false },
      { name: 'A.esp', active: false, fixed: false },
      { name: 'New.esp', active: false, fixed: false },
    ]);
  });

  it('moves only among the user plugins and writes Plugins.txt back', () => {
    expect(movePlugin(list, 3, -1)).toBe(list);
    const moved = movePlugin(list, 4, -1);
    expect(moved.map((entry) => entry.name).slice(3)).toEqual(['A.esp', 'B.esp', 'New.esp']);
    const text = formatPluginsTxt(moved);
    expect(parsePluginsTxt(text)).toEqual([
      { name: 'A.esp', active: false },
      { name: 'B.esp', active: true },
      { name: 'New.esp', active: false },
    ]);
  });
});
