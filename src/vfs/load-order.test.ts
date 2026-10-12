import { describe, expect, it } from 'vitest';
import type { PluginHeader } from '../formats/esm/plugin-header.ts';
import { parseIni } from '../formats/ini/ini.ts';
import {
  archiveListFromIni,
  computeArchiveOrder,
  computeLoadOrder,
  DEFAULT_ARCHIVE_LIST,
  formatModIndex,
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
  it('zet vaste masters vooraan, ongeacht de volgorde op schijf', () => {
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

  it('laadt Creation Club-plugins in de volgorde van Skyrim.ccc, alleen als ze bestaan', () => {
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

  it('leest actieve regels uit plugins.txt en zet masters vóór gewone plugins', () => {
    const { entries, problems } = computeLoadOrder({
      plugins: [
        ...vanilla,
        plugin('Mod.esp'),
        plugin('FlaggedMaster.esp', { master: true }),
        plugin('Inactive.esp'),
        plugin('LightMod.esp', { light: true }),
      ],
      pluginsTxt: [
        '# commentaar',
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

  it('valt terug op de extensie als de header onleesbaar is', () => {
    const { entries } = computeLoadOrder({
      plugins: [...vanilla, { name: 'X.esl', header: undefined }],
      pluginsTxt: '*X.esl',
    });
    expect(entries.at(-1)).toMatchObject({ name: 'X.esl', isMaster: true, isLight: true });
  });

  it('meldt plugins boven de limiet van 254 volledige plugins', () => {
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

describe('archieven', () => {
  it('leest de archieflijst uit de INI, met standaardlijst als terugval', () => {
    const ini = parseIni(
      '[Archive]\nsResourceArchiveList=A.bsa, B.bsa\nsResourceArchiveList2=C.bsa',
    );
    expect(archiveListFromIni(ini)).toEqual(['A.bsa', 'B.bsa', 'C.bsa']);
    expect(archiveListFromIni(undefined)).toBe(DEFAULT_ARCHIVE_LIST);
    expect(archiveListFromIni(parseIni('[General]'))).toBe(DEFAULT_ARCHIVE_LIST);
  });

  it('zet INI-archieven voor plugin-archieven en slaat ontbrekende over', () => {
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
});
