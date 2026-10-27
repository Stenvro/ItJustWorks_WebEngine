import { describe, expect, it } from 'vitest';
import { buildBsa } from '../../tests/helpers/bsa-builder.ts';
import { MemoryGameFolder, pluginBytes } from '../../tests/helpers/memory-game-folder.ts';
import { iniValue } from '../formats/ini/ini.ts';
import { Vfs, VfsNotFoundError } from './vfs.ts';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

const bsa = (files: Record<string, string>, options?: Parameters<typeof buildBsa>[1]) =>
  buildBsa(
    Object.entries(files).map(([path, data]) => ({ path, data: ascii(data) })),
    options,
  );

const iniText =
  '[Archive]\nsResourceArchiveList=Skyrim - Misc.bsa\nsResourceArchiveList2=Skyrim - Textures0.bsa';

function installation(
  extra: Record<string, Uint8Array | string> = {},
): Record<string, Uint8Array | string> {
  return {
    'Skyrim.esm': pluginBytes(1),
    'Update.esm': pluginBytes(1),
    'ccFish.esm': pluginBytes(1),
    'Skyrim - Misc.bsa': bsa({
      'meshes\\a.nif': 'misc-a',
      'meshes\\b.nif': 'misc-b',
      'meshes\\c.nif': 'misc-c',
    }),
    'Skyrim - Textures0.bsa': bsa({ 'meshes\\b.nif': 'tex-b', 'textures\\t.dds': 'tex-t' }),
    'ccFish.bsa': bsa({ 'meshes\\c.nif': 'fish-c' }),
    'MarketplaceTextures.bsa': bsa({ 'meshes\\a.nif': 'market-a' }),
    ...extra,
  };
}

const root = { 'Skyrim.ccc': 'ccFish.esm\r\n', 'Skyrim_Default.ini': iniText };

