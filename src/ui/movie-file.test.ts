import { describe, expect, it } from 'vitest';
import { movieFile } from './movie-file.ts';

describe('menu movie files', () => {
  const files = new Set([
    'interface\\hudmenu.swf',
    'interface\\exported\\hudmenu.gfx',
    'interface\\exported\\safezone.gfx',
    'interface\\inventory components\\itemcard.swf',
  ]);
  const has = (file: string): boolean => files.has(file);

  it('reads a menu from its movie, else from the exported folder, as the original does', () => {
    expect(movieFile('hudmenu.swf', has)).toBe('interface\\hudmenu.swf');
    expect(movieFile('safezone.swf', has)).toBe('interface\\exported\\safezone.gfx');
    expect(movieFile('inventory components\\itemcard.swf', has)).toBe(
      'interface\\inventory components\\itemcard.swf',
    );
  });

  it('finds nothing for a missing file, and no exported copy of a file in a folder', () => {
    expect(movieFile('missing.swf', has)).toBeUndefined();
    expect(movieFile('inventory components\\safezone.swf', has)).toBeUndefined();
    expect(movieFile('safezone.txt', has)).toBeUndefined();
  });
});
