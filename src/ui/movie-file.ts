// Which file of the interface folder a menu's movie is read from. Platform-independent.

/**
 * The file a path of the interface folder is read from: the file itself; a menu's movie
 * ("hudmenu.swf") that is not there comes from interface\exported\<name>.gfx, as in the
 * original (Interface/<name>.swf first, then Interface/Exported/<name>.gfx). Undefined: neither.
 */
export function movieFile(path: string, has: (file: string) => boolean): string | undefined {
  const full = `interface\\${path}`;
  if (has(full)) return full;
  const menu = /^([^\\]+)\.swf$/i.exec(path)?.[1];
  const exported = menu === undefined ? undefined : `interface\\exported\\${menu}.gfx`;
  return exported !== undefined && has(exported) ? exported : undefined;
}
