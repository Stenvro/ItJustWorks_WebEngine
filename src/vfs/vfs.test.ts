import { describe, expect, it } from 'vitest';
import { buildBsa } from '../../tests/helpers/bsa-builder.ts';
import { MemoryGameFolder, pluginBytes } from '../../tests/helpers/memory-game-folder.ts';
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
  it('bepaalt laadvolgorde en archiefvolgorde zoals het origineel', async () => {
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

  it('laat later geladen archieven winnen en losse bestanden altijd', async () => {
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

  it('meldt ontbrekende bestanden', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), root));
    expect(vfs.has('meshes\\none.nif')).toBe(false);
    await expect(vfs.read('meshes\\none.nif')).rejects.toBeInstanceOf(VfsNotFoundError);
  });

  it('slaat een corrupt archief over en meldt het', async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(installation({ 'ccFish.bsa': 'kapot' }), root),
    );
    expect(vfs.archives.map((a) => a.name)).not.toContain('ccFish.bsa');
    expect(vfs.problems).toEqual([
      { source: 'ccFish.bsa', message: expect.stringMatching(/BSA/) as string },
    ]);
    expect(text(await vfs.read('meshes\\c.nif'))).toBe('misc-c');
  });

  it('laadt geen Creation Club-plugins zonder Skyrim.ccc', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), null));
    expect(vfs.loadOrder.map((e) => e.name)).toEqual(['Skyrim.esm', 'Update.esm']);
    expect(vfs.hasCreationClubList).toBe(false);
    expect(vfs.problems.map((p) => p.source)).toEqual(['Skyrim.ccc']);
  });

  it('zoekt op hash in archieven zonder namen, met de juiste prioriteit', async () => {
    const vfs = await Vfs.mount(
      new MemoryGameFolder(
        installation({ 'ccFish.bsa': bsa({ 'meshes\\a.nif': 'fish-a' }, { includeNames: false }) }),
        root,
      ),
    );
    expect(text(await vfs.read('meshes\\a.nif'))).toBe('fish-a');
    expect(text(await vfs.read('meshes\\b.nif'))).toBe('tex-b');
  });

  it('somt paden onder een map op', async () => {
    const vfs = await Vfs.mount(new MemoryGameFolder(installation(), root));
    expect(vfs.list('Meshes')).toEqual(['meshes\\a.nif', 'meshes\\b.nif', 'meshes\\c.nif']);
  });
});
