import { describe, expect, it } from 'vitest';
import type { PluginHeader } from '../formats/esm/plugin-header.ts';
import { parseIni } from '../formats/ini/ini.ts';
import {
  archiveListFromIni,
  computeArchiveOrder,
  computeLoadOrder,
  DEFAULT_ARCHIVE_LIST,
  formatModIndex,
  gameContentArchives,
  hasAnniversaryContent,
  type LoadOrderEntry,
  type PluginCandidate,
} from './load-order.ts';

function header(flags: { master?: boolean; light?: boolean } = {}): PluginHeader {
  return {
    flags: 0,
    isMaster: flags.master ?? false,
    isLight: flags.light ?? false,
    isLocalized: false,
  };
}

const plugin = (name: string, flags?: { master?: boolean; light?: boolean }): PluginCandidate => ({
  name,
  header: header(flags),
});

const vanilla = [
  plugin('Skyrim.esm', { master: true }),
  plugin('Update.esm', { master: true }),
  plugin('Dawnguard.esm', { master: true }),
  plugin('HearthFires.esm', { master: true }),
  plugin('Dragonborn.esm', { master: true }),
];

describe('computeLoadOrder', () => {
  it('puts implicit masters first, regardless of order on disk', () => {
    const { entries } = computeLoadOrder({ plugins: [...vanilla].reverse() });
    expect(entries.map((e) => e.name)).toEqual([
      'Skyrim.esm',
      'Update.esm',
      'Dawnguard.esm',
      'HearthFires.esm',
      'Dragonborn.esm',
    ]);
    expect(entries.map((e) => e.modIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('loads Creation Club plugins in Skyrim.ccc order, only if they exist', () => {
    const { entries } = computeLoadOrder({
      plugins: [
        ...vanilla,
        plugin('ccB.esl'),
        plugin('ccA.esm', { master: true }),
        plugin('_ResourcePack.esl'),
      ],
      ccc: 'ccMissing.esm\r\nccA.esm\r\nccB.esl\r\n_ResourcePack.esl\r\n',
    });
    expect(entries.slice(5).map((e) => [e.name, formatModIndex(e)])).toEqual([
      ['ccA.esm', '05'],
      ['ccB.esl', 'FE:000'],
      ['_ResourcePack.esl', 'FE:001'],
    ]);
  });

  it('reads active lines from plugins.txt and puts masters before regular plugins', () => {
    const { entries, problems } = computeLoadOrder({
      plugins: [
        ...vanilla,
        plugin('Mod.esp'),
        plugin('FlaggedMaster.esp', { master: true }),
        plugin('Inactive.esp'),
        plugin('LightMod.esp', { light: true }),
      ],
      pluginsTxt: [
        '# comment',
        '*Mod.esp',
        'Inactive.esp',
        '*LightMod.esp',
        '*FlaggedMaster.esp',
        '*Skyrim.esm',
        '*Gone.esp',
      ].join('\n'),
    });
    expect(entries.slice(5).map((e) => [e.name, formatModIndex(e)])).toEqual([
      ['FlaggedMaster.esp', '05'],
      ['Mod.esp', '06'],
      ['LightMod.esp', 'FE:000'],
    ]);
    expect(problems).toEqual(['Gone.esp is listed in plugins.txt but missing']);
  });

  it('falls back to the extension if the header is unreadable', () => {
    const { entries } = computeLoadOrder({
      plugins: [...vanilla, { name: 'X.esl', header: undefined }],
      pluginsTxt: '*X.esl',
    });
    expect(entries.at(-1)).toMatchObject({ name: 'X.esl', isMaster: true, isLight: true });
  });

  it('refuses plugins with a missing master, and those that need them, and checks the order', () => {
    const withMasters = (name: string, masters: string[], master = false): PluginCandidate => ({
      ...plugin(name, { master }),
      masters,
    });
    const { entries, problems, refused } = computeLoadOrder({
      plugins: [
        ...vanilla,
        withMasters('NeedsGone.esp', ['Skyrim.esm', 'Gone.esm']),
        withMasters('NeedsNeedsGone.esp', ['NeedsGone.esp']),
        withMasters('Patch.esp', ['Late.esp']),
        withMasters('Late.esp', ['Skyrim.esm']),
        withMasters('Fine.esp', ['Skyrim.esm', 'Dawnguard.esm']),
      ],
      pluginsTxt: '*NeedsGone.esp\n*NeedsNeedsGone.esp\n*Patch.esp\n*Late.esp\n*Fine.esp',
    });
    expect(entries.slice(5).map((e) => [e.name, formatModIndex(e)])).toEqual([
      ['Patch.esp', '05'],
      ['Late.esp', '06'],
      ['Fine.esp', '07'],
    ]);
    expect([...refused]).toEqual([
      ['needsgone.esp', 'its master Gone.esm is missing'],
      ['needsneedsgone.esp', 'its master NeedsGone.esp is not active'],
    ]);
    expect(problems).toEqual([
      'NeedsGone.esp not loaded: its master Gone.esm is missing',
      'NeedsNeedsGone.esp not loaded: its master NeedsGone.esp is not active',
      'Patch.esp loads before its master Late.esp',
    ]);
  });

  it('reports plugins beyond the limit of 254 full plugins', () => {
    const many = Array.from({ length: 260 }, (_, i) => plugin(`Mod${i}.esp`));
    const { entries, problems } = computeLoadOrder({
      plugins: many,
      pluginsTxt: many.map((p) => `*${p.name}`).join('\n'),
    });
    expect(entries).toHaveLength(254);
    expect(entries.at(-1)?.modIndex).toBe(0xfd);
    expect(problems).toHaveLength(6);
  });
});

describe('archives', () => {
  it('reads the archive list from the INI, with the default list as fallback', () => {
    const ini = parseIni(
      '[Archive]\nsResourceArchiveList=A.bsa, B.bsa\nsResourceArchiveList2=C.bsa',
    );
    expect(archiveListFromIni(ini)).toEqual(['A.bsa', 'B.bsa', 'C.bsa']);
    expect(archiveListFromIni(undefined)).toBe(DEFAULT_ARCHIVE_LIST);
    expect(archiveListFromIni(parseIni('[General]'))).toBe(DEFAULT_ARCHIVE_LIST);
  });

  it('puts INI archives before plugin archives and skips missing ones', () => {
    const { entries } = computeLoadOrder({
      plugins: [...vanilla, plugin('Mod.esp')],
      pluginsTxt: '*Mod.esp',
    });
    const order = computeArchiveOrder(
      ['Skyrim - Misc.bsa', 'Skyrim - Patch.bsa', 'mod.bsa'],
      entries,
      ['MOD - textures.bsa', 'Mod.bsa', 'Skyrim - Misc.bsa', 'Unrelated.bsa'],
    );
    expect(order).toEqual(['Skyrim - Misc.bsa', 'Mod.bsa', 'MOD - textures.bsa']);
  });

  it("counts the INI's and the game's own plugins' archives as its content, not mods'", () => {
    const { entries } = computeLoadOrder({
      plugins: [...vanilla, plugin('ccFish.esm', { master: true }), plugin('Mod.esp')],
      ccc: 'ccFish.esm',
      pluginsTxt: '*Mod.esp',
    });
    const official = gameContentArchives(['Skyrim - Misc.bsa'], entries);
    expect(official.has('skyrim - misc.bsa')).toBe(true);
    expect(official.has('dawnguard.bsa')).toBe(true);
    expect(official.has('ccfish.bsa')).toBe(true);
    expect(official.has('ccfish - textures.bsa')).toBe(true);
    expect(official.has('mod.bsa')).toBe(false);
  });
});

describe('hasAnniversaryContent', () => {
  const entry = (name: string, source: LoadOrderEntry['source']): LoadOrderEntry => ({
    name,
    source,
    isLight: name.endsWith('.esl'),
    isMaster: true,
    modIndex: 0,
    lightIndex: undefined,
  });

  it('is false with only the free Creations', () => {
    expect(
      hasAnniversaryContent([
        entry('Skyrim.esm', 'implicit'),
        entry('ccBGSSSE001-Fish.esm', 'Skyrim.ccc'),
        entry('ccQDRSSE001-SurvivalMode.esl', 'Skyrim.ccc'),
        entry('ccBGSSSE037-Curios.esl', 'Skyrim.ccc'),
        entry('ccBGSSSE025-AdvDSGS.esm', 'Skyrim.ccc'),
        entry('_ResourcePack.esl', 'Skyrim.ccc'),
        entry('MyMod.esp', 'plugins.txt'),
      ]),
    ).toBe(false);
  });

  it('is true with another Creation', () => {
    expect(hasAnniversaryContent([entry('ccBGSSSE002-ExoticArrows.esl', 'Skyrim.ccc')])).toBe(true);
  });
});
