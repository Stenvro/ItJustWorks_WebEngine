import { describe, expect, it } from 'vitest';
import { iniValue, parseIni, splitIniList } from './ini.ts';

describe('parseIni', () => {
  const ini = parseIni(
    [
      '; commentaar',
      '[General]',
      'sLanguage=ENGLISH',
      '',
      '[Archive]',
      'sResourceArchiveList = A.bsa, B.bsa ,, C.bsa',
      '# ander commentaar',
      'zonder-gelijkteken',
      '[archive]',
      'bExtra=1',
    ].join('\r\n'),
  );

  it('leest secties en sleutels hoofdletterongevoelig', () => {
    expect(iniValue(ini, 'general', 'SLANGUAGE')).toBe('ENGLISH');
    expect(iniValue(ini, 'ARCHIVE', 'bextra')).toBe('1');
    expect(iniValue(ini, 'Archive', 'onbekend')).toBeUndefined();
    expect(iniValue(ini, 'Onbekend', 'x')).toBeUndefined();
  });

  it('splitst lijsten en slaat lege items over', () => {
    expect(splitIniList(iniValue(ini, 'Archive', 'sResourceArchiveList'))).toEqual([
      'A.bsa',
      'B.bsa',
      'C.bsa',
    ]);
    expect(splitIniList(undefined)).toEqual([]);
  });
});