describe('Vfs', () => {
  it('determines load order and archive order like the original', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), root));
    expect(vfs.loadOrder.map((e) => e.name)).toEqual(['Skyrim.esm', 'Update.esm', 'ccFish.esm']);
    expect(vfs.archives.map((a) => a.name)).toEqual([
      'Skyrim - Misc.bsa',
      'Skyrim - Textures0.bsa',
      'ccFish.bsa',
    ]);
    expect(vfs.problems).toEqual([]);
    expect(vfs.hasCreationClubList).toBe(true);
  });

  it('lets later-loaded archives win, and loose files always', async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(installation({ 'Meshes/C.nif': 'loose-c' }), root),
    );
    expect(text(await vfs.read('meshes\\a.nif'))).toBe('misc-a');
    expect(text(await vfs.read('MESHES/B.NIF'))).toBe('tex-b');
    expect(text(await vfs.read('meshes\\c.nif'))).toBe('loose-c');
    expect(vfs.resolve('meshes\\b.nif')).toMatchObject({
      kind: 'archive',
      archive: { name: 'Skyrim - Textures0.bsa' },
    });
    expect(vfs.resolve('meshes\\c.nif')?.kind).toBe('loose');
  });

  it("tells the game's own files from a mod's and loose ones", async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(
        installation({
          'Mod.esp': pluginBytes(1),
          'Mod.bsa': bsa({ 'textures\\mod.dds': 'mod' }),
          'Textures/Loose.dds': 'loose',
        }),
        root,
      ),
      { pluginsTxt: '*Mod.esp\r\n' },
    );
    expect(vfs.isGameContent('textures\\t.dds')).toBe(true);
    expect(vfs.isGameContent('meshes\\a.nif')).toBe(true);
    expect(vfs.isGameContent('meshes\\c.nif')).toBe(true);
    expect(vfs.isGameContent('textures\\mod.dds')).toBe(false);
    expect(vfs.isGameContent('textures\\loose.dds')).toBe(false);
    expect(vfs.isGameContent('textures\\none.dds')).toBe(false);
  });

  it('reports missing files', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), root));
    expect(vfs.has('meshes\\none.nif')).toBe(false);
    await expect(vfs.read('meshes\\none.nif')).rejects.toBeInstanceOf(VfsNotFoundError);
  });

  it('skips a corrupt archive and reports it', async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(installation({ 'ccFish.bsa': 'broken' }), root),
    );
    expect(vfs.archives.map((a) => a.name)).not.toContain('ccFish.bsa');
    expect(vfs.problems).toEqual([
      { source: 'ccFish.bsa', message: expect.stringMatching(/BSA/) as string },
    ]);
    expect(text(await vfs.read('meshes\\c.nif'))).toBe('misc-c');
  });

  it('loads no Creation Club plugins without Skyrim.ccc', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), null));
    expect(vfs.loadOrder.map((e) => e.name)).toEqual(['Skyrim.esm', 'Update.esm']);
    expect(vfs.hasCreationClubList).toBe(false);
    expect(vfs.problems.map((p) => p.source)).toEqual(['Skyrim.ccc']);
  });

  it('looks up by hash in archives without names, with the correct priority', async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(
        installation({ 'ccFish.bsa': bsa({ 'meshes\\a.nif': 'fish-a' }, { includeNames: false }) }),
        root,
      ),
    );
    expect(text(await vfs.read('meshes\\a.nif'))).toBe('fish-a');
    expect(text(await vfs.read('meshes\\b.nif'))).toBe('tex-b');
  });

  it('refuses a plugin whose master is not active, and mounts no archive of it', async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(
        installation({
          'Base.esm': pluginBytes(1, ['Skyrim.esm']),
          'Addon.esp': pluginBytes(0, ['Skyrim.esm', 'Base.esm']),
          'Addon.bsa': bsa({ 'meshes\\addon.nif': 'addon' }),
          'Other.esp': pluginBytes(0, ['Skyrim.esm']),
          'Other - Textures.bsa': bsa({ 'textures\\other.dds': 'other' }),
        }),
        root,
      ),
      { pluginsTxt: 'Base.esm\r\n*Addon.esp\r\n*Other.esp\r\n' },
    );
    expect(vfs.loadOrder.map((e) => e.name)).toContain('Other.esp');
    expect(vfs.loadOrder.map((e) => e.name)).not.toContain('Addon.esp');
    expect(vfs.refused.get('addon.esp')).toBe('its master Base.esm is not active');
    expect(vfs.archives.map((a) => a.name)).toContain('Other - Textures.bsa');
    expect(vfs.has('meshes\\addon.nif')).toBe(false);
    expect(vfs.plugins.find((p) => p.name === 'Addon.esp')?.masters).toEqual([
      'Skyrim.esm',
      'Base.esm',
    ]);
  });

  it("layers the player's INI files and a plugin's own INI over the default", async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(
        installation({
          'Mod.esp': pluginBytes(0),
          'Mod.ini': '[General]\nuGridsToLoad=7',
          'Mod.bsa': bsa({ 'meshes\\mod.nif': 'mod' }),
          'Extra.bsa': bsa({ 'meshes\\extra.nif': 'extra' }),
        }),
        {
          ...root,
          'Skyrim_Default.ini': `${iniText}\n[Display]\nfGamma=1.0\n[General]\nuGridsToLoad=5`,
        },
      ),
      {
        pluginsTxt: '*Mod.esp',
        skyrimIni: '[Archive]\nsResourceArchiveList2=Skyrim - Textures0.bsa, Extra.bsa',
        skyrimPrefsIni: '[Display]\nfGamma=1.2',
      },
    );
    expect(iniValue(vfs.ini, 'Display', 'fGamma')).toBe('1.2');
    expect(iniValue(vfs.ini, 'General', 'uGridsToLoad')).toBe('7');
    expect(vfs.pluginInis).toEqual(['Mod.ini']);
    expect(vfs.archives.map((a) => a.name)).toEqual([
      'Skyrim - Misc.bsa',
      'Skyrim - Textures0.bsa',
      'Extra.bsa',
      'ccFish.bsa',
      'Mod.bsa',
    ]);
    // An archive the player's INI adds is not the game's own.
    expect(vfs.isGameContent('meshes\\extra.nif')).toBe(false);
    expect(iniValue(vfs.defaultIni ?? new Map(), 'Display', 'fGamma')).toBe('1.0');
  });

  it('lists paths under a folder', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), root));
    expect(vfs.list('Meshes')).toEqual(['meshes\\a.nif', 'meshes\\b.nif', 'meshes\\c.nif']);
  });
});
