import { asciiLowerCase } from './text.ts';

/**
 * Normalizes a path the way the engine looks it up: lowercase (ASCII),
 * backslashes, no leading or doubled separators and no `.\`.
 *
 * `Meshes/Clutter//Foo.NIF` → `meshes\clutter\foo.nif`
 */
export function normalizePath(path: string): string {
  return asciiLowerCase(path.trim())
    .replace(/[\\/]+/g, '\\')
    .replace(/^(\.?\\)+/, '');
}

/** Folder part of a normalized path (`meshes\clutter`), or `''` for the root. */
export function folderOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('\\');
  return slash < 0 ? '' : normalizedPath.slice(0, slash);
}

/** File name of a normalized path (`foo.nif`). */
export function fileNameOf(normalizedPath: string): string {
  return normalizedPath.slice(normalizedPath.lastIndexOf('\\') + 1);
}
