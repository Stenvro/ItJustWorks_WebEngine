import { asciiLowerCase } from './text.ts';

/**
 * Normaliseert een pad zoals de engine het opzoekt: kleine letters (ASCII),
 * backslashes, zonder leidende of dubbele scheidingstekens en zonder `.\`.
 *
 * `Meshes/Clutter//Foo.NIF` → `meshes\clutter\foo.nif`
 */
export function normalizePath(path: string): string {
  return asciiLowerCase(path.trim())
    .replace(/[\\/]+/g, '\\')
    .replace(/^(\.?\\)+/, '');
}

/** Map-deel van een genormaliseerd pad (`meshes\clutter`), of `''` voor de wortel. */
export function folderOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('\\');
  return slash < 0 ? '' : normalizedPath.slice(0, slash);
}

/** Bestandsnaam van een genormaliseerd pad (`foo.nif`). */
export function fileNameOf(normalizedPath: string): string {
  return normalizedPath.slice(normalizedPath.lastIndexOf('\\') + 1);
}
