// The settings the engine reads: the player's own over the INI files' over the defaults; the
// files read once per setting.

import { describe, expect, it } from 'vitest';
import { parseIni } from '../formats/ini/ini.ts';
import { IniSettings } from './ini-settings.ts';

describe('INI settings', () => {
  it("takes the player's value over the files' and the files' over the default", () => {
    const own = new Map<string, number>();
    const ini = new IniSettings(
      parseIni('[Animation]\nfHavokHitTimeSec=5\nfHavokHitImpulseMult=x\n'),
      {
        number: (section, key) => own.get(`${section}:${key}`),
      },
    );
    expect(ini.number('Animation', 'fHavokHitTimeSec')).toBe(5);
    // Not a number in the file: the default.
    expect(ini.number('Animation', 'fHavokHitImpulseMult')).toBe(50);
    expect(ini.number('Animation', 'fSpecialIdlePickTime')).toBe(250);
    // The player's own, set after the first reads, wins at once; and goes again.
    own.set('Animation:fHavokHitTimeSec', 2);
    expect(ini.number('Animation', 'fHavokHitTimeSec')).toBe(2);
    own.delete('Animation:fHavokHitTimeSec');
    expect(ini.number('Animation', 'fHavokHitTimeSec')).toBe(5);
  });

  it('reads the files once per setting', () => {
    const file = parseIni('[Animation]\nfHavokHitTimeSec=5\n');
    let reads = 0;
    const counted = new Map(
      [...file].map(([section, keys]) => [
        section,
        {
          get: (key: string) => {
            reads++;
            return keys.get(key);
          },
        },
      ]),
    ) as unknown as typeof file;
    const ini = new IniSettings(counted);
    for (let i = 0; i < 100; i++) expect(ini.number('Animation', 'fHavokHitTimeSec')).toBe(5);
    expect(reads).toBe(1);
  });
});
