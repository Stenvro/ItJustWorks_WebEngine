import { describe, expect, it } from 'vitest';
import { iniValue, parseIni, splitIniList } from './ini.ts';

describe('parseIni', () => {
  const ini = parseIni(
    [
      '; comment',
      '[General]',
      'sLanguage=ENGLISH',
      '',
      '[Archive]',
      'sResourceArchiveList = A.bsa, B.bsa ,, C.bsa',
      '# another comment',
      'no-equals-sign',
      '[archive]',
      'bExtra=1',
    ].join('\r\n'),
  );

  it('reads sections and keys case-insensitively', () => {
    expect(iniValue(ini, 'general', 'SLANGUAGE')).toBe('ENGLISH');
    expect(iniValue(ini, 'ARCHIVE', 'bextra')).toBe('1');
    expect(iniValue(ini, 'Archive', 'unknown')).toBeUndefined();
    expect(iniValue(ini, 'Unknown', 'x')).toBeUndefined();
  });

  it('splits lists and skips empty items', () => {
    expect(splitIniList(iniValue(ini, 'Archive', 'sResourceArchiveList'))).toEqual([
      'A.bsa',
      'B.bsa',
      'C.bsa',
    ]);
    expect(splitIniList(undefined)).toEqual([]);
  });
});
