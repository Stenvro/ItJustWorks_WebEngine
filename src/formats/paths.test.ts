import { describe, expect, it } from 'vitest';
import { fileNameOf, folderOf, normalizePath } from './paths.ts';

describe('normalizePath', () => {
  it.each([
    ['Meshes/Clutter//Foo.NIF', 'meshes\\clutter\\foo.nif'],
    ['\\textures\\sky\\a.dds', 'textures\\sky\\a.dds'],
    ['.\\Interface\\HUDMenu.swf', 'interface\\hudmenu.swf'],
    ['  Skyrim.esm ', 'skyrim.esm'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe('folderOf / fileNameOf', () => {
  it('splits a path', () => {
    expect(folderOf('meshes\\clutter\\foo.nif')).toBe('meshes\\clutter');
    expect(fileNameOf('meshes\\clutter\\foo.nif')).toBe('foo.nif');
  });

  it('handles files in the root', () => {
    expect(folderOf('skyrim.esm')).toBe('');
    expect(fileNameOf('skyrim.esm')).toBe('skyrim.esm');
  });
});
